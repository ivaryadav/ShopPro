// preload.js - runs in renderer context with access to node APIs
// Keep minimal for security
window.addEventListener('DOMContentLoaded', () => {
  // App version info
  const { ipcRenderer } = require('electron');
  // Expose minimal API to renderer
  window.isElectronApp = true;
  window.electronPlatform = process.platform;
});
