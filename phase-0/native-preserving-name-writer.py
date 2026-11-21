"""One identity-bound Name edit; preserve every other decompressed native byte.

The editor round trip is a separate, required proof. This tool never claims it.
Untouched ZIP local records stay byte-identical. Only documented ZIP CRC/size/
offset fields and the target compressed stream may change. No extraction occurs.
"""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import unicodedata
import zipfile
import zlib
from xml.sax.saxutils import escape

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('preservation_native', HERE / 'resolve-native-timeline-inventory.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
TOKEN = re.compile(rb'<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|</?[A-Za-z_][A-Za-z0-9_.:-]*(?:"[^"<]*"|\x27[^\x27<]*\x27|[^"\x27<>])*>')
TAG = re.compile(rb'<(/?)([A-Za-z_][A-Za-z0-9_.:-]*)')
MAX_ARCHIVE = 100 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_bytes(filename):
    path = Path(filename)
    if not path.is_absolute() or path.suffix != '.drp' or any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError('unsafe-source')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_ARCHIVE:
            raise ValueError('unsafe-source')
        data = stream.read(MAX_ARCHIVE + 1)
        after = os.fstat(stream.fileno())
        if len(data) != before.st_size or native._native._reader.identity(before) != native._native._reader.identity(after) or native._native._reader.identity(before) != native._native._reader.identity(path.lstat()):
            raise ValueError('source-changed')
    return data


def zip_layout(raw):
    # This finite writer refuses ZIP64, encryption, multipart archives, prefixes,
    # extension records and extra fields whose offsets might need interpretation.
    end = raw.rfind(b'PK\x05\x06', max(0, len(raw) - 65557))
    if end < 0 or end + 22 > len(raw):
        raise ValueError('unsupported-zip-end')
    e = struct.unpack_from('<4s4H2LH', raw, end)
    if e[1] or e[2] or e[3] != e[4] or not 1 <= e[4] <= 1000 or e[5] == 0xffffffff or e[6] == 0xffffffff or end + 22 + e[7] != len(raw) or e[6] + e[5] != end:
        raise ValueError('unsupported-zip-envelope')
    entries, cursor, seen = [], e[6], set()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        if len(infos) != e[4]:
            raise ValueError('zip-count')
        for info in infos:
            if raw[cursor:cursor + 4] != b'PK\x01\x02':
                raise ValueError('zip-central')
            c = struct.unpack_from(zipfile.structCentralDir, raw, cursor)
            length = 46 + c[12] + c[13] + c[14]
            central = raw[cursor:cursor + length]
            name = central[46:46 + c[12]]
            normalized = unicodedata.normalize('NFC', info.filename).casefold()
            if normalized in seen or c[13] or c[15] or c[4] or c[5] & ~0x0808 or c[6] not in (0, 8) or max(c[10], c[11], c[18]) == 0xffffffff:
                raise ValueError('unsupported-zip-member')
            if c[11] > 20 * 1024 * 1024 or info.is_dir() or info.filename.startswith('/') or '\\' in info.filename or '..' in info.filename.split('/') or stat.S_ISLNK(c[17] >> 16):
                raise ValueError('unsafe-zip-member')
            seen.add(normalized)
            offset = c[18]
            if raw[offset:offset + 4] != b'PK\x03\x04' or offset != info.header_offset:
                raise ValueError('zip-local')
            h = struct.unpack_from(zipfile.structFileHeader, raw, offset)
            data_start = offset + 30 + h[10] + h[11]
            if h[11] or h[3:7] != c[5:9] or raw[offset + 30:offset + 30 + h[10]] != name or h[10] != c[12]:
                raise ValueError('zip-local-metadata')
            data_end = data_start + c[10]
            descriptor = b''
            if c[5] & 8:
                size = 16 if raw[data_end:data_end + 4] == b'PK\x07\x08' else 12
                descriptor = raw[data_end:data_end + size]
                if len(descriptor) != size or struct.unpack_from('<LLL', descriptor, size - 12) != (c[9], c[10], c[11]) or h[7:10] not in ((0, 0, 0), (c[9], c[10], c[11])):
                    raise ValueError('zip-descriptor')
            elif h[7:10] != (c[9], c[10], c[11]):
                raise ValueError('zip-local-sizes')
            payload = archive.read(info)  # ZIP CRC and expanded bounds checked.
            if len(payload) != c[11] or len(payload) > 20 * 1024 * 1024:
                raise ValueError('zip-expanded-size')
            compressed = raw[data_start:data_end]
            if c[6] == 8:
                decoder = zlib.decompressobj(-15)
                expanded = decoder.decompress(compressed, 20 * 1024 * 1024 + 1)
                if expanded != payload or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                    raise ValueError('zip-deflate-stream')
            elif compressed != payload:
                raise ValueError('zip-stored-stream')
            entries.append({'name': info.filename, 'nameBytes': name, 'bytes': payload, 'offset': offset,
                            'header': raw[offset:data_start], 'compressed': raw[data_start:data_end],
                            'descriptor': descriptor, 'local': raw[offset:data_end + len(descriptor)], 'central': central,
                            'method': c[6], 'flags': c[5]})
            cursor += length
    if cursor != end or sum(len(x['bytes']) for x in entries) > MAX_ARCHIVE:
        raise ValueError('zip-expanded-limit')
    expected = 0
    for entry in entries:
        if entry['offset'] != expected:
            raise ValueError('zip-order-or-gap')
        expected += len(entry['local'])
    if expected != e[6]:
        raise ValueError('zip-local-gap')
    return entries, raw[end:]


def name_span(data, tag, item_id, old_name):
    stack, target_depth, result = [], None, []
    for token in TOKEN.finditer(data):
        raw = token[0]
        match = TAG.match(raw)
        if not match:
            continue
        closing, name = match.groups()
        if closing:
            if not stack or stack[-1][0] != name:
                raise ValueError('native-token-parentage')
            start_name, body_start = stack.pop()
            if target_depth is not None and len(stack) == target_depth and name == b'Name':
                body = data[body_start:token.start()]
                if b'<' in body or body != escape(old_name).encode():
                    raise ValueError('name-lexical-shape')
                result.append((body_start, token.start()))
            if target_depth is not None and len(stack) == target_depth - 1:
                target_depth = None
        else:
            if len(stack) > 100:
                raise ValueError('native-depth')
            # The lexical target must be the parsed object's sole, unqualified
            # DbId attribute, not UUID-looking text inside another attribute.
            target_open = rb'<' + tag.encode() + rb'''\s+DbId\s*=\s*(["'])''' + item_id.encode() + rb'\1\s*>'
            if name == tag.encode() and re.fullmatch(target_open, raw):
                if target_depth is not None:
                    raise ValueError('ambiguous-target')
                target_depth = len(stack) + 1
            if raw.rstrip().endswith(b'/>'):
                if target_depth is not None and name == b'Name' and len(stack) == target_depth:
                    raise ValueError('empty-name-shape')
                continue
            stack.append((name, token.end()))
    if stack or len(result) != 1:
        raise ValueError('ambiguous-target-name')
    return result[0]


def rewrite(raw, target_name, offset, old_bytes, new_bytes):
    entries, end = zip_layout(raw)
    output, central, changed = bytearray(), [], 0
    for entry in entries:
        c = bytearray(entry['central'])
        struct.pack_into('<L', c, 42, len(output))
        if entry['name'] != target_name:
            output.extend(entry['local'])
        else:
            changed += 1
            original = entry['bytes']
            if original[offset:offset + len(old_bytes)] != old_bytes:
                raise ValueError('source-span-differs')
            edited = original[:offset] + new_bytes + original[offset + len(old_bytes):]
            if entry['method'] == 8:
                compressor = zlib.compressobj(6, zlib.DEFLATED, -15)
                compressed = compressor.compress(edited) + compressor.flush()
            else:
                compressed = edited
            crc = zlib.crc32(edited)
            h = bytearray(entry['header'])
            if not entry['flags'] & 8 or struct.unpack_from('<LLL', h, 14) != (0, 0, 0):
                struct.pack_into('<LLL', h, 14, crc, len(compressed), len(edited))
            descriptor = bytearray(entry['descriptor'])
            if descriptor:
                struct.pack_into('<LLL', descriptor, len(descriptor) - 12, crc, len(compressed), len(edited))
            struct.pack_into('<LLL', c, 16, crc, len(compressed), len(edited))
            output.extend(h + compressed + descriptor)
        central.append(c)
    if changed != 1:
        raise ValueError('target-member-count')
    patched_end = bytearray(end)
    struct.pack_into('<L', patched_end, 16, len(output))
    output.extend(b''.join(central))
    output.extend(patched_end)
    result = bytes(output)
    after, after_end = zip_layout(result)
    for before, current in zip(entries, after):
        expected = before['bytes'] if before['name'] != target_name else before['bytes'][:offset] + new_bytes + before['bytes'][offset + len(old_bytes):]
        if before['nameBytes'] != current['nameBytes'] or current['bytes'] != expected:
            raise ValueError('unrelated-member-changed')
        if before['name'] != target_name and before['local'] != current['local']:
            raise ValueError('untouched-local-record-changed')
        expected_central = bytearray(before['central'])
        expected_central[42:46] = current['central'][42:46]
        if before['name'] == target_name:
            expected_central[16:28] = current['central'][16:28]
        if bytes(expected_central) != current['central']:
            raise ValueError('zip-metadata-changed')
    expected_end = bytearray(end)
    expected_end[16:20] = after_end[16:20]
    if bytes(expected_end) != after_end:
        raise ValueError('zip-end-metadata-changed')
    return result, entries, after


def write_name(source, destination, expected_sha, project_id, timeline_id, item_id, old_name, new_name):
    if any(not UUID.fullmatch(value) for value in (project_id, timeline_id, item_id)) or not re.fullmatch('[a-f0-9]{64}', expected_sha) or old_name == new_name or not 0 < len(new_name.encode()) <= 256 or any(ord(c) < 32 or ord(c) == 127 for c in new_name):
        raise ValueError('invalid-name-edit')
    raw = read_bytes(source)
    if sha(raw) != expected_sha:
        raise ValueError('source-hash-differs')
    facts = native.inventory(source)
    if facts['archive']['sha256'] != expected_sha or facts['projectId'] != project_id or not facts['supportedFlatStructuralProfile']:
        raise ValueError('source-identity-differs')
    timeline = next((t for t in facts['timelines'] if t['timelineId'] == timeline_id), None)
    rows = [i for t in timeline['tracks'] for i in t['items'] if i['itemId'] == item_id] if timeline else []
    if len(rows) != 1 or rows[0]['kind'] not in ('video', 'audio') or rows[0]['nameSha256'] != sha(old_name.encode()):
        raise ValueError('unsupported-target')
    entries, _ = zip_layout(raw)
    matches = []
    for entry in entries:
        if native._native._reader.kind(entry['name']) != 'sequence':
            continue
        tree = native._native.native_tree(entry['bytes'])
        if tree.attrib.get('DbId') == timeline['nativeContainerId']:
            matches.append(entry)
    if len(matches) != 1:
        raise ValueError('ambiguous-native-container')
    target = matches[0]
    tag = 'Sm2TiVideoClip' if rows[0]['kind'] == 'video' else 'Sm2TiAudioClip'
    start, stop = name_span(target['bytes'], tag, item_id, old_name)
    old_bytes, new_bytes = target['bytes'][start:stop], escape(new_name).encode()
    output, before, after = rewrite(raw, target['name'], start, old_bytes, new_bytes)
    if read_bytes(source) != raw:
        raise ValueError('source-changed-before-publication')
    dest = Path(destination)
    parent = dest.parent
    if not dest.is_absolute() or dest.suffix != '.drp' or source == destination or any(p.is_symlink() for p in [parent, *parent.parents]):
        raise ValueError('unsafe-destination')
    s = parent.stat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077 or parent.resolve() != parent:
        raise ValueError('private-destination-required')
    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(directory)
        if (s.st_dev, s.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError('destination-directory-changed')
        with os.fdopen(os.open(dest.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory), 'wb') as stream:
            stream.write(output)
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(directory)
        named = parent.stat()
        if (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError('destination-directory-changed')
    finally:
        os.close(directory)
    if read_bytes(destination) != output:
        raise ValueError('destination-readback-differs')
    return {'schemaVersion': 1, 'operation': 'native-preserving-name-write', 'source': {'sha256': sha(raw), 'size': len(raw)},
            'written': {'sha256': sha(output), 'size': len(output)}, 'identity': {'projectId': project_id, 'timelineId': timeline_id, 'itemId': item_id},
            'edit': {'field': 'Name', 'memberNameSha256': sha(target['nameBytes']), 'offset': start, 'oldBytes': len(old_bytes), 'newBytes': len(new_bytes), 'oldSha256': sha(old_bytes), 'newSha256': sha(new_bytes)},
            'memberCount': len(before), 'unrelatedNativeMemberBytesPreserved': True, 'unknownNativeBytesExcluded': 0,
            'unchangedLocalRecordsByteIdentical': True, 'zipMetadataPreservedExceptCrcSizeOffsets': True,
            'writerBytePreservationProven': True, 'editorRoundTripPreservationProven': False,
            'losslessValidated': False, 'fullNativePreservationProven': False, 'ordinaryApplySupported': False, 'safeToApply': False}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 9:
            raise ValueError('usage')
        print(json.dumps(write_name(*sys.argv[1:]), sort_keys=True))
    except Exception:
        print('native-preserving-name-write-refused', file=sys.stderr)
        sys.exit(1)
