import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('census', Path(__file__).with_name('resolve-native-byte-census.py'))
census = importlib.util.module_from_spec(spec)
spec.loader.exec_module(census)


class CensusTests(unittest.TestCase):
    def fixture(self, root):
        target = Path(root) / 'source.drp'
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.comment = b'container comment preserved'
            archive.writestr('project.xml', b'<?xml version="1.0"?><SM_Project DbId="00000000-0000-4000-8000-000000000001"><Name>Private secret label</Name></SM_Project>')
            archive.writestr('MediaPool/Master/MpFolder.xml', b'<ListMgt::LmVersionTable><FieldsBlob><Unknown Attr="private-path">00ff</Unknown></FieldsBlob></ListMgt::LmVersionTable>')
            archive.writestr('SeqContainer/one.xml', b'<Container><!--private comment--><Body><![CDATA[<unknown>private cdata</unknown>]]></Body></Container>')
            archive.writestr('unknown-future-member.bin', b'\x00\x01\xffprivate unknown binary')
            archive.writestr('empty-member', b'')
        return target

    def assert_partition(self, raw, ranges):
        cursor = 0
        for token in ranges:
            self.assertEqual(token['offset'], cursor)
            cursor = token['endOffsetExclusive']
            self.assertEqual(token['bytes'], cursor - token['offset'])
            self.assertEqual(token['sha256'], hashlib.sha256(raw[token['offset']:cursor]).hexdigest())
        self.assertEqual(cursor, len(raw))

    def test_every_archive_and_unknown_member_byte_is_covered_without_printing_values(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = str(Path(folder).resolve())
            source = self.fixture(folder)
            report = census.census(str(source))
            self.assertEqual(report['memberCount'], 5)
            self.assertTrue(report['allArchiveBytesAccountedFor'])
            self.assertFalse(report['losslessValidated'])
            self.assertEqual(report['unknownMembersOrFieldsExcluded'], 0)
            self.assert_partition(source.read_bytes(), report['zipEnvelopeRanges'])
            raw, entries, _ = census.load_members(str(source))
            for member, entry in zip(report['members'], entries):
                self.assertEqual(member['sha256'], hashlib.sha256(entry['bytes']).hexdigest())
                self.assert_partition(entry['bytes'], member['tokens'])
            encoded = json.dumps(report)
            for secret in ['Private secret label', 'private-path', 'private comment', 'private cdata', 'private unknown binary', 'unknown-future-member.bin']:
                self.assertNotIn(secret, encoded)

    def test_cpp_scoped_tags_nested_payload_attributes_comments_cdata_and_processing_instructions(self):
        raw = b'<?xml version="1.0"?><!DOCTYPE Root><Root DbId="00000000-0000-4000-8000-000000000001"><Cxx::Unknown Flag="a&gt;b"><!--x--><![CDATA[<x>]]><?test opaque?><Nested a=\'x\'/></Cxx::Unknown></Root>'
        report = census.lexical_census(raw)
        self.assertEqual(report['tokenization'], 'native-lexical-ranges')
        self.assert_partition(raw, report['tokens'])
        self.assertEqual(len(report['nodes']), 3)
        self.assertTrue(all(node['ownerNativeId'] == '00000000-0000-4000-8000-000000000001' for node in report['nodes']))
        self.assertIn('comment', [t['kind'] for t in report['tokens']])
        self.assertIn('cdata', [t['kind'] for t in report['tokens']])
        self.assertEqual(sum(len(node['attributes']) for node in report['nodes']), 3)
        for node in report['nodes']:
            self.assertEqual(node['sha256'], hashlib.sha256(raw[node['offset']:node['endOffsetExclusive']]).hexdigest())

    def test_unsupported_or_malformed_members_remain_whole_opaque_ranges(self):
        for raw in [b'<Root><Open></Root>', b'<!DOCTYPE x [<!ENTITY ex SYSTEM "file:///secret">]><x/>', b'<Broken', b'\x00\xffbinary']:
            report = census.lexical_census(raw)
            self.assertEqual(report['tokenization'], 'opaque-unparsed')
            self.assertEqual(report['nodes'], [])
            self.assertEqual(len(report['tokens']), 1)
            self.assert_partition(raw, report['tokens'])

    def test_private_adapter_round_trips_every_raw_member_in_original_order_and_refuses_alias_or_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = str(Path(folder).resolve())
            os.chmod(folder, 0o700)
            source = self.fixture(folder)
            dest = Path(folder) / 'entries.json'
            census.write_private_entries(str(source), str(dest))
            self.assertEqual(dest.stat().st_mode & 0o777, 0o600)
            value = json.loads(dest.read_bytes())
            _, entries, _ = census.load_members(str(source))
            self.assertEqual([(bytes.fromhex(e['nameBytesHex']), base64.b64decode(e['bytesBase64'])) for e in value['entries']], [(e['nameBytes'], e['bytes']) for e in entries])
            with self.assertRaises(FileExistsError):
                census.write_private_entries(str(source), str(dest))
            alias = Path(folder) / 'alias'
            alias.symlink_to(folder)
            with self.assertRaises(ValueError):
                census.write_private_entries(str(source), str(alias / 'new.json'))
            os.chmod(folder, 0o755)
            with self.assertRaises(ValueError):
                census.write_private_entries(str(source), str(Path(folder) / 'insecure.json'))


if __name__ == '__main__':
    unittest.main()
