'use strict';
const { createHash } = require('node:crypto');
const { fingerprint } = require('./project-api-contracts');
const { validateTransferBundle } = require('./revision-transfer');
const { validateRevisionManifest } = require('./revision-manifest');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/, MANIFEST = /^sha256:[a-f0-9]{64}$/, BRANCH = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const SCOPE_FIELDS = ['originHash', 'accountId', 'localProjectId', 'localBranch', 'remoteProjectId', 'remoteBranch'];
const LOCAL_RECORD_FIELDS = ['id', 'projectId', 'parentRevisionId', 'author', 'createdAt', 'message', 'editorVersion', 'manifestVersion', 'contentHash'];
const CANDIDATE_FIELDS = ['localRevisionId', 'remoteRevisionId', 'remoteAuthorId', 'manifestId', 'recordHash', 'proofHash', 'verifiedAt', 'observedLocalHead', 'observedRemoteHead'];
const exact = (value, fields, optional = []) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && fields.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...fields, ...optional].includes(key));
const validId = value => typeof value === 'string' && ID.test(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && SHA.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 240
  && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value);
const date = value => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value));
const fail = code => Object.assign(new Error(code), { code });
function validateServiceSyncBaseScope(value) {
  if (!exact(value, SCOPE_FIELDS) || !hash(value.originHash) || !validId(value.accountId) || !uuid(value.localProjectId)
    || typeof value.localBranch !== 'string' || !BRANCH.test(value.localBranch) || !validId(value.remoteProjectId) || !validId(value.remoteBranch)) throw fail('sync-base-invalid');
  return structuredClone(value);
}
function validateServiceSyncBaseCandidate(value) {
  if (!exact(value, CANDIDATE_FIELDS) || !uuid(value.localRevisionId) || !validId(value.remoteRevisionId) || !validId(value.remoteAuthorId)
    || typeof value.manifestId !== 'string' || !MANIFEST.test(value.manifestId) || !hash(value.recordHash) || !hash(value.proofHash)
    || !time(value.verifiedAt) || !uuid(value.observedLocalHead) || !validId(value.observedRemoteHead)) throw fail('sync-base-invalid');
  return structuredClone(value);
}
function validateServiceSyncBaseEntry(value) {
  if (!exact(value, ['version', 'scope', ...CANDIDATE_FIELDS, 'proofSnapshotHash']) || !Number.isSafeInteger(value.version) || value.version < 1
    || !hash(value.proofSnapshotHash)) throw fail('sync-base-invalid');
  validateServiceSyncBaseScope(value.scope); validateServiceSyncBaseCandidate(Object.fromEntries(CANDIDATE_FIELDS.map(key => [key, value[key]])));
  return structuredClone(value);
}
function verifyServiceSyncBase({ scope, bundle, remote, verifiedAt } = {}) {
  scope = validateServiceSyncBaseScope(scope);
  if (!time(verifiedAt)) throw fail('sync-base-invalid');
  try {
    if (!exact(bundle, ['format', 'version', 'projectId', 'branches', 'records']) || Buffer.byteLength(JSON.stringify(bundle)) > 64 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(remote)) > 64 * 1024 * 1024
      || !Array.isArray(bundle.records) || bundle.records.length > 10000 || bundle.projectId !== scope.localProjectId) throw fail('sync-history-invalid');
    const records = validateTransferBundle(bundle);
    for (const entry of bundle.records) {
      const record = records.get(entry.summary.id);
      if (!exact(entry, ['summary', 'bytes']) || !exact(entry.summary, LOCAL_RECORD_FIELDS, ['recordHash'])
        || !exact(record, [...LOCAL_RECORD_FIELDS, 'manifest']) || !uuid(record.id) || !uuid(record.projectId)
        || record.parentRevisionId !== null && !uuid(record.parentRevisionId) || !date(record.createdAt)
        || !text(record.author) || !text(record.message) || entry.summary.recordHash !== undefined && !hash(entry.summary.recordHash)) throw fail('sync-history-invalid');
    }
    const bytesById = new Map(bundle.records.map(entry => [entry.summary.id, entry.bytes])); const localHead = bundle.branches[scope.localBranch];
    if (localHead === undefined) throw fail('sync-history-invalid');
    const local = []; let cursor = localHead;
    while (cursor) { if (local.length >= 10000 || !records.has(cursor)) throw fail('sync-history-invalid'); const record = records.get(cursor); local.push(record); cursor = record.parentRevisionId; }
    local.reverse();
    if (!exact(remote, ['schemaVersion', 'remoteProjectId', 'branch', 'head', 'revisions', 'manifests', 'mediaFetched'], ['checkedAt'])
      || remote.schemaVersion !== 1 || remote.remoteProjectId !== scope.remoteProjectId || remote.branch !== scope.remoteBranch || remote.mediaFetched !== false
      || (remote.head !== null && !validId(remote.head)) || !Array.isArray(remote.revisions) || remote.revisions.length > 10000
      || !Array.isArray(remote.manifests) || remote.manifests.length > 10000 || remote.checkedAt !== undefined && !time(remote.checkedAt)) throw fail('sync-history-invalid');
    const manifests = new Map();
    for (const item of remote.manifests) {
      if (!exact(item, ['id', 'projectId', 'document', 'createdAt']) || item.projectId !== scope.remoteProjectId || !date(item.createdAt)
        || typeof item.id !== 'string' || !MANIFEST.test(item.id) || manifests.has(item.id) || item.id !== `sha256:${fingerprint(item.document)}`) throw fail('sync-history-invalid');
      validateRevisionManifest(item.document); manifests.set(item.id, item);
    }
    const remoteIds = new Set(), sourceIds = new Set(), used = new Set(); let parent = null;
    const byRemote = new Map();
    for (const record of remote.revisions) {
      if (!exact(record, ['id', 'projectId', 'manifestId', 'parentRevisionId', 'authorId', 'message', 'sourceRevisionId', 'createdAt'])
        || !validId(record.id) || remoteIds.has(record.id) || record.projectId !== scope.remoteProjectId || record.parentRevisionId !== parent
        || !manifests.has(record.manifestId) || !validId(record.authorId) || !text(record.message) || !date(record.createdAt)
        || record.sourceRevisionId !== null && (!validId(record.sourceRevisionId) || sourceIds.has(record.sourceRevisionId))) throw fail('sync-history-invalid');
      remoteIds.add(record.id); if (record.sourceRevisionId !== null) sourceIds.add(record.sourceRevisionId);
      used.add(record.manifestId); parent = record.id; byRemote.set(record.id, record);
    }
    if (parent !== remote.head || used.size !== manifests.size) throw fail('sync-history-invalid');
    // Every known source ID must retain its exact local identity, even after a
    // legitimate unknown remote child ends the common prefix.
    for (const record of remote.revisions) if (record.sourceRevisionId !== null && records.has(record.sourceRevisionId)) {
      const item = records.get(record.sourceRevisionId), previous = record.parentRevisionId === null ? null : byRemote.get(record.parentRevisionId);
      if (record.manifestId !== `sha256:${fingerprint(item.manifest)}` || record.message.trim() !== item.message.trim()
        || (previous?.sourceRevisionId || null) !== item.parentRevisionId) throw fail('sync-history-invalid');
    }
    let candidate = null;
    for (let index = 0; index < Math.min(local.length, remote.revisions.length); index++) {
      const item = local[index], record = remote.revisions[index]; if (record.sourceRevisionId !== item.id) break;
      const bytes = bytesById.get(item.id);
      candidate = { localRevisionId: item.id, remoteRevisionId: record.id, remoteAuthorId: record.authorId,
        manifestId: record.manifestId, recordHash: createHash('sha256').update(bytes).digest('hex'),
        verifiedAt, observedLocalHead: localHead, observedRemoteHead: remote.head };
    }
    if (!candidate) return null;
    const chain = local.map(item => ({ id: item.id, parentRevisionId: item.parentRevisionId,
      recordHash: createHash('sha256').update(bytesById.get(item.id)).digest('hex') }));
    const normalizedRemote = { ...remote, manifests: [...manifests.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
    return validateServiceSyncBaseCandidate({ ...candidate, proofHash: fingerprint({ version: 1, scope, chain, remote: normalizedRemote, verifiedAt }) });
  } catch { throw fail('sync-history-invalid'); }
}
module.exports = { verifyServiceSyncBase, validateServiceSyncBaseScope, validateServiceSyncBaseCandidate, validateServiceSyncBaseEntry };
