"""Forge private Serena rename planner.

Runs inside an owned Windows job against a private captured project copy. It
only calls Serena 1.7.0's read-only SolidLSP requests; it never applies a
WorkspaceEdit. Forge validates and journals the plan itself.
"""
import hashlib
import importlib.metadata
import json
import logging
import os
import sys
from pathlib import Path

PROTOCOL = "forge-serena-rename-v1"
SERENA_VERSION = "1.7.0"


def tree_pins(root: Path) -> dict[str, list[int]]:
    pins: dict[str, list[int]] = {}
    if not root.exists():
        return pins
    for path in sorted(root.rglob("*")):
        if path.is_file():
            info = path.stat()
            pins[path.relative_to(root).as_posix()] = [info.st_size, info.st_mtime_ns]
    return pins

def tree_digest(root: Path) -> dict:
    """Same digest as install-languages.py: relative path + content hash of every file."""
    h = hashlib.sha256()
    files = 0
    size = 0
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        data = path.read_bytes()
        h.update(path.relative_to(root).as_posix().encode() + b"\0" + hashlib.sha256(data).digest())
        files += 1
        size += len(data)
    return {"sha256": h.hexdigest(), "files": files, "bytes": size}


def main() -> None:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if request.get("protocol") != PROTOCOL:
        raise SystemExit("Unsupported Forge Serena request protocol")
    version = importlib.metadata.version("serena-agent")
    if version != SERENA_VERSION:
        raise SystemExit(f"Serena {SERENA_VERSION} is required; found {version}")
    from solidlsp.ls import SolidLanguageServer
    from solidlsp.ls_config import LanguageServerConfig, LanguageServerId
    from solidlsp.settings import SolidLSPSettings

    root = Path(request["project"]).resolve(strict=True)
    owned = Path(request["owned"]).resolve(strict=True)
    if not root.is_relative_to(owned):
        raise SystemExit("Private project is outside the owned analysis directory")
    target = (root / request["file"]).resolve(strict=True)
    if not target.is_relative_to(root) or not target.is_file():
        raise SystemExit("Rename target is outside the captured project")
    java = request.get("java")
    if java is not None:
        # Upstream JDT LS mode on Forge's private install: no downloads, and
        # every writable JDT LS location is under the owned run directory.
        if request["language"] != "java":
            raise SystemExit("Java settings are only valid for Java")
        settings = SolidLSPSettings(solidlsp_dir=str(owned / "solidlsp"), project_data_path=str(owned / "lsp-state"),
                                    ls_specific_settings={LanguageServerId.JAVA: {key: java[key] for key in ("jdtls_path", "lombok_path", "java_home", "jdtls_xmx")}})
        resources = Path(java["jdtls_path"]).parent
    elif request.get("owned_language") is not None:
        # Language servers Forge installed with Serena's pinned installers into
        # its owned directory; refuse anything that differs from the lock.
        spec = request["owned_language"]
        version_key = {"cpp": "clangd_version", "bash": "bash_language_server_version", "php": "intelephense_version", "kotlin": "kotlin_lsp_version"}.get(request["language"])
        custom = {LanguageServerId(request["language"]): {version_key: spec["version"]}} if version_key and spec.get("version") else {}
        if request["language"] == "php_phpantom":
            # Never resolve a different binary on PATH or download during analysis.
            executable = Path(spec["home"]) / "language_servers/static/PHPantomServer/phpantom-lsp/phpantom_lsp.exe"
            if "PHPantomServer" not in spec["resource_dirs"] or not executable.is_file():
                raise SystemExit("Pinned PHPantom executable is missing; install php_phpantom first")
            custom = {LanguageServerId.PHP_PHPANTOM: {"ls_path": str(executable.resolve(strict=True))}}
        settings = SolidLSPSettings(solidlsp_dir=str(Path(spec["home"]).resolve(strict=True)), project_data_path=str(owned / "lsp-state"), ls_specific_settings=custom)
        resources = Path(settings.ls_resources_dir)
        for name, pin in spec["resource_dirs"].items():
            if tree_digest(resources / name) != pin:
                raise SystemExit(f"Installed language server {name} does not match its pinned digest")
        if request["language"] == "lua":
            # lua-language-server writes logs and meta files beside its binary by
            # default. Launch the verified binary through a private launcher that
            # keeps them in the owned run directory (Serena resolves it via PATH).
            lua_dirs = [d for d in spec["resource_dirs"] if (resources / d).is_dir()]
            exe = next((resources / d / sub / "lua-language-server.exe" for d in lua_dirs for sub in ("bin", "lua/bin") if (resources / d / sub / "lua-language-server.exe").is_file()), None)
            if exe is None:
                raise SystemExit("Pinned lua-language-server binary not found")
            launcher = owned / "lua-launcher"
            launcher.mkdir()
            (launcher / "lua-language-server.cmd").write_text(
                '@"' + str(exe) + '" --logpath="' + str(owned / "lua-log") + '" --metapath="' + str(owned / "lua-meta") + '" %*\r\n',
                encoding="utf-8")
            os.environ["PATH"] = str(launcher) + os.pathsep + os.environ.get("PATH", "")
    else:
        settings = SolidLSPSettings(project_data_path=str(owned / "lsp-state"))
        resources = Path(settings.ls_resources_dir)
    before = tree_pins(resources)
    server = SolidLanguageServer.create(
        LanguageServerConfig(ls_id=LanguageServerId(request["language"]), ignored_paths=["**/node_modules/**"]),
        str(root), timeout=float(request["request_timeout"]), solidlsp_settings=settings,
    )
    line, column = request["line"] - 1, request["column"] - 1
    if request['language'] == 'kotlin':
        server.server.on_notification('intellij/workspaceImportState', lambda p: server._intellij_server_ready.set() if p.get('phase') == 'FINISHED' else None)
    try:
        server.start()
        # Startup success is not indexing readiness. A references request waits
        # for cross-file analysis; then two rename plans must agree exactly.
        references = server.request_references(request["file"], line, column)
        first = server.request_rename_symbol_edit(request["file"], line, column, request["new_name"])
        second = server.request_rename_symbol_edit(request["file"], line, column, request["new_name"])
    finally:
        server.stop()
    result = Path(request["result"])
    if result.parent.resolve() != owned:
        raise SystemExit("Result path is outside the owned analysis directory")
    result.write_text(json.dumps({
        "protocol": PROTOCOL, "serena_version": version, "language": request["language"],
        "references": [{"uri": item.get("uri"), "range": item.get("range")} for item in references or []],
        "plans": [first, second],
        "prerequisites_unchanged": tree_pins(resources) == before,
        "python": sys.version.split()[0], "pid": os.getpid(),
        "helper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
