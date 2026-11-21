import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).with_name('resolve-native-track-identity.py')
spec = importlib.util.spec_from_file_location('native_tracks', SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
P = '10000000-0000-4000-8000-000000000001'
T = '10000000-0000-4000-8000-000000000002'
S = '10000000-0000-4000-8000-000000000003'
C = '10000000-0000-4000-8000-000000000004'
I = '10000000-0000-4000-8000-000000000005'
IDS = ['20000000-0000-4000-8000-' + str(i).zfill(12) for i in range(1, 6)]
NONCE = 'a' * 32


def tracks(challenge=False):
    result = []
    for i, kind in enumerate(['video', 'video', 'video', 'audio', 'audio']):
        index = i + 1 if kind == 'video' else i - 2
        name = f'Frameline-TrackProof-{NONCE}-{kind}-{index}' if challenge else 'Repeated private track name'
        result.append({'id': IDS[i], 'kind': kind, 'index': index, 'name': name, 'items': [I] if i == 0 else []})
    return result


class TrackIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def archive(self, name='sample.drp', rows=None, project=P, extra=''):
        rows = rows or tracks()
        path = self.root / name
        vectors = []
        for kind, tag in [('video', 'VideoTrackVec'), ('audio', 'AudioTrackVec'), ('subtitle', 'SubtitleTrackVec')]:
            values = []
            for track in [row for row in rows if row['kind'] == kind]:
                item_tag = 'Sm2TiVideoClip' if kind == 'video' else 'Sm2TiAudioClip'
                items = ''.join(f'<Element><{item_tag} DbId="{item}"/></Element>' for item in track['items'])
                values.append(f'<Element><Sm2TiTrack DbId="{track["id"]}"><Sequence>{S}</Sequence><Items>{items}</Items><UserDefinedName>{track["name"]}</UserDefinedName><FieldsBlob>private-opaque-native-data</FieldsBlob></Sm2TiTrack></Element>')
            vectors.append(f'<{tag}>{"".join(values)}</{tag}>')
        with zipfile.ZipFile(path, 'w') as output:
            output.writestr('project.xml', f'<!DOCTYPE SM_Project><SM_Project DbId="{project}"><ListMgt::Opaque><Body>private-value</Body></ListMgt::Opaque></SM_Project>')
            output.writestr('MediaPool/Master/MpFolder.xml', f'<Folder><Sm2Timeline DbId="{T}"><Sequence><Sm2Sequence DbId="{S}"><Parent>{T}</Parent><ListMgt::VersionTable/></Sm2Sequence></Sequence></Sm2Timeline></Folder>')
            output.writestr('SeqContainer/private-user-name.xml', f'<Sm2SequenceContainer DbId="{C}">{"".join(vectors)}<GeometryTrackVec/>{extra}</Sm2SequenceContainer>')
        return path

    def snapshot(self, rows=None, project=P, name='snapshot.json'):
        rows = rows or tracks()
        value = {'schema_version': 3, 'resolve_version': '21.1.2.10', 'project_id': project, 'project_name': 'Disposable',
            'timelines': [{'id': T, 'name': 'Timeline', 'start_frame': 0,
                'tracks': [{'type': row['kind'], 'index': row['index'], 'name': row['name']} for row in rows],
                'items': [{'id': item, 'track_type': row['kind'], 'track_index': row['index'], 'type': row['kind'], 'name': 'Repeated clip',
                    'start_frame': 0, 'end_frame': 24, 'source_start_frame': 0, 'source_end_frame': 24, 'media_pool_id': None,
                    'linked_item_ids': [], 'effect_counts': {'fusion': 0, 'ofx': 0, 'audio': 0}}
                    for row in rows for item in row['items']]}]}
        target = self.root / name
        target.write_text(json.dumps(value))
        return target

    def test_exact_id_graph_binds_items_but_never_guesses_empty_track_identity(self):
        source = self.archive()
        original = source.read_bytes()
        native = probe.graph(source)
        report = probe.bind_api(native, self.snapshot())
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(native['projectId'], P)
        self.assertEqual(native['timelines'][0]['timelineId'], T)
        self.assertEqual(native['timelines'][0]['nativeSequenceId'], S)
        self.assertEqual(len(native['timelines'][0]['tracks']), 5)
        self.assertEqual(report['apiBindings'][0]['nativeTrackId'], IDS[0])
        self.assertEqual(report['apiBindings'][0]['status'], 'exact-item-parentage-witness')
        self.assertEqual(len(report['unboundEmptyApiTracks']), 4)
        self.assertFalse(report['stableTrackIdentityProven'])
        self.assertFalse(report['apiTrackBindingProven'])
        self.assertFalse(report['safeToApply'])
        encoded = json.dumps(report)
        for private in ['Repeated private track name', 'private-user-name', 'private-value', 'private-opaque-native-data', str(self.root)]:
            self.assertNotIn(private, encoded)

    def test_comparison_tracks_native_uuid_across_rename_and_index_shift_with_empty_tracks(self):
        before = self.archive('before.drp')
        rows = tracks()
        rows[1]['name'] = 'Changed'
        rows[0], rows[1] = rows[1], rows[0]
        rows.append({'id': '30000000-0000-4000-8000-000000000001', 'kind': 'video', 'index': 4, 'name': '', 'items': []})
        after = self.archive('after.drp', rows)
        report = probe.compare(before, after)
        self.assertEqual(len(report['retainedTracks']), 5)
        self.assertEqual(len(report['addedNativeTrackIds']), 1)
        retained = next(row for row in report['retainedTracks'] if row['nativeTrackId'] == IDS[1])
        self.assertTrue(retained['nameChanged'])
        self.assertEqual((retained['nativeOrdinalBefore'], retained['nativeOrdinalAfter']), (2, 1))
        self.assertFalse(report['stableTrackIdentityProven'])

    def test_challenge_binds_all_empty_tracks_without_promoting_names_to_durable_identity(self):
        rows = tracks(True)
        report = probe.bind_api(probe.graph(self.archive(rows=rows)), self.snapshot(rows), True)
        self.assertEqual(len(report['apiBindings']), 5)
        self.assertEqual(report['unboundEmptyApiTracks'], [])
        self.assertEqual(report['challengeNonce'], NONCE)
        self.assertTrue(all(row['status'] == 'controlled-name-challenge' for row in report['apiBindings']))
        self.assertFalse(report['apiTrackBindingProven'])
        with self.assertRaises(ValueError):
            probe.bind_api(probe.graph(self.archive('ordinary.drp')), self.snapshot(name='ordinary.json'), True)
        wrong = tracks(True)
        wrong[1]['name'] = wrong[1]['name'].replace(NONCE, 'b' * 32)
        with self.assertRaises(ValueError):
            probe.bind_api(probe.graph(self.archive('wrong.drp', wrong)), self.snapshot(wrong, name='wrong.json'), True)

    def test_duplicate_and_inconsistent_native_id_relations_fail_closed(self):
        rows = tracks(); rows[1]['id'] = rows[0]['id']
        with self.assertRaises(ValueError):
            probe.graph(self.archive(rows=rows))
        wrong = tracks(); wrong[1]['items'] = [I]
        with self.assertRaises(ValueError):
            probe.graph(self.archive('duplicate-item.drp', wrong))
        native = probe.graph(self.archive('valid.drp'))
        with self.assertRaises(ValueError):
            probe.bind_api(native, self.snapshot(project='40000000-0000-4000-8000-000000000001'))
        with self.assertRaises(ValueError):
            probe.bind_api(native, self.snapshot(rows=tracks()[:-1], name='missing-track.json'))

    def test_parser_rejects_entities_and_spoofed_native_tags_without_rewriting_input(self):
        for document in [b'<!DOCTYPE A SYSTEM "file:///private"><A/>', b'<!DOCTYPE A [<!ENTITY x "secret">]><A>&x;</A>',
                         b'<A><_FramelineNativeTag_fake/></A>']:
            with self.assertRaises((ValueError, probe.ET.ParseError)):
                probe.native_tree(document)
        tree = probe.native_tree(b'<Root><!-- <Fake::Tag/> --><![CDATA[<Fake::Tag/>]]><Real::Tag/></Root>')
        self.assertEqual(len(tree), 1)
        self.assertEqual(tree.text, '<Fake::Tag/>')

    def test_native_archive_and_snapshot_readers_reject_links_fifo_and_invalid_schema(self):
        source = self.archive()
        link = self.root / 'alias.drp'; link.symlink_to(source)
        with self.assertRaises(ValueError):
            probe.graph(link)
        snapshot = self.snapshot()
        slink = self.root / 'alias.json'; slink.symlink_to(snapshot)
        with self.assertRaises(ValueError):
            probe.read_snapshot(slink)
        if hasattr(os, 'mkfifo'):
            fifo = self.root / 'fifo.json'; os.mkfifo(fifo)
            with self.assertRaises(ValueError):
                probe.read_snapshot(fifo)
        value = json.loads(snapshot.read_text()); value['resolve_version'] = '22'; snapshot.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            probe.read_snapshot(snapshot)

    def test_cli_does_not_print_sensitive_paths_on_error(self):
        run = subprocess.run([sys.executable, str(SCRIPT), 'graph', '/private/nonexistent-sensitive.drp'], capture_output=True, text=True)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(run.stdout, '')
        self.assertEqual(run.stderr, 'native-track-identity-inspection-failed\n')


if __name__ == '__main__':
    unittest.main()
