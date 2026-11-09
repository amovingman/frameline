const { createAppState, selectProject } = require('./project-state');
const { scanFcpXml } = require('./fcpxml-adapter');

function createProjectSession(scan = scanFcpXml, metadataStore = null) {
  let state = createAppState();
  let selectedPath = null;
  let generation = 0;

  const getState = () => structuredClone(state);

  async function runScan(filePath, currentGeneration) {
    try {
      const result = await scan(filePath);
      if (currentGeneration === generation) state = { ...state, scan: result, scanStatus: 'ready', error: null };
    } catch (error) {
      if (currentGeneration === generation) state = { ...state, scan: null, scanStatus: 'error', error: error.code || 'scan-failed' };
    }
    return getState();
  }

  function startScan(filePath) {
    const currentGeneration = ++generation;
    state = { ...state, scan: null, scanStatus: 'scanning', error: null };
    return runScan(filePath, currentGeneration);
  }

  return {
    getState,
    async select(filePath) {
      const selectionGeneration = ++generation;
      const next = selectProject(state, filePath);
      if (next.error) {
        state = next;
        return getState();
      }
      selectedPath = filePath;
      state = next;
      if (metadataStore) {
        try {
          const { id, recovered } = await metadataStore.getProjectId(filePath);
          if (selectionGeneration !== generation) return getState();
          state = { ...state, selectedProject: { ...state.selectedProject, id, metadataRecovered: recovered } };
        } catch (error) {
          if (selectionGeneration === generation) state = { ...state, scanStatus: 'error', error: error.code || 'metadata-unavailable' };
          return getState();
        }
      }
      return startScan(filePath);
    },
    rescan() {
      if (state.error?.startsWith('metadata-')) return selectedPath ? this.select(selectedPath) : Promise.resolve(getState());
      return selectedPath ? startScan(selectedPath) : Promise.resolve(getState());
    }
  };
}

module.exports = { createProjectSession };
