const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { createProjectSession } = require('./project-session');
const { createLocalMetadataStore } = require('./local-metadata');
const { scanFcpXml } = require('./fcpxml-adapter');
const logger = require('./logger');

let projectSession;
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
  projectSession = createProjectSession(scanFcpXml, createLocalMetadataStore(app.getPath('userData')));
  logger.info('app.ready', { version: app.getVersion() });
  ipcMain.handle('app:get-state', () => projectSession.getState());
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
