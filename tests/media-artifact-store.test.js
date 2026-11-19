const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createMediaArtifactStore } = require('../src/media-artifact-store');
const sha = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('derived image fixture')]);
const metadata = { mimeType: 'image/png', width: 640, height: 360, byteLength: png.length, sha256: sha(png), canonical: false };
async function setup(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-artifact-store-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createMediaArtifactStore({ directory }); await store.initialize(); return { directory, store };
}
test('exclusive private noncanonical publication verifies bytes, counts hardlinks once and refuses tampering', async t => {
  const { store } = await setup(t); const stage = await store.stage('thumbnail', 'film'); await fs.writeFile(stage.outputPath, png);
  const artifact = await store.publish(stage, metadata, async () => {});
  assert.equal(await store.measure('film'), png.length); assert.equal(await store.measure('other'), 0);
  await store.discard(stage); const actual = await store.get(artifact); assert.equal(actual.sha256, sha(png));
  assert.equal((await fs.stat(actual.path)).mode & 0o777, 0o600);
  await fs.writeFile(actual.path, 'modified'); await assert.rejects(store.get(artifact), { code: 'artifact-changed' });
});
test('guard failure and unverified output cannot publish and never overwrite an existing cache artifact', async t => {
  const { store } = await setup(t); const stage = await store.stage('thumbnail', 'film'); await fs.writeFile(stage.outputPath, png);
  await assert.rejects(store.publish(stage, { ...metadata, sha256: 'a'.repeat(64) }, async () => {}), { code: 'render-output-changed' });
  await assert.rejects(store.publish(stage, metadata, async () => { throw Object.assign(new Error('revoked'), { code: 'policy-disabled' }); }), { code: 'policy-disabled' });
  await store.discard(stage); assert.equal(await store.measure('film'), 0);
});
test('recovery removes only provably owned staging including marked native partial outputs', async t => {
  const { directory, store } = await setup(t);
  const owned = await store.stage('thumbnail', 'film'); await fs.writeFile(owned.outputPath, 'partial');
  const nativeToken = randomUUID(); const nested = path.join(owned.directory, `.native-media-${nativeToken}`); await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'owner.json'), JSON.stringify({ version: 1, owner: 'frameline-native-media', token: nativeToken }));
  await fs.writeFile(path.join(nested, 'render.png'), 'native partial');
  await fs.link(path.join(nested, 'render.png'), path.join(owned.directory, 'output.mp4'));
  const ambiguous = await store.stage('thumbnail', 'film'); await fs.writeFile(path.join(ambiguous.directory, 'keep.txt'), 'unknown data');
  const unmarked = path.join(directory, 'artifacts', 'staging', randomUUID()); await fs.mkdir(unmarked); await fs.writeFile(path.join(unmarked, 'output.png'), 'unowned');
  assert.equal(await store.measure('film'), 'partialnative partialunknown data'.length);
  await createMediaArtifactStore({ directory }).initialize();
  await assert.rejects(fs.stat(owned.directory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(ambiguous.directory, 'keep.txt'), 'utf8'), 'unknown data');
  assert.equal(await fs.readFile(path.join(unmarked, 'output.png'), 'utf8'), 'unowned');
});
test('cache symlinks and output hardlinks are refused without changing original permissions', async t => {
  const { directory, store } = await setup(t); const original = path.join(directory, 'source.png'); await fs.writeFile(original, png, { mode: 0o644 });
  const stage = await store.stage('thumbnail', 'film'); await fs.link(original, stage.outputPath);
  await assert.rejects(store.publish(stage, metadata, async () => {}), { code: 'invalid-render-output' });
  assert.equal((await fs.stat(original)).mode & 0o777, 0o644); await store.discard(stage);
  const second = await store.stage('thumbnail', 'film'); await fs.symlink(original, second.outputPath);
  await assert.rejects(store.publish(second, metadata, async () => {}), { code: 'symlink-unsupported' });
  await store.discard(second); assert.equal(await fs.readFile(original, 'utf8'), png.toString());
});
