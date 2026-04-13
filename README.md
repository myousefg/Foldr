<div align="center">

# 📁 Foldr

### Set once. Forget forever.

Foldr is a native desktop application that **automatically monitors a folder and organizes your files** using rules you define — by file type, keyword, or naming pattern. No cloud. No AI. Just automation that runs silently in the background.

[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)](https://github.com)
[![Stack](https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20Python-informational?style=flat-square)](https://github.com)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

</div>

---

## ✨ Features

- 🔍 **Real-time folder monitoring** — detects new files the moment they appear
- ⚙️ **Rule engine** — match by file extension (`.pdf`, `.jpg`) or filename keyword (`invoice`, `receipt`)
- ✏️ **Auto-rename** — clean up messy names like `IMG_9283 (1).jpg` → `2026-04-09_photo.jpg`
- 👁️ **Preview before moving** — review every proposed move before it happens
- ↩️ **Undo** — restore any file to its original location in one click
- 🗂️ **Quick-start presets** — Student, Freelancer, Developer rule sets
- 🌙 **Dark / Light / System theme**
- 📴 **Fully offline** — no data leaves your machine, ever

---

## 📸 Screenshots

| Dashboard                                  | Rules                           | Activity Log           |
| ------------------------------------------ | ------------------------------- | ---------------------- |
| Monitor status, recent moves, folder stats | Create and manage sorting rules | Full history with undo |

> _Screenshots will be added after first production build._

---

## 🧰 Tech Stack

| Layer           | Technology                            |
| --------------- | ------------------------------------- |
| Desktop shell   | Electron 33                           |
| UI              | React 19 + shadcn/ui + Tailwind CSS   |
| Backend         | Python 3.10+ · FastAPI · SQLite       |
| Folder watcher  | `watchdog`                            |
| File operations | `shutil.move`                         |
| Packaging       | PyInstaller + electron-builder (NSIS) |

---

## 🚀 Getting Started

### Prerequisites

Make sure you have these installed before running Foldr:

| Tool    | Version | Download              |
| ------- | ------- | --------------------- |
| Node.js | 18+     | https://nodejs.org    |
| Python  | 3.10+   | https://python.org    |
| Yarn    | any     | `npm install -g yarn` |

### Installation

```bash
# 1. Clone or extract the project, then Run the dev setup script (installs all deps + launches the app)
scripts\dev.bat
```

That's it. The script handles `npm install`, `yarn install`, and `pip install` automatically, then opens the Electron window.

**Manual setup (optional):**

```bash
npm install
cd frontend && yarn install && cd ..
cd backend && pip install -r requirements.txt && cd ..
npm start
```

---

## 🏗️ Building the .exe

To produce a distributable Windows installer:

```bash
scripts\build-exe.bat
```

This runs three steps automatically:

```
1. PyInstaller  →  backend/dist/foldr-backend.exe
2. craco build  →  frontend/build/
3. electron-builder  →  dist/Foldr Setup 1.0.0.exe
```

The final NSIS installer creates a desktop shortcut and launches Foldr after install.

> **Tip:** Run this from a clean terminal after `scripts\dev.bat` has completed at least once.

---

## 📖 Usage

### 1. Select a folder to monitor

Go to **Dashboard → Monitored Folder → Change** and pick your Downloads folder (or any folder).

### 2. Create rules

Go to **Rules → New Rule** and define:

- **Condition:** match by extension (e.g. `.pdf`) or keyword (e.g. `invoice`)
- **Destination:** where the file should go (`Documents`, or an absolute path like `C:\Finance`)
- **Rename template:** how the file should be named after moving

Or apply a **Quick-start Preset** (Student / Freelancer / Developer) at the bottom of the Rules page.

### 3. Enable monitoring

Flip the **Monitoring** toggle on the Dashboard. Foldr now runs silently in the background.

### 4. Review moves (optional)

If **Preview before moving** is enabled in Settings, an amber banner appears on the Dashboard whenever files are detected. Click it to review and approve each move.

---

## 🔤 Rename Tokens

Use these tokens in your rename templates:

| Token                    | Example output  | Description                                               |
| ------------------------ | --------------- | --------------------------------------------------------- |
| `{date}`                 | `2026-04-09`    | Today's date                                              |
| `{originalname_cleaned}` | `invoice-draft` | Auto-cleaned filename (strips camera codes, copy markers) |
| `{originalname}`         | `invoice_draft` | Raw filename without extension                            |
| `{sequence}`             | `001`, `002`    | Auto-incrementing number per destination folder           |
| `{category}`             | `documents`     | Destination folder name, lowercased                       |

**Auto-clean** strips: `IMG_XXXX` / `DSC_XXXX` / `VID_XXXX` · ` (1)` ` (2)` · `- Copy` / `Copy of` · special characters.

**Example:**

```
Input:   IMG_9283 (1).jpg
Rule:    .jpg  →  Pictures,  template: {date}_{originalname_cleaned}
Output:  Pictures\2026-04-09_photo.jpg
```

---

## ⚙️ Configuration

All settings are available under **Settings** in the app:

| Setting                 | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| Monitored Folder        | The folder Foldr watches for new files                        |
| Base Output Folder      | Root for relative destination paths (default: home directory) |
| Preview before moving   | Queue files for review instead of moving immediately          |
| Monitoring enabled      | Pause/resume without losing rules                             |
| Auto-clean filenames    | Strip camera codes and copy markers automatically             |
| Default rename template | Fallback template when a rule has no template of its own      |
| Theme                   | Light / Dark / System                                         |

### Environment

No `.env` file is required. The backend always runs on `http://127.0.0.1:8765` and data is stored at:

- **Windows:** `%APPDATA%\.foldr\foldr.db`
- **macOS/Linux:** `~/.foldr/foldr.db`

---

## 🗂️ Project Structure

```
foldr-native/
├── electron/
│   ├── main.js           Window, tray, IPC, backend process management
│   └── preload.js        Exposes native APIs to React (folder picker, open-in-Explorer)
├── frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.js     Monitoring control, pending file review
│   │   │   ├── RulesManager.js  Rule CRUD, presets, live rename preview
│   │   │   ├── ActivityLog.js   Move history with undo
│   │   │   └── Settings.js      All configuration + theme
│   │   ├── components/
│   │   │   ├── Sidebar.js       Navigation
│   │   │   └── Layout.js        App shell
│   │   └── lib/api.js           HTTP client → http://127.0.0.1:8765
├── backend/
│   ├── server.py           FastAPI app (rules, settings, file watcher, moves)
│   ├── requirements.txt    Python dependencies
│   └── foldr_backend.spec  PyInstaller build spec
├── scripts/
│   ├── dev.bat             Install deps + launch dev mode
│   ├── build-exe.bat       Build production .exe installer
│   └── clean-and-zip.bat   Remove generated files and zip for sharing
└── package.json            Electron + electron-builder configuration
```

---

## 🐛 Troubleshooting

| Problem                       | Fix                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| Electron window is blank      | Wait ~10 s for React to compile on first run, then refresh (`Ctrl+R`)                     |
| `BROWSER=none` not recognized | Already fixed in `.env` — make sure you're using `scripts\dev.bat`                        |
| `react-hooks` ESLint error    | ESLint is disabled in `craco.config.js` — delete `frontend\node_modules\.cache` and retry |
| `foldr-backend.exe` not found | You're in prod mode without building first — run `scripts\build-exe.bat` step 1           |
| Files not being moved         | Check that the monitored folder exists and monitoring is toggled ON in Dashboard          |
| Multiple popups for one file  | Fixed in backend (dedup lock) — make sure you're on the latest `server.py`                |

---

## 📦 Sharing with Another Developer

```bash
scripts\clean-and-zip.bat
```

Removes all generated folders and creates a dated zip (e.g. `foldr-dist-2026-04-13.zip`) one level above the project. Typically **2–5 MB**. The receiving developer just runs `scripts\dev.bat`.

---

## 👥 Contributors

| Name      | Role        |
| --------- | ----------- |
| Your Team | Development |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">
  <sub>Built as a university startup project · Telkom University · 2026</sub>
</div>
