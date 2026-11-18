'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createResolvePreviewPlan, verifyResolvePreviewPlan, refreshResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { createResolveConflictReview, createResolveDecisionAudit } = require('../src/resolve-review-decisions');
const { createResolveReviewSession } = require('../src/resolve-review-session');
const { resolveReviewedRename } = require('../src/resolve-rename-review');
const { riskSnapshotFiles } = require('../phase-0/review-free-merge');
const { previewSnapshotFiles, verifyPreviewFile } = require('../phase-0/preview-free-merge');
const { saveResolvePreview } = require('../src/resolve-preview-store');
const { saveResolveReview } = require('../src/resolve-review-store');
const rich = async () => JSON.parse(await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-enabled.json')));
const sources = (...values) => Object.fromEntries(['base', 'local', 'incoming'].map((role, index) => [role, JSON.stringify(values[index])]));
const pan = (value, decimal) => { value.items[0].properties.Pan.decimal = decimal; return value; };
const zero = '0.0000000000000000e+00', thirteen = '1.3250000000000000e+01', twentySix = '2.6500000000000000e+01';

test('richer preview classifies property-only changes across all four three-way cases', async () => {
  for (const [localValue, incomingValue, status] of [[zero, thirteen, 'incoming-only'], [thirteen, zero, 'local-only'],
    [thirteen, thirteen, 'already-applied'], [thirteen, twentySix, 'conflict']]) {
    const base = await rich(), local = pan(structuredClone(base), localValue), incoming = pan(structuredClone(base), incomingValue);
    const input = sources(base, local, incoming), plan = createResolvePreviewPlan(input);
    assert.equal(plan.schemaVersion, 2); assert.equal(plan.safeToApply, false);
    assert.equal(plan.classification.decisions.length, 1);
    const decision = plan.classification.decisions[0];
    assert.equal(decision.field, 'properties.Pan'); assert.equal(decision.status, status);
    assert.equal(decision.context.itemName, 'mountain-alps.jpg'); assert.equal(decision.context.track, 'V1');
    assert.equal(plan.classification.observationCoverage.gaps.length, 0);
    assert.equal(verifyResolvePreviewPlan(plan, input).valid, true);
  }
});

test('property-only source changes invalidate bindings and clear saved review decisions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rich-preview-review-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = await rich(), local = pan(structuredClone(base), thirteen), incoming = pan(structuredClone(base), twentySix);
  const input = sources(base, local, incoming), session = createResolveReviewSession({ artifactDirectory: directory });
  const state = session.load(input), conflict = state.review.conflicts[0];
  assert.equal(session.setDecision(conflict.id, 'keep-local').audit.choices[0].selectedValue.decimal, thirteen);
  const saved = session.saveReview(); assert(saved.reviewArtifactId);
  const reopened = createResolveReviewSession({ artifactDirectory: directory });
  assert.equal(reopened.recoverReview(saved.reviewArtifactId, input).decisions.length, 1);
  const updated = sources(base, pan(structuredClone(local), twentySix), incoming);
  const refreshed = session.refresh(updated);
  assert.deepEqual(refreshed.sourceVerification.staleRoles, ['local']); assert.deepEqual(refreshed.decisions, []);
  assert.equal(reopened.recoverReview(saved.reviewArtifactId, updated).status, 'error');
  const plan = createResolvePreviewPlan(input);
  assert.equal(refreshResolvePreviewPlan(plan, updated).refreshed, true);
  const altered = structuredClone(plan); altered.classification.decisions[0].local.decimal = zero;
  assert.throws(() => verifyResolvePreviewPlan(altered, input));
});

test('missing, unavailable or absent property keys remain coverage gaps instead of zero or unchanged values', async () => {
  const base = await rich(), local = pan(structuredClone(base), thirteen), incoming = structuredClone(base);
  for (const before of [base.snapshot, (() => { const v = structuredClone(base); delete v.items[0].properties.Pan; return v; })(),
    (() => { const v = structuredClone(base); v.items[0].propertyReadStatus = 'unavailable'; v.items[0].properties = {}; return v; })()]) {
    const plan = createResolvePreviewPlan(sources(before, local, incoming));
    assert(!plan.classification.decisions.some(d => d.field === 'properties.Pan'));
    const gap = plan.classification.observationCoverage.gaps.find(g => g.field === 'properties.Pan' && g.itemId === base.items[0].itemId);
    assert.equal(gap.base.observed, false); assert.equal(gap.local.value.decimal, thirteen);
    assert.equal(gap.incoming.value.decimal, zero);
    assert(plan.assessment.warnings.some(w => w.code === 'observation-coverage' && w.count > 0));
    assert.equal(plan.classification.observationCoverage.capturedContextDiffers, false);
  }
});

test('only known active-timeline observations establish a capture-context difference', async () => {
  const base = await rich(), incoming = structuredClone(base);
  incoming.activeTimelineId = null;
  incoming.items.forEach(item => { item.propertyReadStatus = 'unavailable'; item.properties = {}; });
  const plan = createResolvePreviewPlan(sources(base, base, incoming));
  assert.equal(plan.classification.observationCoverage.capturedContextDiffers, true);
  assert(plan.assessment.warnings.some(w => w.code === 'capture-context-difference'));
});

test('effect slots and indexed track state participate in read-only classification with explicit warnings', async () => {
  const base = await rich(), incoming = structuredClone(base);
  incoming.items[0].effects[0].enabled = false; incoming.tracks[0].locked = true;
  const plan = createResolvePreviewPlan(sources(base, base, incoming));
  assert.deepEqual(plan.classification.decisions.map(d => d.field).sort(), ['effectSlots.ofx.1', 'trackState.video.1.locked']);
  assert(plan.classification.decisions.every(d => d.status === 'incoming-only'));
  assert(plan.assessment.warnings.some(w => w.code === 'effect-slot-change'));
  assert(plan.assessment.warnings.some(w => w.code === 'track-state-change'));
  assert.equal(plan.conflictRules.provenSafeApplyProperties.length, 0);
});

test('incoming item or timeline deletion conflicts with a local inspector edit', async () => {
  const base = await rich(), local = pan(structuredClone(base), thirteen);
  for (const wholeTimeline of [false, true]) {
    const incoming = structuredClone(base);
    if (wholeTimeline) { incoming.snapshot.timelines = []; incoming.items = []; incoming.tracks = []; incoming.activeTimelineId = null; }
    else { incoming.snapshot.timelines[0].items.shift(); incoming.items.shift(); }
    const plan = createResolvePreviewPlan(sources(base, local, incoming));
    const conflict = plan.assessment.conflicts.find(d => d.field === 'existence');
    assert(conflict); assert.equal(conflict.incoming, null);
    const item = wholeTimeline ? conflict.local.items.find(i => i.id === base.items[0].itemId) : conflict.local;
    assert.equal(item.observations.properties.Pan.decimal, thirteen);
  }
});

test('richer review choices never enter the existing rename mutation experiment', async () => {
  const base = await rich(), input = sources(base, pan(structuredClone(base), thirteen), pan(structuredClone(base), twentySix));
  const plan = createResolvePreviewPlan(input), review = createResolveConflictReview(plan, input);
  const audit = createResolveDecisionAudit(plan, input, review.conflicts.map(c => ({ conflictId: c.id, choice: 'take-incoming' })));
  assert.equal(audit.choices[0].selectedValue.decimal, twentySix);
  assert.throws(() => resolveReviewedRename({ sources: input, plan, audit }), /rich-preview-review-only/);
});

test('track deletion retains a local lock edit in the collection conflict', async () => {
  const base = await rich(), local = structuredClone(base), incoming = structuredClone(base);
  local.tracks.find(t => t.type === 'video').locked = true;
  const removed = new Set(incoming.snapshot.timelines[0].items.filter(i => i.track_type === 'video').map(i => i.id));
  incoming.snapshot.timelines[0].tracks = incoming.snapshot.timelines[0].tracks.filter(t => t.type !== 'video');
  incoming.snapshot.timelines[0].items = incoming.snapshot.timelines[0].items.filter(i => !removed.has(i.id));
  for (const item of incoming.snapshot.timelines[0].items) item.linked_item_ids = item.linked_item_ids.filter(id => !removed.has(id));
  incoming.items = incoming.items.filter(i => !removed.has(i.itemId)); incoming.tracks = incoming.tracks.filter(t => t.type !== 'video');
  const plan = createResolvePreviewPlan(sources(base, local, incoming));
  const tracks = plan.assessment.conflicts.find(d => d.field === 'tracks');
  assert(tracks); assert.equal(tracks.local.find(t => t.type === 'video').observations.locked.value, true);
  assert(!plan.classification.decisions.some(d => d.field.startsWith('trackState.')));
});

test('preview sources reject malformed richer fields and invalid UTF-8 bytes', async () => {
  const base = await rich(), altered = structuredClone(base); altered.items[0].properties.Undocumented = true;
  assert.throws(() => createResolvePreviewPlan(sources(base, base, altered)), { code: 'invalid-resolve-preview' });
  const input = sources(base, base, base); input.local = Buffer.concat([Buffer.from(input.local.slice(0, -1)), Buffer.from([0xff]), Buffer.from('}')]);
  assert.throws(() => createResolvePreviewPlan(input), { code: 'invalid-resolve-preview' });
});

test('equivalent decimal spellings and enumeration do not create richer preview edits', async () => {
  const base = await rich(), local = structuredClone(base), incoming = structuredClone(base);
  local.items[0].properties.Pan.decimal = '-0.0000000000000000e+00';
  incoming.items[0].properties.ZoomX.decimal = '0.1000000000000000e+01';
  incoming.items.reverse(); incoming.tracks.reverse(); incoming.snapshot.timelines[0].items.reverse();
  const plan = createResolvePreviewPlan(sources(base, local, incoming));
  assert.deepEqual(plan.classification.decisions, []); assert.equal(plan.schemaVersion, 2);
});

test('file preview and risk commands accept complete captures while remaining blocked for apply', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rich-preview-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = await rich(), incoming = pan(structuredClone(base), thirteen);
  const paths = ['base', 'local', 'incoming'].map(role => path.join(directory, `${role}.json`));
  for (const [index, value] of [base, base, incoming].entries()) await fs.writeFile(paths[index], JSON.stringify(value));
  const plan = previewSnapshotFiles(...paths);
  const filename = path.join(directory, 'plan.json'); await fs.writeFile(filename, JSON.stringify(plan));
  assert.equal(verifyPreviewFile(filename, ...paths).valid, true);
  const risk = riskSnapshotFiles(...paths);
  assert.equal(risk.gate, 'blocked'); assert.equal(risk.safeToApply, false);
  assert.equal(risk.decisions[0].field, 'properties.Pan');
});

test('native property-preview evidence matches reproducible source bindings and immutable artifact hashes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rich-preview-native-proof-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const evidenceBytes = await fs.readFile(path.join(__dirname, '../phase-0/property-preview-live-observation.json'));
  assert.equal(createHash('sha256').update(evidenceBytes).digest('hex'), 'c06ce24b682803796825c5c72e62d44fb969b824e674708cbbae101f79973bdc');
  const evidence = JSON.parse(evidenceBytes);
  const base = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-enabled.json'));
  const incoming = await fs.readFile(path.join(__dirname, '../phase-0/resolve-xml-proof/live-properties-pan-changed.json'));
  const input = { base, local: JSON.stringify(JSON.parse(base)), incoming: JSON.stringify(JSON.parse(incoming)) };
  const plan = createResolvePreviewPlan(input);
  assert.deepEqual(plan.binding.hashes, evidence.sourceHashes);
  assert.equal(plan.classification.observationCoverage.gaps.length, 0);
  assert.equal(plan.classification.decisions.length, 1);
  assert.equal(plan.classification.decisions[0].field, evidence.field);
  assert.equal(plan.classification.decisions[0].status, evidence.status);
  assert.deepEqual(plan.classification.decisions[0].context, evidence.context);
  for (const role of ['base', 'local', 'incoming']) assert.deepEqual(plan.classification.decisions[0][role], evidence[`${role}Value`]);
  assert.equal(saveResolvePreview(directory, input), evidence.previewArtifactId);
  assert.equal(saveResolveReview(directory, input, []), evidence.reviewArtifactId);
  assert.equal(evidence.captureExport.sha256, plan.binding.hashes.local);
  assert.equal(evidence.readOnly, true); assert.equal(evidence.safeToApply, false);
  assert.equal(evidence.editorMutationsPerformed, false);
});
