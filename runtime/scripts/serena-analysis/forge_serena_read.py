"""Use Forge's installed Kotlin pin for read tools as well as private edits."""
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from solidlsp.ls import SolidLanguageServer
from solidlsp.ls_config import LanguageServerConfig, LanguageServerId
from solidlsp.settings import SolidLSPSettings
from serena.ls_manager import LanguageServerFactory
from serena.cli import top_level

home, lock_path, *arguments = sys.argv[1:]
lock = json.loads(Path(lock_path).read_text(encoding='utf-8'))
original = LanguageServerFactory.create_language_server

def create(self, ls_id):
    pin = lock['languages'].get('kotlin', {})
    if ls_id != LanguageServerId('kotlin') or pin.get('state') != 'installed':
        return original(self, ls_id)
    for name, expected in pin['resource_dirs'].items():
        root = Path(home)/'language_servers'/'static'/name
        h = hashlib.sha256()
        for p in sorted(x for x in root.rglob('*') if x.is_file()):
            h.update(p.relative_to(root).as_posix().encode()+b'\0'+hashlib.sha256(p.read_bytes()).digest())
        if h.hexdigest() != expected['sha256']:
            raise ValueError('Kotlin reader prerequisite differs from its pin')
    cache = Path(os.environ['FORGE_SERENA_PRIVATE_CACHE']) if os.environ.get('FORGE_SERENA_PRIVATE_CACHE') else Path(tempfile.gettempdir())/'forge-serena-kotlin-read'/hashlib.sha256(str(self.project_root).encode()).hexdigest()
    settings = SolidLSPSettings(solidlsp_dir=home,project_data_path=str(cache),ls_specific_settings={ls_id:{'kotlin_lsp_version':pin['version']}})
    timeout = min(600.0, max(30.0, float(os.environ.get('FORGE_SERENA_REQUEST_TIMEOUT', '90'))))
    server = SolidLanguageServer.create(LanguageServerConfig(ls_id=ls_id),self.project_root,timeout=timeout,solidlsp_settings=settings)
    # Current IntelliJ LSP reports the production import lifecycle; ready-for-test
    # is no longer the only completion notification. Requests still synchronize
    # with indexing in the server itself.
    server.server.on_notification('intellij/workspaceImportState', lambda p: server._intellij_server_ready.set() if p.get('phase') == 'FINISHED' else None)
    return server

LanguageServerFactory.create_language_server = create
top_level(args=arguments)
