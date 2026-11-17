'use strict';
const { validateScanManifest } = require('./scan-manifest');
const { validateResolveRevisionManifest } = require('./resolve-revision-manifest');

function validateRevisionManifest(manifest) {
  if (manifest?.format === 'resolve-api-observation') return validateResolveRevisionManifest(manifest);
  return validateScanManifest(manifest);
}
module.exports = { validateRevisionManifest };
