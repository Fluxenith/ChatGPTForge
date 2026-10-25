"""Install an upstream Serena backend in a separate home and probe a copied source.
Only invoked by the local installation CLI, never by normal analysis.
"""
import json
import sys
from pathlib import Path
from solidlsp.ls import SolidLanguageServer
from solidlsp.ls_config import LanguageServerConfig, LanguageServerId
from solidlsp.settings import SolidLSPSettings

home, project, name, target, result, *options = sys.argv[1:]
version = options[0] if options else None
language = LanguageServerId(name)
custom = {}
if version:
    if name != 'kotlin':
        raise ValueError('Explicit installer version currently supported only for Kotlin')
    import re, urllib.request, hashlib, zipfile, io
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid Kotlin version')
    url = f'https://download.jetbrains.com/language-server/kotlin-server/{version}/kotlin-server-{version}.win.zip'
    expected = urllib.request.urlopen(url+'.sha256', timeout=30).read().decode().split()[0]
    if not re.fullmatch(r'[a-fA-F0-9]{64}', expected):
        raise ValueError('Invalid official Kotlin checksum')
    data = urllib.request.urlopen(url, timeout=180).read()
    if hashlib.sha256(data).hexdigest() != expected.lower():
        raise ValueError('Kotlin archive differs from official checksum')
    destination = Path(home)/'language_servers'/'static'/'KotlinLanguageServer'/f'kotlin_language_server-{version}'
    destination.mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for item in archive.infolist():
            if not (destination/item.filename).resolve().is_relative_to(destination.resolve()) or ((item.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError('Unsafe Kotlin archive member')
        archive.extractall(destination)
    custom = {language: {'kotlin_lsp_version': version}}
settings = SolidLSPSettings(solidlsp_dir=home, project_data_path=str(Path(home) / "probe-state"),ls_specific_settings=custom)
server = SolidLanguageServer.create(LanguageServerConfig(ls_id=language), project, timeout=180.0, solidlsp_settings=settings)
try:
    server.start()
    symbols = server.request_document_symbols(target)
    count = len(symbols.get_all_symbols_and_roots()[0])
    if not count:
        raise RuntimeError("The supplied source produced no symbols; backend not registered")
finally:
    server.stop()
dirs = sorted(p.name for p in Path(settings.ls_resources_dir).iterdir() if p.is_dir())
if not dirs:
    raise RuntimeError("Backend uses external prerequisites; package them with a reviewed adapter before registration")
Path(result).write_text(json.dumps({"directories": dirs, "symbols": count}), encoding="utf-8")
