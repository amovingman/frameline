"""One stale-checked Name edit on a NEW PRIVATE COPY. Never publishes to a library."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys

HELPER = Path(__file__).with_name('resolve-native-sqlite-snapshot.py')
HELPER_SHA = '35bc1c7c324f63e7066cf77c22627a3a56a93e66c3427e14cd0bc0aa8a5c82d6'
if hashlib.sha256(HELPER.read_bytes()).hexdigest() != HELPER_SHA:
    raise ValueError('snapshot-helper-changed')
spec = importlib.util.spec_from_file_location('snapshot_helper', HELPER)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def create_name_copy(source_snapshot, destination, project_id, project_name, item_id, old_name, new_name, expected_sha):
    if not m.UUID.fullmatch(item_id) or not isinstance(new_name, str) or not 1 <= len(new_name.encode()) <= 256 or any(ord(c) < 32 or ord(c) == 127 or c in '/\\' for c in new_name) or new_name == old_name:
        raise ValueError('invalid-name-edit')
    source = m.canonical_path(source_snapshot)
    target = Path(destination)
    parent = m.canonical_path(target.parent)
    ps = parent.lstat()
    if parent != target.parent or ps.st_uid != os.getuid() or not stat.S_ISDIR(ps.st_mode) or ps.st_mode & 0o077 or list(parent.iterdir()):
        raise ValueError('new-private-empty-output-directory-required')
    if parent == source.parent or parent in source.parents or source.parent in parent.parents or target.name != 'edited.db':
        raise ValueError('separate-private-copy-required')
    raw, source_identity = m.read_regular(source)
    if m.sha(raw) != expected_sha:
        raise ValueError('source-snapshot-differs')
    before = m.census(source, project_id, project_name)
    edit = dict(projectId=project_id, itemId=item_id, oldName=old_name, newName=new_name)
    # Validate primary key, exact stale Name and unique occurrence before writing.
    m.compare_censuses(before, before, edit)
    m.publish_private(parent, target.name, raw, (ps.st_dev, ps.st_ino))
    con = sqlite3.connect(target.as_uri() + '?mode=rw', uri=True, isolation_level=None)
    try:
        if hasattr(con, 'enable_load_extension'):
            con.enable_load_extension(False)
        con.execute('PRAGMA trusted_schema=OFF')
        con.execute('PRAGMA synchronous=FULL')
        if con.execute('PRAGMA journal_mode').fetchone() != ('delete',):
            raise ValueError('delete-journal-required')
        def authorize(action, one, two, database, trigger):
            if action == sqlite3.SQLITE_UPDATE and (one != 'Sm2TiItem' or two != 'Name' or database != 'main' or trigger is not None):
                return sqlite3.SQLITE_DENY
            if action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_DELETE, sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_ALTER_TABLE, sqlite3.SQLITE_DROP_TABLE):
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        con.set_authorizer(authorize)
        con.execute('BEGIN IMMEDIATE')
        changed = con.execute('UPDATE main.Sm2TiItem SET Name=? WHERE Sm2TiItem_id=? AND typeof(Name)=\'text\' AND CAST(Name AS BLOB)=?', (new_name, item_id, old_name.encode('utf-8'))).rowcount
        if changed != 1:
            raise ValueError('stale-name-cell')
        con.execute('COMMIT')
    finally:
        con.close()
    m.no_sidecars(target)
    after = m.census(target, project_id, project_name)
    comparison = m.compare_censuses(before, after, edit)
    if not comparison['allOtherApplicationValuesPreserved']:
        raise ValueError('unrelated-application-value-changed')
    current, current_identity = m.read_regular(source)
    if current != raw or current_identity != source_identity:
        raise ValueError('source-snapshot-changed')
    with target.open('rb') as f:
        os.fsync(f.fileno())
    result = dict(schemaVersion=1, operation='private-native-sqlite-name-copy', sourceSnapshotSha256=expected_sha,
                  outputSnapshot=after['snapshot'], projectId=project_id, itemId=item_id,
                  allOtherApplicationValuesPreserved=True, excludedApplicationColumns=[],
                  sourceDatabaseWritten=False, privateCopyOnly=True, libraryPublicationPerformed=False,
                  runtimeExecutionValidated=False, losslessValidated=False, ordinaryApplySupported=False,
                  safeToApply=False, comparison=comparison)
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(create_name_copy(*sys.argv[1:]), sort_keys=True))
    except Exception as error:
        print('private-native-name-copy-refused:' + str(error), file=sys.stderr)
        sys.exit(1)
