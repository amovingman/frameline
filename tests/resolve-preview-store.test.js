'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { saveResolvePreview, loadResolvePreview, MAX_ARTIFACT_BYTES } = require('../src/resolve-preview-store');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const proof = path.join(__dirname, '../phase-0/resolve-xml-proof');
const read = name => fs.readFileSync(path.join(proof, name));
const sources = () => ({ base: read('live-mapping-before-schema3.json'), local: read('live-mapping-before-schema3.json'), incoming: read('live-mapping-after-schema3.json') });
const invalid = { code: 'invalid-resolve-preview-artifact' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('persists and recovers a deterministic read-only preview bound to exact sources', t => {
  const dir = fixture(t); const input = sources();
  const id = saveResolvePreview(dir, input);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(saveResolvePreview(dir, input), id);
  assert.deepEqual(loadResolvePreview(dir, id, input), createResolvePreviewPlan(input));
  assert.deepEqual(fs.readdirSync(dir), [`${id}.json`]);
  assert.throws(() => loadResolvePreview(dir, id, { ...input, local: Buffer.concat([input.local, Buffer.from(' ')]) }), invalid);
  assert.throws(() => loadResolvePreview(dir, '../outside', input), invalid);
});
test('rejects corrupted content, forged plans, oversized files and symlinks', t => {
  const dir = fixture(t); const input = sources(); const id = saveResolvePreview(dir, input);
  const filename = path.join(dir, `${id}.json`); const original = fs.readFileSync(filename);
  fs.writeFileSync(filename, '{');
  assert.throws(() => loadResolvePreview(dir, id, input), invalid);
  assert.throws(() => saveResolvePreview(dir, input), invalid);
  const artifact = JSON.parse(original); artifact.plan.assessment.counts.conflicts = 999;
  const forged = Buffer.from(JSON.stringify(artifact)); const forgedId = createHash('sha256').update(forged).digest('hex');
  fs.writeFileSync(path.join(dir, `${forgedId}.json`), forged);
  assert.throws(() => loadResolvePreview(dir, forgedId, input), invalid);
  fs.truncateSync(filename, MAX_ARTIFACT_BYTES + 1);
  assert.throws(() => loadResolvePreview(dir, id, input), invalid);
  fs.unlinkSync(filename); fs.symlinkSync(path.join(dir, `${forgedId}.json`), filename);
  assert.throws(() => loadResolvePreview(dir, id, input), invalid);
});
