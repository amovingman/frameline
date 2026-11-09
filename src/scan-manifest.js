const availabilityStates = new Set(['local', 'missing', 'external', 'unknown', 'unavailable']);

class ManifestError extends Error {
  constructor() {
    super('invalid-manifest');
    this.code = 'invalid-manifest';
  }
}

function objectWithKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

const label = value => typeof value === 'string' && value.trim().length > 0;
const frame = value => Number.isSafeInteger(value) && value >= 0;

function validateScanManifest(scan) {
  const valid = objectWithKeys(scan, ['schemaVersion', 'adapter', 'readOnly', 'identityStatus', 'sourceHash', 'sequence', 'clips', 'media', 'warnings'])
    && scan.schemaVersion === 2
    && scan.adapter === 'fcpxml'
    && scan.readOnly === true
    && scan.identityStatus === 'unresolved'
    && /^[a-f0-9]{64}$/.test(scan.sourceHash)
    && objectWithKeys(scan.sequence, ['name', 'frameDuration', 'durationFrames'])
    && label(scan.sequence.name)
    && /^\d+\/[1-9]\d*s$/.test(scan.sequence.frameDuration)
    && BigInt(scan.sequence.frameDuration.split('/')[0]) > 0n
    && frame(scan.sequence.durationFrames)
    && Array.isArray(scan.clips)
    && scan.clips.every((clip, index) => objectWithKeys(clip, ['scanKey', 'name', 'mediaName', 'offsetFrames', 'durationFrames', 'sourceInFrames', 'enabled', 'identityStatus'])
      && clip.scanKey === `position-${index + 1}`
      && label(clip.name)
      && label(clip.mediaName)
      && frame(clip.offsetFrames)
      && frame(clip.durationFrames)
      && frame(clip.sourceInFrames)
      && typeof clip.enabled === 'boolean'
      && clip.identityStatus === 'unresolved'
      && (index === 0 || scan.clips[index - 1].offsetFrames <= clip.offsetFrames))
    && Array.isArray(scan.media)
    && scan.media.every(item => objectWithKeys(item, ['name', 'availability'])
      && label(item.name) && availabilityStates.has(item.availability))
    && Array.isArray(scan.warnings)
    && scan.warnings.every(label);

  if (!valid) throw new ManifestError();
  return scan;
}

module.exports = { ManifestError, validateScanManifest };
