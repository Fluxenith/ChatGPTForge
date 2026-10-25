"""Install Serena 1.7.0 language servers for additional languages into a
Forge-owned directory, using Serena's own pinned installers (official sources).

Owner-approved (2026-10-16): clangd (cpp), intelephense (php), kotlin-lsp
(kotlin), bash-language-server (bash), lua-language-server (lua). Each server is
started once on a tiny private fixture so Serena performs its pinned download,
then the resulting tree is digested into languages-lock.json. Nothing here runs
during normal analysis; private runs read the installed tree and verify it.

Usage: python -I install-languages.py <owned-dir> <lock-json> <language>...
"""
import hashlib
import json
import sys
import tempfile
import time
from pathlib import Path

FIXTURES = {
    "cpp": ("main.cpp", "int add(int a, int b) { return a + b; }\nint main() { return add(1, 2); }\n"),
    "php": ("index.php", "<?php\nfunction add($a, $b) { return $a + $b; }\necho add(1, 2);\n"),
    "kotlin": ("Main.kt", "fun add(a: Int, b: Int) = a + b\nfun main() { println(add(1, 2)) }\n"),
    "bash": ("main.sh", "add() { echo $(($1 + $2)); }\nadd 1 2\n"),
    "lua": ("main.lua", "local function add(a, b) return a + b end\nprint(add(1, 2))\n"),
}


def tree_digest(root: Path) -> dict:
    h = hashlib.sha256()
    files = 0
    size = 0
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        data = path.read_bytes()
        rel = path.relative_to(root).as_posix()
        h.update(rel.encode() + b"\0" + hashlib.sha256(data).digest())
        files += 1
        size += len(data)
    return {"sha256": h.hexdigest(), "files": files, "bytes": size}


def main() -> None:
    from serena import __version__ as version
    from solidlsp.ls import SolidLanguageServer
    from solidlsp.ls_config import LanguageServerConfig, LanguageServerId
    from solidlsp.settings import SolidLSPSettings

    owned, lock_path, languages = Path(sys.argv[1]).resolve(), Path(sys.argv[2]), sys.argv[3:]
    owned.mkdir(parents=True, exist_ok=True)
    lock = json.loads(lock_path.read_text(encoding="utf-8")) if lock_path.exists() else {"serena_version": version, "languages": {}}
    for language in languages:
        name, text = FIXTURES[language]
        started = time.time()
        entry = {"state": "failed"}
        with tempfile.TemporaryDirectory(prefix="forge-ls-install-") as tmp:
            project = Path(tmp) / "project"
            project.mkdir()
            (project / name).write_text(text, encoding="utf-8", newline="\n")
            settings = SolidLSPSettings(solidlsp_dir=str(owned), project_data_path=str(Path(tmp) / "state"))
            before = {p.name for p in Path(settings.ls_resources_dir).iterdir()}
            try:
                server = SolidLanguageServer.create(LanguageServerConfig(ls_id=LanguageServerId(language)), str(project),
                                                    timeout=240.0, solidlsp_settings=settings)
                server.start()
                try:
                    symbols = server.request_document_symbols(name)
                    count = len(symbols.get_all_symbols_and_roots()[0]) if hasattr(symbols, "get_all_symbols_and_roots") else None
                finally:
                    server.stop()
                if language == "lua":
                    # The install run writes logs beside the binary; Forge runs
                    # keep them in their own directory, so they are not pinned.
                    import shutil
                    for log_dir in Path(settings.ls_resources_dir).glob("LuaLanguageServer/**/log"):
                        if log_dir.is_dir():
                            shutil.rmtree(log_dir)
                after = {p.name for p in Path(settings.ls_resources_dir).iterdir()}
                dirs = sorted(after - before) or sorted(after)
                entry = {"state": "installed", "resource_dirs": {d: tree_digest(Path(settings.ls_resources_dir) / d) for d in dirs},
                         "fixture_symbols": count}
            except Exception as error:  # recorded, never retried here
                entry = {"state": "failed", "error": f"{type(error).__name__}: {error}"[:1500]}
        entry["seconds"] = round(time.time() - started, 1)
        lock["languages"][language] = entry
        lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        print(language, entry["state"], entry.get("error", ""), flush=True)


if __name__ == "__main__":
    main()
