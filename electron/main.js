const {
  app, BrowserWindow, Tray, Menu,
  ipcMain, dialog, shell, nativeImage
} = require('electron');
const { spawn } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');

// ── Dev detection ─────────────────────────────────────────────────────────────
// We're in dev if frontend/build/index.html does NOT exist yet
const BUILD_INDEX = path.join(__dirname, '..', 'frontend', 'build', 'index.html');
const DEV = !fs.existsSync(BUILD_INDEX);

const BACKEND_PORT = 8765;
const BACKEND_URL  = `http://127.0.0.1:${BACKEND_PORT}`;

console.log(`[foldr] mode=${DEV ? 'DEV' : 'PROD'}`);

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindow  = null;
let tray        = null;
let backendProc = null;
let isQuitting  = false;

// ── Backend ───────────────────────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FOLDR_PORT: String(BACKEND_PORT) };

    if (DEV) {
      // Dev: run server.py directly with Python
      const script = path.join(__dirname, '..', 'backend', 'server.py');
      console.log('[foldr] Starting backend:', 'python', script);
      backendProc = spawn('python', [script], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Prod: run the bundled exe
      const ext = process.platform === 'win32' ? '.exe' : '';
      const exe = path.join(process.resourcesPath, 'backend', `foldr-backend${ext}`);
      console.log('[foldr] Starting backend exe:', exe);
      backendProc = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    }

    backendProc.stdout?.on('data', d => console.log('[py]', d.toString().trim()));
    backendProc.stderr?.on('data', d => console.warn('[py]', d.toString().trim()));
    backendProc.on('error', err => {
      console.error('[py] spawn error:', err.message);
      reject(err);
    });

    // Poll until ready (max 20 s)
    const deadline = Date.now() + 20_000;
    const poll = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(poll);
        return reject(new Error('Backend startup timeout'));
      }
      http.get(`${BACKEND_URL}/api/`, res => {
        if (res.statusCode === 200) {
          clearInterval(poll);
          console.log('[foldr] Backend ready');
          resolve();
        }
      }).on('error', () => { /* not ready yet */ });
    }, 500);
  });
}

function stopBackend() {
  if (backendProc) { backendProc.kill(); backendProc = null; }
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1100,
    height:    700,
    minWidth:  840,
    minHeight: 540,
    title: 'Foldr',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  const url = DEV
    ? 'http://localhost:3000'
    : `file://${BUILD_INDEX}`;

  console.log('[foldr] Loading URL:', url);
  mainWindow.loadURL(url);

  // Open DevTools in dev mode
  if (DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', e => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────
function createTray() {
  const iconDataURL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA' +
    'BmJLR0QA/wD/AP+gvaeTAAAAVElEQVQ4jWNgGAWkAkZGxv9kaCAmzMDAwMDIyMhAth' +
    'kYGBgYGf9TYgMjIyMD2QYwMDAwkG0AIyMjA9kGMDIwMJBtACMDAwPZBjAyMDCQbcAo' +
    'IAMAEicCC5z4YI8AAAAASUVORK5CYII=';
  const icon = nativeImage.createFromDataURL(iconDataURL);
  tray = new Tray(icon);
  tray.setToolTip('Foldr');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Foldr', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit Foldr',  click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('select-folder', async (_, opts = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties:  ['openDirectory'],
    title:       opts.title || 'Select Folder',
    defaultPath: opts.defaultPath || app.getPath('home'),
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('open-folder', async (_, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) {
    await shell.openPath(folderPath);
    return true;
  }
  return false;
});

ipcMain.handle('get-paths', async () => ({
  home:      app.getPath('home'),
  downloads: app.getPath('downloads'),
  documents: app.getPath('documents'),
  desktop:   app.getPath('desktop'),
}));

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Create window immediately so user sees something
  createWindow();
  createTray();

  // Start backend in background
  try {
    await startBackend();
    // Reload once backend is ready (important for first launch)
    if (mainWindow && !mainWindow.isDestroyed()) {
      const url = DEV ? 'http://localhost:3000' : `file://${BUILD_INDEX}`;
      mainWindow.loadURL(url);
    }
  } catch (err) {
    console.error('[foldr] Backend failed:', err.message);
    // Window stays open showing blank/error — user can still see the shell
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  // Stay in tray — don't quit
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});
