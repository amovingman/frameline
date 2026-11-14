const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { resolveFolderCandidates, sanitizeResolutionReport,
  carryObservedIdentity, createReadinessReport, evaluateMediaRequirements } = require('../src/local-media-readiness');

async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'media-plan-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'); const second = path.join(root, 'second');
  await fs.mkdir(first); await fs.mkdir(second);
  const bytes = Buffer.from('expected camera original');
  await fs.writeFile(path.join(first, 'take.mov'), bytes);
  const expected = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return { root, first, second, expected };
}

test('selected-folder resolution verifies identity and public result omits paths', async t => {
  const { root, expected } = await setup(t);
  const result = await resolveFolderCandidates(root, [{ id: 'media-1', name: 'take.mov', expected }]);
  assert.equal(result.items[0].resolution, 'verified');
  assert.ok(result.items[0].path.endsWith('take.mov'));
  const publicResult = sanitizeResolutionReport(result);
  assert.equal(JSON.stringify(publicResult).includes(root), false);
  assert.deepEqual(publicResult.items[0], { id: 'media-1', candidateCount: 1, verifiedCount: 1,
    resolution: 'verified', search: { visited: 3, truncated: false, unreadable: 0 } });
});

test('duplicate verified candidates remain ambiguous and filename-only matches stay unverified', async t => {
  const { root, second, expected } = await setup(t);
  await fs.writeFile(path.join(second, 'take.mov'), 'expected camera original');
  let result = await resolveFolderCandidates(root, [{ id: 'media-1', name: 'take.mov', expected }]);
  assert.equal(result.items[0].resolution, 'ambiguous');
  result = await resolveFolderCandidates(root, [{ id: 'media-1', name: 'take.mov' }]);
  assert.equal(result.items[0].resolution, 'unverified');
  assert.equal(result.items[0].verifiedCount, 0);
});

test('required media gate blocks unavailable media and records explicit unverified confirmation', async t => {
  const { first, expected } = await setup(t);
  const available = await createReadinessReport([{ id: 'known', path: path.join(first, 'take.mov'), expected },
    { id: 'observed-only', path: path.join(first, 'take.mov') }]);
  assert.equal(evaluateMediaRequirements(available).decision, 'confirmation-required');
  assert.equal(evaluateMediaRequirements(available, { confirmUnverified: true }).decision, 'ready');
  const missing = await createReadinessReport([{ id: 'missing', path: path.join(first, 'absent.mov'), expected }]);
  assert.equal(evaluateMediaRequirements(missing, { confirmUnverified: true }).decision, 'blocked');
});

test('an exact repeated audit can carry prior fingerprint evidence to moved-file search', async t => {
  const { expected } = await setup(t);
  const first = carryObservedIdentity([{ id: 'media-1', displayNames: ['take.mov'], fingerprint: expected }]);
  assert.equal(first[0].identityVerified, false);
  const repeated = carryObservedIdentity([{ id: 'media-1', displayNames: ['take.mov'], fingerprint: expected }], first);
  assert.equal(repeated[0].identityVerified, true);
  const moved = carryObservedIdentity([{ id: 'media-1', displayNames: ['take.mov'], fingerprint: null }], repeated);
  assert.deepEqual(moved[0].expectedFingerprint, expected);
  assert.equal(moved[0].identityVerified, false);
  const renamed = carryObservedIdentity([{ id: 'media-1', displayNames: ['other.mov'], fingerprint: expected }], repeated);
  assert.equal(renamed[0].expectedFingerprint, null);
});
