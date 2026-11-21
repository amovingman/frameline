'use strict';

// Documentation and corpus recognition only. Transaction admission remains with
// the operation's existing source, identity, preservation and recovery guards.
const TARGET = Object.freeze({ editor: 'DaVinci Resolve', edition: 'Free', editorVersion: '21.1.2',
  editorBuild: '21.1.20010', platform: 'darwin' });
const HOST = Object.freeze({ osVersion: '15.6.1', osBuild: '24G90', architecture: 'arm64' });
const rows = [
  ['fcpxml-picture-scan', 'FCPXML', '1.10', 'first-sequence-top-level-picture', 'read-only',
    'Exact frames and warnings; nested content, audio and additional lanes remain omitted.'],
  ['native-checkpoint-review', 'Resolve Project.db', 'private-sqlite-profile', 'saved-flat-native-checkpoint', 'read-only',
    'Complete stored census and authenticated saved UUID/generation joins; unsaved state is not bound.'],
  ['native-name-apply', 'Resolve Project.db', 'private-sqlite-profile', 'one-existing-video-name', 'guarded-original-name-cell',
    'One existing video Name; closed source, exact backup, complete preservation and editor validation required.'],
  ['native-name-review-copy', 'Resolve Project.db', 'private-sqlite-profile', 'one-existing-video-name', 'new-native-review-copy',
    'Verified same-machine library copy; unchanged media references do not prove portability.'],
  ['native-name-pull', 'Resolve Project.db', 'private-sqlite-profile', 'one-existing-video-name', 'guarded-original-name-cell',
    'Full three-way classification, explicit conflict choices, at most one effective Name edit and recoverable Apply.'],
  ['native-result-history', 'Resolve Project.db', 'private-sqlite-profile', 'validated-native-name-result', 'read-only',
    'Historical exact choices and result bindings; exports grant neither Apply nor restore authority.'],
  ['fcpxml-proxy-review-copy', 'FCPXML', '1.10', 'flat-picture-original-proxy', 'new-xml-and-derived-project-only',
    'Exact original/proxy references and frames in a new derived review; no existing-project SDK Save or lossless import claim.']
];
const OPERATIONS = Object.freeze(rows.map(([operation, format, formatVersion, profile, mutationScope, limitation]) =>
  Object.freeze({ operation, format, formatVersion, profile, mutationScope, limitation })));
const SHA = /^[a-f0-9]{64}$/;
const fail = code => Object.assign(Error('personal-compatibility-' + code), { code: 'personal-compatibility-' + code });
const need = (value, code) => { if (!value) throw fail(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exactKeys = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && same(Object.keys(value).sort(), keys.slice().sort());

function assessPersonalCompatibility(input = {}) {
  need(exactKeys(input, ['operation', 'profile', 'format', 'formatVersion', 'environment']), 'assessment-input');
  need(exactKeys(input.environment, [...Object.keys(TARGET), ...Object.keys(HOST)]), 'environment-input');
  need(typeof input.operation === 'string' && /^[a-z0-9-]{1,79}$/.test(input.operation)
    && typeof input.profile === 'string' && /^[a-z0-9-]{1,100}$/.test(input.profile)
    && [input.format, input.formatVersion, ...Object.values(input.environment)]
      .every(value => typeof value === 'string' && value.length > 0 && value.length <= 100), 'assessment-values');
  const operation = OPERATIONS.find(row => row.operation === input.operation);
  const editorTargetMatches = Object.entries(TARGET).every(([key, value]) => input.environment[key] === value);
  const observedHostMatches = Object.entries(HOST).every(([key, value]) => input.environment[key] === value);
  const profileMatches = !!operation && ['profile', 'format', 'formatVersion'].every(key => input[key] === operation[key]);
  return { schemaVersion: 1, operation: typeof input.operation === 'string' && input.operation.length < 80 ? input.operation : null,
    personalProfileRecognized: editorTargetMatches && observedHostMatches && profileMatches,
    editorTargetMatches, observedHostMatches, profileMatches,
    reason: !editorTargetMatches ? 'outside-personal-editor-target' : !observedHostMatches ? 'outside-current-observed-host'
      : !profileMatches ? 'outside-personal-operation-profile' : 'documented-personal-profile',
    readOnlyAssessment: true, safeToApply: false, executionAuthority: false,
    releaseSupported: false, releaseVersionCoverageProven: false };
}

function validatePersonalCompatibilityCatalog(catalog) {
  need(exactKeys(catalog, ['schemaVersion', 'operation', 'personalSupportRange', 'currentHostObservation',
    'releaseSupportRange', 'releaseVersionCoverageProven', 'releaseSupported', 'safeToApply', 'executionAuthority',
    'operations', 'exports', 'nativeProjects', 'sourceHashes'])
    && catalog.schemaVersion === 1 && catalog.operation === 'owner-installed-build-compatibility-corpus', 'catalog-schema');
  need(catalog.releaseSupportRange === null && catalog.releaseVersionCoverageProven === false
    && catalog.releaseSupported === false && catalog.safeToApply === false && catalog.executionAuthority === false, 'release-scope');
  need(Array.isArray(catalog.personalSupportRange) && catalog.personalSupportRange.length === 1
    && same(catalog.personalSupportRange[0], TARGET), 'personal-range');
  need(same(catalog.operations, OPERATIONS), 'operation-profiles');
  const h = catalog.currentHostObservation;
  need(exactKeys(h, ['observedAt', 'target', 'host', 'installedInfoSha256', 'readOnly', 'historicalProofHostPatchEstablished'])
    && h.readOnly === true && h.historicalProofHostPatchEstablished === false && typeof h.observedAt === 'string'
    && Number.isFinite(Date.parse(h.observedAt)) && same(h.target, TARGET) && same(h.host, HOST)
    && SHA.test(h.installedInfoSha256 || ''), 'current-host-observation');
  need(Array.isArray(catalog.exports) && catalog.exports.length === 4
    && new Set(catalog.exports.map(entry => entry.id)).size === 4, 'export-corpus');
  for (const entry of catalog.exports) need(entry.kind === 'editor-export' && entry.format === 'FCPXML'
    && entry.formatVersion === '1.10' && SHA.test(entry.sourceSha256 || '') && SHA.test(entry.storedSha256 || '')
    && SHA.test(entry.provenanceSha256 || '') && Number.isSafeInteger(entry.sourceBytes) && entry.sourceBytes > 0
    && entry.nativeRestorePoint === false && same(entry.editor, TARGET), 'export-entry');
  need(Array.isArray(catalog.nativeProjects) && catalog.nativeProjects.length === 2
    && same(catalog.nativeProjects.map(entry => entry.id), ['closed-native-name-baseline', 'editor-saved-proxy-review']), 'native-corpus');
  for (const entry of catalog.nativeProjects) {
    need(entry.kind === 'saved-native-database' && entry.format === 'Resolve Project.db'
      && same(entry.editor, TARGET) && entry.historicalOsPatch === 'unrecorded'
      && SHA.test(entry.sourceSha256 || '') && Number.isSafeInteger(entry.sourceBytes) && entry.sourceBytes > 100
      && SHA.test(entry.proof.receiptSha256 || '') && SHA.test(entry.proof.nativeProofSha256 || ''), 'native-entry');
    const census = entry.census;
    need(census?.allPersistentTablesCovered === true && census.allSchemaObjectsCovered === true
      && census.excludedApplicationColumnCount === 0 && SHA.test(census.logicalSha256 || '')
      && SHA.test(census.schemaSha256 || '') && ['tables', 'schemaObjects', 'rows', 'cellsIncludingRowid']
        .every(key => Number.isSafeInteger(census.counts[key]) && census.counts[key] > 0), 'native-census');
  }
  need(catalog.nativeProjects[0].provenance === 'closed-checkpoint-open-readback-and-restoration'
    && catalog.nativeProjects[0].sdkSavePreservationProven === false
    && catalog.nativeProjects[1].provenance === 'sdk-save-reopen-three-admissions'
    && catalog.nativeProjects[1].representedPictureOccurrences === 50
    && catalog.nativeProjects[1].losslessNativeImportProven === false, 'native-provenance');
  need(catalog.sourceHashes && Object.keys(catalog.sourceHashes).length > 5
    && Object.entries(catalog.sourceHashes).every(([file, value]) => SHA.test(value)
      && /^[a-zA-Z0-9_./-]{1,180}$/.test(file) && !file.startsWith('/') && !file.split('/').includes('..')), 'source-pins');
  return catalog;
}

module.exports = { PERSONAL_COMPATIBILITY_TARGET: TARGET, PERSONAL_OBSERVED_HOST: HOST,
  PERSONAL_COMPATIBILITY_OPERATIONS: OPERATIONS, assessPersonalCompatibility, validatePersonalCompatibilityCatalog };
