'use strict';
const { validateResolveRevisionManifest } = require('./resolve-revision-manifest');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { compareResolveManifests } = require('./resolve-id-diff');

function compareResolveRevisionManifests(before, after) {
  validateResolveRevisionManifest(before);
  validateResolveRevisionManifest(after);
  const diff = compareResolveManifests(normalizeResolveSnapshot(before.snapshot),
    normalizeResolveSnapshot(after.snapshot));
  return { ...diff, beforeSourceHash: before.sourceHash, afterSourceHash: after.sourceHash };
}
module.exports = { compareResolveRevisionManifests };
