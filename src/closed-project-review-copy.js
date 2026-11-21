'use strict';

// Trusted main-process service. A review copy keeps the source UUID graph in a
// different configured disk library; no import, source mutation or ID guessing.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify, isDeepStrictEqual } = require('node:util');
const { createClosedProjectApplyAdapter } = require('./closed-project-apply-adapter');
const { createClosedProjectOfflineGuard, assertSameClosedProjectObservation } = require('./closed-project-apply-offline-guard');
const bindingDefault = require('./closed-project-apply-source-binding');
const nativeDefault = require('./closed-project-native-store');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value);
const detached = value => JSON.parse(json(value));
const need = (value, code) => { if (!value) throw Object.assign(Error(`review-copy-${code}`), { code: `review-copy-${code}` }); };
const active = new Set();
async function syncDirectory(directory) { const h = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await h.sync(); } finally { await h.close(); } }
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  need(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077)
    && await fs.realpath(directory) === directory, 'private-directory-required');
}
async function readFile(filename, privateMode = true) {
  need(path.isAbsolute(filename) && await fs.realpath(filename) === filename, 'canonical-file-required');
  const h = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await h.stat({ bigint: true });
    need(before.isFile() && before.nlink === 1n && Number(before.uid) === process.getuid()
      && before.size <= 128n * 1024n * 1024n && (!privateMode || !(Number(before.mode) & 0o077)), 'file-unsafe');
    const bytes = await h.readFile();
    const same = after => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => before[k] === after[k]);
    need(bytes.length === Number(before.size) && same(await h.stat({ bigint: true })) && same(await fs.lstat(filename, { bigint: true })), 'file-changed');
    return bytes;
  } finally { await h.close(); }
}
async function exclusiveWrite(filename, bytes) {
  const h = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
  await syncDirectory(path.dirname(filename));
}
async function missing(filename) { try { await fs.lstat(filename); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } }
const directoryIdentity = s => ({ device: String(s.dev), inode: String(s.ino), uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 });

function createClosedProjectReviewCopy({ directory, getCurrentReview, getSyncBase, mediaPolicy,
  guard = createClosedProjectOfflineGuard(), sourceBindingService = bindingDefault, nativeStore = nativeDefault,
  originalAdapter, verifyEditor, execFile: run = promisify(execFile), onCheckpoint = async () => {} } = {}) {
  need(path.isAbsolute(directory || '') && [getCurrentReview, getSyncBase, mediaPolicy, onCheckpoint].every(f => typeof f === 'function'), 'trusted-host-required');
  const adapters = new Map();
  function sourceAdapter(namespace = null) {
    if (originalAdapter) return originalAdapter;
    need(namespace === null || HASH.test(namespace), 'source-plan-namespace-invalid');
    const key = namespace || 'legacy';
    if (!adapters.has(key)) adapters.set(key, createClosedProjectApplyAdapter({ directory: namespace
      ? path.join(directory, 'source-plans', namespace) : path.join(directory, 'source-plans'), getCurrentReview, guard, sourceBindingService, nativeStore }));
    return adapters.get(key);
  }
  let initialization;
  function dir(id) { need(ID.test(id || ''), 'transaction-id-invalid'); return path.join(directory, 'transactions', id); }
  async function initialize() {
    initialization ||= (async () => {
      await privateDirectory(directory); await privateDirectory(path.join(directory, 'transactions')); await privateDirectory(path.join(directory, 'locks'));
      const filename = path.join(directory, 'journal.key');
      try { await exclusiveWrite(filename, randomBytes(32)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const key = await readFile(filename); need(key.length === 32, 'journal-key-invalid'); return key;
    })();
    return initialization;
  }
  const mac = (key, value) => createHmac('sha256', key).update(json(value)).digest('hex');
  async function inspect(id) {
    const key = await initialize(), folder = dir(id); need(await fs.realpath(folder) === folder, 'journal-directory-invalid');
    const stat = await fs.lstat(folder); need(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'journal-directory-invalid');
    const files = (await fs.readdir(folder)).filter(n => /^\d{6}\.json$/.test(n)).sort(); need(files.length > 0, 'journal-missing');
    let previous = null, last;
    for (let n = 0; n < files.length; n++) {
      need(files[n] === `${String(n).padStart(6, '0')}.json`, 'journal-sequence-invalid');
      const bytes = await readFile(path.join(folder, files[n])), event = JSON.parse(bytes), { authentication, ...payload } = event;
      need(HASH.test(authentication || '') && timingSafeEqual(Buffer.from(authentication), Buffer.from(mac(key, payload)))
        && payload.previous === previous && payload.index === n && payload.record.transactionId === id, 'journal-invalid');
      previous = sha(bytes); last = payload.record;
    }
    return { ...detached(last), journal: { events: files.length, head: previous } };
  }
  async function append(record, changes) {
    const key = await initialize(), { journal, ...base } = record;
    const next = { ...base, ...detached(changes), updatedAt: new Date().toISOString() };
    const payload = { index: journal?.events || 0, previous: journal?.head || null, record: next };
    const bytes = Buffer.from(json({ ...payload, authentication: mac(key, payload) }));
    await exclusiveWrite(path.join(dir(record.transactionId), `${String(payload.index).padStart(6, '0')}.json`), bytes);
    return { ...next, journal: { events: payload.index + 1, head: sha(bytes) } };
  }
  async function lock(names, action) {
    await initialize(); const held = [];
    try {
      for (const name of [...new Set(names)].sort()) {
        const filename = path.join(directory, 'locks', `${sha(name)}.lock`);
        need(!active.has(filename), 'operation-in-progress'); active.add(filename);
        let owned = false;
        try {
          try { await exclusiveWrite(filename, json({ pid: process.pid, token: randomUUID() })); owned = true; }
          catch (e) {
            if (e.code !== 'EEXIST') throw e;
            const reclaim = `${filename}.reclaim`; await exclusiveWrite(reclaim, json({ pid: process.pid }));
            try {
              const lease = JSON.parse(await readFile(filename)); need(Number.isSafeInteger(lease.pid) && lease.pid > 0, 'lock-invalid');
              try { process.kill(lease.pid, 0); need(false, 'operation-in-progress'); } catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
              await fs.unlink(filename); await exclusiveWrite(filename, json({ pid: process.pid, token: randomUUID() })); owned = true;
            } finally { await fs.unlink(reclaim); }
          }
          held.push(filename);
        } finally { if (!owned) active.delete(filename); }
      }
      return await action();
    } finally { for (const filename of held.reverse()) { await fs.unlink(filename); active.delete(filename); await syncDirectory(path.dirname(filename)); } }
  }
  async function destination(sourceBinding, root, projectName) {
    need(path.isAbsolute(root || '') && await fs.realpath(root) === root && root !== sourceBinding.libraryRoot, 'different-canonical-library-required');
    const config = await readFile(sourceBinding.configPath, false); need(sha(config) === sourceBinding.configSha256, 'configuration-changed');
    const matches = bindingDefault.parseDiskLibraryConfig(config).filter(v => v.libraryRoot === root); need(matches.length === 1, 'destination-library-unconfigured');
    const selected = config.toString('utf8').trimEnd().split('\n').map(line => line.split(':')).filter(parts => parts[2] === '*');
    need(selected.length === 1 && selected[0][1] === root, 'destination-library-not-selected');
    const guest = path.join(root, 'Resolve Projects', 'Users', 'guest'), projects = path.join(guest, 'Projects');
    const projectsMissingInitially = await missing(projects);
    for (const p of [root, guest, ...(projectsMissingInitially ? [] : [projects])]) { const s = await fs.lstat(p); need(s.isDirectory() && s.uid === process.getuid() && await fs.realpath(p) === p, 'destination-library-unsafe'); }
    if (projectsMissingInitially) { const userDatabase = await fs.lstat(path.join(guest, 'User.db')); need(userDatabase.isFile() && !userDatabase.isSymbolicLink() && userDatabase.uid === process.getuid(), 'destination-library-unsafe'); }
    if (guard.inspectAccessBoundary) await guard.inspectAccessBoundary(projectsMissingInitially ? guest : projects);
    const projectDirectory = path.join(projects, projectName), filename = path.join(projectDirectory, 'Project.db');
    return { path: filename, projectDirectory, libraryRoot: root, projectsDirectory: projects, projectsMissingInitially, guestDirectory: guest, guestIdentity: directoryIdentity(await fs.lstat(guest)),
      projectsIdentity: projectsMissingInitially ? null : directoryIdentity(await fs.lstat(projects)), binding: { ...sourceBinding, sourcePath: filename,
        libraryRoot: root, expectedCurrentDatabase: { DbType: 'Disk', DbName: matches[0].name } } };
  }
  async function policy(record, censusBytes) {
    const result = await mediaPolicy({ plan: record.plan, sourcePath: record.original.path, sourceBinding: record.original.binding,
      censusBytes, destinationLibraryRoot: record.destination.libraryRoot });
    need(result?.verified === true && result.policy === 'unchanged-references' && result.sourceSha256 === record.plan.source.sha256
      && HASH.test(result.bindingSha256 || ''), 'media-policy-unverified'); return detached(result);
  }
  async function originalUnchanged(record) {
    const observation = await guard.inspect({ sourcePath: record.original.path, expectedSourceHash: record.original.sha256 });
    need(isDeepStrictEqual(observation.metadata, record.original.metadata), 'original-metadata-changed');
    need(isDeepStrictEqual(observation.identity, record.original.identity), 'original-identity-changed');
    need(isDeepStrictEqual(await getSyncBase(record.plan.projectId), record.syncBase), 'sync-base-changed');
    const current = await sourceBindingService.prepareClosedProjectSourceBinding({ sourcePath: record.original.path, projectName: record.plan.projectName });
    need(isDeepStrictEqual(current, record.original.binding), 'source-library-changed');
    return observation;
  }
  async function prepare({ review, sourcePath, destinationLibraryRoot } = {}) {
    await initialize(); review ||= await getCurrentReview();
    const binding = await sourceBindingService.prepareClosedProjectSourceBinding({ sourcePath, projectName: JSON.parse(review.sources.local).project_name });
    const sourcePlanNamespace = originalAdapter ? null : binding.configSha256, adapter = sourceAdapter(sourcePlanNamespace);
    const plan = await adapter.createPlan({ review, source: sourcePath });
    need(await adapter.verifyPlan(plan) === true, 'review-unverified');
    const target = await destination(binding, destinationLibraryRoot, plan.projectName);
    return lock([`source:${sourcePath}`, `destination:${target.path}`], async () => {
      need(await missing(target.projectDirectory), 'destination-exists');
      const observation = await guard.inspect({ sourcePath, expectedSourceHash: plan.source.sha256 });
      const transactionId = randomUUID(), folder = dir(transactionId); await privateDirectory(folder);
      let record = await append({ schemaVersion: 1, operation: 'closed-project-review-copy', mode: 'review-copy', transactionId, state: 'preparing', plan, sourcePlanNamespace,
        original: { path: sourcePath, sha256: plan.source.sha256, bytes: plan.source.bytes, metadata: observation.metadata, identity: observation.identity, observation, binding },
        destination: target, candidate: null, snapshot: null, preservation: null, mediaPolicy: null,
        timelineIds: JSON.parse(review.sources.local).timelines.map(t => t.id).sort(), syncBase: detached(await getSyncBase(plan.projectId)), createdAt: new Date().toISOString() }, {});
      try {
        await onCheckpoint('preparation-intent', detached(record));
        const snapshotDirectory = path.join(folder, 'snapshot'); await privateDirectory(snapshotDirectory);
        const captured = await nativeStore.inspectClosedDatabase({ sourcePath, directory: snapshotDirectory, projectId: plan.projectId, projectName: plan.projectName });
        need(sha(captured.databaseBytes) === plan.source.sha256, 'source-capture-changed');
        const candidateDirectory = path.join(folder, 'candidate'); await privateDirectory(candidateDirectory);
        const result = await nativeStore.createNameCandidate({ snapshotPath: captured.snapshotPath, directory: candidateDirectory, plan });
        const candidateBytes = await readFile(result.candidatePath), candidate = { path: result.candidatePath, sha256: sha(candidateBytes), bytes: candidateBytes.length };
        const comparisonDirectory = path.join(folder, 'comparison'); await privateDirectory(comparisonDirectory);
        const preservation = await nativeStore.compareNameCandidate({ plan, backup: { path: captured.snapshotPath, sha256: plan.source.sha256 }, candidate, directory: comparisonDirectory });
        need(preservation.verified === true && preservation.changedFields === 1 && preservation.planId === plan.planId, 'preservation-unverified');
        const policyRecord = await policy(record, captured.censusBytes);
        assertSameClosedProjectObservation(observation, await originalUnchanged(record));
        record = await append(record, { state: 'prepared', candidate, preservation, mediaPolicy: policyRecord,
          snapshot: { path: captured.snapshotPath, censusPath: captured.censusPath, sha256: plan.source.sha256 } });
        return record;
      } catch (e) { await append(record, { state: 'failed', failedPhase: 'preparing', error: String(e.code || e.message).slice(0, 200) }); throw e; }
    });
  }
  async function preserveMetadata(filename, expected) {
    const h = await fs.open(filename, constants.O_RDWR | constants.O_NOFOLLOW);
    try { const s = await h.stat(); if (s.uid !== expected.uid || s.gid !== expected.gid) await h.chown(expected.uid, expected.gid); await h.chmod(expected.mode); await h.sync(); } finally { await h.close(); }
    need(typeof guard.inspectFileMetadata === 'function', 'metadata-observer-required');
    const current = await guard.inspectFileMetadata(filename);
    async function xattr(args) { const r = await run('/usr/bin/xattr', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 }); need(r.stdout === '' && r.stderr === '', 'metadata-write-unverified'); }
    for (const a of current.extendedAttributes) if (!expected.extendedAttributes.some(e => e.name === a.name)) await xattr(['-d', a.name, filename]);
    for (const a of expected.extendedAttributes) if (!current.extendedAttributes.some(e => e.name === a.name && e.valueHex === a.valueHex)) await xattr(['-wx', a.name, a.valueHex, filename]);
    need(isDeepStrictEqual(await guard.inspectFileMetadata(filename), expected), 'metadata-not-preserved');
    const synced = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); try { await synced.sync(); } finally { await synced.close(); }
  }
  async function publish(id) {
    return lock([`transaction:${id}`], async () => {
      let record = await inspect(id); need(record.state === 'prepared', 'already-started');
      return lock([`source:${record.original.path}`, `destination:${record.destination.path}`], async () => {
        try {
          need(await sourceAdapter(record.sourcePlanNamespace || null).verifyPlan(record.plan) === true, 'review-unverified'); await originalUnchanged(record);
          const target = await destination(record.original.binding, record.destination.libraryRoot, record.plan.projectName);
          need(isDeepStrictEqual(target, record.destination) && await missing(target.projectDirectory), 'destination-changed');
          const freshPolicy = await policy(record, await readFile(record.snapshot.censusPath)); need(freshPolicy.bindingSha256 === record.mediaPolicy.bindingSha256, 'media-policy-changed');
          const bytes = await readFile(record.candidate.path); need(sha(bytes) === record.candidate.sha256 && bytes.length === record.candidate.bytes, 'candidate-changed');
          need(sha(await readFile(record.snapshot.path)) === record.original.sha256, 'snapshot-changed');
          record = await append(record, { state: 'publishing' }); await onCheckpoint('publication-intent', detached(record));
          // Exclusive directory creation is the no-overwrite boundary. Incomplete
          // owned output is retained after interruption; no automatic deletion.
          if (target.projectsMissingInitially) {
            need(isDeepStrictEqual(target.guestIdentity, directoryIdentity(await fs.lstat(target.guestDirectory))), 'destination-library-changed');
            await fs.mkdir(target.projectsDirectory, { mode: 0o700 }); await syncDirectory(target.guestDirectory);
            record = await append(record, { ownedProjectsDirectoryIdentity: directoryIdentity(await fs.lstat(target.projectsDirectory)) });
          }
          await fs.mkdir(target.projectDirectory, { mode: 0o700 }); await syncDirectory(target.projectsDirectory);
          const identity = directoryIdentity(await fs.lstat(target.projectDirectory));
          record = await append(record, { ownedDirectoryIdentity: identity }); await onCheckpoint('directory-created', detached(record));
          const stagedPath = path.join(target.projectDirectory, `.frameline-review-${randomBytes(16).toString('hex')}.stage`);
          await exclusiveWrite(stagedPath, bytes); await preserveMetadata(stagedPath, record.original.metadata);
          await originalUnchanged(record);
          need(isDeepStrictEqual(identity, directoryIdentity(await fs.lstat(target.projectDirectory))) && await missing(target.path)
            && isDeepStrictEqual((await fs.readdir(target.projectDirectory)).sort(), [path.basename(stagedPath)]), 'output-directory-changed');
          need(sha(await readFile(stagedPath, false)) === record.candidate.sha256, 'staged-candidate-changed');
          // Link is atomic and never replaces an existing pathname, unlike rename
          // onto a potentially raced destination. Remove only our staging alias.
          await fs.link(stagedPath, target.path); await fs.unlink(stagedPath); await syncDirectory(target.projectDirectory);
          await onCheckpoint('file-published', detached(record));
          const copied = await guard.inspect({ sourcePath: target.path, expectedSourceHash: record.candidate.sha256 });
          need(isDeepStrictEqual(copied.metadata, record.original.metadata), 'copy-metadata-changed');
          await originalUnchanged(record);
          return append(record, { state: 'published-awaiting-editor', copyObservation: copied, publication: { exclusive: true, metadataPreserved: true,
            originalUnchanged: true, syncBaseUnchanged: true, concurrentWriterResistanceProven: false } });
        } catch (e) {
          await append(record, { state: record.state === 'publishing' ? 'publication-unverified' : 'failed', failedPhase: record.state,
            error: String(e.code || e.message).slice(0, 200) }); throw e;
        }
      });
    });
  }
  async function recover(id) {
    const record = await inspect(id); await originalUnchanged(record);
    const target = record.destination;
    let classification = 'destination-absent', mayValidate = false;
    if (!await missing(target.projectDirectory)) {
      const owned = record.ownedDirectoryIdentity && isDeepStrictEqual(record.ownedDirectoryIdentity, directoryIdentity(await fs.lstat(target.projectDirectory)));
      classification = owned ? 'incomplete-owned-copy' : 'unowned-or-diverged-copy';
      if (owned && !await missing(target.path)) {
        try {
          const copied = await guard.inspect({ sourcePath: target.path, expectedSourceHash: record.candidate.sha256 });
          need(isDeepStrictEqual(copied.metadata, record.original.metadata), 'copy-metadata-changed');
          classification = record.state === 'completed' ? 'verified-complete' : 'candidate-needs-editor-validation'; mayValidate = record.state !== 'completed';
        } catch { classification = 'unowned-or-diverged-copy'; }
      }
    }
    return { ...record, recovery: { classification, mayValidate, originalUnchanged: true, syncBaseUnchanged: true, neverReplayPublication: record.state !== 'prepared' } };
  }
  async function validate(id) {
    need(typeof verifyEditor === 'function', 'editor-verifier-required');
    return lock([`transaction:${id}`], async () => {
      let record = await recover(id); if (record.state === 'completed') return record;
      need(record.recovery.mayValidate, 'validation-not-ready');
      return lock([`source:${record.original.path}`, `destination:${record.destination.path}`], async () => {
        try {
          const proof = await verifyEditor({ record: detached(record) });
          need(proof?.verified === true && proof.transactionId === record.transactionId && proof.planId === record.plan.planId
            && proof.closed === true && proof.actualOpenFileBindingVerified === true
            && proof.sourceSha256 === record.candidate.sha256 && proof.metadataPreserved === true && HASH.test(proof.proofSha256 || '')
            && proof.projectId === record.plan.projectId && proof.timelineId === record.plan.edit.timelineId
            && proof.itemId === record.plan.edit.itemId && proof.name === record.plan.edit.newName, 'editor-proof-unverified');
          const observed = await guard.inspect({ sourcePath: record.destination.path, expectedSourceHash: record.candidate.sha256 });
          need(isDeepStrictEqual(observed.metadata, record.original.metadata), 'copy-metadata-changed'); await originalUnchanged(record);
          delete record.recovery;
          return append(record, { state: 'completed', editorProof: detached(proof), resultingRevision: { revisionId: record.candidate.sha256,
            parentSourceSha256: record.original.sha256, planId: record.plan.planId, mode: 'review-copy', projectId: record.plan.projectId,
            destinationLibraryName: record.destination.binding.expectedCurrentDatabase.DbName, proofSha256: proof.proofSha256,
            completedAt: new Date().toISOString() }, originalUnchanged: true, syncBaseUnchanged: true });
        } catch (e) { await append(record, { state: 'validation-failed', error: String(e.code || e.message).slice(0, 200) }); throw e; }
      });
    });
  }
  async function cancel(id) {
    return lock([`transaction:${id}`], async () => {
      const record = await inspect(id); need(record.state === 'prepared' || record.state === 'preparing' || (record.state === 'failed' && record.failedPhase === 'preparing'), 'cancellation-not-ready');
      need(await missing(record.destination.projectDirectory), 'destination-exists');
      return append(record, { state: 'cancelled', sourceDatabaseWritten: false });
    });
  }
  async function listTransactionIds() { await initialize(); return (await fs.readdir(path.join(directory, 'transactions'), { withFileTypes: true })).filter(e => e.isDirectory() && ID.test(e.name)).map(e => e.name).sort(); }
  return { prepare, publish, inspect, recover, validate, cancel, listTransactionIds };
}
module.exports = { createClosedProjectReviewCopy };
