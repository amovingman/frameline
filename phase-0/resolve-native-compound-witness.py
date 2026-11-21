"""Read-only explicit native compound-reference witness, not a supported profile.

This separate reader inspects an unsupported boundary without weakening the
frozen flat-timeline reader. Effect/link payloads and compound internals beyond
ordinary typed track/item membership remain uninterpreted.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

_spec = importlib.util.spec_from_file_location('timeline_inventory', Path(__file__).with_name('resolve-native-timeline-inventory.py'))
_inv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_inv)
_native = _inv._native
COMPOUND_FIELDS = {'FieldsBlob', 'Name', 'MpFolder', 'UniqueMediaPoolItemId', 'MarkIn', 'MarkInVideo', 'MarkInAudio', 'MarkOut', 'MarkOutVideo', 'MarkOutAudio', 'CurPlayheadPosition', 'PinsBA', 'VirtualAudioTracksBA', 'MatteVec', 'AudioSource', 'PTZRPreset', 'PTZRPresetType', 'SlateTC', 'Sequence', 'VideoMetadata', 'MediaMetadata'}
SEQUENCE_FIELDS = {'FieldsBlob', 'UniqueSequenceId', 'MediaExtents', 'FrameRate', 'Resolution', 'VideoTrackVec', 'AudioTrackVec', 'Parent', 'LastChangedTime', 'RenderCacheBA', 'AuxRenderCacheBA', 'UIElementsState', 'NumOutputAudioChannels', 'OutputAudioGain', 'PinsBA', 'ImportExportMetadataBA', 'LockSysId', 'DbSavedTime'}
MAX_RECORDS = 5000


def sha(value):
    return hashlib.sha256(value).hexdigest()


def identifier(node, field=None):
    return _native.identifier(_inv.single_text(node, field) if field else node.attrib.get('DbId'))


def witness(filename):
    archive, members = _native._reader.read_export(filename)
    trees, sources, projects = [], [], []
    for name, data in sorted(members.items()):
        kind = _native._reader.kind(name)
        parsed = kind in {'project', 'media-pool', 'sequence'}
        sources.append({'memberNameSha256': sha(name.encode()), 'rawSha256': sha(data), 'bytes': len(data), 'kind': kind, 'parsed': parsed})
        if parsed:
            tree = _native.native_tree(data)
            trees.append((kind, tree))
            if kind == 'project':
                if tree.tag != 'SM_Project':
                    raise ValueError('unsupported-project')
                projects.append(identifier(tree))
    if len(projects) != 1:
        raise ValueError('ambiguous-project')
    owners, compounds, media_ids, visible = {}, {}, set(), {}
    for kind, tree in trees:
        if kind != 'media-pool':
            continue
        for node in tree.iter():
            if node.tag.startswith('Sm2Mp') and node.tag.endswith('Clip'):
                native_id = identifier(node)
                if native_id in media_ids:
                    raise ValueError('duplicate-media-id')
                media_ids.add(native_id)
            if node.tag not in {'Sm2Timeline', 'Sm2MpCompoundClip'}:
                continue
            native_id = identifier(node)
            sequence = _native.one(_native.one(node, 'Sequence'), 'Sm2Sequence')
            sequence_id = identifier(sequence)
            if sequence_id in owners:
                raise ValueError('duplicate-sequence-owner')
            if identifier(sequence, 'Parent') != native_id:
                raise ValueError('sequence-parent-differs')
            for vector in ['VideoTrackVec', 'AudioTrackVec']:
                if len(_native.one(sequence, vector)) or _inv.single_text(sequence, vector).strip():
                    raise ValueError('unsupported-embedded-tracks')
            owners[sequence_id] = {'kind': node.tag, 'id': native_id}
            if node.tag == 'Sm2Timeline':
                if native_id in visible:
                    raise ValueError('duplicate-timeline')
                visible[native_id] = sequence_id
            else:
                _inv.fields(node, COMPOUND_FIELDS, COMPOUND_FIELDS)
                _inv.fields(sequence, SEQUENCE_FIELDS, SEQUENCE_FIELDS)
                compounds[native_id] = {'nativeCompoundMediaId': native_id,
                    'uniqueMediaPoolItemId': identifier(node, 'UniqueMediaPoolItemId'),
                    'nameSha256': sha(_inv.single_text(node, 'Name').encode()),
                    'nativeSequenceId': sequence_id, 'uniqueSequenceId': identifier(sequence, 'UniqueSequenceId'),
                    'sequenceParentId': identifier(sequence, 'Parent'), 'nativeContainerId': None,
                    'referringItems': [], 'internalTracks': []}
    if not compounds or len(compounds) > 32 or len(owners) > 64:
        raise ValueError('missing-or-excess-compounds')
    seen_tracks, seen_items, containers, sequence_containers = set(), set(), set(), {}
    for kind, tree in trees:
        if kind != 'sequence':
            continue
        if tree.tag != 'Sm2SequenceContainer' or set(tree.attrib) != {'DbId'}:
            raise ValueError('unsupported-container')
        container_id = identifier(tree)
        if container_id in containers:
            raise ValueError('duplicate-container')
        containers.add(container_id)
        if len(containers) > 64:
            raise ValueError('excess-containers')
        tags = [n.tag for n in tree]
        if set(tags) != {'FieldsBlob', 'VideoTrackVec', 'AudioTrackVec', 'SubtitleTrackVec', 'GeometryTrackVec', 'DbSavedTime'} or len(tags) != 6:
            raise ValueError('unsupported-container-fields')
        for vector in ['SubtitleTrackVec', 'GeometryTrackVec']:
            if len(_native.one(tree, vector)) or _inv.single_text(tree, vector).strip():
                raise ValueError('unsupported-track-family')
        container_sequences = set()
        for vector, (track_type, type_code) in _inv.VECTORS.items():
            for index, entry in enumerate(_native.one(tree, vector), 1):
                if entry.tag != 'Element' or entry.attrib or len(entry) != 1 or entry[0].tag != 'Sm2TiTrack':
                    raise ValueError('unsupported-track-wrapper')
                track = entry[0]
                _inv.fields(track, _inv.TRACK, _inv.TRACK)
                track_id, sequence_id = identifier(track), identifier(track, 'Sequence')
                if track_id in seen_tracks or sequence_id not in owners or _inv.integer(track, 'Type') != type_code:
                    raise ValueError('invalid-track-parentage')
                seen_tracks.add(track_id)
                if len(seen_tracks) > 256:
                    raise ValueError('excess-tracks')
                container_sequences.add(sequence_id)
                for field in ['LayersVec', 'FusionCompHolderItems']:
                    if len(_native.one(track, field)) or _inv.single_text(track, field).strip():
                        raise ValueError('unsupported-layered-track')
                owner = owners[sequence_id]
                row = {'trackId': track_id, 'type': track_type, 'currentIndex': index, 'nativeSequenceId': sequence_id, 'items': []}
                for entry in _native.one(track, 'Items'):
                    if entry.tag != 'Element' or entry.attrib or len(entry) != 1 or entry[0].tag not in _inv.ITEMS:
                        raise ValueError('unsupported-item-wrapper')
                    item = entry[0]
                    allowed = _inv.COMMON | ({'AlignmentType', 'Position'} if item.tag == 'Sm2TiTransition' else _inv.CLIP | (_inv.VIDEO if item.tag == 'Sm2TiVideoClip' else _inv.AUDIO))
                    required = {'Name', 'Start', 'Duration', 'EffectFiltersBA', 'LinkedItemSync'} | (set() if item.tag == 'Sm2TiTransition' else {'MediaRef'})
                    _inv.fields(item, allowed, required)
                    item_id = identifier(item)
                    if item_id in seen_items or len(seen_items) >= MAX_RECORDS:
                        raise ValueError('duplicate-or-excess-item')
                    seen_items.add(item_id)
                    if item.tag == 'Sm2TiTransition':
                        if owner['kind'] == 'Sm2MpCompoundClip':
                            raise ValueError('unsupported-internal-transition')
                        continue
                    if _inv.ITEMS[item.tag] != track_type:
                        raise ValueError('item-track-kind-differs')
                    media_ref = identifier(item, 'MediaRef')
                    if media_ref not in media_ids:
                        raise ValueError('dangling-media-reference')
                    fact = {'itemId': item_id, 'nativeTag': item.tag, 'mediaRef': media_ref,
                            'startFrame': _inv.integer(item, 'Start'), 'durationFrames': _inv.integer(item, 'Duration', positive=True)}
                    row['items'].append(fact)
                    if media_ref in compounds:
                        if owner['kind'] != 'Sm2Timeline':
                            raise ValueError('unsupported-recursive-compound')
                        compounds[media_ref]['referringItems'].append({'timelineId': owner['id'], 'nativeSequenceId': sequence_id,
                            'nativeContainerId': container_id, 'trackId': track_id, 'trackType': track_type,
                            'currentIndex': index, 'itemId': item_id, 'mediaRef': media_ref, 'nativeTag': item.tag})
                if owner['kind'] == 'Sm2MpCompoundClip':
                    compounds[owner['id']]['internalTracks'].append(row)
        if len(container_sequences) != 1:
            raise ValueError('container-sequence-ambiguous')
        sequence_id = next(iter(container_sequences))
        if sequence_id in sequence_containers:
            raise ValueError('sequence-spans-containers')
        sequence_containers[sequence_id] = container_id
    if set(sequence_containers) != set(owners):
        raise ValueError('sequence-owner-membership-differs')
    for row in compounds.values():
        row['nativeContainerId'] = sequence_containers[row['nativeSequenceId']]
        if not row['referringItems'] or not row['internalTracks'] or not any(t['items'] for t in row['internalTracks']):
            raise ValueError('unbound-or-empty-compound')
        row['referringItems'].sort(key=lambda x: (x['timelineId'], x['trackType'], x['currentIndex'], x['itemId']))
        row['internalTracks'].sort(key=lambda x: (x['type'], x['currentIndex']))
    return {'schemaVersion': 1, 'operation': 'read-native-compound-reference-witness', 'readOnly': True,
        'profile': 'resolve-21.1.2.10-native-compound-boundary-diagnostic-v1', 'archive': archive, 'projectId': projects[0],
        'sourceMembers': sources, 'apiVisibleTimelineCount': len(visible), 'nativeSequenceOwnerCount': len(owners),
        'nativeContainerCount': len(containers), 'compounds': sorted(compounds.values(), key=lambda x: x['nativeCompoundMediaId']),
        'completeNativeEnumerationProven': False, 'internalProcessingGraphsEnumerated': False,
        'effectParametersObserved': False, 'persistentEffectIdentityProven': False,
        'fullNativePreservationProven': False, 'ordinaryApplySupported': False, 'safeToApply': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('usage')
        print(json.dumps(witness(sys.argv[1]), sort_keys=True, separators=(',', ':')))
    except Exception:
        print('native-compound-reference-witness-failed', file=sys.stderr)
        sys.exit(1)
