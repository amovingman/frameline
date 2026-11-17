const test = require('node:test');
const assert = require('node:assert/strict');
const { EXPERIMENTAL_TARGET, assessCompatibility } = require('../src/compatibility-contract');
const { createUploadDisclosure, confirmUploadDisclosure } = require('../src/upload-disclosure');
const { validateScanManifest } = require('../src/scan-manifest');
const { createAdapterMetrics } = require('../src/adapter-metrics');
const { describeRevisionSync } = require('../src/metadata-disclosure');
const { randomUUID, createHash } = require('node:crypto');

test('exact first-editor target is read-only and never a release-support claim', () => {
  const target = { ...EXPERIMENTAL_TARGET, operation: 'scan' };
  assert.equal(assessCompatibility(target).experimentalReadOnly, true);
  assert.equal(assessCompatibility(target).releaseSupported, false);
  assert.equal(assessCompatibility({ ...target, operation: 'apply' }).writeSupported, false);
  assert.equal(assessCompatibility({ ...target, editorVersion: '21.1.3' }).exactTarget, false);
  assert.equal(assessCompatibility({ ...target, editorBuild: '21.1.20011' }).exactTarget, false);
  assert.equal(assessCompatibility({ ...target, os: 'win32' }).exactTarget, false);
});

test('upload review binds exact classes and bytes before consent', () => {
  const estimate = { projectId: 'film', uploadBytes: 8, reusedBytes: 4, excludedBytes: 2,
    items: [
      { id: 'camera', assetClass: 'original', action: 'upload', bytes: 8 },
      { id: 'proxy', assetClass: 'proxy', action: 'excluded-by-policy', bytes: 2 },
      { id: 'audio', assetClass: 'audio', action: 'reuse', bytes: 4 }
    ] };
  const disclosure = createUploadDisclosure(estimate);
  assert.equal(disclosure.mediaBytesIncluded, false);
  assert.equal(disclosure.pathsIncluded, false);
  assert.deepEqual(disclosure.items.map(item => item.id), ['audio', 'camera', 'proxy']);
  assert.throws(() => confirmUploadDisclosure(disclosure, { sha256: disclosure.sha256 }), { code: 'upload-consent-required' });
  assert.equal(confirmUploadDisclosure(disclosure, { sha256: disclosure.sha256, consent: true }).uploadStarted, false);
  assert.throws(() => confirmUploadDisclosure({ ...disclosure, uploadBytes: 9 },
    { sha256: disclosure.sha256, consent: true }), { code: 'upload-disclosure-changed' });
  assert.throws(() => createUploadDisclosure({ ...estimate, uploadBytes: 9 }), { code: 'upload-disclosure-invalid' });
});

test('public scan manifests reject path-like names before metadata sync', () => {
  const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
    sourceHash: 'a'.repeat(64), sequence: { name: 'Film', frameDuration: '1/24s', durationFrames: 24 },
    clips: [{ scanKey: 'position-1', name: 'A', mediaName: 'camera.mov', offsetFrames: 0,
      durationFrames: 24, sourceInFrames: 0, enabled: true, identityStatus: 'unresolved' }],
    media: [{ name: 'camera.mov', availability: 'local' }], warnings: [] };
  assert.equal(validateScanManifest(manifest), manifest);
  assert.throws(() => validateScanManifest({ ...manifest, media: [{ name: '/Users/editor/camera.mov', availability: 'local' }] }),
    { code: 'invalid-manifest' });
  assert.throws(() => validateScanManifest({ ...manifest, clips: [{ ...manifest.clips[0], name: 'C:\\Projects\\cut' }] }),
    { code: 'invalid-manifest' });
  assert.throws(() => validateScanManifest({ ...manifest, sequence: { ...manifest.sequence, name: 'C:private' } }),
    { code: 'invalid-manifest' });
});

test('scan timing percentiles use a bounded recent window', async () => {
  let time = 0, duration = 1;
  const metrics = createAdapterMetrics({ now: () => time });
  const scan = metrics.wrapScan(async () => { time += duration; });
  for (let index = 0; index < 128; index++) await scan('ignored');
  duration = 100;
  await scan('ignored');
  assert.equal(metrics.snapshot().attempts, 129);
  assert.equal(metrics.snapshot().recentSampleCount, 128);
  assert.equal(metrics.snapshot().recentP50Ms, 1);
  assert.equal(metrics.snapshot().recentP95Ms, 1);
});

test('metadata disclosure counts a validated revision without including source bytes or paths', () => {
  const projectId = randomUUID(), revisionId = randomUUID();
  const manifest = { schemaVersion: 2, adapter: 'fcpxml', readOnly: true, identityStatus: 'unresolved',
    sourceHash: 'b'.repeat(64), sequence: { name: 'Film', frameDuration: '1/24s', durationFrames: 24 },
    clips: [], media: [{ name: 'camera.mov', availability: 'local' }], warnings: [] };
  const record = { id: revisionId, projectId, parentRevisionId: null, author: 'Local editor',
    createdAt: new Date(0).toISOString(), message: 'First cut', editorVersion: null,
    manifestVersion: 2, contentHash: manifest.sourceHash, manifest };
  const bytes = `${JSON.stringify(record)}\n`;
  const { manifest: ignored, ...summary } = record;
  summary.recordHash = createHash('sha256').update(bytes).digest('hex');
  const bundle = { format: 'frameline-revisions', version: 1, projectId,
    branches: { main: revisionId }, records: [{ summary, bytes }] };
  const disclosure = describeRevisionSync(bundle);
  assert.equal(disclosure.revisionCount, 1);
  assert.equal(disclosure.mediaReferenceCount, 1);
  assert.equal(disclosure.transferStarted, false);
  assert.doesNotMatch(JSON.stringify(disclosure), /camera\.mov|Local editor|file:\/\//);
  const withMediaPath = bytes.replace('camera.mov', '/Users/editor/camera.mov');
  assert.throws(() => describeRevisionSync({ ...bundle, records: [{ summary: { ...summary,
    recordHash: createHash('sha256').update(withMediaPath).digest('hex') }, bytes: withMediaPath }] }),
    { code: 'revision-transfer-invalid' });
  const withMessagePath = bytes.replace('First cut', '/Users/editor/cut');
  assert.throws(() => describeRevisionSync({ ...bundle, records: [{ summary: { ...summary,
    message: '/Users/editor/cut', recordHash: createHash('sha256').update(withMessagePath).digest('hex') }, bytes: withMessagePath }] }),
    { code: 'revision-transfer-invalid' });
});
