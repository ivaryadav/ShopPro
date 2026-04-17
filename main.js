const { app, BrowserWindow, shell, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

// ── Generate stable Machine ID from hardware info ─────────────
function getMachineId() {
  try {
    // Try to use node-machine-id if available
    const { machineIdSync } = require('node-machine-id');
    const raw = machineIdSync({ original: true });
    // Hash it and format as XXXX-XXXX-XXXX-XXXX
    const hash = crypto.createHash('sha256').update(raw + 'SHOPERPRO').digest('hex').toUpperCase();
    return `${hash.substring(0,4)}-${hash.substring(4,8)}-${hash.substring(8,12)}-${hash.substring(12,16)}`;
  } catch {
    // Fallback: generate from OS info
    const factors = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.cpus()[0]?.model || 'CPU',
      os.totalmem().toString(),
    ].join('|');
    const hash = crypto.createHash('sha256').update(factors + 'SHOPERPRO').digest('hex').toUpperCase();
    return `${hash.substring(0,4)}-${hash.substring(4,8)}-${hash.substring(8,12)}-${hash.substring(12,16)}`;
  }
}

const MACHINE_ID = getMachineId();

// ── Paths ─────────────────────────────────────────────────────
const userDataPath = app.getPath('userData');
const backupDir = path.join(app.getPath('documents'), 'ShopERP Backups');

// Ensure backup directory exists
if (!fs.existsSync(backupDir)) {
  try { fs.mkdirSync(backupDir, { recursive: true }); } catch {}
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'ShopERP Pro',
    backgroundColor: '#0a0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    autoHideMenuBar: true,
    show: false, // Don't show until ready
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Show window when ready (prevents flash)
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools();
  }

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ─────────────────────────────────────────────

// Get machine ID (sent to renderer for display and license validation)
ipcMain.handle('get-machine-id', () => MACHINE_ID);

// Open external URL
ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
});

// Save backup to Documents/ShopERP Backups/
ipcMain.handle('save-backup', async (event, jsonData) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `shoperpro_backup_${timestamp}.json`;
    const filepath = path.join(backupDir, filename);
    fs.writeFileSync(filepath, jsonData, 'utf8');
    return { success: true, path: filepath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}); 

// List available backups
ipcMain.handle('list-backups', async () => {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.json') && f.startsWith('shoperpro_backup_'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        date: fs.statSync(path.join(backupDir, f)).mtime,
      }))
      .sort((a, b) => b.date - a.date)
      .slice(0, 10); // Last 10 backups
    return { success: true, files };
  } catch (e) {
    return { success: false, files: [] };
  }
});

// Restore from backup file
ipcMain.handle('restore-backup', async (event, filepath) => {
  try {
    const data = fs.readFileSync(filepath, 'utf8');
    JSON.parse(data); // Validate JSON
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Show file open dialog
ipcMain.handle('show-open-dialog', async (event, options) => {
  return dialog.showOpenDialog(win, options);
});

// Show save dialog
ipcMain.handle('show-save-dialog', async (event, options) => {
  return dialog.showSaveDialog(win, options);
});

// Show system notification
ipcMain.handle('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

// Get app version
ipcMain.handle('get-version', () => app.getVersion());

// Get backup directory path
ipcMain.handle('get-backup-dir', () => backupDir);
