const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createProjectSession } = require('./project-session');
const { createLocalMetadataStore } = require('./local-metadata');
const { createResolveRevisionManifest, createResolveObservationManifest } = require('./resolve-revision-manifest');
const { compareResolveRevisionManifests, describeResolveRevisionCoverage } = require('./resolve-revision-comparison');
const { describeResolveHistoryChanges, describeResolveHistoryAudit } = require('./resolve-history-detail');
const { readResolveHistoryPreviewSources, readResolveLiveHistoryPreviewSources } = require('./resolve-history-preview');
const { fcpxmlProjectAdapter } = require('./project-adapter');
const logger = require('./logger');
const { createResolveReviewSession } = require('./resolve-review-session');
const { prepareReviewCopySession } = require('./review-copy-session');
const { compareResolveSnapshotToExport } = require('./resolve-export-candidates');
const { installResolveCompanion } = require('./resolve-companion-install');
const { createLuaCaptureCommand } = require('./resolve-menu-companion');
const { createCaptureRequest, readCaptureResponse } = require('./resolve-companion-protocol');
const { acceptConsoleOutput } = require('./resolve-console-transfer');
const { verifyReviewCopy } = require('./review-copy-verifier');
const { auditFcpxmlMedia } = require('./fcpxml-media-audit');
const { resolveFolderCandidates, sanitizeResolutionReport,
  carryObservedIdentity, evaluateMediaRequirements } = require('./local-media-readiness');
const { createSyncQueue } = require('./sync-queue');
const { createAccessControl } = require('./access-control');
const { createFirstRun } = require('./first-run');
const { createDiagnosticsReport } = require('./diagnostics-report');
const { createAdapterMetrics } = require('./adapter-metrics');
const { createResolveTrialSession } = require('./resolve-trial-session');
const { createResolveHistoryTransfer } = require('./resolve-history-transfer');

let projectSession;
let resolveReviewSession;
let resolveTrialSession;
let resolveHistoryTransfer;
let resolveSourcePaths = null;
let resolveHistoryRevisionIds = null;
let resolveBusy = false;
let selectedProjectPath = null;
let reviewCopyBusy = false;
let resolveExportPath = null;
let resolveExportTimelineId = null;
let resolveExportComparison = null;
let resolveExportError = null;
let resolveExportLocalHash = null;
let companionPending = null;
let companionVerifiedSnapshot = null;
let localMetadataStore;
let verifiedCopyPath = null;
let verifiedCopySourcePath = null;
let verifiedCopyHash = null;
let mediaAuditBusy = false;
let privateMediaAudits = {};
let syncQueue;
let collaborationAccess;
let collaborationTeam;
let firstRun;
let adapterMetrics;
const collaborationProjects = new Set();
const LOCAL_OWNER_ID = 'local-owner';
const RESOLVE_SOURCE_LIMIT = 20 * 1024 * 1024;

function ensureCollaborationProject(projectId) {
  if (!collaborationProjects.has(projectId)) {
    collaborationAccess.registerProject(LOCAL_OWNER_ID, projectId, collaborationTeam.id);
    collaborationProjects.add(projectId);
  }
}

function getCollaborationState(error = null) {
  const appState = projectSession.getState(); const projectId = appState.selectedProject?.id;
  if (!projectId) return { available: false, delivery: 'not-configured', members: [], invitations: [], error };
  ensureCollaborationProject(projectId);
  const members = collaborationAccess.listProjectMembers(LOCAL_OWNER_ID, projectId).map(member => ({
    ...member, displayName: member.userId === LOCAL_OWNER_ID ? 'You' : 'Collaborator', status: 'active'
  }));
  return { available: true, delivery: 'not-configured', projectId, members,
    invitations: collaborationAccess.listProjectInvitations(LOCAL_OWNER_ID, projectId), error };
}

function currentCopyPath() {
  const state = projectSession.getState();
  return verifiedCopyPath && verifiedCopySourcePath === selectedProjectPath
    && verifiedCopyHash === state.scan?.sourceHash && state.scanStatus === 'ready'
    && state.selectedProject?.format === 'FCPXML' && !state.error
    ? verifiedCopyPath : null;
}

function copyUnavailable() {
  return { status: 'error', error: { code: 'review-copy-unavailable', message: 'Choose and scan a regular FCPXML export before verifying a review copy.' } };
}

function copyNotVerified() {
  return { status: 'error', error: { code: 'review-copy-unverified', message: 'No verified copy is available for this export. Verify the copy again.' } };
}

function getResolveState(state = resolveReviewSession.getState()) {
  if (resolveExportLocalHash && state.sourceHashes?.local !== resolveExportLocalHash) {
    resolveExportComparison = null;
    resolveExportError = null;
    resolveExportLocalHash = null;
  }
  return { ...state, exportComparison: resolveExportComparison, exportError: resolveExportError };
}

async function readResolveExport(selectedPath) {
  const extension = path.extname(selectedPath).toLowerCase();
  if (!['.fcpxml', '.fcpxmld'].includes(extension)) throw Object.assign(new Error('Unsupported export.'), { code: 'resolve-export-invalid' });
  const filename = extension === '.fcpxmld' ? path.join(selectedPath, 'Info.fcpxml') : selectedPath;
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size <= 0 || stat.size > RESOLVE_SOURCE_LIMIT) throw Object.assign(new Error('Invalid export size.'), { code: 'resolve-export-invalid' });
  const bytes = await fs.readFile(filename);
  if (bytes.length !== stat.size) throw Object.assign(new Error('Export changed during read.'), { code: 'resolve-export-invalid' });
  return bytes;
}

async function readResolveSources(paths) {
  const sources = {};
  for (const role of ['base', 'local', 'incoming']) {
    const stat = await fs.stat(paths[role]);
    if (!stat.isFile() || stat.size <= 0 || stat.size > RESOLVE_SOURCE_LIMIT) {
      const error = new Error('Invalid Resolve snapshot size.');
      error.code = 'invalid-resolve-preview';
      throw error;
    }
    sources[role] = await fs.readFile(paths[role]);
    if (sources[role].length !== stat.size) {
      const error = new Error('Resolve snapshot changed while reading.');
      error.code = 'invalid-resolve-preview';
      throw error;
    }
  }
  return sources;
}

function hasResolveSources() { return !!resolveSourcePaths || !!resolveHistoryRevisionIds; }
async function currentResolveSources() {
  if (resolveHistoryRevisionIds) {
    if (resolveHistoryRevisionIds.liveLocalSha256) return readResolveLiveHistoryPreviewSources(
      localMetadataStore, resolveHistoryRevisionIds.projectId, resolveHistoryRevisionIds.ids,
      companionVerifiedSnapshot?.snapshot, resolveHistoryRevisionIds.liveLocalSha256);
    return readResolveHistoryPreviewSources(localMetadataStore,
      resolveHistoryRevisionIds.projectId, resolveHistoryRevisionIds.ids);
  }
  if (resolveSourcePaths) return readResolveSources(resolveSourcePaths);
  throw Object.assign(new Error('Resolve sources are unavailable.'), { code: 'invalid-resolve-preview' });
}

async function runResolveAction(action) {
  const trial = resolveTrialSession?.getState();
  if (trial?.busy || ['effect-command', 'backup-command', 'rollback-command', 'recovery-capture', 'recovery-ready', 'recovery-command', 'recovery-required'].includes(trial?.phase)) {
    return getResolveState({ ...resolveReviewSession.getState(), error: { code: 'resolve-trial-active',
      message: 'Finish the active drill or cancel its preparation before changing the review.' } });
  }
  if (resolveBusy) return getResolveState({ ...resolveReviewSession.getState(), error: { code: 'resolve-review-busy', message: 'A Resolve review action is already running.' } });
  resolveBusy = true;
  try { return getResolveState(await action()); }
  catch (error) {
    logger.warn('resolve.review-failed', { code: error.code || 'resolve-review-error' });
    return getResolveState({ ...resolveReviewSession.getState(), error: { code: error.code || 'resolve-review-error', message: 'Could not complete the Resolve review action.' } });
  } finally { resolveBusy = false; }
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 360,
    minHeight: 600,
    title: 'Frameline',
    backgroundColor: '#141415',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, 'index.html'));
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  adapterMetrics = createAdapterMetrics();
  localMetadataStore = createLocalMetadataStore(app.getPath('userData'));
  resolveHistoryTransfer = createResolveHistoryTransfer({ store: localMetadataStore });
  projectSession = createProjectSession({ ...fcpxmlProjectAdapter,
    scan: adapterMetrics.wrapScan(fcpxmlProjectAdapter.scan) }, localMetadataStore);
  syncQueue = createSyncQueue({ directory: path.join(app.getPath('userData'), 'sync') });
  collaborationAccess = createAccessControl();
  collaborationTeam = collaborationAccess.createTeam(LOCAL_OWNER_ID, 'Local workspace');
  firstRun = createFirstRun({ directory: path.join(app.getPath('userData'), 'onboarding') });
  const resolveArtifactDirectory = path.join(app.getPath('userData'), 'resolve-previews');
  resolveReviewSession = createResolveReviewSession({ artifactDirectory: resolveArtifactDirectory });
  const trialDirectory = path.join(app.getPath('userData'), 'resolve-rename-trials');
  resolveTrialSession = createResolveTrialSession({ enabled: !app.isPackaged && process.env.FRAMELINE_RENAME_DRILL === '1',
    directory: trialDirectory, store: localMetadataStore, clipboard,
    getReview: async () => resolveReviewSession.getVerifiedReview(await currentResolveSources()) });
  logger.info('app.ready', { version: app.getVersion() });
  ipcMain.handle('app:get-state', () => projectSession.getState());
  ipcMain.handle('onboarding:get', () => firstRun.read());
  ipcMain.handle('onboarding:save', (_event, selection) => firstRun.save(selection));
  const diagnostic = () => createDiagnosticsReport({ appVersion: app.getVersion(), state: projectSession.getState(),
    syncState: { connected: false, operations: syncQueue.inspect() }, adapterUsage: adapterMetrics.snapshot() });
  ipcMain.handle('diagnostics:preview', () => {
    const { report, sha256 } = diagnostic(); return { report, sha256 };
  });
  ipcMain.handle('diagnostics:export', async (_event, expectedHash) => {
    const current = diagnostic();
    if (typeof expectedHash !== 'string' || expectedHash !== current.sha256) return { saved: false, error: 'diagnostics-changed' };
    const choice = await dialog.showSaveDialog({ title: 'Export reviewed diagnostics', defaultPath: 'frameline-diagnostics.json',
      filters: [{ name: 'JSON report', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return { saved: false, cancelled: true };
    try { await fs.writeFile(choice.filePath, current.bytes, { flag: 'wx', mode: 0o600 }); return { saved: true }; }
    catch { return { saved: false, error: 'diagnostics-save-failed' }; }
  });
  ipcMain.handle('sync:get-state', () => ({ connected: false, serviceStatus: 'not-configured', operations: syncQueue.inspect() }));
  ipcMain.handle('sync:retry', (_event, id) => {
    try { syncQueue.retry(id); return { connected: false, serviceStatus: 'not-configured', operations: syncQueue.inspect() }; }
    catch (error) { return { connected: false, serviceStatus: 'not-configured', operations: syncQueue.inspect(), error: error.code || 'sync-operation-unavailable' }; }
  });
  ipcMain.handle('sync:cancel', (_event, id) => {
    try { syncQueue.cancel(id); return { connected: false, serviceStatus: 'not-configured', operations: syncQueue.inspect() }; }
    catch (error) { return { connected: false, serviceStatus: 'not-configured', operations: syncQueue.inspect(), error: error.code || 'sync-operation-unavailable' }; }
  });
  ipcMain.handle('collaboration:get-state', () => getCollaborationState());
  ipcMain.handle('collaboration:invite', (_event, email, role) => {
    const projectId = projectSession.getState().selectedProject?.id;
    if (!projectId) return getCollaborationState('invitation-project-required');
    try {
      ensureCollaborationProject(projectId);
      collaborationAccess.inviteProject(LOCAL_OWNER_ID, projectId, email, role);
      return getCollaborationState();
    } catch (error) {
      logger.warn('collaboration.invite-failed', { code: error.code || 'invitation-invalid' });
      return getCollaborationState(error.code || 'invitation-invalid');
    }
  });
  ipcMain.handle('resolve:get-review-state', () => getResolveState());
  ipcMain.handle('resolve-trial:state', () => resolveTrialSession.initialize());
  ipcMain.handle('resolve-trial:discover', (_event, append) => resolveTrialSession.refreshDiscovery(append));
  ipcMain.handle('resolve-trial:recover-discovered', (_event, id) => resolveTrialSession.recoverDiscovered(id));
  ipcMain.handle('resolve-trial:cancel-discovered', (_event, id) => resolveTrialSession.cancelDiscovered(id));
  ipcMain.handle('resolve-trial:reveal-records', async (_event, id) => {
    try { shell.showItemInFolder(await resolveTrialSession.discoveredRecordPath(id)); return resolveTrialSession.getState(); }
    catch { return { ...resolveTrialSession.getState(), error: 'The retained drill folder could not be verified. Keep the records for manual inspection.' }; }
  });
  ipcMain.handle('resolve-trial:prepare', (_event, projectName, acknowledged) => resolveTrialSession.prepare(projectName, acknowledged));
  ipcMain.handle('resolve-trial:issue', () => resolveTrialSession.issue());
  ipcMain.handle('resolve-trial:copy', () => resolveTrialSession.copyCommand());
  ipcMain.handle('resolve-trial:cancel', () => resolveTrialSession.cancelPreparation());
  ipcMain.handle('resolve-trial:read', () => resolveTrialSession.read());
  ipcMain.handle('resolve-trial:inspect', () => resolveTrialSession.inspectRecovery());
  ipcMain.handle('resolve-trial:save-revision', () => resolveTrialSession.saveRevision());
  ipcMain.handle('resolve-trial:recover', async () => {
    if (!resolveTrialSession.getState().enabled) return resolveTrialSession.getState();
    const choice = await dialog.showOpenDialog({ title: 'Recover a rename drill', defaultPath: trialDirectory, properties: ['openDirectory'] });
    return choice.canceled ? resolveTrialSession.getState() : resolveTrialSession.recover(choice.filePaths[0]);
  });
  ipcMain.handle('resolve-trial:reveal-backup', async () => {
    try { shell.showItemInFolder(await resolveTrialSession.backupPath()); return resolveTrialSession.getState(); }
    catch { return { ...resolveTrialSession.getState(), error: 'The retained backup could not be verified. Keep the trial records for recovery.' }; }
  });
  ipcMain.handle('resolve-companion:prepare', async (_event, expectedProjectName) => {
    companionPending = null;
    companionVerifiedSnapshot = null;
    try {
      const installed = await installResolveCompanion({
        bundledDirectory: path.join(__dirname, 'companion'),
        dataDirectory: path.join(app.getPath('userData'), 'resolve-companion')
      });
      const request = await createCaptureRequest({ directory: installed.requestsDirectory,
        expectedProjectName, includeProperties: true });
      const command = createLuaCaptureCommand({ luaScriptPath: installed.luaScriptPath,
        luaSource: await fs.readFile(installed.luaScriptPath, 'utf8'),
        effectSource: await fs.readFile(installed.effectScriptPath, 'utf8'), request, expectedProjectName });
      clipboard.writeText(command);
      companionPending = { directory: installed.requestsDirectory,
        requestId: request.requestId, requestSha256: request.requestSha256 };
      return { ready: true, requestId: request.requestId, expiresMinutes: 5 };
    } catch (error) {
      logger.warn('resolve.companion-prepare-failed', { code: error.code || 'resolve-companion-error' });
      return { ready: false, error: 'Could not prepare a capture. Check the exact project name and try again.' };
    }
  });
  ipcMain.handle('resolve-companion:read', async () => {
    if (!companionPending) return { ready: false, error: 'Prepare a new capture first.' };
    try {
      const transfer = acceptConsoleOutput({ output: clipboard.readText(),
        requestId: companionPending.requestId, requestSha256: companionPending.requestSha256,
        transfer: companionPending.transfer });
      if (!transfer.complete) {
        companionPending.transfer = transfer.transfer;
        clipboard.writeText(transfer.command);
        return { ready: false, collecting: true, received: transfer.transfer.chunks.length,
          total: transfer.transfer.total };
      }
      const result = await readCaptureResponse({ ...companionPending,
        responseText: transfer.responseText, includeSnapshot: true });
      companionVerifiedSnapshot = { snapshot: result.snapshot, snapshotSha256: result.snapshotSha256,
        observation: result.observation };
      return { ready: true, requestId: result.requestId, projectId: result.manifest.projectId,
        timelineCount: result.manifest.timelines.length,
        itemCount: result.manifest.timelines.reduce((sum, timeline) => sum + timeline.items.length, 0),
        snapshotSha256: result.snapshotSha256, coverage: result.coverage, readOnly: true, safeToApply: false };
    } catch (error) {
      companionVerifiedSnapshot = null;
      logger.warn('resolve.companion-read-failed', { code: error.code || 'resolve-companion-error' });
      return { ready: false, error: 'No valid capture is ready. Copy the output from Resolve’s Lua Console, then retry within five minutes.' };
    }
  });
  ipcMain.handle('resolve-companion:save-snapshot', async () => {
    const verified = companionVerifiedSnapshot;
    if (!verified) return { saved: false, error: 'Verify a capture before saving it.' };
    const choice = await dialog.showSaveDialog({ title: 'Save verified Resolve snapshot',
      defaultPath: `frameline-resolve-${verified.snapshotSha256.slice(0, 12)}.json`,
      filters: [{ name: 'Resolve snapshot JSON', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return { saved: false, cancelled: true };
    try {
      const bytes = Buffer.from(JSON.stringify(verified.snapshot));
      await fs.writeFile(choice.filePath, bytes, { flag: 'wx', mode: 0o600 });
      return { saved: true, snapshotSha256: verified.snapshotSha256 };
    } catch (error) {
      logger.warn('resolve.companion-save-failed', { code: error.code || 'resolve-companion-save-failed' });
      return { saved: false, error: 'Could not save the snapshot. Choose a new filename and try again.' };
    }
  });
  ipcMain.handle('resolve-companion:save-revision', async (_event, message) => {
    const verified = companionVerifiedSnapshot;
    if (!verified) return { saved: false, error: 'Verify a capture before saving a revision.' };
    try {
      const manifest = verified.observation ? createResolveObservationManifest(verified.observation)
        : createResolveRevisionManifest(verified.snapshot);
      if (typeof message !== 'string' || !message.trim() || message.trim().length > 120
        || /[\\/\x00-\x1f\x7f]/.test(message) || /^[a-z]:/i.test(message)) {
        return { saved: false, error: 'Enter a revision message of 1 to 120 characters.' };
      }
      const project = await localMetadataStore.getResolveProjectId(manifest.snapshot.project_id,
        manifest.snapshot.project_name);
      const branch = (await localMetadataStore.getBranchState(project.id)).currentBranch;
      const revisions = await localMetadataStore.listRevisions(project.id, branch);
      const parent = revisions[0] ? await localMetadataStore.getRevision(project.id, revisions[0].id) : null;
      const comparison = parent ? compareResolveRevisionManifests(parent.manifest, manifest) : null;
      if (comparison && comparison.changes.length === 0 && !comparison.coverageChanged) {
        return { saved: false, unchanged: true, branch, message: 'No observed fields changed from the branch head.' };
      }
      const revision = await localMetadataStore.saveRevision(project.id, manifest, message.trim(), revisions[0]?.id || null, branch);
      return { saved: true, revisionId: revision.id, branch,
        contentHash: revision.contentHash, changeCount: comparison?.changes.length ?? null,
        readOnly: true, safeToApply: false };
    } catch (error) {
      logger.warn('resolve.companion-revision-failed', { code: error.code || 'resolve-companion-revision-failed' });
      return { saved: false, error: 'Could not save the observation. Refresh history and retry.' };
    }
  });
  ipcMain.handle('resolve-history:list-projects', async () => {
    try {
      const projects = await localMetadataStore.listResolveProjects();
      return { ready: true, projects: projects.map(({ id, displayName, currentBranch, revisionCount }) =>
        ({ id, displayName, currentBranch, revisionCount })) };
    }
    catch (error) {
      logger.warn('resolve.history-list-failed', { code: error.code || 'resolve-history-error' });
      return { ready: false, error: 'Could not read local Resolve history.' };
    }
  });
  const backupFailure = error => {
    logger.warn('resolve.history-transfer-failed', { code: error.code || 'resolve-backup-invalid' });
    const messages = {
      'resolve-backup-changed': 'History changed after review. Prepare the backup again.',
      'resolve-backup-size': 'Choose a nonempty Resolve revision backup under 50 MB.',
      'resolve-backup-review-expired': 'This review expired. Prepare the backup again.',
      'resolve-backup-project-missing': 'Choose a saved Resolve project before exporting.',
      'resolve-backup-busy': 'A backup action is already running. Wait for it to finish.',
      EEXIST: 'That filename already exists. Choose a new filename.'
    };
    return { ready: false, error: messages[error.code] || 'The backup could not be verified or saved. Choose a valid Resolve revision backup and try again.' };
  };
  ipcMain.handle('resolve-history:prepare-export', async (_event, projectId) => {
    try { return await resolveHistoryTransfer.prepareExport(projectId); } catch (error) { return backupFailure(error); }
  });
  ipcMain.handle('resolve-history:prepare-import', async () => {
    const choice = await dialog.showOpenDialog({ title: 'Review Resolve revision backup', properties: ['openFile'],
      filters: [{ name: 'Frameline revision backup', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePaths.length) return { cancelled: true };
    try { return await resolveHistoryTransfer.prepareImport(choice.filePaths[0]); } catch (error) { return backupFailure(error); }
  });
  ipcMain.handle('resolve-history:save-export', async (_event, token) => {
    const choice = await dialog.showSaveDialog({ title: 'Save reviewed Resolve revision backup', defaultPath: 'frameline-resolve-history.json',
      filters: [{ name: 'Frameline revision backup', extensions: ['json'] }] });
    if (choice.canceled || !choice.filePath) return { cancelled: true };
    try { return await resolveHistoryTransfer.saveExport(token, choice.filePath); } catch (error) { return backupFailure(error); }
  });
  ipcMain.handle('resolve-history:import-reviewed', async (_event, token) => {
    try { return await resolveHistoryTransfer.importReviewed(token); } catch (error) { return backupFailure(error); }
  });
  ipcMain.handle('resolve-history:cancel-transfer', async (_event, token) => {
    try { return await resolveHistoryTransfer.cancel(token); } catch (error) { return backupFailure(error); }
  });
  ipcMain.handle('resolve-history:list-revisions', async (_event, projectId) => {
    try {
      const project = (await localMetadataStore.listResolveProjects()).find(item => item.id === projectId);
      if (!project) return { ready: false, error: 'Choose a local Resolve project.' };
      const revisions = await localMetadataStore.listRevisions(projectId, project.currentBranch);
      return { ready: true, projectId, branch: project.currentBranch, total: revisions.length,
        revisions: revisions.slice(0, 100).map(({ id, parentRevisionId, createdAt, message, contentHash }) =>
          ({ id, parentRevisionId, createdAt, message, contentHash })) };
    } catch (error) {
      logger.warn('resolve.history-revisions-failed', { code: error.code || 'resolve-history-error' });
      return { ready: false, error: 'Could not read local Resolve revisions.' };
    }
  });
  ipcMain.handle('resolve-history:open-revision', async (_event, projectId, revisionId, filters, auditOffset) => {
    try {
      const project = (await localMetadataStore.listResolveProjects()).find(item => item.id === projectId);
      if (!project || typeof revisionId !== 'string' || !/^[a-f0-9-]{36}$/.test(revisionId)) {
        return { ready: false, error: 'Choose a local Resolve revision.' };
      }
      const revision = await localMetadataStore.getRevision(projectId, revisionId);
      if (revision.manifest.format !== 'resolve-api-observation') throw new Error('resolve-history-invalid');
      const parent = revision.parentRevisionId
        ? await localMetadataStore.getRevision(projectId, revision.parentRevisionId) : null;
      const detail = parent ? describeResolveHistoryChanges(parent.manifest, revision.manifest, filters) : null;
      return { ready: true, revisionId, parentRevisionId: revision.parentRevisionId,
        message: revision.message, createdAt: revision.createdAt,
        sourceHash: revision.manifest.sourceHash, changeCount: detail?.changeCount ?? null,
        observationCoverage: describeResolveRevisionCoverage(revision.manifest), comparisonCoverage: detail?.coverage || null,
        filteredCount: detail?.filteredCount ?? null, options: detail?.options || null,
        changes: detail?.changes || [], trialAudit: describeResolveHistoryAudit(revision.manifest, auditOffset),
        readOnly: true, safeToApply: false };
    } catch (error) {
      logger.warn('resolve.history-open-failed', { code: error.code || 'resolve-history-error' });
      return { ready: false, error: 'This revision could not be verified.' };
    }
  });
  ipcMain.handle('resolve-history:graph', async (_event, projectId) => {
    try {
      const graph = await localMetadataStore.getResolveRevisionGraph(projectId);
      return { ready: true, projectId, branches: graph.branches, currentBranch: graph.currentBranch,
        revisions: graph.revisions.map(({ id, parentRevisionId, message, createdAt, contentHash }) =>
          ({ id, parentRevisionId, message, createdAt, contentHash })) };
    } catch (error) {
      logger.warn('resolve.history-graph-failed', { code: error.code || 'resolve-history-error' });
      return { ready: false, error: 'Could not read this Resolve revision graph.' };
    }
  });
  ipcMain.handle('resolve-history:create-branch', async (_event, projectId, name) => {
    try {
      const graph = await localMetadataStore.getResolveRevisionGraph(projectId);
      const state = await localMetadataStore.createBranch(projectId, name,
        graph.branches[graph.currentBranch]);
      return { ready: true, currentBranch: state.currentBranch, branches: state.branches };
    } catch (error) {
      logger.warn('resolve.history-create-branch-failed', { code: error.code || 'resolve-history-error' });
      return { ready: false, error: 'Could not create this branch. Use a unique lowercase name with letters, numbers, dots, underscores, or hyphens.' };
    }
  });
  ipcMain.handle('resolve-history:switch-branch', async (_event, projectId, name) => {
    try {
      await localMetadataStore.getResolveRevisionGraph(projectId);
      const state = await localMetadataStore.switchBranch(projectId, name);
      return { ready: true, currentBranch: state.currentBranch, branches: state.branches };
    } catch (error) {
      logger.warn('resolve.history-switch-branch-failed', { code: error.code || 'resolve-history-error' });
      return { ready: false, error: 'Could not switch to this Resolve branch. Refresh history and try again.' };
    }
  });
  ipcMain.handle('resolve-history:preview', (_event, projectId, ids) => runResolveAction(async () => {
    let sources;
    const liveLocalSha256 = ids?.local === 'verified-capture' ? companionVerifiedSnapshot?.snapshotSha256 : null;
    try {
      sources = ids?.local === 'verified-capture'
        ? await readResolveLiveHistoryPreviewSources(localMetadataStore, projectId,
          { base: ids.base, incoming: ids.incoming }, companionVerifiedSnapshot?.snapshot, liveLocalSha256)
        : await readResolveHistoryPreviewSources(localMetadataStore, projectId, ids);
    }
    catch { return { ...resolveReviewSession.getState(), error: { code: 'resolve-history-preview-invalid',
      message: 'Choose verified sources from one Resolve project. The base must precede the incoming revision and the current branch head.' } }; }
    const state = resolveReviewSession.load(sources);
    if (state.status === 'ready') {
      resolveHistoryRevisionIds = { projectId, ids: liveLocalSha256
        ? { base: ids.base, incoming: ids.incoming } : { ...ids }, liveLocalSha256 };
      resolveSourcePaths = null;
      resolveExportComparison = resolveExportError = resolveExportPath = resolveExportTimelineId = resolveExportLocalHash = null;
    }
    return state;
  }));
  ipcMain.handle('resolve:choose-snapshots', () => runResolveAction(async () => {
    const paths = {};
    for (const role of ['base', 'local', 'incoming']) {
      const result = await dialog.showOpenDialog({
        title: `Choose ${role} Resolve snapshot`,
        properties: ['openFile'],
        filters: [{ name: 'Resolve API snapshot', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePaths.length) return resolveReviewSession.getState();
      paths[role] = result.filePaths[0];
    }
    const sources = await readResolveSources(paths);
    const state = resolveReviewSession.load(sources);
    if (state.status === 'ready') { resolveSourcePaths = paths; resolveHistoryRevisionIds = null; }
    return state;
  }));
  ipcMain.handle('resolve:refresh-preview', () => runResolveAction(async () => {
    if (!hasResolveSources()) return resolveReviewSession.getState();
    return resolveReviewSession.refresh(await currentResolveSources());
  }));
  ipcMain.handle('resolve:save-preview', () => runResolveAction(async () => {
    if (!hasResolveSources()) return resolveReviewSession.getState();
    const refreshed = resolveReviewSession.refresh(await currentResolveSources());
    if (refreshed.sourceVerification?.changed) return { ...refreshed, error: { code: 'resolve-source-changed', message: 'Snapshot files changed. Preview refreshed; inspect it before saving.' } };
    if (refreshed.status !== 'ready') return refreshed;
    await fs.mkdir(resolveArtifactDirectory, { recursive: true, mode: 0o700 });
    return resolveReviewSession.save();
  }));
  ipcMain.handle('resolve:save-review', () => runResolveAction(async () => {
    if (!hasResolveSources()) return resolveReviewSession.getState();
    const refreshed = resolveReviewSession.refresh(await currentResolveSources());
    if (refreshed.sourceVerification?.changed) return { ...refreshed, error: { code: 'resolve-source-changed', message: 'Snapshot files changed. Previous choices cleared; review the new comparison before saving.' } };
    if (refreshed.status !== 'ready') return refreshed;
    await fs.mkdir(resolveArtifactDirectory, { recursive: true, mode: 0o700 });
    return resolveReviewSession.saveReview();
  }));
  ipcMain.handle('resolve:recover-preview', (_event, artifactId) => runResolveAction(async () => {
    if (!hasResolveSources()) return resolveReviewSession.getState();
    return resolveReviewSession.recover(artifactId, await currentResolveSources());
  }));
  ipcMain.handle('resolve:recover-review', (_event, artifactId) => runResolveAction(async () => {
    if (!hasResolveSources()) return resolveReviewSession.getState();
    return resolveReviewSession.recoverReview(artifactId, await currentResolveSources());
  }));
  ipcMain.handle('resolve:set-decision', (_event, conflictId, choice) => runResolveAction(
    () => resolveReviewSession.setDecision(conflictId, choice)));
  ipcMain.handle('resolve:choose-export', (_event, requestedTimelineId) => runResolveAction(async () => {
    if (!hasResolveSources()) {
      resolveExportError = { code: 'resolve-export-unavailable', message: 'Choose the three Resolve snapshots before matching an export.' };
      return resolveReviewSession.getState();
    }
    const sources = await currentResolveSources();
    const state = resolveReviewSession.refresh(sources);
    if (state.status !== 'ready') return state;
    const timelines = JSON.parse(sources.local.toString('utf8')).timelines;
    const timelineId = typeof requestedTimelineId === 'string' && requestedTimelineId !== 'all'
      ? requestedTimelineId : timelines.length === 1 ? timelines[0].id : null;
    if (!timelineId || !timelines.some(item => item.id === timelineId)) {
      resolveExportError = { code: 'resolve-export-select-timeline', message: 'Select one local timeline before matching an FCPXML export.' };
      return state;
    }
    const result = await dialog.showOpenDialog({
      title: 'Choose an FCPXML export for candidate matching',
      properties: ['openFile', 'treatPackageAsDirectory'],
      filters: [{ name: 'Resolve FCPXML export', extensions: ['fcpxml', 'fcpxmld'] }]
    });
    if (result.canceled || !result.filePaths.length) return state;
    try {
      const exportBytes = await readResolveExport(result.filePaths[0]);
      resolveExportComparison = compareResolveSnapshotToExport(sources.local, exportBytes, timelineId);
      resolveExportPath = result.filePaths[0];
      resolveExportTimelineId = timelineId;
      resolveExportLocalHash = state.sourceHashes.local;
      resolveExportError = null;
    } catch (error) {
      resolveExportComparison = null;
      resolveExportError = { code: error.code || 'resolve-export-invalid', message: 'This export cannot be matched to the selected flat picture timeline.' };
    }
    return state;
  }));
  ipcMain.handle('resolve:refresh-export', () => runResolveAction(async () => {
    if (!hasResolveSources() || !resolveExportPath || !resolveExportTimelineId) {
      resolveExportError = { code: 'resolve-export-unavailable', message: 'Choose an FCPXML export before refreshing its candidates.' };
      return resolveReviewSession.getState();
    }
    const sources = await currentResolveSources();
    const state = resolveReviewSession.refresh(sources);
    if (state.status !== 'ready') return state;
    try {
      resolveExportComparison = compareResolveSnapshotToExport(sources.local,
        await readResolveExport(resolveExportPath), resolveExportTimelineId);
      resolveExportLocalHash = state.sourceHashes.local;
      resolveExportError = null;
    } catch (error) {
      resolveExportComparison = null;
      resolveExportLocalHash = null;
      resolveExportError = { code: error.code || 'resolve-export-invalid', message: 'The export or local snapshot changed. Choose a valid flat picture export again.' };
    }
    return state;
  }));
  ipcMain.handle('project:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a DaVinci Resolve timeline',
      properties: ['openFile', 'treatPackageAsDirectory'],
      filters: [{ name: 'DaVinci Resolve timeline exchange', extensions: ['fcpxml', 'fcpxmld'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      logger.info('project.selection-cancelled');
      return projectSession.getState();
    }
    const selectedPath = result.filePaths[0];
    const state = await projectSession.select(selectedPath);
    selectedProjectPath = state.error === 'unsupported-format' ? null : selectedPath;
    verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
    privateMediaAudits = {};
    if (state.error === 'unsupported-format') {
      logger.warn('project.selection-rejected', { filePath: selectedPath });
    } else {
      logger.info('project.selected', {
        format: state.selectedProject.format,
        filePath: selectedPath
      });
      if (state.scanStatus === 'ready') logger.info('project.scan-complete', { clipCount: state.scan.clips.length, warningCount: state.scan.warnings.length });
      else logger.warn('project.scan-failed', { code: state.error });
    }
    return state;
  });
  ipcMain.handle('project:rescan', async () => {
    const previousHash = projectSession.getState().scan?.sourceHash;
    const state = await projectSession.rescan();
    if (state.scanStatus !== 'ready' || state.scan?.sourceHash !== verifiedCopyHash) {
      verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
    }
    if (state.scan?.sourceHash !== previousHash) privateMediaAudits = {};
    if (state.scanStatus === 'ready') logger.info('project.rescan-complete', { clipCount: state.scan.clips.length, warningCount: state.scan.warnings.length });
    else if (state.scanStatus === 'error') logger.warn('project.rescan-failed', { code: state.error });
    return state;
  });
  ipcMain.handle('project:cancel-scan', () => projectSession.cancelScan());
  ipcMain.handle('project:prepare-review-copy', async () => {
    if (reviewCopyBusy) return { status: 'error', error: { code: 'review-copy-busy', message: 'A review copy is already being prepared.' } };
    const state = projectSession.getState();
    if (!selectedProjectPath || state.scanStatus !== 'ready' || state.selectedProject?.format !== 'FCPXML'
      || !state.scan?.sourceHash || state.error) {
      return { status: 'error', error: { code: 'review-copy-unavailable', message: 'Choose and scan a regular FCPXML export before making a review copy.' } };
    }
    reviewCopyBusy = true;
    try {
      const sourcePath = selectedProjectPath;
      const extension = path.extname(sourcePath);
      const base = path.basename(sourcePath, extension);
      const result = await dialog.showSaveDialog({
        title: 'Choose a location for a verified review copy',
        defaultPath: `${base}-review.fcpxml`,
        filters: [{ name: 'FCPXML review copy', extensions: ['fcpxml'] }]
      });
      if (result.canceled || !result.filePath) return { status: 'canceled' };
      if (selectedProjectPath !== sourcePath
        || state.selectedProject.id !== projectSession.getState().selectedProject?.id) {
        return { status: 'error', error: { code: 'review-copy-unavailable', message: 'Project selection changed. Choose the current export and try again.' } };
      }
      const prepared = await prepareReviewCopySession({
        sourcePath,
        expectedSha256: state.scan.sourceHash,
        destinationDirectory: path.dirname(result.filePath),
        preferredFilename: path.basename(result.filePath)
      });
      if (prepared.status === 'ready' && selectedProjectPath === sourcePath
        && projectSession.getState().scan?.sourceHash === state.scan.sourceHash) {
        verifiedCopyPath = path.join(path.dirname(result.filePath), prepared.copyName);
        verifiedCopySourcePath = sourcePath;
        verifiedCopyHash = state.scan.sourceHash;
      }
      return prepared;
    } catch (error) {
      logger.warn('review-copy.failed', { code: error.code || 'review-copy-failed' });
      return { status: 'error', error: { code: 'review-copy-failed', message: 'Unable to prepare a verified review copy.' } };
    } finally { reviewCopyBusy = false; }
  });
  ipcMain.handle('project:verify-review-copy', async () => {
    if (reviewCopyBusy) return { status: 'error', error: { code: 'review-copy-busy', message: 'A review copy check is already running.' } };
    const state = projectSession.getState();
    if (!selectedProjectPath || state.scanStatus !== 'ready' || state.selectedProject?.format !== 'FCPXML'
      || !state.scan?.sourceHash || state.error) return copyUnavailable();
    reviewCopyBusy = true;
    try {
      const sourcePath = selectedProjectPath;
      const result = await dialog.showOpenDialog({
        title: 'Choose an unchanged FCPXML review copy to verify',
        properties: ['openFile'],
        filters: [{ name: 'FCPXML review copy', extensions: ['fcpxml'] }]
      });
      if (result.canceled || !result.filePaths.length) return { status: 'canceled' };
      if (selectedProjectPath !== sourcePath || projectSession.getState().scan?.sourceHash !== state.scan.sourceHash) return copyUnavailable();
      const copyPath = result.filePaths[0];
      const verified = await verifyReviewCopy({ sourcePath, copyPath, expectedSha256: state.scan.sourceHash });
      if (verified.status === 'ready' && selectedProjectPath === sourcePath
        && projectSession.getState().scan?.sourceHash === state.scan.sourceHash) {
        verifiedCopyPath = copyPath;
        verifiedCopySourcePath = sourcePath;
        verifiedCopyHash = state.scan.sourceHash;
      } else if (verified.status !== 'ready') {
        verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
      }
      return verified;
    } catch (error) {
      logger.warn('review-copy.verify-failed', { code: error.code || 'review-copy-failed' });
      return { status: 'error', error: { code: 'review-copy-failed', message: 'Unable to verify the FCPXML review copy.' } };
    } finally { reviewCopyBusy = false; }
  });
  ipcMain.handle('project:reveal-review-copy', async () => {
    if (reviewCopyBusy) return { status: 'error', error: { code: 'review-copy-busy', message: 'A review copy check is already running.' } };
    const copyPath = currentCopyPath();
    if (!copyPath) return copyNotVerified();
    reviewCopyBusy = true;
    try {
      const state = projectSession.getState();
      const verified = await verifyReviewCopy({ sourcePath: selectedProjectPath,
        copyPath, expectedSha256: state.scan.sourceHash });
      if (verified.status !== 'ready' || copyPath !== currentCopyPath()) {
        verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
        return verified.status === 'ready' ? copyNotVerified() : verified;
      }
      shell.showItemInFolder(copyPath);
      return verified;
    } catch (error) {
      logger.warn('review-copy.reveal-failed', { code: error.code || 'review-copy-failed' });
      return { status: 'error', error: { code: 'review-copy-failed', message: 'Unable to reveal the verified FCPXML review copy.' } };
    } finally { reviewCopyBusy = false; }
  });
  ipcMain.handle('project:audit-media', async (_event, target) => {
    if (mediaAuditBusy) return { status: 'error', error: { code: 'media-audit-busy', message: 'A media audit is already running.' } };
    const state = projectSession.getState();
    if (!['source', 'copy'].includes(target) || !selectedProjectPath || state.scanStatus !== 'ready'
      || state.selectedProject?.format !== 'FCPXML' || !state.scan?.sourceHash || state.error) {
      return { status: 'error', error: { code: 'media-audit-unavailable', message: 'Choose and scan a regular FCPXML export before auditing its media.' } };
    }
    const copyPath = target === 'copy' ? currentCopyPath() : null;
    if (target === 'copy' && !copyPath) return copyNotVerified();
    mediaAuditBusy = true;
    try {
      const sourcePath = selectedProjectPath;
      const expectedHash = state.scan.sourceHash;
      if (target === 'copy') {
        const verified = await verifyReviewCopy({ sourcePath, copyPath, expectedSha256: expectedHash });
        if (verified.status !== 'ready') {
          verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
          return verified;
        }
      }
      const report = await auditFcpxmlMedia({ exportPath: target === 'copy' ? copyPath : sourcePath,
        expectedSourceHash: expectedHash });
      if (selectedProjectPath !== sourcePath || projectSession.getState().scan?.sourceHash !== expectedHash) return copyUnavailable();
      report.assets = carryObservedIdentity(report.assets,
        privateMediaAudits[target]?.sourceHash === report.sourceHash ? privateMediaAudits[target].assets : []);
      privateMediaAudits[target] = report;
      const requirements = evaluateMediaRequirements({ schemaVersion: 1,
        items: report.assets.map(asset => ({ id: asset.id, required: true, state: asset.status,
          availabilityReason: asset.reason, verified: asset.identityVerified,
          reason: asset.identityVerified ? 'prior-size-and-hash-match'
            : asset.fingerprint ? 'expected-identity-unavailable' : 'original-unavailable' })) });
      return { status: 'ready', sourceHash: report.sourceHash, counts: report.counts,
        assets: report.assets.map(({ fingerprint, expectedFingerprint, ...asset }) => ({ ...asset,
          fingerprintAvailable: !!fingerprint, expectedIdentityAvailable: !!expectedFingerprint,
          size: fingerprint?.size ?? null })),
        requirements, identityVerified: false, error: null };
    } catch (error) {
      logger.warn('media.audit-failed', { code: error.code || 'media-audit-failed' });
      return { status: 'error', error: { code: 'media-audit-failed', message: 'Unable to audit media for this FCPXML export.' } };
    } finally { mediaAuditBusy = false; }
  });
  ipcMain.handle('project:find-media', async (_event, target) => {
    if (mediaAuditBusy) return { status: 'error', error: { code: 'media-audit-busy', message: 'A media check is already running.' } };
    const state = projectSession.getState();
    const audit = privateMediaAudits[target];
    if (!['source', 'copy'].includes(target) || !audit || state.scanStatus !== 'ready'
      || audit.sourceHash !== state.scan?.sourceHash) return { status: 'error', error: {
        code: 'media-search-unavailable', message: 'Run the media audit before choosing a search folder.' } };
    const unresolved = audit.assets.filter(asset => asset.status !== 'local' && asset.status !== 'excluded');
    if (!unresolved.length) return { status: 'ready', canceled: false,
      ...sanitizeResolutionReport({ items: [], resolvedCount: 0, ambiguousCount: 0 }) };
    const selected = await dialog.showOpenDialog({ title: 'Choose a folder to search for moved media', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths.length) return { status: 'ready', canceled: true };
    mediaAuditBusy = true;
    try {
      const result = await resolveFolderCandidates(selected.filePaths[0], unresolved.map(asset => ({
        id: asset.id, name: asset.displayNames[0] || 'Untitled media',
        expected: asset.expectedFingerprint || asset.fingerprint || undefined
      })));
      if (audit !== privateMediaAudits[target] || audit.sourceHash !== projectSession.getState().scan?.sourceHash) {
        return { status: 'error', error: { code: 'media-search-stale', message: 'The export changed. Run the media audit again.' } };
      }
      return { status: 'ready', canceled: false, ...sanitizeResolutionReport(result) };
    } catch (error) {
      logger.warn('media.search-failed', { code: error.code || 'media-search-failed' });
      return { status: 'error', error: { code: 'media-search-failed', message: 'The selected folder could not be searched safely.' } };
    } finally { mediaAuditBusy = false; }
  });
  ipcMain.handle('project:save-revision', async (_event, message) => {
    const state = await projectSession.saveRevision(message);
    if (state.revisionError) logger.warn('revision.save-failed', { code: state.revisionError });
    else if (state.revisionStatus === 'idle' && state.revisions.length) logger.info('revision.saved', { projectId: state.selectedProject.id, revisionId: state.revisions[0].id });
    return state;
  });
  ipcMain.handle('project:open-revision', async (_event, revisionId) => projectSession.openRevision(revisionId));
  ipcMain.handle('project:create-branch', async (_event, name) => projectSession.createBranch(name));
  ipcMain.handle('project:switch-branch', async (_event, name) => projectSession.switchBranch(name));
  ipcMain.handle('project:relink', async (_event, projectId) => projectSession.relinkProject(projectId));
  ipcMain.handle('project:export-revisions', async () => {
    try {
      const bundle = await projectSession.exportRevisions();
      const result = await dialog.showSaveDialog({
        title: 'Export revision backup',
        defaultPath: 'frameline-revisions.json',
        filters: [{ name: 'Frameline revision backup', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const tempPath = `${result.filePath}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(tempPath, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(bundle, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(tempPath, result.filePath);
      } finally { await fs.rm(tempPath, { force: true }).catch(() => {}); }
      return { revisionCount: bundle.records.length, branchCount: Object.keys(bundle.branches).length };
    } catch (error) {
      logger.warn('revision.export-failed', { code: error.code || 'metadata-unavailable' });
      return { error: error.code || 'metadata-unavailable' };
    }
  });
  ipcMain.handle('project:import-revisions', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import revision backup',
      properties: ['openFile'],
      filters: [{ name: 'Frameline revision backup', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    try {
      const filePath = result.filePaths[0];
      const stat = await fs.stat(filePath);
      if (stat.size > 50 * 1024 * 1024) return { error: 'revision-transfer-too-large' };
      const bundle = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return await projectSession.importRevisions(bundle);
    } catch (error) {
      const code = error instanceof SyntaxError ? 'revision-transfer-invalid' : error.code || 'metadata-unavailable';
      logger.warn('revision.import-failed', { code });
      return { error: code };
    }
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
