'use strict';
// Host-owned identity ledger for closed native checkpoints. A library/path is a
// separate lineage even if its editor UUIDs were copied. Only a verified copy
// transaction may join that lineage to an existing comparison ancestry.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createClosedProjectOfflineGuard, assertSameClosedProjectObservation } = require('./closed-project-apply-offline-guard');
const defaultNative = { ...require('./closed-project-native-store'), ...require('./native-project-identity') };
const defaultBindings = require('./closed-project-apply-source-binding');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const need = (value, code) => { if (!value) throw Object.assign(Error(`checkpoint-${code}`), { code: `checkpoint-${code}` }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const json = value => JSON.stringify(canonical(value));
const detached = value => JSON.parse(json(value));
const digest = value => sha(json(value));
async function syncDirectory(directory) { const h = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await h.sync(); } finally { await h.close(); } }
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const s = await fs.lstat(directory);
  need(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & 0o077)
    && await fs.realpath(directory) === directory, 'private-directory-required');
}
async function privateRead(filename, max = 128 * 1024 * 1024) {
  const h = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const before = await h.stat({ bigint: true }); need(before.isFile() && before.nlink === 1n && Number(before.uid) === process.getuid()
      && !(Number(before.mode) & 0o077) && before.size > 0n && before.size <= BigInt(max), 'private-file-required');
    const bytes = await h.readFile(), after = await h.stat({ bigint: true }), named = await fs.lstat(filename, { bigint: true });
    need(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => before[k] === after[k] && before[k] === named[k]) && bytes.length === Number(before.size), 'private-file-changed'); return bytes;
  } finally { await h.close(); }
}
async function exclusiveWrite(filename, bytes) {
  const h = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); } await syncDirectory(path.dirname(filename));
}
function nativeGraph(census) {
  need(census?.operation === 'native-sqlite-all-cell-census' && census.integrityCheck === 'ok'
    && census.allPersistentTablesCovered === true && census.allSchemaObjectsCovered === true && Array.isArray(census.excludedApplicationColumns)
    && census.excludedApplicationColumns.length === 0 && Array.isArray(census.tables) && ID.test(census.projectContext?.projectId || ''), 'complete-census-required');
  const graph = [], byKind = new Map();
  function rows(name, key) { const matches = census.tables.filter(t => t.name === name); need(matches.length === 1, 'identity-table-required'); const t = matches[0];
    need(Array.isArray(t.columns) && new Set(t.columns).size === t.columns.length && t.primaryKeyColumns?.length === 1 && t.primaryKeyColumns[0].name === key && Array.isArray(t.rows), 'identity-primary-key-required');
    const index = t.columns.indexOf(key); need(index >= 0, 'identity-column-required');
    function text(row, name, nullable = false) { const ci = t.columns.indexOf(name); need(ci >= 0 && row.cells?.length === t.columns.length, 'identity-column-required'); const v = row.cells[ci];
      if (nullable && v.type === 'null') return null;
      need(v.type === 'text' && typeof v.base64 === 'string', 'identity-text-required'); const b = Buffer.from(v.base64, 'base64'), s = b.toString('utf8');
      need(b.toString('base64') === v.base64 && Buffer.from(s).equals(b), 'identity-text-encoding'); return s;
    }
    const result = [], seen = new Set();
    for (const r of t.rows) { const id = text(r, key); need(ID.test(id) && !seen.has(id) && isDeepStrictEqual(r.primaryKey, [r.cells[index]]), 'identity-collision'); seen.add(id); result.push({ row: r, id, text: (name, nullable) => text(r, name, nullable) }); }
    return result;
  }
  function add(kind, nativeId, parentKind, parentNativeId, dbType) { need(typeof dbType === 'string' && dbType.length > 0, 'identity-type-required');
    const entity = { kind, nativeId, parentKind, parentNativeId, dbType }; graph.push(entity); if (!byKind.has(kind)) byKind.set(kind, new Map()); need(!byKind.get(kind).has(nativeId), 'identity-collision'); byKind.get(kind).set(nativeId, entity); return entity;
  }
  const projects = rows('SM_Project', 'SM_Project_id'); need(projects.length === 1 && projects[0].id === census.projectContext.projectId, 'project-identity-mismatch');
  need(projects[0].text('ProjectName') === census.projectContext.projectName && projects[0].text('DbType') === 'SM_Project', 'project-context-mismatch');
  add('project', projects[0].id, null, null, 'SM_Project');
  const timelines = rows('Sm2Timeline', 'Sm2Timeline_id'), sequences = rows('Sm2Sequence', 'Sm2Sequence_id'); const timelineSequences = new Map();
  for (const t of timelines) { const seq = t.text('Sequence'); need(ID.test(seq) && !timelineSequences.has(seq), 'sequence-binding-invalid'); timelineSequences.set(seq, t.id); add('timeline', t.id, 'project', projects[0].id, t.text('DbType')); }
  need(sequences.length === timelines.length, 'sequence-coverage-invalid');
  for (const s of sequences) { const parent = s.text('Parent'); need(timelineSequences.get(s.id) === parent, 'sequence-parent-invalid'); add('sequence', s.id, 'timeline', parent, s.text('DbType')); }
  for (const t of rows('Sm2TiTrack', 'Sm2TiTrack_id')) { const sequence = t.text('Sequence'); need(byKind.get('sequence')?.has(sequence), 'track-parent-invalid'); add('track', t.id, 'sequence', sequence, t.text('DbType')); }
  for (const i of rows('Sm2TiItem', 'Sm2TiItem_id')) { const track = i.text('Sm2TiTrack_id'); need(byKind.get('track')?.has(track), 'item-parent-invalid'); add('item', i.id, 'track', track, i.text('DbType')); }
  return graph.sort((a, b) => `${a.kind}:${a.nativeId}`.localeCompare(`${b.kind}:${b.nativeId}`));
}
function createClosedProjectCheckpointStore({ directory, guard = createClosedProjectOfflineGuard(), sourceBindingService = defaultBindings,
  nativeStore = defaultNative, verifyCopyLineage = null, onCheckpoint = async () => {} } = {}) {
  need(path.isAbsolute(directory || '') && typeof guard?.inspect === 'function' && typeof sourceBindingService?.prepareClosedProjectSourceBinding === 'function'
    && typeof nativeStore?.inspectClosedDatabase === 'function' && (verifyCopyLineage === null || typeof verifyCopyLineage === 'function') && typeof onCheckpoint === 'function', 'trusted-store-required');
  let initialization;
  async function initialize() { initialization ||= (async () => { await privateDirectory(directory); await privateDirectory(path.join(directory, 'checkpoints')); const p = path.join(directory, 'identity.key');
    try { await exclusiveWrite(p, randomBytes(32)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const key = await privateRead(p, 32); need(key.length === 32, 'key-invalid'); return key; })(); return initialization; }
  const mac = (key, body) => createHmac('sha256', key).update(body).digest('hex');
  async function authenticatedWrite(p, value) { const body = json(value); need(Buffer.byteLength(body) <= 24 * 1024 * 1024, 'capacity-exceeded'); const key = await initialize(); await exclusiveWrite(p, json({ body, authentication: mac(key, body) })); }
  async function authenticatedRead(p) { const value = JSON.parse(await privateRead(p, 32 * 1024 * 1024)), key = await initialize(); need(typeof value.body === 'string' && SHA.test(value.authentication || '')
      && timingSafeEqual(Buffer.from(value.authentication), Buffer.from(mac(key, value.body))), 'authentication-invalid'); return JSON.parse(value.body); }
  async function state() { await initialize(); const files = (await fs.readdir(directory)).filter(n => /^state-\d{6}\.json$/.test(n)).sort(); let previous = null, result = { schemaVersion: 1, checkpoints: [], lineages: {} };
    for (let n = 0; n < files.length; n++) { need(files[n] === `state-${String(n).padStart(6, '0')}.json`, 'state-chain-invalid'); const value = await authenticatedRead(path.join(directory, files[n]));
      need(value.index === n && value.previous === previous && value.state.schemaVersion === 1 && Array.isArray(value.state.checkpoints) && value.state.checkpoints.length === n + 1, 'state-chain-invalid');
      const seen = new Set(); for (const entry of value.state.checkpoints) { need(ID.test(entry.checkpointId) && ID.test(entry.lineageId) && SHA.test(entry.recordHash) && !seen.has(entry.checkpointId), 'state-invalid'); seen.add(entry.checkpointId); }
      if (n) need(isDeepStrictEqual(value.state.checkpoints.slice(0, -1), result.checkpoints), 'state-history-changed');
      result = value.state; previous = sha(await privateRead(path.join(directory, files[n])));
    }
    need(files.length <= 10000, 'capacity-exceeded'); return { ...result, index: files.length, previous };
  }
  function checkpointDirectory(id) { need(ID.test(id || ''), 'id-invalid'); return path.join(directory, 'checkpoints', id); }
  async function inspectWithState(id, s) { const entry = s.checkpoints.find(e => e.checkpointId === id); need(entry, 'not-found'); const p = path.join(checkpointDirectory(id), 'record.json'), record = await authenticatedRead(p);
    need(digest(record) === entry.recordHash && record.checkpointId === id && record.lineageId === entry.lineageId, 'record-binding-invalid'); return detached(record); }
  async function inspect(id) { return inspectWithState(id, await state()); }
  async function readCheckpoint(id) { const record = await inspect(id), dir = checkpointDirectory(id), databaseBytes = await privateRead(path.join(dir, 'capture', 'source.db')),
      censusBytes = await privateRead(path.join(dir, 'capture', 'source.db.census.json'), 24 * 1024 * 1024); need(sha(databaseBytes) === record.source.sha256 && databaseBytes.length === record.source.bytes && sha(censusBytes) === record.source.censusSha256, 'artifact-changed');
    const census = JSON.parse(censusBytes); need(isDeepStrictEqual(nativeGraph(census), record.nativeGraph) && census.snapshot.sha256 === record.source.sha256 && census.snapshot.size === record.source.bytes, 'graph-binding-invalid'); return { record, databaseBytes, censusBytes, census }; }
  async function list() { const s = await state(); return Promise.all(s.checkpoints.map(e => inspectWithState(e.checkpointId, s))); }
  async function verifyCurrent(id) { const record = await inspect(id), binding = await sourceBindingService.prepareClosedProjectSourceBinding({ sourcePath: record.scope.projectPath, projectName: record.projectName });
    need(isDeepStrictEqual(binding, record.binding), 'source-library-changed'); const observed = await guard.inspect({ sourcePath: record.scope.projectPath, expectedSourceHash: record.source.sha256 });
    need(isDeepStrictEqual(observed.metadata, record.observation.metadata), 'source-metadata-changed'); return observed; }
  async function isAncestor(base, from) { const s = await state(), seen = new Set(); need(ID.test(base || '') && ID.test(from || '') && s.checkpoints.some(e => e.checkpointId === base) && s.checkpoints.some(e => e.checkpointId === from), 'not-found'); let current = from; while (current) { if (current === base) return true; need(!seen.has(current), 'ancestry-cycle'); seen.add(current); const r = await inspectWithState(current, s); current = r.parentCheckpointId || r.forkParentCheckpointId; } return false; }
  async function lock(action) { await initialize(); const p = path.join(directory, 'capture.lock'), token = randomUUID(); let held = false;
    try { try { await exclusiveWrite(p, json({ pid: process.pid, token })); held = true; } catch (e) { if (e.code !== 'EEXIST') throw e;
      const reclaim = p + '.reclaim'; await exclusiveWrite(reclaim, token); try { const old = JSON.parse(await privateRead(p, 4096)); need(Number.isSafeInteger(old.pid) && old.pid > 0, 'lock-invalid');
        let dead = false; try { process.kill(old.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; } need(dead, 'capture-busy'); await fs.unlink(p); await exclusiveWrite(p, json({ pid: process.pid, token })); held = true;
      } finally { await fs.unlink(reclaim); } }
      return await action();
    } finally { if (held) { const lease = JSON.parse(await privateRead(p, 4096)); need(lease.token === token, 'lock-changed'); await fs.unlink(p); await syncDirectory(directory); } }
  }
  async function capture({ sourcePath, projectId, projectName, parentCheckpointId, lineage } = {}) {
    return lock(async () => {
      const before = await guard.inspect({ sourcePath });
      if (!projectId || !projectName) { need(typeof nativeStore.readProjectIdentity === 'function', 'project-identity-reader-required'); const context = await nativeStore.readProjectIdentity({ sourcePath });
        need(!projectId || projectId === context.projectId, 'project-identity-mismatch'); need(!projectName || projectName === context.projectName, 'project-context-mismatch'); projectId = context.projectId; projectName = context.projectName; }
      need(ID.test(projectId || '') && typeof projectName === 'string' && projectName.length > 0, 'project-context-required');
      const binding = await sourceBindingService.prepareClosedProjectSourceBinding({ sourcePath, projectName }); need(binding.sourcePath === sourcePath && binding.projectName === projectName && path.isAbsolute(binding.libraryRoot), 'source-binding-invalid');
      const s = await state(); need(s.index < 10000, 'capacity-exceeded'); const scope = { libraryRoot: binding.libraryRoot, projectPath: sourcePath }, scopeKey = digest({ scope, projectId });
      let ledger = Object.values(s.lineages).find(l => l.scopeKey === scopeKey), fork = null, forkSource = null;
      if (lineage !== undefined) { need(!ledger && verifyCopyLineage && lineage && Object.keys(lineage).sort().join(',') === 'sourceCheckpointId,transactionId' && ID.test(lineage.transactionId) && ID.test(lineage.sourceCheckpointId), 'copy-lineage-required');
        const base = await inspectWithState(lineage.sourceCheckpointId, s), copy = await verifyCopyLineage({ ...lineage, sourceRecord: detached(base), destinationBinding: detached(binding), destinationSha256: before.sha256 });
        need(copy?.state === 'completed' && copy.transactionId === lineage.transactionId && copy.plan?.projectId === projectId && copy.original?.path === base.scope.projectPath && copy.original.sha256 === base.source.sha256
          && copy.destination?.path === sourcePath && copy.destination.libraryRoot === binding.libraryRoot && copy.candidate?.sha256 === before.sha256 && copy.editorProof?.verified === true && copy.editorProof.closed === true
          && copy.editorProof.actualOpenFileBindingVerified === true && copy.editorProof.sourceSha256 === before.sha256 && SHA.test(copy.editorProof.proofSha256 || '') && isDeepStrictEqual(copy.destination.binding, binding), 'copy-lineage-unverified');
        need(base.projectId === projectId && base.scope.libraryRoot !== binding.libraryRoot, 'copy-lineage-unverified');
        forkSource = base; fork = { forkParentCheckpointId: base.checkpointId, comparisonRootLineageId: base.comparisonRootLineageId, copyTransactionId: copy.transactionId, copyProofSha256: copy.editorProof.proofSha256 };
      }
      if (ledger) { need(parentCheckpointId === undefined || parentCheckpointId === ledger.headCheckpointId, 'parent-stale'); }
      else need(parentCheckpointId === undefined, 'parent-scope-mismatch');
      const checkpointId = randomUUID(), dir = checkpointDirectory(checkpointId); await privateDirectory(dir); const captureDirectory = path.join(dir, 'capture'); await privateDirectory(captureDirectory);
      const captured = await nativeStore.inspectClosedDatabase({ sourcePath, directory: captureDirectory, projectId, projectName });
      need(sha(captured.databaseBytes) === before.sha256 && captured.facts?.source?.sha256 === before.sha256 && sha(captured.censusBytes) === captured.facts?.census?.sha256, 'capture-source-changed');
      const census = JSON.parse(captured.censusBytes), graph = nativeGraph(census); if (fork) need(isDeepStrictEqual(graph, forkSource.nativeGraph), 'copy-identity-graph-changed'); need(census.projectContext.projectId === projectId && census.projectContext.projectName === projectName, 'project-context-mismatch');
      const after = await guard.inspect({ sourcePath, expectedSourceHash: before.sha256 }); assertSameClosedProjectObservation(before, after);
      need(isDeepStrictEqual(await sourceBindingService.prepareClosedProjectSourceBinding({ sourcePath, projectName }), binding), 'source-library-changed');
      if (ledger) { const latest = await inspectWithState(ledger.headCheckpointId, s); if (latest.source.sha256 === before.sha256 && latest.source.censusSha256 === sha(captured.censusBytes)) return latest; }
      const lineageId = ledger?.lineageId || randomUUID(); if (!ledger) ledger = { lineageId, scopeKey, projectId, scope, entries: {}, headCheckpointId: null,
        comparisonRootLineageId: fork?.comparisonRootLineageId || lineageId, forkParentCheckpointId: fork?.forkParentCheckpointId || null, copyTransactionId: fork?.copyTransactionId || null, copyProofSha256: fork?.copyProofSha256 || null };
      ledger = detached(ledger); if (!forkSource && ledger.forkParentCheckpointId) forkSource = await inspectWithState(ledger.forkParentCheckpointId, s); const forkEntities = new Map((forkSource?.entities || []).map(e => [`${e.kind}:${e.nativeId}`, e])); const keys = new Set(graph.map(e => `${e.kind}:${e.nativeId}`));
      for (const [k, value] of Object.entries(ledger.entries)) if (!keys.has(k) && value.active) { value.active = false; value.deletedAtCheckpointId = checkpointId; }
      const entities = graph.map(e => { const k = `${e.kind}:${e.nativeId}`, prior = ledger.entries[k];
        // A UUID observed absent and later present is a new generation. Reuse is
        // never inferred across an observed deletion or an unrelated library.
        const value = prior?.active ? prior : { appId: randomUUID(), generation: (prior?.generation || 0) + 1, kind: e.kind, nativeId: e.nativeId, firstCheckpointId: checkpointId };
        need(!prior?.active || prior.dbType === e.dbType, 'native-type-reused'); const sourceEntity = !prior ? forkEntities.get(k) : null; const comparisonId = value.comparisonId || (sourceEntity ? sourceEntity.comparisonId || sourceEntity.appId : value.appId); need(ID.test(comparisonId), 'comparison-identity-invalid'); ledger.entries[k] = { ...value, comparisonId, dbType: e.dbType, active: true, lastCheckpointId: checkpointId };
        return { ...e, appId: value.appId, comparisonId, generation: value.generation };
      });
      const byKey = new Map(entities.map(e => [`${e.kind}:${e.nativeId}`, e])); for (const entity of entities) entity.parentAppId = entity.parentKind ? byKey.get(`${entity.parentKind}:${entity.parentNativeId}`)?.appId : null;
      need(new Set(entities.map(e => e.appId)).size === entities.length && entities.every(e => !e.parentKind || ID.test(e.parentAppId || '')), 'generated-identity-collision');
      const record = { schemaVersion: 1, operation: 'closed-native-checkpoint', adapterProfile: 'resolve-free-21.1.2-closed-checkpoint-v1', checkpointId, lineageId,
        comparisonRootLineageId: ledger.comparisonRootLineageId, parentCheckpointId: ledger.headCheckpointId, forkParentCheckpointId: ledger.headCheckpointId ? null : ledger.forkParentCheckpointId,
        copyTransactionId: ledger.copyTransactionId, copyProofSha256: ledger.copyProofSha256, projectId, projectName, projectAppId: byKey.get(`project:${projectId}`).appId,
        scope, binding, source: { sha256: before.sha256, bytes: captured.databaseBytes.length, censusSha256: sha(captured.censusBytes) }, observation: before,
        entities, nativeGraph: graph, identityCoverage: 'native-project-timeline-sequence-track-item-uuid-graph', finiteSavedCheckpointOnly: true,
        currentUnsavedIdentityProven: false, safeToApply: false, createdAt: new Date().toISOString() };
      await authenticatedWrite(path.join(dir, 'record.json'), record); await onCheckpoint('record-retained', detached(record));
      ledger.headCheckpointId = checkpointId; const next = { schemaVersion: 1, checkpoints: [...s.checkpoints, { checkpointId, lineageId, recordHash: digest(record) }], lineages: { ...s.lineages, [lineageId]: ledger } };
      await authenticatedWrite(path.join(directory, `state-${String(s.index).padStart(6, '0')}.json`), { index: s.index, previous: s.previous, state: next });
      await onCheckpoint('state-committed', detached(record)); return detached(record);
    });
  }
  async function getIdentityLedger(lineageId) { const s = await state(); need(ID.test(lineageId || '') && s.lineages[lineageId], 'lineage-not-found'); return detached(s.lineages[lineageId]); }
  return { capture, inspect, readCheckpoint, list, verifyCurrent, isAncestor, getIdentityLedger };
}
module.exports = { createClosedProjectCheckpointStore, nativeGraph };
