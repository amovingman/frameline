"""Read-only byte and line evidence for native Resolve exports; never edit them."""
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import zipfile

MAX_ARCHIVE = 100 * 1024 * 1024
MAX_MEMBER = 20 * 1024 * 1024
MAX_MEMBERS = 1000
MAX_LINES = 100000
PUBLIC_TAGS = {'SM_Project', 'Name', 'FieldsBlob', 'Body', 'DbSavedTime', 'BtThumnail',
               'BlobOwner', 'BtMetadataLockableBlob', 'Element', 'LastModTimeInSecs', 'ProjectAgeInMs'}


def digest(value):
    return hashlib.sha256(value).hexdigest()


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_export(filename):
    selected = Path(filename)
    if not selected.is_absolute() or selected.suffix != '.drp':
        raise ValueError('invalid-input')
    for component in [selected, *selected.parents]:
        if component.is_symlink():
            raise ValueError('symlink-input')
    named = selected.lstat()
    if not stat.S_ISREG(named.st_mode) or not 0 < named.st_size <= MAX_ARCHIVE:
        raise ValueError('invalid-size')
    descriptor = os.open(selected, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_ARCHIVE or identity(before) != identity(named):
            raise ValueError('invalid-size')
        archive = stream.read(MAX_ARCHIVE + 1)
        if len(archive) != before.st_size or identity(before) != identity(os.fstat(stream.fileno())) or identity(before) != identity(selected.lstat()):
            raise ValueError('changed-source')
    members = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        entries = source.infolist()
        if not 1 <= len(entries) <= MAX_MEMBERS:
            raise ValueError('member-limit')
        total = 0
        for entry in entries:
            name = entry.filename
            if name in members or name.startswith('/') or '\\' in name or '..' in name.split('/') or entry.is_dir():
                raise ValueError('invalid-member')
            if entry.file_size > MAX_MEMBER:
                raise ValueError('member-limit')
            total += entry.file_size
            if total > MAX_ARCHIVE:
                raise ValueError('expanded-limit')
            # ZipFile checks each member CRC while reading. No extraction occurs.
            with source.open(entry) as stream:
                data = stream.read(MAX_MEMBER + 1)
            if len(data) != entry.file_size or len(data) > MAX_MEMBER:
                raise ValueError('member-size-mismatch')
            members[name] = data
    if 'project.xml' not in members or 'MediaPool/Master/MpFolder.xml' not in members or not any(name.startswith('SeqContainer/') for name in members):
        raise ValueError('missing-project-members')
    return {'sha256': digest(archive), 'size': len(archive)}, members


def kind(name):
    if name == 'project.xml':
        return 'project'
    if name == 'Gallery.xml':
        return 'gallery'
    if name.startswith('MediaPool/'):
        return 'media-pool'
    if name.startswith('SeqContainer/'):
        return 'sequence'
    return 'other'


def changed_lines(before, after):
    old = before.decode('utf-8').splitlines()
    new = after.decode('utf-8').splitlines()
    if max(len(old), len(new)) > MAX_LINES:
        raise ValueError('line-limit')
    tags = {}
    for operation, a, b, c, d in difflib.SequenceMatcher(None, old, new).get_opcodes():
        if operation == 'equal':
            continue
        for side, lines in [('removed', old[a:b]), ('added', new[c:d])]:
            for line in lines:
                match = re.match(r'\s*</?([A-Za-z_][A-Za-z0-9_:.-]*)', line)
                tag = match[1] if match and match[1] in PUBLIC_TAGS else 'other-tag' if match else 'non-tag-line'
                counts = tags.setdefault(tag, {'removed': 0, 'added': 0})
                counts[side] += 1
    return dict(sorted(tags.items()))


def compare_exports(before_path, after_path):
    before_info, before = read_export(before_path)
    after_info, after = read_export(after_path)
    evidence = []
    for name in sorted(set(before) | set(after)):
        old, new = before.get(name), after.get(name)
        status = 'added' if old is None else 'removed' if new is None else 'unchanged' if old == new else 'changed'
        evidence.append({'memberNameSha256': digest(name.encode()), 'kind': kind(name), 'status': status,
                         'beforeSha256': digest(old) if old is not None else None,
                         'afterSha256': digest(new) if new is not None else None,
                         'changedLineTags': changed_lines(old, new) if status == 'changed' else {}})
    changed = sum(member['status'] != 'unchanged' for member in evidence)
    return {'schemaVersion': 1, 'readOnly': True, 'safeToApply': False,
            'losslessValidated': False, 'before': before_info, 'after': after_info,
            'memberBytesMatch': changed == 0, 'changedMembers': changed, 'members': evidence,
            'limitations': ['Native serialization is undocumented; line tags are diagnostic labels only.',
                            'No changed fields or opaque blobs are ignored.',
                            'Matching bytes cannot prove editor behavior or referenced media identity.']}


def compare_with_control(edit_before, edit_after, control_before, control_after):
    edit = compare_exports(edit_before, edit_after)
    control = compare_exports(control_before, control_after)
    by_edit = {member['memberNameSha256']: member for member in edit['members']}
    by_control = {member['memberNameSha256']: member for member in control['members']}
    evidence = []
    for key in sorted(set(by_edit) | set(by_control)):
        changed = by_edit.get(key)
        unchanged = by_control.get(key)
        edit_tags = changed['changedLineTags'] if changed else {}
        control_tags = unchanged['changedLineTags'] if unchanged else {}
        evidence.append({'memberNameSha256': key, 'kind': (changed or unchanged)['kind'],
                         'editStatus': changed['status'] if changed else 'not-observed',
                         'controlStatus': unchanged['status'] if unchanged else 'not-observed',
                         'editLineTags': edit_tags, 'controlLineTags': control_tags,
                         'commonTags': sorted(set(edit_tags) & set(control_tags)),
                         'editOnlyTags': sorted(set(edit_tags) - set(control_tags)),
                         'controlOnlyTags': sorted(set(control_tags) - set(edit_tags))})
    return {'schemaVersion': 1, 'readOnly': True, 'safeToApply': False, 'losslessValidated': False,
            'edit': edit, 'control': control, 'tagEvidence': evidence,
            'limitations': ['A common line tag does not prove the same semantic property changed.',
                            'No native fields or blobs are ignored based on the control.',
                            'This comparison does not prove editor state, media identity, or lossless writing.']}


if __name__ == '__main__':
    try:
        if len(sys.argv) not in (3, 5):
            raise ValueError('usage')
        compare = compare_exports if len(sys.argv) == 3 else compare_with_control
        print(json.dumps(compare(*sys.argv[1:]), indent=2))
    except Exception:
        print('native-resolve-comparison-failed', file=sys.stderr)
        sys.exit(1)
