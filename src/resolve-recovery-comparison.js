'use strict';

const { createHash } = require('node:crypto');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { compareResolveManifests } = require('./resolve-id-diff');

const LIMIT = 20 * 1024 * 1024;
function read(source) {
  if ((!Buffer.isBuffer(source) && typeof source !== 'string') || Buffer.byteLength(source) > LIMIT) {
    throw new Error('invalid-recovery-snapshot');
  }
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const snapshot = JSON.parse(bytes.toString('utf8'));
  return { snapshot, manifest: normalizeResolveSnapshot(snapshot),
    sha256: createHash('sha256').update(bytes).digest('hex') };
}

// A backup imported under a distinct project name may have a different project ID.
// Compare all captured content by the original timeline/item IDs; never guess an
// identity mapping when import regenerates those IDs. No live-project provenance
// or uncaptured editor properties can be established from these JSON files.
function compareResolveRecovery(sourceBytes, recoveredBytes) {
  const source = read(sourceBytes);
  const recovered = read(recoveredBytes);
  const comparison = compareResolveManifests(source.manifest,
    { ...recovered.manifest, projectId: source.manifest.projectId });
  return {
    schemaVersion: 1, readOnly: true, safeToApply: false, recoveryValidated: false,
    status: comparison.changes.length ? 'observed-fields-differ' : 'observed-fields-match',
    source: { sha256: source.sha256, projectId: source.manifest.projectId, projectName: source.snapshot.project_name },
    recovered: { sha256: recovered.sha256, projectId: recovered.manifest.projectId, projectName: recovered.snapshot.project_name },
    trackIdentityStatus: comparison.trackIdentityStatus,
    changes: comparison.changes,
    limitations: ['Snapshot provenance is unverified.', 'Track identity uses type and index.',
      'Effect identities and settings, nested content, media bytes, and other uncaptured properties are unverified.']
  };
}

module.exports = { compareResolveRecovery };
