import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fields', ROOT / 'phase-0/resolve-native-field-inventory.py')
fields = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fields)
P = 'dd82cbdf-ff6f-4bbb-8648-ffa52dcd68ff'
I = 'ccb4c9a5-2189-4b81-82c9-bf099c49eec1'


class NativeFields(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-field-inventory-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def archive(self, name, blob='000aFF', hidden='one', nested=None, duplicate=False):
        path = self.root / (name + '.drp')
        item = f'<Sm2TiVideoClip DbId="{I}"><FieldsBlob>{blob}</FieldsBlob></Sm2TiVideoClip>'
        body = '/Users/private/source.mov' if nested is None else '<Value>' + nested + '</Value>'
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('project.xml', f'<SM_Project DbId="{P}"><FieldsBlob>00</FieldsBlob><Body>{body}</Body><Hidden>{hidden}</Hidden></SM_Project>')
            archive.writestr('MediaPool/Master/MpFolder.xml', '<Folder><FieldsBlob /></Folder>')
            archive.writestr('SeqContainer/timeline.xml', '<Sm2SequenceContainer>' + item + (item if duplicate else '') + '</Sm2SequenceContainer>')
        path.chmod(0o600)
        return str(path)

    def test_payload_hashes_and_explicit_owner_are_private_and_not_semantics(self):
        archive = self.archive('first')
        api = self.root / 'api.json'
        raw = gzip.decompress((ROOT / 'phase-0/resolve-operation-baseline-observation.json.gz').read_bytes())
        api.write_text(json.dumps(json.loads(raw)['snapshot']))
        report = fields.inventory(archive, str(api))
        item = next(row for row in report['records'] if row['ownerNativeId'] == I)
        self.assertEqual(item['encoding'], 'hex-octets')
        self.assertEqual(item['decodedBytes'], 3)
        self.assertEqual(item['decodedSha256'], fields.sha(bytes.fromhex('000aff')))
        self.assertTrue(item['ownerMatchesApiItemId'])
        self.assertNotIn('/Users/', json.dumps(report))
        self.assertNotIn('source.mov', json.dumps(report))
        self.assertFalse(report['allNativeFieldsCovered'])
        self.assertFalse(report['safeToApply'])

    def test_changed_opaque_payload_is_localized_without_ignoring_it(self):
        before, after = self.archive('before'), self.archive('after', blob='000aFE')
        report = fields.compare(before, after)
        self.assertEqual(len(report['selectedPayloadChanges']), 1)
        change = report['selectedPayloadChanges'][0]
        self.assertEqual(change['ownerNativeId'], I)
        self.assertEqual(change['tag'], 'FieldsBlob')
        self.assertNotEqual(change['before']['decodedSha256'], change['after']['decodedSha256'])
        self.assertFalse(report['rawMemberBytesMatch'])
        self.assertFalse(report['losslessValidated'])

    def test_uncovered_and_nested_changes_never_become_equality_proof(self):
        before, after = self.archive('before'), self.archive('after', hidden='two')
        report = fields.compare(before, after)
        self.assertTrue(report['selectedParsedTextAndShapeMatch'])
        self.assertFalse(report['rawMemberBytesMatch'])
        self.assertFalse(report['completeSelectedPayloadEqualityProven'])
        nested = fields.compare(self.archive('nested1', nested='one'), self.archive('nested2', nested='two'))
        self.assertTrue(nested['selectedParsedTextAndShapeMatch'])
        self.assertFalse(nested['rawMemberBytesMatch'])
        self.assertFalse(nested['completeSelectedPayloadEqualityProven'])

    def test_duplicate_owner_locations_and_symlink_inputs_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            fields.inventory(self.archive('duplicate', duplicate=True))
        original = Path(self.archive('real'))
        alias = self.root / 'alias.drp'
        alias.symlink_to(original)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            fields.inventory(str(alias))

    def test_member_rename_is_location_change_without_inventing_payload_delta(self):
        before = self.archive('before')
        after = self.root / 'after.drp'
        with zipfile.ZipFile(before) as old, zipfile.ZipFile(after, 'w') as new:
            for name in old.namelist():
                new.writestr(name.replace('SeqContainer/timeline.xml', 'SeqContainer/renamed.xml'), old.read(name))
        report = fields.compare(before, str(after))
        self.assertEqual(report['selectedPayloadChanges'], [])
        self.assertEqual(len(report['memberLocationChangesWithSameObservedPayload']), 1)
        self.assertFalse(report['rawMemberBytesMatch'])
        self.assertFalse(report['losslessValidated'])

    def test_reparented_nested_owner_reports_context_change_without_payload_inference(self):
        raw = gzip.decompress((ROOT / 'phase-0/resolve-operation-baseline-observation.json.gz').read_bytes())
        snapshot = json.loads(raw)['snapshot']
        other = next(item['id'] for item in snapshot['timelines'][0]['items'] if item['id'] != I)
        api = self.root / 'api.json'
        api.write_text(json.dumps(snapshot))
        owner = '12345678-1234-1234-1234-123456789012'
        files = []
        for label, parent in [('before', I), ('after', other)]:
            filename = Path(self.archive(label))
            with zipfile.ZipFile(filename, 'a') as archive:
                archive.writestr('SeqContainer/extra.xml', f'<Container><Sm2TiVideoClip DbId="{parent}"><Correction DbId="{owner}"><FieldsBlob>00</FieldsBlob></Correction></Sm2TiVideoClip></Container>')
            files.append(str(filename))
        result = fields.compare(*files, str(api))
        self.assertEqual(result['selectedPayloadChanges'], [])
        self.assertEqual(len(result['apiItemAncestorMatchChanges']), 1)
        self.assertFalse(result['pairedApiItemAncestorMatchesUnchanged'])
        self.assertFalse(result['completeSelectedPayloadEqualityProven'])


if __name__ == '__main__':
    unittest.main()
