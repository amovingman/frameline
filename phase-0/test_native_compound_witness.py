import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid
import zipfile

spec = importlib.util.spec_from_file_location('compound_witness', Path(__file__).with_name('resolve-native-compound-witness.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeCompoundWitness(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='compound-witness-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.ids = [str(uuid.uuid4()) for _ in range(40)]

    def fixture(self, parent=False, unknown=False, dangling=False, recursive=False, duplicate=False, missing=False, type_mismatch=False):
        ids = self.ids
        def item(tag, ident, ref):
            return f'<Element><{tag} DbId="{ident}"><Name>/Users/private/source.mov</Name><Start>0</Start><Duration>24</Duration><MediaRef>{ref}</MediaRef><EffectFiltersBA>001122</EffectFiltersBA><LinkedItemSync/></{tag}></Element>'
        def track(kind, ident, sequence, content):
            code = 0 if kind == 'video' else 1
            if type_mismatch and ident == ids[15]:
                code = 0
            return f'<Element><Sm2TiTrack DbId="{ident}"><FieldsBlob/><Type>{code}</Type><SubType>1</SubType><Flags>0</Flags><Sequence>{sequence}</Sequence><Items>{content}</Items><FusionCompHolderItems/><UserDefinedName>Duplicate</UserDefinedName><LayersVec/></Sm2TiTrack></Element>'
        def container(ident, sequence, v_id, a_id, v_item, a_item):
            return f'<Sm2SequenceContainer DbId="{ident}"><FieldsBlob/><VideoTrackVec>{track("video",v_id,sequence,v_item)}</VideoTrackVec><AudioTrackVec>{track("audio",a_id,sequence,a_item)}</AudioTrackVec><SubtitleTrackVec/><GeometryTrackVec/><DbSavedTime>0</DbSavedTime></Sm2SequenceContainer>'
        fields = ''.join(f'<{f}/>' for f in sorted(native.COMPOUND_FIELDS - {'Name', 'UniqueMediaPoolItemId', 'Sequence'}))
        seq_fields = ''.join(f'<{f}/>' for f in sorted(native.SEQUENCE_FIELDS - {'Parent', 'UniqueSequenceId'}))
        compound = f'<Sm2MpCompoundClip DbId="{ids[4]}">{fields}<Name>/Users/private/compound</Name><UniqueMediaPoolItemId>{ids[5]}</UniqueMediaPoolItemId><Sequence><Sm2Sequence DbId="{ids[6]}">{seq_fields}<Parent>{ids[39] if parent else ids[4]}</Parent><UniqueSequenceId>{ids[7]}</UniqueSequenceId></Sm2Sequence></Sequence>{"<Unknown/>" if unknown else ""}</Sm2MpCompoundClip>'
        timeline = f'<Sm2Timeline DbId="{ids[1]}"><Sequence><Sm2Sequence DbId="{ids[2]}"><Parent>{ids[1]}</Parent><VideoTrackVec/><AudioTrackVec/></Sm2Sequence></Sequence></Sm2Timeline>'
        pool = f'<Root>{timeline}{compound}<Sm2MpVideoClip DbId="{ids[8]}"><UniqueMediaPoolItemId>{ids[9]}</UniqueMediaPoolItemId></Sm2MpVideoClip></Root>'
        movie = ids[39] if dangling else ids[4] if recursive else ids[8]
        outer_v = item('Sm2TiVideoClip', ids[10], ids[4])
        inner_v = item('Sm2TiVideoClip', ids[10] if duplicate else ids[12], movie)
        path = self.root / ('fixture-' + str(uuid.uuid4()) + '.drp')
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('project.xml', f'<SM_Project DbId="{ids[0]}"/>')
            z.writestr('MediaPool/Master/MpFolder.xml', pool)
            z.writestr('SeqContainer/outer.xml', container(ids[3], ids[2], ids[14], ids[15], outer_v, item('Sm2TiAudioClip', ids[11], ids[4])))
            if not missing:
                z.writestr('SeqContainer/inner.xml', container(ids[16], ids[6], ids[17], ids[18], inner_v, item('Sm2TiAudioClip', ids[13], ids[8])))
        path.chmod(0o600)
        return path

    def test_explicit_uuid_chain_and_opaque_scope_without_private_names(self):
        path = self.fixture()
        before = path.read_bytes()
        report = native.witness(str(path))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual((report['apiVisibleTimelineCount'], report['nativeSequenceOwnerCount'], report['nativeContainerCount']), (1, 2, 2))
        row = report['compounds'][0]
        self.assertEqual((row['nativeCompoundMediaId'], row['nativeSequenceId'], row['sequenceParentId'], row['nativeContainerId']), (self.ids[4], self.ids[6], self.ids[4], self.ids[16]))
        self.assertEqual({r['itemId'] for r in row['referringItems']}, {self.ids[10], self.ids[11]})
        self.assertTrue(all(r['mediaRef'] == self.ids[4] and r['timelineId'] == self.ids[1] for r in row['referringItems']))
        self.assertTrue(all(t['nativeSequenceId'] == self.ids[6] for t in row['internalTracks']))
        self.assertEqual({i['mediaRef'] for t in row['internalTracks'] for i in t['items']}, {self.ids[8]})
        self.assertNotIn('/Users/', json.dumps(report))
        self.assertFalse(report['completeNativeEnumerationProven'])
        self.assertFalse(report['ordinaryApplySupported'])

    def test_ambiguous_parentage_unknown_fields_dangling_recursion_and_duplicates_refuse(self):
        for options in [{'parent': True}, {'unknown': True}, {'dangling': True}, {'recursive': True}, {'duplicate': True}, {'missing': True}, {'type_mismatch': True}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                native.witness(str(self.fixture(**options)))

    def test_symlink_source_refuses(self):
        path = self.fixture()
        alias = self.root / 'alias.drp'
        alias.symlink_to(path)
        with self.assertRaises(ValueError):
            native.witness(str(alias))


if __name__ == '__main__':
    unittest.main()
