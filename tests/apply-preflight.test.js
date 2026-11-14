'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveDecisionAudit, createResolveConflictReview } = require('../src/resolve-review-decisions');
const { createRestorePoint } = require('../src/resolve-restore-point');
const { fcpxmlProjectAdapter } = require('../src/project-adapter');
const { checkApplyPreflight } = require('../src/apply-preflight');

async function fixture(t, conflict = false) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'apply-preflight-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const base = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-mapping-before-schema3.json'), 'utf8');
  const local = JSON.parse(base), incoming = JSON.parse(base);
  if (conflict) { local.timelines[0].items[0].start_frame = 10; incoming.timelines[0].items[0].start_frame = 20; }
  const sources = { base, local: JSON.stringify(local), incoming: JSON.stringify(incoming) };
  const plan = createResolvePreviewPlan(sources);
  const review = createResolveConflictReview(plan, sources);
  const audit = createResolveDecisionAudit(plan, sources, review.conflicts.map(({ id }) => ({ conflictId: id, choice: 'keep-local' })));
  const sourcePath = path.join(dir, 'project');
  await fs.writeFile(sourcePath, 'project bytes');
  const expectedSourceHash = createHash('sha256').update('project bytes').digest('hex');
  const restorePoint = await createRestorePoint({ sourcePath, destinationDir: dir, expectedHash: expectedSourceHash });
  const noop = async () => {};
  const adapter = { id: 'future', capabilities: { readOnly: false, stableIds: true, apply: true, editorValidation: true },
    scan: noop, verifySource: noop, mapStableIds: noop, apply: noop, save: noop, validate: noop };
  return { plan, sources, audit, sourcePath, expectedSourceHash, restorePoint, adapter };
}
const codes = result => result.blockers.map(b => b.code);

test('diagnostics never authorize a write, including when every check passes', async t => {
  const input = await fixture(t);
  const result = await checkApplyPreflight(input);
  assert.deepEqual(codes(result), ['project-plan-binding-unverified']);
  assert.equal(result.safeToApply, false);
  assert.equal(result.readOnly, true);
  assert.equal(await fs.readFile(input.sourcePath, 'utf8'), 'project bytes');
});

test('current adapter fails closed and missing source and restore are reported', async t => {
  const input = await fixture(t);
  const result = await checkApplyPreflight({ ...input, adapter: fcpxmlProjectAdapter, sourcePath: 'missing' });
  assert.deepEqual(codes(result), ['project-plan-binding-unverified', 'source-hash-invalid', 'adapter-capabilities-unavailable', 'restore-point-invalid']);
});

test('stale plan and tampered audit fail closed', async t => {
  const input = await fixture(t, true);
  assert.ok(codes(await checkApplyPreflight({ ...input, sources: { ...input.sources, local: input.sources.local + ' ' } })).includes('plan-source-binding-invalid'));
  const audit = structuredClone(input.audit); audit.choices = [];
  const result = await checkApplyPreflight({ ...input, audit });
  assert.ok(codes(result).includes('conflict-audit-invalid'));
  assert.ok(codes(result).includes('media-readiness-unverified'));
});

test('changed source, damaged backup and same-file backup are rejected', async t => {
  const input = await fixture(t);
  await fs.writeFile(input.restorePoint.restorePointPath, 'damaged');
  assert.ok(codes(await checkApplyPreflight(input)).includes('restore-point-invalid'));
  assert.ok(codes(await checkApplyPreflight({ ...input, restorePoint: { ...input.restorePoint, restorePointPath: input.sourcePath } })).includes('restore-point-invalid'));
  await fs.writeFile(input.sourcePath, 'changed');
  assert.ok(codes(await checkApplyPreflight(input)).includes('source-hash-invalid'));
});
