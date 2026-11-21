'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { auditFirstEditor } = require('./audit-first-editor');
const { EXPERIMENTAL_TARGET, assessCompatibility } = require('../src/compatibility-contract');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha = value => createHash('sha256').update(value).digest('hex');

const HISTORICAL_SUPPORT_MATRIX = 'phase-0/evidence-sources/support-matrix-observed-20261119.md.txt';
const HISTORICAL_SUPPORT_MATRIX_SHA256 = 'c25547538522d64b236cc1deff140eb04304534397ff1e32d7c521a1b331ca9b';
const HISTORICAL_PROJECT_SCOPE = 'phase-0/evidence-sources/project-scope-observed-20261119.md.txt';
const HISTORICAL_PROJECT_SCOPE_SHA256 = 'baf361bba806340342f93eacfd41e5d2d8343bde2048fabcf3cb3f89362f8e7f';

function revisitEditorChoice(read = fs.readFileSync) {
  // Recompute named live-evidence hashes. Missing, altered or incompatible
  // evidence aborts the decision rather than turning an old observation into proof.
  const audit = auditFirstEditor();
  if (EXPERIMENTAL_TARGET.editor !== 'DaVinci Resolve' || EXPERIMENTAL_TARGET.edition !== 'Free'
    || EXPERIMENTAL_TARGET.editorVersion !== '21.1.2' || EXPERIMENTAL_TARGET.editorBuild !== '21.1.20010'
    || EXPERIMENTAL_TARGET.os !== 'darwin' || EXPERIMENTAL_TARGET.format !== 'FCPXML' || EXPERIMENTAL_TARGET.formatVersion !== '1.10') throw new Error('editor-reassessment-target-changed');
  if (audit.readOnly !== true || audit.safeToApply !== false || audit.releaseSupported !== false
    || audit.gates.length !== 10 || audit.observations.externalFreeConnection !== false
    || audit.observations.relinkIdentity.stableTrackIdentityProven !== false
    || audit.observations.nativeContent.semanticEquivalenceProven !== false) throw new Error('editor-reassessment-evidence-invalid');
  const evidenceFiles = ['PROJECT_SCOPE.md', 'phase-0/project-scope.json', 'src/compatibility-contract.js', 'phase-0/audit-first-editor.js', 'phase-0/INTEGRATION_ASSESSMENT.md',
    'phase-0/FIRST_EDITOR_READINESS.md', 'phase-0/SUPPORT_MATRIX.md', 'phase-0/external-api-observation.json'];
  const evidence = Object.fromEntries(evidenceFiles.map(file => {
    // This reproduces the historical November19 decision. The current personal
    // matrix and portfolio scope describe later work, not its original inputs.
    const source = file === 'phase-0/SUPPORT_MATRIX.md' ? HISTORICAL_SUPPORT_MATRIX
      : file === 'PROJECT_SCOPE.md' ? HISTORICAL_PROJECT_SCOPE : file;
    const bytes = read(path.join(__dirname, '..', source));
    const hash = sha(bytes);
    if (file === 'phase-0/SUPPORT_MATRIX.md' && hash !== HISTORICAL_SUPPORT_MATRIX_SHA256)
      throw new Error('editor-reassessment-historical-support-matrix-changed');
    if (file === 'PROJECT_SCOPE.md' && hash !== HISTORICAL_PROJECT_SCOPE_SHA256)
      throw new Error('editor-reassessment-historical-project-scope-changed');
    return [file, hash];
  }));
  const report = {
    schemaVersion: 1, decisionDate: '2026-11-19', decision: 'stop-release-retain-read-only-experiment',
    decisionCompleted: true, releaseSupported: false, safeToApply: false,
    target: { ...EXPERIMENTAL_TARGET }, auditSha256: sha(JSON.stringify(canonical(audit))), evidence,
    alternatives: [
      { id: 'free-fcpxml', disposition: 'retain-read-only', reason: 'Proven bounded picture scanning; export identity and complete construct preservation remain unproven.' },
      { id: 'free-internal-console', disposition: 'research-only', reason: 'Read-only capture and guarded disposable rename/recovery evidence exist; complete state, track identity and general apply do not.' },
      { id: 'studio-external-api', disposition: 'not-selected', reason: 'A different edition/license and independently proven corpus/integration would be required; no Studio support is inferred.' },
      { id: 'another-editor', disposition: 'not-selected', reason: 'Another editor is outside the user-confirmed personal target. No second adapter is started by this decision.' },
      { id: 'native-byte-patching', disposition: 'rejected', reason: 'Opaque native content changes are not semantically explained. Native files are backup artifacts, not a supported edit schema.' }
    ],
    blockers: audit.gates.filter(gate => !['proven', 'not-required'].includes(gate.status)).map(gate => ({ id: gate.id, status: gate.status, evidence: gate.evidence })),
    reopeningCriteria: ['Operation-specific small disposable fixtures for the installed editor build',
      'Complete enumeration and explicit unsupported-construct inventory', 'Persistent track/item identity and unambiguous project/export mapping',
      'Lossless represented-field inventory with unexplained native differences resolved',
      'Transactional restore-point, supported API write, reopen validation and interrupted recovery on small disposable projects'],
    enforcement: { exactScanExperimental: assessCompatibility({ ...EXPERIMENTAL_TARGET, operation: 'scan' }).experimentalReadOnly,
      ordinaryWriteSupported: assessCompatibility({ ...EXPERIMENTAL_TARGET, operation: 'apply' }).writeSupported }
  };
  if (report.enforcement.ordinaryWriteSupported !== false) throw new Error('editor-reassessment-write-gate-open');
  return { ...report, decisionSha256: sha(JSON.stringify(canonical(report))) };
}
if (require.main === module) process.stdout.write(`${JSON.stringify(revisitEditorChoice(), null, 2)}\n`);
module.exports = { revisitEditorChoice };
