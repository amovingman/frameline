"""Read-only complete native-byte census; unknown payloads remain uninterpreted.

Lexical ranges partition original bytes. No XML serialization, value/UUID
normalization, field omission or editor-round-trip claim occurs here.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

_spec = importlib.util.spec_from_file_location('preservation_zip', Path(__file__).with_name('native-preserving-name-writer.py'))
if hashlib.sha256(Path(_spec.origin).read_bytes()).hexdigest() != 'fcc2138270fffe560c5feb9156f76f2eb2dff445a347a8f0e3184fb036be2492':
    raise ValueError('native-writer-source-pin')
_zip = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_zip)
_TAG = re.compile(rb'<(/?)([A-Za-z_][A-Za-z0-9_.:-]*)')
_ATTR = re.compile(rb'\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("[^"<]*"|\x27[^\x27<]*\x27)')
_UUID = re.compile(rb'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$')
MAX_TOKENS = 500000


def sha(value):
    return hashlib.sha256(value).hexdigest()


def span(data, start, end, kind):
    return {'offset': start, 'endOffsetExclusive': end, 'bytes': end - start,
            'sha256': sha(data[start:end]), 'kind': kind}


def lexical_census(data):
    tokens, nodes, stack = [], [], []
    if data and b'<' not in data:
        return {'tokenization': 'opaque-unparsed', 'diagnosticCode': 'non-markup-member', 'allRawBytesPartitioned': True, 'tokens': [span(data, 0, len(data), 'opaque-member')], 'nodes': [], 'textAndAttributesInterpreted': False, 'semanticXmlValidityEstablished': False}
    at = 0
    try:
        while at < len(data):
            if len(tokens) >= MAX_TOKENS:
                raise ValueError('token-limit')
            if data[at:at + 1] != b'<':
                end = data.find(b'<', at)
                end = len(data) if end < 0 else end
                tokens.append(span(data, at, end, 'text-or-whitespace'))
                at = end
                continue
            if data.startswith(b'<!--', at):
                stop, kind, suffix = data.find(b'-->', at + 4), 'comment', 3
            elif data.startswith(b'<![CDATA[', at):
                stop, kind, suffix = data.find(b']]>', at + 9), 'cdata', 3
            elif data.startswith(b'<?', at):
                stop, kind, suffix = data.find(b'?>', at + 2), 'processing-instruction', 2
            elif data.startswith(b'<!DOCTYPE', at):
                stop, kind, suffix = data.find(b'>', at + 9), 'doctype-uninterpreted', 1
                if stop >= 0 and b'[' in data[at:stop]:
                    raise ValueError('unsupported-doctype-subset')
            else:
                stop, kind, suffix = -1, 'element-tag', 1
                quote = None
                for cursor in range(at + 1, len(data)):
                    char = data[cursor]
                    if quote is not None:
                        if char == quote:
                            quote = None
                    elif char in (34, 39):
                        quote = char
                    elif char == 62:
                        stop = cursor
                        break
                if stop < 0:
                    raise ValueError('unterminated-tag')
                match = _TAG.match(data, at)
                if not match:
                    raise ValueError('unrecognized-tag')
                closing, tag = match.groups()
                if closing:
                    if data[match.end():stop].strip() or not stack or stack[-1]['tag'] != tag:
                        raise ValueError('tag-parentage')
                    node = stack.pop()
                    record = nodes[node['index']]
                    record.update(span(data, node['start'], stop + 1, 'element-subtree'))
                    record['contentEndOffsetExclusive'] = at
                else:
                    content = data[match.end():stop]
                    self_closing = content.rstrip().endswith(b'/')
                    attribute_end = stop
                    if self_closing:
                        attribute_end = match.end() + len(content.rstrip()) - 1
                    cursor, attributes, owner = match.end(), [], stack[-1]['owner'] if stack else None
                    while cursor < attribute_end:
                        if not data[cursor:attribute_end].strip():
                            break
                        attribute = _ATTR.match(data, cursor)
                        if attribute is None or attribute.end() > attribute_end:
                            raise ValueError('attribute-shape')
                        name, quoted = attribute.groups()
                        attributes.append({**span(data, attribute.start(), attribute.end(), 'attribute-lexeme'),
                                           'attributeNameSha256': sha(name), 'rawQuotedValueSha256': sha(quoted)})
                        if name == b'DbId' and _UUID.fullmatch(quoted[1:-1]):
                            owner = quoted[1:-1].decode('ascii')
                        cursor = attribute.end()
                    if len(stack) >= 256:
                        raise ValueError('element-depth')
                    record = {'tagNameSha256': sha(tag), 'ownerNativeId': owner,
                              'startTagOffset': at, 'contentStartOffset': stop + 1,
                              'attributes': attributes, 'selfClosing': self_closing}
                    nodes.append(record)
                    if self_closing:
                        record.update(span(data, at, stop + 1, 'element-subtree'))
                        record['contentEndOffsetExclusive'] = stop + 1
                    else:
                        stack.append({'tag': tag, 'owner': owner, 'start': at, 'index': len(nodes) - 1})
            if stop < 0:
                raise ValueError('unterminated-lexeme')
            end = stop + suffix
            tokens.append(span(data, at, end, kind))
            at = end
        if stack:
            raise ValueError('unclosed-elements')
        cursor = 0
        for token in tokens:
            if token['offset'] != cursor:
                raise ValueError('byte-partition-gap')
            cursor = token['endOffsetExclusive']
        if cursor != len(data):
            raise ValueError('byte-partition-gap')
        return {'tokenization': 'native-lexical-ranges', 'allRawBytesPartitioned': True,
                'tokens': tokens, 'nodes': nodes, 'textAndAttributesInterpreted': False,
                'semanticXmlValidityEstablished': False}
    except ValueError as error:
        # Unsupported/binary data remains one exact, fully covered opaque range.
        # It is never dropped or treated as an empty document.
        return {'tokenization': 'opaque-unparsed', 'diagnosticCode': str(error),
                'allRawBytesPartitioned': True, 'tokens': [span(data, 0, len(data), 'opaque-member')],
                'nodes': [], 'textAndAttributesInterpreted': False,
                'semanticXmlValidityEstablished': False}


def load_members(filename):
    raw = _zip.read_bytes(filename)
    entries, end = _zip.zip_layout(raw)
    return raw, entries, end


def census(filename):
    raw, entries, end = load_members(filename)
    members, envelope, cursor = [], [], 0
    for entry in entries:
        for key in ['header', 'compressed', 'descriptor']:
            value = entry[key]
            if value:
                envelope.append(span(raw, cursor, cursor + len(value), 'zip-local-' + key))
                cursor += len(value)
        lexical = lexical_census(entry['bytes'])
        members.append({'memberNameSha256': sha(entry['nameBytes']), 'bytes': len(entry['bytes']),
                        'sha256': sha(entry['bytes']), 'zipLocalRecordSha256': sha(entry['local']),
                        'zipCentralRecordSha256': sha(entry['central']), **lexical})
    for entry in entries:
        envelope.append(span(raw, cursor, cursor + len(entry['central']), 'zip-central-record'))
        cursor += len(entry['central'])
    envelope.append(span(raw, cursor, cursor + len(end), 'zip-end-record-and-comment'))
    cursor += len(end)
    if cursor != len(raw) or sum(token['bytes'] for token in envelope) != len(raw):
        raise ValueError('archive-byte-partition-gap')
    return {'schemaVersion': 1, 'operation': 'native-complete-byte-census', 'readOnly': True,
            'archive': {'sha256': sha(raw), 'bytes': len(raw)}, 'memberCount': len(members),
            'members': members, 'zipEnvelopeRanges': envelope,
            'allArchiveBytesAccountedFor': True, 'allNativeMemberBytesAccountedFor': True,
            'unknownMembersOrFieldsExcluded': 0, 'nativePayloadsNormalized': False,
            'semanticEquivalenceProven': False, 'editorExecutionValidated': False,
            'losslessValidated': False, 'ordinaryApplySupported': False, 'safeToApply': False}


def write_private_entries(filename, destination):
    raw, entries, _ = load_members(filename)
    target = Path(destination)
    if not target.is_absolute() or any(p.is_symlink() for p in [target.parent, *target.parent.parents]):
        raise ValueError('unsafe-private-output')
    parent = target.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('owner-only-directory-required')
    value = {'schemaVersion': 1, 'sourceArchiveSha256': sha(raw), 'rawPrivateData': True,
             'entries': [{'nameBytesHex': e['nameBytes'].hex(),
                          'bytesBase64': base64.b64encode(e['bytes']).decode('ascii')} for e in entries]}
    descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (parent.st_dev, parent.st_ino) or opened.st_uid != os.getuid() or opened.st_mode & 0o077:
            raise ValueError('private-output-directory-changed')
        with os.fdopen(os.open(target.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor), 'wb') as stream:
            stream.write(json.dumps(value, separators=(',', ':')).encode() + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return {'privateEntriesWritten': True, 'sourceArchiveSha256': sha(raw), 'memberCount': len(entries),
            'rawDataPrinted': False, 'losslessValidated': False, 'safeToApply': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2:
            result = census(sys.argv[1])
        elif len(sys.argv) == 4 and sys.argv[1] == 'private-entries':
            result = write_private_entries(sys.argv[2], sys.argv[3])
        else:
            raise ValueError('usage')
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    except Exception:
        print('native-byte-census-failed', file=sys.stderr)
        sys.exit(1)
