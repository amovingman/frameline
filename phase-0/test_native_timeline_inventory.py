import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('inventory', ROOT / 'phase-0/resolve-native-timeline-inventory.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeTimelineInventory(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='native-enumeration-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.ids = [str(uuid.uuid4()) for _ in range(40)]

    def fixture(self, name='fixture', nested=False, cycle=False, unknown=False, dangling=False, duplicate=False, effect='001122', link='', composition=False):
        p, t1, s1, c1, t2, s2, c2, mp1, mp2, video, audio = self.ids[:11]
        def pool(tag, native_id, api_id):
            return f'<{tag} DbId="{native_id}"><UniqueMediaPoolItemId>{api_id}</UniqueMediaPoolItemId></{tag}>'
        def timeline(t, s, mp):
            return f'<Sm2Timeline DbId="{t}"><MpTimelineClip>{mp}</MpTimelineClip><Sequence><Sm2Sequence DbId="{s}"><Parent>{t}</Parent><VideoTrackVec/><AudioTrackVec/></Sm2Sequence></Sequence></Sm2Timeline>'
        def item(tag, ident, reference=None, payload='', sync=''):
            fields = f'<Name>/Users/private/display.mov</Name><Start>24</Start><Duration>12</Duration><EffectFiltersBA>{payload}</EffectFiltersBA><LinkedItemSync>{sync}</LinkedItemSync>'
            if reference:
                fields += f'<MediaRef>{reference}</MediaRef><MediaFilePath>/Users/private/media.mov</MediaFilePath>'
            if unknown:
                fields += '<UnknownField>unknown</UnknownField>'
            if composition and tag == 'Sm2TiVideoClip' and ident == self.ids[20]:
                fields += f'<CompositionTable><Sm2TiCompositionTable DbId="{self.ids[35]}"><FieldsBlob>001122</FieldsBlob><DbSavedTime>123</DbSavedTime><CompositionBA/><ActiveCompositionIdx>-1</ActiveCompositionIdx></Sm2TiCompositionTable></CompositionTable>'
            return f'<Element><{tag} DbId="{ident}">{fields}</{tag}></Element>'
        def track(kind, ident, sequence, items):
            code = 0 if kind == 'video' else 1
            return f'<Element><Sm2TiTrack DbId="{ident}"><FieldsBlob/><Type>{code}</Type><SubType>{code}</SubType><Flags>0</Flags><Sequence>{sequence}</Sequence><Items>{items}</Items><FusionCompHolderItems/><UserDefinedName>Duplicate</UserDefinedName><LayersVec/></Sm2TiTrack></Element>'
        def container(ident, video_tracks, audio_tracks):
            return f'<Sm2SequenceContainer DbId="{ident}"><FieldsBlob/><VideoTrackVec>{video_tracks}</VideoTrackVec><AudioTrackVec>{audio_tracks}</AudioTrackVec><SubtitleTrackVec/><GeometryTrackVec/><DbSavedTime>0</DbSavedTime></Sm2SequenceContainer>'
        reference = self.ids[39] if dangling else mp2 if nested else video
        first = item('Sm2TiVideoClip', self.ids[20], reference, effect, link)
        transition = item('Sm2TiTransition', self.ids[21], payload='aa')
        v1 = track('video', self.ids[12], s1, first + transition + (first if duplicate else ''))
        a1 = track('audio', self.ids[13], s1, item('Sm2TiAudioClip', self.ids[22], audio))
        child_reference = mp1 if cycle else video
        v2 = track('video', self.ids[14], s2, item('Sm2TiVideoClip', self.ids[23], child_reference))
        a2 = track('audio', self.ids[15], s2, '')
        document = '<Root>' + pool('Sm2MpTimelineClip', mp1, self.ids[30]) + pool('Sm2MpTimelineClip', mp2, self.ids[31]) + pool('Sm2MpVideoClip', video, self.ids[32]) + pool('Sm2MpAudioClip', audio, self.ids[33]) + timeline(t1, s1, mp1) + timeline(t2, s2, mp2) + '</Root>'
        filename = self.root / (name + '.drp')
        with zipfile.ZipFile(filename, 'w') as archive:
            archive.writestr('project.xml', f'<SM_Project DbId="{p}"/>')
            archive.writestr('MediaPool/Master/MpFolder.xml', document)
            archive.writestr('SeqContainer/one.xml', container(c1, v1, a1))
            archive.writestr('SeqContainer/two.xml', container(c2, v2, a2))
            archive.writestr('Gallery.xml', '<Opaque>uninspected</Opaque>')
        filename.chmod(0o600)
        return str(filename)

    def test_typed_two_timeline_inventory_keeps_uuid_parentage_transition_and_private_hashes(self):
        report = native.inventory(self.fixture())
        self.assertEqual(report['counts'], {'timelines': 2, 'tracks': 4, 'video': 2, 'audio': 1, 'transitions': 1, 'nestedTimelineReferences': 0})
        self.assertTrue(report['nativeTypedItemMembershipEnumerated'])
        self.assertTrue(report['supportedFlatStructuralProfile'])
        self.assertIsNone(report['nativeEffectCount'])
        self.assertIsNone(report['nativeLinkedEdgeCount'])
        self.assertNotIn('/Users/', json.dumps(report))
        self.assertNotIn('display.mov', json.dumps(report))
        transition = next(item for timeline in report['timelines'] for track in timeline['tracks'] for item in track['items'] if item['kind'] == 'transition')
        self.assertEqual((transition['startFrame'], transition['durationFrames'], transition['endFrame']), (24, 12, 36))
        self.assertIsNone(transition['mediaReference'])
        self.assertFalse(report['completeApiEnumerationProven'])
        self.assertFalse(report['safeToApply'])
        clip = next(item for timeline in report['timelines'] for track in timeline['tracks'] for item in track['items'] if item['itemId'] == self.ids[20])
        self.assertEqual(clip['mediaReference']['nativeId'], self.ids[9])
        self.assertEqual(clip['mediaReference']['uniqueMediaPoolItemId'], self.ids[32])
        self.assertNotEqual(clip['mediaReference']['nativeId'], clip['mediaReference']['uniqueMediaPoolItemId'])
        self.assertNotIn('apiMediaPoolId', json.dumps(report))

    def test_nonempty_and_empty_payloads_never_infer_effect_or_link_counts(self):
        for effect, link in [('', ''), ('001122', self.ids[29])]:
            report = native.inventory(self.fixture(name='payload-' + str(len(effect)), effect=effect, link=link))
            self.assertIsNone(report['nativeEffectCount'])
            self.assertIsNone(report['nativeLinkedEdgeCount'])
            item = next(item for t in report['timelines'] for track in t['tracks'] for item in track['items'] if item['itemId'] == self.ids[20])
            self.assertEqual(item['opaqueEffectPayload']['textEmpty'], not effect)
            self.assertFalse(item['opaqueEffectPayload']['contentsInterpreted'])
            self.assertIsNone(item['opaqueLinkSync']['countInferred'])

    def test_nested_edge_uses_explicit_media_uuid_and_marks_flat_profile_unsupported(self):
        report = native.inventory(self.fixture(nested=True))
        self.assertEqual(report['nestedTimelineEdges'], [{'fromTimelineId': self.ids[1], 'itemId': self.ids[20], 'toTimelineId': self.ids[4], 'mediaPoolNativeId': self.ids[8]}])
        self.assertFalse(report['supportedFlatStructuralProfile'])
        self.assertEqual(report['counts']['nestedTimelineReferences'], 1)

    def test_cycles_dangling_unknown_and_duplicate_items_refuse(self):
        for options in [{'nested': True, 'cycle': True}, {'dangling': True}, {'unknown': True}, {'duplicate': True}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                native.inventory(self.fixture(**options))

    def test_source_symlink_refuses_and_source_bytes_are_unchanged(self):
        original = Path(self.fixture())
        before = original.read_bytes()
        native.inventory(str(original))
        self.assertEqual(original.read_bytes(), before)
        alias = self.root / 'alias.drp'
        alias.symlink_to(original)
        with self.assertRaises(ValueError):
            native.inventory(str(alias))

    def test_composition_table_is_owned_auxiliary_structure_without_inventing_effect_or_tool_counts(self):
        report = native.inventory(self.fixture(composition=True))
        self.assertEqual(report['auxiliaryCompositionTableCount'], 1)
        table = report['auxiliaryCompositionTables'][0]
        self.assertEqual((table['timelineId'], table['itemId'], table['nativeCompositionTableId']), (self.ids[1], self.ids[20], self.ids[35]))
        self.assertEqual(table['activeCompositionIndex'], -1)
        self.assertFalse(table['internalGraphEnumerated'])
        self.assertIsNone(table['compositionCountInferred'])
        self.assertIsNone(report['nativeEffectCount'])
        self.assertTrue(report['supportedFlatStructuralProfile'])


if __name__ == '__main__':
    unittest.main()
