"""Read-only complete SQLite cell census and exact private closed-file snapshots.

Never connect to the live source for writing, recover a journal, drop a table,
normalize an application value, or infer that a changed native value is benign.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import sys

MAX_DATABASE = 128 * 1024 * 1024
MAX_CENSUS = 64 * 1024 * 1024
MAX_ROWS = 200000
MAX_TABLES = 2048
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def identity(s):
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink, s.st_uid)


def canonical_path(filename):
    p = Path(filename)
    if not p.is_absolute() or str(p) != os.path.realpath(p) or any(x.is_symlink() for x in [p, *p.parents]):
        raise ValueError('noncanonical-path')
    return p


def no_sidecars(p):
    # A journal/WAL is database state, including when the main file looks valid.
    for suffix in ('-journal', '-wal', '-shm'):
        if os.path.lexists(str(p) + suffix):
            raise ValueError('sqlite-sidecar-present')


def project_directory_manifest(source, project_name):
    parent = canonical_path(source.parent)
    state = parent.stat()
    if source.name != 'Project.db' or parent.name != project_name or state.st_uid != os.getuid():
        raise ValueError('project-directory-context-mismatch')
    rows = []
    for entry in os.scandir(parent):
        s = entry.stat(follow_symlinks=False)
        if entry.name != 'Project.db' or not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1:
            raise ValueError('unknown-project-directory-member')
        rows.append({'nameSha256': sha(os.fsencode(entry.name)), 'identity': list(identity(s)), 'mode': stat.S_IMODE(s.st_mode)})
    if len(rows) != 1:
        raise ValueError('project-directory-member-count')
    return {'directoryIdentity': [state.st_dev, state.st_ino, state.st_uid, stat.S_IMODE(state.st_mode)], 'entries': rows}


def read_regular(filename, limit=MAX_DATABASE):
    p = canonical_path(filename)
    with os.fdopen(os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or not 0 < before.st_size <= limit:
            raise ValueError('unsafe-file')
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        if len(data) != before.st_size or identity(before) != identity(after) or identity(before) != identity(p.lstat()):
            raise ValueError('file-changed')
    return data, identity(before)


def publish_private(parent, name, payload, expected_parent):
    parent = canonical_path(parent)
    current = parent.stat()
    if not stat.S_ISDIR(current.st_mode) or current.st_uid != os.getuid() or current.st_mode & 0o077 or (current.st_dev, current.st_ino) != expected_parent:
        raise ValueError('destination-directory-changed')
    dirfd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if (os.fstat(dirfd).st_dev, os.fstat(dirfd).st_ino) != expected_parent:
            raise ValueError('destination-directory-changed')
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dirfd)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
            written = os.fstat(stream.fileno())
            named = os.stat(name, dir_fd=dirfd, follow_symlinks=False)
            if identity(written) != identity(named) or written.st_nlink != 1:
                raise ValueError('destination-file-changed')
        os.fsync(dirfd)
        current = parent.lstat()
        if (current.st_dev, current.st_ino) != expected_parent or str(parent) != os.path.realpath(parent):
            raise ValueError('destination-directory-changed')
    finally:
        os.close(dirfd)


def typed(value, storage=None):
    if storage is None:
        storage = 'null' if value is None else 'integer' if type(value) is int else 'real' if type(value) is float else 'text' if isinstance(value, str) else 'blob' if isinstance(value, bytes) else None
    if isinstance(storage, bytes):
        storage = storage.decode('ascii')
    if storage == 'null' and value is None:
        return {'type': 'null'}
    if storage == 'integer' and type(value) is int and -(1 << 63) <= value < (1 << 63):
        return {'type': 'integer', 'decimal': str(value)}
    if storage == 'real' and type(value) is float:
        return {'type': 'real', 'ieee754BigEndianHex': struct.pack('>d', value).hex()}
    if storage in ('text', 'blob') and isinstance(value, (bytes, str)):
        raw = value.encode('utf-8') if isinstance(value, str) else value
        return {'type': storage, 'base64': base64.b64encode(raw).decode('ascii')}
    raise ValueError('unsupported-storage-class')


def identifier(value):
    if not isinstance(value, bytes):
        raise ValueError('invalid-schema-identifier')
    name = value.decode('utf-8', errors='strict')
    if not name or '\0' in name:
        raise ValueError('invalid-schema-identifier')
    return name


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def text_value(cell):
    if cell.get('type') != 'text' or set(cell) != {'type', 'base64'}:
        raise ValueError('expected-text-cell')
    return base64.b64decode(cell['base64'], validate=True).decode('utf-8', errors='strict')


def logical(census):
    return {key: census[key] for key in ('projectContext', 'applicationPragmas', 'schemaObjects', 'tables')}


def census(filename, project_id, project_name):
    if not UUID.fullmatch(project_id) or not isinstance(project_name, str) or not project_name:
        raise ValueError('expected-project-required')
    p = canonical_path(filename)
    no_sidecars(p)
    raw, original_identity = read_regular(p)
    if raw[:16] != b'SQLite format 3\0' or raw[18:20] != b'\x01\x01':
        raise ValueError('unsupported-sqlite-header-or-wal')
    con = sqlite3.connect(p.as_uri() + '?mode=ro&immutable=1', uri=True, isolation_level=None)
    con.text_factory = bytes
    if hasattr(con, 'enable_load_extension'):
        con.enable_load_extension(False)
    try:
        con.execute('PRAGMA query_only=ON')
        if con.execute('PRAGMA query_only').fetchone() != (1,):
            raise ValueError('query-only-required')
        con.execute('PRAGMA trusted_schema=OFF')
        con.execute('BEGIN')
        if con.execute('PRAGMA encoding').fetchone() != (b'UTF-8',) or con.execute('PRAGMA journal_mode').fetchone() != (b'delete',):
            raise ValueError('unsupported-encoding-or-journal-mode')
        if con.execute('PRAGMA integrity_check').fetchall() != [(b'ok',)]:
            raise ValueError('sqlite-integrity-failed')
        master = con.execute('SELECT rowid,type,name,tbl_name,rootpage,sql FROM main.sqlite_schema').fetchall()
        schema_objects = []
        for row in master:
            # sqlite_schema TEXT is read as exact UTF-8 bytes, not JSON strings.
            schema_objects.append({'rowid': typed(row[0]), 'type': typed(row[1], 'text'), 'name': typed(row[2], 'text'),
                                   'tableName': typed(row[3], 'text'), 'rootPage': typed(row[4]), 'sql': typed(row[5], 'null' if row[5] is None else 'text')})
        schema_objects.sort(key=encoded)
        table_modes = {}
        for schema, name, kind, ncol, without_rowid, strict in con.execute('PRAGMA main.table_list'):
            if schema != b'main':
                raise ValueError('unexpected-schema')
            if kind in (b'virtual', b'shadow'):
                raise ValueError('unsupported-virtual-or-shadow-table')
            table_modes[identifier(name)] = (kind, ncol, without_rowid, strict)
        table_names = [identifier(row[2]) for row in master if row[1] == b'table']
        if len(table_names) != len(set(table_names)) or not 0 < len(table_names) <= MAX_TABLES:
            raise ValueError('ambiguous-or-excess-tables')
        tables, total_rows, total_cells = [], 0, 0
        for table_name in sorted(table_names):
            mode = table_modes.get(table_name)
            if not mode or mode[0] != b'table':
                raise ValueError('unclassified-table')
            xinfo = con.execute('SELECT * FROM pragma_table_xinfo(?) ORDER BY cid', (table_name,)).fetchall()
            if not xinfo or any(len(row) != 7 for row in xinfo) or len(xinfo) != mode[1]:
                raise ValueError('table-column-coverage')
            columns = [identifier(row[1]) for row in xinfo]
            if len(set(columns)) != len(columns):
                raise ValueError('ambiguous-columns')
            aliases = [name for name in ('rowid', '_rowid_', 'oid') if name.casefold() not in {c.casefold() for c in columns}]
            if not mode[2] and not aliases:
                raise ValueError('inaccessible-rowid')
            rowid_alias = None if mode[2] else aliases[0]
            select = []
            if rowid_alias:
                select.extend(['typeof(' + quote(rowid_alias) + ')', quote(rowid_alias)])
            for column in columns:
                select.extend(['typeof(' + quote(column) + ')', quote(column)])
            rows = []
            pk_columns = sorted([(row[5], index, columns[index]) for index, row in enumerate(xinfo) if row[5] > 0])
            for values in con.execute('SELECT ' + ','.join(select) + ' FROM main.' + quote(table_name)):
                offset = 2 if rowid_alias else 0
                cells = [typed(values[offset + i * 2 + 1], values[offset + i * 2]) for i in range(len(columns))]
                rowid = typed(values[1], values[0]) if rowid_alias else None
                if rowid is not None and rowid['type'] != 'integer':
                    raise ValueError('invalid-rowid')
                rows.append({'rowid': rowid, 'cells': cells, 'primaryKey': [cells[index] for _, index, _ in pk_columns]})
                total_rows += 1
                total_cells += len(cells) + (1 if rowid_alias else 0)
                if total_rows > MAX_ROWS:
                    raise ValueError('excess-rows')
            rows.sort(key=encoded)  # Sort, never deduplicate repeated records.
            tables.append({'name': table_name, 'nameSha256': sha(table_name.encode()), 'tableXInfo': [[typed(v, 'text' if i in (1, 2, 4) and v is not None else None) for i, v in enumerate(row)] for row in xinfo],
                           'columns': columns, 'withoutRowid': bool(mode[2]), 'strict': bool(mode[3]), 'rowidAlias': rowid_alias,
                           'primaryKeyColumns': [{'position': position, 'index': index, 'name': name} for position, index, name in pk_columns],
                           'rows': rows, 'rowCount': len(rows), 'cellCount': len(rows) * (len(columns) + (1 if rowid_alias else 0))})
        project = next((table for table in tables if table['name'] == 'SM_Project'), None)
        if not project or 'SM_Project_id' not in project['columns'] or 'ProjectName' not in project['columns'] or len(project['rows']) != 1:
            raise ValueError('project-table-required')
        row = project['rows'][0]['cells']
        if text_value(row[project['columns'].index('SM_Project_id')]) != project_id or text_value(row[project['columns'].index('ProjectName')]) != project_name:
            raise ValueError('project-context-mismatch')
        pragmas = {name: typed(con.execute('PRAGMA ' + name).fetchone()[0]) for name in ('application_id', 'user_version', 'schema_version')}
        physical = {name: typed(con.execute('PRAGMA ' + name).fetchone()[0]) for name in ('page_size', 'page_count', 'freelist_count', 'auto_vacuum')}
        result = {'schemaVersion': 1, 'operation': 'native-sqlite-all-cell-census', 'readOnly': True,
                  'snapshot': {'sha256': sha(raw), 'size': len(raw)}, 'projectContext': {'projectId': project_id, 'projectName': project_name},
                  'sqliteVersion': sqlite3.sqlite_version, 'encoding': 'UTF-8', 'journalMode': 'delete', 'integrityCheck': 'ok',
                  'applicationPragmas': pragmas, 'physicalContainerPragmas': physical, 'schemaObjects': schema_objects, 'tables': tables,
                  'counts': {'schemaObjects': len(schema_objects), 'tables': len(tables), 'rows': total_rows, 'cellsIncludingRowid': total_cells},
                  'allPersistentTablesCovered': True, 'allSchemaObjectsCovered': True, 'hiddenColumnsIncluded': True, 'rowidsIncludedWhereAccessible': True,
                  'duplicateRowsRetained': True, 'excludedApplicationColumns': [], 'opaqueValuesInterpreted': False,
                  'closedCheckpointProvenByThisTool': False, 'losslessValidated': False, 'ordinaryApplySupported': False, 'safeToApply': False}
        result['logicalSha256'] = sha(encoded(logical(result)))
        con.execute('ROLLBACK')
    finally:
        con.close()
    no_sidecars(p)
    after, after_identity = read_regular(p)
    if after != raw or after_identity != original_identity:
        raise ValueError('sqlite-file-changed-during-read')
    return result


def snapshot(source, destination, project_id, project_name, require_project_directory=False):
    source = canonical_path(source)
    no_sidecars(source)
    directory_before = project_directory_manifest(source, project_name) if require_project_directory else None
    raw, source_identity = read_regular(source)
    dest = Path(destination)
    if not dest.is_absolute() or dest.suffix != '.db' or os.path.lexists(dest):
        raise ValueError('unsafe-destination')
    parent = canonical_path(dest.parent)
    if require_project_directory and parent == source.parent:
        raise ValueError('snapshot-inside-project-directory')
    parent_stat = parent.stat()
    if not stat.S_ISDIR(parent_stat.st_mode) or parent_stat.st_uid != os.getuid() or parent_stat.st_mode & 0o077:
        raise ValueError('private-destination-required')
    parent_identity = (parent_stat.st_dev, parent_stat.st_ino)
    publish_private(parent, dest.name, raw, parent_identity)
    no_sidecars(source)
    after, current_identity = read_regular(source)
    if after != raw or current_identity != source_identity:
        raise ValueError('source-changed-during-copy')
    result = census(dest, project_id, project_name)
    if result['snapshot'] != {'sha256': sha(raw), 'size': len(raw)}:
        raise ValueError('snapshot-readback-differs')
    census_path = Path(str(dest) + '.census.json')
    payload = encoded(result) + b'\n'
    if len(payload) > MAX_CENSUS:
        raise ValueError('excess-census')
    publish_private(parent, census_path.name, payload, parent_identity)
    directory_after = project_directory_manifest(source, project_name) if require_project_directory else None
    if directory_before != directory_after:
        raise ValueError('project-directory-changed')
    return {'schemaVersion': 1, 'operation': 'native-sqlite-readonly-snapshot', 'readOnly': True, 'projectId': project_id, 'projectName': project_name,
            'source': {'sha256': sha(raw), 'size': len(raw)}, 'snapshot': result['snapshot'], 'census': {'sha256': sha(payload), 'size': len(payload)},
            'logicalSha256': result['logicalSha256'], 'counts': result['counts'], 'allApplicationCellsCovered': True,
            'singleProjectDirectoryValidated': require_project_directory,
            'sourceDirectoryManifestSha256': sha(encoded(directory_before)) if require_project_directory else None,
            'sourceDirectoryEntryCount': 1 if require_project_directory else None,
            'closedCheckpointProvenByThisTool': False, 'sourceDatabaseWritten': False, 'losslessValidated': False, 'ordinaryApplySupported': False, 'safeToApply': False}


def publish_record(filename, value):
    destination = Path(filename)
    if not destination.is_absolute() or destination.suffix != '.json' or os.path.lexists(destination):
        raise ValueError('unsafe-record-destination')
    parent = canonical_path(destination.parent)
    s = parent.stat()
    payload = encoded(json.loads(value)) + b'\n'
    if len(payload) > 1024 * 1024:
        raise ValueError('excess-record')
    publish_private(parent, destination.name, payload, (s.st_dev, s.st_ino))
    return {'published': True, 'sha256': sha(payload), 'size': len(payload)}


def validate_census(value):
    def keys(v, expected):
        if type(v) is not dict or set(v) != set(expected):
            raise ValueError('invalid-census-record')

    def cell(v):
        if type(v) is not dict or v.get('type') not in ('null', 'integer', 'real', 'text', 'blob'):
            raise ValueError('invalid-typed-cell')
        kind = v['type']
        keys(v, ['type'] if kind == 'null' else ['type', 'decimal'] if kind == 'integer' else ['type', 'ieee754BigEndianHex'] if kind == 'real' else ['type', 'base64'])
        if kind == 'integer':
            number = v['decimal']
            if not isinstance(number, str) or len(number) > 21 or not re.fullmatch('-?(0|[1-9][0-9]*)', number) or str(int(number)) != number or not -(1 << 63) <= int(number) < (1 << 63):
                raise ValueError('invalid-integer-cell')
        elif kind == 'real':
            if not isinstance(v['ieee754BigEndianHex'], str) or not re.fullmatch('[a-f0-9]{16}', v['ieee754BigEndianHex']):
                raise ValueError('invalid-real-cell')
        elif kind in ('text', 'blob'):
            raw = base64.b64decode(v['base64'], validate=True)
            if base64.b64encode(raw).decode() != v['base64']:
                raise ValueError('noncanonical-cell-bytes')

    if type(value) is not dict or value.get('schemaVersion') != 1 or value.get('operation') != 'native-sqlite-all-cell-census' or value.get('readOnly') is not True:
        raise ValueError('invalid-census')
    keys(value, ['schemaVersion', 'operation', 'readOnly', 'snapshot', 'projectContext', 'sqliteVersion', 'encoding', 'journalMode', 'integrityCheck', 'applicationPragmas', 'physicalContainerPragmas', 'schemaObjects', 'tables', 'counts', 'allPersistentTablesCovered', 'allSchemaObjectsCovered', 'hiddenColumnsIncluded', 'rowidsIncludedWhereAccessible', 'duplicateRowsRetained', 'excludedApplicationColumns', 'opaqueValuesInterpreted', 'closedCheckpointProvenByThisTool', 'losslessValidated', 'ordinaryApplySupported', 'safeToApply', 'logicalSha256'])
    for name in ('allPersistentTablesCovered', 'allSchemaObjectsCovered', 'hiddenColumnsIncluded', 'rowidsIncludedWhereAccessible', 'duplicateRowsRetained'):
        if value[name] is not True:
            raise ValueError('incomplete-census')
    if value['excludedApplicationColumns'] != [] or any(value[name] is not False for name in ('opaqueValuesInterpreted', 'closedCheckpointProvenByThisTool', 'losslessValidated', 'ordinaryApplySupported', 'safeToApply')) or value['encoding'] != 'UTF-8' or value['journalMode'] != 'delete' or value['integrityCheck'] != 'ok':
        raise ValueError('census-scope')
    keys(value['snapshot'], ['sha256', 'size'])
    if not re.fullmatch('[a-f0-9]{64}', value['snapshot']['sha256']) or type(value['snapshot']['size']) is not int or not 0 < value['snapshot']['size'] <= MAX_DATABASE:
        raise ValueError('census-snapshot')
    keys(value['projectContext'], ['projectId', 'projectName'])
    if not UUID.fullmatch(value['projectContext']['projectId']) or not isinstance(value['projectContext']['projectName'], str):
        raise ValueError('census-project')
    keys(value['applicationPragmas'], ['application_id', 'user_version', 'schema_version'])
    keys(value['physicalContainerPragmas'], ['page_size', 'page_count', 'freelist_count', 'auto_vacuum'])
    for v in [*value['applicationPragmas'].values(), *value['physicalContainerPragmas'].values()]:
        cell(v)
        if v['type'] != 'integer':
            raise ValueError('census-pragma-type')
    if type(value['schemaObjects']) is not list or type(value['tables']) is not list or not 0 < len(value['tables']) <= MAX_TABLES:
        raise ValueError('census-lists')
    schema_rowids, table_names = set(), []
    for obj in value['schemaObjects']:
        keys(obj, ['rowid', 'type', 'name', 'tableName', 'rootPage', 'sql'])
        for c in obj.values():
            cell(c)
        key = encoded(obj['rowid'])
        if obj['rowid']['type'] != 'integer' or key in schema_rowids or obj['rootPage']['type'] != 'integer' or obj['sql']['type'] not in ('text', 'null'):
            raise ValueError('invalid-schema-object')
        schema_rowids.add(key)
        kind = text_value(obj['type'])
        text_value(obj['name'])
        text_value(obj['tableName'])
        if kind not in ('table', 'index', 'view', 'trigger'):
            raise ValueError('unsupported-schema-object')
        if kind == 'table':
            table_names.append(text_value(obj['name']))
    seen_tables, total_rows, total_cells = set(), 0, 0
    for table in value['tables']:
        keys(table, ['name', 'nameSha256', 'tableXInfo', 'columns', 'withoutRowid', 'strict', 'rowidAlias', 'primaryKeyColumns', 'rows', 'rowCount', 'cellCount'])
        name, columns = table['name'], table['columns']
        if not isinstance(name, str) or name in seen_tables or table['nameSha256'] != sha(name.encode()) or type(columns) is not list or not columns or len(set(columns)) != len(columns) or type(table['withoutRowid']) is not bool or type(table['strict']) is not bool:
            raise ValueError('ambiguous-table-or-columns')
        seen_tables.add(name)
        if not all(isinstance(c, str) and c and '\0' not in c for c in columns) or type(table['tableXInfo']) is not list or len(table['tableXInfo']) != len(columns):
            raise ValueError('invalid-column-coverage')
        expected_pk = []
        for index, row in enumerate(table['tableXInfo']):
            if type(row) is not list or len(row) != 7:
                raise ValueError('invalid-table-xinfo')
            for c in row:
                cell(c)
            if row[0] != typed(index) or text_value(row[1]) != columns[index] or row[5]['type'] != 'integer':
                raise ValueError('invalid-xinfo-binding')
            position = int(row[5]['decimal'])
            if position > 0:
                expected_pk.append({'position': position, 'index': index, 'name': columns[index]})
        expected_pk.sort(key=lambda r: r['position'])
        if table['primaryKeyColumns'] != expected_pk:
            raise ValueError('invalid-primary-key-metadata')
        if table['withoutRowid']:
            if table['rowidAlias'] is not None or not expected_pk:
                raise ValueError('invalid-without-rowid')
        elif table['rowidAlias'] not in ('rowid', '_rowid_', 'oid') or table['rowidAlias'].casefold() in {c.casefold() for c in columns}:
            raise ValueError('invalid-rowid-alias')
        if type(table['rows']) is not list or table['rowCount'] != len(table['rows']) or table['cellCount'] != len(table['rows']) * (len(columns) + (0 if table['withoutRowid'] else 1)):
            raise ValueError('invalid-row-count')
        seen_rows = set()
        for row in table['rows']:
            keys(row, ['rowid', 'cells', 'primaryKey'])
            if type(row['cells']) is not list or len(row['cells']) != len(columns):
                raise ValueError('invalid-cell-coverage')
            for c in row['cells']:
                cell(c)
            if row['primaryKey'] != [row['cells'][p['index']] for p in expected_pk]:
                raise ValueError('invalid-row-primary-key')
            if table['withoutRowid']:
                if row['rowid'] is not None:
                    raise ValueError('unexpected-rowid')
                key = encoded(row['primaryKey'])
            else:
                cell(row['rowid'])
                if row['rowid']['type'] != 'integer':
                    raise ValueError('noninteger-rowid')
                key = encoded(row['rowid'])
            if key in seen_rows:
                raise ValueError('ambiguous-row-identity')
            seen_rows.add(key)
        total_rows += table['rowCount']
        total_cells += table['cellCount']
    if len(table_names) != len(set(table_names)) or set(table_names) != seen_tables:
        raise ValueError('schema-table-membership-differs')
    if value['counts'] != {'schemaObjects': len(value['schemaObjects']), 'tables': len(value['tables']), 'rows': total_rows, 'cellsIncludingRowid': total_cells} or total_rows > MAX_ROWS or value['logicalSha256'] != sha(encoded(logical(value))):
        raise ValueError('census-digest-or-counts')
    return value


def compare_censuses(before, after, edit=None):
    validate_census(before)
    validate_census(after)
    if before['operation'] != 'native-sqlite-all-cell-census' or after['operation'] != before['operation'] or before['projectContext'] != after['projectContext']:
        raise ValueError('census-context-mismatch')
    expected = json.loads(encoded(logical(before)))
    target = None
    if edit is not None:
        if set(edit) != {'projectId', 'itemId', 'oldName', 'newName'} or edit['projectId'] != before['projectContext']['projectId'] or not UUID.fullmatch(edit['itemId']) or edit['oldName'] == edit['newName']:
            raise ValueError('invalid-name-cell-edit')
        table = next((t for t in expected['tables'] if t['name'] == 'Sm2TiItem'), None)
        if not table or 'Sm2TiItem_id' not in table['columns'] or 'Name' not in table['columns']:
            raise ValueError('name-table-required')
        key_index, name_index = table['columns'].index('Sm2TiItem_id'), table['columns'].index('Name')
        if not any(p['index'] == key_index for p in table['primaryKeyColumns']):
            raise ValueError('target-not-primary-key')
        matches = [r for r in table['rows'] if r['cells'][key_index] == typed(edit['itemId'])]
        if len(matches) != 1 or matches[0]['cells'][name_index] != typed(edit['oldName']):
            raise ValueError('stale-name-cell')
        matches[0]['cells'][name_index] = typed(edit['newName'])
        if any(p['index'] == name_index for p in table['primaryKeyColumns']):
            raise ValueError('name-is-primary-key')
        table['rows'].sort(key=encoded)
        target = {'tableNameSha256': table['nameSha256'], 'itemId': edit['itemId'], 'columnNameSha256': sha(b'Name'),
                  'oldValueSha256': sha(encoded(typed(edit['oldName']))), 'newValueSha256': sha(encoded(typed(edit['newName'])))}
    actual = logical(after)
    differences = []
    if expected['applicationPragmas'] != actual['applicationPragmas']:
        differences.append({'status': 'application-pragmas-changed'})
    if expected['schemaObjects'] != actual['schemaObjects']:
        differences.append({'status': 'schema-objects-changed'})
    old = {t['name']: t for t in expected['tables']}
    new = {t['name']: t for t in actual['tables']}
    for name in sorted(set(old) | set(new)):
        a, b = old.get(name), new.get(name)
        if a != b:
            detail = {'status': 'added-table' if a is None else 'removed-table' if b is None else 'table-cells-or-metadata-changed',
                                'tableNameSha256': sha(name.encode()), 'beforeSha256': sha(encoded(a)) if a else None, 'afterSha256': sha(encoded(b)) if b else None,
                                'beforeRows': a['rowCount'] if a else None, 'afterRows': b['rowCount'] if b else None}
            if a and b:
                def indexed(table):
                    rows = {}
                    for row in table['rows']:
                        key = encoded({'rowid': row['rowid']} if row['rowid'] is not None else {'primaryKey': row['primaryKey']})
                        if key in rows:
                            raise ValueError('ambiguous-row-identity')
                        rows[key] = row
                    return rows
                old_rows, new_rows = indexed(a), indexed(b)
                changed_rows, changed_cells, row_details = 0, 0, []
                for key in sorted(set(old_rows) | set(new_rows)):
                    x, y = old_rows.get(key), new_rows.get(key)
                    if x == y:
                        continue
                    changed_rows += 1
                    row_detail = {'rowIdentitySha256': sha(key), 'status': 'added-row' if x is None else 'removed-row' if y is None else 'changed-cells', 'cells': []}
                    count = max(len(x['cells']) if x else 0, len(y['cells']) if y else 0)
                    for index in range(count):
                        left = x['cells'][index] if x and index < len(x['cells']) else None
                        right = y['cells'][index] if y and index < len(y['cells']) else None
                        if left != right:
                            changed_cells += 1
                            if len(row_detail['cells']) < 64:
                                column = a['columns'][index] if index < len(a['columns']) else b['columns'][index]
                                row_detail['cells'].append({'columnIndex': index, 'columnNameSha256': sha(column.encode()),
                                    'beforeType': left['type'] if left else None, 'afterType': right['type'] if right else None,
                                    'beforeValueSha256': sha(encoded(left)) if left else None, 'afterValueSha256': sha(encoded(right)) if right else None})
                    if len(row_details) < 64:
                        row_details.append(row_detail)
                detail.update(changedRows=changed_rows, changedCells=changed_cells, rowChanges=row_details,
                              detailsTruncated=changed_rows > len(row_details) or changed_cells > sum(len(r['cells']) for r in row_details))
            differences.append(detail)
    return {'schemaVersion': 1, 'operation': 'compare-native-sqlite-all-cells', 'readOnly': True,
            'projectId': before['projectContext']['projectId'], 'beforeSnapshot': before['snapshot'], 'afterSnapshot': after['snapshot'],
            'beforeLogicalSha256': sha(encoded(logical(before))), 'afterLogicalSha256': sha(encoded(actual)),
            'allSuppliedApplicationValuesCompared': True, 'excludedApplicationColumns': [], 'authorizedNameCell': target,
            'unexplainedDifferences': differences, 'allOtherApplicationValuesPreserved': not differences,
            'physicalFileBytesEqual': before['snapshot'] == after['snapshot'], 'physicalContainerEncodingComparedSeparately': True,
            'closedCheckpointProvenByThisFunction': False, 'runtimeExecutionValidated': False, 'losslessValidated': False,
            'ordinaryApplySupported': False, 'safeToApply': False}


if __name__ == '__main__':
    try:
        op, *args = sys.argv[1:]
        if op == 'snapshot' and len(args) in (4, 5):
            if len(args) == 5 and args[4] != 'single-project-file':
                raise ValueError('unsupported-source-directory-scope')
            result = snapshot(*args[:4], require_project_directory=len(args) == 5)
        elif op == 'census' and len(args) == 3:
            result = census(*args)
        elif op == 'compare' and len(args) in (2, 3):
            a = json.loads(read_regular(args[0], MAX_CENSUS)[0])
            b = json.loads(read_regular(args[1], MAX_CENSUS)[0])
            result = compare_censuses(a, b, json.loads(args[2]) if len(args) == 3 else None)
        elif op == 'publish-record' and len(args) == 2:
            result = publish_record(*args)
        else:
            raise ValueError('usage')
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    except Exception as error:
        # Codes only: private paths and native values never enter stdout/stderr.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z0-9-]+', str(error)) else 'native-sqlite-inspection-failed'
        print(code, file=sys.stderr)
        sys.exit(1)
