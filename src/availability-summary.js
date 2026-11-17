function mediaAvailabilitySummary(media) {
  if (!Array.isArray(media) || media.some(item => !item || typeof item !== 'object')) throw new TypeError('Invalid media list');
  const counts = { local: 0, missing: 0, external: 0, unknown: 0, unavailable: 0 };
  for (const item of media) {
    if (!Object.hasOwn(counts, item.availability)) throw new TypeError('Invalid media availability');
    counts[item.availability]++;
  }
  const parts = [`${media.length} referenced media assets`];
  for (const [state, label] of [['local', 'available locally'], ['missing', 'missing'],
    ['external', 'external (unchecked)'], ['unknown', 'source unspecified'], ['unavailable', 'could not check']]) {
    if (counts[state]) parts.push(`${counts[state]} ${label}`);
  }
  return parts.join(' · ');
}

if (typeof module !== 'undefined') module.exports = { mediaAvailabilitySummary };
if (typeof window !== 'undefined') window.mediaAvailabilitySummary = mediaAvailabilitySummary;
