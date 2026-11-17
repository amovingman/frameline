const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, sign } = require('node:crypto');
const { createFirstRun } = require('../src/first-run');
const { createDiagnosticsReport } = require('../src/diagnostics-report');
const { createRecoveryJournal } = require('../src/recovery-journal');
const { verifyInstallerEvidence, verifyUpdateManifest } = require('../src/release-gates');
const { visibleRange } = require('../src/windowed-list');

test('first-run choices persist without storing project paths', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'first-run-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const onboarding = createFirstRun({ directory });
  assert.equal((await onboarding.read()).completed, false);
  await onboarding.save({ editor: 'resolve-free-21.1.2', workspaceName: 'Cut room' });
  assert.equal((await createFirstRun({ directory }).read()).workspaceName, 'Cut room');
  await assert.rejects(onboarding.save({ editor: 'unknown', workspaceName: 'Cut room' }));
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'first-run.json'), 'utf8'), /fcpxml|\/Users/);
});

test('diagnostic report exposes counts and codes while excluding paths and media names', () => {
  const result = createDiagnosticsReport({ appVersion: '0.1.0',
    state: { selectedProject: { format: 'FCPXML', path: '/private/secret.fcpxml' }, scanStatus: 'error',
      error: '/private/secret.fcpxml', scan: { clips: [{ name: 'private take' }], media: [{ name: 'private media' }] }, revisions: [{}] },
    syncState: { connected: false, operations: [{ path: '/private/sync' }] } });
  assert.equal(result.report.pictureClipCount, 1);
  assert.equal(result.report.scanErrorCode, null);
  assert.doesNotMatch(result.bytes.toString(), /private|take|\/Users/);
});

test('windowed list bounds DOM rows for a large history', () => {
  assert.deepEqual(visibleRange(10000, 9600, 600, 96), { start: 96, end: 111, beforePx: 9216, afterPx: 949344 });
  assert.throws(() => visibleRange(10, -1, 400, 96));
});

test('recovery journal keeps only opaque restart instructions', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = createRecoveryJournal({ directory });
  const scan = await journal.begin({ type: 'scan', projectId: 'film' });
  const upload = await journal.begin({ type: 'upload', projectId: 'film', transferId: 'transfer-1' });
  const apply = await journal.begin({ type: 'apply', projectId: 'film' });
  assert.deepEqual((await createRecoveryJournal({ directory }).pending()).map(item => item.nextAction),
    ['reselect-and-rescan', 'resume-verified-chunks', 'manual-restore-required']);
  await journal.finish(scan.id, 'completed'); await journal.finish(upload.id, 'failed');
  assert.equal((await journal.pending()).length, 1);
  assert.equal((await journal.pending())[0].id, apply.id);
});

test('installer evidence and signed staged updates fail closed', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(verifyInstallerEvidence({ platform: 'darwin', sha256: sha, signed: true,
    notarized: true, teamId: 'TEAM123' }, { platform: 'darwin', teamId: 'TEAM123' }).releaseReady, true);
  assert.throws(() => verifyInstallerEvidence({ platform: 'darwin', sha256: sha, signed: true,
    notarized: false, teamId: 'TEAM123' }, { platform: 'darwin', teamId: 'TEAM123' }), { code: 'release-artifact-untrusted' });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = { schemaVersion: 1, version: '0.2.0', channel: 'stable', rolloutPercent: 100,
    url: 'https://example.test/Frameline.dmg', sha256: sha };
  const signature = sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString('base64');
  assert.equal(verifyUpdateManifest({ manifest, signature, publicKey, currentVersion: '0.1.0', installId: 'installation-1' }).eligible, true);
  assert.equal(verifyUpdateManifest({ manifest, signature, publicKey, currentVersion: '0.3.0', installId: 'installation-1' }).eligible, false);
  assert.throws(() => verifyUpdateManifest({ manifest: { ...manifest, url: 'http://example.test/file' }, signature,
    publicKey, currentVersion: '0.1.0', installId: 'installation-1' }), { code: 'update-signature-invalid' });
  const invalidUrl = { ...manifest, url: 'not a URL' };
  const invalidUrlSignature = sign(null, Buffer.from(JSON.stringify(invalidUrl)), privateKey).toString('base64');
  assert.throws(() => verifyUpdateManifest({ manifest: invalidUrl, signature: invalidUrlSignature,
    publicKey, currentVersion: '0.1.0', installId: 'installation-1' }), { code: 'update-manifest-invalid' });
});
