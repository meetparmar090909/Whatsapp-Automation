const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Add any API methods you need to expose to the renderer process
  // For this app, we don't need to expose specific methods since
  // it's primarily a web server wrapped in Electron
});