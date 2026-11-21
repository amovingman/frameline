'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { createClosedProjectOfflineGuard } = require('../src/closed-project-apply-offline-guard');
const { createClosedProjectPublisher } = require('../src/closed-project-apply-publisher');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = Buffer.from('the original project bytes'), candidate = Buffer.from('the changed project bytes');
const info = { CFBundleShortVersionString: '21.1.2', CFBundleVersion: '21.1.20010',
  CFBundleIdentifier: 'com.blackmagic-design.DaVinciResolve', CFBundleExecutable: 'Resolve' };

async function describe(filename) {
  const stat = await fs.stat(filename), bytes = await fs.readFile(filename);
  return { path: filename, sha256: hash(bytes), bytes: bytes.length, dev: stat.dev, ino: stat.ino };
}
async function fixture(t, sourceAttributes = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-publisher-'));
  const root = await fs.realpath(temp);
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'Personal project'), artifacts = path.join(root, 'private');
  await fs.mkdir(parent, { mode: 0o700 }); await fs.mkdir(artifacts, { mode: 0o700 });
  const sourcePath = path.join(parent, 'Project.db');
  await fs.writeFile(sourcePath, original, { mode: 0o644 });
  const artifactPath = path.join(artifacts, 'candidate.db'), backupPath = path.join(artifacts, 'backup.db');
  await fs.writeFile(artifactPath, candidate, { mode: 0o600 });
  await fs.writeFile(backupPath, original, { mode: 0o600 });
  const attrs = new Map([[sourcePath, new Map(Object.entries(sourceAttributes))]]), calls = [];
  let failAttributeWrite = false;
  const execFile = async (file, args) => {
    calls.push({ file, args });
    if (file === '/usr/bin/plutil') return { stdout: JSON.stringify(info), stderr: '' };
    if (file === '/bin/ps') return { stdout: ' 1 Fri Nov 20 09:15:36 2026 /sbin/launchd\n', stderr: '' };
    if (file === '/usr/sbin/lsof') throw Object.assign(new Error('absent'), { code: 1, stdout: '', stderr: '' });
    if (file === '/usr/bin/stat') return { stdout: '0\n', stderr: '' };
    if (file === '/bin/ls') return { stdout: '-rw-r--r--@ 1 owner staff 22 Nov 20 09:15 file\n', stderr: '' };
    assert.equal(file, '/usr/bin/xattr');
    const filename = args[args.length - 1];
    if (!attrs.has(filename)) attrs.set(filename, new Map([['com.apple.provenance', 'aabb']]));
    const values = attrs.get(filename);
    if (args.length === 1) return { stdout: values.size ? [...values.keys()].join('\n') + '\n' : '', stderr: '' };
    if (args[0] === '-px') return { stdout: values.get(args[1]) + '\n', stderr: '' };
    if (failAttributeWrite) throw new Error('attribute mutation denied');
    if (args[0] === '-d') values.delete(args[1]);
    else if (args[0] === '-wx') values.set(args[1], args[2]);
    else assert.fail(`Unexpected xattr call: ${args}`);
    return { stdout: '', stderr: '' };
  };
  const guard = createClosedProjectOfflineGuard({ execFile, platform: 'darwin' });
  const publisher = createClosedProjectPublisher({ execFile, offlineGuard: guard });
  const options = { plan: { planId: 'a'.repeat(64) }, expectedSource: await describe(sourcePath),
    artifact: await describe(artifactPath), direction: 'apply', transactionId: randomUUID(), sourcePath };
  return { root, parent, sourcePath, artifactPath, backupPath, options, guard, publisher, calls, attrs,
    denyAttributeWrite: () => { failAttributeWrite = true; } };
}

test('publication atomically replaces expected source, preserves bytes elsewhere and exact file metadata', async t => {
  const f = await fixture(t, { 'user.opaque': '00ff80', 'user.empty': '' });
  const before = await fs.stat(f.sourcePath);
  const receipt = await f.publisher.publish(f.options);
  assert.deepEqual(await fs.readFile(f.sourcePath), candidate);
  assert.deepEqual(await fs.readFile(f.backupPath), original);
  assert.deepEqual(await fs.readFile(f.artifactPath), candidate);
  assert.deepEqual(await fs.readdir(f.parent), ['Project.db']);
  const after = await fs.stat(f.sourcePath);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o7777, before.mode & 0o7777);
  assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid);
  assert.equal(receipt.sourceSha256, hash(candidate));
  assert.equal(receipt.metadataPreserved, true);
  assert.equal(receipt.editorOfflineRechecked, true);
  assert.equal(receipt.concurrentWriterResistanceProven, false);
  assert.equal(receipt.applicationSourceLockProvidedByTrustedCaller, true);
  const mutations = f.calls.filter(call => call.file === '/usr/bin/xattr' && ['-wx', '-d'].includes(call.args[0]));
  assert.ok(mutations.some(call => call.args[0] === '-d' && call.args[1] === 'com.apple.provenance'));
  assert.ok(mutations.some(call => call.args[0] === '-wx' && call.args[1] === 'user.opaque'));
  assert.ok(mutations.every(call => call.args.at(-1) !== f.sourcePath && call.args.at(-1).endsWith('.stage')));
});

test('guarded reverse publication restores exact backup while retaining changed candidate', async t => {
  const f = await fixture(t);
  await f.publisher.publish(f.options);
  const receipt = await f.publisher.publish({ ...f.options, expectedSource: await describe(f.sourcePath),
    artifact: await describe(f.backupPath), direction: 'rollback' });
  assert.equal(receipt.direction, 'rollback');
  assert.deepEqual(await fs.readFile(f.sourcePath), original);
  assert.deepEqual(await fs.readFile(f.artifactPath), candidate);
  assert.deepEqual(await fs.readdir(f.parent), ['Project.db']);
});

test('changed bytes or replaced source identity blocks before publication', async t => {
  const f = await fixture(t);
  await assert.rejects(f.publisher.publish({ ...f.options, expectedSource: { ...f.options.expectedSource, ino: 1 } }), /source-stale/);
  await fs.writeFile(f.sourcePath, 'newer owner changes');
  await assert.rejects(f.publisher.publish(f.options), /source-hash-stale/);
  assert.equal(await fs.readFile(f.sourcePath, 'utf8'), 'newer owner changes');
  assert.deepEqual(await fs.readdir(f.parent), ['Project.db']);
});

test('metadata differing from authenticated preparation is refused before staging', async t => {
  const f = await fixture(t), observation = await f.guard.inspect({ sourcePath: f.sourcePath });
  await fs.chmod(f.sourcePath, 0o600);
  await assert.rejects(f.publisher.publish({ ...f.options, originalMetadata: observation.metadata }), /original-metadata-changed/);
  assert.deepEqual(await fs.readFile(f.sourcePath), original);
  assert.deepEqual(await fs.readdir(f.parent), ['Project.db']);
});

test('source divergence during stage preparation is retained, stage cleaned and no rename performed', async t => {
  const f = await fixture(t);
  const guard = { ...f.guard, inspect: async options => {
    if (options.stage) await fs.writeFile(f.sourcePath, 'intervening owner work');
    return f.guard.inspect(options);
  } };
  await assert.rejects(f.publisher.publish({ ...f.options, offlineGuard: guard }), error => {
    assert.equal(error.publicationMayHaveOccurred, false); return /source-hash-stale/.test(error.message);
  });
  assert.equal(await fs.readFile(f.sourcePath, 'utf8'), 'intervening owner work');
  assert.deepEqual(await fs.readdir(f.parent), ['Project.db']);
});

test('failure to reproduce stage attributes leaves the original untouched', async t => {
  const f = await fixture(t, { 'user.required': '00ff' });
  f.denyAttributeWrite();
  await assert.rejects(f.publisher.publish(f.options), error => {
    assert.equal(error.publicationMayHaveOccurred, false); return true;
  });
  assert.deepEqual(await fs.readFile(f.sourcePath), original);
  assert.deepEqual(await fs.readdir(f.parent), ['Project.db']);
});

test('post-rename validation failure is uncertain publication and never blindly restores original', async t => {
  const f = await fixture(t);
  let count = 0;
  const guard = { ...f.guard, inspect: async options => {
    if (++count === 3) throw new Error('Resolve started after rename');
    return f.guard.inspect(options);
  } };
  await assert.rejects(f.publisher.publish({ ...f.options, offlineGuard: guard }), error => {
    assert.equal(error.publicationMayHaveOccurred, true); return true;
  });
  assert.deepEqual(await fs.readFile(f.sourcePath), candidate);
  assert.deepEqual(await fs.readFile(f.backupPath), original);
  assert.deepEqual(await fs.readdir(f.parent), ['Project.db']);
});

test('tampered private artifact or artifact symlink is refused without modifying source', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.artifactPath, 'tampered bytes');
  await assert.rejects(f.publisher.publish(f.options), /artifact-unsafe|artifact-changed/);
  await fs.unlink(f.artifactPath);
  await fs.symlink(f.backupPath, f.artifactPath);
  await assert.rejects(f.publisher.publish(f.options), /artifact-noncanonical/);
  assert.deepEqual(await fs.readFile(f.sourcePath), original);
});

test('only an exact known stage is accepted by the final offline recheck', async t => {
  const f = await fixture(t), stagePath = path.join(f.parent, `.frameline-apply-${'f'.repeat(32)}.stage`);
  await fs.writeFile(stagePath, candidate, { mode: 0o600 });
  const stat = await fs.stat(stagePath);
  const stage = { path: stagePath, device: String(stat.dev), inode: String(stat.ino), sha256: hash(candidate), size: candidate.length };
  const observed = await f.guard.inspect({ sourcePath: f.sourcePath, stage });
  assert.equal(observed.sha256, hash(original));
  await assert.rejects(f.guard.inspect({ sourcePath: f.sourcePath }), /source-directory-not-single-file/);
  await assert.rejects(f.guard.inspect({ sourcePath: f.sourcePath, stage: { ...stage, inode: '1' } }), /stage-changed/);
  await assert.rejects(f.guard.inspect({ sourcePath: f.sourcePath, stage: { ...stage, sha256: '0'.repeat(64) } }), /stage-changed/);
  await fs.writeFile(path.join(f.parent, 'Project.db-wal'), 'unexpected');
  await assert.rejects(f.guard.inspect({ sourcePath: f.sourcePath, stage }), /source-directory-not-single-file/);
});
