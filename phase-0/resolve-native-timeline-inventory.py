"""Bounded saved-native timeline structure inventory, never a native writer.

Effect and link byte arrays remain opaque. Only explicit typed membership and
media/timeline references are resolved; names and payload contents never join.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

_spec = importlib.util.spec_from_file_location('native_identity', Path(__file__).with_name('resolve-native-track-identity.py'))
_native = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_native)
PROFILE = 'resolve-21.1.2.10-saved-native-av-transition-structure-v1'
VECTORS = {'VideoTrackVec': ('video', 0), 'AudioTrackVec': ('audio', 1)}
POOL = {'Sm2MpVideoClip': 'video', 'Sm2MpAudioClip': 'audio', 'Sm2MpTimelineClip': 'timeline'}
ITEMS = {'Sm2TiVideoClip': 'video', 'Sm2TiAudioClip': 'audio', 'Sm2TiTransition': 'transition'}
COMMON = {'FieldsBlob', 'PrettyType', 'Name', 'Start', 'Duration', 'LinkedItemSync', 'WasDisbanded',
          'MarkersBA', 'UiMemento', 'Flags', 'PriorityIndex', 'EffectFiltersBA', 'ImportExportMetadataBA',
          'RenderTextEnabled', 'RenderTextGanged', 'RenderTextPrefixed'}
CLIP = {'In', 'MixedFrameRateAlignment', 'MediaRef', 'MediaStartTime', 'MediaFilePath', 'MediaReelNumber',
        'MediaFrameRate', 'MediaTimemapBA', 'LastChangedTime', 'LastRenderedTime', 'IsMarkedForCaching',
        'IsForceConformed', 'MatchConflictState', 'UseOppositeSrcForLeftEye', 'UseOppositeSrcForRightEye', 'RenderCacheBA'}
VIDEO = {'CurrentSelectorIdx', 'IsPreConformed', 'PreConformMediaExtents', 'MediaMetadata', 'Thumbnail', 'ThumbnailDirtyFlag', 'CompositionTable'}
AUDIO = {'VirtualAudioTrackBA', 'MediaTrackIdx'}
TRACK = {'FieldsBlob', 'Type', 'SubType', 'Flags', 'Sequence', 'Items', 'FusionCompHolderItems', 'UserDefinedName', 'LayersVec'}
MAX_ITEMS, MAX_TIMELINES, MAX_TRACKS = 5000, 32, 256
MAX_SAFE = 9007199254740991


def sha(value):
    return hashlib.sha256(value).hexdigest()


def single_text(node, tag):
    field = _native.one(node, tag)
    if len(field) or field.attrib:
        raise ValueError('unsupported-native-scalar')
    return field.text or ''


def integer(node, tag, positive=False):
    text = single_text(node, tag)
    if not re.fullmatch(r'-?(?:0|[1-9][0-9]{0,15})', text):
        raise ValueError('unsupported-native-frame-number')
    value = int(text)
    if abs(value) > MAX_SAFE or positive and value <= 0:
        raise ValueError('unsupported-native-frame-range')
    return value


def fields(node, allowed, required):
    tags = [child.tag for child in node]
    if set(node.attrib) != {'DbId'} or len(tags) != len(set(tags)) or set(tags) - allowed or not required <= set(tags):
        raise ValueError('unsupported-or-ambiguous-native-fields')


def opaque(node, tag):
    text = single_text(node, tag)
    return {'textSha256': sha(text.encode()), 'textBytes': len(text.encode()), 'textEmpty': not text,
            'textLooksLikeUuid': bool(_native.UUID.fullmatch(text)), 'contentsInterpreted': False,
            'countInferred': None}


def inventory(filename):
    graph = _native.graph(filename)
    archive, members = _native._reader.read_export(filename)
    if archive != graph['archive'] or len(graph['timelines']) > MAX_TIMELINES:
        raise ValueError('changed-or-excess-native-source')
    pool, timeline_meta, source_members, trees = {}, {}, [], []
    for name, data in sorted(members.items()):
        kind = _native._reader.kind(name)
        parsed = kind in {'project', 'media-pool', 'sequence'}
        source_members.append({'memberNameSha256': sha(name.encode()), 'rawSha256': sha(data),
                               'bytes': len(data), 'kind': kind, 'parsed': parsed})
        if not parsed:
            continue
        tree = _native.native_tree(data)
        trees.append((kind, tree))
        if kind != 'media-pool':
            continue
        for node in tree.iter():
            if node.tag.startswith('Sm2Mp') and node.tag.endswith('Clip') and node.tag not in POOL:
                raise ValueError('unsupported-native-media-kind')
            if node.tag in POOL:
                native_id = _native.identifier(node.attrib.get('DbId'))
                pool_unique_id = _native.identifier(single_text(node, 'UniqueMediaPoolItemId'))
                if native_id in pool:
                    raise ValueError('duplicate-native-media-object')
                pool[native_id] = {'nativeId': native_id, 'uniqueMediaPoolItemId': pool_unique_id, 'kind': POOL[node.tag], 'targetTimelineId': None}
            elif node.tag == 'Sm2Timeline':
                timeline_id = _native.identifier(node.attrib.get('DbId'))
                pool_id = _native.identifier(single_text(node, 'MpTimelineClip'))
                if timeline_id in timeline_meta:
                    raise ValueError('duplicate-native-timeline')
                sequence = _native.one(_native.one(node, 'Sequence'), 'Sm2Sequence')
                for tag in ['VideoTrackVec', 'AudioTrackVec']:
                    if len(_native.one(sequence, tag)):
                        raise ValueError('unsupported-embedded-sequence-tracks')
                timeline_meta[timeline_id] = pool_id
    native_timelines = {row['timelineId']: row for row in graph['timelines']}
    if set(timeline_meta) != set(native_timelines):
        raise ValueError('native-timeline-membership-differs')
    for timeline_id, pool_id in timeline_meta.items():
        target = pool.get(pool_id)
        if not target or target['kind'] != 'timeline' or target['targetTimelineId'] is not None:
            raise ValueError('ambiguous-native-timeline-media-reference')
        target['targetTimelineId'] = timeline_id
    if any(row['kind'] == 'timeline' and row['targetTimelineId'] is None for row in pool.values()):
        raise ValueError('orphan-native-timeline-media-object')
    sequence_to_timeline = {row['nativeSequenceId']: row['timelineId'] for row in graph['timelines']}
    timelines = {key: {'timelineId': key, 'nativeSequenceId': row['nativeSequenceId'], 'nativeContainerId': None,
                      'mediaPoolNativeId': timeline_meta[key], 'uniqueMediaPoolItemId': pool[timeline_meta[key]]['uniqueMediaPoolItemId'], 'tracks': []}
                 for key, row in native_timelines.items()}
    nested, counts, seen_items, seen_tracks = [], {'timelines': len(timelines), 'tracks': 0, 'video': 0, 'audio': 0, 'transitions': 0, 'nestedTimelineReferences': 0}, set(), set()
    composition_tables, composition_ids = [], set()
    for kind, tree in trees:
        if kind != 'sequence':
            continue
        if tree.tag != 'Sm2SequenceContainer' or set(tree.attrib) != {'DbId'}:
            raise ValueError('unsupported-native-container')
        container_id = _native.identifier(tree.attrib['DbId'])
        root_tags = [node.tag for node in tree]
        expected = {'FieldsBlob', 'VideoTrackVec', 'AudioTrackVec', 'SubtitleTrackVec', 'GeometryTrackVec', 'DbSavedTime'}
        if set(root_tags) != expected or len(root_tags) != len(expected):
            raise ValueError('unsupported-native-container-fields')
        for tag in ['SubtitleTrackVec', 'GeometryTrackVec']:
            if len(_native.one(tree, tag)):
                raise ValueError('unsupported-native-track-family')
        counted_structural = set()
        for vector, (track_type, type_code) in VECTORS.items():
            for index, entry in enumerate(_native.one(tree, vector), 1):
                track = entry[0]  # The immutable graph parser already checks wrappers.
                fields(track, TRACK, TRACK)
                if integer(track, 'Type') != type_code:
                    raise ValueError('native-track-vector-type-differs')
                for tag in ['LayersVec', 'FusionCompHolderItems']:
                    if len(_native.one(track, tag)) or single_text(track, tag).strip():
                        raise ValueError('unsupported-layered-native-track')
                sequence_id = _native.identifier(single_text(track, 'Sequence'))
                timeline_id = sequence_to_timeline[sequence_id]
                timeline = timelines[timeline_id]
                if timeline['nativeContainerId'] not in (None, container_id):
                    raise ValueError('timeline-spans-native-containers')
                timeline['nativeContainerId'] = container_id
                track_id = _native.identifier(track.attrib['DbId'])
                seen_tracks.add(track_id); counted_structural.add(id(track)); counts['tracks'] += 1
                if counts['tracks'] > MAX_TRACKS:
                    raise ValueError('native-track-limit')
                row = {'nativeTrackId': track_id, 'type': track_type, 'currentIndex': index,
                       'nativeType': type_code, 'nativeSubType': integer(track, 'SubType'), 'nativeFlags': integer(track, 'Flags'),
                       'nameSha256': sha(single_text(track, 'UserDefinedName').encode()), 'items': []}
                for item_entry in _native.one(track, 'Items'):
                    item = item_entry[0]
                    if item.tag not in ITEMS:
                        raise ValueError('unsupported-native-timeline-item')
                    allowed = COMMON | ({'AlignmentType', 'Position'} if item.tag == 'Sm2TiTransition' else CLIP | (VIDEO if item.tag == 'Sm2TiVideoClip' else AUDIO))
                    required = {'Name', 'Start', 'Duration', 'EffectFiltersBA', 'LinkedItemSync'} | (set() if item.tag == 'Sm2TiTransition' else {'MediaRef'})
                    fields(item, allowed, required)
                    item_id = _native.identifier(item.attrib['DbId'])
                    key = (timeline_id, item_id)
                    if key in seen_items or len(seen_items) >= MAX_ITEMS:
                        raise ValueError('duplicate-or-excess-native-items')
                    seen_items.add(key); counted_structural.add(id(item))
                    composition = item.find('CompositionTable')
                    if composition is not None:
                        if composition.attrib or len(composition) != 1 or composition[0].tag != 'Sm2TiCompositionTable':
                            raise ValueError('unsupported-native-composition-holder')
                        table = composition[0]
                        table_fields = {'FieldsBlob', 'DbSavedTime', 'CompositionBA', 'ActiveCompositionIdx'}
                        fields(table, table_fields, table_fields)
                        table_id = _native.identifier(table.attrib['DbId'])
                        if (timeline_id, table_id) in composition_ids:
                            raise ValueError('ambiguous-native-composition-table')
                        composition_ids.add((timeline_id, table_id)); counted_structural.add(id(table))
                        composition_tables.append({'timelineId': timeline_id, 'itemId': item_id,
                                                   'nativeCompositionTableId': table_id,
                                                   'fieldsBlob': opaque(table, 'FieldsBlob'),
                                                   'compositionPayload': opaque(table, 'CompositionBA'),
                                                   'activeCompositionIndex': integer(table, 'ActiveCompositionIdx'),
                                                   'nativeDbSavedTime': integer(table, 'DbSavedTime'),
                                                   'compositionCountInferred': None, 'internalGraphEnumerated': False})
                    start, duration = integer(item, 'Start'), integer(item, 'Duration', positive=True)
                    if abs(start + duration) > MAX_SAFE:
                        raise ValueError('native-item-end-overflow')
                    reference = None
                    if item.tag != 'Sm2TiTransition':
                        media_id = _native.identifier(single_text(item, 'MediaRef'))
                        if media_id not in pool:
                            raise ValueError('dangling-native-media-reference')
                        reference = dict(pool[media_id])
                        if reference['kind'] == 'timeline':
                            nested.append({'fromTimelineId': timeline_id, 'itemId': item_id,
                                           'toTimelineId': reference['targetTimelineId'], 'mediaPoolNativeId': media_id})
                    item_kind = ITEMS[item.tag]
                    counts['transitions' if item_kind == 'transition' else item_kind] += 1
                    row['items'].append({'itemId': item_id, 'nativeTag': item.tag, 'kind': item_kind,
                                         'startFrame': start, 'durationFrames': duration, 'endFrame': start + duration,
                                         'nameSha256': sha(single_text(item, 'Name').encode()), 'mediaReference': reference,
                                         'opaqueEffectPayload': opaque(item, 'EffectFiltersBA'),
                                         'opaqueLinkSync': opaque(item, 'LinkedItemSync')})
                timeline['tracks'].append(row)
        for node in tree.iter():
            if node.tag.startswith('Sm2Ti') and id(node) not in counted_structural:
                raise ValueError('unassigned-or-unknown-native-timeline-object')
    for timeline_id, timeline in timelines.items():
        if timeline['nativeContainerId'] is None:
            raise ValueError('native-timeline-container-unresolved')
        expected = {(track['kind'], track['nativeOrdinal'], track['nativeTrackId'], tuple(track['itemIds'])) for track in native_timelines[timeline_id]['tracks']}
        actual = {(track['type'], track['currentIndex'], track['nativeTrackId'], tuple(sorted(item['itemId'] for item in track['items']))) for track in timeline['tracks']}
        if expected != actual:
            raise ValueError('native-structure-reconstruction-differs')
    adjacency = {key: [] for key in timelines}
    for edge in nested:
        adjacency[edge['fromTimelineId']].append(edge['toTimelineId'])
    visited, active = set(), set()
    def visit(timeline_id):
        if timeline_id in active:
            raise ValueError('cyclic-native-timeline-reference')
        if timeline_id in visited:
            return
        active.add(timeline_id)
        for child in adjacency[timeline_id]:
            visit(child)
        active.remove(timeline_id); visited.add(timeline_id)
    for timeline_id in timelines:
        visit(timeline_id)
    counts['nestedTimelineReferences'] = len(nested)
    return {'schemaVersion': 1, 'operation': 'saved-native-timeline-structure-inventory', 'readOnly': True,
            'profile': PROFILE, 'projectId': graph['projectId'], 'archive': archive, 'sourceMembers': source_members,
            'timelines': sorted(timelines.values(), key=lambda row: row['timelineId']),
            'nestedTimelineEdges': sorted(nested, key=lambda row: (row['fromTimelineId'], row['itemId'])),
            'auxiliaryCompositionTables': sorted(composition_tables, key=lambda row: (row['timelineId'], row['itemId'])),
            'auxiliaryCompositionTableCount': len(composition_tables),
            'counts': counts, 'nativeTypedItemMembershipEnumerated': True, 'nativeEffectCount': None, 'nativeLinkedEdgeCount': None,
            'supportedFlatStructuralProfile': not nested, 'parametersEnumerated': False, 'persistentEffectInstanceIdentityProven': False,
            'mediaReferenceRule': 'MediaRef resolves native media-pool DbId; UniqueMediaPoolItemId is retained separately and never used as API identity.',
            'completeApiEnumerationProven': False, 'losslessValidated': False, 'safeToApply': False, 'ordinaryApplySupported': False,
            'limitations': ['This inventories explicit saved-native structure only; unsaved exports may contain stale database state.',
                            'Nonempty or empty effect/link byte arrays do not establish effect counts, linked-item targets or their absence.',
                            'Nested references are explicit diagnostic edges; they do not promote nested content into the flat supported profile.',
                            'Composition-table objects retain explicit item ownership and opaque payload hashes; no composition, tool or effect count is inferred.',
                            'Transition membership and timing do not establish transition parameters or neighboring-clip semantics.',
                            'Unknown typed structures and dangling references refuse. Raw source members remain hash-bound; opaque contents are not interpreted.']}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('usage')
        print(json.dumps(inventory(sys.argv[1]), indent=2))
    except Exception:
        print('native-timeline-inventory-failed', file=sys.stderr)
        sys.exit(1)
