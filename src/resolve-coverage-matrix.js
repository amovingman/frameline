'use strict';

const { inventoryStructure } = require('./fcpxml-structure');
const { buildDecorationInventory } = require('./fcpxml-decorations');

function invalid() { const error = new Error('invalid-coverage-input'); error.code = 'INVALID_COVERAGE_INPUT'; return error; }
const countEntries = (sequence, type) => sequence.tracks.filter(track => track.type === type).reduce((n, track) => n + track.entries.length, 0);
const comparison = (apiCount, xmlCount) => xmlCount === null ? 'unobservable' : apiCount === xmlCount ? 'counts-agree-identity-unresolved' : 'counts-differ';

/** Aggregate observations only: no item identity, track mapping, or application authority. */
function buildResolveCoverageMatrix(manifest, xml, options = {}) {
  if (manifest?.schemaVersion !== 1 || manifest.readOnly !== true || !Array.isArray(manifest.timelines)
    || !manifest.timelines.every(t => typeof t.id === 'string' && /^[A-Za-z0-9_-]{1,240}$/.test(t.id) && Array.isArray(t.tracks) && Array.isArray(t.items)
      && t.tracks.every(track => ['video', 'audio', 'subtitle'].includes(track.type) && Number.isSafeInteger(track.index) && track.index > 0)
      && t.items.every(item => ['video', 'audio', 'transition', 'subtitle'].includes(item.type)
        && Array.isArray(item.linkedItemIds) && ['fusion', 'ofx', 'audio'].every(key => Number.isSafeInteger(item.effectCounts?.[key]) && item.effectCounts[key] >= 0)))) throw invalid();
  const structure = inventoryStructure(xml);
  const timelines = manifest.timelines.filter(t => options.timelineId === undefined || t.id === options.timelineId);
  if (!timelines.length || (options.timelineId !== undefined && timelines.length !== 1)) throw invalid();
  const sequences = structure.sequences.filter(s => options.sequenceId === undefined || s.id === options.sequenceId);
  if (options.sequenceId !== undefined && sequences.length !== 1) throw invalid();
  // A single pair is a caller-supplied comparison scope, never proof of identity.
  const selected = timelines.length === 1 && sequences.length === 1 ? sequences[0] : null;
  let decorations = null;
  if (selected) {
    try { decorations = buildDecorationInventory(xml, { projectName: selected.name }); } catch { /* Decoration inventory's narrower supported scope remains explicit below. */ }
  }
  return {
    schemaVersion: 1, readOnly: true, identityStatus: 'unresolved', trackMapping: 'unresolved',
    scopeBasis: selected ? 'single-selected-pair-identity-unverified' : 'no-sequence-association',
    timelines: [...timelines].sort((a, b) => a.id.localeCompare(b.id)).map(timeline => {
      const items = timeline.items;
      const apiVideo = items.filter(item => item.type === 'video').length;
      const apiAudio = items.filter(item => item.type === 'audio').length;
      const apiTransitions = items.filter(item => item.type === 'transition').length;
      const effects = items.reduce((counts, item) => { for (const key of Object.keys(counts)) counts[key] += item.effectCounts[key]; return counts; }, { fusion: 0, ofx: 0, audio: 0 });
      const pictureEntries = selected ? countEntries(selected, 'video') : null;
      const audioEntries = selected ? countEntries(selected, 'audio') : null;
      const transitionEntries = selected ? selected.tracks.flatMap(track => track.entries).filter(entry => entry.kind === 'transition').length : null;
      const compoundReferences = selected ? selected.tracks.flatMap(track => track.entries).filter(entry => entry.kind === 'ref-clip').length : null;
      return {
        timelineId: timeline.id, sequenceId: selected?.id ?? null,
        coverage: {
          video: { apiItems: apiVideo, xmlPictureEntries: pictureEntries, xmlCompoundReferences: compoundReferences, status: comparison(apiVideo, pictureEntries) },
          audio: { apiItems: apiAudio, xmlExplicitEntries: audioEntries, status: comparison(apiAudio, audioEntries) },
          transitions: { apiItems: apiTransitions, xmlEntries: transitionEntries, status: comparison(apiTransitions, transitionEntries) },
          effects: { apiOccurrences: effects, xmlSerializedNodes: decorations?.effects.length ?? null, status: 'not-comparable' },
          linked: { apiItemsReportingLinks: items.filter(item => item.linkedItemIds.length > 0).length, xmlCandidateGroups: selected?.linkedAudio.length ?? null, status: 'identity-unresolved' },
          extraTracks: { apiTracks: Object.fromEntries(['video', 'audio', 'subtitle'].map(type => [type, timeline.tracks.filter(track => track.type === type).length])), xmlOccupiedLanes: selected ? Object.fromEntries(['video', 'audio', 'unknown'].map(type => [type, selected.tracks.filter(track => track.type === type).length])) : null, status: 'track-mapping-unresolved' }
        },
        omitted: [...new Set([...(selected?.unsupported ?? []), ...(decorations ? [] : ['decoration-inventory-unavailable']), ...(selected ? [] : ['sequence-association-required'])])].sort(),
        unobservable: ['api-to-xml-item-identity', 'effect-parameters-and-omitted-effects', 'empty-xml-tracks', 'linked-item-identity', 'resolve-track-to-xml-lane-mapping', 'nested-sequence-contents'],
        completeEnumeration: false, safeToApply: false
      };
    }),
    completeEnumeration: false, safeToApply: false
  };
}

module.exports = { buildResolveCoverageMatrix };
