import importlib.util
import io
from pathlib import Path
import struct
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


writer = load('preserving_writer', 'native-preserving-name-writer.py')
fixtures = load('preserving_fixture', 'test_native_timeline_inventory.py')


class Unseekable(io.BytesIO):
    def seekable(self):
        return False

    def seek(self, *args):
        raise io.UnsupportedOperation('seek')


class PreservingNameWriter(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.NativeTimelineInventory()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)

    def test_full_identity_bound_edit_preserves_unknown_binary_and_nested_opaque_bytes(self):
        source = Path(self.fixture.fixture(composition=True))
        with zipfile.ZipFile(source, 'a') as archive:
            archive.writestr('Unknown/future.bin', bytes(range(256)))
        raw = source.read_bytes()
        destination = self.fixture.root / 'edited.drp'
        ids = self.fixture.ids
        result = writer.write_name(str(source), str(destination), writer.sha(raw), ids[0], ids[1], ids[20], '/Users/private/display.mov', 'Edited <name> & opaque')
        self.assertTrue(result['writerBytePreservationProven'])
        self.assertFalse(result['editorRoundTripPreservationProven'])
        self.assertFalse(result['losslessValidated'])
        self.assertEqual(source.read_bytes(), raw)
        before, _ = writer.zip_layout(raw)
        after, _ = writer.zip_layout(destination.read_bytes())
        changed = [(a, b) for a, b in zip(before, after) if a['bytes'] != b['bytes']]
        self.assertEqual(len(changed), 1)
        a, b = changed[0]
        at = result['edit']['offset']
        expected = a['bytes'][:at] + b'Edited &lt;name&gt; &amp; opaque' + a['bytes'][at + result['edit']['oldBytes']:]
        self.assertEqual(b['bytes'], expected)
        self.assertEqual(next(x['bytes'] for x in after if x['name'].endswith('.bin')), bytes(range(256)))
        for a, b in zip(before, after):
            if a['bytes'] == b['bytes']:
                self.assertEqual(a['local'], b['local'])

    def test_data_descriptor_and_metadata_are_preserved_without_reserializing_untouched_records(self):
        stream = Unseekable()
        with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.comment = b'opaque archive comment'
            first = zipfile.ZipInfo('one.xml', (2020, 3, 4, 5, 6, 8))
            first.compress_type = zipfile.ZIP_DEFLATED
            first.comment = b'opaque member comment'
            first.external_attr = 0o100600 << 16
            archive.writestr(first, b'<Root><Name>old</Name><Opaque>00ff</Opaque></Root>')
            archive.writestr('future.bin', b'\x00\xff\x04opaque')
        raw = stream.getvalue()
        before, end = writer.zip_layout(raw)
        self.assertTrue(all(e['flags'] & 8 for e in before))
        offset = before[0]['bytes'].index(b'old')
        edited, _, after = writer.rewrite(raw, 'one.xml', offset, b'old', b'longer new name')
        self.assertNotEqual(edited, raw)
        self.assertEqual(before[1]['local'], after[1]['local'])
        self.assertEqual(before[0]['header'], after[0]['header'])
        with zipfile.ZipFile(io.BytesIO(edited)) as archive:
            self.assertEqual(archive.comment, b'opaque archive comment')
            self.assertEqual(archive.infolist()[0].comment, b'opaque member comment')
            self.assertEqual(archive.infolist()[0].date_time, (2020, 3, 4, 5, 6, 8))
            self.assertEqual(archive.read('future.bin'), b'\x00\xff\x04opaque')

    def test_wrong_identity_stale_hash_and_existing_destination_refuse_without_source_changes(self):
        source = self.fixture.fixture()
        raw = Path(source).read_bytes()
        ids, dest = self.fixture.ids, self.fixture.root / 'destination.drp'
        args = [source, str(dest), writer.sha(raw), ids[0], ids[1], ids[20], '/Users/private/display.mov', 'new name']
        for index, value in [(2, '0' * 64), (3, ids[39]), (4, ids[4]), (5, ids[23]), (6, 'stale name')]:
            changed = list(args)
            changed[index] = value
            with self.assertRaises(ValueError):
                writer.write_name(*changed)
            self.assertFalse(dest.exists())
        dest.write_bytes(b'unrelated destination')
        with self.assertRaises(FileExistsError):
            writer.write_name(*args)
        self.assertEqual(dest.read_bytes(), b'unrelated destination')
        self.assertEqual(Path(source).read_bytes(), raw)

    def test_ambiguous_or_nested_name_span_refuses(self):
        ident = self.fixture.ids[20]
        def element(body):
            return f'<Sm2TiVideoClip DbId="{ident}">{body}</Sm2TiVideoClip>'.encode()
        for xml in [b'<Root>' + element('<Name>old</Name>') * 2 + b'</Root>', element('<Name>old</Name><Name>old</Name>'), element('<Name><![CDATA[old]]></Name>'), element('<Name><Nested>old</Nested></Name>')]:
            with self.assertRaises(ValueError):
                writer.name_span(xml, 'Sm2TiVideoClip', ident, 'old')
        xml = element('<Other><Name>not target</Name></Other><Name>old</Name>')
        a, b = writer.name_span(xml, 'Sm2TiVideoClip', ident, 'old')
        self.assertEqual(xml[a:b], b'old')

    def test_unknown_zip_extensions_traversal_gaps_and_corrupt_crc_refuse(self):
        for name, extra in [('one.xml', b'\x01\x00\x00\x00'), ('../unsafe', b'')]:
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as archive:
                info = zipfile.ZipInfo(name)
                info.extra = extra
                archive.writestr(info, b'raw')
            with self.assertRaises(ValueError):
                writer.zip_layout(stream.getvalue())
        raw = Path(self.fixture.fixture()).read_bytes()
        with self.assertRaises(ValueError):
            writer.zip_layout(b'prefix' + raw)
        damaged = bytearray(raw)
        first = struct.unpack_from(zipfile.structFileHeader, damaged, 0)
        damaged[30 + first[10] + first[11]] ^= 1
        with self.assertRaises((ValueError, zipfile.BadZipFile)):
            writer.zip_layout(bytes(damaged))

    def test_identity_text_inside_other_attributes_never_selects_a_target(self):
        ident = self.fixture.ids[20]
        for attributes in [f'''comment='DbId="{ident}"' ''', f'''other:DbId="{ident}"''', f'''DbId="{ident}" unrelated="attribute"''']:
            xml = f'<Sm2TiVideoClip {attributes}><Name>old</Name></Sm2TiVideoClip>'.encode()
            with self.assertRaises(ValueError):
                writer.name_span(xml, 'Sm2TiVideoClip', ident, 'old')
        xml = f"<Sm2TiVideoClip DbId='{ident}'><Name>old</Name></Sm2TiVideoClip>".encode()
        a, b = writer.name_span(xml, 'Sm2TiVideoClip', ident, 'old')
        self.assertEqual(xml[a:b], b'old')


if __name__ == '__main__':
    unittest.main()
