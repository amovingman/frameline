'use strict';
const { createHash } = require('node:crypto');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');
const { parseEffectObservation } = require('./resolve-effect-observation');
const { createResolvePreviewPlan } = require('./resolve-preview-plan');
const { resolveReviewedRename } = require('./resolve-rename-review');

const MAX_AUDIT_BYTES = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{32}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const transport = value => {
  keys(value, ['schemaVersion', 'token']);
  if (value.schemaVersion !== 1 || !ID.test(value.token || '')) invalid();
};
function invalid() { throw Object.assign(new Error('invalid-portable-trial-audit'), { code: 'invalid-portable-trial-audit' }); }
function plain(value, ancestors = new Set(), depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 1000000 || depth > 64) invalid();
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
  if (typeof value !== 'object' || ancestors.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) invalid();
  if (Array.isArray(value) && Reflect.ownKeys(value).length !== value.length + 1) invalid();
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')
      || ((!Array.isArray(value) || key !== 'length') && !descriptor.enumerable)) invalid();
    if (key !== 'length' || !Array.isArray(value)) plain(descriptor.value, ancestors, depth + 1, budget);
  }
  ancestors.delete(value);
}
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) invalid();
}
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
function encodedJson(value, limit) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > limit
    || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value)) !== value) invalid();
  return JSON.parse(value);
}
function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}
function portableTrialAuditHash(value) {
  plain(value);
  const bytes = json(value);
  if (Buffer.byteLength(bytes) > MAX_AUDIT_BYTES) invalid();
  return hash(bytes);
}

function validatePortableTrialAudit(value, expectedSnapshot = null) {
  try {
    plain(value);
    if (expectedSnapshot !== null) validateResolveSnapshot(expectedSnapshot);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_AUDIT_BYTES) invalid();
    keys(value, ['schemaVersion', 'kind', 'readOnly', 'safeToApply', 'nativeBackupIncluded', 'provenance', 'transactionId', 'sources', 'review',
      'issuedRecord', 'outcome', 'resultSnapshot', 'effects', 'recovery']);
    if (value.schemaVersion !== 1 || value.kind !== 'resolve-rename-trial-audit' || value.readOnly !== true
      || value.safeToApply !== false || value.nativeBackupIncluded !== false
      || !['copied-console-observation', 'retained-internal-script-observation'].includes(value.provenance)
      || !ID.test(value.transactionId)) invalid();
    keys(value.sources, ['base', 'local', 'incoming']);
    for (const source of Object.values(value.sources)) validateResolveSnapshot(encodedJson(source, 20 * 1024 * 1024));
    const plan = createResolvePreviewPlan(value.sources);
    const derived = resolveReviewedRename({ sources: value.sources, plan, audit: value.review });
    keys(value.outcome, ['status', 'recordedAt', 'sourceSha256', 'incomingSha256', 'resultingSnapshotSha256', 'validation', 'effectObservation']);
    const { outcome } = value;
    if (!['applied', 'rolled-back', 'restored', 'source-verified'].includes(outcome.status)
      || outcome.validation !== 'observed-fields-only' || outcome.sourceSha256 !== hash(derived.beforeBytes)
      || outcome.incomingSha256 !== hash(derived.afterBytes) || outcome.resultingSnapshotSha256 !== hash(value.resultSnapshot)) invalid();
    timestamp(outcome.recordedAt);
    const snapshot = encodedJson(value.resultSnapshot, 20 * 1024 * 1024); validateResolveSnapshot(snapshot);
    const before = JSON.parse(derived.beforeBytes), after = JSON.parse(derived.afterBytes);
    if (json(snapshot) !== json(outcome.status === 'applied' ? after : before)
      || (expectedSnapshot !== null && json(snapshot) !== json(expectedSnapshot))) invalid();
    const issued = encodedJson(value.issuedRecord, 16384);
    keys(issued, ['transactionId', 'backup', 'forceFailure', 'issuedAt', ...(Object.hasOwn(issued, 'recoveryVersion') ? ['recoveryVersion'] : []),
      ...(Object.hasOwn(issued, 'resultTransport') ? ['resultTransport'] : [])]);
    if (issued.transactionId !== value.transactionId || typeof issued.forceFailure !== 'boolean'
      || (issued.recoveryVersion !== undefined && ![1, 2, 3].includes(issued.recoveryVersion))
      || (issued.forceFailure && outcome.status === 'applied')) invalid();
    if (issued.recoveryVersion === 3) transport(issued.resultTransport);
    else if (issued.resultTransport !== undefined) invalid();
    timestamp(issued.issuedAt);
    keys(issued.backup, ['schemaVersion', 'sha256', 'size', 'mode', 'timelineCount', 'archiveVerified']);
    if (issued.backup.schemaVersion !== 1 || !SHA.test(issued.backup.sha256) || issued.backup.archiveVerified !== true
      || issued.backup.mode !== 0o600 || !Number.isSafeInteger(issued.backup.size) || issued.backup.size < 1
      || issued.backup.size > 100 * 1024 * 1024 || !Number.isSafeInteger(issued.backup.timelineCount)
      || issued.backup.timelineCount < 1 || issued.backup.timelineCount > 10000) invalid();
    let effectsBefore = null;
    if (value.effects !== null) {
      keys(value.effects, ['before', 'after']);
      effectsBefore = parseEffectObservation(value.effects.before);
      const effectsAfter = parseEffectObservation(value.effects.after);
      if (json(effectsBefore.snapshot) !== json(before) || json(effectsAfter.snapshot) !== json(snapshot)) invalid();
      const expected = structuredClone(effectsBefore); expected.snapshot = snapshot;
      if (json(effectsAfter) !== json(expected)) invalid();
      keys(outcome.effectObservation, ['sourceSha256', 'resultingSha256', 'validation']);
      if (outcome.effectObservation.sourceSha256 !== hash(value.effects.before)
        || outcome.effectObservation.resultingSha256 !== hash(value.effects.after)
        || outcome.effectObservation.validation !== 'observed-effect-metadata-only') invalid();
    } else if (outcome.effectObservation !== null) invalid();
    const recovered = ['restored', 'source-verified'].includes(outcome.status);
    if (recovered) {
      if (!effectsBefore || !([2, 3].includes(issued.recoveryVersion) || issued.recoveryVersion === 1 && issued.forceFailure === true)) invalid();
      keys(value.recovery, ['binding', 'inspection', 'revocation']);
      const binding = value.recovery.binding;
      keys(binding, ['attemptId', 'revocationSha256', 'inspectionSha256', 'operation', ...(Object.hasOwn(binding, 'resultTransport') ? ['resultTransport'] : [])]);
      if (binding.resultTransport !== undefined) transport(binding.resultTransport);
      if (!ID.test(binding.attemptId) || binding.revocationSha256 !== hash(value.recovery.revocation)
        || binding.inspectionSha256 !== hash(value.recovery.inspection)
        || binding.operation !== (outcome.status === 'restored' ? 'restore-name' : 'verify-source')) invalid();
      const revocation = encodedJson(value.recovery.revocation, 1024);
      keys(revocation, ['schemaVersion', 'transactionId', 'issuedSha256', 'backupSha256']);
      if (revocation.schemaVersion !== 1 || revocation.transactionId !== value.transactionId
        || revocation.issuedSha256 !== hash(value.issuedRecord) || revocation.backupSha256 !== issued.backup.sha256) invalid();
      const inspection = parseEffectObservation(value.recovery.inspection), expected = structuredClone(effectsBefore);
      expected.snapshot = outcome.status === 'restored' ? after : before;
      if (json(inspection) !== json(expected)) invalid();
    } else if (value.recovery !== null) invalid();
    const retained = recovered ? value.recovery.binding.resultTransport !== undefined : issued.resultTransport !== undefined;
    if (value.provenance !== (retained ? 'retained-internal-script-observation' : 'copied-console-observation')) invalid();
    return value;
  } catch { invalid(); }
}

function createPortableTrialAuditBundle(audit) {
  validatePortableTrialAudit(audit);
  return { format: 'frameline-resolve-trial-audit', version: 1, auditHash: portableTrialAuditHash(audit), audit: structuredClone(audit) };
}
function validatePortableTrialAuditBundle(value) {
  try {
    plain(value); keys(value, ['format', 'version', 'auditHash', 'audit']);
    if (value.format !== 'frameline-resolve-trial-audit' || value.version !== 1) invalid();
    validatePortableTrialAudit(value.audit);
    if (value.auditHash !== portableTrialAuditHash(value.audit)) invalid();
    return value;
  } catch { invalid(); }
}

module.exports = { validatePortableTrialAudit, portableTrialAuditHash, createPortableTrialAuditBundle,
  validatePortableTrialAuditBundle, MAX_AUDIT_BYTES };
