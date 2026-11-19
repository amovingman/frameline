'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { createResolveReviewGuidance, verifyResolveReviewGuidance } = require('../src/resolve-review-guidance');
const { createResolveReviewSession } = require('../src/resolve-review-session');
const { saveResolvePreview, loadResolvePreview } = require('../src/resolve-preview-store');
const { saveResolveReview, loadResolveReview } = require('../src/resolve-review-store');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const error = { code: 'invalid-resolve-review-guidance' };

// Generated with the original modules from commit f7d677a via git show before
// guidance integration. Runtime tests need no Git history or subprocess: these
// exact content-addressed values pin the previous artifact wire format.
const LEGACY = Object.freeze({
  sourceHashes: {
    base: '37dcddbf9590aa423d99ebde5513e35f8ea49bb0169e9f5019e09f8c1ff85c51',
    local: 'e2ebdad930dfa3ee5a7f904d6d0fb89807cf9dd00e9e783aea7c208913fc959b',
    incoming: '13673151b24045e6180241ec49a8ec6fc6be09e76edb7ec6fa28ed3d8966a286'
  },
  planHash: '30379afcdecf3a7360394b4a819ba90477f9b2fb1bb17a8fe77f69035d7e0f06',
  conflictId: '2804850e7d734ce4ece70531f012229bf86141407863da92a634b4eccc5e2fe8',
  auditHash: 'ea002b63ed8dd18e5856a3d4a30528ba02671a8410cb08d50a8504d4cddae8d7',
  previewArtifactId: '1886b7db83cadca6e99e73cf6e19905bdd386397b55fae3410aa6f81f4faf590',
  reviewArtifactId: '06f799be80ff5ec3a84e5ec191cb9c1defeafaab335931212557b1ae84e64b54'
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-guidance-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-mapping-before-schema3.json'));
  const local = JSON.parse(base), incoming = JSON.parse(base);
  local.timelines[0].items[0].name = 'Retained local edit'; incoming.timelines[0].items.shift();
  const sources = { base, local: Buffer.from(JSON.stringify(local)), incoming: Buffer.from(JSON.stringify(incoming)) };
  const plan = createResolvePreviewPlan(sources), review = createResolveConflictReview(plan, sources);
  const decisions = review.conflicts.map(conflict => ({ conflictId: conflict.id, choice: 'keep-local' }));
  return { directory, sources, plan, review, decisions };
}

test('guidance has its own deterministic hash bound to every exact source while canonical identity stays unchanged', async t => {
  const { sources, plan, review, decisions } = await fixture(t);
  const original = Buffer.from(JSON.stringify({ sources, plan, review }));
  const guidance = createResolveReviewGuidance(plan, sources), { guidanceHash, ...body } = guidance;
  assert.equal(guidanceHash, sha(JSON.stringify(canonical(body))));
  assert.deepEqual(guidance.sourceHashes, LEGACY.sourceHashes);
  assert.equal(guidance.readOnly, true); assert.equal(guidance.safeToApply, false);
  assert.equal(guidance.deletionPolicy.conflicts[0].deletedBy, 'incoming');
  assert.equal(guidance.placementPolicy.automaticTimelineOrdering, false);
  assert.deepEqual(verifyResolveReviewGuidance(guidance, plan, sources), { valid: true, readOnly: true, safeToApply: false });
  assert.deepEqual(createResolveReviewGuidance(plan, sources), guidance);
  assert.deepEqual(Buffer.from(JSON.stringify({ sources, plan, review })), original);
  assert.equal(review.planHash, LEGACY.planHash);
  assert.deepEqual(review.conflicts.map(conflict => conflict.id), [LEGACY.conflictId]);
  assert.equal(createResolveDecisionAudit(plan, sources, decisions).auditHash, LEGACY.auditHash);
});

test('tampered meaning, policy, source hashes, or guidance hash cannot verify', async t => {
  const { sources, plan } = await fixture(t), guidance = createResolveReviewGuidance(plan, sources);
  const mutations = [
    value => { value.deletionPolicy.conflicts[0].deletedBy = 'local'; },
    value => { value.deletionPolicy.conflicts[0].consequences['take-incoming'].action = 'retain-edited'; },
    value => { value.placementPolicy.automaticTimelineOrdering = true; },
    value => { value.sourceHashes.local = '0'.repeat(64); },
    value => { value.guidanceHash = '0'.repeat(64); },
    value => { value.safeToApply = true; },
    value => { value.extra = 'unapproved'; }
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(guidance); mutate(altered);
    assert.throws(() => verifyResolveReviewGuidance(altered, plan, sources), error);
  }
  const alteredPlan = structuredClone(plan); alteredPlan.assessment.conflicts[0].status = 'incoming-only';
  assert.throws(() => createResolveReviewGuidance(alteredPlan, sources), error);
  assert.throws(() => createResolveReviewGuidance(null, sources), error);
});

test('format-only source refresh regenerates guidance and clears prior conflict choices', async t => {
  const { directory, sources } = await fixture(t), session = createResolveReviewSession({ artifactDirectory: directory });
  const before = session.load(sources);
  session.setDecision(before.review.conflicts[0].id, 'keep-local');
  const saved = session.saveReview();
  const nextSources = { ...sources, local: Buffer.concat([sources.local, Buffer.from('\n')]) };
  assert.throws(() => verifyResolveReviewGuidance(before.guidance, createResolvePreviewPlan(nextSources), nextSources), error);
  assert.throws(() => createResolveReviewGuidance(createResolvePreviewPlan(sources), nextSources), error);
  const refreshed = session.refresh(nextSources);
  assert.equal(refreshed.status, 'ready');
  assert.deepEqual(refreshed.sourceVerification, { changed: true, staleRoles: ['local'] });
  assert.notEqual(refreshed.guidance.guidanceHash, before.guidance.guidanceHash);
  assert.notEqual(refreshed.guidance.sourceHashes.local, before.guidance.sourceHashes.local);
  assert.deepEqual(refreshed.guidance.deletionPolicy, before.guidance.deletionPolicy);
  assert.deepEqual(refreshed.guidance.placementPolicy, before.guidance.placementPolicy);
  assert.deepEqual(refreshed.decisions, []); assert.equal(refreshed.audit, null);
  assert.equal(refreshed.reviewArtifactId, null);
  assert.equal(session.recoverReview(saved.reviewArtifactId, nextSources).status, 'error');
  assert.equal(session.getState().guidance, null);
});

test('previous preview/review artifact bytes retain their addresses and recover with fresh guidance', async t => {
  const { directory, sources, plan, review, decisions } = await fixture(t);
  const audit = createResolveDecisionAudit(plan, sources, decisions);
  // Recreate the prior persisted formats directly, independently of save code.
  const previewBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, readOnly: true, safeToApply: false, plan }));
  const reviewBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, readOnly: true, safeToApply: false,
    binding: plan.binding, decisions, auditHash: audit.auditHash }));
  assert.equal(sha(previewBytes), LEGACY.previewArtifactId); assert.equal(sha(reviewBytes), LEGACY.reviewArtifactId);
  await fs.writeFile(path.join(directory, `${LEGACY.previewArtifactId}.json`), previewBytes);
  await fs.writeFile(path.join(directory, `review-${LEGACY.reviewArtifactId}.json`), reviewBytes);
  assert.deepEqual(loadResolvePreview(directory, LEGACY.previewArtifactId, sources), plan);
  assert.equal(loadResolveReview(directory, LEGACY.reviewArtifactId, sources).audit.auditHash, LEGACY.auditHash);
  const session = createResolveReviewSession({ artifactDirectory: directory });
  const fromPreview = session.recover(LEGACY.previewArtifactId, sources);
  assert.equal(fromPreview.status, 'ready'); assert(fromPreview.guidance);
  assert.equal(fromPreview.review.planHash, LEGACY.planHash); assert.deepEqual(fromPreview.decisions, []);
  const fromReview = session.recoverReview(LEGACY.reviewArtifactId, sources);
  assert.equal(fromReview.status, 'ready'); assert.deepEqual(fromReview.guidance, fromPreview.guidance);
  assert.equal(fromReview.audit.auditHash, LEGACY.auditHash);
  assert.deepEqual(fromReview.review.conflicts.map(conflict => conflict.id), [LEGACY.conflictId]);
  assert.equal(session.save().artifactId, LEGACY.previewArtifactId);
  assert.equal(session.saveReview().reviewArtifactId, LEGACY.reviewArtifactId);
  assert.equal(saveResolvePreview(directory, sources), LEGACY.previewArtifactId);
  assert.equal(saveResolveReview(directory, sources, decisions), LEGACY.reviewArtifactId);
  assert.deepEqual(createResolveConflictReview(plan, sources), review);
});

test('reopened sessions recompute detached guidance and clear it on source failure or explicit clear', async t => {
  const { directory, sources } = await fixture(t);
  const first = createResolveReviewSession({ artifactDirectory: directory }), loaded = first.load(sources);
  first.setDecision(loaded.review.conflicts[0].id, 'keep-local');
  const saved = first.saveReview();
  const reopened = createResolveReviewSession({ artifactDirectory: directory });
  const restored = reopened.recoverReview(saved.reviewArtifactId, sources);
  assert.deepEqual(restored.guidance, loaded.guidance);
  restored.guidance.deletionPolicy.conflicts[0].deletedBy = 'local';
  restored.guidance.sourceHashes.base = 'changed';
  assert.deepEqual(reopened.getState().guidance, loaded.guidance);
  const wire = JSON.stringify(reopened.getState().guidance);
  assert.doesNotMatch(wire, /\/Users\/|\/private\/|"snapshot"|"resolve_version"|"project_id"|"binding"/);
  assert.equal(Object.hasOwn(reopened.getState(), 'sources'), false);
  const failed = reopened.load({ ...sources, incoming: Buffer.from('{invalid') });
  assert.equal(failed.status, 'error'); assert.equal(failed.guidance, null); assert.equal(failed.plan, null);
  reopened.load(sources); assert.equal(reopened.clear('resolve-source-changed').guidance, null);
});

test('service-history sessions expose verified guidance while still denying editor authority', async t => {
  const { directory, sources } = await fixture(t), session = createResolveReviewSession({ artifactDirectory: directory });
  const state = session.load(sources, { sourceMode: 'service-history' });
  assert.equal(state.status, 'ready'); assert.equal(state.sourceMode, 'service-history');
  assert.equal(state.guidance.deletionPolicy.conflicts[0].requiresExplicitChoice, true);
  const decided = session.setDecision(state.review.conflicts[0].id, 'take-incoming');
  assert.equal(decided.audit.validationStatus, 'review-only');
  assert.throws(() => session.getVerifiedReview(sources), /service-review-read-only/);
  const refreshed = session.refresh(sources);
  assert.equal(refreshed.guidance.guidanceHash, state.guidance.guidanceHash);
  assert.equal(refreshed.decisions.length, 1);
  assert.throws(() => session.getVerifiedReview(sources), /service-review-read-only/);
});
