'use strict';
const { createHash } = require('node:crypto');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');

const SHA = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function invalid() { const error = new Error('resolve-revision-invalid'); error.code = 'resolve-revision-invalid'; throw error; }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}
function createResolveRevisionManifest(snapshot) {
  try {
    validateResolveSnapshot(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    return { schemaVersion: 1, format: 'resolve-api-observation', readOnly: true,
      safeToApply: false, sourceHash: sha(bytes), snapshot: JSON.parse(bytes) };
  } catch { invalid(); }
}
function validateResolveRevisionManifest(value) {
  try {
    if (!exactKeys(value, ['schemaVersion', 'format', 'readOnly', 'safeToApply', 'sourceHash', 'snapshot'])
      || value.schemaVersion !== 1 || value.format !== 'resolve-api-observation'
      || value.readOnly !== true || value.safeToApply !== false || !SHA.test(value.sourceHash)) invalid();
    validateResolveSnapshot(value.snapshot);
    if (sha(Buffer.from(JSON.stringify(value.snapshot))) !== value.sourceHash) invalid();
    return value;
  } catch { invalid(); }
}
module.exports = { createResolveRevisionManifest, validateResolveRevisionManifest };
