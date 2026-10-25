"""One read request through Serena's real tools, within Forge's owned job/model."""
import asyncio
import hashlib
import importlib.metadata
import json
import os
import sys
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    req = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    if req['protocol'] != 'forge-serena-query-v1' or req['language'] != 'kotlin':
        raise ValueError('Invalid private query')
    owned = Path(req['owned']).resolve(strict=True)
    project = Path(req['project']).resolve(strict=True)
    if not project.is_relative_to(owned):
        raise ValueError('Query project is outside the owned run')
    reader = Path(req['reader_path'])
    if hashlib.sha256(reader.read_bytes()).hexdigest() != req['reader_sha256']:
        raise ValueError('Reader adapter changed')
    pin = req['owned_language']
    lock = owned/'reader-lock.json'
    lock.write_text(json.dumps({'languages': {'kotlin': {**pin, 'state': 'installed'}}}), encoding='utf-8')
    # Explicitly constrain Serena to Kotlin. It must not install other servers
    # when the same source set also contains Java or cached dependency metadata.
    config_dir = project/'.serena'
    config_dir.mkdir(exist_ok=True)
    (config_dir/'project.yml').write_text('project_name: forge-kotlin-private\nlanguages:\n- kotlin\n', encoding='utf-8')
    env = {**os.environ, 'FORGE_SERENA_PRIVATE_CACHE': str(owned/'read-cache'), 'FORGE_SERENA_REQUEST_TIMEOUT': str(req['request_timeout'])}
    params = StdioServerParameters(command=sys.executable, args=[
        '-I', '-B', str(reader), pin['home'], str(lock), 'start-mcp-server',
        '--transport', 'stdio', '--context', 'desktop-app', '--project', str(project),
        '--add-mode', str(Path(__file__).with_name('forge-serena-diagnostics.yml')),
        '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false', '--enable-gui-log-window', 'false',
    ], env=env, cwd=str(project))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            response = await session.call_tool(req['tool'], arguments=req['args'])
            if response.isError:
                raise ValueError(str(response.content)[:2000])
            content = '\n'.join(item.text for item in response.content if item.type == 'text')
    if hashlib.sha256(reader.read_bytes()).hexdigest() != req['reader_sha256']:
        raise ValueError('Reader adapter changed during query')
    for name, expected in pin['resource_dirs'].items():
        base = Path(pin['home'])/'language_servers'/'static'/name
        digest = hashlib.sha256()
        for file in sorted(p for p in base.rglob('*') if p.is_file()):
            digest.update(file.relative_to(base).as_posix().encode()+b'\0'+hashlib.sha256(file.read_bytes()).digest())
        if digest.hexdigest() != expected['sha256']:
            raise ValueError('Kotlin prerequisites changed during query')
    result = Path(req['result'])
    if result.parent.resolve() != owned:
        raise ValueError('Result leaves owned run')
    result.write_text(json.dumps({
        'protocol': req['protocol'], 'serena_version': importlib.metadata.version('serena-agent'),
        'language': 'kotlin', 'content': content, 'prerequisites_unchanged': True,
        'helper_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }), encoding='utf-8')

asyncio.run(main())
