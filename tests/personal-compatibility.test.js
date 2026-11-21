'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PERSONAL_COMPATIBILITY_TARGET: target, PERSONAL_OBSERVED_HOST: host,
  PERSONAL_COMPATIBILITY_OPERATIONS: operations, assessPersonalCompatibility, validatePersonalCompatibilityCatalog }
  = require('../src/personal-compatibility');
const catalog = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../phase-0/personal-compatibility-corpus.json')));
const request = (row = operations[0]) => ({ operation: row.operation, format: row.format,
  formatVersion: row.formatVersion, profile: row.profile, environment: { ...target, ...host } });

test('the published personal singleton recognizes each exact operation profile without execution or release authority', () => {
  assert.equal(operations.length, 7);
  for (const row of operations) {
    const result = assessPersonalCompatibility(request(row));
    assert.equal(result.personalProfileRecognized, true, row.operation);
    for (const key of ['safeToApply', 'executionAuthority', 'releaseSupported', 'releaseVersionCoverageProven']) assert.equal(result[key], false);
    assert.equal(result.readOnlyAssessment, true);
  }
  assert.equal(operations.find(row => row.operation === 'native-name-apply').profile, 'one-existing-video-name');
  assert.equal(operations.find(row => row.operation === 'fcpxml-proxy-review-copy').mutationScope, 'new-xml-and-derived-project-only');
  assert.equal(assessPersonalCompatibility({ ...request(), operation: 'general-native-save' }).personalProfileRecognized, false);
});

test('other editor editions, versions, builds, operating systems, host patches, architecture and formats stay outside the observed profile', () => {
  for (const [key, value] of Object.entries({ edition: 'Studio', editorVersion: '21.1.3', editorBuild: '21.1.20011',
    platform: 'win32', osVersion: '15.6.2', osBuild: '24G91', architecture: 'x86_64' })) {
    const input = request(); input.environment[key] = value;
    assert.equal(assessPersonalCompatibility(input).personalProfileRecognized, false, key);
  }
  for (const changed of [{ formatVersion: '1.11' }, { format: 'arbitrary-project' }, { profile: 'nested-multicam' }])
    assert.equal(assessPersonalCompatibility({ ...request(), ...changed }).personalProfileRecognized, false);
  assert.throws(() => assessPersonalCompatibility({ ...request(), safeToApply: true }), /assessment-input/);
  assert.throws(() => assessPersonalCompatibility({ ...request(), operation: '/Users/private/source' }), /assessment-values/);
  const missing = request(); delete missing.environment.editorBuild;
  assert.throws(() => assessPersonalCompatibility(missing), /environment-input/);
});

test('the catalog distinguishes four exports from two retained native saved databases and never invents historical OS patch provenance', () => {
  const value = catalog(); validatePersonalCompatibilityCatalog(value);
  assert.equal(value.personalSupportRange.length, 1);
  assert.equal(value.releaseSupportRange, null);
  assert.equal(value.releaseVersionCoverageProven, false);
  assert.equal(value.exports.length, 4); assert.equal(value.nativeProjects.length, 2);
  assert(value.exports.every(entry => entry.nativeRestorePoint === false));
  assert(value.nativeProjects.every(entry => entry.historicalOsPatch === 'unrecorded'));
  assert.equal(value.nativeProjects[0].sdkSavePreservationProven, false);
  assert.equal(value.nativeProjects[1].representedPictureOccurrences, 50);
  assert.equal(value.nativeProjects[1].losslessNativeImportProven, false);
  assert.equal(value.currentHostObservation.historicalProofHostPatchEstablished, false);
  assert.doesNotMatch(JSON.stringify(value), /\/Users\/|\/private\/|"base64"\s*:/);
});

test('empty native coverage, export substitution, broader ranges and proof promotion cannot close the personal gates', () => {
  for (const change of [value => value.nativeProjects.pop(), value => value.nativeProjects[0].kind = 'editor-export',
    value => value.releaseSupportRange = ['21.x'], value => value.releaseVersionCoverageProven = true,
    value => value.personalSupportRange.push({ ...target, editorVersion: '21.1.3' }),
    value => value.nativeProjects[0].sdkSavePreservationProven = true,
    value => value.nativeProjects[1].losslessNativeImportProven = true,
    value => value.currentHostObservation.historicalProofHostPatchEstablished = true,
    value => value.executionAuthority = true, value => value.nativeWriteAuthority = true,
    value => value.nativeProjects[0].census.excludedApplicationColumnCount = 1]) {
    const value = catalog(); change(value);
    assert.throws(() => validatePersonalCompatibilityCatalog(value));
  }
});
