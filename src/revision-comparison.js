const { validateScanManifest } = require('./scan-manifest');

function compareScanRevisions(before, after) {
  validateScanManifest(before);
  validateScanManifest(after);
  const changes = [];
  for (const field of ['name', 'frameDuration', 'durationFrames']) {
    if (field === 'frameDuration') {
      const [oldNumerator, oldDenominator] = before.sequence.frameDuration.slice(0, -1).split('/').map(BigInt);
      const [newNumerator, newDenominator] = after.sequence.frameDuration.slice(0, -1).split('/').map(BigInt);
      if (oldNumerator * newDenominator === newNumerator * oldDenominator) continue;
    }
    if (before.sequence[field] !== after.sequence[field]) changes.push({
      kind: 'sequence', name: field, before: before.sequence[field], after: after.sequence[field]
    });
  }

  const oldMedia = new Map(before.media.map(item => [item.name, item.availability]));
  const newMedia = new Map(after.media.map(item => [item.name, item.availability]));
  const duplicateNames = before.media.length !== oldMedia.size || after.media.length !== newMedia.size;
  if (!duplicateNames) {
    for (const name of [...new Set([...oldMedia.keys(), ...newMedia.keys()])].sort()) {
      const oldValue = oldMedia.get(name) ?? null;
      const newValue = newMedia.get(name) ?? null;
      if (oldValue !== newValue) changes.push({ kind: 'media', name, before: oldValue, after: newValue });
    }
  }
  return {
    changes,
    mediaNamesAmbiguous: duplicateNames,
    beforeClipCount: before.clips.length,
    afterClipCount: after.clips.length,
    mediaIdentityAvailable: false,
    clipChangesAvailable: false
  };
}

module.exports = { compareScanRevisions };
