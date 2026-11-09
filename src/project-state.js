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
    scanStatus: 'idle',
    currentBranch: 'main',
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
    scanStatus: 'not-scanned',
    error: null
  };
}

module.exports = { createAppState, getProjectFormat, selectProject };
