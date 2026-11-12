// Compare two read-only observations of the same named Free Resolve test timeline.
// Counts are coverage evidence, never stable API-item ↔ FCPXML identity.
const fs = require('node:fs');
const { inspectFreeExport } = require('./inspect-free-export');

function apiObservation(snapshot, projectName) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('invalid-api-observation');
  if (Array.isArray(snapshot.tracks) && snapshot.timeline_id) {
    const xmlName = projectName.replace(/ \(Resolve\)$/, '');
    if (!String(snapshot.provenance || '').includes('DaVinci Resolve Free 21.1.2.10')
      || !String(snapshot.provenance).includes(xmlName)) throw new Error('matching-timeline-required');
    return snapshot.tracks;
  }
  if (snapshot.schema_version === 3 && Array.isArray(snapshot.timelines)) {
    if (snapshot.resolve_version !== '21.1.2.10' || !String(snapshot.project_name || '').startsWith('Frameline')) {
      throw new Error('frameline-observation-required');
    }
    const xmlName = projectName.replace(/ \(Resolve\)$/, '');
    const matches = snapshot.timelines.filter(timeline => timeline.name === xmlName);
    if (matches.length !== 1) throw new Error('matching-timeline-required');
    const timeline = matches[0];
    if (!Array.isArray(timeline.tracks) || !Array.isArray(timeline.items)) throw new Error('invalid-api-observation');
    return timeline.tracks.map(track => ({
      type: track.type,
      items: timeline.items.filter(item => item.track_type === track.type && item.track_index === track.index)
    }));
  }
  throw new Error('invalid-api-observation');
}

function reconcileCoverage(snapshot, xmlReport) {
  if (!xmlReport?.readOnly || !Array.isArray(xmlReport.sequences) || xmlReport.sequences.length !== 1
    || !Array.isArray(xmlReport.tracks) || xmlReport.tracks.length !== 1) throw new Error('invalid-xml-observation');
  const tracks = apiObservation(snapshot, xmlReport.projectName);
  if (!tracks.every(track => ['video', 'audio', 'subtitle'].includes(track.type) && Array.isArray(track.items))) {
    throw new Error('invalid-api-observation');
  }
  const items = tracks.flatMap(track => track.items.map(item => ({ ...item, trackType: track.type })));
  const count = predicate => items.filter(predicate).length;
  const api = {
    videoTracks: tracks.filter(track => track.type === 'video').length,
    audioTracks: tracks.filter(track => track.type === 'audio').length,
    videoItems: count(item => item.trackType === 'video' && item.type === 'video'),
    audioItems: count(item => item.trackType === 'audio' && item.type === 'audio'),
    transitions: count(item => item.type === 'transition'),
    itemsReportingLinks: count(item => Array.isArray(item.linked_item_ids) ? item.linked_item_ids.length > 0 : Number(item.linked_items) > 0),
    ofxOccurrences: items.reduce((total, item) => total + Number(item.effect_counts?.ofx ?? item.ofx_effects ?? 0), 0)
  };
  if (!Object.values(api).every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid-api-observation');
  const structure = xmlReport.tracks[0];
  const xml = {
    pictureEntries: structure.counts.pictureEntries,
    compoundReferences: structure.tracks.filter(track => track.type === 'unknown')
      .flatMap(track => track.entries).filter(entry => entry.kind === 'ref-clip').length,
    explicitAudioEntries: structure.counts.audioEntries,
    transitions: xmlReport.transitions.length,
    serializedEffectNodes: xmlReport.effects.length,
    candidateAudioLinks: xmlReport.audio[0].linkedAudio.length
  };
  return {
    schemaVersion: 1,
    readOnly: true,
    identityStatus: 'unresolved',
    sourceHash: xmlReport.sourceHash,
    api,
    xml,
    coverage: {
      videoAndUnknownCount: api.videoItems === xml.pictureEntries + xml.compoundReferences ? 'counts-agree-type-and-identity-unknown' : 'counts-differ',
      audioCount: api.audioItems === xml.explicitAudioEntries ? 'counts-agree-identity-unknown' : 'counts-differ',
      transitionCount: api.transitions === xml.transitions ? 'counts-agree-identity-unknown' : 'counts-differ',
      linkedIdentity: 'unresolved',
      effectCoverage: 'not-comparable-from-xml',
      trackMapping: 'unresolved'
    },
    completeEnumeration: false,
    safeToApply: false
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('usage');
    const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const report = reconcileCoverage(snapshot, inspectFreeExport(process.argv[3]));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const code = ['usage', 'invalid-api-observation', 'invalid-xml-observation', 'frameline-observation-required', 'matching-timeline-required'].includes(error.message)
      ? error.message : 'invalid-input';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

module.exports = { reconcileCoverage };
