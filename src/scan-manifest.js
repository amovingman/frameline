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

const label = value => typeof value === 'string' && value.trim().length > 0
  && !/[\\/\x00-\x1f\x7f]/.test(value) && !/^[a-z]:/i.test(value);
const frame = value => Number.isSafeInteger(value) && value >= 0;
function mediaDependencies(value) {
  if (!objectWithKeys(value, ['version', 'coverage', 'assets']) || value.version !== 1
    || !['complete', 'incomplete'].includes(value.coverage) || !Array.isArray(value.assets) || value.assets.length > 10000) return false;
  let previous = 0; const identities = new Map();
  return value.assets.every(asset => {
    if (!objectWithKeys(asset, ['referenceId', 'identity', 'required']) || asset.required !== true
      || typeof asset.referenceId !== 'string' || !/^media-[1-9]\d{0,5}$/.test(asset.referenceId)) return false;
    const index = Number(asset.referenceId.slice(6));
    if (index <= previous || index > 10000 || value.coverage === 'complete' && index !== previous + 1) return false;
    previous = index;
    const identity = asset.identity;
    const valid = objectWithKeys(identity, ['version', 'algorithm', 'contentId', 'size', 'assetClass', 'mediaType'])
      && identity.version === 1 && identity.algorithm === 'sha256'
      && typeof identity.contentId === 'string' && /^sha256:[a-f0-9]{64}$/.test(identity.contentId)
      && frame(identity.size) && identity.size <= 64 * 1024 ** 3
      && ['original', 'proxy', 'audio', 'graphics', 'other'].includes(identity.assetClass)
      && (identity.mediaType === null || typeof identity.mediaType === 'string' && identity.mediaType.length <= 127
        && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(identity.mediaType));
    if (!valid) return false;
    const prior = identities.get(identity.contentId);
    if (prior && ['version', 'algorithm', 'contentId', 'size', 'assetClass', 'mediaType'].some(key => prior[key] !== identity[key])) return false;
    identities.set(identity.contentId, identity); return true;
  });
}

function validateScanManifest(scan) {
  const bound = scan?.schemaVersion === 3;
  const valid = objectWithKeys(scan, ['schemaVersion', 'adapter', 'readOnly', 'identityStatus', 'sourceHash', 'sequence', 'clips', 'media', 'warnings', ...(bound ? ['mediaDependencies'] : [])])
    && [2, 3].includes(scan.schemaVersion)
    && (!bound || mediaDependencies(scan.mediaDependencies))
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
      && Number.isSafeInteger(clip.offsetFrames + clip.durationFrames)
      && Number.isSafeInteger(clip.sourceInFrames + clip.durationFrames)
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
