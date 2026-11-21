'use strict';
const path = require('node:path');
const { createClosedProjectReviewCopy } = require('./closed-project-review-copy');
const { createReviewCopyEditorValidation } = require('./review-copy-editor-validation');
const { createReviewCopyOpenCommand } = require('./review-copy-open-command');
const { createReviewCopyMediaPolicy } = require('./resolve-review-copy-media');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(['preparing', 'prepared', 'publishing', 'published-awaiting-editor', 'publication-unverified',
  'failed', 'validation-failed', 'completed', 'cancelled']);
const TERMINAL = new Set(['completed', 'cancelled']);
const METHODS = new Set(['initialize', 'prepare', 'publish', 'cancel', 'prepare-check', 'read-check',
  'validate', 'recover', 'inspect', 'reveal', 'open', 'read-open']);
const MESSAGES = {
  'closed-project-resolve-running': 'Quit Resolve before preparing, publishing or finishing the copy check.',
  'review-copy-destination-exists': 'A project with this name already exists in the destination library. Choose another connected library.',
  'review-copy-original-changed': 'The original project changed. Keep the retained records and review fresh captures before continuing.',
  'review-copy-sync-base-changed': 'The original history or sync base changed. Inspect the retained copy before continuing.',
  'copy-review-locked': 'Finish the active Apply or rename drill before starting a review copy.',
  'copy-action-invalid': 'The requested review-copy action is invalid.',
  'copy-not-initialized': 'Read the retained review-copy records before continuing.',
  'copy-not-published': 'Publish the prepared review copy before opening or validating it.',
  'copy-cancel-unavailable': 'Only an unpublished preparation can be cancelled. Keep the retained copy and inspect recovery.',
  'copy-open-unavailable': 'The source-bound open command is unavailable. Keep the copy and its records.',
  'copy-record-invalid': 'The retained review-copy record could not be verified. Keep its files for inspection.',
  'copy-editor-readback-required': 'Open the review copy in its destination library, run the prepared check, then read it here. Quit Resolve before finishing validation.'
};
const fail = code => Object.assign(new Error(code), { code });
const text = value => typeof value === 'string' ? value.slice(0, 512) : null;
const digest = value => HASH.test(value || '') ? value : null;
function publicMedia(value) {
  if (!value) return null;
  const report = value.report || {}, counts = report.counts || {}, status = ['observed-media-missing', 'observed-media-unknown', 'observed-references-available'].includes(report.status) ? report.status : 'observed-media-unknown';
  return { policy: value.policy === 'unchanged-references' ? value.policy : null, verified: value.verified === true,
    mediaReadiness: ['observed-media-missing', 'observed-media-unknown', 'observed-references-available'].includes(status) ? status : 'observed-media-unknown',
    portableCopyVerified: false, collectionRequiredForPortability: true, collectionAction: 'collect-in-resolve-and-recapture',
    report: { status, opaqueNativeMediaCells: Number.isSafeInteger(report.opaqueNativeMediaCells) && report.opaqueNativeMediaCells >= 0 ? report.opaqueNativeMediaCells : 0, counts: Object.fromEntries(['total', 'available', 'missing', 'unknown'].map(key => [key,
      Number.isSafeInteger(counts[key]) && counts[key] >= 0 ? counts[key] : 0])),
      completeMediaEnumeration: false, mediaRelinkPerformed: false, mediaCollected: false,
      message: status === 'observed-media-missing'
        ? 'Some observed media references are missing. Collect or relink media in Resolve, then capture and prepare a new review copy.'
        : 'The copy shares the original media references on this Mac. Opaque media and proxy records are preserved; their paths have not been enumerated.' } };
}
function publicRecord(record) {
  const recovery = record.recovery;
  const canCancel = record.state === 'prepared' || record.state === 'preparing' || record.state === 'failed' && record.failedPhase === 'preparing';
  return { transactionId: record.transactionId, state: record.state, canCancel,
    projectName: text(record.plan.projectName), projectId: text(record.plan.projectId),
    libraryName: text(record.destination.binding.expectedCurrentDatabase.DbName),
    edit: { oldName: text(record.plan.edit.oldName), newName: text(record.plan.edit.newName) },
    sourceSha256: digest(record.original.sha256), copySha256: digest(record.candidate?.sha256),
    originalUnchanged: record.originalUnchanged === true, syncBaseUnchanged: record.syncBaseUnchanged === true,
    mediaPolicy: publicMedia(record.mediaPolicy),
    resultingRevision: record.resultingRevision ? { revisionId: digest(record.resultingRevision.revisionId),
      completedAt: text(record.resultingRevision.completedAt) } : null,
    recovery: recovery && ['destination-absent', 'incomplete-owned-copy', 'unowned-or-diverged-copy',
      'verified-complete', 'candidate-needs-editor-validation'].includes(recovery.classification)
      ? { classification: recovery.classification, mayValidate: recovery.mayValidate === true } : null };
}
function createDesktopNativeReviewCopy({ directory, getVerifiedReview, getSyncBase, chooseSource, chooseDestination,
  canStart = () => true, reveal, openEditor, onChange = () => {}, service: injected,
  editor: injectedEditor, openCommand } = {}) {
  if (!path.isAbsolute(directory || '') || [getVerifiedReview, getSyncBase, chooseSource, chooseDestination,
    canStart, reveal, openEditor, onChange].some(value => typeof value !== 'function')) throw fail('copy-controller-invalid');
  const editor = injectedEditor || createReviewCopyEditorValidation({ directory: path.join(directory, 'editor-checks') });
  const service = injected || createClosedProjectReviewCopy({ directory: path.join(directory, 'transactions'),
    getCurrentReview: getVerifiedReview, getSyncBase, mediaPolicy: createReviewCopyMediaPolicy(), verifyEditor: editor.verify });
  if (!['prepare', 'publish', 'inspect', 'recover', 'validate', 'listTransactionIds'].every(key => typeof service[key] === 'function')
    || !['prepare', 'read'].every(key => typeof editor[key] === 'function')) throw fail('copy-controller-invalid');
  openCommand ||= createReviewCopyOpenCommand({ directory: path.join(directory, 'editor-open') });
  const records = new Map();
  let initialized = false, busy = false, uncertain = false, error = null, selected = null, editorCheck = null, openCheck = null;
  function isReviewLocked() { return !initialized || busy || uncertain || [...records.values()].some(record => !TERMINAL.has(record.state)); }
  function getState() {
    return { initialized, busy, reviewLocked: isReviewLocked(), error,
      transaction: records.has(selected) ? publicRecord(records.get(selected)) : null,
      retained: [...records.values()].map(publicRecord), editorCheck: editorCheck ? { ...editorCheck } : null,
      openCheck: openCheck ? { ...openCheck } : null };
  }
  function changed() {
    const state = getState();
    try { Promise.resolve(onChange(structuredClone(state))).catch(() => {}); } catch { /* UI errors cannot undo a copy. */ }
    return state;
  }
  function install(record, expectedId = null) {
    if (!record || !ID.test(record.transactionId || '') || expectedId && record.transactionId !== expectedId
      || !STATES.has(record.state) || !record.plan?.edit || !record.destination?.binding?.expectedCurrentDatabase
      || !HASH.test(record.original?.sha256 || '') || !(HASH.test(record.candidate?.sha256 || '') || record.candidate === null && (['preparing', 'cancelled'].includes(record.state) || record.state === 'failed' && record.failedPhase === 'preparing'))) throw fail('copy-record-invalid');
    records.set(record.transactionId, structuredClone(record)); selected = record.transactionId;
  }
  function checkState(record) {
    if (!['published-awaiting-editor', 'validation-failed', 'publication-unverified', 'completed'].includes(record.state)
      && record.recovery?.mayValidate !== true) throw fail('copy-not-published');
  }
  async function readInventory() {
    const ids = await service.listTransactionIds();
    if (!Array.isArray(ids) || ids.length > 1000 || new Set(ids).size !== ids.length || ids.some(id => !ID.test(id))) throw fail('copy-record-invalid');
    for (const id of ids) install(await service.inspect(id), id);
  }
  async function readCheck(record, optional = false) {
    try {
      const result = await editor.read(record, { admit: !optional });
      editorCheck = { transactionId: record.transactionId, menuName: text(result.menuName), status: text(result.status) };
    } catch (failure) {
      if (!optional || !['ENOENT', 'copy-editor-not-prepared'].includes(failure.code || failure.message)) throw failure;
      editorCheck = { transactionId: record.transactionId, menuName: null, status: 'not-prepared' };
    }
  }
  async function readOpen(record, optional = false) {
    if (!openCommand || typeof openCommand.read !== 'function') throw fail('copy-open-unavailable');
    try {
      const result = await openCommand.read(record, { admit: !optional });
      openCheck = { transactionId: record.transactionId, menuName: text(result.menuName) || openCheck?.menuName || null,
        status: text(result.status) };
    } catch (failure) {
      if (!optional || !['ENOENT', 'review-copy-open-not-prepared'].includes(failure.code || failure.message)) throw failure;
      openCheck = null;
    }
  }
  async function action(name, ...args) {
    if (busy) return { ...getState(), error: 'A review-copy action is already running.' };
    busy = true; error = null; changed();
    let accepted = false;
    try {
      if (!METHODS.has(name)) throw fail('copy-action-invalid');
      if (['initialize', 'prepare'].includes(name)) { if (args.length) throw fail('copy-action-invalid'); }
      else if (args.length !== 1 || typeof args[0] !== 'string' || !ID.test(args[0]) || !records.has(args[0])) throw fail('copy-action-invalid');
      accepted = true;
      if (name === 'initialize') {
        if (!initialized) {
          await readInventory();
          initialized = true;
          const current = records.get(selected);
          if (current && !TERMINAL.has(current.state) && !['prepared', 'preparing'].includes(current.state) && !(current.state === 'failed' && current.failedPhase === 'preparing')) { await readCheck(current, true); await readOpen(current, true); }
        }
      } else {
        if (!initialized) throw fail('copy-not-initialized');
        if (name === 'prepare') {
          if (canStart() !== true || uncertain || [...records.values()].some(record => !TERMINAL.has(record.state))) throw fail('copy-review-locked');
          const review = await getVerifiedReview(), sourcePath = await chooseSource();
          if (sourcePath) {
            const destinationLibraryRoot = await chooseDestination();
            if (destinationLibraryRoot) {
              if (canStart() !== true) throw fail('copy-review-locked');
              uncertain = true;
              install(await service.prepare({ review, sourcePath, destinationLibraryRoot }));
              uncertain = false; editorCheck = openCheck = null;
            }
          }
        } else {
          const id = args[0];
          if (!records.has(id)) throw fail('copy-action-invalid');
          if (['publish', 'open', 'prepare-check'].includes(name) && canStart() !== true) throw fail('copy-review-locked');
          let record = await service.inspect(id); install(record, id);
          if (name === 'publish') {
            record = await service.publish(id); install(record, id);
            const prepared = await editor.prepare(record);
            editorCheck = { transactionId: id, menuName: text(prepared.menuName), status: text(prepared.status) || 'ready' };
          } else if (name === 'cancel') {
            if (!(record.state === 'prepared' || record.state === 'preparing' || record.state === 'failed' && record.failedPhase === 'preparing') || typeof service.cancel !== 'function') throw fail('copy-cancel-unavailable');
            install(await service.cancel(id), id); editorCheck = openCheck = null;
          } else if (name === 'prepare-check') {
            checkState(record); const prepared = await editor.prepare(record);
            editorCheck = { transactionId: id, menuName: text(prepared.menuName), status: text(prepared.status) || 'ready' };
          } else if (name === 'read-check') { checkState(record); await readCheck(record); }
          else if (name === 'validate') { checkState(record); install(await service.validate(id), id); }
          else if (name === 'recover') { record = await service.recover(id); install(record, id); if (record.recovery?.mayValidate) await readCheck(record, true); }
          else if (name === 'reveal') await reveal(record.destination.path);
          else if (name === 'open') {
            checkState(record); if (!openCommand || typeof openCommand.prepare !== 'function') throw fail('copy-open-unavailable');
            const prepared = await openCommand.prepare(record);
            openCheck = { transactionId: id, menuName: text(prepared.menuName), status: text(prepared.status) || 'ready' };
            await openEditor({ libraryName: record.destination.binding.expectedCurrentDatabase.DbName, projectName: record.plan.projectName });
          } else if (name === 'read-open') { checkState(record); await readOpen(record); } else if (name === 'inspect' && !TERMINAL.has(record.state) && !['prepared', 'preparing'].includes(record.state) && !(record.state === 'failed' && record.failedPhase === 'preparing')) { await readCheck(record, true); await readOpen(record, true); }
        }
      }
    } catch (failure) {
      error = MESSAGES[failure.code || failure.message] || 'The copy action could not be verified. Keep its retained records, close Resolve for file checks, and inspect recovery before continuing.';
      if (accepted && name === 'prepare' && uncertain) { try { await readInventory(); uncertain = false; } catch { /* Retain an uncertain preparation lock. */ } }
      if (accepted && selected) { try { install(await service.inspect(selected), selected); } catch { /* Retain the review lock and last trusted record. */ } }
    } finally { busy = false; }
    return changed();
  }
  return { action, getState, isReviewLocked };
}
module.exports = { createDesktopNativeReviewCopy };
