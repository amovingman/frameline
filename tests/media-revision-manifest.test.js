'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { scanFcpXml } = require('../src/fcpxml-adapter');
const { validateScanManifest } = require('../src/scan-manifest');
const { validateRevisionManifest } = require('../src/revision-manifest');
const { fingerprint } = require('../src/project-api-contracts');
const { createMediaBoundScanManifest, captureMediaBoundScanManifest, captureMediaRevision,
  projectMediaBoundScanManifest } = require('../src/media-revision-manifest');
const sha = value => createHash('sha256').update(value).digest('hex');
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
async function setup(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-revision-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const exportPath = path.join(directory, 'cut.fcpxml');
  const first = path.join(directory, 'first.bin'), second = path.join(directory, 'second.bin');
  await fs.writeFile(first, 'identical original bytes'); await fs.writeFile(second, 'identical original bytes');
  async function write({ urls = [pathToFileURL(first).href, pathToFileURL(second).href], refs = urls.map((_, index) => `a${index}`),
    extra = '', resourceExtra = '', wrapper = false } = {}) {
    const assets = urls.map((url, index) => `<asset id="a${index}" name="source-${index}.bin"><media-rep kind="original-media" src="${escape(url)}"/></asset>`).join('');
    const clips = refs.map((ref, index) => wrapper ? `<clip name="Take ${index + 1}" offset="${index}s" start="0s" duration="1s"><video ref="${ref}"/><adjust-transform position="0 0"/></clip>`
      : `<asset-clip name="Take ${index + 1}" ref="${ref}" offset="${index}s" start="0s" duration="1s"/>`).join('');
    const xml = `<?xml version="1.0"?><!DOCTYPE fcpxml><fcpxml version="1.10"><resources><format id="f" frameDuration="1/24s"/>${assets}${resourceExtra}</resources><library><event><project name="Small fixture"><sequence format="f" duration="${refs.length}s"><spine>${clips}${extra}</spine></sequence></project></event></library></fcpxml>`;
    await fs.writeFile(exportPath, xml); return xml;
  }
  return { directory, exportPath, first, second, write };
}

test('captures exact source and streamed content identities, keeps paths private, and preserves unresolved clip identity', async t => {
  const f = await setup(t); const xml = await f.write(); const scan = await scanFcpXml(f.exportPath);
  const before = structuredClone(scan); const { manifest, sources } = await captureMediaRevision({ exportPath: f.exportPath, manifest: scan });
  assert.equal(manifest.schemaVersion, 3); assert.equal(manifest.sourceHash, sha(xml)); assert.equal(manifest.identityStatus, 'unresolved');
  assert.equal(manifest.mediaDependencies.coverage, 'complete'); assert.equal(manifest.mediaDependencies.assets.length, 2);
  assert.deepEqual(manifest.mediaDependencies.assets.map(item => item.referenceId), ['media-1', 'media-2']);
  assert.equal(manifest.mediaDependencies.assets[0].identity.contentId, `sha256:${sha('identical original bytes')}`);
  assert.equal(manifest.mediaDependencies.assets[0].identity.contentId, manifest.mediaDependencies.assets[1].identity.contentId);
  assert.equal(manifest.mediaDependencies.assets[0].identity.assetClass, 'original');
  assert.deepEqual(scan, before); assert.equal(await fs.readFile(f.exportPath, 'utf8'), xml);
  assert.doesNotMatch(JSON.stringify(manifest), /\/private\/|\/Users\/|sourcePath|media-revision-/);
  assert.deepEqual(sources.map(item => item.sourcePath), [f.first, f.second]); assert.equal(validateRevisionManifest(manifest), manifest);
  assert.deepEqual(projectMediaBoundScanManifest(manifest), scan);
});
test('deduplicates repeated source references and excludes unused resources without using names as identity', async t => {
  const f = await setup(t); await f.write({ refs: ['a0', 'a0'], urls: [pathToFileURL(f.first).href, 'file:///missing-unused.bin'] });
  const manifest = await captureMediaBoundScanManifest({ exportPath: f.exportPath });
  assert.equal(manifest.mediaDependencies.coverage, 'complete'); assert.equal(manifest.mediaDependencies.assets.length, 1);
  assert.equal(manifest.clips.length, 2);
});
test('missing, nonlocal and unresolved original references retain incomplete coverage', async t => {
  const f = await setup(t);
  for (const options of [{ urls: ['file:///missing-original.bin'] }, { urls: ['https://example.invalid/original.bin'] }, { urls: [], refs: ['unresolved'] }, { refs: ['f'] },
    { refs: ['a0'], extra: '<opaque>unmodeled</opaque>' }, { refs: ['a0'], extra: '<audio ref="unresolved"/>' }]) {
    await f.write(options); const manifest = await captureMediaBoundScanManifest({ exportPath: f.exportPath });
    assert.equal(manifest.mediaDependencies.coverage, 'incomplete'); assert.equal(manifest.identityStatus, 'unresolved');
  }
});
test('ordinary Resolve video wrappers and known adjustments can bind declared original media without claiming edit coverage', async t => {
  const f = await setup(t); await f.write({ refs: ['a0'], wrapper: true });
  const manifest = await captureMediaBoundScanManifest({ exportPath: f.exportPath });
  assert.equal(manifest.mediaDependencies.coverage, 'complete'); assert.match(manifest.warnings.join(' '), /Nested clip content/);
  assert.equal(manifest.clips[0].identityStatus, 'unresolved'); assert.equal(manifest.readOnly, true);
});
test('requires the supplied manifest to represent the actual source and refuses media or export mutation during capture', async t => {
  const f = await setup(t); await f.write({ refs: ['a0'] });
  const forged = await scanFcpXml(f.exportPath); forged.clips[0].name = 'Forged';
  await assert.rejects(captureMediaRevision({ exportPath: f.exportPath, manifest: forged }), { code: 'media-revision-manifest-mismatch' });
  let modified = false;
  await assert.rejects(captureMediaRevision({ exportPath: f.exportPath, onProgress: async value => {
    if (value.phase === 'checking' && value.checked === 1 && !modified) { modified = true; await fs.writeFile(f.first, 'changed after initial fingerprint'); }
  } }), { code: 'media-revision-source-changed' });
  await f.write({ refs: ['a0'] }); modified = false;
  await assert.rejects(captureMediaRevision({ exportPath: f.exportPath, onProgress: async value => {
    if (value.phase === 'checking' && value.checked === 1 && !modified) { modified = true; await fs.appendFile(f.exportPath, '\n'); }
  } }), { code: 'stale-export' });
});
test('bundle capture works and symlinked sources never establish complete content bindings', async t => {
  const f = await setup(t); const xml = await f.write({ refs: ['a0'] });
  const bundle = path.join(f.directory, 'cut.fcpxmld'); await fs.mkdir(bundle); await fs.writeFile(path.join(bundle, 'Info.fcpxml'), xml);
  assert.equal((await captureMediaBoundScanManifest({ exportPath: bundle })).mediaDependencies.coverage, 'complete');
  const link = path.join(f.directory, 'link.bin'); await fs.symlink(f.first, link);
  await f.write({ urls: [pathToFileURL(link).href] });
  assert.equal((await captureMediaBoundScanManifest({ exportPath: f.exportPath })).mediaDependencies.coverage, 'incomplete');
});
test('schema3 strictly validates canonical dependencies and binds changed media into the manifest hash', async t => {
  const f = await setup(t); await f.write({ refs: ['a0'] }); const manifest = await captureMediaBoundScanManifest({ exportPath: f.exportPath });
  for (const change of [m => m.mediaDependencies.assets.push(structuredClone(m.mediaDependencies.assets[0])),
    m => { m.mediaDependencies.assets[0].referenceId = 'media-2'; }, m => { m.mediaDependencies.coverage = 'verified'; },
    m => { m.mediaDependencies.assets[0].required = false; }, m => { m.mediaDependencies.assets[0].identity.sourcePath = '/private/source'; },
    m => { m.mediaDependencies.assets[0].identity.algorithm = 'md5'; }, m => { m.mediaDependencies.assets[0].identity.size = -1; }]) {
    const invalid = structuredClone(manifest); change(invalid); assert.throws(() => validateScanManifest(invalid), { code: 'invalid-manifest' });
  }
  await fs.writeFile(f.first, 'new original bytes'); const changed = await captureMediaBoundScanManifest({ exportPath: f.exportPath });
  assert.equal(changed.sourceHash, manifest.sourceHash); assert.notEqual(fingerprint(changed), fingerprint(manifest));
  const projection = projectMediaBoundScanManifest(manifest); assert.equal(projection.schemaVersion, 2); assert.equal('mediaDependencies' in projection, false);
  assert.deepEqual(createMediaBoundScanManifest(projection, manifest.mediaDependencies), manifest);
  for (const patch of [{ assetClass: 'proxy' }, { size: manifest.mediaDependencies.assets[0].identity.size + 1 }, { mediaType: 'video/mp4' }]) {
    const conflicting = structuredClone(manifest), duplicate = structuredClone(conflicting.mediaDependencies.assets[0]);
    duplicate.referenceId = 'media-2'; Object.assign(duplicate.identity, patch); conflicting.mediaDependencies.assets.push(duplicate);
    assert.throws(() => validateScanManifest(conflicting), { code: 'invalid-manifest' });
  }
});
test('capture cancellation stops hashing without returning a complete binding', async t => {
  const f = await setup(t); await f.write(); const controller = new AbortController();
  await assert.rejects(captureMediaRevision({ exportPath: f.exportPath, signal: controller.signal, onProgress: value => {
    if (value.phase === 'hashing') controller.abort();
  } }), error => ['media-job-cancelled', 'media-revision-cancelled'].includes(error.code));
});
