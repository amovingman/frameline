'use strict';
// Read-only main-process checkpoint review. IPC supplies opaque retained IDs;
// native paths, SQL values and lineage receipts remain behind this boundary.
const { createHash } = require('node:crypto');
const engineDefault = require('./native-checkpoint-diff');
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['incoming-only', 'local-only', 'already-applied', 'conflicting']);
const SCOPES = new Set(['keyed-field', 'keyed-entity', 'application-pragma', 'physical-container', 'schema-object', 'schema-object-storage', 'table-metadata', 'unkeyed-table', 'rowid-storage']);
const fail = code => Object.assign(new Error(code), { code });
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => HASH.test(value || '') ? value : null;
const label = value => typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f/\\]/.test(value) ? value : 'Stored value';
const schemaLabel = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_ ]{0,127}$/.test(value) ? value : 'Stored field';
const MESSAGES = {
  'native-checkpoints-invalid-action': 'The checkpoint action is invalid.',
  'native-checkpoints-not-initialized': 'Read retained checkpoints before comparing.',
  'native-checkpoints-busy': 'A checkpoint action is already running.',
  'native-checkpoints-write-active': 'Finish the active Apply, review copy or rename drill before reading native checkpoints.',
  'native-checkpoints-select-roles': 'Choose a retained common base and incoming checkpoint.',
  'native-checkpoints-lineage-mismatch': 'These checkpoints have no verified common lineage. Capture related history or import a verified review copy.',
  'native-checkpoints-identity-ambiguous': 'A native object ID was reused or its retained identity changed. Capture a new common base before comparing.',
  'native-checkpoints-copy-unverified': 'The selected review copy has no verified completed transaction.',
  'closed-project-resolve-running': 'Quit Resolve before capturing or comparing a closed project.',
  'closed-project-source-hash-stale': 'The local project changed while comparing. Capture and compare again.',
  'native-checkpoints-source-changed': 'The local project changed while comparing. Capture and compare again.'
};
function publicCheckpoint(record) {
  return { checkpointId: record.checkpointId, parentCheckpointId: record.parentCheckpointId || record.forkParentCheckpointId || null,
    lineageId: record.lineageId, comparisonRootLineageId: record.comparisonRootLineageId || record.lineageId,
    projectId: record.projectId, projectAppId: record.projectAppId,
    projectName: label(record.projectName), libraryName: label(record.binding?.expectedCurrentDatabase?.DbName
      || record.sourceBinding?.expectedCurrentDatabase?.DbName || record.libraryName || 'Local library'),
    sourceSha256: digest(record.source?.sha256), censusSha256: digest(record.source?.censusSha256),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    entityCount: Array.isArray(record.entities) ? record.entities.length : 0,
    persistentIdentity: true, historicalCheckpoint: true };
}
function publicValue(value, allowName) {
  if (!value || typeof value !== 'object') return { present: false };
  const result = { present: value.present === true };
  if (['null', 'integer', 'real', 'text', 'blob', 'missing', 'atomic', 'atomic-structure', 'json'].includes(value.type)) result.type = value.type;
  if (HASH.test(value.sha256 || '')) result.sha256 = value.sha256;
  if (Number.isSafeInteger(value.bytes) && value.bytes >= 0) result.bytes = value.bytes;
  if (['integer', 'real'].includes(value.type) && typeof value.display === 'string' && value.display.length <= 80 && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value.display)) result.display = value.display;
  if (value.type === 'real' && /^[a-f0-9]{16}$/.test(value.ieee754BigEndianHex || '')) { result.ieee754BigEndianHex = value.ieee754BigEndianHex; const n = Buffer.from(value.ieee754BigEndianHex, 'hex').readDoubleBE(); if (Number.isFinite(n)) result.display = String(n); }
  if (allowName && typeof value.display === 'string' && Buffer.byteLength(value.display) <= 256
    && !/[\x00-\x1f\x7f/\\]/.test(value.display)) result.display = value.display;
  return result;
}
function publicChange(row) {
  const allowName = row.table === 'Sm2TiItem' && row.column === 'Name';
  return { id: digest(row.id), scope: SCOPES.has(row.scope) ? row.scope : 'stored-field', table: schemaLabel(row.table), column: schemaLabel(row.column),
    primaryKeySha256: digest(row.primaryKeySha256), matching: ['primary-key', 'primary-key-uuid', 'atomic-unkeyed-multiset', 'atomic-rowid-multiset', 'atomic-schema', 'exact-stored-value', 'physical-storage-only', 'schema-object-name', 'table-name'].includes(row.matching) ? row.matching : 'atomic',
    status: STATUSES.has(row.status) ? row.status : 'conflicting', changeKind: label(row.changeKind),
    values: Object.fromEntries(['base', 'local', 'incoming'].map(role => [role, publicValue(row.values?.[role], allowName)])) };
}
function assertIdentityComparability(records) {
  const observed = new Map();
  for (const record of records) {
    if (!Array.isArray(record.entities)) throw fail('native-checkpoints-identity-ambiguous');
    const local = new Set();
    for (const entity of record.entities) {
      const key = `${entity.kind}:${entity.nativeId}`;
      if (local.has(key) || entity.comparisonId !== undefined && !ID.test(entity.comparisonId || '') || !Number.isSafeInteger(entity.generation) || entity.generation < 1
        || !ID.test(entity.appId || '')) throw fail('native-checkpoints-identity-ambiguous');
      local.add(key);
      const earlier = observed.get(key) || [];
      for (const previous of earlier) {
        if (previous.lineageId === record.lineageId) {
          if (previous.appId !== entity.appId || previous.generation !== entity.generation || (previous.comparisonId || previous.appId) !== (entity.comparisonId || entity.appId)) throw fail('native-checkpoints-identity-ambiguous');
        } else if (!ID.test(previous.comparisonId || '') || !ID.test(entity.comparisonId || '') || previous.comparisonId !== entity.comparisonId) throw fail('native-checkpoints-identity-ambiguous');
      }
      earlier.push({ lineageId: record.lineageId, appId: entity.appId, generation: entity.generation, comparisonId: entity.comparisonId }); observed.set(key, earlier);
    }
  }
}
function sidecarRows(records) {
  const tables = { project: 'SM_Project', timeline: 'Sm2Timeline', sequence: 'Sm2Sequence', track: 'Sm2TiTrack', item: 'Sm2TiItem' };
  const result = new Map();
  // Canonical primary-key encoding matches the exact typed-census engine. UUID
  // contents are ASCII; the sorted keys are base64 then type.
  for (const [role, record] of Object.entries(records)) for (const entity of record.entities) {
    if (!tables[entity.kind] || !/^[a-f0-9-]{36}$/.test(entity.nativeId)) continue;
    const primaryKeySha256 = sha(JSON.stringify([{ base64: Buffer.from(entity.nativeId).toString('base64'), type: 'text' }]));
    const key = `${tables[entity.kind]}:${primaryKeySha256}`;
    if (!result.has(key)) result.set(key, { kind: entity.kind, nativeId: entity.nativeId, verifiedCheckpointMapping: true, roles: {} });
    result.get(key).roles[role] = { appId: entity.appId, generation: entity.generation,
      parentAppId: ID.test(entity.parentAppId || '') ? entity.parentAppId : null, comparisonId: ID.test(entity.comparisonId || '') ? entity.comparisonId : null };
  }
  return result;
}
function createDesktopNativeCheckpoints({ store, chooseSource, canRead = () => true,
  listReviewCopies = async () => [], readReviewCopy = async () => null, onChange = () => {}, engine = engineDefault } = {}) {
  if (!store || !['capture', 'list', 'readCheckpoint', 'isAncestor', 'verifyCurrent'].every(method => typeof store[method] === 'function')
    || [chooseSource, canRead, listReviewCopies, readReviewCopy, onChange].some(value => typeof value !== 'function')
    || typeof engine.compareNativeThreeWay !== 'function' || typeof engine.pageNativeChanges !== 'function') throw fail('native-checkpoints-config-invalid');
  const records = new Map(); let initialized = false, busy = false, error = null, baseId = null, incomingId = null;
  let copies = [], report = null, comparison = null, offset = 0, statuses = null, table = null, identityRows = new Map();
  function page() {
    if (!report) return null;
    const p = engine.pageNativeChanges(report, { offset, limit: 40, ...(statuses ? { statuses } : {}), ...(table ? { table } : {}) });
    const rows = p.changes || p.items || p.rows || [];
    return { offset, limit: 40, total: Number.isSafeInteger(p.total) ? p.total : report.changes.length,
      items: rows.map(row => ({ ...publicChange(row), ...(identityRows.has(`${row.table}:${row.primaryKeySha256}`) ? { persistentIdentity: structuredClone(identityRows.get(`${row.table}:${row.primaryKeySha256}`)) } : {}) })), hasMore: p.hasMore === true || offset + rows.length < (p.total ?? report.changes.length),
      statuses: statuses ? [...statuses] : null, table };
  }
  function getState() { return { initialized, busy, error, baseCheckpointId: baseId, incomingCheckpointId: incomingId,
    checkpoints: [...records.values()].map(publicCheckpoint), copies: structuredClone(copies),
    comparison: comparison ? structuredClone(comparison) : null, page: page(), readOnly: true, safeToApply: false }; }
  function changed() { const s = getState(); try { Promise.resolve(onChange(structuredClone(s))).catch(() => {}); } catch {} return s; }
  function requireId(value) { if (typeof value !== 'string' || !ID.test(value)) throw fail('native-checkpoints-invalid-action'); return value; }
  function install(record) { if (!record || !ID.test(record.checkpointId || '')) throw fail('native-checkpoints-record-invalid'); records.set(record.checkpointId, structuredClone(record)); }
  function clearComparison() { report = comparison = null; identityRows = new Map(); offset = 0; statuses = table = null; }
  async function refresh() { const all = await store.list(); if (!Array.isArray(all) || all.length > 1000) throw fail('native-checkpoints-record-invalid'); records.clear(); for (const r of all) install(r); }
  async function refreshCopies() { const all = await listReviewCopies(); if (!Array.isArray(all) || all.length > 1000) throw fail('native-checkpoints-copy-unverified');
    copies = all.filter(r => r?.state === 'completed' && ID.test(r.transactionId || '')).map(r => ({ transactionId: r.transactionId,
      projectName: label(r.plan?.projectName || r.projectName), newName: label(r.plan?.edit?.newName || r.newName) })); }
  async function action(name, ...args) {
    if (busy) return { ...getState(), error: MESSAGES['native-checkpoints-busy'] };
    busy = true; error = null; changed();
    try {
      if (name === 'initialize' || name === 'refresh') {
        if (args.length) throw fail('native-checkpoints-invalid-action'); await refresh(); await refreshCopies(); initialized = true;
      } else {
        if (!initialized) throw fail('native-checkpoints-not-initialized');
        if (['capture', 'import-copy', 'compare'].includes(name) && canRead() !== true) throw fail('native-checkpoints-write-active');
        if (name === 'capture') {
          if (args.length) throw fail('native-checkpoints-invalid-action'); const sourcePath = await chooseSource();
          if (sourcePath) { if (canRead() !== true) throw fail('native-checkpoints-write-active'); const record = await store.capture({ sourcePath }); install(record); if (!baseId) baseId = record.checkpointId; incomingId = record.checkpointId; clearComparison(); }
        } else if (name === 'set-base' || name === 'set-incoming') {
          if (args.length !== 1) throw fail('native-checkpoints-invalid-action'); if (args[0] === '') { if (name === 'set-base') baseId = null; else incomingId = null; clearComparison(); } else { const id = requireId(args[0]); if (!records.has(id)) throw fail('native-checkpoints-invalid-action');
          if (name === 'set-base') baseId = id; else incomingId = id; clearComparison(); }
        } else if (name === 'import-copy') {
          if (args.length !== 1 || !baseId) throw fail('native-checkpoints-select-roles'); const transactionId = requireId(args[0]);
          if (!copies.some(copy => copy.transactionId === transactionId)) throw fail('native-checkpoints-copy-unverified');
          const copy = await readReviewCopy(transactionId); if (!copy || copy.state !== 'completed' || copy.transactionId !== transactionId
            || typeof copy.destination?.path !== 'string') throw fail('native-checkpoints-copy-unverified');
          const record = await store.capture({ sourcePath: copy.destination.path, lineage: { transactionId, sourceCheckpointId: baseId } });
          install(record); incomingId = record.checkpointId; clearComparison();
        } else if (name === 'compare') {
          if (args.length || !baseId || !incomingId) throw fail('native-checkpoints-select-roles'); clearComparison();
          const base = await store.readCheckpoint(baseId), incoming = await store.readCheckpoint(incomingId);
          if (base.record.projectId !== incoming.record.projectId || !(await store.isAncestor(baseId, incomingId))) throw fail('native-checkpoints-lineage-mismatch');
          const localRecord = await store.capture({ sourcePath: base.record.scope.projectPath }); install(localRecord);
          const local = await store.readCheckpoint(localRecord.checkpointId);
          if (!(await store.isAncestor(baseId, local.record.checkpointId))) throw fail('native-checkpoints-lineage-mismatch');
          assertIdentityComparability([base.record, local.record, incoming.record]);
          const nextIdentityRows = sidecarRows({ base: base.record, local: local.record, incoming: incoming.record });
          await store.verifyCurrent(local.record.checkpointId);
          const result = engine.compareNativeThreeWay({ base: base.census, local: local.census, incoming: incoming.census,
            namespace: sha(`${base.record.comparisonRootLineageId || base.record.lineageId}:${base.record.projectId}`) });
          await store.verifyCurrent(local.record.checkpointId);
          // Both historical sides came from authenticated, hash-verified private
          // checkpoints. Only the local side claims freshness at comparison time.
          report = result; identityRows = nextIdentityRows; comparison = { baseCheckpointId: baseId, localCheckpointId: local.record.checkpointId,
            incomingCheckpointId: incomingId, currentSourceSha256: digest(local.record.source.sha256),
            localFreshlyVerified: true, incomingHistorical: true, comparedAt: new Date().toISOString(),
            summary: structuredClone(result.summary), coverage: structuredClone(result.coverage), bindings: structuredClone(result.bindings),
            reportSha256: digest(result.reportId || result.reportSha256 || result.id || sha(JSON.stringify(result))),
            persistentEntityBindings: nextIdentityRows.size, readOnly: true, safeToApply: false };
        } else if (name === 'page') {
          if (args.length !== 1 || !report || !args[0] || Object.getPrototypeOf(args[0]) !== Object.prototype
            || Object.keys(args[0]).some(k => !['offset', 'statuses', 'table'].includes(k))) throw fail('native-checkpoints-invalid-action');
          const p = args[0]; if (!Number.isSafeInteger(p.offset) || p.offset < 0 || p.offset > 1000000
            || p.statuses !== undefined && (!Array.isArray(p.statuses) || !p.statuses.length || p.statuses.some(s => !STATUSES.has(s)))
            || p.table !== undefined && (typeof p.table !== 'string' || !/^[A-Za-z_][A-Za-z0-9_ ]{0,127}$/.test(p.table))) throw fail('native-checkpoints-invalid-action');
          offset = p.offset; statuses = p.statuses ? [...new Set(p.statuses)] : null; table = p.table || null;
        } else throw fail('native-checkpoints-invalid-action');
      }
    } catch (e) { if (['compare', 'capture', 'import-copy'].includes(name)) clearComparison(); error = MESSAGES[e.code || e.message] || 'The checkpoint action could not be verified. Keep Resolve closed and inspect the retained checkpoint sources before comparing again.'; }
    finally { busy = false; }
    return changed();
  }
  return { getState, action, isBusy: () => busy };
}
module.exports = { createDesktopNativeCheckpoints, publicCheckpoint, publicChange, assertIdentityComparability, sidecarRows };
