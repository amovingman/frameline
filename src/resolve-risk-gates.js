'use strict';

// Observations can demonstrate risk, but cannot demonstrate complete edit safety.
const { assessResolvePlan } = require('./resolve-plan-policy');
const { validateResolveIdManifest } = require('./resolve-id-diff');
const CATEGORIES = Object.freeze(['timing-ripple', 'linked-clips', 'transitions', 'nested-unknown']);
const TIMING = new Set(['startFrame', 'endFrame', 'sourceStartFrame', 'sourceEndFrame', 'track', 'tracks', 'existence']);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function assessResolveRiskGates(classification, snapshots = {}) {
  assessResolvePlan(classification); // Share the classifier contract and validation.
  let reference;
  for (const side of ['base', 'local', 'incoming']) {
    if (snapshots[side] === undefined) continue;
    const manifest = validateResolveIdManifest(snapshots[side]);
    if ((reference && (reference.projectId !== manifest.projectId || reference.resolveVersion !== manifest.resolveVersion))
      || (classification.projectId && classification.projectId !== manifest.projectId)
      || (classification.resolveVersion && classification.resolveVersion !== manifest.resolveVersion)) {
      const error = new Error('Risk observations must match the classification project and Resolve version.');
      error.code = 'incompatible-resolve-manifests';
      throw error;
    }
    reference = manifest;
  }
  const decisions = classification.decisions.map(decision => {
    const codes = new Set(['transition-coverage-unknown', 'nested-coverage-unknown', 'ripple-semantics-unknown', 'linked-coverage-unknown']);
    const blocked = new Set();
    const entities = [];
    function inspect(value) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(inspect); return; }
      if (typeof value.type === 'string' && (value.id || value.track || value.trackIndex)) entities.push(value);
      Object.values(value).forEach(inspect);
    }
    if (decision.field === 'existence') [decision.base, decision.local, decision.incoming].forEach(inspect);
    for (const side of ['base', 'local', 'incoming']) {
      const timeline = snapshots[side]?.timelines.find(value => value.id === decision.timelineId);
      if (decision.itemId === null) entities.push(...(timeline?.items || []));
      else {
        const item = timeline?.items.find(value => value.id === decision.itemId);
        if (item) entities.push(item);
      }
    }
    if (TIMING.has(decision.field)) {
      codes.add('timing-ripple-review-required'); blocked.add('timing-ripple');
    }
    if (decision.field === 'linkedItemIds' || entities.some(value => value.linkedItemIds?.length)) {
      codes.add('linked-clips-review-required'); blocked.add('linked-clips');
    }
    const types = entities.map(value => value.type);
    if (decision.field === 'type') types.push(decision.base, decision.local, decision.incoming);
    for (const type of types) {
      if (typeof type !== 'string') continue;
      if (/transition/i.test(type)) { codes.add('transition-observed'); blocked.add('transitions'); }
      if (!['video', 'audio'].includes(type)) {
        codes.add('unsupported-or-nested-item'); blocked.add('nested-unknown');
      }
    }
    if (decision.status === 'conflict') codes.add('unresolved-conflict');
    return { timelineId: decision.timelineId, itemId: decision.itemId, field: decision.field,
      status: decision.status, gate: 'blocked',
      riskCategories: CATEGORIES.map(category => ({ category, status: blocked.has(category) ? 'blocked' : 'unknown' })),
      warningCodes: [...codes].sort(cmp) };
  }).sort((a, b) => cmp(a.timelineId, b.timelineId) || cmp(a.itemId || '', b.itemId || '')
    || cmp(a.field, b.field) || cmp(JSON.stringify(a), JSON.stringify(b)));
  const warningCodes = [...new Set(['read-only-risk-assessment', 'transition-coverage-unknown', 'nested-coverage-unknown',
    'ripple-semantics-unknown', 'linked-coverage-unknown', ...decisions.flatMap(value => value.warningCodes)])].sort(cmp);
  return { schemaVersion: 1, readOnly: true, safeToApply: false, gate: 'blocked',
    coverage: 'observed-fields-only', warningCodes, decisions };
}

module.exports = { assessResolveRiskGates, CATEGORIES };
