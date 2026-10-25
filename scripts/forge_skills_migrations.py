"""Pinned SQLite checkpoints; refuse rollback that would discard business data."""
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from contextlib import contextmanager, closing
from pathlib import Path

IGNORED = {"schema_migrations", "audit_log", "sqlite_sequence"}
DERIVED_TIMESTAMPS = {"sources": {"updated_at"}, "skills": {"last_seen_at", "updated_at"}, "skill_variants": {"updated_at"}}

def atomic(path, value):
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def backup(source, destination):
    with closing(sqlite3.connect(source)) as a, closing(sqlite3.connect(destination)) as b:
        a.backup(b)
        if b.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite checkpoint integrity failed")

def snapshot(profile, directory=None):
    state = Path(profile["state_dir"])
    directory = Path(directory) if directory else state / "migration-checkpoints" / uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=False)
    database = directory / "database.sqlite"
    backup(state / "control-plane.db", database)
    manifest = {"version": 1, "state_dir": str(state.resolve()), "source_dir": profile["source_dir"],
                "source_head": profile["source_head"], "database_sha256": digest(database), "sidecars": {}}
    for name in ["workflow-imports.json", "index.json"]:
        file = state / name
        if file.exists():
            (directory / name).write_bytes(file.read_bytes())
            manifest["sidecars"][name] = digest(directory / name)
    atomic(directory / "manifest.json", manifest)
    return str(directory)

def validated(directory, state):
    directory = Path(directory)
    info = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    if info["version"] != 1 or Path(info["state_dir"]).resolve() != Path(state).resolve():
        raise ValueError("Checkpoint belongs to another Skills state")
    if digest(directory / "database.sqlite") != info["database_sha256"]:
        raise ValueError("Checkpoint database hash differs")
    for name, sha in info["sidecars"].items():
        if name not in {"workflow-imports.json", "index.json"} or digest(directory / name) != sha:
            raise ValueError("Checkpoint sidecar differs")
    return info

def rollback_allowed(current, previous):
    def tables(db):
        return {n: sql for n, sql in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table'") if n not in IGNORED and not n.startswith('sqlite_')}
    def rows(db, name):
        quoted = '"' + name.replace('"','""') + '"'
        columns = [r[1] for r in db.execute('PRAGMA table_info(' + quoted + ')') if r[1] not in DERIVED_TIMESTAMPS.get(name, set())]
        select = ','.join('"' + c.replace('"','""') + '"' for c in columns)
        return sorted(repr(tuple(r)) for r in db.execute('SELECT ' + select + ' FROM ' + quoted))
    with closing(sqlite3.connect(current)) as live, closing(sqlite3.connect(previous)) as old:
        a, b = tables(live), tables(old)
        for name, schema in b.items():
            if a.get(name) != schema or rows(live, name) != rows(old, name):
                raise ValueError("Rollback would discard changed business data/schema: " + name)
        for name in a.keys() - b.keys():
            if rows(live, name):
                raise ValueError("Rollback would discard data in a new table: " + name)

def restore(profile, directory, recovery=False):
    state = Path(profile["state_dir"]); directory = Path(directory)
    info = validated(directory, state)
    if not recovery:
        rollback_allowed(state / "control-plane.db", directory / "database.sqlite")
    else:
        rollback_allowed(directory / "database.sqlite", state / "control-plane.db")
    # Caller owns both stopped services and the managed installation mutex.
    backup(directory / "database.sqlite", state / "control-plane.db")
    for name in ["workflow-imports.json", "index.json"]:
        if name in info["sidecars"]:
            (state / name).write_bytes((directory / name).read_bytes())
        else:
            (state / name).unlink(missing_ok=True)
    atomic(state / "migration-source.json", {"source_dir": info["source_dir"], "source_head": info["source_head"]})
    return info

@contextmanager
def migration_guard(profile):
    state = Path(profile["state_dir"]); marker = state / "migration-source.json"
    mutex = state / "migration.lock"
    fd = os.open(mutex, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        old = json.loads(marker.read_text(encoding="utf-8")) if marker.exists() else None
        if (state / "control-plane.db").exists() and (old is None or old['source_head'] != profile['source_head']):
            snapshot({**profile, **(old or {"source_head": "unknown"})})
        yield
        atomic(marker, {"source_dir": profile["source_dir"], "source_head": profile["source_head"]})
    finally:
        os.close(fd); mutex.unlink()

if __name__ == "__main__":
    action, profile_path, *rest = sys.argv[1:]
    profile = json.loads(Path(profile_path).read_text(encoding="utf-8-sig"))
    if action == "snapshot":
        result = {"snapshot": snapshot(profile)}
    elif action == "check":
        info = validated(rest[0], profile['state_dir'])
        rollback_allowed(Path(profile['state_dir'])/'control-plane.db', Path(rest[0])/'database.sqlite')
        result = {"allowed": True, **info}
    elif action in {"restore", "recover"}:
        result = restore(profile, rest[0], recovery=action == "recover")
    else:
        raise ValueError("Unknown migration action")
    print(json.dumps(result))
