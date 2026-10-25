"""Read environment selection from captured configuration; do not inspect or import it."""
import json
import pathlib
import posixpath
import sys


def selection(data):
    chain = data.get('pyright_chain', [])
    if chain:
        layers = [(entry['file'], entry['value']) for entry in chain]
    elif 'pyproject.toml' in data.get('configuration_texts', {}):
        import tomllib
        project = tomllib.loads(data['configuration_texts']['pyproject.toml'].removeprefix('\ufeff'))
        settings = project.get('tool', {}).get('pyright', {})
        layers = [('pyproject.toml', settings)]
    else:
        layers = []
    selected = {}
    for file, settings in layers:
        if not isinstance(settings, dict):
            raise ValueError('Python virtual environment configuration must be a table')
        for key in ('venvPath', 'venv'):
            if key in settings:
                value = settings[key]
                if not isinstance(value, str) or not value.strip() or len(value) > 512:
                    raise ValueError('Python virtual environment ' + key + ' must be a non-empty bounded path string')
                value = value.replace('\\', '/')
                if pathlib.PureWindowsPath(value).drive or value.startswith(('/', '~')) or any(c in value for c in '*?['):
                    raise ValueError('Python virtual environment paths must remain relative to the project')
                if key == 'venv':
                    if value in ('.', '..') or '/' in value:
                        raise ValueError('Python virtual environment venv must name one directory')
                    selected[key] = value
                else:
                    name = posixpath.normpath(posixpath.join(posixpath.dirname(file), value))
                    if name == '.': name = ''
                    if name == '..' or name.startswith('../') or len(name.split('/')) > 64:
                        raise ValueError('Python virtual environment path escapes the project or exceeds 64 segments')
                    selected[key] = name
    if 'venvPath' in selected and 'venv' not in selected:
        raise ValueError('Python virtual environment venvPath requires a venv name')
    return {'explicit':bool(selected), 'root':posixpath.join(selected.get('venvPath', ''), selected['venv']) if 'venv' in selected else None}


try:
    print(json.dumps({'ok':True, **selection(json.load(sys.stdin))}))
except Exception as error:
    print(json.dumps({'ok':False, 'error':'Python virtual environment configuration: ' + str(error)}))
