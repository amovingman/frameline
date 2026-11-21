'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createClosedProjectOfflineGuard, assertSameClosedProjectObservation, parseProcessList }
  = require('../src/closed-project-apply-offline-guard');

const INFO = { CFBundleShortVersionString: '21.1.2', CFBundleVersion: '21.1.20010',
  CFBundleIdentifier: 'com.blackmagic-design.DaVinciResolve', CFBundleExecutable: 'Resolve' };
const PROCESS = '  1 Fri Nov 20 09:15:36 2026 /sbin/launchd\n';
const bytes = Buffer.from('private database fixture; guard does not interpret SQL');
const hash = createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-offline-guard-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'Owner project');
  await fs.mkdir(parent, { mode: 0o700 });
  const sourcePath = path.join(await fs.realpath(parent), 'Project.db');
  await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
  return { root, parent, sourcePath };
}

function harness(overrides = {}) {
  const calls = [];
  const execFile = async (file, args, options) => {
    calls.push({ file, args, options });
    const override = overrides[file];
    if (override) return override(args, calls.filter(call => call.file === file).length);
    if (file === '/usr/bin/plutil') return { stdout: JSON.stringify(INFO), stderr: '' };
    if (file === '/bin/ps') return { stdout: PROCESS, stderr: '' };
    if (file === '/usr/sbin/lsof') throw Object.assign(new Error('no matches'), { code: 1, stdout: '', stderr: '' });
    if (file === '/usr/bin/stat') return { stdout: '0\n', stderr: '' };
    if (file === '/bin/ls') return { stdout: '-rw------- 1 owner staff 52 Nov 20 09:15 Project.db\n', stderr: '' };
    if (file === '/usr/bin/xattr') return { stdout: '', stderr: '' };
    throw new Error(`Unexpected executable: ${file}`);
  };
  return { guard: createClosedProjectOfflineGuard({ execFile, platform: 'darwin' }), calls };
}

test('fresh offline observation binds bytes, exact metadata and two empty process/open-file observations without authority', async t => {
  const { sourcePath } = await fixture(t), { guard, calls } = harness();
  const result = await guard.inspect({ sourcePath, expectedSourceHash: hash });
  assert.equal(result.sha256, hash);
  assert.equal(result.size, bytes.length);
  assert.equal(result.identity.nlink, 1);
  assert.equal(result.metadata.mode, 0o600);
  assert.deepEqual(result.metadata.extendedAttributes, []);
  assert.equal(result.metadata.exactPreservationRequired, true);
  assert.equal(result.freshObservationOnly, true);
  assert.equal(result.safeToApply, false);
  assert.equal(result.concurrencyExclusionProven, false);
  assert.equal(calls.filter(call => call.file === '/bin/ps').length, 2);
  assert.equal(calls.filter(call => call.file === '/usr/sbin/lsof').length, 2);
  assert.ok(calls.every(call => call.options.env.LC_ALL === 'C' && call.options.timeout === 10000 && !call.options.shell));
  const again = await guard.inspect({ sourcePath });
  assert.equal(assertSameClosedProjectObservation(result, again), true);
  await fs.writeFile(sourcePath, Buffer.from('different bytes'));
  const changed = await guard.inspect({ sourcePath });
  assert.throws(() => assertSameClosedProjectObservation(result, changed), /source-changed/);
});

test('preserves opaque attribute byte values in the required metadata profile', async t => {
  const { sourcePath } = await fixture(t);
  const { guard } = harness({ '/usr/bin/xattr': async args => ({ stdout: args[0] === '-px'
    ? (args[1] === 'com.apple.provenance' ? '00 ff 80\n' : '') : 'user.empty\ncom.apple.provenance\n', stderr: '' }) });
  const result = await guard.inspect({ sourcePath });
  assert.deepEqual(result.metadata.extendedAttributes, [
    { name: 'com.apple.provenance', valueHex: '00ff80', bytes: 3 }, { name: 'user.empty', valueHex: '', bytes: 0 }]);
});

test('a started Resolve, including alternate app paths, is rejected', async t => {
  const { sourcePath } = await fixture(t);
  for (const command of ['/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve',
    '/Volumes/Other/Resolve', 'Resolve', '/Applications/DaVinci Resolve Studio.app/Contents/MacOS/Resolve']) {
    const { guard } = harness({ '/bin/ps': async () => ({ stdout: `${PROCESS} 22 Fri Nov 20 10:00:00 2026 ${command}\n`, stderr: '' }) });
    await assert.rejects(guard.inspect({ sourcePath }), /resolve-running/);
  }
});

test('process evidence retains PID and start time and rejects malformed, empty or duplicate observations', () => {
  assert.deepEqual(parseProcessList(' 22 Fri Nov 20 10:00:00 2026 Resolve\n'),
    [{ pid: 22, started: 'Fri Nov 20 10:00:00 2026', command: 'Resolve' }]);
  for (const input of ['', 'garbage', PROCESS + PROCESS, '123 Resolve\n']) {
    assert.throws(() => parseProcessList(input), /process-observation-unavailable/);
  }
});

test('only lsof exit one with both streams empty establishes observed absence', async t => {
  const { sourcePath } = await fixture(t);
  for (const result of [
    { stdout: 'p13\nf4\ntREG\nnProject.db\n', stderr: '' },
    { stdout: '', stderr: '' },
    Object.assign(new Error('denied'), { code: 1, stdout: '', stderr: 'permission denied' }),
    Object.assign(new Error('failed'), { code: 2, stdout: '', stderr: '' }),
    Object.assign(new Error('partial'), { code: 1, stdout: 'p13\n', stderr: '' })
  ]) {
    const { guard } = harness({ '/usr/sbin/lsof': async () => { if (result instanceof Error) throw result; return result; } });
    await assert.rejects(guard.inspect({ sourcePath }), /source-open|open-file-observation-unavailable/);
  }
});

test('blocked process observer and mismatching installed build fail closed', async t => {
  const { sourcePath } = await fixture(t);
  await assert.rejects(harness({ '/bin/ps': async () => { throw Object.assign(new Error('denied'), { code: 1 }); } })
    .guard.inspect({ sourcePath }), /process-observation-unavailable/);
  for (const altered of [{ CFBundleVersion: '21.1.20011' }, { CFBundleIdentifier: 'com.other.resolve' },
    { CFBundleExecutable: 'Other' }, { CFBundleShortVersionString: '22.0' }]) {
    await assert.rejects(harness({ '/usr/bin/plutil': async () => ({ stdout: JSON.stringify({ ...INFO, ...altered }), stderr: '' }) })
      .guard.inspect({ sourcePath }), /installed-build-unsupported/);
  }
});

test('Resolve appearing on the second observation prevents admission', async t => {
  const { sourcePath } = await fixture(t);
  const { guard } = harness({ '/bin/ps': async (_args, count) => ({ stdout: count === 1 ? PROCESS
    : `${PROCESS} 22 Fri Nov 20 10:00:00 2026 Resolve\n`, stderr: '' }) });
  await assert.rejects(guard.inspect({ sourcePath }), /resolve-running/);
});

test('symlinks, hardlinks, sidecars and unrelated sibling files are refused', async t => {
  const { root, parent, sourcePath } = await fixture(t), { guard } = harness();
  const linkParent = path.join(root, 'alias');
  await fs.symlink(parent, linkParent);
  await assert.rejects(guard.inspect({ sourcePath: path.join(linkParent, 'Project.db') }), /source-noncanonical/);
  const hardlink = path.join(root, 'linked.db');
  await fs.link(sourcePath, hardlink);
  await assert.rejects(guard.inspect({ sourcePath }), /source-file-unsafe/);
  await fs.unlink(hardlink);
  for (const name of ['Project.db-wal', 'Project.db-journal', 'Project.db-shm', 'other.txt']) {
    await fs.writeFile(path.join(parent, name), 'present');
    await assert.rejects(guard.inspect({ sourcePath }), /source-directory-not-single-file/);
    await fs.unlink(path.join(parent, name));
  }
});

test('unsafe permissions are refused without chmod or mutation', async t => {
  const { root, parent, sourcePath } = await fixture(t), { guard } = harness();
  for (const mode of [0o666, 0o400, 0o700]) {
    await fs.chmod(sourcePath, mode);
    await assert.rejects(guard.inspect({ sourcePath }), /source-permissions-unsupported/);
    assert.equal((await fs.stat(sourcePath)).mode & 0o7777, mode);
  }
  await fs.chmod(sourcePath, 0o600);
  const exposed = await fs.mkdtemp('/private/tmp/frameline-exposed-');
  t.after(() => fs.rm(exposed, { recursive: true, force: true }));
  await fs.chmod(exposed, 0o777);
  const exposedSource = path.join(exposed, 'Project.db');
  await fs.writeFile(exposedSource, bytes, { mode: 0o600 });
  await assert.rejects(guard.inspect({ sourcePath: exposedSource }), /source-directory-unsafe/);
});

test('Resolve writable directories require a private ancestor with no traversal-granting ACL', async t => {
  const { root, parent, sourcePath } = await fixture(t);
  await fs.chmod(parent, 0o777);
  const { guard } = harness({ '/bin/ls': async args => ({ stdout: args.at(-1) === await fs.realpath(root)
    ? 'drwx------ 1 owner staff 52 Nov 20 09:15 private\n' : '-rw------- 1 owner staff 52 Nov 20 09:15 Project.db\n', stderr: '' }) });
  const result = await guard.inspect({ sourcePath });
  assert.equal(result.directoryIdentity.mode, 0o777);
  assert.equal(result.directoryIdentity.accessBoundary.path, await fs.realpath(root));
  assert.equal((await fs.stat(parent)).mode & 0o7777, 0o777);
  const restricted = harness({ '/bin/ls': async args => ({ stdout: args.at(-1) === await fs.realpath(root)
    ? 'drwx------+ 1 owner staff 52 Nov 20 09:15 private\n 0: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C deny delete\n'
    : '-rw------- 1 owner staff 52 Nov 20 09:15 Project.db\n', stderr: '' }) });
  const restrictedResult = await restricted.guard.inspect({ sourcePath });
  assert.equal(restrictedResult.directoryIdentity.accessBoundary.aclEntries.length, 1);
  const denied = harness({ '/bin/ls': async () => ({ stdout: 'drwx------+ 1 owner staff 52 Nov 20 09:15 private\n 0: user:other allow search\n', stderr: '' }) });
  await assert.rejects(denied.guard.inspect({ sourcePath }), /source-directory-access-unverified/);
});

test('ACLs and filesystem flags outside the supported metadata profile are rejected', async t => {
  const { sourcePath } = await fixture(t);
  for (const listing of ['-rw-------+ 1 owner staff 52 Nov 20 09:15 Project.db\n',
    '-rw-------@ 1 owner staff 52 Nov 20 09:15 Project.db\n 0: group:everyone deny delete\n']) {
    await assert.rejects(harness({ '/bin/ls': async () => ({ stdout: listing, stderr: '' }) })
      .guard.inspect({ sourcePath }), /source-acl-unsupported/);
  }
  await assert.rejects(harness({ '/usr/bin/stat': async () => ({ stdout: '2\n', stderr: '' }) })
    .guard.inspect({ sourcePath }), /source-flags-unsupported/);
});

test('source, metadata and build changes during observation are detected', async t => {
  const { sourcePath } = await fixture(t);
  const altered = harness({ '/usr/bin/xattr': async (_args, count) => {
    if (count === 2) await fs.writeFile(sourcePath, Buffer.from('a changed project'));
    return { stdout: '', stderr: '' };
  } });
  await assert.rejects(altered.guard.inspect({ sourcePath }), /source-changed/);
  const meta = harness({ '/usr/bin/xattr': async (args, count) => ({ stdout: args[0] === '-px' ? 'ab\n'
    : count === 1 ? '' : 'user.late\n', stderr: '' }) });
  await assert.rejects(meta.guard.inspect({ sourcePath }), /source-changed/);
  const build = harness({ '/usr/bin/plutil': async (_args, count) => ({ stdout: JSON.stringify({ ...INFO, extra: count }), stderr: '' }) });
  await assert.rejects(build.guard.inspect({ sourcePath }), /editor-state-changed/);
});

test('stale hashes, invalid paths and non-macOS use cannot be admitted', async t => {
  const { sourcePath } = await fixture(t), { guard } = harness();
  await assert.rejects(guard.inspect({ sourcePath, expectedSourceHash: '0'.repeat(64) }), /source-hash-stale/);
  await assert.rejects(guard.inspect({ sourcePath, expectedSourceHash: 'caller approved' }), /source-hash-invalid/);
  await assert.rejects(guard.inspect({ sourcePath: '../Project.db' }), /source-path-invalid/);
  await assert.rejects(guard.inspect({ sourcePath: sourcePath.replace('Project.db', 'copy.db') }), /source-path-invalid/);
  await assert.rejects(createClosedProjectOfflineGuard({ platform: 'linux' }).inspect({ sourcePath }), /platform-unsupported/);
});
