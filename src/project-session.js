const { createAppState, selectProject } = require('./project-state');
const { scanFcpXml, verifyFcpXmlSource } = require('./fcpxml-adapter');

function createProjectSession(scan = scanFcpXml, metadataStore = null, verifySource = verifyFcpXmlSource) {
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
    state = { ...state, scan: null, scanStatus: 'scanning', revisionStatus: 'idle', error: null };
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
          if (metadataStore.getBranchState) {
            const branchState = await metadataStore.getBranchState(id);
            if (selectionGeneration !== generation) return getState();
            state = { ...state, ...branchState };
          }
          if (metadataStore.listRevisions) {
            const revisions = await metadataStore.listRevisions(id, state.currentBranch);
            if (selectionGeneration !== generation) return getState();
            state = { ...state, revisions };
          }
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
    },
    async saveRevision(message) {
      if (state.revisionStatus === 'saving') return getState();
      const cleanMessage = typeof message === 'string' ? message.trim() : '';
      if (!cleanMessage || cleanMessage.length > 120) {
        state = { ...state, revisionError: 'revision-message-invalid' };
        return getState();
      }
      if (!selectedPath || !state.selectedProject?.id || state.scanStatus !== 'ready' || !metadataStore?.saveRevision) {
        state = { ...state, revisionError: 'revision-scan-required' };
        return getState();
      }
      const currentGeneration = generation;
      const projectId = state.selectedProject.id;
      const manifest = structuredClone(state.scan);
      const headId = state.revisions[0]?.id || null;
      const branchName = state.currentBranch;
      state = { ...state, revisionStatus: 'saving', revisionError: null };
      try {
        await verifySource(selectedPath, manifest.sourceHash);
        if (currentGeneration !== generation) return getState();
        const revision = await metadataStore.saveRevision(projectId, manifest, cleanMessage, headId, branchName);
        if (currentGeneration === generation) state = { ...state, revisions: [revision, ...state.revisions], revisionStatus: 'idle', revisionError: null };
      } catch (error) {
        if (currentGeneration === generation) state = { ...state, revisionStatus: 'idle', revisionError: error.code || 'metadata-unavailable' };
      }
      return getState();
    },
    async openRevision(revisionId) {
      if (!state.selectedProject?.id || !metadataStore?.getRevision || typeof revisionId !== 'string') {
        state = { ...state, selectedRevision: null, revisionDetailError: 'revision-not-found' };
        return getState();
      }
      const currentGeneration = generation;
      try {
        const revision = await metadataStore.getRevision(state.selectedProject.id, revisionId);
        if (currentGeneration === generation) state = { ...state, selectedRevision: revision, revisionDetailError: null };
      } catch (error) {
        if (currentGeneration === generation) state = { ...state, selectedRevision: null, revisionDetailError: error.code || 'revision-corrupt' };
      }
      return getState();
    },
    async createBranch(name) {
      if (!state.selectedProject?.id || !metadataStore?.createBranch) {
        state = { ...state, branchError: 'branch-project-required' };
        return getState();
      }
      const currentGeneration = generation;
      try {
        const branchState = await metadataStore.createBranch(state.selectedProject.id, name, state.revisions[0]?.id || null);
        const revisions = await metadataStore.listRevisions(state.selectedProject.id, branchState.currentBranch);
        if (currentGeneration === generation) state = { ...state, ...branchState, revisions, selectedRevision: null, revisionDetailError: null, branchError: null };
      } catch (error) {
        if (currentGeneration === generation) state = { ...state, branchError: error.code || 'metadata-unavailable' };
      }
      return getState();
    },
    async switchBranch(name) {
      if (!state.selectedProject?.id || !metadataStore?.switchBranch) {
        state = { ...state, branchError: 'branch-project-required' };
        return getState();
      }
      const currentGeneration = generation;
      try {
        const branchState = await metadataStore.switchBranch(state.selectedProject.id, name);
        const revisions = await metadataStore.listRevisions(state.selectedProject.id, branchState.currentBranch);
        if (currentGeneration === generation) state = { ...state, ...branchState, revisions, selectedRevision: null, revisionDetailError: null, branchError: null };
      } catch (error) {
        if (currentGeneration === generation) state = { ...state, branchError: error.code || 'metadata-unavailable' };
      }
      return getState();
    },
    async exportRevisions() {
      if (!state.selectedProject?.id || !metadataStore?.exportRevisions) throw Object.assign(new Error('branch-project-required'), { code: 'branch-project-required' });
      return metadataStore.exportRevisions(state.selectedProject.id);
    },
    async importRevisions(bundle) {
      if (!state.selectedProject?.id || !metadataStore?.importRevisions) throw Object.assign(new Error('branch-project-required'), { code: 'branch-project-required' });
      const currentGeneration = generation;
      const projectId = state.selectedProject.id;
      const result = await metadataStore.importRevisions(projectId, bundle);
      const branchState = await metadataStore.getBranchState(projectId);
      const revisions = await metadataStore.listRevisions(projectId, branchState.currentBranch);
      if (currentGeneration === generation) state = { ...state, ...branchState, revisions };
      return { state: getState(), result };
    }
  };
}

module.exports = { createProjectSession };
