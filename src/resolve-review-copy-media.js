'use strict';
// Private host-side inspection. Explicit item paths are observations, while
// opaque native media records stay uninterpreted and byte-preserved.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const need = (value, code) => { if (!value) throw Object.assign(new Error(`review-copy-media-${code}`), { code: `review-copy-media-${code}` }); };
const decode = value => {
  need(value?.type === 'text' && typeof value.base64 === 'string', 'text-required');
  const bytes = Buffer.from(value.base64, 'base64'), text = bytes.toString('utf8');
  need(bytes.toString('base64') === value.base64 && Buffer.from(text).equals(bytes), 'invalid-text');
  return text;
};
function table(census, name) {
  const found = census.tables.filter(value => value.name === name);
  need(found.length === 1 && Array.isArray(found[0].columns) && new Set(found[0].columns).size === found[0].columns.length, 'table-required');
  return found[0];
}
function cell(t, row, column) {
  const index = t.columns.indexOf(column);
  need(index >= 0 && Array.isArray(row.cells) && row.cells.length === t.columns.length, 'column-required');
  return row.cells[index];
}
function inspectReviewCopyMedia(census) {
  need(census?.operation === 'native-sqlite-all-cell-census' && census.allPersistentTablesCovered === true
    && census.allSchemaObjectsCovered === true && census.integrityCheck === 'ok'
    && Array.isArray(census.excludedApplicationColumns) && census.excludedApplicationColumns.length === 0
    && UUID.test(census.projectContext?.projectId || '') && Array.isArray(census.tables), 'complete-census-required');
  const mediaTable = table(census, 'Sm2MpMedia'), mediaIds = new Set();
  need(mediaTable.primaryKeyColumns?.length === 1 && mediaTable.primaryKeyColumns[0].name === 'Sm2MpMedia_id', 'media-primary-key');
  for (const row of mediaTable.rows) {
    const id = decode(cell(mediaTable, row, 'Sm2MpMedia_id'));
    need(UUID.test(id) && !mediaIds.has(id) && isDeepStrictEqual(row.primaryKey, [cell(mediaTable, row, 'Sm2MpMedia_id')]), 'media-identity');
    mediaIds.add(id);
  }
  const items = table(census, 'Sm2TiItem');
  need(items.primaryKeyColumns?.length === 1 && items.primaryKeyColumns[0].name === 'Sm2TiItem_id', 'item-primary-key');
  const references = [], seen = new Set(), raw = [];
  for (const row of items.rows) {
    const itemId = decode(cell(items, row, 'Sm2TiItem_id'));
    need(UUID.test(itemId) && !seen.has(itemId) && isDeepStrictEqual(row.primaryKey, [cell(items, row, 'Sm2TiItem_id')]), 'item-identity');
    seen.add(itemId);
    const kind = decode(cell(items, row, 'DbType')), reference = cell(items, row, 'MediaRef'), storedPath = cell(items, row, 'MediaFilePath');
    raw.push({ itemId, kind, reference, storedPath });
    if (!['Sm2TiVideoClip', 'Sm2TiAudioClip'].includes(kind)) continue;
    const mediaId = reference.type === 'null' ? null : decode(reference);
    need(mediaId === null || UUID.test(mediaId) && mediaIds.has(mediaId), 'media-reference-unbound');
    let filename = null, state = 'unknown', reason = 'no-explicit-item-reference';
    if (storedPath.type === 'text') {
      filename = decode(storedPath);
      if (filename && path.isAbsolute(filename) && path.normalize(filename) === filename && !/[\x00-\x1f\x7f]/.test(filename)) {
        state = 'unobserved'; reason = 'explicit-absolute-item-reference';
      } else { filename = null; reason = 'relative-or-invalid-item-reference'; }
    } else need(storedPath.type === 'null', 'path-type-unsupported');
    references.push({ itemId, mediaId, kind: kind === 'Sm2TiVideoClip' ? 'video' : 'audio', filename, state, reason });
  }
  // These tables carry media locations/proxy data in opaque application cells.
  // Include every column/row, without trying to decode an embedded path.
  const native = ['Sm2MpMedia', 'BtVideoInfo', 'BtAudioInfo'].map(name => {
    const t = table(census, name);
    return { name, columns: t.columns, primaryKeyColumns: t.primaryKeyColumns, rows: t.rows };
  });
  const opaqueCells = native.reduce((sum, t) => sum + t.rows.reduce((n, r) => n + r.cells.filter(c => c.type === 'blob' && c.base64 !== '').length, 0), 0);
  raw.sort((a, b) => a.itemId.localeCompare(b.itemId));
  references.sort((a, b) => a.itemId.localeCompare(b.itemId));
  return { schemaVersion: 1, projectId: census.projectContext.projectId,
    databaseSha256: census.snapshot.sha256, mediaReferenceSha256: sha({ raw, native }),
    policy: 'same-machine-unchanged-references', completeMediaEnumeration: false,
    opaqueNativeMediaCells: opaqueCells, references };
}
function verifyReviewCopyMediaPreserved(sourceCensus, copyCensus) {
  const source = inspectReviewCopyMedia(sourceCensus), copy = inspectReviewCopyMedia(copyCensus);
  need(source.projectId === copy.projectId && source.mediaReferenceSha256 === copy.mediaReferenceSha256, 'references-changed');
  return { schemaVersion: 1, verified: true, policy: source.policy,
    sourceDatabaseSha256: source.databaseSha256, copyDatabaseSha256: copy.databaseSha256,
    mediaReferenceSha256: source.mediaReferenceSha256, explicitItemReferences: source.references.length,
    opaqueNativeMediaCells: source.opaqueNativeMediaCells, completeMediaEnumeration: false,
    representedMediaReferenceValuesCompared: true, mediaRelinkPerformed: false, mediaCollected: false };
}
async function auditReviewCopyMedia(census, { stat = filename => fs.stat(filename), signal } = {}) {
  need(typeof stat === 'function', 'observer-required');
  const inspected = inspectReviewCopyMedia(census), entries = [];
  for (const reference of inspected.references) {
    if (signal?.aborted) throw Object.assign(new Error('review-copy-media-cancelled'), { code: 'review-copy-media-cancelled' });
    let state = reference.state, reason = reference.reason;
    if (reference.filename) {
      try { const result = await stat(reference.filename); state = result.isFile() ? 'available' : 'unknown'; reason = result.isFile() ? 'observed-regular-file' : 'not-a-regular-file'; }
      catch (error) { state = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unknown'; reason = state === 'missing' ? 'explicit-reference-unavailable' : 'availability-unverified'; }
    }
    entries.push({ itemId: reference.itemId, mediaId: reference.mediaId, kind: reference.kind, state, reason });
  }
  const counts = { total: entries.length, available: 0, missing: 0, unknown: 0 };
  for (const entry of entries) counts[entry.state]++;
  return { schemaVersion: 1, projectId: inspected.projectId, databaseSha256: inspected.databaseSha256,
    policy: inspected.policy, mediaReferenceSha256: inspected.mediaReferenceSha256,
    completeMediaEnumeration: false, opaqueNativeMediaCells: inspected.opaqueNativeMediaCells,
    counts, entries, portability: 'same-machine-references-only', mediaRelinkPerformed: false, mediaCollected: false,
    status: counts.missing ? 'observed-media-missing' : counts.unknown ? 'observed-media-unknown' : 'observed-references-available',
    collectionAction: 'collect-in-resolve-and-recapture',
    message: counts.missing ? 'Some observed media references are missing. Collect or relink media in Resolve, then capture and prepare a new review copy.'
      : 'The copy shares the original media references on this Mac. Opaque media and proxy records are preserved; their paths have not been enumerated.' };
}
function createReviewCopyMediaPolicy({ stat, signal } = {}) {
  return async function reviewCopyMediaPolicy({ plan, sourcePath, sourceBinding, censusBytes, destinationLibraryRoot } = {}) {
    need(plan?.operation === 'closed-project-name-apply-plan' && plan.mediaPolicy === 'unchanged-references'
      && /^[a-f0-9]{64}$/.test(plan.source?.sha256 || '') && UUID.test(plan.projectId || '')
      && Buffer.isBuffer(censusBytes) && censusBytes.length <= 24 * 1024 * 1024
      && path.isAbsolute(sourcePath || '') && path.isAbsolute(destinationLibraryRoot || '')
      && sourceBinding?.sourcePath === sourcePath && sourceBinding?.projectName === plan.projectName, 'policy-binding-required');
    const census = JSON.parse(censusBytes);
    need(census.projectContext?.projectId === plan.projectId && census.snapshot?.sha256 === plan.source.sha256, 'source-binding-changed');
    const report = await auditReviewCopyMedia(census, { ...(stat ? { stat } : {}), signal });
    const bindingSha256 = sha({ schemaVersion: 1, policy: 'unchanged-references', projectId: plan.projectId,
      sourceSha256: plan.source.sha256, sourcePath, destinationLibraryRoot, mediaReferenceSha256: report.mediaReferenceSha256 });
    return { schemaVersion: 1, policy: 'unchanged-references', verified: true, sourceSha256: plan.source.sha256,
      bindingSha256, report, mediaReadiness: report.status,
      preservesExistingAvailabilityConditionOnly: true, portableCopyVerified: false,
      collectionRequiredForPortability: true, collectionAction: report.collectionAction };
  };
}
module.exports = { inspectReviewCopyMedia, verifyReviewCopyMediaPreserved, auditReviewCopyMedia, createReviewCopyMediaPolicy };
