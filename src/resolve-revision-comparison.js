'use strict';
const { validateResolveRevisionManifest } = require('./resolve-revision-manifest');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { compareResolveManifests } = require('./resolve-id-diff');
const { decimalIdentity } = require('./resolve-observation-values');
const { parseEffectObservation, compareEffectObservations, describeEffectCoverage } = require('./resolve-effect-observation');

function revisionObservation(manifest) {
  return manifest.observation || (manifest.transactionAudit?.effects
    ? parseEffectObservation(manifest.transactionAudit.effects.after) : null);
}
function describeResolveRevisionCoverage(manifest) {
  validateResolveRevisionManifest(manifest);
  const observation = revisionObservation(manifest);
  return observation ? describeEffectCoverage(observation) : null;
}

function compareResolveRevisionManifests(before, after) {
  validateResolveRevisionManifest(before);
  validateResolveRevisionManifest(after);
  const diff = compareResolveManifests(normalizeResolveSnapshot(before.snapshot),
    normalizeResolveSnapshot(after.snapshot));
  const oldObservation = revisionObservation(before), newObservation = revisionObservation(after);
  const beforeCoverage = oldObservation ? describeEffectCoverage(oldObservation) : null;
  const afterCoverage = newObservation ? describeEffectCoverage(newObservation) : null;
  const changes = [...diff.changes];
  const comparableProperties = oldObservation?.schemaVersion === 2 && newObservation?.schemaVersion === 2;
  if (oldObservation && newObservation) {
    const extra = compareEffectObservations(JSON.stringify(oldObservation), JSON.stringify(newObservation));
    for (const change of extra.effectChanges) changes.push({ ...change,
      kind: change.kind === 'slot-added' ? 'effect-slot-added' : change.kind === 'slot-removed' ? 'effect-slot-deleted' : 'effect-slot-changed' });
    for (const change of extra.propertyChanges || []) {
      // Compare represented decimals exactly, including equivalent exponent and
      // signed-zero spellings, without rounding them through a JS Number.
      const a = decimalIdentity(change.before), b = decimalIdentity(change.after);
      if (a !== null && a === b) continue;
      changes.push({ ...change, kind: 'item-property-changed' });
    }
    for (const { type, index, ...change } of extra.trackStateChanges || []) changes.push({ ...change,
      kind: 'track-state-changed', trackType: type, trackIndex: index });
    if (extra.activeTimelineChange) changes.push({ ...extra.activeTimelineChange, kind: 'capture-context-changed',
      timelineId: extra.activeTimelineChange.after || extra.activeTimelineChange.before, field: 'activeTimelineId' });
  }
  const key = change => JSON.stringify([change.timelineId, change.itemId || '', change.kind, change.field || '',
    change.category || '', change.index || change.trackIndex || 0]);
  changes.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return { ...diff, changes, beforeSourceHash: before.sourceHash, afterSourceHash: after.sourceHash,
    coverage: { before: beforeCoverage, after: afterCoverage, comparableProperties,
      comparableEffects: Boolean(oldObservation && newObservation) },
    coverageChanged: (oldObservation?.schemaVersion || 0) !== (newObservation?.schemaVersion || 0) };
}
module.exports = { compareResolveRevisionManifests, describeResolveRevisionCoverage };
