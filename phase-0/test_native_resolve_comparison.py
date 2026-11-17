import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('compare-native-resolve-exports.py')
spec = importlib.util.spec_from_file_location('native_comparison', SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class NativeComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def archive(self, name, blob='0000', sequence_name='Clip', extra=None):
        target = self.root / name
        with zipfile.ZipFile(target, 'w') as output:
            output.writestr('project.xml', '<SM_Project><FieldsBlob>' + blob + '</FieldsBlob></SM_Project>')
            output.writestr('MediaPool/Master/MpFolder.xml', '<Folder/>')
            output.writestr('SeqContainer/timeline.xml', '<Sequence>\n<Name>' + sequence_name + '</Name>\n</Sequence>')
            if extra:
                output.writestr(*extra)
        return target

    def test_opaque_changes_are_reported_and_never_treated_as_harmless(self):
        before = self.archive('before.drp')
        after = self.archive('after.drp', '1111')
        report = probe.compare_exports(before, after)
        self.assertFalse(report['memberBytesMatch'])
        self.assertFalse(report['losslessValidated'])
        self.assertFalse(report['safeToApply'])
        self.assertEqual(report['changedMembers'], 1)
        changed = next(member for member in report['members'] if member['status'] == 'changed')
        self.assertEqual(changed['changedLineTags'], {'SM_Project': {'added': 1, 'removed': 1}})
        self.assertNotEqual(changed['beforeSha256'], changed['afterSha256'])

    def test_report_never_discloses_member_names_or_values(self):
        before = self.archive('before.drp', extra=('MediaPool/private-client-name.xml', 'secret-local-path'))
        after = self.archive('after.drp', sequence_name='private-clip-name', extra=('MediaPool/private-client-name.xml', '<private-custom-tag>other-secret</private-custom-tag>'))
        encoded = json.dumps(probe.compare_exports(before, after))
        for private in ['private-client-name', 'secret-local-path', 'private-clip-name', 'private-custom-tag', str(self.root)]:
            self.assertNotIn(private, encoded)

    def test_identical_bytes_remain_observation_evidence_only(self):
        source = self.archive('source.drp')
        report = probe.compare_exports(source, source)
        self.assertTrue(report['memberBytesMatch'])
        self.assertFalse(report['losslessValidated'])
        self.assertEqual(report['before'], report['after'])

    def test_rejects_symlink_traversal_duplicate_and_expansion_limits(self):
        source = self.archive('source.drp')
        link = self.root / 'link.drp'
        link.symlink_to(source)
        with self.assertRaises(ValueError):
            probe.read_export(link)
        if hasattr(os, 'mkfifo'):
            fifo = self.root / 'pipe.drp'
            os.mkfifo(fifo)
            with self.assertRaises(ValueError):
                probe.read_export(fifo)
        traversal = self.archive('traversal.drp', extra=('../outside', 'x'))
        with self.assertRaises(ValueError):
            probe.read_export(traversal)
        duplicate = self.archive('duplicate.drp', extra=('project.xml', '<Other/>'))
        with self.assertRaises(ValueError):
            probe.read_export(duplicate)
        previous = probe.MAX_MEMBER
        try:
            probe.MAX_MEMBER = 1
            with self.assertRaises(ValueError):
                probe.read_export(source)
        finally:
            probe.MAX_MEMBER = previous

    def test_cli_error_does_not_disclose_input_path(self):
        run = subprocess.run([sys.executable, str(SCRIPT), '/private/nonexistent-sensitive-source.drp', '/private/other.drp'], capture_output=True, text=True)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stderr, 'native-resolve-comparison-failed\n')
        self.assertEqual(run.stdout, '')


if __name__ == '__main__':
    unittest.main()
