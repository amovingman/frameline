const { contextBridge, ipcRenderer } = require('electron');

// Expose a deliberately small, safe API to the renderer as integrations are added.
contextBridge.exposeInMainWorld('desktop', {
  appName: 'Git for Video Editing',
  getAppState: () => ipcRenderer.invoke('app:get-state'),
  getFirstRun: () => ipcRenderer.invoke('onboarding:get'),
  saveFirstRun: selection => ipcRenderer.invoke('onboarding:save', selection),
  previewDiagnostics: () => ipcRenderer.invoke('diagnostics:preview'),
  exportDiagnostics: hash => ipcRenderer.invoke('diagnostics:export', hash),
  getSyncState: () => ipcRenderer.invoke('sync:get-state'),
  retrySync: id => ipcRenderer.invoke('sync:retry', id),
  cancelSync: id => ipcRenderer.invoke('sync:cancel', id),
  getServiceState: () => ipcRenderer.invoke('service:state'),
  connectService: input => ipcRenderer.invoke('service:connect', input),
  disconnectService: () => ipcRenderer.invoke('service:disconnect'),
  refreshServiceProjects: () => ipcRenderer.invoke('service:refresh-projects'),
  bindServiceProject: input => ipcRenderer.invoke('service:bind', input),
  unlinkServiceProject: () => ipcRenderer.invoke('service:unlink'),
  checkServiceSync: () => ipcRenderer.invoke('service:check'),
  pushServiceRevisions: () => ipcRenderer.invoke('service:push'),
  fetchServiceRevisions: () => ipcRenderer.invoke('service:fetch'),
  compareServiceRevisions: () => ipcRenderer.invoke('service:compare'),
  getResolveServiceState: () => ipcRenderer.invoke('resolve-service:state'),
  selectResolveServiceProject: projectId => ipcRenderer.invoke('resolve-service:select', projectId),
  bindResolveServiceProject: input => ipcRenderer.invoke('resolve-service:bind', input),
  unlinkResolveServiceProject: () => ipcRenderer.invoke('resolve-service:unlink'),
  checkResolveServiceSync: () => ipcRenderer.invoke('resolve-service:check'),
  pushResolveServiceRevisions: () => ipcRenderer.invoke('resolve-service:push'),
  fetchResolveServiceRevisions: () => ipcRenderer.invoke('resolve-service:fetch'),
  retryResolveServiceSync: id => ipcRenderer.invoke('resolve-service:retry', id),
  cancelResolveServiceSync: id => ipcRenderer.invoke('resolve-service:cancel', id),
  previewResolveServiceHistory: input => ipcRenderer.invoke('resolve-service:preview', input),
  getResolveComments: () => ipcRenderer.invoke('resolve-comments:state'),
  refreshResolveComments: (append = false) => ipcRenderer.invoke('resolve-comments:refresh', append),
  addResolveComment: input => ipcRenderer.invoke('resolve-comments:add', input),
  resolveResolveComment: commentId => ipcRenderer.invoke('resolve-comments:resolve', commentId),
  onResolveCommentsState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('resolve-comments:state', handle);
    return () => ipcRenderer.removeListener('resolve-comments:state', handle);
  },
  getBranchReviewState: () => ipcRenderer.invoke('branch-review:state'),
  selectBranchReview: input => ipcRenderer.invoke('branch-review:select', input),
  refreshBranchReview: input => ipcRenderer.invoke('branch-review:refresh', input),
  setBranchProtection: input => ipcRenderer.invoke('branch-review:policy', input),
  requestBranchApproval: input => ipcRenderer.invoke('branch-review:request', input),
  approveBranchRequest: input => ipcRenderer.invoke('branch-review:approve', input),
  onBranchReviewState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('branch-review:state', handle);
    return () => ipcRenderer.removeListener('branch-review:state', handle);
  },
  getShareLinksState: () => ipcRenderer.invoke('share-links:state'),
  selectShareLinks: input => ipcRenderer.invoke('share-links:select', input),
  refreshShareLinks: input => ipcRenderer.invoke('share-links:refresh', input),
  copyShareLink: input => ipcRenderer.invoke('share-links:copy', input),
  revokeShareLink: input => ipcRenderer.invoke('share-links:revoke', input),
  onShareLinksState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('share-links:state', handle);
    return () => ipcRenderer.removeListener('share-links:state', handle);
  },
  getAccountUpdatesState: () => ipcRenderer.invoke('account-updates:state'),
  refreshAccountUpdates: input => ipcRenderer.invoke('account-updates:refresh', input),
  markAccountUpdateRead: input => ipcRenderer.invoke('account-updates:read', input),
  setAccountUpdatesWatch: enabled => ipcRenderer.invoke('account-updates:watch', enabled),
  selectNotificationProject: projectId => ipcRenderer.invoke('account-updates:select', projectId),
  refreshNotificationPreferences: () => ipcRenderer.invoke('account-updates:preferences'),
  saveNotificationPreferences: input => ipcRenderer.invoke('account-updates:save', input),
  disableNotificationDelivery: input => ipcRenderer.invoke('account-updates:disable', input),
  onAccountUpdatesState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('account-updates:state', handle);
    return () => ipcRenderer.removeListener('account-updates:state', handle);
  },
  getProjectPresetsState: () => ipcRenderer.invoke('project-presets:state'),
  refreshProjectPresets: () => ipcRenderer.invoke('project-presets:refresh'),
  selectPresetTeam: teamId => ipcRenderer.invoke('project-presets:team', teamId),
  loadProjectPresets: () => ipcRenderer.invoke('project-presets:load'),
  selectProjectPreset: presetId => ipcRenderer.invoke('project-presets:select', presetId),
  saveProjectPreset: input => ipcRenderer.invoke('project-presets:save', input),
  previewProjectFromPreset: input => ipcRenderer.invoke('project-presets:preview', input),
  createProjectFromPreset: input => ipcRenderer.invoke('project-presets:create', input),
  retryProjectPresetIntent: input => ipcRenderer.invoke('project-presets:retry', input),
  dismissProjectPresetIntent: input => ipcRenderer.invoke('project-presets:dismiss', input),
  onProjectPresetsState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('project-presets:state', handle);
    return () => ipcRenderer.removeListener('project-presets:state', handle);
  },
  onResolveServiceState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('resolve-service:state', handle);
    return () => ipcRenderer.removeListener('resolve-service:state', handle);
  },
  onResolveReviewState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('resolve:review-state', handle);
    return () => ipcRenderer.removeListener('resolve:review-state', handle);
  },
  getProjectActivityState: () => ipcRenderer.invoke('project-activity:state'),
  refreshProjectActivity: input => ipcRenderer.invoke('project-activity:refresh', input),
  loadOlderProjectActivity: () => ipcRenderer.invoke('project-activity:older'),
  markProjectNotificationRead: id => ipcRenderer.invoke('project-activity:mark-read', id),
  setProjectActivityWatch: enabled => ipcRenderer.invoke('project-activity:watch', enabled),
  onProjectActivityState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('project-activity:state', handle);
    return () => ipcRenderer.removeListener('project-activity:state', handle);
  },
  getAssetTransferState: () => ipcRenderer.invoke('asset-transfer:state'),
  prepareAssetUpload: input => ipcRenderer.invoke('asset-transfer:prepare-upload', input),
  confirmAssetUpload: id => ipcRenderer.invoke('asset-transfer:confirm-upload', id),
  clearAssetUploadReview: () => ipcRenderer.invoke('asset-transfer:clear-review'),
  downloadServiceAsset: input => ipcRenderer.invoke('asset-transfer:download', input),
  resumeAssetTransfer: id => ipcRenderer.invoke('asset-transfer:resume', id),
  cancelAssetTransfer: id => ipcRenderer.invoke('asset-transfer:cancel', id),
  refreshAssetStorage: () => ipcRenderer.invoke('asset-transfer:refresh-storage'),
  saveAssetStoragePolicy: input => ipcRenderer.invoke('asset-transfer:save-policy', input),
  checkServiceAssetAvailability: id => ipcRenderer.invoke('asset-transfer:availability', id),
  setServiceAssetArchived: input => ipcRenderer.invoke('asset-transfer:archive', input),
  onAssetTransferState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('asset-transfer:state', handle);
    return () => ipcRenderer.removeListener('asset-transfer:state', handle);
  },
  onServiceState: listener => {
    if (typeof listener !== 'function') return () => {};
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('service:state', handle);
    return () => ipcRenderer.removeListener('service:state', handle);
  },
  getCollaborationState: () => ipcRenderer.invoke('collaboration:get-state'),
  inviteCollaborator: (email, role) => ipcRenderer.invoke('collaboration:invite', email, role),
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  rescanProject: () => ipcRenderer.invoke('project:rescan'),
  cancelScan: () => ipcRenderer.invoke('project:cancel-scan'),
  saveRevision: message => ipcRenderer.invoke('project:save-revision', message),
  openRevision: revisionId => ipcRenderer.invoke('project:open-revision', revisionId),
  createBranch: name => ipcRenderer.invoke('project:create-branch', name),
  switchBranch: name => ipcRenderer.invoke('project:switch-branch', name),
  relinkProject: projectId => ipcRenderer.invoke('project:relink', projectId),
  exportRevisions: () => ipcRenderer.invoke('project:export-revisions'),
  importRevisions: () => ipcRenderer.invoke('project:import-revisions'),
  getResolveReviewState: () => ipcRenderer.invoke('resolve:get-review-state'),
  getResolveTrialState: () => ipcRenderer.invoke('resolve-trial:state'),
  discoverResolveTrials: append => ipcRenderer.invoke('resolve-trial:discover', append),
  recoverDiscoveredResolveTrial: id => ipcRenderer.invoke('resolve-trial:recover-discovered', id),
  cancelDiscoveredResolveTrial: id => ipcRenderer.invoke('resolve-trial:cancel-discovered', id),
  revealResolveTrialRecords: id => ipcRenderer.invoke('resolve-trial:reveal-records', id),
  prepareResolveTrial: (projectName, acknowledged, mode = 'forced-rollback') => ipcRenderer.invoke('resolve-trial:prepare', projectName, acknowledged, mode),
  issueResolveTrial: () => ipcRenderer.invoke('resolve-trial:issue'),
  copyResolveTrialCommand: () => ipcRenderer.invoke('resolve-trial:copy'),
  cancelResolveTrialPreparation: () => ipcRenderer.invoke('resolve-trial:cancel'),
  readResolveTrial: () => ipcRenderer.invoke('resolve-trial:read'),
  saveResolveTrialRevision: () => ipcRenderer.invoke('resolve-trial:save-revision'),
  recoverResolveTrial: () => ipcRenderer.invoke('resolve-trial:recover'),
  inspectResolveTrialRecovery: () => ipcRenderer.invoke('resolve-trial:inspect'),
  revealResolveTrialBackup: () => ipcRenderer.invoke('resolve-trial:reveal-backup'),
  prepareResolveCapture: projectName => ipcRenderer.invoke('resolve-companion:prepare', projectName),
  readResolveCapture: () => ipcRenderer.invoke('resolve-companion:read'),
  saveResolveCapture: () => ipcRenderer.invoke('resolve-companion:save-snapshot'),
  saveResolveObservation: () => ipcRenderer.invoke('resolve-companion:save-observation'),
  saveResolveCaptureRevision: message => ipcRenderer.invoke('resolve-companion:save-revision', message),
  listResolveProjects: () => ipcRenderer.invoke('resolve-history:list-projects'),
  prepareResolveHistoryExport: projectId => ipcRenderer.invoke('resolve-history:prepare-export', projectId),
  prepareResolveHistoryImport: () => ipcRenderer.invoke('resolve-history:prepare-import'),
  saveResolveHistoryExport: reviewId => ipcRenderer.invoke('resolve-history:save-export', reviewId),
  importReviewedResolveHistory: reviewId => ipcRenderer.invoke('resolve-history:import-reviewed', reviewId),
  cancelResolveHistoryTransfer: reviewId => ipcRenderer.invoke('resolve-history:cancel-transfer', reviewId),
  listResolveRevisions: projectId => ipcRenderer.invoke('resolve-history:list-revisions', projectId),
  openResolveRevision: (projectId, revisionId, filters, auditOffset) => ipcRenderer.invoke('resolve-history:open-revision', projectId, revisionId, filters, auditOffset),
  getResolveRevisionGraph: projectId => ipcRenderer.invoke('resolve-history:graph', projectId),
  previewResolveHistory: (projectId, ids, includeObservations = true) => ipcRenderer.invoke('resolve-history:preview', projectId, ids, includeObservations),
  createResolveBranch: (projectId, name) => ipcRenderer.invoke('resolve-history:create-branch', projectId, name),
  switchResolveBranch: (projectId, name) => ipcRenderer.invoke('resolve-history:switch-branch', projectId, name),
  chooseResolveSnapshots: () => ipcRenderer.invoke('resolve:choose-snapshots'),
  refreshResolvePreview: () => ipcRenderer.invoke('resolve:refresh-preview'),
  saveResolvePreview: () => ipcRenderer.invoke('resolve:save-preview'),
  saveResolveReview: () => ipcRenderer.invoke('resolve:save-review'),
  recoverResolvePreview: artifactId => ipcRenderer.invoke('resolve:recover-preview', artifactId),
  recoverResolveReview: artifactId => ipcRenderer.invoke('resolve:recover-review', artifactId),
  setResolveDecision: (conflictId, choice) => ipcRenderer.invoke('resolve:set-decision', conflictId, choice),
  prepareReviewCopy: () => ipcRenderer.invoke('project:prepare-review-copy'),
  verifyReviewCopy: () => ipcRenderer.invoke('project:verify-review-copy'),
  revealReviewCopy: () => ipcRenderer.invoke('project:reveal-review-copy'),
  auditProjectMedia: target => ipcRenderer.invoke('project:audit-media', target),
  getMediaAuditState: () => ipcRenderer.invoke('media-audit:state'),
  cancelMediaAudit: id => ipcRenderer.invoke('media-audit:cancel', id),
  resumeMediaAudit: id => ipcRenderer.invoke('media-audit:resume', id),
  retryMediaAudit: id => ipcRenderer.invoke('media-audit:retry', id),
  restartMediaAudit: id => ipcRenderer.invoke('media-audit:restart', id),
  onMediaAuditState: listener => {
    if (typeof listener !== 'function') throw new TypeError('A media audit listener is required.');
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('media-audit:state', handler);
    return () => ipcRenderer.removeListener('media-audit:state', handler);
  },
  findProjectMedia: target => ipcRenderer.invoke('project:find-media', target),
  chooseResolveExport: timelineId => ipcRenderer.invoke('resolve:choose-export', timelineId),
  refreshResolveExport: () => ipcRenderer.invoke('resolve:refresh-export')
});
