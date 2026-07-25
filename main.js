const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// Keep reference to prevent garbage collection
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'ShopERP Pro',
    icon: path.join(__dirname, 'icons', 'icon.png'),
    backgroundColor: '#0d1526',
    show: false, // Show after ready
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load the app
  mainWindow.loadFile('app/ShopERP_Pro_v8.html');

  // Show window when fully loaded (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in browser, not Electron. Only http/https are
  // handed to the OS browser; everything else is denied outright rather
  // than falling through to Electron's default "open a new, unrestricted
  // window" behavior — no legitimate app flow calls window.open() with
  // anything but an http(s) URL (checked: no other scheme appears at any
  // window.open call site in app/ShopERP_Pro_v8.html), so this narrows an
  // unused allowance rather than changing real behavior.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Restrict full-document navigation to the app's own local file — same
  // spirit as setWindowOpenHandler above but for in-place navigation
  // (location.href, a plain <a href> click), which setWindowOpenHandler
  // does not govern. Client-side page switching (showPage()-style DOM
  // updates) is not a real navigation and never reaches this handler.
  // pathToFileURL (not string concatenation) so this is correct on
  // Windows too — a raw 'file://' + a Windows path (backslashes, a drive
  // letter) does not produce a valid file:// URL.
  const appRoot = pathToFileURL(path.join(__dirname, 'app') + path.sep).href;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appRoot)) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Build application menu
function buildMenu() {
  const template = [
    {
      label: 'ShopERP Pro',
      submenu: [
        { label: 'About ShopERP Pro', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'ShopERP Pro',
            message: 'ShopERP Pro v8',
            detail: 'Professional ERP for Indian Mobile Phone Shops\n\nSales · Repairs · Inventory · Customers · CA Reports\n\nLicense: SADM-9999-PROX-0001',
            buttons: ['OK'],
            icon: path.join(__dirname, 'icons', 'icon.png')
          });
        }},
        { type: 'separator' },
        { label: 'Quit ShopERP Pro', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.reload() },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => mainWindow.webContents.setZoomLevel(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => {
          const z = mainWindow.webContents.getZoomLevel();
          mainWindow.webContents.setZoomLevel(Math.min(z + 0.5, 3));
        }},
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => {
          const z = mainWindow.webContents.getZoomLevel();
          mainWindow.webContents.setZoomLevel(Math.max(z - 0.5, -2));
        }},
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'F11', click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen()) },
      ]
    },
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', role: 'close' },
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
