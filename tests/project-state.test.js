const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppState, getProjectFormat, selectProject } = require('../src/project-state');

test('recognizes Resolve FCPXML files and bundles case-insensitively', () => {
  assert.equal(getProjectFormat('/work/cut.fcpxml'), 'FCPXML');
  assert.equal(getProjectFormat('/work/cut.FCPXMLD'), 'FCPXML bundle');
});

test('rejects unsupported project formats', () => {
  assert.equal(getProjectFormat('/work/cut.drp'), null);
  assert.equal(getProjectFormat('/work/notes.txt'), null);
});

test('starts with a local idle project state', () => {
  assert.deepEqual(createAppState(), {
    selectedProject: null,
    scan: null,
    revisions: [],
    revisionStatus: 'idle',
    revisionError: null,
    selectedRevision: null,
    revisionDetailError: null,
    scanStatus: 'idle',
    currentBranch: 'main',
    branches: ['main'],
    branchError: null,
    error: null
  });
});

test('selecting a supported project records safe display metadata only', () => {
  const state = selectProject(createAppState(), '/private/projects/cut.fcpxml');
  assert.deepEqual(state, {
    selectedProject: { name: 'cut.fcpxml', format: 'FCPXML' },
    scan: null,
    revisions: [],
    revisionStatus: 'idle',
    revisionError: null,
    selectedRevision: null,
    revisionDetailError: null,
    scanStatus: 'not-scanned',
    currentBranch: 'main',
    branches: ['main'],
    branchError: null,
    error: null
  });
  assert.equal(JSON.stringify(state).includes('/private/projects'), false);
});

test('unsupported selections report an error and preserve existing project state', () => {
  const selected = selectProject(createAppState(), '/work/cut.fcpxml');
  const rejected = selectProject(selected, '/work/cut.drp');
  assert.equal(rejected.error, 'unsupported-format');
  assert.deepEqual(rejected.selectedProject, selected.selectedProject);
  assert.equal(rejected.scanStatus, 'not-scanned');
});
