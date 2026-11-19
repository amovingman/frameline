const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readPrivateMediaPreview } = require('../src/private-media-preview');
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-preview-read-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('verified private preview'); const filename = path.join(dir, 'preview.png'); await fs.writeFile(filename, bytes);
  return { dir, bytes, artifact: { path: filename, mimeType: 'image/png', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
test('preview returns only verified bounded image bytes and a noncanonical marker', async t => {
  const f = await fixture(t); const result = await readPrivateMediaPreview(f.artifact, () => f.artifact);
  assert.deepEqual(result, { dataUrl: `data:image/png;base64,${f.bytes.toString('base64')}`, canonical: false });
});
test('oversized replaced preview is refused before any current-scope publication', async t => {
  const f = await fixture(t); const handle = await fs.open(f.artifact.path, 'w'); await handle.truncate(128 * 1024 * 1024); await handle.close();
  let called = false; await assert.rejects(readPrivateMediaPreview(f.artifact, () => { called = true; return f.artifact; })); assert.equal(called, false);
});
test('symlink replacement and same-size corrupt bytes are refused', async t => {
  const f = await fixture(t); const other = path.join(f.dir, 'other.png'); await fs.rename(f.artifact.path, other); await fs.symlink(other, f.artifact.path);
  await assert.rejects(readPrivateMediaPreview(f.artifact, () => f.artifact));
  await fs.unlink(f.artifact.path); await fs.writeFile(f.artifact.path, Buffer.alloc(f.bytes.length));
  await assert.rejects(readPrivateMediaPreview(f.artifact, () => f.artifact), { code: 'media-artifact-unavailable' });
});
test('permission/scope revocation after the read prevents data URL publication', async t => {
  const f = await fixture(t);
  await assert.rejects(readPrivateMediaPreview(f.artifact, () => null), { code: 'media-artifact-unavailable' });
  await assert.rejects(readPrivateMediaPreview(f.artifact, () => ({ ...f.artifact, sha256: '0'.repeat(64) })), { code: 'media-artifact-unavailable' });
});
