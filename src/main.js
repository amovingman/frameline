const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createProjectSession } = require('./project-session');
const { createLocalMetadataStore } = require('./local-metadata');
const { fcpxmlProjectAdapter } = require('./project-adapter');
const logger = require('./logger');
const { createResolveReviewSession } = require('./resolve-review-session');

let projectSession;
let resolveReviewSession;
let resolveSourcePaths = null;
let resolveBusy = false;
const RESOLVE_SOURCE_LIMIT = 20 * 1024 * 1024;

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

async function runResolveAction(action) {
  if (resolveBusy) return { ...resolveReviewSession.getState(), error: { code: 'resolve-review-busy', message: 'A Resolve review action is already running.' } };
  resolveBusy = true;
  try { return await action(); }
  catch (error) {
    logger.warn('resolve.review-failed', { code: error.code || 'resolve-review-error' });
    return { ...resolveReviewSession.getState(), error: { code: error.code || 'resolve-review-error', message: 'Could not complete the Resolve review action.' } };
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
  projectSession = createProjectSession(fcpxmlProjectAdapter, createLocalMetadataStore(app.getPath('userData')));
  const resolveArtifactDirectory = path.join(app.getPath('userData'), 'resolve-previews');
  resolveReviewSession = createResolveReviewSession({ artifactDirectory: resolveArtifactDirectory });
  logger.info('app.ready', { version: app.getVersion() });
  ipcMain.handle('app:get-state', () => projectSession.getState());
  ipcMain.handle('resolve:get-review-state', () => resolveReviewSession.getState());
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
    if (state.status === 'ready') resolveSourcePaths = paths;
    return state;
  }));
  ipcMain.handle('resolve:refresh-preview', () => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    return resolveReviewSession.refresh(await readResolveSources(resolveSourcePaths));
  }));
  ipcMain.handle('resolve:save-preview', () => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    const refreshed = resolveReviewSession.refresh(await readResolveSources(resolveSourcePaths));
    if (refreshed.sourceVerification?.changed) return { ...refreshed, error: { code: 'resolve-source-changed', message: 'Snapshot files changed. Preview refreshed; inspect it before saving.' } };
    if (refreshed.status !== 'ready') return refreshed;
    await fs.mkdir(resolveArtifactDirectory, { recursive: true, mode: 0o700 });
    return resolveReviewSession.save();
  }));
  ipcMain.handle('resolve:save-review', () => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    const refreshed = resolveReviewSession.refresh(await readResolveSources(resolveSourcePaths));
    if (refreshed.sourceVerification?.changed) return { ...refreshed, error: { code: 'resolve-source-changed', message: 'Snapshot files changed. Previous choices cleared; review the new comparison before saving.' } };
    if (refreshed.status !== 'ready') return refreshed;
    await fs.mkdir(resolveArtifactDirectory, { recursive: true, mode: 0o700 });
    return resolveReviewSession.saveReview();
  }));
  ipcMain.handle('resolve:recover-preview', (_event, artifactId) => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    return resolveReviewSession.recover(artifactId, await readResolveSources(resolveSourcePaths));
  }));
  ipcMain.handle('resolve:recover-review', (_event, artifactId) => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    return resolveReviewSession.recoverReview(artifactId, await readResolveSources(resolveSourcePaths));
  }));
  ipcMain.handle('resolve:set-decision', (_event, conflictId, choice) => runResolveAction(
    () => resolveReviewSession.setDecision(conflictId, choice)));
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
    const state = await projectSession.rescan();
    if (state.scanStatus === 'ready') logger.info('project.rescan-complete', { clipCount: state.scan.clips.length, warningCount: state.scan.warnings.length });
    else if (state.scanStatus === 'error') logger.warn('project.rescan-failed', { code: state.error });
    return state;
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
