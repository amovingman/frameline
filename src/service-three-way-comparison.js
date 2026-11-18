'use strict';
const { isDeepStrictEqual } = require('node:util');
const { fingerprint } = require('./project-api-contracts');
const { validateScanManifest } = require('./scan-manifest');
const { bindServiceComparisonSources } = require('./service-comparison-sources');
const MAX_RESULT_BYTES = 1024 * 1024;
const AVAILABILITY = ['local', 'missing', 'external', 'unknown', 'unavailable'];
const fail = code => Object.assign(new Error(code), { code });

function canonicalRate(value) {
  let [numerator, denominator] = value.slice(0, -1).split('/').map(BigInt);
  let a = numerator, b = denominator;
  while (b) [a, b] = [b, a % b];
  numerator /= a; denominator /= a;
  return `${numerator}/${denominator}s`;
}

function context(manifest) {
  const names = new Set(); let ambiguousMediaNames = false;
  const availability = Object.fromEntries(AVAILABILITY.map(key => [key, 0]));
  for (const item of manifest.media) {
    if (names.has(item.name)) ambiguousMediaNames = true;
    names.add(item.name); availability[item.availability]++;
  }
  return { clipCount: manifest.clips.length, mediaCount: manifest.media.length, ambiguousMediaNames,
    availability, warningCount: manifest.warnings.length };
}

/** Compare captured sequence observations only. The caller must independently
 * verify current local source bytes and scope before and after this pure work.
 * No source, incoming revision, branch, or shared-base receipt is changed here.
 */
function createServiceThreeWayComparison(input) {
  const { binding, base, local, incoming: incomingManifest } = bindServiceComparisonSources(input);
  if ([base, local, incomingManifest].some(value => value?.format === 'resolve-api-observation')) throw fail('service-comparison-unsupported');
  try { for (const value of [base, local, incomingManifest]) validateScanManifest(value); }
  catch { throw fail('service-comparison-invalid'); }
  const decisions = [];
  for (const field of ['name', 'frameDuration', 'durationFrames']) {
    const values = [base, local, incomingManifest].map(value => field === 'frameDuration'
      ? canonicalRate(value.sequence[field]) : value.sequence[field]);
    const [b, l, i] = values;
    if (b === l && b === i) continue;
    const status = l === i ? 'already-applied' : b === l ? 'incoming-only' : b === i ? 'local-only' : 'conflict';
    decisions.push({ field, status, base: b, local: l, incoming: i });
  }
  const contexts = { base: context(base), local: context(local), incoming: context(incomingManifest) };
  const warnings = [
    'Only captured sequence name, frame duration, and duration in frames are classified. Unchanged observed fields are omitted.',
    'Clip positions are scan positions, not persistent clip identities. Clip edits and complete editor equivalence are unavailable.',
    'Media inventory and availability counts are context only. Availability may differ between machines and does not establish an editor change or media identity.',
    'Duration values are frame counts; a frame-rate change may alter elapsed time.',
    'This comparison captures the selected export at verification time. Later file or service changes require another scan or fetch and comparison; live editor state and apply remain unproven.'
  ];
  if (Object.values(contexts).some(value => value.warningCount)) warnings.push('At least one source scan reported coverage warnings; unobserved content is excluded from classification.');
  const payload = { schemaVersion: 1, readOnly: true, safeToApply: false, coverage: 'fcpxml-sequence-fields-only',
    binding,
    decisions, context: contexts,
    gaps: ['clip-edits-unavailable', 'media-edit-classification-unavailable', 'live-editor-state-unproven', 'editor-apply-unavailable'], warnings };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RESULT_BYTES) throw fail('service-comparison-too-large');
  return { ...payload, id: `sha256:${fingerprint(payload)}` };
}

function verifyServiceThreeWayComparison(result, input) {
  return { valid: isDeepStrictEqual(result, createServiceThreeWayComparison(input)), readOnly: true, safeToApply: false };
}

module.exports = { createServiceThreeWayComparison, verifyServiceThreeWayComparison };
