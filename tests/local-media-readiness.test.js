const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { fingerprintFile, inspectAvailability, searchFolderCandidates, verifyCandidate, createReadinessReport } = require('../src/local-media-readiness');

async function fixture(t) {
  // realpath avoids macOS's /var -> /private/var symlink in the test fixture.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-readiness-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'clip.mov');
  await fs.writeFile(file, 'original media');
  const expected = { size: 14, sha256: createHash('sha256').update('original media').digest('hex') };
  return { root, file, expected };
}

test('streamed fingerprints and candidate verification use both size and hash', async t => {
  const { file, expected } = await fixture(t);
  assert.deepEqual(await fingerprintFile(file), expected);
  assert.equal((await verifyCandidate(file, expected)).verified, true);
  assert.equal((await verifyCandidate(file, { ...expected, size: 1 })).reason, 'size-mismatch');
  assert.equal((await verifyCandidate(file, { ...expected, sha256: '0'.repeat(64) })).reason, 'hash-mismatch');
  assert.equal((await verifyCandidate(file)).reason, 'identity-unavailable');
});

test('availability only names special states with explicit evidence', async t => {
  const { root, file } = await fixture(t);
  assert.equal((await inspectAvailability({ path: file })).state, 'local');
  assert.equal((await inspectAvailability({ path: path.join(root, 'absent') })).state, 'missing');
  assert.equal((await inspectAvailability()).state, 'unknown');
  for (const [evidence, state] of [['volumeOffline', 'offline-volume'], ['proxyOnly', 'proxy-only'], ['excluded', 'excluded']]) {
    assert.equal((await inspectAvailability({ evidence: { [evidence]: true } })).state, state);
    assert.equal((await inspectAvailability({ evidence: { [evidence]: 'true' } })).state, 'unknown');
  }
});

test('symlink files and ancestors are not accepted or searched', async t => {
  const { root, file, expected } = await fixture(t);
  const link = path.join(root, 'link.mov');
  await fs.symlink(file, link);
  assert.equal((await inspectAvailability({ path: link })).state, 'unknown');
  await assert.rejects(fingerprintFile(link), { code: 'symlink-unsupported' });
  assert.equal((await verifyCandidate(link, expected)).verified, false);
  const dir = path.join(root, 'folder');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'hidden.mov'), 'x');
  const linkedDir = path.join(root, 'linked');
  await fs.symlink(dir, linkedDir);
  await assert.rejects(searchFolderCandidates(linkedDir, { name: 'hidden.mov' }), { code: 'folder-unreadable' });
  const found = await searchFolderCandidates(root, { name: 'hidden.mov' });
  assert.equal(found.candidates.length, 1);
  assert.equal((await inspectAvailability({ path: path.join(linkedDir, 'hidden.mov') })).state, 'unknown');
});

test('selected-folder search is bounded and filename matches do not verify identity', async t => {
  const { root, file } = await fixture(t);
  const found = await searchFolderCandidates(root, { name: 'clip.mov' });
  assert.deepEqual(found.candidates, [{ path: file }]);
  await fs.mkdir(path.join(root, 'deep'));
  await fs.writeFile(path.join(root, 'deep', 'clip.mov'), 'different');
  const shallow = await searchFolderCandidates(root, { name: 'clip.mov', maxDepth: 0 });
  assert.equal(shallow.candidates.length, 1);
  assert.equal(shallow.truncated, true);
  const bounded = await searchFolderCandidates(root, { name: 'absent', maxEntries: 1 });
  assert.equal(bounded.visited, 1);
  assert.equal(bounded.truncated, true);
  await assert.rejects(searchFolderCandidates(root, { name: '../clip.mov' }), { code: 'invalid-name' });
});

test('required readiness requires original identity and public reports omit paths', async t => {
  const { root, file, expected } = await fixture(t);
  const media = [{ id: 'original', path: file, expected }, { id: 'optional', required: false }];
  const report = await createReadinessReport(media);
  assert.equal(report.ready, true);
  assert.equal(report.requiredCount, 1);
  assert.equal(report.verifiedCount, 1);
  assert.equal(JSON.stringify(report).includes(root), false);
  assert.equal('path' in report.items[0], false);
  assert.equal((await createReadinessReport([{ id: 'unverified', path: file }])).ready, false);
  for (const evidence of [{ proxyOnly: true }, { volumeOffline: true }, { excluded: true }]) {
    assert.equal((await createReadinessReport([{ id: 'required', path: file, expected, evidence }])).ready, false);
  }
  await assert.rejects(createReadinessReport([{ id: file }]), { code: 'invalid-media' });
  await assert.rejects(createReadinessReport([{ id: 'same' }, { id: 'same' }]), { code: 'invalid-media' });
});

test('CLI readiness report omits input paths', async t => {
  const { root, file, expected } = await fixture(t);
  const input = path.join(root, 'media.json');
  await fs.writeFile(input, JSON.stringify([{ id: 'original', path: file, expected }]));
  const script = path.join(__dirname, '../phase-0/check-media-readiness.js');
  const run = spawnSync(process.execPath, [script, input], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).ready, true);
  assert.equal(run.stdout.includes(root), false);
});
