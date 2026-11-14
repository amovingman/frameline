'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { saveResolveReview, loadResolveReview } = require('../src/resolve-review-store');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview } = require('../src/resolve-review-decisions');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = fs.readFileSync(path.join(__dirname, '../phase-0/resolve-xml-proof/live-mapping-before-schema3.json'), 'utf8');
  const local = JSON.parse(base), incoming = JSON.parse(base);
  local.timelines[0].items[0].start_frame = 10; incoming.timelines[0].items[0].start_frame = 20;
  local.timelines[0].items[0].end_frame = 110; incoming.timelines[0].items[0].end_frame = 120;
  const sources = { base, local: JSON.stringify(local), incoming: JSON.stringify(incoming) };
  const review = createResolveConflictReview(createResolvePreviewPlan(sources), sources);
  return { dir, sources, review };
}
const bad = { code: 'invalid-resolve-review-artifact' };
function forge(dir, artifact) {
  const bytes = Buffer.from(JSON.stringify(artifact));
  const id = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(dir, `review-${id}.json`), bytes);
  return id;
}
test('partial and complete choices round trip with exact sources and no source contents', t => {
  const { dir, sources, review } = fixture(t);
  assert.ok(review.conflicts.length >= 2);
  const choices = review.conflicts.map(({ id }) => ({ conflictId: id, choice: 'keep-local' }));
  for (const decisions of [choices.slice(0, 1), choices]) {
    const id = saveResolveReview(dir, sources, decisions);
    assert.equal(saveResolveReview(dir, sources, decisions), id);
    const loaded = loadResolveReview(dir, id, sources);
    assert.deepEqual(loaded.decisions, [...decisions].sort((a, b) => a.conflictId.localeCompare(b.conflictId, 'en')));
    assert.equal(Boolean(loaded.audit), decisions.length === choices.length);
    assert.equal(fs.readFileSync(path.join(dir, `review-${id}.json`), 'utf8').includes(sources.base), false);
    for (const role of ['base', 'local', 'incoming']) assert.throws(() => loadResolveReview(dir, id, { ...sources, [role]: sources[role] + ' ' }), bad);
  }
});
test('rejects traversal, symlinks, damaged bytes, forged choices and audit', t => {
  const { dir, sources, review } = fixture(t);
  const choices = review.conflicts.map(({ id }) => ({ conflictId: id, choice: 'take-incoming' }));
  const id = saveResolveReview(dir, sources, choices), file = path.join(dir, `review-${id}.json`);
  const artifact = JSON.parse(fs.readFileSync(file));
  assert.throws(() => loadResolveReview(dir, '../outside', sources), bad);
  assert.throws(() => saveResolveReview(dir, sources, [choices[0], choices[0]]), bad);
  const wrong = structuredClone(artifact); wrong.decisions[0].conflictId = 'unknown';
  assert.throws(() => loadResolveReview(dir, forge(dir, wrong), sources), bad);
  const wrongAudit = structuredClone(artifact); wrongAudit.auditHash = '0'.repeat(64);
  assert.throws(() => loadResolveReview(dir, forge(dir, wrongAudit), sources), bad);
  fs.writeFileSync(file, '{}');
  assert.throws(() => loadResolveReview(dir, id, sources), bad);
  assert.throws(() => saveResolveReview(dir, sources, choices), bad);
  fs.unlinkSync(file); fs.symlinkSync(path.join(dir, 'missing'), file);
  assert.throws(() => loadResolveReview(dir, id, sources), bad);
  assert.throws(() => saveResolveReview(dir, sources, choices), bad);
});
