const { contextBridge, ipcRenderer } = require('electron');

// Expose a deliberately small, safe API to the renderer as integrations are added.
contextBridge.exposeInMainWorld('desktop', {
  appName: 'Git for Video Editing',
  getAppState: () => ipcRenderer.invoke('app:get-state'),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  rescanProject: () => ipcRenderer.invoke('project:rescan'),
  saveRevision: message => ipcRenderer.invoke('project:save-revision', message),
  openRevision: revisionId => ipcRenderer.invoke('project:open-revision', revisionId),
  createBranch: name => ipcRenderer.invoke('project:create-branch', name),
  switchBranch: name => ipcRenderer.invoke('project:switch-branch', name),
  relinkProject: projectId => ipcRenderer.invoke('project:relink', projectId),
  exportRevisions: () => ipcRenderer.invoke('project:export-revisions'),
  importRevisions: () => ipcRenderer.invoke('project:import-revisions'),
  getResolveReviewState: () => ipcRenderer.invoke('resolve:get-review-state'),
  chooseResolveSnapshots: () => ipcRenderer.invoke('resolve:choose-snapshots'),
  refreshResolvePreview: () => ipcRenderer.invoke('resolve:refresh-preview'),
  saveResolvePreview: () => ipcRenderer.invoke('resolve:save-preview'),
  saveResolveReview: () => ipcRenderer.invoke('resolve:save-review'),
  recoverResolvePreview: artifactId => ipcRenderer.invoke('resolve:recover-preview', artifactId),
  recoverResolveReview: artifactId => ipcRenderer.invoke('resolve:recover-review', artifactId),
  setResolveDecision: (conflictId, choice) => ipcRenderer.invoke('resolve:set-decision', conflictId, choice)
});
