const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { createAppState, selectProject } = require('./project-state');
const { scanFcpXml } = require('./fcpxml-adapter');
const logger = require('./logger');

let appState = createAppState();
function getAppState() {
  return structuredClone(appState);
}

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

app.whenReady().then(() => {
  logger.info('app.ready', { version: app.getVersion() });
  ipcMain.handle('app:get-state', () => getAppState());
  ipcMain.handle('project:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a DaVinci Resolve timeline',
      properties: ['openFile', 'treatPackageAsDirectory'],
      filters: [{ name: 'DaVinci Resolve timeline exchange', extensions: ['fcpxml', 'fcpxmld'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      logger.info('project.selection-cancelled');
      return getAppState();
    }
    const selectedPath = result.filePaths[0];
    appState = selectProject(appState, selectedPath);
    if (appState.error) {
      logger.warn('project.selection-rejected', { filePath: selectedPath });
    } else {
      logger.info('project.selected', {
        format: appState.selectedProject.format,
        filePath: selectedPath
      });
      try {
        appState.scan = await scanFcpXml(selectedPath);
        appState.scanStatus = 'ready';
        logger.info('project.scan-complete', { clipCount: appState.scan.clips.length, warningCount: appState.scan.warnings.length });
      } catch (error) {
        appState.scanStatus = 'error';
        appState.error = error.code || 'scan-failed';
        logger.warn('project.scan-failed', { code: appState.error });
      }
    }
    return getAppState();
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
