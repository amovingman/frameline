'use strict';
const path = require('node:path');
const { createClosedProjectApplyAdapter } = require('./closed-project-apply-adapter');
const { createClosedProjectApplyTransaction } = require('./closed-project-apply-transaction');
const { createClosedProjectApplySession } = require('./closed-project-apply-session');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PENDING = new Set(['pending-editor-validation', 'pending-rollback-editor-validation', 'validating-editor',
  'validating-rollback', 'validation-failed', 'publication-unverified']);
const MESSAGES = {
  'closed-project-resolve-running': 'Quit Resolve completely before checking or changing the project file. Open it again when the prepared editor check is ready.',
  'closed-project-source-open': 'Another process has the project file open. Close it before retrying the file check.',
  'closed-project-source-hash-stale': 'The project file changed. Inspect the retained transaction and review the current source before preparing another Apply.',
  'apply-source-changed': 'The project file changed. Inspect the retained transaction before continuing.',
  'apply-source-metadata-changed': 'The project permissions or file attributes changed. Keep the backup and inspect the retained transaction.',
  'closed-project-installed-build-unsupported': 'This Apply supports the installed Resolve Free 21.1.2 build on macOS. The current installation differs.',
  'closed-project-installed-build-unverified': 'The installed Resolve build could not be verified.',
  'closed-project-source-directory-not-single-file': 'The selected project directory contains additional files. Quit Resolve and choose its closed Project.db again.',
  'closed-project-source-acl-unsupported': 'The selected project has access permissions this Apply cannot preserve.',
  'closed-project-source-permissions-unsupported': 'The selected project has permissions this Apply cannot preserve.',
  'closed-project-source-attributes-unsupported': 'The selected project has file attributes this Apply cannot preserve.',
  'complete-current-review-required': 'Review sources changed or conflict choices are incomplete. Refresh and finish the review.',
  'service-review-read-only': 'Service history reviews cannot apply changes to a local project.',
  'rich-preview-review-only': 'Use a snapshot review containing one existing video clip Name change for this Apply.',
  'reviewed-trial-requires-one-rename': 'This Apply requires exactly one reviewed video clip Name change.',
  'unsupported-reviewed-operation': 'The review contains an operation outside the supported Name change.',
  'closed-apply-source-required': 'Choose the closed project’s Project.db file to prepare Apply.',
  'closed-apply-review-locked': 'Finish or inspect the retained Apply before starting another review.',
  'closed-apply-not-initialized': 'Refresh retained Apply records before continuing.',
  'closed-apply-busy': 'An Apply action is already running.',
  'apply-operation-in-progress': 'Another Apply action is already running. Keep its records and retry after it finishes.',
  'apply-editor-readback-required': 'Open the project in Resolve, run its prepared verification script, and read the editor check here before quitting Resolve for final validation.',
  'apply-validation-not-ready': 'Inspect the retained Apply before preparing its editor check.',
  'apply-rollback-not-ready': 'Inspect the retained Apply before restoring the backup.',
  'closed-apply-input-invalid': 'The requested Apply action is invalid.',
  'closed-apply-action-unavailable': 'That action is unavailable for the retained Apply.',
  'closed-apply-record-invalid': 'The retained Apply record could not be verified. Keep its files and backup for inspection.'
};
const fallback = 'The action could not be verified. Keep the retained Apply records and backup, then inspect the transaction before continuing.';
function direction(record) {
  return ['pending-rollback-editor-validation', 'validating-rollback'].includes(record.state)
    || ['rollback-publishing', 'validating-rollback'].includes(record.failedPhase)
    || record.recovery?.classification === 'original-needs-editor-validation' ? 'rollback' : 'apply';
}

// Dependency injection belongs to the main process. IPC accepts only action
// names and opaque retained transaction UUIDs, never native paths or proofs.
function createDesktopClosedProjectApply({ directory, getVerifiedReview, chooseSource, reveal,
  onChange = () => {}, adapter: injectedAdapter, transactionService } = {}) {
  if (!path.isAbsolute(directory || '') || [getVerifiedReview, chooseSource, reveal, onChange]
    .some(value => typeof value !== 'function')) throw new Error('closed-apply-desktop-invalid');
  let check = null, extraError = null, busy = false;
  const adapter = injectedAdapter || createClosedProjectApplyAdapter({ directory: path.join(directory, 'adapter'), getCurrentReview: getVerifiedReview });
  const transaction = transactionService || createClosedProjectApplyTransaction({ directory: path.join(directory, 'transactions'), adapter, verifyPlan: adapter.verifyPlan });
  const session = createClosedProjectApplySession({ transactionService: transaction, createPlan: adapter.createPlan,
    getVerifiedReview, getSelectedNativeSource: chooseSource, onChange: () => changed() });
  function state() {
    const current = session.getState(), code = extraError || current.error;
    return { ...current, busy: busy || current.busy, reviewLocked: busy || current.reviewLocked,
      actions: Object.fromEntries(Object.entries(current.actions).map(([key, value]) => [key, value && !busy])),
      editorCheck: check ? { ...check } : null, errorCode: code, error: code ? MESSAGES[code] || fallback : null };
  }
  function changed() {
    const current = state();
    try { Promise.resolve(onChange(structuredClone(current))).catch(() => {}); } catch { /* UI delivery cannot undo the transaction. */ }
    return current;
  }
  function checkedId(args) {
    if (args.length !== 1 || typeof args[0] !== 'string' || !UUID.test(args[0])) throw new Error('closed-apply-input-invalid');
    return args[0];
  }
  async function checkOptions(id) {
    // Preparation requires fresh offline classification. Reading the existing
    // native receipt deliberately uses journal inspection instead.
    const record = await transaction.recover(id);
    if (!record.recovery?.mayValidate) throw new Error('apply-validation-not-ready');
    const way = direction(record);
    return { plan: record.plan, transactionId: id, direction: way,
      expectedSource: way === 'apply' ? record.candidate : record.source };
  }
  async function prepareCheck(id) {
    const options = await checkOptions(id), prepared = await adapter.prepareEditorCheck(options);
    check = { transactionId: id, menuName: prepared.menuName, status: 'ready' };
  }
  async function readCheck(id, optional = false) {
    const record = await transaction.inspect(id);
    try {
      const result = await adapter.readEditorCheck({ plan: record.plan, transactionId: id, direction: direction(record), admit: !optional });
      check = { transactionId: id, menuName: result.menuName || (check?.transactionId === id ? check.menuName : null), status: result.status };
    } catch (error) {
      if (!optional || error.code !== 'ENOENT') throw error;
      check = { transactionId: id, menuName: null, status: 'not-prepared' };
    }
  }
  async function action(method, ...args) {
    if (busy) return { ...state(), errorCode: 'closed-apply-busy', error: MESSAGES['closed-apply-busy'] };
    busy = true; extraError = null; changed();
    try {
      if (!['initialize', 'prepare', 'apply', 'validate', 'recover', 'rollback', 'inspect', 'cancel',
        'prepare-check', 'read-check', 'reveal'].includes(method)) throw new Error('closed-apply-input-invalid');
      if (['initialize', 'prepare'].includes(method)) {
        if (args.length) throw new Error('closed-apply-input-invalid');
      } else checkedId(args);
      if (method === 'prepare-check') await prepareCheck(args[0]);
      else if (method === 'read-check') await readCheck(args[0]);
      else if (method === 'reveal') {
        const record = await transaction.inspect(args[0]);
        await reveal(record.backup?.path || path.join(directory, 'transactions', record.transactionId));
      } else {
        await session[method](...args);
        const current = session.getState(), record = current.transaction;
        if (!current.error && record) {
          if (['apply', 'rollback'].includes(method) && ['pending-editor-validation', 'pending-rollback-editor-validation'].includes(record.state)) {
            await prepareCheck(record.transactionId);
          } else if (['initialize', 'inspect', 'recover'].includes(method) && PENDING.has(record.state)) {
            await readCheck(record.transactionId, true);
          } else if (['completed', 'rolled-back', 'cancelled'].includes(record.state)) check = null;
        }
      }
    } catch (error) {
      const code = error.code || error.message;
      extraError = Object.hasOwn(MESSAGES, code) ? code : 'closed-apply-action-failed';
    } finally { busy = false; }
    return changed();
  }
  return { getState: state, isReviewLocked: () => busy || session.isReviewLocked(), action };
}
module.exports = { createDesktopClosedProjectApply };
