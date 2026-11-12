const { inventoryStructure } = require('./fcpxml-structure');
function inventorySequences(xml) {
  const inventory = inventoryStructure(xml);
  return inventory.sequences.map(({ id, name, duration, unsupported }) => ({ id, name, duration, unsupported }));
}
module.exports = { inventorySequences };
