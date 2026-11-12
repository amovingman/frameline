const { inventoryStructure } = require('./fcpxml-structure');
function inventoryTracks(xml) {
  const inventory = inventoryStructure(xml);
  return inventory.sequences.map(({ id, containers, tracks, unsupported }) => ({
    sequenceId: id,
    laneMeaning: inventory.laneMeaning,
    timingMeaning: inventory.timingMeaning,
    containers,
    tracks,
    counts: {
      serializedGaps: containers.filter(container => container.kind === 'gap').length,
      pictureEntries: tracks.filter(track => track.type === 'video').reduce((total, track) => total + track.entries.length, 0),
      audioEntries: tracks.filter(track => track.type === 'audio').reduce((total, track) => total + track.entries.length, 0),
      unknownEntries: tracks.filter(track => track.type === 'unknown').reduce((total, track) => total + track.entries.length, 0)
    },
    unsupported
  }));
}
module.exports = { inventoryTracks };
