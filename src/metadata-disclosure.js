const { validateTransferBundle } = require('./revision-transfer');
const { fingerprint } = require('./project-api-contracts');

// Shows what a metadata-only push would contain. No source paths or media
// bytes are accepted by the validated revision-bundle manifest contract.
function describeRevisionSync(bundle) {
  const records = validateTransferBundle(bundle);
  let clipCount = 0, mediaReferenceCount = 0;
  for (const record of records.values()) {
    clipCount += record.manifest.clips.length;
    mediaReferenceCount += record.manifest.media.length;
  }
  return { schemaVersion: 1, projectId: bundle.projectId, revisionCount: records.size,
    clipRecordCount: clipCount, mediaReferenceCount, branchCount: Object.keys(bundle.branches).length,
    includes: ['revision messages and authors', 'sequence and clip display names', 'media display names and availability', 'content hashes and branch heads'],
    excludes: ['source paths', 'credentials', 'media bytes'], bundleHash: fingerprint(bundle),
    transferStarted: false };
}

module.exports = { describeRevisionSync };
