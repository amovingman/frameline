import importlib.util
from pathlib import Path
import unittest
import zipfile


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reader = load('location_graph', 'resolve-native-location-graph.py')
fixtures = load('identity_fixtures', 'test_resolve_native_track_identity.py')


class LocationGraphTests(unittest.TestCase):
    setUp = fixtures.TrackIdentityTests.setUp

    def archive(self, transform=lambda value: value, rows=None):
        source = fixtures.TrackIdentityTests.archive(self, rows=rows)
        with zipfile.ZipFile(source) as archive:
            members = {name: archive.read(name) for name in archive.namelist()}
        for name, data in members.items():
            if not name.startswith('SeqContainer/'):
                continue
            tree = reader._native.native_tree(data)
            for vector, kind in [('VideoTrackVec', 0), ('AudioTrackVec', 1)]:
                for entry in tree.find(vector):
                    track = entry[0]
                    for tag, text in [('Type', str(kind)), ('SubType', str(kind)), ('Flags', '0'),
                                      ('FusionCompHolderItems', None), ('LayersVec', None)]:
                        child = reader._native.ET.SubElement(track, tag)
                        child.text = text
            transform(tree)
            members[name] = reader._native.ET.tostring(tree)
        with zipfile.ZipFile(source, 'w') as archive:
            for name, data in members.items():
                archive.writestr(name, data)
        return source

    def test_fresh_native_ids_and_empty_track_locations_are_extracted_without_a_ledger(self):
        source = self.archive()
        original = source.read_bytes()
        graph = reader.graph(source)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(graph['identitySource'], 'Sm2TiTrack.DbId')
        self.assertFalse(graph['identityEqualsOrdinal'])
        tracks = graph['timelines'][0]['tracks']
        self.assertEqual([row['currentVectorIndex'] for row in tracks], [1, 2, 3, 1, 2])
        self.assertEqual([row['nativeTrackId'] for row in tracks], fixtures.IDS)

    def test_unknown_layers_kinds_fields_and_type_codes_refuse(self):
        def first(tree):
            return tree.find('VideoTrackVec')[0][0]

        mutations = [
            lambda tree: reader._native.ET.SubElement(first(tree), 'UnknownTrackStructure'),
            lambda tree: reader._native.ET.SubElement(first(tree).find('LayersVec'), 'Layer'),
            lambda tree: reader._native.ET.SubElement(tree.find('GeometryTrackVec'), 'Element'),
            lambda tree: reader._native.ET.SubElement(tree.find('SubtitleTrackVec'), 'Element'),
            lambda tree: setattr(first(tree).find('Type'), 'text', '1'),
            lambda tree: setattr(first(tree).find('Flags'), 'text', '-1'),
            lambda tree: first(tree).find('SubType').set('unknown', '1'),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                with self.assertRaises((ValueError, KeyError)):
                    reader.graph(self.archive(mutation))

    def test_track_bound_refuses_an_unobserved_large_vector(self):
        rows = [{'id': f'20000000-0000-4000-8000-{index:012d}', 'kind': 'video',
                 'index': index, 'name': 'Same empty name', 'items': []} for index in range(1, 66)]
        with self.assertRaisesRegex(ValueError, 'unsupported-native-track-vector'):
            reader.graph(self.archive(rows=rows))


if __name__ == '__main__':
    unittest.main()
