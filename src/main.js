const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');

const supportedProjectExtensions = new Set(['.fcpxml', '.fcpxmld']);

function getProjectFormat(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!supportedProjectExtensions.has(extension)) return null;
  return extension === '.fcpxmld' ? 'FCPXML bundle' : 'FCPXML';
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
  ipcMain.handle('project:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a DaVinci Resolve timeline',
      properties: ['openFile', 'treatPackageAsDirectory'],
      filters: [{ name: 'DaVinci Resolve timeline exchange', extensions: ['fcpxml', 'fcpxmld'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selectedPath = result.filePaths[0];
    const format = getProjectFormat(selectedPath);
    if (!format) return { error: 'unsupported-format' };
    return { name: path.basename(selectedPath), format };
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
