'use strict';
const { createHash } = require('node:crypto');
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');
const { validatePortableTrialAudit, portableTrialAuditHash } = require('./resolve-portable-trial-audit');

const SHA = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function invalid() { const error = new Error('resolve-revision-invalid'); error.code = 'resolve-revision-invalid'; throw error; }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable; });
}
function createResolveRevisionManifest(snapshot, transactionAudit = null) {
  try {
    validateResolveSnapshot(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (transactionAudit !== null) validatePortableTrialAudit(transactionAudit, snapshot);
    return { schemaVersion: transactionAudit === null ? 1 : 2, format: 'resolve-api-observation', readOnly: true,
      safeToApply: false, sourceHash: sha(bytes), snapshot: JSON.parse(bytes),
      ...(transactionAudit === null ? {} : { transactionAudit: structuredClone(transactionAudit),
        transactionAuditHash: portableTrialAuditHash(transactionAudit) }) };
  } catch { invalid(); }
}
function validateResolveRevisionManifest(value) {
  try {
    const version = Object.getOwnPropertyDescriptor(value, 'schemaVersion')?.value;
    if (!exactKeys(value, ['schemaVersion', 'format', 'readOnly', 'safeToApply', 'sourceHash', 'snapshot',
      ...(version === 2 ? ['transactionAudit', 'transactionAuditHash'] : [])])
      || ![1, 2].includes(value.schemaVersion) || value.format !== 'resolve-api-observation'
      || value.readOnly !== true || value.safeToApply !== false || !SHA.test(value.sourceHash)) invalid();
    validateResolveSnapshot(value.snapshot);
    if (sha(Buffer.from(JSON.stringify(value.snapshot))) !== value.sourceHash) invalid();
    if (value.schemaVersion === 2) {
      validatePortableTrialAudit(value.transactionAudit, value.snapshot);
      if (!SHA.test(value.transactionAuditHash) || portableTrialAuditHash(value.transactionAudit) !== value.transactionAuditHash) invalid();
    }
    return value;
  } catch { invalid(); }
}
module.exports = { createResolveRevisionManifest, validateResolveRevisionManifest };
