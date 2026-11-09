const { createHash } = require('node:crypto');
const { validateScanManifest } = require('./scan-manifest');

const uuidPattern = /^[a-f0-9-]{36}$/;
const branchPattern = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const fields = ['id', 'projectId', 'parentRevisionId', 'author', 'createdAt', 'message', 'editorVersion', 'manifestVersion', 'contentHash'];

function transferError() {
  return Object.assign(new Error('revision-transfer-invalid'), { code: 'revision-transfer-invalid' });
}

function verifyRecord(summary, bytes) {
  if (!summary || typeof summary !== 'object' || typeof bytes !== 'string'
    || (summary.recordHash && createHash('sha256').update(bytes).digest('hex') !== summary.recordHash)) throw transferError();
  let record;
  try { record = JSON.parse(bytes); validateScanManifest(record.manifest); }
  catch { throw transferError(); }
  if (fields.some(field => record[field] !== summary[field])
    || record.contentHash !== record.manifest.sourceHash
    || record.manifestVersion !== record.manifest.schemaVersion
    || !uuidPattern.test(record.id) || !uuidPattern.test(record.projectId)
    || (record.parentRevisionId !== null && !uuidPattern.test(record.parentRevisionId))) throw transferError();
  return record;
}

function validateTransferBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.format !== 'frameline-revisions'
    || bundle.version !== 1 || !uuidPattern.test(bundle.projectId) || !Array.isArray(bundle.records)
    || !bundle.branches || typeof bundle.branches !== 'object' || Array.isArray(bundle.branches)
    || !Object.keys(bundle.branches).length || !Object.hasOwn(bundle.branches, 'main')) throw transferError();
  const records = new Map();
  for (const entry of bundle.records) {
    if (!entry || typeof entry !== 'object') throw transferError();
    const record = verifyRecord(entry.summary, entry.bytes);
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
