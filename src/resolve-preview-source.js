'use strict';
const { validateResolveSnapshot } = require('./resolve-snapshot-validator');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { parseEffectObservation, describeEffectCoverage } = require('./resolve-effect-observation');
const MAX_PREVIEW_SOURCE_BYTES = 20 * 1024 * 1024;

function parseResolvePreviewSource(source) {
  if ((!Buffer.isBuffer(source) && typeof source !== 'string') || Buffer.byteLength(source) > MAX_PREVIEW_SOURCE_BYTES) throw new Error('invalid-resolve-preview-source');
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (typeof source === 'string' && text !== source) throw new Error('invalid-resolve-preview-source');
  const value = JSON.parse(text);
  const observation = value?.operation === 'resolve-effect-observation' ? parseEffectObservation(text) : null;
  const snapshot = observation ? observation.snapshot : value;
  validateResolveSnapshot(snapshot);
  return { snapshot, observation, normalized: normalizeResolveSnapshot(snapshot),
    coverage: observation ? describeEffectCoverage(observation) : null };
}
function previewSnapshotBytes(source) {
  return Buffer.from(JSON.stringify(parseResolvePreviewSource(source).snapshot));
}
module.exports = { parseResolvePreviewSource, previewSnapshotBytes, MAX_PREVIEW_SOURCE_BYTES };
