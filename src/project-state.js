const path = require('node:path');

const supportedProjectExtensions = new Set(['.fcpxml', '.fcpxmld']);

function getProjectFormat(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!supportedProjectExtensions.has(extension)) return null;
  return extension === '.fcpxmld' ? 'FCPXML bundle' : 'FCPXML';
}

function createAppState() {
  return {
    selectedProject: null,
    scan: null,
    revisions: [],
    revisionStatus: 'idle',
    revisionError: null,
    selectedRevision: null,
    revisionDetailError: null,
    selectedComparison: null,
    comparisonError: null,
    relinkCandidates: [],
    relinkError: null,
    scanStatus: 'idle',
    currentBranch: 'main',
    branches: ['main'],
    branchError: null,
    error: null
  };
}

function selectProject(state, filePath) {
  const format = getProjectFormat(filePath);
  if (!format) return { ...state, error: 'unsupported-format' };

  return {
    ...state,
    selectedProject: { name: path.basename(filePath), format },
    scan: null,
    revisions: [],
    revisionStatus: 'idle',
    revisionError: null,
    selectedRevision: null,
    revisionDetailError: null,
    selectedComparison: null,
    comparisonError: null,
    relinkCandidates: [],
    relinkError: null,
    scanStatus: 'not-scanned',
    currentBranch: 'main',
    branches: ['main'],
    branchError: null,
    error: null
  };
}

module.exports = { createAppState, getProjectFormat, selectProject };
