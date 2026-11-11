// Read-only diagnostic for named Frameline exports from Resolve Free 21.1.2.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inventorySequences } = require('../src/fcpxml-sequences');
const { inventoryTracks } = require('../src/fcpxml-tracks');
const { inventoryLinkedAudio } = require('../src/fcpxml-links');
const { inventoryTransitions } = require('../src/fcpxml-transitions');
const { inventoryEffects } = require('../src/fcpxml-effects');

const MAX_XML_BYTES = 20 * 1024 * 1024;

function inspectFreeExport(selectedPath) {
  const extension = path.extname(selectedPath).toLowerCase();
  if (!['.fcpxml', '.fcpxmld'].includes(extension)) throw new Error('unsupported-format');
  const xmlPath = extension === '.fcpxmld' ? path.join(selectedPath, 'Info.fcpxml') : selectedPath;
  const stat = fs.statSync(xmlPath);
  if (!stat.isFile() || stat.size > MAX_XML_BYTES) throw new Error('invalid-export');
  const bytes = fs.readFileSync(xmlPath);
  if (bytes.length > MAX_XML_BYTES) throw new Error('invalid-export');
  const xml = bytes.toString('utf8');
  const transitions = inventoryTransitions(xml);
  const effects = inventoryEffects(xml);
  return {
    readOnly: true,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    projectName: transitions.projectName,
    timingBasis: 'xml-serialized-unresolved',
    sequences: inventorySequences(xml),
    tracks: inventoryTracks(xml),
    audio: inventoryLinkedAudio(xml),
    transitions: transitions.transitions,
    effects: effects.effects,
    warnings: [...new Set([...transitions.warnings, ...effects.warnings])],
    limitations: [
      'FCPXML lane numbers are not Resolve track numbers',
      'FCPXML alone does not prove linked clip identity',
      'Only serialized effects are visible; absent editor effects cannot be assessed',
      'No edit, apply, or round-trip support is implied'
    ]
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('usage');
    process.stdout.write(`${JSON.stringify(inspectFreeExport(process.argv[2]), null, 2)}\n`);
  } catch (error) {
    const safeCode = ['usage', 'unsupported-format', 'invalid-export', 'malformed-xml', 'unsupported-fcpxml-version', 'frameline-project-required', 'ambiguous-project'].includes(error.message)
      ? error.message : 'invalid-export';
    process.stderr.write(`${safeCode}\n`);
    process.exitCode = 1;
  }
}

module.exports = { inspectFreeExport };
