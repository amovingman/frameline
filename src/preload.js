const { contextBridge, ipcRenderer } = require('electron');

// Expose a deliberately small, safe API to the renderer as integrations are added.
contextBridge.exposeInMainWorld('desktop', {
  appName: 'Git for Video Editing',
  getAppState: () => ipcRenderer.invoke('app:get-state'),
  chooseProject: () => ipcRenderer.invoke('project:choose')
});
