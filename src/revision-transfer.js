const { createHash } = require('node:crypto');
const { validateRevisionManifest } = require('./revision-manifest');

const uuidPattern = /^[a-f0-9-]{36}$/;
const branchPattern = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const fields = ['id', 'projectId', 'parentRevisionId', 'author', 'createdAt', 'message', 'editorVersion', 'manifestVersion', 'contentHash'];
const pathFreeText = value => typeof value === 'string' && value.trim().length > 0
  && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value);

function transferError() {
  return Object.assign(new Error('revision-transfer-invalid'), { code: 'revision-transfer-invalid' });
}

function verifyRecord(summary, bytes) {
  if (!summary || typeof summary !== 'object' || typeof bytes !== 'string'
    || (summary.recordHash && createHash('sha256').update(bytes).digest('hex') !== summary.recordHash)) throw transferError();
  let record;
  try { record = JSON.parse(bytes); validateRevisionManifest(record.manifest); }
  catch { throw transferError(); }
  if (fields.some(field => record[field] !== summary[field])
    || !pathFreeText(record.author) || !pathFreeText(record.message)
    || record.contentHash !== record.manifest.sourceHash
    || record.editorVersion !== (record.manifest.format === 'resolve-api-observation' ? record.manifest.snapshot.resolve_version : null)
    || record.manifestVersion !== record.manifest.schemaVersion
    || !uuidPattern.test(record.id) || !uuidPattern.test(record.projectId)
    || (record.parentRevisionId !== null && !uuidPattern.test(record.parentRevisionId))) throw transferError();
  return record;
}

function validateTransferBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.format !== 'frameline-revisions'
    || ![1, 2].includes(bundle.version) || !uuidPattern.test(bundle.projectId) || !Array.isArray(bundle.records)
    || !bundle.branches || typeof bundle.branches !== 'object' || Array.isArray(bundle.branches)
    || !Object.keys(bundle.branches).length || !Object.hasOwn(bundle.branches, 'main')) throw transferError();
  const records = new Map();
  for (const entry of bundle.records) {
    if (!entry || typeof entry !== 'object') throw transferError();
    const record = verifyRecord(entry.summary, entry.bytes);
    if (bundle.version === 1 && record.manifest.format === 'resolve-api-observation') throw transferError();
    if (record.projectId !== bundle.projectId || records.has(record.id)) throw transferError();
    records.set(record.id, record);
  }
  const checked = new Set();
  for (const record of records.values()) {
    if (record.parentRevisionId !== null && !records.has(record.parentRevisionId)) throw transferError();
    const seen = new Set();
    let current = record;
    while (current && !checked.has(current.id)) {
      if (seen.has(current.id)) throw transferError();
      seen.add(current.id);
      current = records.get(current.parentRevisionId);
    }
    for (const id of seen) checked.add(id);
  }
  for (const [name, head] of Object.entries(bundle.branches)) {
    if (!branchPattern.test(name) || (head !== null && !records.has(head))) throw transferError();
  }
  return records;
}

module.exports = { validateTransferBundle, verifyRecord };
