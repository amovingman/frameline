'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { scanXml } = require('../src/fcpxml-adapter');
const { createResolveRevisionManifest } = require('../src/resolve-revision-manifest');
const { MAX_BACKUP_BYTES, BACKUP_PREFIX, inspectBackup, uploadBackup, listBackups, downloadBackup } = require('../src/cloud-backup');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error(code), { code });

async function fixture(t, resolve = false) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'frameline-cloud-core-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalMetadataStore(path.join(directory, 'history'));
  let project, before, after;
  if (resolve) {
    const snapshot = JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-rename-before-schema3.json')));
    project = await store.getResolveProjectId(snapshot.project_id, snapshot.project_name);
    before = createResolveRevisionManifest(snapshot);
    snapshot.timelines[0].items[0].name = 'Changed observation';
    after = createResolveRevisionManifest(snapshot);
  } else {
    project = await store.getProjectId(path.join(directory, 'source.fcpxml'));
    before = scanXml(await fs.readFile(path.join(__dirname, '../phase-0/compatibility-corpus/edit-before.fcpxml'), 'utf8'));
    after = scanXml(await fs.readFile(path.join(__dirname, '../phase-0/compatibility-corpus/edit-after.fcpxml'), 'utf8'));
  }
  const base = await store.saveRevision(project.id, before, 'First cut');
  const second = await store.saveRevision(project.id, after, 'Second cut', base.id);
  await store.createBranch(project.id, 'alternate', second.id);
  const bundle = await store.exportRevisionsReadOnly(project.id);
  const bytes = Buffer.from(JSON.stringify(bundle, null, 2) + '\n');
  const filename = path.join(directory, 'backup.json');
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  const memory = new Map(), calls = [];
  const transport = {
    async put(input) {
      calls.push(['put', input.key]);
      if (memory.has(input.key)) throw error('cloud-backup-exists');
      assert.equal(input.sha256, hash(input.bytes)); memory.set(input.key, Buffer.from(input.bytes)); return { uploaded: true };
    },
    async get(input) { calls.push(['get', input.key]); if (!memory.has(input.key)) throw error('cloud-backup-not-found'); return Buffer.from(memory.get(input.key)); },
    async list(input) { calls.push(['list', input.prefix]); return { items: [...memory].map(([key, value]) => ({ key, size: value.length })), continuationToken: null }; }
  };
  return { directory, filename, bundle, bytes, memory, transport, calls, store, project };
}

async function missing(filename) { await assert.rejects(fs.lstat(filename), { code: 'ENOENT' }); }

test('real exported revisions inspect, upload idempotently, list and download as exact private bytes without importing history', async t => {
  const f = await fixture(t), initialHistory = await fs.readFile(path.join(f.directory, 'history/metadata.json'));
  const summary = await inspectBackup(f.filename);
  assert.deepEqual(summary, { sha256: hash(f.bytes), byteCount: f.bytes.length, revisionCount: 2, branchCount: 2, metadataOnly: true, safeToApply: false });
  const upload = await uploadBackup({ filename: f.filename, expectedSha256: summary.sha256, transport: f.transport });
  assert.equal(upload.uploaded, true); assert.equal(upload.reused, false);
  const retry = await uploadBackup({ filename: f.filename, expectedSha256: summary.sha256, transport: f.transport });
  assert.equal(retry.reused, true); assert.equal(f.memory.size, 1);
  const page = await listBackups({ transport: f.transport });
  assert.deepEqual(page, { backups: [{ sha256: summary.sha256, byteCount: f.bytes.length, lastModified: null }], continuationToken: null });
  const destination = path.join(f.directory, 'download.json');
  assert.equal((await downloadBackup({ sha256: summary.sha256, destination, transport: f.transport })).downloaded, true);
  assert.deepEqual(await fs.readFile(destination), f.bytes);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(destination)).nlink, 1);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'history/metadata.json')), initialHistory);
  assert.deepEqual(await fs.readFile(f.filename), f.bytes);
  assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('.frameline-cloud-')), false);
});

test('Resolve observation bundles use the same backup path and remain importable only by an explicit separate history action', async t => {
  const f = await fixture(t, true), summary = await inspectBackup(f.filename);
  await uploadBackup({ filename: f.filename, expectedSha256: summary.sha256, transport: f.transport });
  const destination = path.join(f.directory, 'resolve-download.json');
  await downloadBackup({ sha256: summary.sha256, destination, transport: f.transport });
  const restored = JSON.parse(await fs.readFile(destination, 'utf8'));
  assert.equal(restored.version, 2);
  const target = createLocalMetadataStore(path.join(f.directory, 'explicit-new-history'));
  const snapshot = JSON.parse(restored.records[0].bytes).manifest.snapshot;
  const project = await target.getResolveProjectId(snapshot.project_id, snapshot.project_name);
  await target.importRevisions(project.id, restored);
  assert.equal((await target.exportRevisions(project.id)).records.length, 2);
});

test('changed reviewed source or cancelled upload cannot contact the transport', async t => {
  const f = await fixture(t), summary = await inspectBackup(f.filename);
  await fs.appendFile(f.filename, '\n');
  await assert.rejects(uploadBackup({ filename: f.filename, expectedSha256: summary.sha256, transport: f.transport }), { code: 'cloud-backup-review-changed' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uploadBackup({ filename: f.filename, expectedSha256: summary.sha256, transport: f.transport, signal: controller.signal }), { code: 'cloud-backup-cancelled' });
  assert.deepEqual(f.calls, []);
});

test('malformed, hidden extra and duplicate JSON fields cannot enter cloud storage', async t => {
  const f = await fixture(t);
  const variants = [
    '{broken',
    JSON.stringify({ ...f.bundle, nativeDatabase: 'hidden payload' }),
    JSON.stringify({ ...f.bundle, records: [{ ...f.bundle.records[0], payload: 'hidden' }] }),
    JSON.stringify({ ...f.bundle, records: f.bundle.records.map(entry => ({ ...entry, summary: { ...entry.summary, secret: 'hidden' } })) }),
    JSON.stringify({ ...f.bundle, records: f.bundle.records.map(entry => ({ ...entry, bytes: JSON.stringify({ ...JSON.parse(entry.bytes), nativeBytes: 'hidden' }) })) }),
    JSON.stringify(f.bundle).replace('"format":', '"format":"hidden","format":'),
    JSON.stringify({ ...f.bundle, records: f.bundle.records.map(entry => ({ ...entry, bytes: entry.bytes.replace('"id":', '"id":"hidden","id":') })) }),
    JSON.stringify({ ...f.bundle, records: [] }),
    JSON.stringify({ ...f.bundle, records: Array(1001).fill(f.bundle.records[0]) }),
    JSON.stringify({ ...f.bundle, version: 77 }),
    JSON.stringify({ ...f.bundle, branches: { main: 'a'.repeat(36) } })
  ];
  for (const bytes of variants) {
    await fs.writeFile(f.filename, bytes);
    await assert.rejects(inspectBackup(f.filename), { code: 'cloud-backup-invalid-bundle' });
  }
  await fs.writeFile(f.filename, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(inspectBackup(f.filename), { code: 'cloud-backup-invalid-bundle' });
  assert.deepEqual(f.calls, []);
});

test('the byte and structural limits reject oversized or deeply nested inputs before transport', async t => {
  const f = await fixture(t);
  const handle = await fs.open(f.filename, 'w'); await handle.truncate(MAX_BACKUP_BYTES + 1); await handle.close();
  await assert.rejects(inspectBackup(f.filename), { code: 'cloud-backup-too-large' });
  await fs.writeFile(f.filename, '['.repeat(49) + '0' + ']'.repeat(49));
  await assert.rejects(inspectBackup(f.filename), { code: 'cloud-backup-too-large' });
});

test('symlink files, aliased parents, hard links and directories are refused as upload sources', async t => {
  const f = await fixture(t), link = path.join(f.directory, 'link.json');
  await fs.symlink(f.filename, link);
  await assert.rejects(inspectBackup(link), { code: 'cloud-backup-invalid-file' });
  const parentLink = path.join(f.directory, 'alias'); await fs.symlink(path.join(f.directory, 'history'), parentLink);
  await assert.rejects(inspectBackup(path.join(parentLink, 'metadata.json')), { code: 'cloud-backup-invalid-file' });
  await assert.rejects(inspectBackup(f.directory), { code: 'cloud-backup-invalid-file' });
  await fs.unlink(link); await fs.link(f.filename, link);
  await assert.rejects(inspectBackup(link), { code: 'cloud-backup-invalid-file' });
  await assert.rejects(inspectBackup('relative.json'), { code: 'cloud-backup-invalid-file' });
  await assert.rejects(inspectBackup(`${f.directory}/line\nbreak.json`), { code: 'cloud-backup-invalid-file' });
  await assert.rejects(inspectBackup(`${f.directory}/${'a'.repeat(4096)}`), { code: 'cloud-backup-invalid-file' });
});

test('a key collision must contain the exact reviewed bundle, while remote failures expose no underlying private details', async t => {
  const f = await fixture(t), summary = await inspectBackup(f.filename), key = `${BACKUP_PREFIX}${summary.sha256}.json`;
  f.memory.set(key, Buffer.from('wrong data'));
  await assert.rejects(uploadBackup({ filename: f.filename, expectedSha256: summary.sha256, transport: f.transport }), { code: 'cloud-backup-integrity' });
  await assert.rejects(uploadBackup({ filename: f.filename, expectedSha256: summary.sha256, transport: {
    put: async () => { throw new Error('AWSSECRET /private/config.json https://private-bucket'); }
  } }), value => value.code === 'cloud-backup-unavailable' && value.message === 'cloud-backup-unavailable' && !value.cause);
});

test('download hash, bundle and transport bounds are checked before any destination is published', async t => {
  const f = await fixture(t), destination = path.join(f.directory, 'download.json'), summary = await inspectBackup(f.filename);
  for (const [bytes, code, sha256] of [
    [Buffer.from('corrupt'), 'cloud-backup-integrity', summary.sha256],
    [Buffer.from('{"not":"a bundle"}'), 'cloud-backup-invalid-bundle', hash('{"not":"a bundle"}')],
    [Buffer.alloc(MAX_BACKUP_BYTES + 1), 'cloud-backup-too-large', summary.sha256],
    ['wrong type', 'cloud-backup-invalid-response', summary.sha256]
  ]) {
    await assert.rejects(downloadBackup({ sha256, destination, transport: { get: async () => bytes } }), { code });
    await missing(destination);
    assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('.frameline-cloud-')), false);
  }
});

test('existing files, symlink destinations and a collision during download are preserved exactly', async t => {
  const f = await fixture(t), summary = await inspectBackup(f.filename), destination = path.join(f.directory, 'download.json');
  await fs.writeFile(destination, 'existing');
  await assert.rejects(downloadBackup({ sha256: summary.sha256, destination, transport: f.transport }), { code: 'cloud-backup-exists' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'existing'); assert.deepEqual(f.calls, []);
  await fs.unlink(destination); await fs.symlink(f.filename, destination);
  await assert.rejects(downloadBackup({ sha256: summary.sha256, destination, transport: f.transport }), { code: 'cloud-backup-exists' });
  await fs.unlink(destination);
  await assert.rejects(downloadBackup({ sha256: summary.sha256, destination, transport: { get: async () => {
    await fs.writeFile(destination, 'concurrent user file'); return f.bytes;
  } } }), { code: 'cloud-backup-exists' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'concurrent user file');
  assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('.frameline-cloud-')), false);
});

test('cancellation after receiving a remote bundle leaves no partial destination or staging file', async t => {
  const f = await fixture(t), summary = await inspectBackup(f.filename), controller = new AbortController();
  const destination = path.join(f.directory, 'cancelled.json');
  await assert.rejects(downloadBackup({ sha256: summary.sha256, destination, signal: controller.signal,
    transport: { get: async () => { controller.abort(); return f.bytes; } } }), { code: 'cloud-backup-cancelled' });
  await missing(destination);
  assert.equal((await fs.readdir(f.directory)).some(name => name.startsWith('.frameline-cloud-')), false);
});

test('list exposes only fixed-prefix content IDs and bounded metadata, including explicit pagination', async () => {
  const sha256 = 'a'.repeat(64), stamp = '2026-11-21T10:00:00.000Z';
  const page = await listBackups({ continuationToken: 'opaque-page', transport: { list: async input => {
    assert.equal(input.prefix, BACKUP_PREFIX); assert.equal(input.continuationToken, 'opaque-page');
    return { items: [{ key: `${BACKUP_PREFIX}${sha256}.json`, size: 42, lastModified: stamp }], continuationToken: 'next-page' };
  } } });
  assert.deepEqual(page, { backups: [{ sha256, byteCount: 42, lastModified: stamp }], continuationToken: 'next-page' });
  for (const invalid of [
    { items: [], continuationToken: '' },
    { items: [], continuationToken: 'control\ncharacter' },
    { items: [], continuationToken: null, secret: 'hidden' },
    { items: [{ key: `another-prefix/${sha256}.json`, size: 42 }], continuationToken: null },
    { items: [{ key: `${BACKUP_PREFIX}invalid.json`, size: 42 }], continuationToken: null },
    { items: [{ key: `${BACKUP_PREFIX}${sha256}.json`, size: MAX_BACKUP_BYTES + 1 }], continuationToken: null },
    { items: Array(101).fill({ key: `${BACKUP_PREFIX}${sha256}.json`, size: 42 }), continuationToken: null },
    { items: [{ key: `${BACKUP_PREFIX}${sha256}.json`, size: 42 }, { key: `${BACKUP_PREFIX}${sha256}.json`, size: 42 }], continuationToken: null }
  ]) await assert.rejects(listBackups({ transport: { list: async () => invalid } }), { code: 'cloud-backup-invalid-response' });
  await assert.rejects(listBackups({ continuationToken: 'same', transport: { list: async () => ({ items: [], continuationToken: 'same' }) } }), { code: 'cloud-backup-invalid-response' });
  await assert.rejects(listBackups({ continuationToken: 'invalid\n', transport: { list: async () => assert.fail('invalid input reached network') } }), { code: 'cloud-backup-invalid-response' });
});

test('invalid content IDs cannot select arbitrary remote paths or create a download', async t => {
  const f = await fixture(t);
  for (const sha256 of ['../escape', 'A'.repeat(64), 'a'.repeat(63), null, {}, 'https://example.com']) {
    await assert.rejects(downloadBackup({ sha256, destination: path.join(f.directory, 'download.json'), transport: f.transport }), { code: 'cloud-backup-invalid-id' });
  }
  assert.deepEqual(f.calls, []);
});
