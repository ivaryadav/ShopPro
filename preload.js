const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Machine ID — for license validation
  getMachineId: () => ipcRenderer.invoke('get-machine-id'),

  // External links (WhatsApp, Google etc.)
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Backup — writes to Documents/ShopERP Backups/
  saveBackup: (jsonData) => ipcRenderer.invoke('save-backup', jsonData),
  listBackups: () => ipcRenderer.invoke('list-backups'),
  restoreBackup: (filepath) => ipcRenderer.invoke('restore-backup', filepath),

  // Dialogs
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  // System
  showNotification: (title, body) => ipcRenderer.invoke('show-notification', { title, body }),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getBackupDir: () => ipcRenderer.invoke('get-backup-dir'),
  platform: process.platform,
  isElectron: true,
});
