"""Read-only native Resolve ID graph. No project/archive bytes are written."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import sys
import xml.etree.ElementTree as ET

_spec = importlib.util.spec_from_file_location('native_export_reader', Path(__file__).with_name('compare-native-resolve-exports.py'))
_reader = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_reader)
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TOKEN = re.compile(r'<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|(</?)([A-Za-z_][A-Za-z0-9_.:-]*)(?=[\s/>])')
VECTORS = {'VideoTrackVec': 'video', 'AudioTrackVec': 'audio', 'SubtitleTrackVec': 'subtitle'}
ITEMS = {'Sm2TiVideoClip', 'Sm2TiAudioClip', 'Sm2TiTransition', 'Sm2TiSubtitleClip'}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def identifier(value):
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError('invalid-native-id')
    return value


def native_tree(data):
    """Map C++ scoped element names only in a parser copy, never in the input.

    Resolve emits names such as ListMgt::LmVersionTable, which XML parsers reject.
    Comments, CDATA and processing instructions are copied verbatim. DTD subsets
    and external entities are rejected. No field, blob or semantic delta is
    discarded by this spelling-only parser adaptation.
    """
    text = data.decode('utf-8')
    if '_FramelineNativeTag_' in text or re.search(r'<!ENTITY', text, re.I):
        raise ValueError('unsafe-native-xml')
    names = {}

    def substitute(match):
        token = match[0]
        if token.startswith('<!DOCTYPE'):
            if not re.fullmatch(r'<!DOCTYPE\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*>', token):
                raise ValueError('unsafe-native-doctype')
            return ''
        if match[1] is None:
            return token
        name = match[2]
        if ':' not in name:
            return token
        mapped = '_FramelineNativeTag_' + sha(name.encode())
        if mapped in names and names[mapped] != name:
            raise ValueError('native-name-collision')
        names[mapped] = name
        return match[1] + mapped

    parsed = ET.fromstring(TOKEN.sub(substitute, text))
    stack, count = [(parsed, 0)], 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if depth > 256 or count > 200000:
            raise ValueError('native-tree-limit')
        stack.extend((child, depth + 1) for child in node)
    return parsed


def one(parent, tag):
    values = parent.findall(tag)
    if len(values) != 1:
        raise ValueError('ambiguous-native-field')
    return values[0]


def graph(archive_path):
    info, members = _reader.read_export(archive_path)
    project = native_tree(members['project.xml'])
    if project.tag != 'SM_Project':
        raise ValueError('unsupported-native-project')
    project_id = identifier(project.attrib.get('DbId'))
    timelines, by_sequence = {}, {}
    for name, data in members.items():
        if not name.startswith('MediaPool/'):
            continue
        tree = native_tree(data)
        for timeline in tree.iter('Sm2Timeline'):
            timeline_id = identifier(timeline.attrib.get('DbId'))
            sequence = one(one(timeline, 'Sequence'), 'Sm2Sequence')
            sequence_id = identifier(sequence.attrib.get('DbId'))
            if one(sequence, 'Parent').text != timeline_id or timeline_id in timelines or sequence_id in by_sequence:
                raise ValueError('ambiguous-native-timeline')
            record = {'timelineId': timeline_id, 'nativeSequenceId': sequence_id, 'tracks': []}
            timelines[timeline_id] = record
            by_sequence[sequence_id] = record
    seen_tracks, seen_items, containers = set(), set(), set()
    for name, data in members.items():
        if not name.startswith('SeqContainer/'):
            continue
        tree = native_tree(data)
        if tree.tag != 'Sm2SequenceContainer':
            raise ValueError('unsupported-native-sequence')
        container_id = identifier(tree.attrib.get('DbId'))
        if container_id in containers:
            raise ValueError('duplicate-native-container')
        containers.add(container_id)
        geometry = tree.find('GeometryTrackVec')
        if geometry is not None and len(geometry):
            raise ValueError('unsupported-native-geometry')
        for vector, kind in VECTORS.items():
            for ordinal, entry in enumerate(one(tree, vector), 1):
                if entry.tag != 'Element' or len(entry) != 1 or entry[0].tag != 'Sm2TiTrack':
                    raise ValueError('unsupported-native-track')
                track = entry[0]
                track_id = identifier(track.attrib.get('DbId'))
                sequence_id = identifier(one(track, 'Sequence').text)
                if track_id in seen_tracks or sequence_id not in by_sequence:
                    raise ValueError('ambiguous-native-track')
                seen_tracks.add(track_id)
                items = []
                for item_entry in one(track, 'Items'):
                    if item_entry.tag != 'Element' or len(item_entry) != 1 or item_entry[0].tag not in ITEMS:
                        raise ValueError('unsupported-native-item')
                    if item_entry[0].tag != 'Sm2TiTransition' and item_entry[0].tag != {'video': 'Sm2TiVideoClip', 'audio': 'Sm2TiAudioClip', 'subtitle': 'Sm2TiSubtitleClip'}[kind]:
                        raise ValueError('native-item-kind-mismatch')
                    item_id = identifier(item_entry[0].attrib.get('DbId'))
                    item_key = (sequence_id, item_id)
                    if item_key in seen_items:
                        raise ValueError('duplicate-native-item')
                    seen_items.add(item_key)
                    items.append(item_id)
                name_value = one(track, 'UserDefinedName').text or ''
                by_sequence[sequence_id]['tracks'].append({'nativeTrackId': track_id, 'nativeContainerId': container_id,
                    'kind': kind, 'nativeOrdinal': ordinal, 'nameSha256': sha(name_value.encode()),
                    'itemIds': sorted(items)})
    for timeline in timelines.values():
        timeline['tracks'].sort(key=lambda item: item['nativeTrackId'])
    return {'schemaVersion': 1, 'readOnly': True, 'safeToApply': False, 'projectId': project_id,
            'archive': info, 'timelines': sorted(timelines.values(), key=lambda item: item['timelineId']),
            'stableTrackIdentityProven': False, 'apiTrackBindingProven': False,
            'limitations': ['Native serialization is undocumented; DbIds are observed native identifiers only.',
                            'Native vector ordinals are locations, never API index mappings.',
                            'Empty API tracks require an independent controlled binding experiment.',
                            'No native fields, opaque data, referenced media or editor preservation are validated.']}


def read_snapshot(filename):
    selected = Path(filename)
    if not selected.is_absolute() or any(component.is_symlink() for component in [selected, *selected.parents]):
        raise ValueError('invalid-api-source')
    named = selected.lstat()
    if not stat.S_ISREG(named.st_mode) or not 0 < named.st_size <= 24 * 1024 * 1024:
        raise ValueError('invalid-api-source')
    fd = os.open(selected, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if _reader.identity(named) != _reader.identity(before) or not stat.S_ISREG(before.st_mode):
            raise ValueError('api-source-changed')
        data = stream.read(24 * 1024 * 1024 + 1)
        if len(data) != before.st_size or _reader.identity(before) != _reader.identity(os.fstat(stream.fileno())) or _reader.identity(before) != _reader.identity(selected.lstat()):
            raise ValueError('api-source-changed')
    value = json.loads(data)
    value = value.get('snapshot', value)
    validator = str(Path(__file__).resolve().parents[1] / 'src' / 'resolve-snapshot-validator.js')
    script = "const fs=require('node:fs');require(process.argv[1]).validateResolveSnapshot(JSON.parse(fs.readFileSync(0,'utf8')));"
    run = subprocess.run(['node', '-e', script, validator], input=json.dumps(value), capture_output=True, text=True, timeout=15)
    if run.returncode != 0:
        raise ValueError('invalid-api-snapshot')
    return data, value


def bind_api(native, snapshot_path, challenge=False):
    data, snapshot = read_snapshot(snapshot_path)
    if snapshot['project_id'] != native['projectId']:
        raise ValueError('native-api-project-mismatch')
    api_timelines = {timeline['id']: timeline for timeline in snapshot['timelines']}
    native_timelines = {timeline['timelineId']: timeline for timeline in native['timelines']}
    if set(api_timelines) != set(native_timelines):
        raise ValueError('native-api-timeline-mismatch')
    rows, empty, seen_nonce = [], [], None
    for timeline_id, api in api_timelines.items():
        native_tracks = native_timelines[timeline_id]['tracks']
        if any(sum(track['kind'] == kind for track in native_tracks) != sum(track['type'] == kind for track in api['tracks']) for kind in ('video', 'audio', 'subtitle')):
            raise ValueError('native-api-track-count-mismatch')
        parent = {item_id: track for track in native_tracks for item_id in track['itemIds']}
        api_ids = {item['id'] for item in api['items']}
        if api_ids != set(parent):
            raise ValueError('native-api-items-mismatch')
        for track in api['tracks']:
            item_ids = sorted(item['id'] for item in api['items'] if item['track_type'] == track['type'] and item['track_index'] == track['index'])
            anchor = {'timelineId': timeline_id, 'type': track['type'], 'index': track['index']}
            if challenge:
                match = re.fullmatch(r'Frameline-TrackProof-([0-9a-f]{32})-(video|audio|subtitle)-([1-9][0-9]*)', track['name'])
                if not match or match[2] != track['type'] or int(match[3]) != track['index'] or (seen_nonce and seen_nonce != match[1]):
                    raise ValueError('invalid-track-challenge')
                seen_nonce = match[1]
                candidates = [candidate for candidate in native_tracks if candidate['kind'] == track['type'] and candidate['nameSha256'] == sha(track['name'].encode())]
            else:
                candidates = list({parent[item_id]['nativeTrackId']: parent[item_id] for item_id in item_ids}.values())
            if not item_ids and not challenge:
                empty.append(anchor)
                continue
            if len(candidates) != 1 or candidates[0]['kind'] != track['type'] or candidates[0]['itemIds'] != item_ids:
                raise ValueError('ambiguous-native-api-track')
            rows.append({**anchor, 'nativeTrackId': candidates[0]['nativeTrackId'],
                'status': 'controlled-name-challenge' if challenge else 'exact-item-parentage-witness', 'itemCount': len(item_ids)})
    if len({row['nativeTrackId'] for row in rows}) != len(rows):
        raise ValueError('native-track-binding-collision')
    return {**native, 'snapshotSha256': sha(data), 'apiBindings': rows, 'unboundEmptyApiTracks': empty,
            'bindingMethod': 'temporary-unique-name-challenge' if challenge else 'explicit-native-item-parentage',
            'challengeNonce': seen_nonce, 'apiTrackBindingProven': False}


def compare(before_path, after_path):
    before, after = graph(before_path), graph(after_path)
    if before['projectId'] != after['projectId']:
        raise ValueError('native-project-mismatch')
    def rows(value):
        return {track['nativeTrackId']: (timeline['timelineId'], track) for timeline in value['timelines'] for track in timeline['tracks']}
    old, new = rows(before), rows(after)
    retained = []
    for track_id in sorted(set(old) & set(new)):
        a, b = old[track_id], new[track_id]
        retained.append({'nativeTrackId': track_id, 'timelineBefore': a[0], 'timelineAfter': b[0],
            'kindBefore': a[1]['kind'], 'kindAfter': b[1]['kind'],
            'nativeOrdinalBefore': a[1]['nativeOrdinal'], 'nativeOrdinalAfter': b[1]['nativeOrdinal'],
            'nameChanged': a[1]['nameSha256'] != b[1]['nameSha256'],
            'itemIdsChanged': a[1]['itemIds'] != b[1]['itemIds']})
    return {'schemaVersion': 1, 'readOnly': True, 'safeToApply': False, 'projectId': before['projectId'],
        'before': before['archive'], 'after': after['archive'], 'retainedTracks': retained,
        'removedNativeTrackIds': sorted(set(old) - set(new)), 'addedNativeTrackIds': sorted(set(new) - set(old)),
        'stableTrackIdentityProven': False, 'apiTrackBindingProven': False}


if __name__ == '__main__':
    try:
        operation, *args = sys.argv[1:]
        if operation == 'graph' and len(args) == 1:
            report = graph(args[0])
        elif operation in ('bind-api', 'bind-challenge') and len(args) == 2:
            report = bind_api(graph(args[0]), args[1], operation == 'bind-challenge')
        elif operation == 'compare' and len(args) == 2:
            report = compare(*args)
        else:
            raise ValueError('usage')
        print(json.dumps(report, indent=2))
    except Exception:
        print('native-track-identity-inspection-failed', file=sys.stderr)
        sys.exit(1)
