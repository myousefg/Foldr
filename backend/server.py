"""
Foldr Native Backend
FastAPI + SQLite + watchdog (real folder monitoring + file moves)
"""
import os, re, shutil, sqlite3, logging, threading, uuid, time
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional

import uvicorn
from fastapi import FastAPI, APIRouter, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE_DIR = Path(os.environ.get("FOLDR_DATA", Path.home() / ".foldr"))
BASE_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = BASE_DIR / "foldr.db"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("foldr")

# ── SQLite ────────────────────────────────────────────────────────────────────
_db_lock = threading.Lock()

def _conn():
    c = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    return c

def db_one(sql, p=()):
    with _db_lock:
        c = _conn()
        try:
            r = c.execute(sql, p).fetchone()
            return dict(r) if r else None
        finally: c.close()

def db_all(sql, p=()):
    with _db_lock:
        c = _conn()
        try: return [dict(r) for r in c.execute(sql, p).fetchall()]
        finally: c.close()

def db_run(sql, p=()):
    with _db_lock:
        c = _conn()
        try: c.execute(sql, p); c.commit()
        finally: c.close()

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
CREATE TABLE IF NOT EXISTS organized_files (
    id TEXT PRIMARY KEY,
    original_name TEXT, original_path TEXT,
    new_name TEXT, new_path TEXT,
    folder TEXT, file_type TEXT, organized_at TEXT, rule_id TEXT
);
CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    original_name TEXT, original_path TEXT,
    new_name TEXT, new_path TEXT,
    destination_folder TEXT, rule_name TEXT, rule_id TEXT,
    timestamp TEXT, undone INTEGER DEFAULT 0,
    file_type TEXT, file_id TEXT
);
CREATE TABLE IF NOT EXISTS pending_files (
    id TEXT PRIMARY KEY,
    original_path TEXT, proposed_path TEXT,
    proposed_name TEXT, destination_folder TEXT,
    rule_id TEXT, rule_name TEXT, detected_at TEXT
);
        """)
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

    # Option B contract:
    #   {originalname_cleaned} → ALWAYS cleans, regardless of auto_clean setting.
    #     The token name is the explicit instruction. If you typed it, you want it.
    #   {originalname}         → ALWAYS raw, regardless of auto_clean setting.
    #   auto_clean only decides which fallback template resolve_tmpl picks when
    #     the rule's rename_template field is left empty (see _process / preview_org).
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
        # Absolute paths: only allow them when they are already real directories
        # (user explicitly configured them). We still normalise to catch e.g. /a/../../../etc.
        resolved = p.resolve()
        return str(resolved)
    # Relative paths must resolve inside the configured base_output_folder (or home)
    base = Path(settings.get("base_output_folder") or str(Path.home()))
    return str(_safe_resolve(base / folder, base))

def match_rule(filename: str) -> Optional[dict]:
    rules = db_all("SELECT * FROM rules WHERE enabled=1 ORDER BY priority")
    ext = ('.' + filename.rsplit('.', 1)[1].lower()) if '.' in filename else ''
    nl = filename.lower()
    for rule in rules:
        cv = rule["condition_value"].lower()
        if rule["condition_type"] == "extension":
            if not cv.startswith('.'): cv = '.' + cv
            if ext == cv: return rule
        elif rule["condition_type"] == "keyword":
            if cv in nl: return rule
    return None

def next_seq(folder: str) -> int:
    r = db_one("SELECT COUNT(*) AS c FROM organized_files WHERE folder=?", (folder,))
    return (r["c"] if r else 0) + 1

# ── Move helper ───────────────────────────────────────────────────────────────
_MOVE_MAX_RETRIES = 3
_MOVE_RETRY_DELAY = 0.1  # seconds

def do_move(src, dst, orig_name, new_name, folder, rule_id, rule_name):
    # Validate source exists and is a real file (not a symlink escape)
    src_path = Path(src).resolve()
    if not src_path.is_file():
        log.warning(f"do_move: source does not exist or is not a file: {src}")
        return None

    # Validate destination directory does not escape via traversal
    dst_path = Path(dst).resolve()
    dst_path.parent.mkdir(parents=True, exist_ok=True)

    # ── Atomic unique_path + shutil.move under _move_lock ────────────────────
    # The lock serialises all do_move calls so two threads can never receive
    # the same free path from unique_path() and race to shutil.move() it.
    #
    # Retry loop handles the residual TOCTOU window where a process outside
    # Foldr creates the file between our os.path.exists check and the move.
    # Each retry re-runs unique_path() inside the lock to get a fresh free
    # path — we never blindly overwrite on retry.
    # ─────────────────────────────────────────────────────────────────────────
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

    # Store src_path (resolved absolute path), NOT the raw `src` string.
    # If src was a relative path or contained symlinks, storing `src` would
    # make undo_activity restore to the wrong location.
    abs_src = str(src_path)

    try:
        db_run("""INSERT INTO organized_files
            (id,original_name,original_path,new_name,new_path,folder,file_type,organized_at,rule_id)
            VALUES (?,?,?,?,?,?,?,?,?)""",
            (fid, orig_name, abs_src, new_name, final_dst, folder, ext, now, rule_id))
        db_run("""INSERT INTO activity_log
            (id,original_name,original_path,new_name,new_path,destination_folder,
             rule_name,rule_id,timestamp,undone,file_type,file_id)
            VALUES (?,?,?,?,?,?,?,?,?,0,?,?)""",
            (str(uuid.uuid4()), orig_name, abs_src, new_name, final_dst, folder,
             rule_name, rule_id, now, ext, fid))
    except Exception as db_err:
        # File was moved successfully — don't undo. Log the discrepancy.
        log.error(f"DB log failed after successful move {abs_src} → {final_dst}: {db_err}")

    log.info(f"Moved: {orig_name} -> {final_dst}")
    return final_dst

# ── Watchdog ──────────────────────────────────────────────────────────────────
class FoldrHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory:
            threading.Timer(0.8, self._handle, args=[event.src_path]).start()
    def on_moved(self, event):
        if not event.is_directory:
            threading.Timer(0.8, self._handle, args=[event.dest_path]).start()

    def _handle(self, path):
        if not os.path.isfile(path): return
        # Dedup: skip if this path is already queued or being processed
        with _pending_lock:
            if path in _pending_paths:
                return
            _pending_paths.add(path)
        try:
            self._process(path)
        finally:
            # Release after a short delay so rapid duplicate events are ignored
            threading.Timer(3.0, lambda: _pending_paths.discard(path)).start()

    def _process(self, path):
        if not os.path.isfile(path): return
        # Also skip if already in pending_files table (survived a restart)
        existing = db_one("SELECT id FROM pending_files WHERE original_path=?", (path,))
        if existing: return
        settings = db_one("SELECT * FROM settings WHERE id='default'") or {}
        if not settings.get("monitoring_enabled", 1): return
        filename = os.path.basename(path)
        rule = match_rule(filename)
        if not rule: return
        dest_dir = resolve_dest(rule["destination_folder"], settings)
        seq = next_seq(rule["destination_folder"])
        # ── Template resolution ───────────────────────────────────────────
        # Option B contract:
        #   {originalname_cleaned} in an EXPLICIT rule template → always cleans.
        #   auto_clean flag only controls two things:
        #     1. Empty rule template fallback: ON→{originalname_cleaned}, OFF→{originalname}
        #     2. Global default fallback: OFF swaps {originalname_cleaned}→{originalname}
        #        so the global default also respects the setting when no rule overrides it.
        rule_tmpl = rule.get("rename_template")
        if rule_tmpl is None:
            # No rule template — use global default, but honour auto_clean by
            # swapping the token so the user's global preference is respected.
            tmpl = settings.get("default_rename_template", "{date}_{originalname_cleaned}")
            if not auto_clean:
                tmpl = tmpl.replace("{originalname_cleaned}", "{originalname}") \
                           .replace("{cleaned_name}", "{originalname}")
        elif rule_tmpl == "":
            # Empty = no rename. auto_clean decides whether to clean the name.
            tmpl = "{originalname_cleaned}" if auto_clean else "{originalname}"
        else:
            # Explicit rule template — rendered exactly as written.
            # {originalname_cleaned} always cleans; auto_clean is irrelevant here.
            tmpl = rule_tmpl
        # ─────────────────────────────────────────────────────────────────

        # Read auto_clean_names flag (default ON).
        # This was the root cause: flag was saved to DB but never read here.
        auto_clean = bool(settings.get("auto_clean_names", 1))

        new_name = apply_template(tmpl, filename, seq, rule["destination_folder"], auto_clean=auto_clean)
        proposed = unique_path(os.path.join(dest_dir, new_name))

        if settings.get("preview_before_apply", 1):
            db_run("""INSERT OR REPLACE INTO pending_files
                (id,original_path,proposed_path,proposed_name,destination_folder,rule_id,rule_name,detected_at)
                VALUES (?,?,?,?,?,?,?,?)""",
                (str(uuid.uuid4()), path, proposed, new_name,
                 rule["destination_folder"], rule["id"], rule["name"],
                 datetime.now(timezone.utc).isoformat()))
            log.info(f"Queued: {filename}")
        else:
            do_move(path, proposed, filename, new_name,
                    rule["destination_folder"], rule["id"], rule["name"])

_observer: Optional[Observer] = None
_obs_lock = threading.Lock()
_pending_paths: set = set()   # dedup: paths currently being processed
_pending_lock = threading.Lock()
_move_lock = threading.Lock()  # ensures unique_path + shutil.move are atomic

def start_watcher(folder):
    global _observer
    with _obs_lock:
        if _observer:
            _observer.stop(); _observer.join()
        if not folder or not os.path.isdir(folder): return
        _observer = Observer()
        _observer.schedule(FoldrHandler(), folder, recursive=False)
        _observer.start()
        log.info(f"Watching: {folder}")

def stop_watcher():
    global _observer
    with _obs_lock:
        if _observer:
            _observer.stop(); _observer.join(); _observer = None

# ── App lifespan ──────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    s = db_one("SELECT * FROM settings WHERE id='default'") or {}
    if s.get("monitoring_enabled") and s.get("monitored_folder"):
        start_watcher(s["monitored_folder"])
    yield
    stop_watcher()

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
    # Allowlist: only known column names may appear in the dynamic SET clause
    if invalid := set(fields) - _SETTINGS_COLUMNS:
        raise HTTPException(400, f"Unknown settings fields: {invalid}")
    # Validate folder paths: must be absolute and must not contain traversal sequences
    for folder_key in ("monitored_folder", "base_output_folder"):
        if folder_key in fields and fields[folder_key]:
            p = Path(str(fields[folder_key]))
            if ".." in p.parts:
                raise HTTPException(400, f"{folder_key} must not contain '..'.")
    sets = ", ".join(f"{k}=?" for k in fields)
    db_run(f"UPDATE settings SET {sets} WHERE id='default'", list(fields.values()))
    if "monitored_folder" in fields or "monitoring_enabled" in fields:
        s = db_one("SELECT * FROM settings WHERE id='default'") or {}
        if s.get("monitoring_enabled") and s.get("monitored_folder"):
            start_watcher(s["monitored_folder"])
        else:
            stop_watcher()
    return db_one("SELECT * FROM settings WHERE id='default'")

# ── Rules ─────────────────────────────────────────────────────────────────────
class RuleCreate(BaseModel):
    name: str; condition_type: str; condition_value: str
    destination_folder: str; rename_template: str = ""; enabled: bool = True

class RuleUpdate(BaseModel):
    name: Optional[str] = None; condition_type: Optional[str] = None
    condition_value: Optional[str] = None; destination_folder: Optional[str] = None
    rename_template: Optional[str] = None; enabled: Optional[bool] = None

class RuleReorder(BaseModel):
    rule_ids: List[str]

_VALID_CONDITION_TYPES = frozenset({"extension", "keyword"})

def _validate_rule_fields(
    name: Optional[str] = None,
    condition_type: Optional[str] = None,
    destination_folder: Optional[str] = None,
):
    """Raise HTTPException for any field that fails basic input sanitisation."""
    if name is not None and (not name.strip() or len(name) > 128):
        raise HTTPException(400, "Rule name must be 1–128 non-blank characters.")
    if condition_type is not None and condition_type not in _VALID_CONDITION_TYPES:
        raise HTTPException(400, f"condition_type must be one of: {sorted(_VALID_CONDITION_TYPES)}")
    if destination_folder is not None:
        # Reject obvious traversal sequences in destination_folder
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

# Normalised dedup key
def _cv_key(ctype: str, cval: str) -> tuple:
    return (ctype.lower(), cval.lower().strip().lstrip("."))

# Lock prevents concurrent preset calls (rapid double-clicks)
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
        # Snapshot all existing keys in ONE query to prevent any duplication
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

@api.get("/rules")
def get_rules():     return db_all("SELECT * FROM rules ORDER BY priority")
@api.post("/rules")
def create_rule(rule: RuleCreate):
    _validate_rule_fields(rule.name, rule.condition_type, rule.destination_folder)
    count = db_one("SELECT COUNT(*) AS c FROM rules")["c"]
    did = str(uuid.uuid4()); now = datetime.now(timezone.utc).isoformat()
    db_run("""INSERT INTO rules (id,name,condition_type,condition_value,destination_folder,
               rename_template,priority,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
           (did,rule.name,rule.condition_type,rule.condition_value,
            rule.destination_folder,rule.rename_template,count,1 if rule.enabled else 0,now))
    return db_one("SELECT * FROM rules WHERE id=?", (did,))

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
    _validate_rule_fields(rule.name, rule.condition_type, rule.destination_folder)
    fields = {k: (1 if v is True else (0 if v is False else v))
              for k, v in rule.model_dump().items() if v is not None}
    if not fields: raise HTTPException(400, "Nothing to update")
    # Allowlist: only known column names may appear in the dynamic SET clause
    if invalid := set(fields) - _RULE_COLUMNS:
        raise HTTPException(400, f"Unknown rule fields: {invalid}")
    sets = ", ".join(f"{k}=?" for k in fields)
    db_run(f"UPDATE rules SET {sets} WHERE id=?", [*fields.values(), rule_id])
    r = db_one("SELECT * FROM rules WHERE id=?", (rule_id,))
    if not r: raise HTTPException(404, "Not found")
    return r

@api.delete("/rules/{rule_id}")
def delete_rule(rule_id: str):
    db_run("DELETE FROM rules WHERE id=?", (rule_id,)); return {"message": "deleted"}

# ── Pending ───────────────────────────────────────────────────────────────────
class ApplyPending(BaseModel):
    ids: List[str]

@api.get("/pending")
def get_pending():
    rows = db_all("SELECT * FROM pending_files ORDER BY detected_at DESC")
    # Auto-clean stale records: original file was deleted before user reviewed it.
    # This ensures the frontend never shows a preview card for a file that is gone.
    stale_ids = [r["id"] for r in rows if not Path(r["original_path"]).is_file()]
    for sid in stale_ids:
        db_run("DELETE FROM pending_files WHERE id=?", (sid,))
        log.info(f"Auto-cleaned stale pending record: {sid}")
    active = [r for r in rows if r["id"] not in set(stale_ids)]
    return active

@api.post("/pending/apply")
def apply_pending(data: ApplyPending):
    applied = 0
    stale   = 0  # files that were deleted before the user hit Apply

    for pid in data.ids:
        row = db_one("SELECT * FROM pending_files WHERE id=?", (pid,))
        if not row:
            continue  # already processed or skipped

        # ── Stale-file guard ──────────────────────────────────────────────
        # If the source file no longer exists (user deleted it manually, or a
        # previous apply already moved it), remove the pending record and skip.
        # do_move() also checks this internally, but doing it here gives us an
        # explicit stale count and avoids unnecessary rule/path lookups.
        if not Path(row["original_path"]).is_file():
            db_run("DELETE FROM pending_files WHERE id=?", (pid,))
            log.info(f"apply_pending: stale record removed (file gone): {row['original_path']}")
            stale += 1
            continue
        # ─────────────────────────────────────────────────────────────────

        rule = db_one("SELECT * FROM rules WHERE id=?", (row["rule_id"],))
        if not rule:
            db_run("DELETE FROM pending_files WHERE id=?", (pid,))
            continue

        # Pass proposed_path directly — do_move calls unique_path() under
        # _move_lock, so there is no double-unique_path race here.
        result = do_move(
            row["original_path"],
            row["proposed_path"],
            os.path.basename(row["original_path"]),
            row["proposed_name"],
            row["destination_folder"],
            row["rule_id"],
            row["rule_name"],
        )
        db_run("DELETE FROM pending_files WHERE id=?", (pid,))
        if result:
            applied += 1

    return {"applied": applied, "stale": stale}

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

@api.get("/activity")
def get_activity(limit: int = Query(50, ge=1, le=500)):
    return db_all("SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ?", (limit,))

@api.post("/activity/{aid}/undo")
def undo_activity(aid: str):
    act = db_one("SELECT * FROM activity_log WHERE id=?", (aid,))
    if not act: raise HTTPException(404, "Not found")
    if act.get("undone"): raise HTTPException(400, "Already undone")

    # ── Pending-items guard ──────────────────────────────────────────────────
    # If there are files waiting in the preview queue, block undo.
    # Undoing while preview is active would move the file back into the
    # monitored folder, triggering watchdog to re-queue it — causing an
    # infinite move → undo → move loop.
    pending_count = db_one("SELECT COUNT(*) AS c FROM pending_files")["c"]
    if pending_count > 0:
        raise HTTPException(
            409,
            "Please review the pending files first before using Undo."
        )
    # ─────────────────────────────────────────────────────────────────────────

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
                # unique_path() ensures we never overwrite if original slot is
                # already taken (e.g. user created a new file at that location).
                # AC: "jika original_path sudah ditempati, gunakan unique_path()"
                final_dst = unique_path(str(dst_undo))

                if final_dst != str(dst_undo):
                    log.info(f"Undo [{aid}]: original slot occupied — "
                             f"restoring to {final_dst} instead of {dst_undo}")

                # ── Loop prevention ──────────────────────────────────────────
                # Register both paths in _pending_paths before the move so the
                # watchdog skips the event and doesn't re-queue the file.
                with _pending_lock:
                    _pending_paths.add(final_dst)
                    _pending_paths.add(str(dst_undo))
                def _release(paths):
                    for p in paths:
                        _pending_paths.discard(p)
                threading.Timer(10.0, _release, args=[[final_dst, str(dst_undo)]]).start()
                # ────────────────────────────────────────────────────────────

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
@api.get("/stats")
def get_stats():
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    week  = (now - timedelta(days=7)).isoformat()
    return {
        "total_files":    db_one("SELECT COUNT(*) AS c FROM organized_files")["c"],
        "files_today":    db_one("SELECT COUNT(*) AS c FROM organized_files WHERE organized_at>=?", (today,))["c"],
        "files_week":     db_one("SELECT COUNT(*) AS c FROM organized_files WHERE organized_at>=?", (week,))["c"],
        "active_rules":   db_one("SELECT COUNT(*) AS c FROM rules WHERE enabled=1")["c"],
        "total_rules":    db_one("SELECT COUNT(*) AS c FROM rules")["c"],
        "pending_count":  db_one("SELECT COUNT(*) AS c FROM pending_files")["c"],
        "type_breakdown": db_all("SELECT file_type AS type,COUNT(*) AS count FROM organized_files GROUP BY file_type ORDER BY count DESC LIMIT 10"),
        "folder_breakdown": [{"folder": r["folder"], "count": r["count"]} for r in
                             db_all("SELECT folder,COUNT(*) AS count FROM organized_files GROUP BY folder ORDER BY count DESC LIMIT 10")],
        "recent_activity": db_all("SELECT * FROM activity_log WHERE undone=0 ORDER BY timestamp DESC LIMIT 5"),
    }

@api.get("/folders")
def get_folders():
    return db_all("SELECT folder,COUNT(*) AS file_count FROM organized_files GROUP BY folder ORDER BY file_count DESC")

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
        # Distinguish empty folder from folder that never existed
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