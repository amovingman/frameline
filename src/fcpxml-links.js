const { inventoryStructure } = require('./fcpxml-structure');
function inventoryLinkedAudio(xml) {
  return inventoryStructure(xml).sequences.map(({ id, linkedAudio, tracks, unsupported }) => ({
    sequenceId: id,
    explicitAudioEntries: tracks.filter(track => track.type === 'audio').flatMap(track =>
      track.entries.map(({ id: entryId, name, offset, duration, parentId }) => ({
        entryId, lane: track.lane, name, offset, duration, parentId
      }))),
    linkedAudio,
    linkageStatus: 'unresolved-without-api-ids',
    unsupported
  }));
}
module.exports = { inventoryLinkedAudio };
