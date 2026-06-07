"""
Foldr Native Backend
FastAPI + SQLite + watchdog (real folder monitoring + file moves)
"""
import os, re, shutil, sqlite3, logging, threading, traceback as _traceback, uuid, time, hashlib
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import List, Optional

import uvicorn
from fastapi import FastAPI, APIRouter, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from watchdog.events import FileSystemEventHandler
from watchdog.observers.polling import PollingObserver

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR = Path(os.environ.get("FOLDR_DATA", Path.home() / ".foldr"))
BASE_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH  = BASE_DIR / "foldr.db"

# ── Logging ───────────────────────────────────────────────────────────────────

LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

_LOG_FMT = "%(asctime)s %(levelname)-8s %(message)s"
_LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"

# General application logger — console only
logging.basicConfig(level=logging.INFO, format=_LOG_FMT, datefmt=_LOG_DATEFMT)
log = logging.getLogger("foldr")

# Database-specific logger — file + console
db_log = logging.getLogger("foldr.db")
db_log.setLevel(logging.DEBUG)
db_log.propagate = True   # also surfaces to console via root handler

_db_file_handler = RotatingFileHandler(
    filename=str(LOG_DIR / "database.log"),
    maxBytes=10 * 1024 * 1024,   # 10 MB
    backupCount=3,
    encoding="utf-8",
)
_db_file_handler.setFormatter(logging.Formatter(_LOG_FMT, datefmt=_LOG_DATEFMT))
db_log.addHandler(_db_file_handler)

# ── SQLite ────────────────────────────────────────────────────────────────────
_db_lock = threading.Lock()

def _conn():
    c = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c

def _fmt_query(sql: str, params) -> str:
    """Format a query + params for log output — keeps messages self-contained."""
    p_repr = repr(params) if params else "()"
    return f"SQL: {sql.strip()}  |  params: {p_repr}"

def db_one(sql, p=()):
    with _db_lock:
        c = _conn()
        try:
            r = c.execute(sql, p).fetchone()
            return dict(r) if r else None
        except sqlite3.Error as e:
            db_log.error(
                "db_one() failed — %s\n%s\n%s",
                e, _fmt_query(sql, p), _traceback.format_exc().rstrip(),
            )
            raise
        finally:
            c.close()

def db_all(sql, p=()):
    with _db_lock:
        c = _conn()
        try:
            return [dict(r) for r in c.execute(sql, p).fetchall()]
        except sqlite3.Error as e:
            db_log.error(
                "db_all() failed — %s\n%s\n%s",
                e, _fmt_query(sql, p), _traceback.format_exc().rstrip(),
            )
            raise
        finally:
            c.close()

def db_run(sql, p=()):
    with _db_lock:
        c = _conn()
        try:
            c.execute(sql, p)
            c.commit()
        except sqlite3.Error as e:
            db_log.error(
                "db_run() failed — %s\n%s\n%s",
                e, _fmt_query(sql, p), _traceback.format_exc().rstrip(),
            )
            raise
        finally:
            c.close()

# ── Schema ────────────────────────────────────────────────────────────────────
def init_db():
    with _db_lock:
        c = _conn()
        c.executescript("""
CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,
    monitoring_enabled INTEGER DEFAULT 1,
    default_rename_template TEXT DEFAULT '{date}_{originalname_cleaned}',
    auto_clean_names INTEGER DEFAULT 1,
    monitored_folder TEXT DEFAULT '',
    base_output_folder TEXT DEFAULT '',
    preview_before_apply INTEGER DEFAULT 1,
    auto_start INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    condition_type TEXT NOT NULL,
    condition_value TEXT NOT NULL,
    destination_folder TEXT NOT NULL,
    rename_template TEXT DEFAULT '',
    priority INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_conditions (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    condition_type TEXT NOT NULL,
    condition_value TEXT NOT NULL,
    FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS organized_files (
    id TEXT PRIMARY KEY,
    original_name TEXT, original_path TEXT,
    new_name TEXT, new_path TEXT,
    folder TEXT, file_type TEXT, organized_at TEXT, rule_id TEXT,
    content_hash TEXT
);
CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    original_name TEXT, original_path TEXT,
    new_name TEXT, new_path TEXT,
    destination_folder TEXT, rule_name TEXT, rule_id TEXT,
    timestamp TEXT, undone INTEGER DEFAULT 0,
    file_type TEXT, file_id TEXT,
    duplicate_action TEXT
);
CREATE TABLE IF NOT EXISTS pending_files (
    id TEXT PRIMARY KEY,
    original_path TEXT, proposed_path TEXT,
    proposed_name TEXT, destination_folder TEXT,
    rule_id TEXT, rule_name TEXT, detected_at TEXT,
    content_hash TEXT, duplicate_of TEXT
);
CREATE TABLE IF NOT EXISTS monitored_folders (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);
        """)
        c.commit()
        # ── Migrations: add new columns to existing tables if missing ──────────
        existing_cols = lambda tbl: {
            r[1] for r in c.execute(f"PRAGMA table_info({tbl})").fetchall()
        }
        if 'content_hash'     not in existing_cols('organized_files'):
            c.execute("ALTER TABLE organized_files ADD COLUMN content_hash TEXT")
        if 'duplicate_action' not in existing_cols('activity_log'):
            c.execute("ALTER TABLE activity_log ADD COLUMN duplicate_action TEXT")
        if 'content_hash'     not in existing_cols('pending_files'):
            c.execute("ALTER TABLE pending_files ADD COLUMN content_hash TEXT")
        if 'duplicate_of'     not in existing_cols('pending_files'):
            c.execute("ALTER TABLE pending_files ADD COLUMN duplicate_of TEXT")
        # ── Migrate existing single-condition rules into rule_conditions ───────
        existing_rc_tables = {r[0] for r in c.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='rule_conditions'"
        ).fetchall()}
        # Table is created above via executescript; seed it for existing rules
        # that don't yet have entries in rule_conditions.
        existing_rc_rule_ids = {r[0] for r in c.execute(
            "SELECT DISTINCT rule_id FROM rule_conditions"
        ).fetchall()} if existing_rc_tables else set()
        rules_to_migrate = c.execute(
            "SELECT id, condition_type, condition_value FROM rules"
        ).fetchall()
        for row in rules_to_migrate:
            rid = row[0]
            if rid not in existing_rc_rule_ids:
                cid = str(uuid.uuid4())
                c.execute(
                    "INSERT INTO rule_conditions (id, rule_id, condition_type, condition_value) VALUES (?,?,?,?)",
                    (cid, rid, row[1], row[2]),
                )
        c.commit()
        if not c.execute("SELECT id FROM settings WHERE id='default'").fetchone():
            c.execute("""INSERT INTO settings
                (id,monitoring_enabled,default_rename_template,auto_clean_names,
                 monitored_folder,base_output_folder,preview_before_apply,auto_start)
                VALUES ('default',1,'{date}_{originalname_cleaned}',1,'','',1,0)""")
            c.commit()
        c.close()

# ── Name helpers ──────────────────────────────────────────────────────────────
def clean_filename(name: str) -> str:
    name = re.sub(r'^\d{4}-\d{2}-\d{2}[-_]', '', name)   # strip leading date prefix (YYYY-MM-DD)
    name = re.sub(r'\s*\(\d+\)\s*', '', name)
    name = re.sub(r'^Copy\s+of\s+', '', name, flags=re.IGNORECASE)
    name = re.sub(r'^(IMG|DSC|DCIM|VID|MVI|MOV|PICT|SANY|SDC)[-_]?\d+[-_]?', '', name, flags=re.IGNORECASE)
    name = re.sub(r'^Screenshot[\s_]+\d{4}[-_]\d{2}[-_]\d{2}[\s_]+at[\s_]+', '', name)
    name = re.sub(r'\s*-\s*[Cc]opy\s*$', '', name)
    name = name.replace('_', ' ')
    name = re.sub(r'\s+', ' ', name).strip().lower().replace(' ', '-')
    name = re.sub(r'[^a-z0-9\-]', '', name).strip('-')
    return name or 'file'

def apply_template(template: str, filename: str, seq: int, category: str, auto_clean: bool = True) -> str:
    if not template:
        return filename
    parts = filename.rsplit('.', 1)
    name = parts[0]; ext = ('.' + parts[1]) if len(parts) > 1 else ''
    now = datetime.now()

    r = template
    r = r.replace("{date}", now.strftime("%Y-%m-%d"))
    r = r.replace("{YYYY-MM-DD}", now.strftime("%Y-%m-%d"))
    r = r.replace("{YYYY}", now.strftime("%Y"))
    r = r.replace("{MM}", now.strftime("%m"))
    r = r.replace("{DD}", now.strftime("%d"))
    r = r.replace("{originalname}", name)
    r = r.replace("{originalname_cleaned}", clean_filename(name))  # always clean
    r = r.replace("{cleaned_name}", clean_filename(name))          # always clean
    r = r.replace("{sequence}", str(seq).zfill(3))
    r = r.replace("{category}", category.lower().replace(' ', '-'))
    r = re.sub(r'[-_]{2,}', '_', r).strip('_-')
    return r + ext

def sha256_file(path: str) -> Optional[str]:
    """Return SHA-256 hex digest of a file, or None on error."""
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(65536), b''):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None

def find_duplicate_in_dest(src_path: str, dest_dir: str, src_hash: Optional[str] = None) -> Optional[str]:
    """Check if any file in dest_dir has identical content to src_path.
    Also checks organized_files DB for hash matches (catches race conditions).
    Returns the path of the duplicate, or None if no duplicate found."""
    if src_hash is None:
        src_hash = sha256_file(src_path)
    if not src_hash:
        return None

    # 1. Check organized_files DB first — catches files moved moments ago
    row = db_one(
        "SELECT new_path FROM organized_files WHERE content_hash=? LIMIT 1",
        (src_hash,)
    )
    if row and row.get("new_path") and os.path.isfile(row["new_path"]):
        return row["new_path"]

    # 1b. Check pending_files — catches duplicates queued but not yet applied
    pending_row = db_one(
        "SELECT original_path FROM pending_files WHERE content_hash=? LIMIT 1",
        (src_hash,)
    )
    if pending_row and pending_row.get("original_path") and os.path.isfile(pending_row["original_path"]):
        return pending_row["original_path"]

    # 2. Scan destination folder for size+hash match
    try:
        src_size = os.path.getsize(src_path)
        for entry in os.scandir(dest_dir):
            if not entry.is_file():
                continue
            if entry.stat().st_size != src_size:
                continue
            candidate_hash = sha256_file(entry.path)
            if candidate_hash and candidate_hash == src_hash:
                return entry.path
    except (OSError, PermissionError):
        pass
    return None

def unique_path(p: str) -> str:
    if not os.path.exists(p): return p
    base, ext = os.path.splitext(p)
    i = 1
    while os.path.exists(p):
        p = f"{base}_{i:03d}{ext}"; i += 1
    return p

def _safe_resolve(path: Path, base: Path) -> Path:
    """Resolve *path* and assert it does not escape *base* (prevents path traversal)."""
    resolved = path.resolve()
    try:
        resolved.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(400, "Path traversal detected — destination must be inside the allowed base directory.")
    return resolved

def resolve_dest(folder: str, settings: dict) -> str:
    """Return the absolute destination directory, rejecting traversal attempts."""
    p = Path(folder)
    if p.is_absolute():
        resolved = p.resolve()
        return str(resolved)
    base = Path(settings.get("base_output_folder") or str(Path.home()))
    return str(_safe_resolve(base / folder, base))

def _condition_matches(condition_type: str, condition_value: str, filename: str, ext: str) -> bool:
    cv = condition_value.lower()
    nl = filename.lower()
    if condition_type == "extension":
        if not cv.startswith('.'): cv = '.' + cv
        return ext == cv
    elif condition_type == "keyword":
        return cv in nl
    return False

def match_rule(filename: str) -> Optional[dict]:
    rules = db_all("SELECT * FROM rules WHERE enabled=1 ORDER BY priority")
    ext = ('.' + filename.rsplit('.', 1)[1].lower()) if '.' in filename else ''
    for rule in rules:
        conditions = db_all(
            "SELECT condition_type, condition_value FROM rule_conditions WHERE rule_id=?",
            (rule["id"],)
        )
        if not conditions:
            conditions = [{"condition_type": rule["condition_type"],
                           "condition_value": rule["condition_value"]}]
        if all(_condition_matches(c["condition_type"], c["condition_value"], filename, ext)
               for c in conditions):
            return rule
    return None

def next_seq(folder: str) -> int:
    r = db_one("SELECT COUNT(*) AS c FROM organized_files WHERE folder=?", (folder,))
    return (r["c"] if r else 0) + 1

# ── Move helper ───────────────────────────────────────────────────────────────
_MOVE_MAX_RETRIES = 3
_MOVE_RETRY_DELAY = 0.1  # seconds

def do_move(src, dst, orig_name, new_name, folder, rule_id, rule_name, content_hash=None):
    src_path = Path(src).resolve()
    if not src_path.is_file():
        log.warning(f"do_move: source does not exist or is not a file: {src}")
        return None

    dst_path = Path(dst).resolve()
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    final_dst = None
    last_err  = None

    for attempt in range(1, _MOVE_MAX_RETRIES + 1):
        try:
            with _move_lock:
                candidate = unique_path(str(dst_path))
                shutil.move(str(src_path), candidate)
                final_dst = candidate
            break   # success — exit retry loop
        except (OSError, shutil.Error) as e:
            last_err = e
            log.warning(f"do_move attempt {attempt}/{_MOVE_MAX_RETRIES} failed ({e}); "
                        f"{'retrying' if attempt < _MOVE_MAX_RETRIES else 'giving up'}")
            if attempt < _MOVE_MAX_RETRIES:
                time.sleep(_MOVE_RETRY_DELAY)

    if final_dst is None:
        log.error(f"Move failed after {_MOVE_MAX_RETRIES} attempts: {src} → {dst} | {last_err}")
        return None

    new_name = os.path.basename(final_dst)   # reflect any _001 suffix from unique_path
    ext = orig_name.rsplit('.', 1)[1].lower() if '.' in orig_name else 'unknown'
    fid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    abs_src = str(src_path)

    try:
        db_run("""INSERT INTO organized_files
            (id,original_name,original_path,new_name,new_path,folder,file_type,organized_at,rule_id,content_hash)
            VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (fid, orig_name, abs_src, new_name, final_dst, folder, ext, now, rule_id, content_hash))
        db_run("""INSERT INTO activity_log
            (id,original_name,original_path,new_name,new_path,destination_folder,
             rule_name,rule_id,timestamp,undone,file_type,file_id)
            VALUES (?,?,?,?,?,?,?,?,?,0,?,?)""",
            (str(uuid.uuid4()), orig_name, abs_src, new_name, final_dst, folder,
             rule_name, rule_id, now, ext, fid))
    except sqlite3.Error as db_err:
        # CRITICAL: the file was already moved on disk but the DB record failed.
        # Log with full detail so the operator can manually reconcile if needed.
        db_log.critical(
            "FILE MOVED BUT NOT RECORDED IN DB — manual reconciliation may be required.\n"
            "  original : %s\n"
            "  moved to : %s\n"
            "  rule     : %s (id=%s)\n"
            "  error    : %s\n%s",
            abs_src, final_dst, rule_name, rule_id,
            db_err, _traceback.format_exc().rstrip(),
        )

    log.info(f"Moved: {orig_name} -> {final_dst}")
    return final_dst

# ── Watchdog ──────────────────────────────────────────────────────────────────
# Prefixes/suffixes that are temp/lock files — never process these
_IGNORE_PREFIXES = ('~$', '.~', '._')
_IGNORE_SUFFIXES = ('.tmp', '.temp', '.crdownload', '.part', '.download')

def _is_temp_file(filename: str) -> bool:
    """Return True for files that should never be organized (temp/lock files)."""
    lname = filename.lower()
    return (
        any(filename.startswith(p) for p in _IGNORE_PREFIXES) or
        any(lname.endswith(s) for s in _IGNORE_SUFFIXES)
    )

class FoldrHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory:
            threading.Timer(0.8, self._handle, args=[event.src_path]).start()

    def on_moved(self, event):
        if event.is_directory:
            return
        dest = str(Path(event.dest_path).resolve())
        # Only process if dest is inside one of the monitored folders
        in_monitored = any(
            dest.startswith(str(Path(f).resolve()) + os.sep) or dest == str(Path(f).resolve())
            for f in _watched_folders
        )
        if not in_monitored:
            log.debug(f"on_moved: dest outside monitored folders, ignoring — {dest}")
            return
        threading.Timer(0.8, self._handle, args=[event.dest_path]).start()

    def _handle(self, path):
        if not os.path.isfile(path): return
        with _pending_lock:
            if path in _pending_paths:
                return
            _pending_paths.add(path)
        try:
            self._process(path)
        finally:
            threading.Timer(3.0, lambda: _pending_paths.discard(path)).start()

    def _process(self, path):
        if not os.path.isfile(path): return
        existing = db_one("SELECT id FROM pending_files WHERE original_path=?", (path,))
        if existing: return
        settings = db_one("SELECT * FROM settings WHERE id='default'") or {}
        if not settings.get("monitoring_enabled", 1): return
        filename = os.path.basename(path)
        if _is_temp_file(filename): return
        rule = match_rule(filename)
        if not rule: return
        dest_dir = resolve_dest(rule["destination_folder"], settings)
        seq = next_seq(rule["destination_folder"])
        auto_clean = bool(settings.get("auto_clean_names", 1))
        rule_tmpl = rule.get("rename_template")
        if rule_tmpl is None:
            tmpl = settings.get("default_rename_template", "{date}_{originalname_cleaned}")
            if not auto_clean:
                tmpl = tmpl.replace("{originalname_cleaned}", "{originalname}") \
                           .replace("{cleaned_name}", "{originalname}")
        elif rule_tmpl == "":
            tmpl = "{originalname_cleaned}" if auto_clean else "{originalname}"
        else:
            tmpl = rule_tmpl

        new_name = apply_template(tmpl, filename, seq, rule["destination_folder"], auto_clean=auto_clean)
        proposed = unique_path(os.path.join(dest_dir, new_name))

        # ── Duplicate detection ────────────────────────────────────────────────
        Path(dest_dir).mkdir(parents=True, exist_ok=True)
        src_hash = sha256_file(path)
        duplicate_of = find_duplicate_in_dest(path, dest_dir, src_hash)

        if settings.get("preview_before_apply", 1):
            db_run("""INSERT OR REPLACE INTO pending_files
                (id,original_path,proposed_path,proposed_name,destination_folder,
                 rule_id,rule_name,detected_at,content_hash,duplicate_of)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (str(uuid.uuid4()), path, proposed, new_name,
                 rule["destination_folder"], rule["id"], rule["name"],
                 datetime.now(timezone.utc).isoformat(),
                 src_hash, duplicate_of))
            log.info(f"Queued: {filename}" + (f" [DUPLICATE of {duplicate_of}]" if duplicate_of else ""))
        else:
            if duplicate_of:
                # Auto-mode: skip duplicate, log to activity_log as skipped
                ext = filename.rsplit('.', 1)[1].lower() if '.' in filename else 'unknown'
                now = datetime.now(timezone.utc).isoformat()
                db_run("""INSERT INTO activity_log
                    (id,original_name,original_path,new_name,new_path,destination_folder,
                     rule_name,rule_id,timestamp,undone,file_type,file_id,duplicate_action)
                    VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)""",
                    (str(uuid.uuid4()), filename, path,
                     os.path.basename(duplicate_of), duplicate_of,
                     rule["destination_folder"], rule["name"], rule["id"],
                     now, ext, None, 'skipped_duplicate'))
                log.info(f"Skipped duplicate: {filename} (identical to {duplicate_of})")
            else:
                do_move(path, proposed, filename, new_name,
                        rule["destination_folder"], rule["id"], rule["name"],
                        content_hash=src_hash)

_observer: Optional[PollingObserver] = None
_watched_folders: set = set()
_obs_lock = threading.Lock()
_pending_paths: set = set()
_pending_lock = threading.Lock()
_move_lock = threading.Lock()

# ── Stale-file reconciler ─────────────────────────────────────────────────────
# Strategy:
#   1. Group records by their parent directory.
#   2. os.path.isdir(parent) — one cheap call per folder.
#      If the whole folder is gone, every file in it is stale immediately.
#   3. For files whose parent still exists, check each file in parallel
#      (thread pool) so a slow filesystem never blocks for N×timeout.
# Worst-case latency: one isdir() timeout for the deleted folder (~0 s on
# local NTFS/ext4) + parallel isfile() for survivors.  In practice <0.1 s.
_reconciler_stop = threading.Event()

def _reconcile_once():
    rows = db_all("SELECT id, new_path FROM organized_files WHERE new_path IS NOT NULL AND new_path != ''")
    if not rows:
        return

    # Group by parent directory
    by_parent: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_parent[os.path.dirname(r["new_path"])].append(r)

    stale_ids: list[str] = []

    for parent, entries in by_parent.items():
        if not os.path.isdir(parent):
            # Whole folder gone — all entries are stale, no per-file I/O needed
            stale_ids.extend(e["id"] for e in entries)
        else:
            # Folder exists — check individual files in parallel
            def _check(entry):
                return entry["id"] if not os.path.isfile(entry["new_path"]) else None
            with _reconcile_executor() as ex:
                results = ex.map(_check, entries)
            stale_ids.extend(r for r in results if r is not None)

    if not stale_ids:
        return
    placeholders = ",".join("?" * len(stale_ids))
    db_run(f"DELETE FROM activity_log WHERE file_id IN ({placeholders})", tuple(stale_ids))
    db_run(f"DELETE FROM organized_files WHERE id IN ({placeholders})", tuple(stale_ids))
    log.info(f"Reconciler: removed {len(stale_ids)} stale file record(s)")

@contextmanager
def _reconcile_executor():
    """Short-lived thread pool for parallel isfile checks."""
    ex = ThreadPoolExecutor(max_workers=16, thread_name_prefix="reconcile")
    try:
        yield ex
    finally:
        ex.shutdown(wait=True)

def _reconcile_loop():
    """Background thread: purge DB records for files that no longer exist."""
    while not _reconciler_stop.wait(timeout=2):
        try:
            _reconcile_once()
        except Exception as e:
            log.warning(f"Reconciler error: {e}")

def start_reconciler():
    _reconciler_stop.clear()
    t = threading.Thread(target=_reconcile_loop, daemon=True, name="foldr-reconciler")
    t.start()

def stop_reconciler():
    _reconciler_stop.set()

def start_watcher(folders):
    """Accept a single folder path (str) or a list of folder paths.
    Schedules all valid folders on a single PollingObserver.
    No-ops if the active folder set hasn't changed."""
    global _observer, _watched_folders
    if isinstance(folders, str):
        folders = [folders]
    folders = [f for f in folders if f and os.path.isdir(f)]
    new_set = set(folders)

    with _obs_lock:
        # Skip full restart if the watched set is identical
        if new_set == _watched_folders and _observer and _observer.is_alive():
            return
        if _observer:
            _observer.stop(); _observer.join()
        _observer = None
        _watched_folders = set()
        if not folders:
            return
        _observer = PollingObserver(timeout=2)
        handler = FoldrHandler()
        for folder in folders:
            _observer.schedule(handler, folder, recursive=False)
            log.info(f"Watching: {folder}")
        _observer.start()
        _watched_folders = new_set

def stop_watcher():
    global _observer, _watched_folders
    with _obs_lock:
        if _observer:
            _observer.stop(); _observer.join(); _observer = None
        _watched_folders = set()

# ── App lifespan ──────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    s = db_one("SELECT * FROM settings WHERE id='default'") or {}
    if s.get("monitoring_enabled"):
        # Collect all enabled monitored folders
        rows = db_all("SELECT path FROM monitored_folders WHERE enabled=1")
        folders = [r["path"] for r in rows]
        # Fallback: legacy single monitored_folder from settings
        if not folders and s.get("monitored_folder"):
            folders = [s["monitored_folder"]]
        if folders:
            start_watcher(folders)
    start_reconciler()
    yield
    stop_watcher()
    stop_reconciler()

app = FastAPI(lifespan=lifespan)
api = APIRouter(prefix="/api")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Settings endpoints ────────────────────────────────────────────────────────
class SettingsUpdate(BaseModel):
    monitoring_enabled: Optional[bool] = None
    default_rename_template: Optional[str] = None
    auto_clean_names: Optional[bool] = None
    monitored_folder: Optional[str] = None
    base_output_folder: Optional[str] = None
    preview_before_apply: Optional[bool] = None
    auto_start: Optional[bool] = None

@api.get("/settings")
def get_settings():
    return db_one("SELECT * FROM settings WHERE id='default'") or {}

_SETTINGS_COLUMNS = frozenset({
    "monitoring_enabled", "default_rename_template", "auto_clean_names",
    "monitored_folder", "base_output_folder", "preview_before_apply", "auto_start",
})

@api.put("/settings")
def update_settings(data: SettingsUpdate):
    fields = {k: (1 if v is True else (0 if v is False else v))
              for k, v in data.model_dump().items() if v is not None}
    if not fields: raise HTTPException(400, "Nothing to update")
    if invalid := set(fields) - _SETTINGS_COLUMNS:
        raise HTTPException(400, f"Unknown settings fields: {invalid}")
    for folder_key in ("monitored_folder", "base_output_folder"):
        if folder_key in fields and fields[folder_key]:
            p = Path(str(fields[folder_key]))
            if ".." in p.parts:
                raise HTTPException(400, f"{folder_key} must not contain '..'.")
    sets = ", ".join(f"{k}=?" for k in fields)
    db_run(f"UPDATE settings SET {sets} WHERE id='default'", list(fields.values()))
    if "monitored_folder" in fields or "monitoring_enabled" in fields:
        s = db_one("SELECT * FROM settings WHERE id='default'") or {}
        if s.get("monitoring_enabled"):
            rows = db_all("SELECT path FROM monitored_folders WHERE enabled=1")
            folders = [r["path"] for r in rows]
            if not folders and s.get("monitored_folder"):
                folders = [s["monitored_folder"]]
            if folders:
                start_watcher(folders)
            else:
                stop_watcher()
        else:
            stop_watcher()
    return db_one("SELECT * FROM settings WHERE id='default'")

# ── Monitored Folders ─────────────────────────────────────────────────────────
class MonitoredFolderCreate(BaseModel):
    path: str
    enabled: bool = True

class MonitoredFolderUpdate(BaseModel):
    enabled: Optional[bool] = None

def _restart_watcher_from_db():
    """Restart the watcher using all enabled monitored_folders in the DB."""
    s = db_one("SELECT * FROM settings WHERE id='default'") or {}
    if not s.get("monitoring_enabled"):
        stop_watcher()
        return
    rows = db_all("SELECT path FROM monitored_folders WHERE enabled=1")
    folders = [r["path"] for r in rows]
    if folders:
        start_watcher(folders)
    else:
        stop_watcher()

@api.get("/monitored-folders")
def get_monitored_folders():
    return db_all("SELECT * FROM monitored_folders ORDER BY created_at ASC")

@api.post("/monitored-folders")
def add_monitored_folder(data: MonitoredFolderCreate):
    p = Path(data.path)
    if ".." in p.parts:
        raise HTTPException(400, "Path must not contain '..'.")
    if not p.is_absolute():
        raise HTTPException(400, "Path must be absolute.")
    if not p.is_dir():
        raise HTTPException(400, "Path does not exist or is not a directory.")
    existing = db_one("SELECT id FROM monitored_folders WHERE path=?", (str(p),))
    if existing:
        raise HTTPException(409, "Folder is already being monitored.")
    fid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    db_run("INSERT INTO monitored_folders (id, path, enabled, created_at) VALUES (?,?,?,?)",
           (fid, str(p), 1 if data.enabled else 0, now))
    _restart_watcher_from_db()
    return db_one("SELECT * FROM monitored_folders WHERE id=?", (fid,))

@api.patch("/monitored-folders/{folder_id}")
def update_monitored_folder(folder_id: str, data: MonitoredFolderUpdate):
    row = db_one("SELECT * FROM monitored_folders WHERE id=?", (folder_id,))
    if not row:
        raise HTTPException(404, "Monitored folder not found.")
    if data.enabled is not None:
        db_run("UPDATE monitored_folders SET enabled=? WHERE id=?",
               (1 if data.enabled else 0, folder_id))
    _restart_watcher_from_db()
    return db_one("SELECT * FROM monitored_folders WHERE id=?", (folder_id,))

@api.delete("/monitored-folders/{folder_id}")
def delete_monitored_folder(folder_id: str):
    row = db_one("SELECT * FROM monitored_folders WHERE id=?", (folder_id,))
    if not row:
        raise HTTPException(404, "Monitored folder not found.")
    db_run("DELETE FROM monitored_folders WHERE id=?", (folder_id,))
    _restart_watcher_from_db()
    return {"message": "removed"}

# ── Rules ─────────────────────────────────────────────────────────────────────
class ConditionItem(BaseModel):
    condition_type: str
    condition_value: str

class RuleCreate(BaseModel):
    name: str
    destination_folder: str
    rename_template: str = ""
    enabled: bool = True
    # Legacy single-condition fields (kept for backwards-compat with old clients)
    condition_type: str = "extension"
    condition_value: str = ""
    # New multi-condition list — takes precedence when provided
    conditions: Optional[List[ConditionItem]] = None

class RuleUpdate(BaseModel):
    name: Optional[str] = None
    destination_folder: Optional[str] = None
    rename_template: Optional[str] = None
    enabled: Optional[bool] = None
    condition_type: Optional[str] = None
    condition_value: Optional[str] = None
    conditions: Optional[List[ConditionItem]] = None

class RuleReorder(BaseModel):
    rule_ids: List[str]

_VALID_CONDITION_TYPES = frozenset({"extension", "keyword"})

def _validate_rule_fields(
    name: Optional[str] = None,
    condition_type: Optional[str] = None,
    destination_folder: Optional[str] = None,
    conditions: Optional[list] = None,
):
    """Raise HTTPException for any field that fails basic input sanitisation."""
    if name is not None and (not name.strip() or len(name) > 128):
        raise HTTPException(400, "Rule name must be 1–128 non-blank characters.")
    if condition_type is not None and condition_type not in _VALID_CONDITION_TYPES:
        raise HTTPException(400, f"condition_type must be one of: {sorted(_VALID_CONDITION_TYPES)}")
    if conditions is not None:
        if not conditions:
            raise HTTPException(400, "conditions list must not be empty.")
        for c in conditions:
            ct = c.condition_type if hasattr(c, "condition_type") else c.get("condition_type", "")
            if ct not in _VALID_CONDITION_TYPES:
                raise HTTPException(400, f"condition_type must be one of: {sorted(_VALID_CONDITION_TYPES)}")
    if destination_folder is not None:
        norm = Path(destination_folder).as_posix()
        if ".." in norm.split("/"):
            raise HTTPException(400, "destination_folder must not contain '..' path components.")
        if not destination_folder.strip():
            raise HTTPException(400, "destination_folder must not be empty.")

RULE_TEMPLATES = {
    "student": [
        {"name":"PDFs → Assignments",   "condition_type":"extension","condition_value":".pdf",  "destination_folder":"Assignments",   "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Word Docs → Notes",     "condition_type":"extension","condition_value":".docx", "destination_folder":"Notes",         "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Presentations",         "condition_type":"extension","condition_value":".pptx", "destination_folder":"Presentations", "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Spreadsheets",          "condition_type":"extension","condition_value":".xlsx", "destination_folder":"Spreadsheets",  "rename_template":"{date}_{originalname_cleaned}"},
    ],
    "freelancer": [
        {"name":"Invoices",              "condition_type":"keyword",  "condition_value":"invoice",  "destination_folder":"Invoices",  "rename_template":"{date}_{originalname_cleaned}_{sequence}"},
        {"name":"Contracts",             "condition_type":"keyword",  "condition_value":"contract", "destination_folder":"Contracts", "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Proposals",             "condition_type":"keyword",  "condition_value":"proposal", "destination_folder":"Proposals", "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"PDFs → Documents",      "condition_type":"extension","condition_value":".pdf",     "destination_folder":"Documents", "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Images → Assets",       "condition_type":"extension","condition_value":".jpg",     "destination_folder":"Assets",   "rename_template":"{category}_{sequence}"},
    ],
    "developer": [
        {"name":"Python Files",          "condition_type":"extension","condition_value":".py",   "destination_folder":"Code",          "rename_template":"{originalname}"},
        {"name":"JavaScript",            "condition_type":"extension","condition_value":".js",   "destination_folder":"Code",          "rename_template":"{originalname}"},
        {"name":"TypeScript",            "condition_type":"extension","condition_value":".ts",   "destination_folder":"Code",          "rename_template":"{originalname}"},
        {"name":"JSON Config",           "condition_type":"extension","condition_value":".json", "destination_folder":"Config",        "rename_template":"{originalname}"},
        {"name":"Markdown",              "condition_type":"extension","condition_value":".md",   "destination_folder":"Documentation", "rename_template":"{originalname}"},
        {"name":"Archives",              "condition_type":"extension","condition_value":".zip",  "destination_folder":"Archives",      "rename_template":"{date}_{originalname_cleaned}"},
    ],
    "photographer": [
        {"name":"JPEG Photos",           "condition_type":"extension","condition_value":".jpg",  "destination_folder":"Photos",   "rename_template":"{date}_{sequence}"},
        {"name":"JPEG Photos (uppercase)","condition_type":"extension","condition_value":".jpeg", "destination_folder":"Photos",   "rename_template":"{date}_{sequence}"},
        {"name":"PNG Images",            "condition_type":"extension","condition_value":".png",  "destination_folder":"Photos",   "rename_template":"{date}_{sequence}"},
        {"name":"HEIC Photos",           "condition_type":"extension","condition_value":".heic", "destination_folder":"Photos",   "rename_template":"{date}_{sequence}"},
        {"name":"RAW Photos",            "condition_type":"extension","condition_value":".raw",  "destination_folder":"RAW",      "rename_template":"{date}_{sequence}"},
        {"name":"Video Files",           "condition_type":"extension","condition_value":".mp4",  "destination_folder":"Videos",   "rename_template":"{date}_{sequence}"},
        {"name":"Lightroom Edits",       "condition_type":"extension","condition_value":".xmp",  "destination_folder":"Edits",    "rename_template":"{date}_{originalname}"},
    ],
    "designer": [
        {"name":"Figma Files",           "condition_type":"extension","condition_value":".fig",  "destination_folder":"Figma",     "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Adobe XD",              "condition_type":"extension","condition_value":".xd",   "destination_folder":"XD",        "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Photoshop Files",       "condition_type":"extension","condition_value":".psd",  "destination_folder":"Photoshop", "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Illustrator Files",     "condition_type":"extension","condition_value":".ai",   "destination_folder":"Illustrator","rename_template":"{date}_{originalname_cleaned}"},
        {"name":"SVG Icons",             "condition_type":"extension","condition_value":".svg",  "destination_folder":"Icons",     "rename_template":"{originalname_cleaned}"},
        {"name":"Fonts",                 "condition_type":"extension","condition_value":".ttf",  "destination_folder":"Fonts",     "rename_template":"{originalname}"},
        {"name":"Exported PNGs",         "condition_type":"keyword",  "condition_value":"export","destination_folder":"Exports",   "rename_template":"{date}_{originalname_cleaned}"},
    ],
    "writer": [
        {"name":"Word Documents",        "condition_type":"extension","condition_value":".docx", "destination_folder":"Drafts",    "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"PDFs",                  "condition_type":"extension","condition_value":".pdf",  "destination_folder":"Published", "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Text Files",            "condition_type":"extension","condition_value":".txt",  "destination_folder":"Notes",     "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Markdown Notes",        "condition_type":"extension","condition_value":".md",   "destination_folder":"Notes",     "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Draft keyword",         "condition_type":"keyword",  "condition_value":"draft", "destination_folder":"Drafts",    "rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Final keyword",         "condition_type":"keyword",  "condition_value":"final", "destination_folder":"Final",     "rename_template":"{date}_{originalname_cleaned}"},
    ],
}

def _cv_key(ctype: str, cval: str) -> tuple:
    return (ctype.lower(), cval.lower().strip().lstrip("."))


_preset_lock = threading.Lock()

@api.get("/rules/templates")
def get_templates(): return RULE_TEMPLATES

@api.post("/rules/templates/{ttype}")
def apply_template_route(ttype: str):
    if ttype not in RULE_TEMPLATES:
        raise HTTPException(404, "Template not found")
    if not _preset_lock.acquire(blocking=False):
        raise HTTPException(409, "Already applying a preset — please wait.")
    try:
        existing_rules = db_all("SELECT condition_type, condition_value FROM rules")
        existing_keys = {_cv_key(r["condition_type"], r["condition_value"]) for r in existing_rules}
        count = db_one("SELECT COUNT(*) AS c FROM rules")["c"]
        added_rules, skipped_vals = [], []
        for i, rd in enumerate(RULE_TEMPLATES[ttype]):
            key = _cv_key(rd["condition_type"], rd["condition_value"])
            if key in existing_keys:
                skipped_vals.append(rd["condition_value"])
                continue
            rid = str(uuid.uuid4())
            now = datetime.now(timezone.utc).isoformat()
            cv  = rd["condition_value"].lower().strip()
            db_run("""INSERT INTO rules (id,name,condition_type,condition_value,destination_folder,
                       rename_template,priority,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
                   (rid, rd["name"], rd["condition_type"], cv,
                    rd["destination_folder"], rd["rename_template"], count + i, 1, now))
            existing_keys.add(key)  # update snapshot so same-call duplicates are caught too
            row = db_one("SELECT * FROM rules WHERE id=?", (rid,))
            if row: added_rules.append(row)
        return {"added": len(added_rules), "skipped": len(skipped_vals), "rules": added_rules}
    finally:
        _preset_lock.release()

@api.delete("/rules/duplicates")
def remove_duplicate_rules():
    """Remove duplicate rules (same condition_type + condition_value). Keeps the first."""
    all_rules = db_all("SELECT * FROM rules ORDER BY priority")
    seen: set = set()
    deleted = 0
    for rule in all_rules:
        key = _cv_key(rule["condition_type"], rule["condition_value"])
        if key in seen:
            db_run("DELETE FROM rules WHERE id=?", (rule["id"],))
            deleted += 1
        else:
            seen.add(key)
    return {"deleted": deleted}

@api.get("/rules/export")
def export_rules():
    return db_all("SELECT * FROM rules ORDER BY priority")

class ImportRulesData(BaseModel):
    rules: List[dict]
    replace: bool = False

@api.post("/rules/import")
def import_rules(data: ImportRulesData):
    if data.replace:
        db_run("DELETE FROM rules")
    existing_rules = db_all("SELECT condition_type, condition_value FROM rules")
    existing_keys = {_cv_key(r["condition_type"], r["condition_value"]) for r in existing_rules}
    count = db_one("SELECT COUNT(*) AS c FROM rules")["c"]
    added, skipped = 0, 0
    for i, rule in enumerate(data.rules):
        key = _cv_key(rule.get("condition_type",""), rule.get("condition_value",""))
        if not data.replace and key in existing_keys:
            skipped += 1
            continue
        rid = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        db_run("""INSERT INTO rules (id,name,condition_type,condition_value,destination_folder,
                   rename_template,priority,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
               (rid, rule.get("name","Imported Rule"), rule.get("condition_type","extension"),
                rule.get("condition_value","").lower().strip(),
                rule.get("destination_folder",""), rule.get("rename_template","{date}_{originalname_cleaned}"),
                count + i, 1 if rule.get("enabled", True) else 0, now))
        existing_keys.add(key)
        added += 1
    return {"added": added, "skipped": skipped}

def _enrich_rule_with_conditions(rule: dict) -> dict:
    """Attach a 'conditions' list to a rule dict fetched from DB."""
    conds = db_all(
        "SELECT condition_type, condition_value FROM rule_conditions WHERE rule_id=? ORDER BY rowid",
        (rule["id"],)
    )
    if not conds:
        conds = [{"condition_type": rule["condition_type"], "condition_value": rule["condition_value"]}]
    rule["conditions"] = conds
    return rule

@api.get("/rules")
def get_rules():
    rules = db_all("SELECT * FROM rules ORDER BY priority")
    return [_enrich_rule_with_conditions(r) for r in rules]
def _sync_rule_conditions(rule_id: str, conditions: list):
    """Replace all rule_conditions rows for a rule with the given list."""
    db_run("DELETE FROM rule_conditions WHERE rule_id=?", (rule_id,))
    for c in conditions:
        ct = c.condition_type if hasattr(c, "condition_type") else c["condition_type"]
        cv = c.condition_value if hasattr(c, "condition_value") else c["condition_value"]
        db_run(
            "INSERT INTO rule_conditions (id, rule_id, condition_type, condition_value) VALUES (?,?,?,?)",
            (str(uuid.uuid4()), rule_id, ct, cv.lower().strip()),
        )

@api.post("/rules")
def create_rule(rule: RuleCreate):
    conditions = rule.conditions if rule.conditions else [
        ConditionItem(condition_type=rule.condition_type, condition_value=rule.condition_value)
    ]
    _validate_rule_fields(rule.name, destination_folder=rule.destination_folder, conditions=conditions)
    # Use primary condition for legacy columns (keeps backward compat / existing queries working)
    primary = conditions[0]
    count = db_one("SELECT COUNT(*) AS c FROM rules")["c"]
    did = str(uuid.uuid4()); now = datetime.now(timezone.utc).isoformat()
    db_run("""INSERT INTO rules (id,name,condition_type,condition_value,destination_folder,
               rename_template,priority,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
           (did, rule.name, primary.condition_type, primary.condition_value.lower().strip(),
            rule.destination_folder, rule.rename_template, count, 1 if rule.enabled else 0, now))
    _sync_rule_conditions(did, conditions)
    r = db_one("SELECT * FROM rules WHERE id=?", (did,))
    return _enrich_rule_with_conditions(r)

@api.put("/rules/reorder")
def reorder_rules(data: RuleReorder):
    for i, rid in enumerate(data.rule_ids):
        db_run("UPDATE rules SET priority=? WHERE id=?", (i, rid))
    return {"message": "reordered"}

_RULE_COLUMNS = frozenset({
    "name", "condition_type", "condition_value", "destination_folder",
    "rename_template", "enabled",
})

@api.put("/rules/{rule_id}")
def update_rule(rule_id: str, rule: RuleUpdate):
    _validate_rule_fields(rule.name, rule.condition_type, rule.destination_folder, rule.conditions)
    # Build conditions list: prefer explicit conditions; fall back to legacy single-condition fields
    new_conditions = rule.conditions
    if new_conditions is None and (rule.condition_type or rule.condition_value):
        existing = db_one("SELECT condition_type, condition_value FROM rules WHERE id=?", (rule_id,))
        ct = rule.condition_type or (existing["condition_type"] if existing else "extension")
        cv = rule.condition_value or (existing["condition_value"] if existing else "")
        new_conditions = [ConditionItem(condition_type=ct, condition_value=cv)]
    # Update the rule_conditions table if new conditions were provided
    if new_conditions is not None:
        _sync_rule_conditions(rule_id, new_conditions)
        # Also keep legacy columns in sync with primary condition
        primary = new_conditions[0]
        rule_dump = rule.model_dump(exclude={"conditions"})
        rule_dump["condition_type"] = primary.condition_type
        rule_dump["condition_value"] = primary.condition_value.lower().strip()
    else:
        rule_dump = rule.model_dump(exclude={"conditions"})
    fields = {k: (1 if v is True else (0 if v is False else v))
              for k, v in rule_dump.items() if v is not None}
    if fields:
        allowed = _RULE_COLUMNS
        if invalid := set(fields) - allowed:
            raise HTTPException(400, f"Unknown rule fields: {invalid}")
        sets = ", ".join(f"{k}=?" for k in fields)
        db_run(f"UPDATE rules SET {sets} WHERE id=?", [*fields.values(), rule_id])
    r = db_one("SELECT * FROM rules WHERE id=?", (rule_id,))
    if not r: raise HTTPException(404, "Not found")
    return _enrich_rule_with_conditions(r)

@api.delete("/rules/{rule_id}")
def delete_rule(rule_id: str):
    db_run("DELETE FROM rules WHERE id=?", (rule_id,)); return {"message": "deleted"}

# ── Pending ───────────────────────────────────────────────────────────────────
class PendingAction(BaseModel):
    id: str
    duplicate_action: Optional[str] = None  # 'skip' | 'overwrite' | 'rename' | None

class ApplyPending(BaseModel):
    ids: List[str]
    actions: Optional[List[PendingAction]] = None  # per-item duplicate actions

@api.get("/pending")
def get_pending():
    rows = db_all("SELECT * FROM pending_files ORDER BY detected_at DESC")
    stale_ids = [r["id"] for r in rows if not Path(r["original_path"]).is_file()]
    for sid in stale_ids:
        db_run("DELETE FROM pending_files WHERE id=?", (sid,))
        log.info(f"Auto-cleaned stale pending record: {sid}")
    active = [r for r in rows if r["id"] not in set(stale_ids)]
    return active

@api.post("/pending/apply")
def apply_pending(data: ApplyPending):
    applied = 0
    stale   = 0
    skipped = 0

    # Build action map from per-item actions list
    action_map = {}
    if data.actions:
        for a in data.actions:
            action_map[a.id] = a.duplicate_action

    for pid in data.ids:
        row = db_one("SELECT * FROM pending_files WHERE id=?", (pid,))
        if not row:
            continue

        if not Path(row["original_path"]).is_file():
            db_run("DELETE FROM pending_files WHERE id=?", (pid,))
            stale += 1
            continue

        rule = db_one("SELECT * FROM rules WHERE id=?", (row["rule_id"],))
        if not rule:
            db_run("DELETE FROM pending_files WHERE id=?", (pid,))
            continue

        dup_action = action_map.get(pid)
        duplicate_of = row.get("duplicate_of")

        # If this file is a duplicate and user chose skip (or no action chosen)
        if duplicate_of and dup_action == 'skip':
            db_run("DELETE FROM pending_files WHERE id=?", (pid,))
            skipped += 1
            continue

        proposed = row["proposed_path"]

        if duplicate_of and dup_action == 'overwrite':
            # Remove the existing duplicate then move to its exact path
            try:
                os.remove(duplicate_of)
                log.info(f"Overwrite: removed existing {duplicate_of}")
            except OSError as e:
                log.warning(f"Overwrite: could not remove {duplicate_of}: {e}")
            proposed = duplicate_of  # move to exact same path

        elif duplicate_of and dup_action == 'rename':
            # Use the already-unique proposed_path (has _001 suffix from unique_path)
            proposed = row["proposed_path"]

        elif duplicate_of and not dup_action:
            # No action provided for a duplicate — default to rename
            proposed = row["proposed_path"]

        result = do_move(
            row["original_path"],
            proposed,
            os.path.basename(row["original_path"]),
            row["proposed_name"],
            row["destination_folder"],
            row["rule_id"],
            row["rule_name"],
            content_hash=row.get("content_hash"),
        )
        db_run("DELETE FROM pending_files WHERE id=?", (pid,))
        if result:
            applied += 1

    return {"applied": applied, "stale": stale, "skipped": skipped}

@api.delete("/pending/{pid}")
def skip_pending(pid: str):
    db_run("DELETE FROM pending_files WHERE id=?", (pid,)); return {"message": "skipped"}

@api.delete("/pending")
def clear_pending():
    db_run("DELETE FROM pending_files"); return {"message": "cleared"}

# ── Organize (manual) ─────────────────────────────────────────────────────────
class OrganizeRequest(BaseModel):
    filenames: List[str]

@api.post("/organize/preview")
def preview_org(data: OrganizeRequest):
    settings = db_one("SELECT * FROM settings WHERE id='default'") or {}
    auto_clean = bool(settings.get("auto_clean_names", 1))
    out = []
    for fn in data.filenames:
        rule = match_rule(fn)
        if rule:
            rule_tmpl = rule.get("rename_template")
            if rule_tmpl is None:
                tmpl = settings.get("default_rename_template", "{date}_{originalname_cleaned}")
                if not auto_clean:
                    tmpl = tmpl.replace("{originalname_cleaned}", "{originalname}") \
                               .replace("{cleaned_name}", "{originalname}")
            elif rule_tmpl == "":
                tmpl = "{originalname_cleaned}" if auto_clean else "{originalname}"
            else:
                tmpl = rule_tmpl
            new_name = apply_template(tmpl, fn, next_seq(rule["destination_folder"]), rule["destination_folder"], auto_clean=auto_clean)
            dest = resolve_dest(rule["destination_folder"], settings)
            out.append({"original_name": fn, "new_name": new_name,
                        "destination_folder": dest, "rule_name": rule["name"],
                        "rule_id": rule["id"], "matched": True})
        else:
            out.append({"original_name": fn, "new_name": fn, "destination_folder": "Unsorted",
                        "rule_name": "No matching rule", "rule_id": None, "matched": False})
    return out

# ── Template preview (used by RulesManager dialog) ────────────────────────────
class TemplatePreviewRequest(BaseModel):
    filename: str
    rename_template: str
    destination_folder: str = "Documents"

@api.post("/organize/template-preview")
def preview_template(data: TemplatePreviewRequest):
    """Apply a rename template to a sample filename without needing a saved rule.
    Used by the frontend RulesManager dialog to show a live, accurate preview."""
    settings = db_one("SELECT * FROM settings WHERE id='default'") or {}
    auto_clean = bool(settings.get("auto_clean_names", 1))

    tmpl = data.rename_template
    if not tmpl:
        tmpl = "{originalname_cleaned}" if auto_clean else "{originalname}"

    seq = next_seq(data.destination_folder)
    new_name = apply_template(tmpl, data.filename, seq, data.destination_folder, auto_clean=auto_clean)
    dest = resolve_dest(data.destination_folder, settings)

    return {
        "original_name": data.filename,
        "new_name": new_name,
        "destination_folder": dest,
    }

@api.get("/activity")
def get_activity(limit: int = Query(50, ge=1, le=500)):
    return db_all("SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ?", (limit,))

@api.post("/activity/{aid}/undo")
def undo_activity(aid: str):
    act = db_one("SELECT * FROM activity_log WHERE id=?", (aid,))
    if not act: raise HTTPException(404, "Not found")
    if act.get("undone"): raise HTTPException(400, "Already undone")

    pending_count = db_one("SELECT COUNT(*) AS c FROM pending_files")["c"]
    if pending_count > 0:
        raise HTTPException(
            409,
            "Please review the pending files first before using Undo."
        )

    if act.get("new_path") and act.get("original_path") and os.path.exists(act["new_path"]):
        src_undo  = Path(act["new_path"]).resolve()
        dst_undo  = Path(act["original_path"]).resolve()   # stored as absolute — see do_move
        final_dst = None

        log.info(f"Undo [{aid}]: src={src_undo}  target={dst_undo}")

        if not src_undo.is_file():
            raise HTTPException(500, f"Undo failed: source file no longer exists at {src_undo}")

        dst_undo.parent.mkdir(parents=True, exist_ok=True)

        try:
            with _move_lock:
                final_dst = unique_path(str(dst_undo))

                if final_dst != str(dst_undo):
                    log.info(f"Undo [{aid}]: restoring to {final_dst} (original slot occupied)")

                with _pending_lock:
                    _pending_paths.add(final_dst)
                    _pending_paths.add(str(dst_undo))
                def _release(paths):
                    for p in paths:
                        _pending_paths.discard(p)
                threading.Timer(10.0, _release, args=[[final_dst, str(dst_undo)]]).start()

                shutil.move(str(src_undo), final_dst)

            log.info(f"Undo [{aid}]: moved to {final_dst}")

        except (OSError, shutil.Error) as e:
            log.error(f"Undo [{aid}]: move failed {src_undo} → {final_dst or dst_undo} | {e}")
            raise HTTPException(500, f"Undo failed: could not move file back ({e})")

    db_run("UPDATE activity_log SET undone=1 WHERE id=?", (aid,))
    if act.get("file_id"):
        db_run("DELETE FROM organized_files WHERE id=?", (act["file_id"],))
    return {"message": "undone", "id": aid}

@api.delete("/activity")
def clear_activity():
    db_run("DELETE FROM activity_log"); return {"message": "cleared"}

# ── Stats ─────────────────────────────────────────────────────────────────────
def _safe_full_path(folder: str, settings: dict) -> Optional[str]:
    """Resolve a folder name to its absolute path, returning None on any error."""
    try:
        return resolve_dest(folder, settings)
    except Exception:
        return None

@api.post("/organize/reconcile")
def trigger_reconcile():
    """Immediately purge DB records for files deleted from disk.
    Called by the Dashboard on mount so the Folders section is always current."""
    _reconcile_once()
    return {"message": "reconciled"}

# ── Organize Now ──────────────────────────────────────────────────────────────
@api.post("/organize-now")
def organize_now():
    """Scan all enabled monitored folders and apply active rules to every existing file.
    Respects preview_before_apply: queues to pending_files if ON, moves directly if OFF.
    Skips files already present in organized_files (already moved by Foldr).
    Returns a summary: scanned, matched, moved/queued, skipped."""
    settings = db_one("SELECT * FROM settings WHERE id='default'") or {}
    auto_clean = bool(settings.get("auto_clean_names", 1))
    preview = bool(settings.get("preview_before_apply", 1))

    # Collect all enabled monitored folders
    rows = db_all("SELECT path FROM monitored_folders WHERE enabled=1")
    folders = [r["path"] for r in rows]
    # Fallback to legacy single folder
    if not folders and settings.get("monitored_folder"):
        folders = [settings["monitored_folder"]]

    if not folders:
        raise HTTPException(400, "No monitored folders configured.")

    # Build set of already-organized original paths to skip re-processing
    already_organized = {
        r["original_path"]
        for r in db_all("SELECT original_path FROM organized_files")
        if r["original_path"]
    }
    # Also skip anything already in pending queue
    already_pending = {
        r["original_path"]
        for r in db_all("SELECT original_path FROM pending_files")
        if r["original_path"]
    }

    scanned = 0
    matched = 0
    actioned = 0  # moved or queued
    skipped = 0
    destination_folders: set = set()

    now_ts = datetime.now(timezone.utc).isoformat()

    for folder in folders:
        if not os.path.isdir(folder):
            continue
        try:
            entries = os.listdir(folder)
        except PermissionError:
            log.warning(f"organize-now: permission denied — {folder}")
            continue

        for filename in entries:
            full_path = os.path.join(folder, filename)
            if not os.path.isfile(full_path):
                continue
            if _is_temp_file(filename):
                continue
            scanned += 1

            abs_path = str(Path(full_path).resolve())

            if abs_path in already_organized or abs_path in already_pending:
                skipped += 1
                continue

            rule = match_rule(filename)
            if not rule:
                continue
            matched += 1

            rule_tmpl = rule.get("rename_template")
            if rule_tmpl is None:
                tmpl = settings.get("default_rename_template", "{date}_{originalname_cleaned}")
                if not auto_clean:
                    tmpl = tmpl.replace("{originalname_cleaned}", "{originalname}") \
                               .replace("{cleaned_name}", "{originalname}")
            elif rule_tmpl == "":
                tmpl = "{originalname_cleaned}" if auto_clean else "{originalname}"
            else:
                tmpl = rule_tmpl

            dest_dir = resolve_dest(rule["destination_folder"], settings)
            seq = next_seq(rule["destination_folder"])
            new_name = apply_template(tmpl, filename, seq, rule["destination_folder"], auto_clean=auto_clean)
            proposed = unique_path(os.path.join(dest_dir, new_name))

            if preview:
                # Queue to pending_files for user review
                existing_pending = db_one(
                    "SELECT id FROM pending_files WHERE original_path=?", (abs_path,)
                )
                if existing_pending:
                    skipped += 1
                    continue
                db_run(
                    """INSERT OR REPLACE INTO pending_files
                       (id, original_path, proposed_path, proposed_name,
                        destination_folder, rule_id, rule_name, detected_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (str(uuid.uuid4()), abs_path, proposed, new_name,
                     rule["destination_folder"], rule["id"], rule["name"], now_ts)
                )
                already_pending.add(abs_path)
                actioned += 1
                destination_folders.add(rule["destination_folder"])
            else:
                result = do_move(
                    abs_path, proposed, filename, new_name,
                    rule["destination_folder"], rule["id"], rule["name"]
                )
                if result:
                    actioned += 1
                    already_organized.add(abs_path)
                    destination_folders.add(rule["destination_folder"])

    return {
        "scanned": scanned,
        "matched": matched,
        "actioned": actioned,
        "skipped": skipped,
        "queued": actioned if preview else 0,
        "moved": actioned if not preview else 0,
        "folders": sorted(destination_folders),
        "preview_mode": preview,
    }

@api.get("/stats")
def get_stats():
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    week  = (now - timedelta(days=7)).isoformat()
    settings = db_one("SELECT * FROM settings WHERE id='default'") or {}
    return {
        "total_files":    db_one("SELECT COUNT(*) AS c FROM organized_files")["c"],
        "files_today":    db_one("SELECT COUNT(*) AS c FROM organized_files WHERE organized_at>=?", (today,))["c"],
        "files_week":     db_one("SELECT COUNT(*) AS c FROM organized_files WHERE organized_at>=?", (week,))["c"],
        "active_rules":   db_one("SELECT COUNT(*) AS c FROM rules WHERE enabled=1")["c"],
        "total_rules":    db_one("SELECT COUNT(*) AS c FROM rules")["c"],
        "pending_count":  db_one("SELECT COUNT(*) AS c FROM pending_files")["c"],
        "type_breakdown": db_all("SELECT file_type AS type,COUNT(*) AS count FROM organized_files GROUP BY file_type ORDER BY count DESC LIMIT 10"),
        "folder_breakdown": [{
            "folder": r["folder"],
            "count":  r["count"],
            "full_path": _safe_full_path(r["folder"], settings),
        } for r in db_all("SELECT folder,COUNT(*) AS count FROM organized_files GROUP BY folder ORDER BY count DESC LIMIT 10")],
        "recent_activity": db_all("SELECT * FROM activity_log WHERE undone=0 ORDER BY timestamp DESC LIMIT 5"),
    }

@api.get("/folders")
def get_folders():
    settings = db_one("SELECT * FROM settings WHERE id='default'") or {}
    rows = db_all("SELECT folder,COUNT(*) AS file_count FROM organized_files GROUP BY folder ORDER BY file_count DESC")
    return [{"folder": r["folder"], "file_count": r["file_count"],
             "full_path": _safe_full_path(r["folder"], settings)} for r in rows]

@api.get("/folders/{folder_name}")
def get_folder_files(folder_name: str):
    rows = db_all(
        """SELECT new_name AS filename, new_path AS path,
                  file_type, organized_at
           FROM organized_files
           WHERE folder=?
           ORDER BY organized_at DESC""",
        (folder_name,)
    )
    if not rows:
        exists = db_one("SELECT 1 AS found FROM organized_files WHERE folder=? LIMIT 1", (folder_name,))
        if not exists:
            raise HTTPException(404, f"Folder '{folder_name}' not found")
    return rows

@api.get("/")
def root(): return {"message": "Foldr backend running"}

app.include_router(api)

if __name__ == "__main__":
    port = int(os.environ.get("FOLDR_PORT", 8765))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")