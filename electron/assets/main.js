const {
  app, BrowserWindow, Tray, Menu,
  ipcMain, dialog, shell, nativeImage,
  Notification
} = require('electron');
const { spawn } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');

// ── Single Instance Lock ───────────────────────────────────────────────────────
// If another instance is already running, focus it and exit immediately.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Called in the *first* instance when a second one tries to launch.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Remove native menu bar
app.on('ready', () => Menu.setApplicationMenu(null));

// ── Dev detection ─────────────────────────────────────────────────────────────
const BUILD_INDEX = path.join(__dirname, '..', 'frontend', 'build', 'index.html');
const DEV = !fs.existsSync(BUILD_INDEX);

const BACKEND_PORT = 8765;
const BACKEND_URL  = `http://127.0.0.1:${BACKEND_PORT}`;

console.log(`[foldr] mode=${DEV ? 'DEV' : 'PROD'}`);

let mainWindow  = null;
let tray        = null;
let backendProc = null;
let isQuitting  = false;
let monitoringEnabled = true; // mirrors backend state for tray menu label

// ── Tray icon ─────────────────────────────────────────────────────────────────
// Resolves to electron/assets/icon.ico (multi-res: 16/32/48/64/128/256)
const TRAY_ICON_PATH   = path.join(__dirname, 'assets', 'icon.ico');
const WINDOW_ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

function createTrayIcon() {
  return nativeImage.createFromPath(TRAY_ICON_PATH);
}

// ── Backend ───────────────────────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FOLDR_PORT: String(BACKEND_PORT) };

    if (DEV) {
      const script = path.join(__dirname, '..', 'backend', 'server.py');
      console.log('[foldr] Starting backend: python', script);
      backendProc = spawn('python', [script], { env, stdio: ['ignore','pipe','pipe'] });
    } else {
      const ext = process.platform === 'win32' ? '.exe' : '';
      const exe = path.join(process.resourcesPath, 'backend', `foldr-backend${ext}`);
      backendProc = spawn(exe, [], { env, stdio: ['ignore','pipe','pipe'] });
    }

    backendProc.stdout?.on('data', d => console.log('[py]', d.toString().trim()));
    backendProc.stderr?.on('data', d => console.warn('[py]', d.toString().trim()));
    backendProc.on('error', reject);

    const deadline = Date.now() + 20_000;
    const poll = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(poll);
        return reject(new Error('Backend startup timeout'));
      }
      http.get(`${BACKEND_URL}/api/`, res => {
        if (res.statusCode === 200) { clearInterval(poll); console.log('[foldr] Backend ready'); resolve(); }
      }).on('error', () => {});
    }, 500);
  });
}

function stopBackend() {
  if (backendProc) { backendProc.kill(); backendProc = null; }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160, height: 720,
    minWidth: 1160, minHeight: 720,
    title: 'Foldr',
    icon: WINDOW_ICON_PATH,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  const url = DEV ? 'http://localhost:3000' : `file://${BUILD_INDEX}`;
  mainWindow.loadURL(url);
  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('close', e => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Open Foldr',
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    { type: 'separator' },
    {
      label: monitoringEnabled ? 'Pause Monitoring' : 'Resume Monitoring',
      click: async () => {
        const postData = JSON.stringify({ monitoring_enabled: !monitoringEnabled });
        const req = http.request(
          { hostname: '127.0.0.1', port: BACKEND_PORT, path: '/api/settings',
            method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } },
          (res) => {
            if (res.statusCode === 200) {
              monitoringEnabled = !monitoringEnabled;
              tray.setContextMenu(buildTrayMenu());
              tray.setToolTip(monitoringEnabled ? 'Foldr — File Organizer' : 'Foldr — Monitoring paused');
            }
          }
        );
        req.on('error', e => console.warn('[foldr] Could not toggle monitoring from tray:', e.message));
        req.write(postData);
        req.end();
      },
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => { isQuitting = true; app.quit(); },
    },
  ]);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Foldr — File Organizer');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('select-folder', async (_, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: opts.title || 'Select Folder',
    defaultPath: opts.defaultPath || app.getPath('home'),
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('open-folder', async (_, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) { await shell.openPath(folderPath); return true; }
  return false;
});

ipcMain.handle('get-paths', async () => ({
  home:      app.getPath('home'),
  downloads: app.getPath('downloads'),
  documents: app.getPath('documents'),
  desktop:   app.getPath('desktop'),
}));

// Windows toast notification
ipcMain.handle('show-notification', (_, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
    n.show();
  }
});

// Tray badge — updates tooltip only (badge overlay is handled by the OS)
ipcMain.handle('set-tray-badge', (_, count) => {
  if (!tray) return;
  tray.setToolTip(
    count > 0
      ? `Foldr — ${count} file${count !== 1 ? 's' : ''} pending review`
      : monitoringEnabled ? 'Foldr — File Organizer' : 'Foldr — Monitoring paused'
  );
});

// Auto-start with Windows
ipcMain.handle('set-auto-start', (_, enable) => {
  app.setLoginItemSettings({
    openAtLogin: enable,
    openAsHidden: true,
  });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('get-auto-start', () => {
  return app.getLoginItemSettings().openAtLogin;
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();
  createTray();

  try {
    await startBackend();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(DEV ? 'http://localhost:3000' : `file://${BUILD_INDEX}`);
    }
  } catch (err) {
    console.error('[foldr] Backend failed:', err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => { /* stay in tray */ });
app.on('before-quit', () => { isQuitting = true; stopBackend(); });