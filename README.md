<div align="center">

# 📁 Foldr

### Set once. Forget forever.

Foldr is a native desktop application that **automatically monitors your folders and organizes files** using rules you define — by file type, keyword, size, or age. No cloud. No AI. Just automation that runs silently in the background.

[![Version](https://img.shields.io/badge/version-1.2.0-blue?style=flat-square)](https://github.com/myousefg/Foldr/releases/tag/v1.2.0)
[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)](https://github.com/myousefg/Foldr/releases)
[![Stack](https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20Python-informational?style=flat-square)](https://github.com/myousefg/Foldr)
[![License](https://img.shields.io/badge/license-Proprietary-red?style=flat-square)](LICENSE)

</div>

---

## ✨ Features

- 🔍 **Multi-folder monitoring** — watch Downloads, Desktop, and any other folder simultaneously
- ⚡ **Organize Now** — scan and organize existing files in one click, without waiting for new files
- ⚙️ **Rule engine with AND logic** — match by extension AND keyword, combined in a single rule
- 📏 **Size & age filters** — only organize files above a minimum size or within a certain age
- 🔁 **Duplicate detection** — SHA-256 content hash check before every move; skip, overwrite, or rename
- ✏️ **Auto-rename** — clean up messy names like `IMG_9283 (1).jpg` → `2026-04-09_photo.jpg`
- 👁️ **Preview before moving** — review every proposed move before it happens
- ↩️ **Undo** — restore any file to its original location in one click
- 🗂️ **Quick-start presets** — Student, Freelancer, Developer, Photographer, Designer, Writer
- 🌐 **Bilingual UI** — English and Bahasa Indonesia
- 🌙 **Dark / Light / System theme**
- 📴 **Fully offline** — no data leaves your machine, ever

---

## 📸 Screenshots

| Dashboard | Rules | Activity Log |
| --------- | ----- | ------------ |
| ![Dashboard](assets/screenshots/dashboard.png) | ![Rules](assets/screenshots/rules.png) | ![Activity](assets/screenshots/activity.png) |

---

## 🧰 Tech Stack

| Layer           | Technology                            |
| --------------- | ------------------------------------- |
| Desktop shell   | Electron 33                           |
| UI              | React 19 + shadcn/ui + Tailwind CSS   |
| Backend         | Python 3.10+ · FastAPI · SQLite       |
| Folder watcher  | `watchdog` (PollingObserver, 2s interval) |
| File operations | `shutil.move` + SHA-256 dedup         |
| Packaging       | PyInstaller + electron-builder (NSIS) |

---

## 🚀 Getting Started

### Prerequisites

| Tool    | Version | Download              |
| ------- | ------- | --------------------- |
| Node.js | 18+     | https://nodejs.org    |
| Python  | 3.10+   | https://python.org    |
| Yarn    | any     | `npm install -g yarn` |

### Installation

```bash
# Clone or extract the project, then:
scripts\dev.bat
```

The script installs all Node, frontend, and Python dependencies automatically, then opens the Electron window. No manual setup needed.

**Manual setup (optional):**

```bash
npm install
cd frontend && yarn install && cd ..
cd backend && pip install -r requirements.txt && cd ..
npm start
```

---

## 🏗️ Building the .exe

```bash
scripts\build-exe.bat
```

Runs four steps automatically:

```
1. PyInstaller     →  backend/dist/foldr-backend.exe
2. yarn install    →  frontend/node_modules/
3. craco build     →  frontend/build/
4. electron-builder  →  dist/Foldr-Setup-1.2.0.exe + dist/checksum.txt
```

> **Tip:** You can run this right after `scripts\clean.bat` — the script reinstalls frontend dependencies automatically.

---

## 📖 Usage

### 1. Add folders to monitor

Go to **Settings → Monitored Folders** and add one or more folders (e.g. Downloads, Desktop). All folders are watched simultaneously and share the same rules.

### 2. Create rules

Go to **Rules → New Rule** and define:

- **Conditions:** match by extension (e.g. `.pdf`) AND/OR keyword (e.g. `invoice`) — stack multiple conditions with AND logic
- **Size filter (optional):** only apply the rule to files above a minimum size (MB)
- **Age filter (optional):** only apply to files modified within the last N days
- **Destination:** where the file should go (`Documents`, or an absolute path like `C:\Finance`)
- **Rename template:** how the file should be named after moving

Or apply a **Quick-start Preset** at the bottom of the Rules page. Presets are dedup-safe — re-applying only adds missing rules.

### 3. Organize existing files

Click **Organize Now** on the Dashboard to scan all monitored folders immediately and apply rules to any files not yet organized. If Preview mode is on, files are queued for review first.

### 4. Enable monitoring

Flip the **Monitoring** toggle on the Dashboard. Foldr now runs silently in the background — any new file in a monitored folder is processed automatically.

### 5. Review moves (optional)

If **Preview before moving** is enabled in Settings, an amber banner appears on the Dashboard whenever files are detected. Click it to review, approve, or skip each move. Duplicate files show a warning with three choices: **Skip**, **Overwrite**, or **Rename (_001)**.

---

## 🔤 Rename Tokens

| Token                    | Example output  | Description                                                      |
| ------------------------ | --------------- | ---------------------------------------------------------------- |
| `{date}`                 | `2026-04-09`    | Today's date                                                     |
| `{originalname_cleaned}` | `invoice-draft` | Filename with camera codes, copy markers, and spacing cleaned up |
| `{originalname}`         | `invoice_draft` | Raw filename without extension — never modified                  |
| `{sequence}`             | `001`, `002`    | Auto-incrementing number per destination folder                  |
| `{category}`             | `documents`     | Destination folder name, lowercased                              |

**Token vs. Auto-clean setting behaviour:**

| Rule template                   | Auto-clean ON           | Auto-clean OFF                |
| ------------------------------- | ----------------------- | ----------------------------- |
| _(empty)_                       | Cleaned, no date prefix | Raw, no date prefix           |
| `{date}_{originalname_cleaned}` | Cleaned + date          | Cleaned + date _(token wins)_ |
| `{date}_{originalname}`         | Raw + date              | Raw + date                    |
| _(not set on rule)_             | Uses global default, cleaned | Uses global default, raw |

> `{originalname_cleaned}` **always cleans** when written explicitly in a template — the Auto-clean toggle only affects the fallback when the rename template is left empty.

**Auto-clean strips:** `IMG_XXXX` / `DSC_XXXX` / `VID_XXXX` · ` (1)` ` (2)` · `- Copy` / `Copy of` · leading date prefixes (`2026-06-07_`) · extra spaces and special characters.

---

## ⚙️ Configuration

All settings are available under **Settings** in the app:

| Setting                 | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| Monitored Folders       | All folders Foldr watches — add, remove, or pause individually          |
| Base Output Folder      | Root for relative destination paths (default: home directory)           |
| Preview before moving   | Queue files for review instead of moving immediately                    |
| Monitoring enabled      | Pause/resume all watching without losing your configuration             |
| Auto-clean filenames    | Strip camera codes and copy markers when no template is set             |
| Default rename template | Fallback template when a rule has no template of its own                |
| Theme                   | Light / Dark / System                                                   |
| Language                | English / Bahasa Indonesia                                              |

---

## 🔁 Duplicate Detection

Before every file move, Foldr computes a **SHA-256 content hash** and checks it against:

1. Files already in the destination folder (filesystem scan, size-filtered for performance)
2. Files already moved by Foldr (DB hash index — catches race conditions)
3. Files already queued in the pending review list

**Preview ON:** duplicate files show a ⚠️ warning card with three actions — Skip, Overwrite, or Rename (_001).

**Preview OFF (auto-mode):** duplicates are skipped automatically and logged in the Activity Log as `skipped — duplicate`. Filter by **Skipped duplicate** in the status dropdown to review them.

---

## 🗄️ Data & Reset

All app data is stored in a single SQLite file:

- **Windows:** `%APPDATA%\.foldr\foldr.db`

| What you want to reset | How |
| ---------------------- | --- |
| Dashboard counters (Files Today, Total Organized, This Week) | Delete `%APPDATA%\.foldr\foldr.db` — resets everything |
| Only the activity log | Go to **Activity Log → Clear** in the app |
| Only the file counters | Open `foldr.db` in [DB Browser for SQLite](https://sqlitebrowser.org) and run: `DELETE FROM organized_files;` |
| Everything (full wipe) | Delete `%APPDATA%\.foldr\foldr.db` — app recreates it fresh on next launch |

> ⚠️ Deleting the `.db` file also wipes your rules and settings. Export rules first via **Rules → Export** if needed.

---

## 🗂️ Project Structure

```
foldr/
├── electron/
│   ├── assets/               App icons (icon.ico, icon.png, icon.svg)
│   ├── main.js               Window, tray, IPC, single-instance lock, backend process
│   └── preload.js            Exposes native APIs to React (folder picker, open-in-Explorer)
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── Dashboard.js      Monitoring control, multi-folder widget, pending review
│       │   ├── RulesManager.js   Rule CRUD, AND conditions, size/age filters, presets
│       │   ├── ActivityLog.js    Move history with undo and status filters
│       │   └── Settings.js       All configuration, theme, language
│       ├── components/
│       │   ├── Sidebar.js        Navigation (translated)
│       │   └── Layout.js         App shell
│       ├── context/
│       │   ├── ThemeProvider.js  Dark/light/system theme
│       │   └── I18nProvider.js   Lightweight i18n (EN/ID, localStorage persistence)
│       ├── locales/
│       │   ├── en.json           English strings
│       │   └── id.json           Bahasa Indonesia strings
│       └── lib/api.js            HTTP client → http://127.0.0.1:8765
├── backend/
│   ├── server.py             FastAPI app (rules, multi-folder watcher, moves, dedup)
│   ├── requirements.txt      Python dependencies
│   └── foldr_backend.spec    PyInstaller build spec
├── scripts/
│   ├── dev.bat               Install deps + launch dev mode
│   ├── build-exe.bat         Build production .exe installer (v1.2.0)
│   └── clean.bat             Remove generated folders before sharing/zipping
└── package.json              Electron + electron-builder configuration (v1.2.0)
```

---

## 🔄 Updating Files in Dev Mode

| What you changed                          | Do you need to restart?                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| Any React file (`.js`, `.jsx`, CSS)       | ❌ No — hot reload is automatic                          |
| `backend/server.py`                       | ✅ Yes — close the terminal and re-run `scripts\dev.bat` |
| `electron/main.js` or `preload.js`        | ✅ Yes — close the terminal and re-run `scripts\dev.bat` |
| `frontend/package.json` (added a package) | ✅ Yes — run `cd frontend && yarn install`, then restart |

---

## 🐛 Troubleshooting

| Problem                        | Fix                                                             |
| ------------------------------ | --------------------------------------------------------------- |
| Electron window is blank       | Wait ~10 s for React to compile, then refresh (`Ctrl+R`)        |
| `react-hooks` ESLint error     | Delete `frontend\node_modules\.cache` and retry                 |
| `foldr-backend.exe` not found  | You're in prod mode — run `scripts\build-exe.bat` step 1 first  |
| Port 8765 already in use       | Another instance is running — Foldr auto-focuses it instead of opening a second window |
| Files not being moved          | Check monitored folders exist and Monitoring is ON in Dashboard |
| Duplicate not detected         | Files must be byte-identical (same content hash) — re-downloads may differ |
| Dashboard counters won't reset | Delete `%APPDATA%\.foldr\foldr.db` and relaunch                 |

---

## 📦 Sharing with Another Developer

```bash
scripts\clean.bat
```

Removes all generated folders (`node_modules`, `build`, `dist`, etc.). Then zip the folder manually and send it. Typically **2–5 MB**. The receiving developer runs `scripts\dev.bat` to get started.

---

## 📋 Changelog

### v1.2.0 — Sprint 2 Feature Update

- **New:** Multi-folder monitoring — add Desktop, Downloads, and any other folder simultaneously
- **New:** Organize Now button — scan and organize all existing files in monitored folders instantly
- **New:** Duplicate detection — SHA-256 content hash check before every move; auto-skip or choose Skip / Overwrite / Rename in preview
- **New:** AND logic for rules — stack multiple conditions (e.g. `.pdf` AND contains `telkom`)
- **New:** Size & age filters — only apply rules to files above a minimum size or within N days old
- **New:** Bahasa Indonesia — full UI translation, toggle in Settings, persists across restarts
- **New:** Final app icon — new Foldr logo applied to window, tray, and installer
- **Fix:** Single instance lock — clicking the `.exe` again focuses the existing window instead of opening a second
- **Fix:** CPU usage — PollingObserver at 2-second interval keeps Foldr below 1% at idle
- **Fix:** Files moved out of monitored folder no longer re-processed by the watcher
- **Fix:** Temp files (`~$`, `.crdownload`, `.part`) are now correctly ignored
- **Fix:** Date stacking — files already named `2026-06-07_name` are not prefixed with another date
- **Fix:** Preset and import dedup — rules with same condition but different destination folder are treated as distinct
- **Fix:** Remove Duplicates button now correctly compares condition + destination, not just condition

### v1.1.0 — Sprint 1 Stability Update

- Fixed: multiple files queued simultaneously now all move correctly
- Fixed: preview cards for deleted files auto-dismiss instead of persisting
- Fixed: auto-clean filenames toggle now works correctly (ON/OFF respected)
- Fixed: empty rename template no longer applies the global date prefix
- Fixed: undo no longer causes an infinite move loop when preview is active
- Fixed: undo restores files to their exact original absolute path
- Fixed: undo button disabled with tooltip when files are pending review
- Fixed: race condition — concurrent file moves can no longer overwrite each other
- Fixed: `GET /api/folders/{name}` endpoint missing (404 error in Dashboard)
- Fixed: dashboard polling requests no longer accumulate in the background
- Security: path traversal protection on all file operations and rule inputs
- Security: SQL injection protection via column allowlists and parameterized queries
- Build: SHA-256 checksum generated correctly alongside installer

### v1.0.0 — Initial Release

- Real-time folder monitoring, rule engine, auto-rename, preview, undo, presets

---

## 👥 Contributors

| Name                      | Role    |
| ------------------------- | ------- |
| Mohammed Yousef Gumilar   | Hacker  |
| Joshua Daniel Simanjuntak | Hustler |
| Muhammad Ghiyats Fatiha   | Hipster |

---

## 📄 License

This project is proprietary software. All rights reserved.

Unauthorized copying, distribution, or use of this software is strictly prohibited.
See [LICENSE](LICENSE) for details.

---

<div align="center">
  <sub>Built as a university startup project · Telkom University · 2026</sub>
</div>
