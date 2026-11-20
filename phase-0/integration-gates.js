'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');
const { auditFirstEditor } = require('./audit-first-editor');
const { inspectCorpus } = require('./integration-corpus');
const { inventory, inspectIdentity, inspectPreservation } = require('../src/resolve-integration-inspection');
const { readInput } = require('./integration-input');
const { auditMenuInventoryEvidence } = require('./menu-inventory-evidence');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function auditIntegrationGates() {
  const root = path.resolve(__dirname, '..');
  const source = file => readInput(path.join(root, file));
  const before = source('phase-0/resolve-xml-proof/live-properties-enabled.json');
  const after = source('phase-0/resolve-xml-proof/live-properties-pan-changed.json');
  const restored = source('phase-0/resolve-xml-proof/live-properties-restored.json');
  const api = JSON.parse(source('phase-0/resolve-api-capabilities.json'));
  const firstEditor = auditFirstEditor();
  const corpus = inspectCorpus();
  const files = ['src/resolve-integration-inspection.js', 'phase-0/inspect-resolve-api.js',
    'phase-0/resolve-api-capabilities.json', 'phase-0/integration-corpus.json', 'phase-0/integration-corpus.js',
    'phase-0/integration-gates.js', 'phase-0/benchmark-integration.js', 'phase-0/integration-input.js',
    'phase-0/menu-inventory-evidence.js', 'phase-0/resolve-menu-inventory.lua', 'phase-0/prepare-menu-inventory.js',
    'src/companion/resolve-internal.lua', 'phase-0/resolve-menu-inventory-live-result.json.gz'];
  return { schemaVersion: 1, readOnly: true, safeToApply: false, releaseSupported: false,
    sourceHashes: Object.fromEntries(files.map(file => [file, hash(source(file))])),
    firstEditorAuditSha256: hash(JSON.stringify(canonical(firstEditor))),
    apiReference: api, corpus, enumeration: inventory(before), identity: inspectIdentity(before, restored),
    nativeMenuInventory: auditMenuInventoryEvidence(),
    changedProperty: inspectPreservation(before, after), restoration: inspectPreservation(before, restored),
    gates: firstEditor.gates.filter(gate => ['complete-timeline-enumeration', 'release-version-corpus',
      'stable-clip-and-track-identity', 'representative-scan-write-reopen', 'lossless-editor-fields'].includes(gate.id)),
    limitations: ['This command recomputes checked-in evidence; it does not connect to or write to Resolve.',
      'Native write/reopen performance needs a fresh operation-specific disposable editor run.'] };
}

function main(args) {
  const [operation, ...files] = args;
  if (operation === 'audit' && files.length === 0) return auditIntegrationGates();
  if (operation === 'inventory' && files.length === 1) return inventory(readInput(files[0]));
  if (operation === 'identity' && files.length === 2) return inspectIdentity(...files.map(readInput));
  if (operation === 'preservation' && [2, 3].includes(files.length)) return inspectPreservation(readInput(files[0]), readInput(files[1]),
    files[2] ? { expectedRename: JSON.parse(readInput(files[2])) } : {});
  if (operation === 'corpus' && files.length === 0) return inspectCorpus();
  throw new Error('integration-usage');
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)), null, 2)}\n`); }
  catch { process.stderr.write('resolve-integration-inspection-failed\n'); process.exitCode = 1; }
}
module.exports = { readInput, auditIntegrationGates, main };
