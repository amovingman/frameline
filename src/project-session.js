const { createAppState, selectProject } = require('./project-state');
const { scanFcpXml } = require('./fcpxml-adapter');

function createProjectSession(scan = scanFcpXml) {
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
    select(filePath) {
      const next = selectProject(state, filePath);
      if (next.error) {
        state = next;
        return Promise.resolve(getState());
      }
      selectedPath = filePath;
      state = next;
      return startScan(filePath);
    },
    rescan() {
      return selectedPath ? startScan(selectedPath) : Promise.resolve(getState());
    }
  };
}

module.exports = { createProjectSession };
