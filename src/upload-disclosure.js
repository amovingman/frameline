const { fingerprint } = require('./project-api-contracts');
const { CLASSES } = require('./media-storage-policy');
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const ACTIONS = new Set(['upload', 'reuse', 'excluded-by-policy']);
function fail(code) { const error = new Error(code); error.code = code; return error; }

// This is a path-free review artifact for an explicit future upload control.
// A real upload executor must re-estimate authoritative assets after consent.
function createUploadDisclosure(estimate) {
  if (!estimate || !ID.test(estimate.projectId || '') || !Array.isArray(estimate.items)
    || estimate.items.length > 10000 || new Set(estimate.items.map(item => item?.id)).size !== estimate.items.length
    || estimate.items.some(item => !ID.test(item?.id || '') || !CLASSES.includes(item.assetClass)
      || !ACTIONS.has(item.action) || !Number.isSafeInteger(item.bytes) || item.bytes < 0)) throw fail('upload-disclosure-invalid');
  const totals = { uploadBytes: 0, reusedBytes: 0, excludedBytes: 0 };
  for (const item of estimate.items) totals[item.action === 'upload' ? 'uploadBytes'
    : item.action === 'reuse' ? 'reusedBytes' : 'excludedBytes'] += item.bytes;
  if (Object.entries(totals).some(([key, value]) => !Number.isSafeInteger(value) || estimate[key] !== value)) throw fail('upload-disclosure-invalid');
  const body = { schemaVersion: 1, projectId: estimate.projectId,
    items: estimate.items.map(({ id, assetClass, action, bytes }) => ({ id, assetClass, action, bytes }))
      .sort((a, b) => a.id.localeCompare(b.id)), ...totals,
    mediaBytesIncluded: false, pathsIncluded: false };
  return { ...body, sha256: fingerprint(body) };
}

function confirmUploadDisclosure(disclosure, { sha256, consent } = {}) {
  if (consent !== true || typeof sha256 !== 'string' || !disclosure || disclosure.sha256 !== sha256) throw fail('upload-consent-required');
  const { sha256: stored, ...body } = disclosure;
  if (fingerprint(body) !== stored) throw fail('upload-disclosure-changed');
  return { projectId: body.projectId, disclosureHash: stored, consentRecorded: true, uploadStarted: false };
}

module.exports = { createUploadDisclosure, confirmUploadDisclosure };
