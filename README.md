# Foldr Native — Electron + React + Python (.exe)

> **Set once. Forget forever.**
> Automated local file organizer that monitors folders and sorts files using rule-based logic. Runs offline with no cloud or AI.

## Tech Stack

| Layer           | Tech                                                           |
| --------------- | -------------------------------------------------------------- |
| Desktop shell   | Electron 33                                                    |
| UI              | React 19 + shadcn/ui + Tailwind CSS                            |
| Backend         | Python 3.11 · FastAPI · SQLite                                 |
| Folder watcher  | `watchdog`                                                     |
| File operations | `shutil.move` (real moves + rename)                            |
| Packaging       | PyInstaller (backend .exe) + electron-builder (NSIS installer) |

---

## Quick Start — Dev Mode

```bat
scripts\dev.bat
```

Or manually:

```bat
npm install
cd frontend && yarn install && cd ..
cd backend && pip install -r requirements.txt && cd ..
npm start          ← launches React on :3000 + Electron
```

---

## Build → Windows .exe

```bat
scripts\build-exe.bat
```

Steps it runs:

1. **PyInstaller** bundles `backend/server.py` → `backend/dist/foldr-backend.exe`
2. **craco build** compiles React → `frontend/build/`
3. **electron-builder** packages everything → `dist/Foldr Setup 1.0.0.exe`

The NSIS installer puts `foldr-backend.exe` in `resources/backend/`, creates a
desktop shortcut, and launches Foldr after install.

---

## How It Works

```
User drops file into Downloads
        ↓
watchdog (Python) detects it
        ↓
Rule engine matches by extension or keyword
        ↓
   preview_before_apply ON?
   ├── YES → queued in SQLite → amber banner in Dashboard → user reviews
   └── NO  → shutil.move() immediately + renamed
        ↓
Activity log records original_path + new_path
        ↓
Undo button → shutil.move() back to original_path
```

---

## Project Structure

```
foldr-native/
├── electron/
│   ├── main.js        Spawn backend, create window+tray, IPC handlers
│   └── preload.js     Expose electronAPI to renderer (selectFolder, openFolder)
├── frontend/
│   ├── src/pages/
│   │   ├── Dashboard.js    Folder picker · live pending banner (polls /api/pending)
│   │   ├── RulesManager.js CRUD + native folder picker + live rename preview
│   │   ├── ActivityLog.js  Full log + real file Undo + open-in-Explorer
│   │   └── Settings.js     Monitored folder, base output, all toggles
│   └── src/lib/api.js      All calls → http://127.0.0.1:8765
├── backend/
│   ├── server.py           FastAPI + SQLite + watchdog + shutil.move
│   ├── requirements.txt    fastapi · uvicorn · watchdog · pyinstaller
│   └── foldr_backend.spec  PyInstaller spec (single-file, no console)
├── scripts/
│   ├── dev.bat             One-command dev setup
│   └── build-exe.bat       One-command build to installer
└── package.json            Electron shell + electron-builder config
```

---

## Rename Tokens

| Token                    | Output                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| `{date}`                 | `2026-04-09`                                                            |
| `{originalname_cleaned}` | Cleaned name — strips `IMG_XXXX`, ` (1)`, `- Copy`, lowercases, hyphens |
| `{originalname}`         | Raw name without extension                                              |
| `{sequence}`             | `001`, `002`, … per destination folder                                  |
| `{category}`             | Destination folder name, lowercased                                     |

**Auto-clean** removes: `IMG_` / `DSC_` / `VID_` camera codes · ` (1)` ` (2)` duplicate markers · `- Copy` / `Copy of` prefixes · special characters.

---

## Destination Folder Resolution

| What you type                    | Where files go                   |
| -------------------------------- | -------------------------------- |
| `Documents` (relative)           | `<Base Output Folder>\Documents` |
| `C:\Finance\Invoices` (absolute) | `C:\Finance\Invoices` exactly    |

Base Output Folder defaults to your home directory if not set in Settings.

---

## Data Location

All rules, settings, activity log → `%APPDATA%\.foldr\foldr.db`  
No data leaves your machine. No cloud. No telemetry.
