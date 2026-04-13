"""
Foldr Native Backend
FastAPI + SQLite + watchdog (real folder monitoring + file moves)
"""
import os, re, shutil, sqlite3, logging, threading, uuid
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

def apply_template(template: str, filename: str, seq: int, category: str) -> str:
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
    r = r.replace("{originalname_cleaned}", clean_filename(name))
    r = r.replace("{cleaned_name}", clean_filename(name))
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

def resolve_dest(folder: str, settings: dict) -> str:
    p = Path(folder)
    if p.is_absolute(): return str(p)
    base = settings.get("base_output_folder") or str(Path.home())
    return str(Path(base) / folder)

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
def do_move(src, dst, orig_name, new_name, folder, rule_id, rule_name):
    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        dst = unique_path(dst)
        shutil.move(src, dst)
        ext = orig_name.rsplit('.', 1)[1].lower() if '.' in orig_name else 'unknown'
        fid = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        db_run("""INSERT INTO organized_files
            (id,original_name,original_path,new_name,new_path,folder,file_type,organized_at,rule_id)
            VALUES (?,?,?,?,?,?,?,?,?)""",
            (fid, orig_name, src, new_name, dst, folder, ext, now, rule_id))
        db_run("""INSERT INTO activity_log
            (id,original_name,original_path,new_name,new_path,destination_folder,
             rule_name,rule_id,timestamp,undone,file_type,file_id)
            VALUES (?,?,?,?,?,?,?,?,?,0,?,?)""",
            (str(uuid.uuid4()), orig_name, src, new_name, dst, folder,
             rule_name, rule_id, now, ext, fid))
        log.info(f"Moved: {orig_name} -> {dst}")
        return dst
    except Exception as e:
        log.error(f"Move failed {src}: {e}")
        return None

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
        tmpl = rule.get("rename_template") or settings.get("default_rename_template", "{date}_{originalname_cleaned}")
        new_name = apply_template(tmpl, filename, seq, rule["destination_folder"])
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

@api.put("/settings")
def update_settings(data: SettingsUpdate):
    fields = {k: (1 if v is True else (0 if v is False else v))
              for k, v in data.model_dump().items() if v is not None}
    if not fields: raise HTTPException(400, "Nothing to update")
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

RULE_TEMPLATES = {
    "student": [
        {"name":"PDFs → Assignments","condition_type":"extension","condition_value":".pdf","destination_folder":"Assignments","rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Word Docs → Notes","condition_type":"extension","condition_value":".docx","destination_folder":"Notes","rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Presentations","condition_type":"extension","condition_value":".pptx","destination_folder":"Presentations","rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Spreadsheets","condition_type":"extension","condition_value":".xlsx","destination_folder":"Spreadsheets","rename_template":"{date}_{originalname_cleaned}"},
    ],
    "freelancer": [
        {"name":"Invoices","condition_type":"keyword","condition_value":"invoice","destination_folder":"Invoices","rename_template":"{date}_{originalname_cleaned}_{sequence}"},
        {"name":"Contracts","condition_type":"keyword","condition_value":"contract","destination_folder":"Contracts","rename_template":"{date}_{originalname_cleaned}"},
        {"name":"PDFs → Documents","condition_type":"extension","condition_value":".pdf","destination_folder":"Documents","rename_template":"{date}_{originalname_cleaned}"},
        {"name":"Images → Assets","condition_type":"extension","condition_value":".jpg","destination_folder":"Assets","rename_template":"{category}_{sequence}"},
    ],
    "developer": [
        {"name":"Python Files","condition_type":"extension","condition_value":".py","destination_folder":"Code","rename_template":"{originalname}"},
        {"name":"JavaScript","condition_type":"extension","condition_value":".js","destination_folder":"Code","rename_template":"{originalname}"},
        {"name":"JSON Config","condition_type":"extension","condition_value":".json","destination_folder":"Config","rename_template":"{originalname}"},
        {"name":"Markdown","condition_type":"extension","condition_value":".md","destination_folder":"Documentation","rename_template":"{originalname}"},
        {"name":"Archives","condition_type":"extension","condition_value":".zip","destination_folder":"Archives","rename_template":"{date}_{originalname_cleaned}"},
    ]
}

@api.get("/rules/templates")
def get_templates():    return RULE_TEMPLATES
@api.post("/rules/templates/{ttype}")
def apply_template_route(ttype: str):
    if ttype not in RULE_TEMPLATES: raise HTTPException(404, "Not found")
    count = db_one("SELECT COUNT(*) AS c FROM rules")["c"]
    created = []
    for i, rd in enumerate(RULE_TEMPLATES[ttype]):
        did = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        db_run("""INSERT INTO rules (id,name,condition_type,condition_value,destination_folder,
                   rename_template,priority,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
               (did,rd["name"],rd["condition_type"],rd["condition_value"],
                rd["destination_folder"],rd["rename_template"],count+i,1,now))
        created.append(db_one("SELECT * FROM rules WHERE id=?", (did,)))
    return created

@api.get("/rules")
def get_rules():     return db_all("SELECT * FROM rules ORDER BY priority")
@api.post("/rules")
def create_rule(rule: RuleCreate):
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

@api.put("/rules/{rule_id}")
def update_rule(rule_id: str, rule: RuleUpdate):
    fields = {k: (1 if v is True else (0 if v is False else v))
              for k, v in rule.model_dump().items() if v is not None}
    if not fields: raise HTTPException(400, "Nothing to update")
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
    return db_all("SELECT * FROM pending_files ORDER BY detected_at DESC")

@api.post("/pending/apply")
def apply_pending(data: ApplyPending):
    count = 0
    for pid in data.ids:
        row = db_one("SELECT * FROM pending_files WHERE id=?", (pid,))
        if not row: continue
        rule = db_one("SELECT * FROM rules WHERE id=?", (row["rule_id"],))
        if not rule: db_run("DELETE FROM pending_files WHERE id=?", (pid,)); continue
        final = unique_path(row["proposed_path"])
        result = do_move(row["original_path"], final,
                         os.path.basename(row["original_path"]),
                         os.path.basename(final),
                         row["destination_folder"], row["rule_id"], row["rule_name"])
        db_run("DELETE FROM pending_files WHERE id=?", (pid,))
        if result: count += 1
    return {"applied": count}

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
    out = []
    for fn in data.filenames:
        rule = match_rule(fn)
        if rule:
            tmpl = rule.get("rename_template") or settings.get("default_rename_template","")
            new_name = apply_template(tmpl, fn, next_seq(rule["destination_folder"]), rule["destination_folder"])
            dest = resolve_dest(rule["destination_folder"], settings)
            out.append({"original_name": fn, "new_name": new_name,
                        "destination_folder": dest, "rule_name": rule["name"],
                        "rule_id": rule["id"], "matched": True})
        else:
            out.append({"original_name": fn, "new_name": fn, "destination_folder": "Unsorted",
                        "rule_name": "No matching rule", "rule_id": None, "matched": False})
    return out

# ── Activity ──────────────────────────────────────────────────────────────────
@api.get("/activity")
def get_activity(limit: int = Query(50, ge=1, le=500)):
    return db_all("SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ?", (limit,))

@api.post("/activity/{aid}/undo")
def undo_activity(aid: str):
    act = db_one("SELECT * FROM activity_log WHERE id=?", (aid,))
    if not act: raise HTTPException(404, "Not found")
    if act.get("undone"): raise HTTPException(400, "Already undone")
    if act.get("new_path") and act.get("original_path") and os.path.exists(act["new_path"]):
        try:
            os.makedirs(os.path.dirname(act["original_path"]), exist_ok=True)
            shutil.move(act["new_path"], unique_path(act["original_path"]))
        except Exception as e:
            log.warning(f"Undo failed: {e}")
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

@api.get("/")
def root(): return {"message": "Foldr backend running"}

app.include_router(api)

if __name__ == "__main__":
    port = int(os.environ.get("FOLDR_PORT", 8765))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")