import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_sqlite', Path(__file__).with_name('resolve-native-sqlite-snapshot.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
PROJECT = 'ad9b6092-e709-475b-8986-79c0adfef8da'
ITEM = 'dd124594-a329-4d94-b79c-3bb069cb88cb'


class NativeSqliteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='frameline-native-sqlite-test-')
        self.root = Path(self.tmp.name).resolve()
        self.root.chmod(0o700)
        self.source = self.root / 'Project.db'
        c = sqlite3.connect(self.source)
        c.executescript('''
CREATE TABLE SM_Project(SM_Project_id TEXT PRIMARY KEY, ProjectName TEXT);
CREATE TABLE Sm2TiItem(Sm2TiItem_id TEXT PRIMARY KEY, Name TEXT, UnknownBlob BLOB);
CREATE TABLE UnknownValues(i, r, t, b, n);
CREATE TABLE Multi(k TEXT, value BLOB);
CREATE TABLE Composite(a TEXT, b INTEGER, payload BLOB, PRIMARY KEY(a,b)) WITHOUT ROWID;
CREATE TABLE Generated(source TEXT, derived TEXT GENERATED ALWAYS AS (upper(source)) VIRTUAL);
CREATE TABLE Auto(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
CREATE INDEX unknown_idx ON UnknownValues(i);
CREATE VIEW opaque_view AS SELECT * FROM UnknownValues;
CREATE TRIGGER untouched_trigger AFTER INSERT ON Auto BEGIN SELECT 1; END;
''')
        c.execute('INSERT INTO SM_Project VALUES(?,?)', (PROJECT, 'Synthetic preservation'))
        c.execute('INSERT INTO Sm2TiItem VALUES(?,?,?)', (ITEM, 'before', b'\x00\xff\x80opaque'))
        c.execute("INSERT INTO UnknownValues VALUES(9223372036854775807,1.25,CAST(x'ff0080' AS TEXT),x'0000ff80',NULL)")
        c.executemany('INSERT INTO Multi VALUES(?,?)', [('same', b'\x00'), ('same', b'\x00')])
        c.execute('INSERT INTO Composite VALUES(?,?,?)', ('key', 7, b'\xff'))
        c.execute('INSERT INTO Generated(source) VALUES(?)', ('abc',))
        c.execute('INSERT INTO Auto(value) VALUES(?)', ('value',))
        c.execute('ANALYZE')
        c.commit()
        c.close()
        self.source.chmod(0o600)

    def tearDown(self):
        self.tmp.cleanup()

    def census(self, source=None):
        return m.census(source or self.source, PROJECT, 'Synthetic preservation')

    def clone(self, name):
        p = self.root / name
        shutil.copyfile(self.source, p)
        p.chmod(0o600)
        return p

    def test_complete_schema_internal_hidden_typed_cells_and_multiplicity(self):
        before = self.source.read_bytes()
        r = self.census()
        self.assertEqual(before, self.source.read_bytes())
        tables = {t['name']: t for t in r['tables']}
        self.assertIn('sqlite_sequence', tables)
        self.assertIn('sqlite_stat1', tables)
        self.assertEqual(tables['Multi']['rowCount'], 2)
        self.assertNotEqual(tables['Multi']['rows'][0]['rowid'], tables['Multi']['rows'][1]['rowid'])
        self.assertTrue(tables['Composite']['withoutRowid'])
        self.assertIsNone(tables['Composite']['rowidAlias'])
        self.assertEqual(len(tables['Composite']['primaryKeyColumns']), 2)
        self.assertEqual(len(tables['Generated']['columns']), 2)
        self.assertEqual(tables['Generated']['tableXInfo'][1][6], m.typed(2))
        cells = tables['UnknownValues']['rows'][0]['cells']
        self.assertEqual(cells[0], {'type': 'integer', 'decimal': '9223372036854775807'})
        self.assertEqual(cells[1], {'type': 'real', 'ieee754BigEndianHex': '3ff4000000000000'})
        self.assertEqual(base64.b64decode(cells[2]['base64']), b'\xff\x00\x80')
        self.assertEqual(cells[2]['type'], 'text')
        self.assertEqual(cells[3]['type'], 'blob')
        self.assertEqual(cells[4], {'type': 'null'})
        kinds = [m.text_value(o['type']) for o in r['schemaObjects']]
        self.assertIn('trigger', kinds)
        self.assertIn('view', kinds)
        self.assertIn('index', kinds)
        self.assertEqual(r['excludedApplicationColumns'], [])

    def test_raw_snapshot_private_readback_and_no_source_write(self):
        raw, original = m.read_regular(self.source)
        copied = self.root / 'snapshot.db'
        r = m.snapshot(self.source, copied, PROJECT, 'Synthetic preservation')
        self.assertEqual(raw, copied.read_bytes())
        self.assertEqual(m.read_regular(self.source), (raw, original))
        self.assertEqual(copied.stat().st_mode & 0o777, 0o600)
        census_file = Path(str(copied) + '.census.json')
        self.assertEqual(census_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(m.sha(census_file.read_bytes()), r['census']['sha256'])
        self.assertFalse(r['sourceDatabaseWritten'])
        self.assertFalse(r['closedCheckpointProvenByThisTool'])
        with self.assertRaises(ValueError):
            m.snapshot(self.source, copied, PROJECT, 'Synthetic preservation')

    def test_exact_one_primary_key_name_cell_only(self):
        after_file = self.clone('edited.db')
        c = sqlite3.connect(after_file)
        c.execute('UPDATE Sm2TiItem SET Name=? WHERE Sm2TiItem_id=?', ('after', ITEM))
        c.commit()
        c.close()
        before, after = self.census(), self.census(after_file)
        self.assertFalse(m.compare_censuses(before, after)['allOtherApplicationValuesPreserved'])
        r = m.compare_censuses(before, after, {'projectId': PROJECT, 'itemId': ITEM, 'oldName': 'before', 'newName': 'after'})
        self.assertTrue(r['allOtherApplicationValuesPreserved'])
        self.assertFalse(r['physicalFileBytesEqual'])
        self.assertFalse(r['losslessValidated'])
        self.assertEqual(r['excludedApplicationColumns'], [])

    def test_unknown_blob_type_multiplicity_rowid_and_schema_changes_all_fail(self):
        statements = ["UPDATE Sm2TiItem SET UnknownBlob=x'00ff81'", "UPDATE UnknownValues SET r=CAST(1 AS INTEGER)",
                      "INSERT INTO Multi VALUES('same',x'00')", "UPDATE Multi SET rowid=rowid+100", 'CREATE TABLE Extra(unknown BLOB)']
        for index, sql in enumerate(statements):
            copied = self.clone('changed' + str(index) + '.db')
            c = sqlite3.connect(copied)
            c.execute(sql)
            c.commit()
            c.close()
            self.assertFalse(m.compare_censuses(self.census(), self.census(copied))['allOtherApplicationValuesPreserved'])

    def test_wrong_project_stale_target_and_missing_primary_key_refuse(self):
        with self.assertRaises(ValueError):
            m.census(self.source, '00000000-0000-4000-8000-000000000001', 'Synthetic preservation')
        with self.assertRaises(ValueError):
            m.compare_censuses(self.census(), self.census(), {'projectId': PROJECT, 'itemId': ITEM, 'oldName': 'stale', 'newName': 'after'})

    def test_sidecars_symlinks_hardlinks_and_fifo_refuse_without_copying(self):
        for suffix in ('-journal', '-wal', '-shm'):
            sidecar = Path(str(self.source) + suffix)
            sidecar.write_bytes(b'')
            with self.assertRaises(ValueError):
                self.census()
            sidecar.unlink()
        alias = self.root / 'alias.db'
        alias.symlink_to(self.source)
        with self.assertRaises(ValueError):
            self.census(alias)
        alias.unlink()
        os.link(self.source, alias)
        with self.assertRaises(ValueError):
            self.census()
        alias.unlink()
        fifo = self.root / 'fifo.db'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError):
            self.census(fifo)

    def test_inaccessible_rowid_and_virtual_tables_refuse(self):
        p = self.clone('shadow.db')
        c = sqlite3.connect(p)
        c.execute('CREATE TABLE RowidShadow(rowid,_rowid_,oid)')
        c.commit()
        c.close()
        with self.assertRaisesRegex(ValueError, 'inaccessible-rowid'):
            self.census(p)
        p = self.clone('virtual.db')
        c = sqlite3.connect(p)
        c.execute('CREATE VIRTUAL TABLE Fts USING fts5(value)')
        c.commit()
        c.close()
        with self.assertRaises((ValueError, sqlite3.DatabaseError)):
            self.census(p)

    def test_public_diagnostics_do_not_expose_native_values(self):
        c = self.clone('changed.db')
        con = sqlite3.connect(c)
        con.execute("UPDATE Sm2TiItem SET UnknownBlob=x'abcdef'")
        con.commit()
        con.close()
        report = m.compare_censuses(self.census(), self.census(c))
        serialized = json.dumps(report)
        self.assertNotIn('Synthetic preservation', serialized)
        self.assertNotIn('UnknownBlob', serialized)
        self.assertNotIn('abcdef', serialized)
        self.assertTrue(report['unexplainedDifferences'])

    def test_explicit_project_directory_scope_requires_only_project_database(self):
        source_dir = self.root / 'Synthetic preservation'
        source_dir.mkdir(mode=0o700)
        source = source_dir / 'Project.db'
        shutil.copyfile(self.source, source)
        source.chmod(0o600)
        r = m.snapshot(source, self.root / 'single-project.db', PROJECT, 'Synthetic preservation', True)
        self.assertTrue(r['singleProjectDirectoryValidated'])
        self.assertEqual(r['sourceDirectoryEntryCount'], 1)
        self.assertRegex(r['sourceDirectoryManifestSha256'], '^[a-f0-9]{64}$')
        (source_dir / 'unknown.bin').write_bytes(b'unknown')
        with self.assertRaisesRegex(ValueError, 'unknown-project-directory-member'):
            m.snapshot(source, self.root / 'must-refuse.db', PROJECT, 'Synthetic preservation', True)

    def test_forged_duplicate_table_or_row_identity_cannot_be_silently_deduplicated(self):
        for mode in ('table', 'row'):
            source = self.census()
            forged = json.loads(m.encoded(source))
            if mode == 'table':
                forged['tables'].append(forged['tables'][0])
            else:
                target = next(t for t in forged['tables'] if t['name'] == 'Multi')
                target['rows'].append(target['rows'][0])
                target['rowCount'] += 1
                target['cellCount'] += len(target['columns']) + 1
            forged['logicalSha256'] = m.sha(m.encoded(m.logical(forged)))
            with self.assertRaises(ValueError):
                m.compare_censuses(forged, forged)


if __name__ == '__main__':
    unittest.main()
