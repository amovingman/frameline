"""Localize selected native opaque payloads without interpreting or writing them."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

_spec = importlib.util.spec_from_file_location('native_graph_reader', Path(__file__).with_name('resolve-native-track-identity.py'))
_native = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_native)
TAGS = {'FieldsBlob', 'Body', 'BtMetadataLockableBlob', 'BlobOwner', 'BtThumnail'}
MAX_RECORDS = 20000


def sha(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def payload(node):
    text = node.text or ''
    raw = text.encode('utf-8')
    result = {'textSha256': sha(raw), 'textBytes': len(raw), 'textIsNull': node.text is None,
              'attributeCount': len(node.attrib), 'attributesSha256': sha(encoded(node.attrib)),
              'childCount': len(node), 'nestedContentsInspected': False}
    # Hex is an observed text encoding, not a serialization schema. Never infer
    # the meaning of decoded bytes or discard an unknown/changed payload.
    if len(node):
        result['encoding'] = 'nested-uninspected'
    elif not text:
        result['encoding'] = 'empty-text'
    elif len(text) % 2 == 0 and re.fullmatch('[0-9a-fA-F]+', text):
        decoded = bytes.fromhex(text)
        result.update(encoding='hex-octets', decodedBytes=len(decoded), decodedSha256=sha(decoded))
    else:
        result['encoding'] = 'text-uninterpreted'
    return result


def inventory(filename, api_file=None):
    archive, members = _native._reader.read_export(filename)
    project = _native.native_tree(members['project.xml'])
    if project.tag != 'SM_Project':
        raise ValueError('unsupported-native-project')
    project_id = _native.identifier(project.attrib.get('DbId'))
    api_ids, api_hash = set(), None
    if api_file is not None:
        api_bytes, snapshot = _native.read_snapshot(api_file)
        if snapshot['project_id'] != project_id:
            raise ValueError('native-api-project-mismatch')
        api_ids = {item['id'] for timeline in snapshot['timelines'] for item in timeline['items']}
        api_hash = sha(api_bytes)
    records, member_facts, seen = [], [], set()
    for name, data in sorted(members.items()):
        member_hash = sha(name.encode())
        kind = _native._reader.kind(name)
        if kind not in {'project', 'media-pool', 'sequence'}:
            member_facts.append({'memberNameSha256': member_hash, 'kind': kind,
                                 'rawSha256': sha(data), 'parsed': False})
            continue
        tree = _native.native_tree(data)
        member_facts.append({'memberNameSha256': member_hash, 'kind': kind,
                             'rawSha256': sha(data), 'parsed': True})
        stack = [(tree, None, None, None, [], [])]
        while stack:
            node, owner, owner_type, containing_item, relative, absolute = stack.pop()
            db_id = node.attrib.get('DbId')
            if isinstance(db_id, str) and _native.UUID.fullmatch(db_id):
                owner, owner_type, relative = db_id, sha(node.tag.encode()), []
                if db_id in api_ids and node.tag in _native.ITEMS:
                    containing_item = db_id
            if node.tag in TAGS:
                location = {'memberNameSha256': member_hash, 'memberKind': kind, 'ownerNativeId': owner,
                            'ownerTypeSha256': owner_type,
                            'relativeLocationSha256': sha(encoded(relative if owner else absolute))}
                # Member filenames can change on save. Explicit native owners
                # anchor the diagnostic field; an ownerless field remains a
                # member/path location. Ambiguous duplicate owner paths refuse.
                key = sha(encoded({'projectId': project_id, 'namespace': kind if owner else member_hash,
                                   'ownerNativeId': owner, 'ownerTypeSha256': owner_type,
                                   'relativeLocationSha256': location['relativeLocationSha256']}))
                if key in seen or len(records) >= MAX_RECORDS:
                    raise ValueError('ambiguous-or-excess-native-fields')
                seen.add(key)
                records.append({**location, 'fieldKey': key, 'tag': node.tag,
                                'containingApiItemIdMatch': containing_item,
                                'ownerMatchesApiItemId': owner in api_ids if api_file is not None else None,
                                **payload(node)})
            counts = {}
            children = []
            for child in node:
                index = counts.get(child.tag, 0) + 1
                counts[child.tag] = index
                segment = [child.tag, index]
                children.append((child, owner, owner_type, containing_item, relative + [segment], absolute + [segment]))
            stack.extend(reversed(children))
    return {'schemaVersion': 1, 'operation': 'native-opaque-payload-inventory',
            'readOnly': True, 'safeToApply': False, 'losslessValidated': False,
            'projectId': project_id, 'archive': archive, 'apiSourceSha256': api_hash,
            'members': member_facts, 'records': sorted(records, key=lambda row: row['fieldKey']),
            'apiItemAncestorMatchingAttempted': api_file is not None,
            'allNativeFieldsCovered': False,
            'limitations': ['Only the selected opaque field tags are localized; other native fields remain outside this inventory.',
                            'Text hashes cover parsed XML text, not exact serialized field bytes; untouched member/archive hashes are retained separately.',
                            'Explicit owner UUIDs anchor relative diagnostic field locations; this does not establish general persistent field identity.',
                            'Hex decoding identifies octets only; no semantic meaning, volatility or harmlessness is inferred.',
                            'API-item ancestor matches require a native item tag and UUID equality only; this inventory does not independently validate complete timeline parentage.',
                            'Nested payload contents are not inspected. No changed payload is ignored.']}


def compare(before_file, after_file, api_file=None):
    before, after = inventory(before_file, api_file), inventory(after_file, api_file)
    if before['projectId'] != after['projectId']:
        raise ValueError('native-project-mismatch')
    old = {row['fieldKey']: row for row in before['records']}
    new = {row['fieldKey']: row for row in after['records']}
    changes, location_changes, context_changes = [], [], []
    metadata = {'memberNameSha256', 'memberKind', 'ownerNativeId', 'ownerTypeSha256',
                'relativeLocationSha256', 'fieldKey', 'tag', 'containingApiItemIdMatch', 'ownerMatchesApiItemId'}
    for key in sorted(set(old) | set(new)):
        a, b = old.get(key), new.get(key)
        old_payload = {key: value for key, value in a.items() if key not in metadata} if a else None
        new_payload = {key: value for key, value in b.items() if key not in metadata} if b else None
        if a and b and a['containingApiItemIdMatch'] != b['containingApiItemIdMatch']:
            context_changes.append({'fieldKey': key, 'ownerNativeId': a['ownerNativeId'],
                                    'beforeApiItemIdMatch': a['containingApiItemIdMatch'],
                                    'afterApiItemIdMatch': b['containingApiItemIdMatch']})
        if old_payload != new_payload:
            reference = b or a
            changes.append({'fieldKey': key, 'ownerNativeId': reference['ownerNativeId'],
                            'status': 'added-record' if a is None else 'removed-record' if b is None else 'observed-payload-difference',
                            'ownerMatchesApiItemId': reference['ownerMatchesApiItemId'],
                            'containingApiItemIdMatch': reference['containingApiItemIdMatch'],
                            'tag': reference['tag'], 'before': a, 'after': b})
        elif a['memberNameSha256'] != b['memberNameSha256']:
            location_changes.append({'fieldKey': key, 'ownerNativeId': a['ownerNativeId'],
                                     'beforeMemberNameSha256': a['memberNameSha256'],
                                     'afterMemberNameSha256': b['memberNameSha256']})
    member_old = {row['memberNameSha256']: row['rawSha256'] for row in before['members']}
    member_new = {row['memberNameSha256']: row['rawSha256'] for row in after['members']}
    return {'schemaVersion': 1, 'operation': 'native-opaque-payload-comparison',
            'readOnly': True, 'safeToApply': False, 'losslessValidated': False,
            'projectId': before['projectId'], 'beforeArchive': before['archive'], 'afterArchive': after['archive'],
            'apiSourceSha256': before['apiSourceSha256'], 'selectedPayloadChanges': changes,
            'recordDifferenceCounts': {kind: sum(row['status'] == kind for row in changes)
                                       for kind in ['added-record', 'removed-record', 'observed-payload-difference']},
            'memberLocationChangesWithSameObservedPayload': location_changes,
            'apiItemAncestorMatchChanges': context_changes,
            'pairedApiItemAncestorMatchesUnchanged': not context_changes if api_file is not None else None,
            'selectedParsedTextAndShapeMatch': not changes,
            'completeSelectedPayloadEqualityProven': False,
            'rawMemberBytesMatch': member_old == member_new,
            'uncoveredNativeDifferencesPossible': True, 'limitations': before['limitations']}


if __name__ == '__main__':
    try:
        op, *args = sys.argv[1:]
        if op == 'inventory' and len(args) in (1, 2):
            result = inventory(*args)
        elif op == 'compare' and len(args) in (2, 3):
            result = compare(*args)
        else:
            raise ValueError('usage')
        print(json.dumps(result, indent=2))
    except Exception:
        print('native-field-inspection-failed', file=sys.stderr)
        sys.exit(1)
