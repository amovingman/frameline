const { fingerprintFile } = require('./local-media-readiness');

const CLASSES = new Set(['original', 'proxy', 'audio', 'graphics', 'other']);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function createMediaAssetIdentity(fingerprint, { assetClass = 'other', mediaType = null } = {}) {
  if (!fingerprint || !Number.isSafeInteger(fingerprint.size) || fingerprint.size < 0
    || typeof fingerprint.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint.sha256)
    || !CLASSES.has(assetClass) || (mediaType !== null && (typeof mediaType !== 'string'
      || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mediaType)))) throw fail('asset-identity-invalid');
  return Object.freeze({ version: 1, algorithm: 'sha256', contentId: `sha256:${fingerprint.sha256.toLowerCase()}`,
    size: fingerprint.size, assetClass, mediaType });
}
async function identifyMediaFile(filename, metadata) {
  // fingerprintFile streams, rejects symlinks and checks for mid-read changes.
  return createMediaAssetIdentity(await fingerprintFile(filename), metadata);
}
function sameMediaContent(left, right) {
  if (!left || !right || left.version !== 1 || right.version !== 1) throw fail('asset-identity-invalid');
  return left.contentId === right.contentId && left.size === right.size;
}
module.exports = { createMediaAssetIdentity, identifyMediaFile, sameMediaContent };
