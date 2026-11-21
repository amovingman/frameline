import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
import test_native_sqlite_preservation as fixture
PROJECT, ITEM = fixture.PROJECT, fixture.ITEM

spec = importlib.util.spec_from_file_location('private_name_copy', Path(__file__).with_name('native-sqlite-name-copy.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class PrivateNameCopyTests(unittest.TestCase):
    setUp = fixture.NativeSqliteTests.setUp
    tearDown = fixture.NativeSqliteTests.tearDown

    def execute(self, output, item=ITEM, old='before'):
        return w.create_name_copy(str(self.source), str(output), PROJECT, 'Synthetic preservation', item, old, 'after custom', w.m.sha(self.source.read_bytes()))

    def test_only_one_typed_name_cell_changes_and_source_is_untouched(self):
        raw = self.source.read_bytes()
        with tempfile.TemporaryDirectory(prefix='frameline-native-name-copy-') as output:
            target = Path(output).resolve() / 'edited.db'
            result = self.execute(target)
            self.assertTrue(result['allOtherApplicationValuesPreserved'])
            self.assertTrue(result['privateCopyOnly'])
            self.assertFalse(result['libraryPublicationPerformed'])
            self.assertFalse(result['runtimeExecutionValidated'])
            self.assertFalse(result['losslessValidated'])
            self.assertEqual(self.source.read_bytes(), raw)
            self.assertEqual(sorted(p.name for p in target.parent.iterdir()), ['edited.db'])
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                self.execute(target)

    def test_stale_name_and_trigger_side_effects_refuse(self):
        for trigger in (False, True):
            if trigger:
                c = sqlite3.connect(self.source)
                c.execute("CREATE TRIGGER name_side_effect AFTER UPDATE OF Name ON Sm2TiItem BEGIN UPDATE Sm2TiItem SET UnknownBlob=x'01'; END")
                c.commit();c.close()
            raw = self.source.read_bytes()
            with tempfile.TemporaryDirectory(prefix='frameline-native-name-copy-') as output:
                with self.assertRaises((ValueError, sqlite3.DatabaseError)):
                    self.execute(Path(output).resolve() / 'edited.db', old='before' if trigger else 'wrong')
            self.assertEqual(self.source.read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
