'use strict';

// Main-process controller. The renderer selects an opaque retained transaction;
// it never supplies native paths, plans, closed-state claims, or editor proofs.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['completed', 'rolled-back', 'cancelled']);
const STATES = new Set(['prepared', 'backup-started', 'backed-up', 'candidate-started', 'candidate-verified',
  'publishing', 'pending-editor-validation', 'validating-editor', 'completed', 'rollback-publishing',
  'pending-rollback-editor-validation', 'validating-rollback', 'rolled-back', 'failed',
  'publication-unverified', 'validation-failed', 'cancelled']);
const RECOVERY = new Set(['original-safe-replan', 'candidate-needs-editor-validation', 'original-needs-editor-validation',
  'diverged-manual-review', 'verified-complete', 'verified-rollback']);
const SAFE_ERRORS = new Set(['closed-apply-input-invalid', 'closed-apply-review-locked', 'closed-apply-not-initialized',
  'closed-apply-record-invalid', 'closed-apply-source-required', 'closed-apply-action-unavailable',
  'closed-project-resolve-running', 'closed-project-source-open', 'closed-project-source-hash-stale',
  'closed-project-installed-build-unsupported', 'closed-project-installed-build-unverified',
  'closed-project-source-directory-not-single-file', 'closed-project-source-acl-unsupported',
  'closed-project-source-permissions-unsupported', 'closed-project-source-attributes-unsupported',
  'apply-source-changed', 'apply-source-metadata-changed', 'apply-editor-readback-required',
  'apply-operation-in-progress', 'apply-validation-not-ready', 'apply-rollback-not-ready',
  'complete-current-review-required', 'service-review-read-only', 'rich-preview-review-only',
  'reviewed-trial-requires-one-rename', 'unsupported-reviewed-operation']);
const text = value => typeof value === 'string' ? value.slice(0, 512) : null;
const digest = value => typeof value === 'string' && SHA.test(value) ? value : null;
const fail = code => Object.assign(new Error(code), { code });

function publicRecord(record) {
  const plan = record.plan || {}, edit = plan.edit || {};
  return {
    transactionId: record.transactionId, state: record.state,
    projectName: text(plan.projectName), projectId: text(plan.projectId),
    planId: digest(plan.planId || record.planHash),
    edit: { timelineId: text(edit.timelineId), itemId: text(edit.itemId),
      oldName: text(edit.oldName), newName: text(edit.newName), field: 'Name' },
    sourceSha256: digest(record.source?.sha256), candidateSha256: digest(record.candidate?.sha256),
    backup: record.backup ? { retained: true, sha256: digest(record.backup.sha256),
      bytes: Number.isSafeInteger(record.backup.bytes) && record.backup.bytes >= 0 ? record.backup.bytes : null } : null,
    resultingRevision: record.resultingRevision ? {
      revisionId: digest(record.resultingRevision.revisionId), sourceSha256: digest(record.resultingRevision.sourceSha256),
      parentSourceSha256: digest(record.resultingRevision.parentSourceSha256), createdAt: text(record.resultingRevision.createdAt),
      planId: digest(record.resultingRevision.planId), editorProofSha256: digest(record.resultingRevision.editorProofSha256),
      direction: ['apply', 'rollback'].includes(record.resultingRevision.direction) ? record.resultingRevision.direction : null,
      auditHash: digest(record.resultingRevision.review?.auditHash),
      choiceCount: Array.isArray(record.resultingRevision.review?.choices) ? record.resultingRevision.review.choices.length : 0
    } : null,
    recovery: RECOVERY.has(record.recovery?.classification) ? {
      classification: record.recovery.classification,
      mayRollback: record.recovery.mayRollback === true,
      mayValidate: record.recovery.mayValidate === true
    } : null
  };
}

function createClosedProjectApplySession({ transactionService, createPlan, getVerifiedReview,
  getSelectedNativeSource, listTransactionIds = null, onChange = () => {} } = {}) {
  if (!transactionService || !['prepare', 'apply', 'validate', 'recover', 'rollback', 'inspect']
    .every(method => typeof transactionService[method] === 'function')
    || [createPlan, getVerifiedReview, getSelectedNativeSource, onChange].some(value => typeof value !== 'function')
    || (listTransactionIds !== null && typeof listTransactionIds !== 'function')) throw fail('closed-apply-session-invalid');
  const readInventory = listTransactionIds || (typeof transactionService.listTransactionIds === 'function'
    ? () => transactionService.listTransactionIds() : null);
  if (!readInventory) throw fail('closed-apply-session-invalid');
  const records = new Map();
  let selectedId = null, busy = false, error = null, initialized = false, uncertain = null;
  function unresolved(record) {
    return !TERMINAL.has(record.state) && record.recovery?.classification !== 'original-safe-replan';
  }
  function isReviewLocked() { return !initialized || busy || Boolean(uncertain) || [...records.values()].some(unresolved); }
  function getState() {
    const record = records.get(selectedId);
    return {
      initialized, busy, reviewLocked: isReviewLocked(), error,
      transaction: record ? publicRecord(record) : null,
      retained: [...records.values()].map(publicRecord),
      actions: {
        prepare: initialized && !isReviewLocked(),
        apply: !busy && record?.state === 'prepared',
        validate: !busy && Boolean(record && (['pending-editor-validation', 'pending-rollback-editor-validation']
          .includes(record.state) || record.recovery?.mayValidate === true)),
        rollback: !busy && record?.recovery?.mayRollback === true,
        cancel: !busy && record?.state === 'prepared' && typeof transactionService.cancel === 'function',
        inspect: !busy && Boolean(record), recover: !busy && Boolean(record)
      }
    };
  }
  function publish() {
    const state = getState();
    try { Promise.resolve(onChange(structuredClone(state))).catch(() => {}); } catch { /* View failures cannot undo a transaction. */ }
    return state;
  }
  function install(record, expectedId) {
    if (!record || !ID.test(record.transactionId || '') || !STATES.has(record.state)
      || (expectedId && record.transactionId !== expectedId)) throw fail('closed-apply-record-invalid');
    // Keep a detached record: injected implementations cannot later mutate UI
    // recovery authority by retaining a reference to a returned object.
    records.set(record.transactionId, structuredClone(record)); selectedId = record.transactionId;
  }
  async function run(action) {
    if (busy) return { ...getState(), error: 'closed-apply-busy' };
    busy = true; error = null; publish();
    try { await action(); }
    catch (failure) {
      const code = failure?.code || failure?.message;
      error = SAFE_ERRORS.has(code) ? code : 'closed-apply-action-failed';
    } finally { busy = false; }
    return publish();
  }
  function requireId(args) {
    if (args.length !== 1 || typeof args[0] !== 'string' || !ID.test(args[0])) throw fail('closed-apply-input-invalid');
    return args[0];
  }
  function initialize(...args) {
    return run(async () => {
      if (args.length) throw fail('closed-apply-input-invalid');
      if (initialized && !uncertain) return;
      // An unreadable inventory cannot silently unlock a possibly published edit.
      uncertain = 'inventory';
      const ids = await readInventory();
      if (!Array.isArray(ids) || ids.length > 1000 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !ID.test(id))) throw fail('closed-apply-record-invalid');
      // Journal inspection works while Resolve is open for its readback step.
      // Fresh closed-file classification remains an explicit recovery action.
      for (const id of ids) install(await transactionService.inspect(id), id);
      initialized = true; uncertain = null;
    });
  }
  function prepare(...args) {
    return run(async () => {
      if (args.length) throw fail('closed-apply-input-invalid');
      if (!initialized) throw fail('closed-apply-not-initialized');
      if (uncertain || [...records.values()].some(unresolved)) throw fail('closed-apply-review-locked');
      const review = await getVerifiedReview();
      const source = await getSelectedNativeSource();
      if (source === null) return; // The native file picker was cancelled.
      if (!source) throw fail('closed-apply-source-required');
      const plan = await createPlan({ review, source });
      uncertain = 'inventory';
      install(await transactionService.prepare(plan));
      uncertain = null;
    });
  }
  function act(method, args) {
    return run(async () => {
      const id = requireId(args);
      if (!initialized) throw fail('closed-apply-not-initialized');
      if (typeof transactionService[method] !== 'function') throw fail('closed-apply-action-unavailable');
      if (!['inspect', 'recover'].includes(method) && !records.has(id)) throw fail('closed-apply-input-invalid');
      if (method === 'apply' && records.get(id).state !== 'prepared') throw fail('closed-apply-action-unavailable');
      if (method === 'cancel' && records.get(id).state !== 'prepared') throw fail('closed-apply-action-unavailable');
      selectedId = id;
      const mutating = ['apply', 'validate', 'rollback', 'cancel'].includes(method);
      if (mutating && uncertain && uncertain !== id) throw fail('closed-apply-review-locked');
      if (mutating) uncertain = id;
      try {
        install(await transactionService[method](id), id);
        if (uncertain === id) uncertain = null;
      } catch (failure) {
        if (mutating) {
          // A rejected promise may follow a committed rename. Reconciliation is
          // read only and must not replay the effect or silently restore bytes.
          try { install(await transactionService.recover(id), id); if (uncertain === id) uncertain = null; } catch { /* Retain lock and backup. */ }
        }
        throw failure;
      }
    });
  }
  return { getState, isReviewLocked, initialize, prepare,
    apply: (...args) => act('apply', args), validate: (...args) => act('validate', args),
    recover: (...args) => act('recover', args), rollback: (...args) => act('rollback', args),
    inspect: (...args) => act('inspect', args), cancel: (...args) => act('cancel', args) };
}

module.exports = { createClosedProjectApplySession };
