'use strict';

// Main-process only. The adapter owns editor exclusion, native field binding,
// preservation analysis, atomic replacement and editor observation. A reviewed
// plan or a renderer assertion cannot substitute for any of those operations.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');

const PROFILE = 'resolve-free-21.1.2-closed-name-v1';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const activeLocks = new Set();

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  fail('apply-invalid-json');
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function clone(value) { return JSON.parse(canonical(value)); }
function validatePlan(plan) {
  canonical(plan);
  if (plan?.schemaVersion !== 1 || plan.operation !== 'closed-project-name-apply-plan'
    || !HASH.test(plan.planId) || plan.adapterProfile !== PROFILE
    || !HASH.test(plan.source?.sha256) || !HASH.test(plan.source?.censusSha256)
    || !Number.isSafeInteger(plan.source?.bytes) || plan.source.bytes <= 0 || plan.source.bytes > 128 * 1024 * 1024
    || !HASH.test(plan.review?.planHash) || !HASH.test(plan.review?.auditHash)
    || !plan.sourceBindings || !Array.isArray(plan.review?.choices)
    || plan.edit?.kind !== 'video' || plan.edit?.field !== 'Name'
    || typeof plan.edit.oldName !== 'string' || !plan.edit.oldName.length
    || typeof plan.edit.newName !== 'string' || !plan.edit.newName.length
    || plan.edit.oldName === plan.edit.newName || plan.edit.newName.includes('\0')
    || ['projectId', 'projectName'].some(key => typeof plan[key] !== 'string' || !plan[key].length)
    || ['timelineId', 'itemId', 'trackId', 'sequenceId'].some(key => typeof plan.edit[key] !== 'string' || !plan.edit[key].length)
    || plan.mediaPolicy !== 'unchanged-references'
    || ['freshClosedSource', 'applicationSerializedPublication', 'fullCellComparison', 'editorReopen', 'postCloseValidation']
      .some(key => plan.requires?.[key] !== true)) fail('apply-unsupported-plan');
}
async function syncDirectory(directory) {
  const fd = await fs.open(directory, constants.O_RDONLY | NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function privateDirectory(directory, create = true) {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) fail('apply-private-directory-required');
  if (await fs.realpath(directory) !== directory) fail('apply-symlink-directory');
}
async function privateArtifact(filename) {
  const fd = await fs.open(filename, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024
      || (process.getuid && stat.uid !== process.getuid())) fail('apply-invalid-private-artifact');
  } finally { await fd.close(); }
}
async function privateRead(filename) {
  const fd = await fs.open(filename, constants.O_RDONLY | NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())
      || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) fail('apply-invalid-private-record');
    return await fd.readFile();
  } finally { await fd.close(); }
}
async function exclusiveWrite(filename, bytes) {
  const fd = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  await syncDirectory(path.dirname(filename));
}
async function syncArtifact(filename) {
  const handle = await fs.open(filename, constants.O_RDONLY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(filename));
}
function sameIdentity(a, b) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
}
async function inspectFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('apply-absolute-source-required');
  const resolved = await fs.realpath(filename);
  if (resolved !== path.resolve(filename)) fail('apply-symlink-source');
  const fd = await fs.open(filename, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.nlink !== 1) fail('apply-regular-single-link-file-required');
    const hash = createHash('sha256');
    for await (const chunk of fd.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await fd.stat(), named = await fs.lstat(filename);
    if (!sameIdentity(before, after) || !sameIdentity(after, named) || named.isSymbolicLink()) fail('apply-file-changed');
    return { path: resolved, sha256: hash.digest('hex'), bytes: before.size, dev: before.dev, ino: before.ino };
  } finally { await fd.close(); }
}
function exactFile(actual, expected) {
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail('apply-source-changed');
}
function sameOriginalFile(actual, expected) {
  exactFile(actual, expected);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail('apply-source-identity-changed');
}
function distinct(a, b) {
  if (a.path === b.path || (a.dev === b.dev && a.ino === b.ino)) fail('apply-distinct-file-required');
}

function createClosedProjectApplyTransaction({ directory, adapter, verifyPlan } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || typeof verifyPlan !== 'function'
    || ['inspectSource', 'createBackup', 'createCandidate', 'verifyPreservation', 'publish', 'verifyEditor']
      .some(method => typeof adapter?.[method] !== 'function')) fail('apply-trusted-adapter-required');
  directory = path.resolve(directory);
  let initialization;
  async function initialize() {
    if (!initialization) initialization = (async () => {
      await privateDirectory(directory);
      await privateDirectory(path.join(directory, 'locks'));
      const keyPath = path.join(directory, 'journal.key');
      try { await exclusiveWrite(keyPath, Buffer.from(randomUUID() + randomUUID())); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const key = await privateRead(keyPath);
      if (key.length !== 72) fail('apply-invalid-journal-key');
      return key;
    })();
    return initialization;
  }
  function transactionDirectory(id) {
    if (!ID.test(id)) fail('apply-invalid-transaction-id');
    return path.join(directory, id);
  }
  function signature(key, value) { return createHmac('sha256', key).update(canonical(value)).digest('hex'); }
  async function inspect(id) {
    const key = await initialize(), dir = transactionDirectory(id);
    await privateDirectory(dir, false);
    const files = (await fs.readdir(dir)).filter(name => /^\d{6}\.json$/.test(name)).sort();
    if (!files.length) fail('apply-missing-journal');
    let previous = null, result;
    for (let index = 0; index < files.length; index++) {
      if (files[index] !== `${String(index).padStart(6, '0')}.json`) fail('apply-invalid-journal-chain');
      let event;
      try { event = JSON.parse((await privateRead(path.join(dir, files[index]))).toString('utf8')); }
      catch (error) { if (error.code?.startsWith('apply-')) throw error; fail('apply-invalid-journal'); }
      const { mac, ...payload } = event;
      if (!HASH.test(mac) || !timingSafeEqual(Buffer.from(mac), Buffer.from(signature(key, payload)))
        || payload.index !== index || payload.previous !== previous
        || payload.record.transactionId !== id || payload.record.planHash !== digest(canonical(payload.record.plan))) fail('apply-invalid-journal-chain');
      validatePlan(payload.record.plan);
      previous = digest(canonical(event)); result = payload.record;
    }
    return { ...clone(result), journal: { events: files.length, head: previous } };
  }
  async function append(record, changes) {
    const key = await initialize();
    const { journal, ...current } = record;
    const next = { ...current, ...clone(changes), updatedAt: new Date().toISOString() };
    const payload = { index: journal?.events || 0, previous: journal?.head || null, record: next };
    const event = { ...payload, mac: signature(key, payload) };
    await exclusiveWrite(path.join(transactionDirectory(record.transactionId), `${String(payload.index).padStart(6, '0')}.json`), canonical(event));
    return { ...next, journal: { events: payload.index + 1, head: digest(canonical(event)) } };
  }
  async function lock(name, action) {
    await initialize();
    const filename = path.join(directory, 'locks', `${digest(name)}.lock`);
    if (activeLocks.has(filename)) fail('apply-operation-in-progress');
    activeLocks.add(filename);
    let held = false;
    try {
      try { await exclusiveWrite(filename, canonical({ pid: process.pid, token: randomUUID() })); held = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Stale lock removal is serialized by an exclusive reclaim file. A
        // crashed reclaimer is retained for manual review instead of guessed.
        const reclaim = `${filename}.reclaim`;
        let claim = false;
        try {
          await exclusiveWrite(reclaim, canonical({ pid: process.pid })); claim = true;
          const lease = JSON.parse((await privateRead(filename)).toString('utf8'));
          if (!Number.isSafeInteger(lease.pid) || lease.pid < 1) fail('apply-invalid-lock');
          try { process.kill(lease.pid, 0); fail('apply-operation-in-progress'); }
          catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
          await fs.unlink(filename);
          await exclusiveWrite(filename, canonical({ pid: process.pid, token: randomUUID() })); held = true;
        } finally { if (claim) await fs.unlink(reclaim); }
      }
      return await action();
    } finally {
      if (held) { await fs.unlink(filename); await syncDirectory(path.dirname(filename)); }
      activeLocks.delete(filename);
    }
  }
  async function source(record) {
    const located = await adapter.inspectSource({ plan: clone(record.plan), transactionId: record.transactionId });
    const actual = await inspectFile(located?.path);
    if (record.source && actual.path !== record.source.path) fail('apply-source-path-changed');
    return actual;
  }
  async function prepare(plan) {
    plan = clone(plan); validatePlan(plan);
    if (await verifyPlan(clone(plan)) !== true) fail('apply-plan-verification-failed');
    await initialize();
    const id = randomUUID(), dir = transactionDirectory(id);
    await fs.mkdir(dir, { mode: 0o700 }); await syncDirectory(directory);
    const record = { schemaVersion: 1, transactionId: id, state: 'prepared', plan, planHash: digest(canonical(plan)), createdAt: new Date().toISOString() };
    record.source = await source(record); exactFile(record.source, plan.source);
    return append(record, {});
  }
  async function failure(record, error, state = 'failed') {
    return append(record, { state, failedPhase: record.state, error: String(error.code || error.message || 'apply-failed').slice(0, 200) });
  }
  async function apply(id) {
    return lock(`transaction:${id}`, async () => {
      let record = await inspect(id);
      if (record.state !== 'prepared') fail('apply-already-started');
      return lock(`source:${record.source.path}`, async () => {
        try {
          if (await verifyPlan(clone(record.plan)) !== true) fail('apply-plan-verification-failed');
          sameOriginalFile(await source(record), record.source);
          record = await append(record, { state: 'backup-started' });
          const backup = await inspectFile((await adapter.createBackup({ plan: clone(record.plan), source: clone(record.source), directory: transactionDirectory(id), transactionId: id }))?.path);
          exactFile(backup, record.source); distinct(backup, record.source);
          if (!backup.path.startsWith(`${transactionDirectory(id)}${path.sep}`)) fail('apply-private-backup-required');
          await privateArtifact(backup.path); await syncArtifact(backup.path);
          record = await append(record, { state: 'backed-up', backup });
          sameOriginalFile(await source(record), record.source);
          record = await append(record, { state: 'candidate-started' });
          const candidate = await inspectFile((await adapter.createCandidate({ plan: clone(record.plan), backup: clone(backup), directory: transactionDirectory(id), transactionId: id }))?.path);
          distinct(candidate, backup); distinct(candidate, record.source);
          if (!candidate.path.startsWith(`${transactionDirectory(id)}${path.sep}`)) fail('apply-private-candidate-required');
          await privateArtifact(candidate.path); await syncArtifact(candidate.path);
          if (candidate.sha256 === backup.sha256) fail('apply-empty-candidate');
          const preservation = await adapter.verifyPreservation({ plan: clone(record.plan), backup: clone(backup), candidate: clone(candidate), transactionId: id });
          if (preservation?.verified !== true || preservation.planId !== record.plan.planId
            || preservation.sourceSha256 !== backup.sha256 || preservation.candidateSha256 !== candidate.sha256
            || preservation.changedFields !== 1 || !HASH.test(preservation.proofSha256)) fail('apply-preservation-unverified');
          exactFile(await inspectFile(backup.path), backup); exactFile(await inspectFile(candidate.path), candidate);
          record = await append(record, { state: 'candidate-verified', candidate, preservation: clone(preservation) });
          sameOriginalFile(await source(record), record.source);
          record = await append(record, { state: 'publishing' });
          const publication = await adapter.publish({ plan: clone(record.plan), sourcePath: record.source.path, expectedSource: clone(record.source), artifact: clone(candidate), direction: 'apply', transactionId: id });
          checkPublication(publication, record, 'apply', candidate);
          exactFile(await source(record), candidate);
          return await append(record, { state: 'pending-editor-validation', publication: clone(publication) });
        } catch (error) {
          await failure(record, error, record.state === 'publishing' ? 'publication-unverified' : 'failed'); throw error;
        }
      });
    });
  }
  function checkPublication(receipt, record, direction, expected) {
    if (receipt?.transactionId !== record.transactionId || receipt.planId !== record.plan.planId || receipt.direction !== direction
      || receipt.sourceSha256 !== expected.sha256 || receipt.atomic !== true || receipt.applicationSourceLockHeld !== true || receipt.editorOfflineRechecked !== true
      || receipt.concurrentWriterResistanceProven !== false || receipt.metadataPreserved !== true) fail('apply-publication-unverified');
  }
  async function recover(id) {
    const record = await inspect(id), actual = await source(record);
    if (record.backup) exactFile(await inspectFile(record.backup.path), record.backup);
    if (record.candidate) exactFile(await inspectFile(record.candidate.path), record.candidate);
    const original = actual.sha256 === record.source.sha256 && actual.bytes === record.source.bytes;
    const candidate = record.candidate && actual.sha256 === record.candidate.sha256 && actual.bytes === record.candidate.bytes;
    const rollback = ['rollback-publishing', 'pending-rollback-editor-validation', 'validating-rollback'].includes(record.state)
      || record.failedPhase === 'rollback-publishing' || record.failedPhase === 'validating-rollback';
    const classification = original ? (record.state === 'rolled-back' ? 'verified-rollback' : rollback ? 'original-needs-editor-validation' : 'original-safe-replan')
      : candidate ? (record.state === 'completed' ? 'verified-complete' : 'candidate-needs-editor-validation') : 'diverged-manual-review';
    return { ...record, recovery: { classification, mayRollback: !!candidate && !!record.backup && record.state !== 'rolled-back',
      mayValidate: (!!candidate && record.state !== 'completed' && !rollback) || (original && rollback), observedSha256: actual.sha256 } };
  }
  async function validate(id) {
    return lock(`transaction:${id}`, async () => {
      let record = await recover(id);
      if ((record.state === 'completed' && record.recovery.classification === 'verified-complete')
        || (record.state === 'rolled-back' && record.recovery.classification === 'verified-rollback')) {
        // A committed outcome is immutable. A retry returns its original ID,
        // timestamp and proof without rerunning the editor or appending history.
        delete record.recovery; return record;
      }
      if (!record.recovery.mayValidate) fail('apply-validation-not-ready');
      const direction = record.recovery.classification === 'original-needs-editor-validation' ? 'rollback' : 'apply';
      const expected = direction === 'rollback' ? record.source : record.candidate;
      return lock(`source:${record.source.path}`, async () => {
        delete record.recovery;
        try {
          exactFile(await source(record), expected);
          record = await append(record, { state: direction === 'rollback' ? 'validating-rollback' : 'validating-editor' });
          const proof = await adapter.verifyEditor({ plan: clone(record.plan), expectedSource: clone(expected), direction, transactionId: id });
          if (proof?.verified !== true || proof.closed !== true || proof.metadataPreserved !== true || !HASH.test(proof.proofSha256)
            || proof.transactionId !== id || proof.planId !== record.plan.planId || proof.direction !== direction
            || proof.sourceSha256 !== expected.sha256 || proof.projectId !== record.plan.projectId
            || proof.timelineId !== record.plan.edit.timelineId || proof.itemId !== record.plan.edit.itemId
            || proof.name !== (direction === 'rollback' ? record.plan.edit.oldName : record.plan.edit.newName)) fail('apply-editor-proof-unverified');
          exactFile(await source(record), expected);
          exactFile(await inspectFile(record.backup.path), record.backup);
          const resultingRevision = {
            schemaVersion: 1, kind: 'closed-project-native-revision', revisionId: expected.sha256,
            sourceSha256: expected.sha256, bytes: expected.bytes,
            parentSourceSha256: direction === 'rollback' ? record.candidate.sha256 : record.source.sha256,
            createdAt: new Date().toISOString(), transactionId: id, direction, planId: record.plan.planId,
            review: { planHash: record.plan.review.planHash, auditHash: record.plan.review.auditHash,
              choices: clone(record.plan.review.choices), sourceBindings: clone(record.plan.sourceBindings) },
            editorProofSha256: proof.proofSha256,
            backup: { path: record.backup.path, sha256: record.backup.sha256, bytes: record.backup.bytes }
          };
          return await append(record, { state: direction === 'rollback' ? 'rolled-back' : 'completed',
            editorProof: clone(proof), resultingRevision,
            nativeRevisions: [...(record.nativeRevisions || []), resultingRevision] });
        } catch (error) { await failure(record, error, 'validation-failed'); throw error; }
      });
    });
  }
  async function rollback(id) {
    return lock(`transaction:${id}`, async () => {
      let record = await recover(id);
      if (!record.recovery.mayRollback) fail('apply-rollback-not-ready');
      return lock(`source:${record.source.path}`, async () => {
        delete record.recovery;
        try {
          exactFile(await source(record), record.candidate);
          exactFile(await inspectFile(record.backup.path), record.backup);
          record = await append(record, { state: 'rollback-publishing' });
          const expectedSource = await source(record);
          exactFile(expectedSource, record.candidate);
          const publication = await adapter.publish({ plan: clone(record.plan), sourcePath: record.source.path, expectedSource, artifact: clone(record.backup), direction: 'rollback', transactionId: id });
          checkPublication(publication, record, 'rollback', record.source);
          exactFile(await source(record), record.source);
          return await append(record, { state: 'pending-rollback-editor-validation', rollbackPublication: clone(publication) });
        } catch (error) { await failure(record, error, 'publication-unverified'); throw error; }
      });
    });
  }
  async function listTransactionIds() {
    await initialize();
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && ID.test(entry.name)).map(entry => entry.name).sort();
  }
  async function list() {
    const records = [];
    for (const id of await listTransactionIds()) {
      try { records.push(await inspect(id)); }
      catch (error) { records.push({ schemaVersion: 1, transactionId: id, state: 'unreadable', error: String(error.code || error.message) }); }
    }
    return records;
  }
  async function cancel(id) {
    return lock(`transaction:${id}`, async () => {
      const record = await inspect(id);
      if (record.state !== 'prepared') fail('apply-cancellation-not-ready');
      return append(record, { state: 'cancelled' });
    });
  }
  return Object.freeze({ prepare, apply, validate, recover, rollback, inspect, listTransactionIds, list, cancel });
}

module.exports = { createClosedProjectApplyTransaction };
