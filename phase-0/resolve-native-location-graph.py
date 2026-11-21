"""Read-only exact-build native track location graph; no prior UUID ledger."""
import importlib.util
import json
from pathlib import Path
import re
import sys

_spec = importlib.util.spec_from_file_location('native_identity', Path(__file__).with_name('resolve-native-track-identity.py'))
_native = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_native)
PROFILE = 'resolve-free-21.1.2.10-video-audio-v1'
TRACK_CHILDREN = {'FieldsBlob', 'Type', 'SubType', 'Flags', 'Sequence', 'Items',
                  'FusionCompHolderItems', 'UserDefinedName', 'LayersVec'}
VECTOR_KIND = {'VideoTrackVec': ('video', 0), 'AudioTrackVec': ('audio', 1)}


def integer(node):
    value = node.text or ''
    if len(node) or node.attrib or not re.fullmatch(r'0|[1-9][0-9]{0,9}', value):
        raise ValueError('unsupported-native-integer')
    result = int(value)
    if result > 2147483647:
        raise ValueError('unsupported-native-integer')
    return result


def graph(filename):
    # Preserve the old parser/source contract. Its graph proves explicit
    # project/timeline/sequence references and unique item/track UUIDs.
    result = _native.graph(filename)
    info, members = _native._reader.read_export(filename)
    if info != result['archive']:
        raise ValueError('native-source-changed')
    profile_rows = {}
    timeline_container = {}
    for name, data in members.items():
        if not name.startswith('SeqContainer/'):
            continue
        tree = _native.native_tree(data)
        container_id = _native.identifier(tree.attrib.get('DbId'))
        expected_root = {'FieldsBlob', 'VideoTrackVec', 'AudioTrackVec', 'SubtitleTrackVec', 'GeometryTrackVec', 'DbSavedTime'}
        if set(child.tag for child in tree) - expected_root:
            raise ValueError('unsupported-sequence-structure')
        for kind in ['SubtitleTrackVec', 'GeometryTrackVec']:
            if len(_native.one(tree, kind)):
                raise ValueError('unsupported-native-track-kind')
        for vector, (kind, type_code) in VECTOR_KIND.items():
            tracks = _native.one(tree, vector)
            if tracks.attrib or len(tracks) > 64:
                raise ValueError('unsupported-native-track-vector')
            for index, entry in enumerate(tracks, 1):
                if entry.attrib or len(entry) != 1:
                    raise ValueError('unsupported-native-track-entry')
                track = entry[0]
                track_id = _native.identifier(track.attrib.get('DbId'))
                if set(track.attrib) != {'DbId'} or {child.tag for child in track} != TRACK_CHILDREN or len(track) != len(TRACK_CHILDREN):
                    raise ValueError('unsupported-native-track-structure')
                if integer(_native.one(track, 'Type')) != type_code:
                    raise ValueError('native-vector-type-disagrees')
                sub_type = integer(_native.one(track, 'SubType'))
                flags = integer(_native.one(track, 'Flags'))
                if any(len(_native.one(track, tag)) or (_native.one(track, tag).text or '').strip()
                       for tag in ['FusionCompHolderItems', 'LayersVec']):
                    raise ValueError('unsupported-layered-native-track')
                sequence_id = _native.identifier(_native.one(track, 'Sequence').text)
                if sequence_id in timeline_container and timeline_container[sequence_id] != container_id:
                    raise ValueError('sequence-spans-native-containers')
                timeline_container[sequence_id] = container_id
                profile_rows[track_id] = {'nativeType': type_code, 'nativeSubType': sub_type, 'nativeFlags': flags,
                                          'nativeVector': vector, 'currentVectorIndex': index}
    for timeline in result['timelines']:
        if not timeline['tracks'] or timeline['nativeSequenceId'] not in timeline_container:
            raise ValueError('unsupported-empty-native-timeline')
        timeline['nativeContainerId'] = timeline_container[timeline['nativeSequenceId']]
        for track in timeline['tracks']:
            fields = profile_rows.pop(track['nativeTrackId'])
            if fields['currentVectorIndex'] != track['nativeOrdinal']:
                raise ValueError('native-location-disagrees')
            track.update(fields)
    if profile_rows:
        raise ValueError('unassigned-native-track')
    return {**result, 'nativeStructuralProfile': PROFILE,
            'identitySource': 'Sm2TiTrack.DbId', 'identityEqualsOrdinal': False,
            'locationRule': 'explicit-per-kind-vector-current-index',
            'limitations': ['Native vector locations are an empirically tested exact-build location rule, not persistent identities.',
                            'This reader supports simple video/audio tracks only; layered, geometry and subtitle tracks refuse.',
                            'Native serialization is undocumented and no native preservation guarantee is inferred.']}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('usage')
        print(json.dumps(graph(sys.argv[1]), indent=2))
    except Exception:
        print('native-location-inspection-failed', file=sys.stderr)
        sys.exit(1)
