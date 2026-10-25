"""Forge private Serena symbol editor.

Runs inside an owned Windows job against a private captured project copy.
Serena 1.7.0's own LanguageServerCodeEditor performs replace_body,
insert_before, insert_after or safe_delete on that copy; Forge compares the
copy with its capture and journals the differences itself. SERENA_HOME points
into the owned directory, so Serena's user home is never written.
"""
import hashlib
import importlib.metadata
import json
import logging
import os
import sys
from collections import defaultdict
from pathlib import Path

PROTOCOL = "forge-serena-edit-v1"
SERENA_VERSION = "1.7.0"
OPERATIONS = ("replace_body", "insert_before", "insert_after", "safe_delete")


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
    if request.get("operation") not in OPERATIONS:
        raise SystemExit("Unsupported Serena symbol edit operation")
    version = importlib.metadata.version("serena-agent")
    if version != SERENA_VERSION:
        raise SystemExit(f"Serena {SERENA_VERSION} is required; found {version}")
    root = Path(request["project"]).resolve(strict=True)
    owned = Path(request["owned"]).resolve(strict=True)
    if not root.is_relative_to(owned):
        raise SystemExit("Private project is outside the owned analysis directory")
    home = Path(os.environ.get("SERENA_HOME", "")).resolve()
    if not home.is_relative_to(owned):
        raise SystemExit("SERENA_HOME must be inside the owned analysis directory")
    target = (root / request["file"]).resolve(strict=True)
    if not target.is_relative_to(root) or not target.is_file():
        raise SystemExit("Symbol edit target is outside the captured project")

    from serena.code_editor import LanguageServerCodeEditor
    from serena.config.serena_config import ProjectConfig, SerenaConfig
    from serena.ls_manager import LanguageServerFactory
    from serena.project import Project
    from serena.symbol import LanguageServerSymbolRetriever
    from solidlsp.ls import SolidLanguageServer
    from solidlsp.ls_config import LanguageServerConfig, LanguageServerId
    from solidlsp.settings import SolidLSPSettings

    language = LanguageServerId(request["language"])
    java = request.get("java")
    if java is not None and request["language"] != "java":
        raise SystemExit("Java settings are only valid for Java")
    if java is not None:
        settings = SolidLSPSettings(solidlsp_dir=str(owned / "solidlsp"), project_data_path=str(owned / "lsp-state"),
                                    ls_specific_settings={LanguageServerId.JAVA: {key: java[key] for key in ("jdtls_path", "lombok_path", "java_home", "jdtls_xmx")}})
        resources = Path(java["jdtls_path"]).parent
    elif request.get("owned_language") is not None:
        # Language servers Forge installed with Serena's pinned installers into
        # its owned directory; refuse anything that differs from the lock.
        spec = request["owned_language"]
        version_key = {"cpp": "clangd_version", "bash": "bash_language_server_version", "php": "intelephense_version", "kotlin": "kotlin_lsp_version"}.get(request["language"])
        custom = {language: {version_key: spec["version"]}} if version_key and spec.get("version") else {}
        if request["language"] == "php_phpantom":
            executable = Path(spec["home"]) / "language_servers/static/PHPantomServer/phpantom-lsp/phpantom_lsp.exe"
            if "PHPantomServer" not in spec["resource_dirs"] or not executable.is_file():
                raise SystemExit("Pinned PHPantom executable is missing; install php_phpantom first")
            custom = {language: {"ls_path": str(executable.resolve(strict=True))}}
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

    # Start the language server exactly like the shared rename helper does.
    def create_language_server(self, ls_id):
        server = SolidLanguageServer.create(
            LanguageServerConfig(ls_id=ls_id, ignored_paths=["**/node_modules/**"]),
            self.project_root, timeout=float(request["request_timeout"]), solidlsp_settings=settings,
        )
        if request['language'] == 'kotlin':
            server.server.on_notification('intellij/workspaceImportState', lambda p: server._intellij_server_ready.set() if p.get('phase') == 'FINISHED' else None)
        return server
    LanguageServerFactory.create_language_server = create_language_server

    # Serena writes with one configured line ending. Keep the target file's own
    # convention; a file mixing conventions would be rewritten, so it is refused.
    from serena.config.serena_config import LineEnding
    raw = target.read_bytes()
    crlf = raw.count(b"\r\n")
    lf = raw.count(b"\n") - crlf
    if (crlf and lf) or b"\r" in raw.replace(b"\r\n", b""):
        raise SystemExit("Serena symbol edits require one consistent line ending in the target file")
    line_ending = LineEnding.CRLF if crlf else LineEnding.LF
    if "body" in request:
        request["body"] = request["body"].replace("\r\n", "\n")
    project = Project(project_root=str(root), project_config=ProjectConfig(project_name="forge-private", language_servers=[language], line_ending=line_ending),
                      serena_config=SerenaConfig(line_ending=line_ending))
    manager = project.create_language_server_manager()
    relative = Path(request["file"]).as_posix()
    status, message = "applied", ""
    try:
        retriever = LanguageServerSymbolRetriever(project)
        editor = LanguageServerCodeEditor(retriever)
        operation, name_path = request["operation"], request["name_path"]
        if operation == "replace_body":
            editor.replace_body(name_path, relative_file_path=relative, body=request["body"])
        elif operation == "insert_before":
            editor.insert_before_symbol(name_path, relative_file_path=relative, body=request["body"])
        elif operation == "insert_after":
            editor.insert_after_symbol(name_path, relative_file_path=relative, body=request["body"])
        else:
            # Same rule as Serena's SafeDeleteSymbol tool: refuse while referenced.
            symbol = retriever.find_unique(name_path, substring_matching=False, within_relative_path=relative)
            if symbol.relative_path != relative or symbol.line is None or symbol.column is None:
                raise SystemExit("Serena could not locate the symbol identifier in the requested file")
            server = retriever.get_language_server(relative)
            references = server.request_references(relative, symbol.line, symbol.column) or []
            lines: dict[str, list[int]] = defaultdict(list)
            for reference in references:
                path = reference.get("relativePath")
                if path is not None:
                    lines[path].append(reference["range"]["start"]["line"] + 1)
            if lines:
                status, message = "refused", "symbol is referenced in " + json.dumps(lines, sort_keys=True)
            else:
                editor.delete_symbol(symbol.get_name_path(), relative_file_path=relative)
    finally:
        manager.stop_all()
    result = Path(request["result"])
    if result.parent.resolve() != owned:
        raise SystemExit("Result path is outside the owned analysis directory")
    after = tree_pins(resources)
    changed = sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))
    result.write_text(json.dumps({
        "protocol": PROTOCOL, "serena_version": version, "language": request["language"],
        "status": status, "message": message,
        "prerequisites_unchanged": not changed,
        "changed_prerequisites": changed[:12],
        "python": sys.version.split()[0], "pid": os.getpid(),
        "helper_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
