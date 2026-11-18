const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { fingerprint } = require('../src/project-api-contracts');
const { createRevisionCache } = require('../src/revision-cache');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-proof-cache-'));
  return { root, directory: path.join(root, 'cache'), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function result(count = 2) {
  const document = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
    sourceHash: 'a'.repeat(64), sequence: { name: 'Timeline', frameDuration: '1/24s', durationFrames: 0 }, clips: [], media: [], warnings: [] };
  const manifestId = `sha256:${fingerprint(document)}`;
  return { schemaVersion: 1, remoteProjectId: 'project-a', branch: 'review', head: count ? `remote-${count}` : null,
    revisions: Array.from({ length: count }, (_, i) => ({ id: `remote-${i + 1}`, projectId: 'project-a', manifestId,
      parentRevisionId: i ? `remote-${i}` : null, authorId: 'original-publisher', message: 'Saved cut', sourceRevisionId: `local-${i + 1}`,
      createdAt: new Date(0).toISOString() })), manifests: count ? [{ id: manifestId, projectId: 'project-a', document,
        createdAt: new Date(0).toISOString() }] : [], mediaFetched: false, checkedAt: 7 };
}
function rawSnapshot(directory, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`), hash = createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(path.join(directory, 'snapshots'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'snapshots', `${hash}.json`), bytes, { mode: 0o600 }); return hash;
}

test('immutable proof remains readable by hash after pointer changes, removal, and fresh reopen', () => {
  const f = fixture(); try {
    const cache = createRevisionCache(f), first = result(1), stored = cache.store(first);
    cache.store(result(2)); assert.equal(cache.read('project-a', 'review').head, 'remote-2');
    fs.rmSync(path.join(f.directory, 'indexes'), { recursive: true });
    const reopened = createRevisionCache(f);
    assert.deepEqual(reopened.readSnapshot(stored.snapshotHash, { projectId: 'project-a', branch: 'review' }), first);
    assert.throws(() => reopened.readSnapshot(stored.snapshotHash, { projectId: 'project-b', branch: 'review' }), { code: 'revision-cache-corrupt' });
    assert.throws(() => reopened.readSnapshot(stored.snapshotHash, { projectId: 'project-a', branch: 'main' }), { code: 'revision-cache-corrupt' });
    assert.throws(() => reopened.read('project-a', 'review'), { code: 'revision-cache-miss' });
  } finally { f.close(); }
});

test('snapshot-only proof publication never creates or advances explicit fetched-history indexes', () => {
  const f = fixture(); try {
    const cache = createRevisionCache(f), first = result(1), next = result(2);
    const proof = cache.storeSnapshot(first);
    assert(!fs.existsSync(path.join(f.directory, 'indexes')));
    assert.throws(() => cache.read('project-a', 'review'), { code: 'revision-cache-miss' });
    assert.deepEqual(cache.readSnapshot(proof.snapshotHash, { projectId: 'project-a', branch: 'review' }), first);
    cache.store(first);
    const indexPath = path.join(f.directory, 'indexes', fs.readdirSync(path.join(f.directory, 'indexes'))[0]);
    const before = fs.readFileSync(indexPath), later = cache.storeSnapshot(next);
    assert.deepEqual(fs.readFileSync(indexPath), before);
    const reopened = createRevisionCache(f);
    assert.deepEqual(reopened.read('project-a', 'review'), first);
    assert.deepEqual(reopened.readSnapshot(later.snapshotHash, { projectId: 'project-a', branch: 'review' }), next);
  } finally { f.close(); }
});

test('snapshot-only publication flush failure latches both publishing APIs without advancing the index', () => {
  const f = fixture(); try {
    createRevisionCache(f).store(result(1)); let linked = false;
    const storage = { ...fs,
      linkSync(...args) { fs.linkSync(...args); linked = true; },
      fsyncSync(fd) { if (linked && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('private'), { code: 'EIO' }); return fs.fsyncSync(fd); }
    };
    const cache = createRevisionCache({ directory: f.directory, storage });
    assert.throws(() => cache.storeSnapshot(result(2)), { code: 'revision-cache-uncertain' });
    assert.throws(() => cache.storeSnapshot(result(1)), { code: 'revision-cache-uncertain' });
    assert.throws(() => cache.store(result(1)), { code: 'revision-cache-uncertain' });
    const reopened = createRevisionCache(f);
    assert.equal(reopened.read('project-a', 'review').head, 'remote-1');
    const snapshotHash = createHash('sha256').update(`${JSON.stringify(result(2))}\n`).digest('hex');
    assert.equal(reopened.readSnapshot(snapshotHash, { projectId: 'project-a', branch: 'review' }).head, 'remote-2');
  } finally { f.close(); }
});

test('store and immutable reads reject structurally invalid or hash-consistent malformed histories', () => {
  const f = fixture(); try {
    const cache = createRevisionCache(f);
    const changes = [
      value => { value.privatePath = '/private/secret'; },
      value => { value.revisions[0].token = 'private'; },
      value => { value.manifests[0].document.sequence.name = 'Altered'; },
      value => { value.manifests[0].document.sequence.durationFrames = -1; value.manifests[0].id = `sha256:${fingerprint(value.manifests[0].document)}`; value.revisions.forEach(r => { r.manifestId = value.manifests[0].id; }); },
      value => { value.revisions[1].parentRevisionId = null; },
      value => { value.revisions[0].parentRevisionId = 'remote-2'; },
      value => { value.head = 'remote-1'; },
      value => { value.revisions[1].sourceRevisionId = value.revisions[0].sourceRevisionId; },
      value => { value.revisions[1].id = value.revisions[0].id; },
      value => { value.revisions[0].projectId = 'project-b'; },
      value => { value.manifests.push(structuredClone(value.manifests[0])); },
      value => { value.manifests[0].createdAt = 'invalid'; },
      value => { value.revisions[0].message = '/private/message'; },
      value => { value.checkedAt = -1; },
      value => { value.revisions = Array.from({ length: 10001 }, () => value.revisions[0]); }
    ];
    for (const change of changes) {
      const value = result(); change(value);
      assert.throws(() => cache.store(value), { code: 'revision-cache-invalid' });
      const hash = rawSnapshot(f.directory, value);
      assert.throws(() => cache.readSnapshot(hash, { projectId: 'project-a', branch: 'review' }), { code: 'revision-cache-corrupt' });
    }
    assert.deepEqual(cache.readSnapshot(cache.store(result(0)).snapshotHash, { projectId: 'project-a', branch: 'review' }), result(0));
  } finally { f.close(); }
});

test('snapshot tamper, symlinks, public permissions and oversized files fail closed', () => {
  const f = fixture(); try {
    const cache = createRevisionCache(f), receipt = cache.store(result());
    const filename = path.join(f.directory, 'snapshots', `${receipt.snapshotHash}.json`);
    fs.appendFileSync(filename, 'tampered');
    assert.throws(() => cache.readSnapshot(receipt.snapshotHash, { projectId: 'project-a', branch: 'review' }), { code: 'revision-cache-corrupt' });
    fs.unlinkSync(filename); fs.symlinkSync(path.join(f.root, 'no-file'), filename);
    assert.throws(() => cache.readSnapshot(receipt.snapshotHash, { projectId: 'project-a', branch: 'review' }), { code: 'revision-cache-corrupt' });
    fs.unlinkSync(filename); fs.writeFileSync(filename, '{}', { mode: 0o644 });
    assert.throws(() => cache.readSnapshot(receipt.snapshotHash, { projectId: 'project-a', branch: 'review' }), { code: 'revision-cache-corrupt' });
    fs.chmodSync(filename, 0o600); fs.truncateSync(filename, 64 * 1024 * 1024 + 1);
    assert.throws(() => cache.readSnapshot(receipt.snapshotHash, { projectId: 'project-a', branch: 'review' }), { code: 'revision-cache-corrupt' });
    assert.throws(() => cache.readSnapshot('../escape', { projectId: 'project-a', branch: 'review' }), { code: 'revision-cache-invalid' });
  } finally { f.close(); }
});

test('each acknowledged snapshot/index and newly created directory is flushed privately', () => {
  const f = fixture(), synced = [], files = new Map();
  const storage = { ...fs,
    openSync(target, ...args) { const fd = fs.openSync(target, ...args); files.set(fd, target); return fd; },
    closeSync(fd) { files.delete(fd); return fs.closeSync(fd); },
    fsyncSync(fd) { synced.push(files.get(fd)); return fs.fsyncSync(fd); }
  };
  try {
    const cache = createRevisionCache({ directory: f.directory, storage }); cache.store(result());
    for (const target of [f.root, f.directory, path.join(f.directory, 'snapshots'), path.join(f.directory, 'indexes')]) assert(synced.includes(target), target);
    assert.equal(synced.filter(target => /\.tmp$/.test(target)).length, 2);
    for (const child of ['snapshots', 'indexes']) {
      const dir = path.join(f.directory, child); assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).mode & 0o777, 0o600);
    }
  } finally { f.close(); }
});

test('prepublication file flush failure preserves old index and allows retry', () => {
  const f = fixture(); try {
    const baseline = createRevisionCache(f); baseline.store(result(1)); let failOnce = true;
    const storage = { ...fs, fsyncSync(fd) {
      if (failOnce && fs.fstatSync(fd).isFile()) { failOnce = false; throw Object.assign(new Error('private details'), { code: 'EIO' }); }
      return fs.fsyncSync(fd);
    } };
    const cache = createRevisionCache({ directory: f.directory, storage });
    assert.throws(() => cache.store(result(2)), { code: 'revision-cache-storage-unavailable' });
    assert.equal(baseline.read('project-a', 'review').head, 'remote-1');
    assert.equal(cache.store(result(2)).head, 'remote-2');
  } finally { f.close(); }
});

test('immutable snapshot reuse flushes the existing file and refuses to replace damaged evidence', () => {
  const f = fixture(); try {
    const baseline = createRevisionCache(f), value = result(), receipt = baseline.store(value);
    const filename = path.join(f.directory, 'snapshots', `${receipt.snapshotHash}.json`), inode = fs.statSync(filename).ino;
    const files = new Map(); let existingSynced = false;
    const storage = { ...fs,
      openSync(target, ...args) { const fd = fs.openSync(target, ...args); files.set(fd, target); return fd; },
      closeSync(fd) { files.delete(fd); return fs.closeSync(fd); },
      fsyncSync(fd) { if (files.get(fd) === filename) existingSynced = true; return fs.fsyncSync(fd); }
    };
    const cache = createRevisionCache({ directory: f.directory, storage });
    assert.equal(cache.store(value).snapshotHash, receipt.snapshotHash); assert(existingSynced);
    assert.equal(fs.statSync(filename).ino, inode);
    fs.appendFileSync(filename, 'damaged'); const damaged = fs.readFileSync(filename);
    assert.throws(() => cache.store(value), { code: 'revision-cache-corrupt' });
    assert.deepEqual(fs.readFileSync(filename), damaged);
    assert.equal(cache.store(result(1)).head, 'remote-1');
  } finally { f.close(); }
});

test('rename that publishes then reports failure latches writes; reopen validates immutable evidence', () => {
  const f = fixture(); try {
    createRevisionCache(f).store(result(1));
    const storage = { ...fs, renameSync(...args) { fs.renameSync(...args); throw Object.assign(new Error('private details'), { code: 'EIO' }); } };
    const cache = createRevisionCache({ directory: f.directory, storage });
    assert.throws(() => cache.store(result(2)), { code: 'revision-cache-uncertain' });
    assert.throws(() => cache.store(result(1)), { code: 'revision-cache-uncertain' });
    assert.equal(createRevisionCache(f).read('project-a', 'review').head, 'remote-2');
  } finally { f.close(); }
});

test('postpublication directory flush failure cannot acknowledge and latches later writes', () => {
  const f = fixture(); try {
    createRevisionCache(f).store(result(1)); let renamed = false;
    const storage = { ...fs,
      renameSync(...args) { fs.renameSync(...args); renamed = true; },
      fsyncSync(fd) { if (renamed && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('private'), { code: 'EIO' }); return fs.fsyncSync(fd); }
    };
    const cache = createRevisionCache({ directory: f.directory, storage });
    assert.throws(() => cache.store(result(2)), { code: 'revision-cache-uncertain' });
    assert.throws(() => cache.store(result(1)), { code: 'revision-cache-uncertain' });
    assert.equal(createRevisionCache(f).read('project-a', 'review').head, 'remote-2');
  } finally { f.close(); }
});
