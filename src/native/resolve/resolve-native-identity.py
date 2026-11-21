"""Read the sole native project identity without modifying the database."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys

helper = Path(__file__).with_name('resolve-native-sqlite-snapshot.py')
if hashlib.sha256(helper.read_bytes()).hexdigest() != '35bc1c7c324f63e7066cf77c22627a3a56a93e66c3427e14cd0bc0aa8a5c82d6':
    raise ValueError('identity-reader-helper-changed')
spec = importlib.util.spec_from_file_location('identity_snapshot', helper)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def identify(source):
    p = m.canonical_path(source)
    m.no_sidecars(p)
    raw, identity = m.read_regular(p)
    con = sqlite3.connect(p.as_uri() + '?mode=ro', uri=True, isolation_level=None)
    try:
        con.execute('PRAGMA query_only=ON')
        con.execute('PRAGMA trusted_schema=OFF')
        rows = con.execute('SELECT SM_Project_id, ProjectName, DbType FROM main.SM_Project LIMIT 2').fetchall()
        if len(rows) != 1:
            raise ValueError('single-native-project-required')
        project_id, project_name, kind = rows[0]
        if not isinstance(project_id, str) or not m.UUID.fullmatch(project_id) or not isinstance(project_name, str) or not 1 <= len(project_name.encode()) <= 512 or any(ord(c) < 32 or c in '/\\' for c in project_name) or kind != 'SM_Project':
            raise ValueError('native-project-identity-invalid')
    finally:
        con.close()
    m.no_sidecars(p)
    after, last_identity = m.read_regular(p)
    if raw != after or identity != last_identity:
        raise ValueError('native-project-changed')
    return dict(schemaVersion=1, operation='native-project-identity-read', readOnly=True,
                projectId=project_id, projectName=project_name, sourceSha256=m.sha(raw), bytes=len(raw))

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('source-required')
        print(json.dumps(identify(sys.argv[1]), sort_keys=True))
    except Exception as error:
        print('native-identity-refused:' + str(error), file=sys.stderr)
        sys.exit(1)
