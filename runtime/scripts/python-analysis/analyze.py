"""Static analysis of an owned, bounded snapshot; never import project modules."""
import ast
import configparser
import fnmatch
import io
import importlib.util
import importlib.machinery
import json
import keyword
import pathlib
import posixpath
import re
from functools import lru_cache
import sys
import tokenize
import unicodedata

bundle = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(bundle))
from typing_views import DependencyViews
class SourceOnlyLoader(importlib.machinery.SourceFileLoader):
    # Bytecode caches are neither dependency pins nor an executable input.
    def get_code(self, fullname):
        filename = self.get_filename(fullname)
        return self.source_to_code(self.get_data(filename), filename)
sys.path_hooks.insert(0, importlib.machinery.FileFinder.path_hook(
    (SourceOnlyLoader, importlib.machinery.SOURCE_SUFFIXES),
    (importlib.machinery.ExtensionFileLoader, importlib.machinery.EXTENSION_SUFFIXES),
))
sys.path_importer_cache.clear()
sys.path.insert(0, str(bundle / "vendor"))
import jedi
import parso
from jedi.api.environment import InterpreterEnvironment


def import_configuration(data):
    """Interpret static import settings against the captured directory catalog."""
    known_directories = set(data.get('directories', ['']))
    for file in data.get('sources', {}):
        known_directories.update(str(parent) for parent in pathlib.PurePosixPath(file).parents if str(parent) != '.')
    directories = {path.casefold(): path for path in sorted(known_directories)}
    links = [path.casefold() for path in data.get('skipped_links', [])]
    blocked = {'.git', 'node_modules', '.venv', 'venv', 'site-packages', '__pycache__',
               'dist', 'build', 'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache'}
    def paths(value, file, allow_glob=False):
        if not isinstance(value, str):
            raise ValueError('Python configuration import path must be a string')
        if not value.strip():
            value = '.'
        value = value.replace('\\', '/')
        if pathlib.PureWindowsPath(value).drive or value.startswith(('/', '~')):
            raise ValueError('Python configuration import path must remain relative to the project')
        name = posixpath.normpath(posixpath.join(posixpath.dirname(file), value))
        if name == '.': name = ''
        if name == '..' or name.startswith('../') or any(part.casefold() in blocked for part in name.split('/')):
            raise ValueError('Python configuration import path escapes the project or enters an excluded directory')
        key = name.casefold()
        if any(key == link or key.startswith(link + '/') for link in links):
            raise ValueError('Python configuration import path contains a skipped link')
        if any(char in name for char in '*?['):
            if not allow_glob:
                raise ValueError('Python configuration package/environment roots cannot contain glob patterns')
            # Match one directory segment at a time; ** may span zero or more.
            parts = key.split('/')
            def matches(pattern, path):
                if not pattern: return not path
                if pattern[0] == '**':
                    return matches(pattern[1:], path) or bool(path) and matches(pattern, path[1:])
                return bool(path) and fnmatch.fnmatchcase(path[0], pattern[0]) and matches(pattern[1:], path[1:])
            if any(matches(parts[:size], link.split('/')) for link in links for size in range(1, len(parts) + 1)):
                raise ValueError('Python configuration import path glob may traverse a skipped link')
            found = [actual for lower, actual in sorted(directories.items()) if matches(parts, lower.split('/') if lower else [])]
            if not found: raise ValueError('Python configuration import path glob matches no captured directories')
            return found
        if key not in directories:
            raise ValueError('Python configuration import path is missing or excluded: ' + name)
        return [directories[key]]
    def array(value, label):
        if not isinstance(value, list) or len(value) > 32:
            raise ValueError('Python configuration ' + label + ' must be an array of at most 32 entries')
        return value
    def unique(items):
        result = list(dict.fromkeys(items))
        if len(result) > 32: raise ValueError('Python configuration exceeds 32 import roots per environment')
        return result
    raw = data.get('configuration_texts', {})
    package_roots, pyproject = [], {}
    if 'pyproject.toml' in raw:
        try:
            import tomllib
        except ImportError:
            raise ValueError('Python 3.11 or later is required to parse pyproject.toml import configuration')
        try:
            pyproject = tomllib.loads(raw['pyproject.toml'].removeprefix('\ufeff'))
        except ValueError as error:
            raise ValueError('Invalid Python configuration pyproject.toml: ' + str(error))
        if not isinstance(pyproject.get('tool', {}), dict): raise ValueError('Invalid Python configuration tool table')
        setuptools = pyproject.get('tool', {}).get('setuptools', {})
        if not isinstance(setuptools, dict): raise ValueError('Invalid Python configuration setuptools table')
        mapping = setuptools.get('package-dir', {})
        if not isinstance(mapping, dict) or any(name != '' for name in mapping):
            raise ValueError('Python configuration supports a common setuptools package-dir root, not named package remapping')
        if '' in mapping: package_roots.extend(paths(mapping[''], 'pyproject.toml'))
        packages = setuptools.get('packages', {})
        if isinstance(packages, dict) and 'find' in packages:
            if not isinstance(packages['find'], dict): raise ValueError('Invalid Python configuration setuptools find table')
            for value in array(packages['find'].get('where', ['.']), 'setuptools find.where'):
                package_roots.extend(paths(value, 'pyproject.toml'))
    if 'setup.cfg' in raw:
        config = configparser.ConfigParser(interpolation=None)
        config.read_string(raw['setup.cfg'].removeprefix('\ufeff'))
        if config.has_option('options', 'package_dir'):
            for row in config.get('options', 'package_dir').splitlines():
                if not row.strip(): continue
                key, separator, value = row.partition('=')
                if not separator or key.strip():
                    raise ValueError('Python configuration supports only the common setup.cfg package_dir root')
                package_roots.extend(paths(value.strip(), 'setup.cfg'))
        if config.has_option('options.packages.find', 'where'):
            for value in config.get('options.packages.find', 'where').splitlines():
                if value.strip(): package_roots.extend(paths(value.strip(), 'setup.cfg'))
    package_roots = unique(package_roots)
    chain = data.get('pyright_chain', [])
    if chain:
        layers = [(entry['file'], entry['value']) for entry in chain]
    elif 'pyright' in pyproject.get('tool', {}):
        layers = [('pyproject.toml', pyproject['tool']['pyright'])]
        if 'extends' in layers[0][1]:
            raise ValueError('Python configuration TOML extends is not supported; use an internal JSON inheritance chain')
    else:
        layers = []
    def source_specs(value, file):
        if not isinstance(value, list) or len(value) > 256:
            raise ValueError('Python configuration source filters require at most 256 paths')
        result = []
        for path in value:
            if not isinstance(path, str) or len(path) > 512:
                raise ValueError('Python configuration source filter must be a path string of at most 512 characters')
            path = path.replace('\\', '/')
            if pathlib.PureWindowsPath(path).drive or path.startswith(('/', '~')):
                raise ValueError('Python configuration source filter must remain relative to the project')
            name = posixpath.normpath(posixpath.join(posixpath.dirname(file), path or '.'))
            if name == '.': name = ''
            if name == '..' or name.startswith('../') or len(name.split('/')) > 64:
                raise ValueError('Python configuration source filter escapes the project or exceeds 64 segments')
            result.append({'file':file, 'pattern':name})
        return result
    # Resolve path-bearing options against captured directories. The checker
    # receives only the private project snapshot, never the original path.
    # Rule and boolean names are the DiagnosticRule set of the pinned Pyright
    # 1.1.414 (reportShadowedImports and path/file options are excluded).
    checker_bools = {
        'analyzeUnannotatedFunctions', 'deprecateTypingAliases', 'disableBytesTypePromotions',
        'enableExperimentalFeatures', 'enableReachabilityAnalysis', 'enableTypeIgnoreComments',
        'strictDictionaryInference', 'strictParameterNoneValue', 'strictSetInference',
        'useLibraryCodeForTypes'}
    checker_reports = {
        'reportAbstractUsage', 'reportArgumentType', 'reportAssertAlwaysTrue',
        'reportAssertTypeFailure', 'reportAssignmentType', 'reportAttributeAccessIssue',
        'reportCallInDefaultInitializer', 'reportCallIssue', 'reportConstantRedefinition',
        'reportDeprecated', 'reportDuplicateImport', 'reportFunctionMemberAccess',
        'reportGeneralTypeIssues', 'reportImplicitOverride',
        'reportImplicitStringConcatenation', 'reportImportCycles',
        'reportIncompatibleMethodOverride', 'reportIncompatibleVariableOverride',
        'reportIncompleteStub', 'reportInconsistentConstructor', 'reportInconsistentOverload',
        'reportIndexIssue', 'reportInvalidStringEscapeSequence', 'reportInvalidStubStatement',
        'reportInvalidTypeArguments', 'reportInvalidTypeForm', 'reportInvalidTypeVarUse',
        'reportMatchNotExhaustive', 'reportMissingImports', 'reportMissingModuleSource',
        'reportMissingParameterType', 'reportMissingSuperCall', 'reportMissingTypeArgument',
        'reportMissingTypeStubs', 'reportNoOverloadImplementation', 'reportOperatorIssue',
        'reportOptionalCall', 'reportOptionalContextManager', 'reportOptionalIterable',
        'reportOptionalMemberAccess', 'reportOptionalOperand', 'reportOptionalSubscript',
        'reportOverlappingOverload', 'reportPossiblyUnboundVariable',
        'reportPrivateImportUsage', 'reportPrivateUsage', 'reportPropertyTypeMismatch',
        'reportRedeclaration', 'reportReturnType', 'reportSelfClsParameterName',
        'reportTypeCommentUsage', 'reportTypedDictNotRequiredAccess', 'reportUnboundVariable',
        'reportUndefinedVariable', 'reportUnhashable', 'reportUninitializedInstanceVariable',
        'reportUnknownArgumentType', 'reportUnknownLambdaType', 'reportUnknownMemberType',
        'reportUnknownParameterType', 'reportUnknownVariableType', 'reportUnnecessaryCast',
        'reportUnnecessaryComparison', 'reportUnnecessaryContains',
        'reportUnnecessaryIsInstance', 'reportUnnecessaryTypeIgnoreComment',
        'reportUnreachable', 'reportUnsupportedDunderAll', 'reportUntypedBaseClass',
        'reportUntypedClassDecorator', 'reportUntypedFunctionDecorator',
        'reportUntypedNamedTuple', 'reportUnusedCallResult', 'reportUnusedClass',
        'reportUnusedCoroutine', 'reportUnusedExcept', 'reportUnusedExpression',
        'reportUnusedFunction', 'reportUnusedImport', 'reportUnusedVariable',
        'reportWildcardImportFromLibrary'}
    checker_keys = {'typeCheckingMode', 'pythonVersion', 'pythonPlatform'} | checker_bools | checker_reports
    checker_options = {}
    extra, environments, ignored, include, exclude = [], [], set(), None, []
    stub_path = None
    for file, settings in layers:
        if not isinstance(settings, dict): raise ValueError('Python configuration settings must be a table')
        ignored.update(key for key in settings if key not in {'extends', 'extraPaths', 'executionEnvironments', 'include', 'exclude', 'venv', 'venvPath', 'stubPath'} | checker_keys)
        for name in checker_keys & settings.keys():
            value = settings[name]
            if name == 'typeCheckingMode':
                if value not in ('off', 'basic', 'standard', 'strict', 'all'):
                    raise ValueError('Python typeCheckingMode must be off, basic, standard, strict or all')
            elif name == 'pythonVersion':
                if not isinstance(value, str) or not re.fullmatch(r'3\.(?:[3-9]|1[0-9])', value):
                    raise ValueError('Invalid Python pythonVersion')
            elif name == 'pythonPlatform':
                if value not in ('Windows', 'Linux', 'Darwin', 'All'):
                    raise ValueError('Invalid Python pythonPlatform')
            elif name in checker_bools:
                if type(value) is not bool:
                    raise ValueError('Invalid Python type checker boolean setting: ' + name)
            elif not (type(value) is bool or value in ('none', 'information', 'warning', 'error')):
                raise ValueError('Invalid Python type checker diagnostic setting: ' + name)
            checker_options[name] = value
        if 'include' in settings: include = source_specs(settings['include'], file)
        if 'exclude' in settings: exclude = source_specs(settings['exclude'], file)
        if 'stubPath' in settings: stub_path = paths(settings['stubPath'], file)[0]
        if 'extraPaths' in settings:
            extra = unique([path for value in array(settings['extraPaths'], 'extraPaths') for path in paths(value, file, True)])
        if 'executionEnvironments' in settings:
            environments = []
            for setting in array(settings['executionEnvironments'], 'executionEnvironments'):
                if not isinstance(setting, dict) or 'root' not in setting:
                    raise ValueError('Python configuration execution environment requires a root')
                env_root = paths(setting['root'], file)[0]
                env_extra = None if 'extraPaths' not in setting else unique([path for value in array(setting['extraPaths'], 'environment extraPaths') for path in paths(value, file, True)])
                env_checker = {}
                if 'pythonVersion' in setting:
                    value = setting['pythonVersion']
                    if not isinstance(value, str) or not re.fullmatch(r'3\.(?:[3-9]|1[0-9])', value):
                        raise ValueError('Invalid Python execution environment pythonVersion')
                    env_checker['python_version'] = value
                if 'pythonPlatform' in setting:
                    value = setting['pythonPlatform']
                    if value not in ('Windows', 'Linux', 'Darwin', 'All'):
                        raise ValueError('Invalid Python execution environment pythonPlatform')
                    env_checker['python_platform'] = value
                environments.append((env_root, env_extra, env_checker))
                ignored.update('executionEnvironments.' + key for key in setting if key not in {'root', 'extraPaths', 'pythonVersion', 'pythonPlatform'})
    stub_roots = [stub_path] if stub_path is not None else []
    default_roots = unique(stub_roots + [''] + extra + package_roots + (['src'] if 'src' in directories else []))
    result_envs = [{'root':env_root,'import_roots':unique(stub_roots + [env_root] + (extra if env_extra is None else env_extra) + package_roots),**env_checker} for env_root, env_extra, env_checker in environments]
    if len({path for item in result_envs for path in item['import_roots']} | set(default_roots)) > 128:
        raise ValueError('Python configuration exceeds 128 distinct import roots')
    return {'default_roots':default_roots, 'package_roots':package_roots,'stub_path':stub_path,
            'execution_environments':result_envs,'ignored_options':sorted(ignored),
            'config_source':layers[-1][0] if layers else None,
            'checker_options':checker_options,
            'source_filters':{'include':include or [{'file':'', 'pattern':''}], 'exclude':exclude,
                              'default_exclude_hidden':True}}


def analyze(data):
    root = pathlib.Path(data["snapshot_root"]).resolve()
    sources = data["sources"]
    query = data["query"]
    settings = import_configuration(data)
    dependency_files = set(data.get('dependency_files', []))
    dependency_roots = data.get('dependency_roots', [])
    settings['dependency_roots'] = dependency_roots
    path_roots = data.get('project_path_roots', [])
    settings['default_roots'] = list(dict.fromkeys(settings['default_roots'] + dependency_roots + path_roots))
    for item in settings['execution_environments']:
        item['import_roots'] = list(dict.fromkeys(item['import_roots'] + dependency_roots + path_roots))
    def read_only(file):
        return file in dependency_files or file.lower().endswith('.pyi')
    def import_roots(file):
        for item in settings['execution_environments']:
            folder = item['root']
            if not folder or file.casefold().startswith(folder.casefold() + '/'):
                return item['import_roots']
        return settings['default_roots']
    all_source_names = set(sources) | set(data.get('opaque_sources', []))
    captured_paths = {(root/file).resolve() for file in all_source_names}
    views = DependencyViews(root, dependency_files, dependency_roots, data.get('typed_markers', []))
    captured_paths.update(views.origins)
    settings['stub_packages'] = views.packages[:100]
    settings['stub_packages_total'] = len(views.packages)
    settings['stub_packages_truncated'] = len(views.packages) > 100
    class SnapshotFinder:
        # Jedi asks finders for a short child name, even for packages. Prefer a
        # captured source to a Windows builtin of the same name. Returning a
        # source spec lets Jedi parse it; project paths never enter sys.path.
        def find_spec(self, fullname, path=None, target=None):
            if path is None:
                return None
            for folder in path:
                for suffix in (fullname + '.pyi', fullname + '/__init__.pyi', fullname + '.py', fullname + '/__init__.py'):
                    candidate = (pathlib.Path(folder)/suffix).resolve()
                    if candidate in captured_paths:
                        return importlib.util.spec_from_file_location(fullname, candidate, loader=SourceOnlyLoader(fullname, str(candidate)), submodule_search_locations=[str(candidate.parent)] if candidate.name.lower().startswith('__init__.') else None)
            return None
    sys.meta_path.insert(0, SnapshotFinder())
    from jedi.inference import imports as jedi_imports
    original_module_loader = jedi_imports._load_python_module
    project_paths = {(root/file).resolve() for file in data.get('project_sources', [])}
    project_directories = {parent for path in project_paths for parent in path.parents if parent.is_relative_to(root)}
    def load_captured_stub(inference_state, file_io, import_names=None, is_package=False):
        path = pathlib.Path(file_io.path).resolve()
        if path.suffix.lower() == '.pyi' and path in captured_paths:
            # A source finder can expose a stub before Jedi's normal stub lookup.
            # Use its pinned stub constructor so namespace children retain the
            # expected stub context instead of an ordinary ModuleValue.
            module = jedi_imports.load_module_from_path(inference_state, file_io,
                import_names=import_names, is_package=is_package)
        else:
            module = original_module_loader(inference_state, file_io,
                import_names=import_names, is_package=is_package)
        if path in views.origins and is_package and import_names:
            namespace_paths = []
            for folder in inference_state.get_sys_path():
                candidate = pathlib.Path(folder).joinpath(*import_names).resolve()
                if candidate in project_directories and not any(
                    candidate / name in project_paths for name in ('__init__.py','__init__.pyi')):
                    namespace_paths.append(str(candidate))
            combined = list(dict.fromkeys(namespace_paths + (module.py__path__() or [])))
            module.py__path__ = lambda: combined
        return module
    jedi_imports._load_python_module = load_captured_stub
    environment = InterpreterEnvironment()
    jedi.settings.cache_directory = str(root.parent / "cache")
    jedi.settings.auto_import_modules = []
    scripts, projects = {}, {}
    def script(file):
        if file not in scripts:
            roots = tuple(views.backend_roots(import_roots(file), file))
            if roots not in projects:
                projects[roots] = jedi.Project(str(root), sys_path=list(roots),
                                              smart_sys_path=False, load_unsafe_extensions=False)
            scripts[file] = jedi.Script(
                code=sources[file].removeprefix("\ufeff"),
                path=str(views.source_path(file)), project=projects[roots],
                environment=environment,
            )
        return scripts[file]

    all_sources = sources
    modules = {}
    all_roots = set(settings['default_roots']) | {folder for item in settings['execution_environments'] for folder in item['import_roots']}
    for folder in all_roots:
        if folder in views.modules:
            modules[folder] = views.modules[folder]
            continue
        table = modules[folder] = {}
        for current in sorted(all_source_names, key=lambda name:(not name.lower().endswith('.pyi'),name)):
            if folder and not current.casefold().startswith(folder.casefold() + '/'): continue
            suffix = current[len(folder)+1:] if folder else current
            pieces = list(pathlib.PurePosixPath(suffix).with_suffix('').parts)
            if pieces[-1] == '__init__': pieces.pop()
            table.setdefault('.'.join(pieces), current)
    def module_source(current, module):
        for folder in import_roots(current):
            table = modules[folder]
            if module in table: return table[module]
            # The owned backend runs on Windows, whose source paths ignore case.
            found = next((file for name,file in table.items() if name.casefold() == module.casefold()), None)
            if found is not None: return found
            if views.blocked(folder, module): return None
            if folder not in views.modules:
                parts = module.split('.')
                for size in range(1,len(parts)):
                    parent = '.'.join(parts[:size]).casefold()
                    package = next((file for name,file in table.items() if name.casefold() == parent), None)
                    if package is not None and pathlib.PurePosixPath(package).name.lower() in {'__init__.py','__init__.pyi'}:
                        return None
        return None

    def package_parts(current):
        folders = [folder for folder in all_roots if not folder or current.casefold().startswith(folder.casefold() + '/')]
        folder = max(folders, key=len)
        return views.package_parts(folder, current)
    def import_module(current, node):
        if not node.level: return node.module or ''
        package = package_parts(current)
        if node.level > len(package): return None
        return '.'.join(package[:len(package)-node.level+1] + ([node.module] if node.module else []))
    def dependencies(current, tree):
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                module = import_module(current, node)
                if module is None: continue
                names.add(module)
                names.update('.'.join(filter(None,[module,alias.name])) for alias in node.names if alias.name != '*')
        found = set()
        for name in names:
            parts = name.split('.')
            for size in range(1,len(parts)+1):
                file = module_source(current,'.'.join(parts[:size]))
                if file is not None: found.add(file)
        return sorted(found)

    def compiled_specs(specs):
        return [tuple('**' if part == '**' else re.compile(re.escape(part).replace(r'\*','.*').replace(r'\?','.'))
                      for part in entry['pattern'].casefold().split('/') if part) for entry in specs]
    def matches(pattern, file):
        parts = tuple(file.casefold().split('/'))
        @lru_cache(maxsize=None)
        def visit(i,j):
            if i == len(pattern): return True  # A directory spec includes its descendants.
            if pattern[i] == '**': return visit(i+1,j) or j < len(parts) and visit(i,j+1)
            return j < len(parts) and pattern[i].fullmatch(parts[j]) is not None and visit(i+1,j+1)
        return visit(0,0)
    filters = settings['source_filters']
    selected_mode = query.get('files') is not None
    included, excluded = compiled_specs(filters['include']), compiled_specs(filters['exclude'])
    project_sources = set(data.get('project_sources', all_source_names-dependency_files))
    root_files = sorted(project_sources) if selected_mode else [
        file for file in sorted(project_sources)
        if not any(part.startswith('.') for part in file.split('/'))
        and any(matches(spec,file) for spec in included)
        and not any(matches(spec,file) for spec in excluded)
    ]
    if not root_files: raise ValueError('No Python analysis sources match configured source filters')
    syntax, trees, active_files = [], {}, set()
    pending = list(reversed(root_files))
    if query.get('file') in dependency_files:
        pending.append(query['file'])
    while pending:
        file = pending.pop()
        if file in active_files: continue
        if file not in all_sources: raise ValueError('Python analysis requires UTF-8 for analysis source: ' + file)
        active_files.add(file)
        try:
            trees[file] = ast.parse(all_sources[file].removeprefix('\ufeff'), filename=file)
        except SyntaxError as error:
            syntax.append({
                'file':file, 'line':error.lineno or 1,
                'column':max(0,(error.offset or 1)-1),
                'end_line':error.end_lineno or error.lineno or 1,
                'end_column':max(0,(error.end_offset or error.offset or 1)-1),
                'code':'PY_SYNTAX', 'severity':'error', 'message':error.msg,
                **({'read_only':True} if read_only(file) else {}),
            })
        else:
            pending.extend(reversed(dependencies(file,trees[file])))
    sources = {file:all_sources[file] for file in sorted(active_files)}
    if query.get('file') is not None and query['file'] not in sources:
        raise ValueError('Target is outside Python analysis sources selected by source filters; use explicit files to inspect it')
    selection = {'applied':not selected_mode, 'root_files':root_files,
                 'analysis_files':sorted(sources),
                 'excluded_files':sorted(all_source_names-set(sources)),
                 'read_only_files':sorted(file for file in sources if read_only(file)),
                 'include':filters['include'], 'exclude':filters['exclude'],
                 'default_exclude_hidden':not selected_mode}
    tokens = {}
    for file, code in sources.items():
        entries = {}
        try:
            for token in tokenize.generate_tokens(io.StringIO(code.removeprefix('\ufeff')).readline):
                if token.type == tokenize.NAME: entries[token.start] = token
        except (tokenize.TokenError, IndentationError, SyntaxError):
            pass
        tokens[file] = entries

    def location(name):
        if name.module_path is None or name.line is None: return None
        path = views.original_path(name.module_path)
        try:
            file = path.relative_to(root).as_posix()
        except ValueError:
            return {'file':'python_environment:' + name.module_name,
                    'line':name.line, 'column':name.column,
                    'end_line':name.line, 'end_column':name.column + len(name.name),
                    'name':name.name, 'kind':name.type, 'read_only':True}
        if file not in all_source_names: raise RuntimeError('Python result is outside captured sources')
        if file not in sources: return None
        token = tokens[file].get((name.line,name.column))
        if token is None: return None
        return {'file':file, 'line':token.start[0], 'column':token.start[1],
                'end_line':token.end[0], 'end_column':token.end[1],
                'name':name.name, 'kind':name.type, 'read_only':read_only(file)}

    def ast_column(current, line, byte_column):
        value = sources[current].removeprefix("\ufeff").splitlines()[line - 1]
        return len(value.encode("utf-8")[:byte_column].decode("utf-8"))

    imports, bindings, exported_names = {}, [], {}
    for current, tree in trees.items():
        for node in ast.walk(tree):
            if not isinstance(node, (ast.ImportFrom, ast.Import)):
                continue
            if isinstance(node, ast.ImportFrom):
                module = import_module(current,node)
                if module is None: continue
            else:
                module = None
            for alias in node.names:
                if alias.name == "*":
                    continue
                start = (alias.lineno, ast_column(current, alias.lineno, alias.col_offset))
                end = (alias.end_lineno, ast_column(current, alias.end_lineno, alias.end_col_offset))
                names = [token for pos, token in sorted(tokens[current].items()) if start <= pos < end]
                if not names:
                    continue
                origin, local = names[0], names[-1] if alias.asname else names[0]
                binding = {"file": current, "module": module, "export": alias.name,
                           "local": alias.asname or alias.name.split('.')[0],
                           "explicit": bool(alias.asname), "origin": origin, "token": local}
                bindings.append(binding)
                imports[(current, local.start)] = binding
                imports[(current, origin.start)] = binding

    def identity(name):
        if name.module_path is None:
            return None
        return (str(views.original_path(name.module_path)), name.line, name.column)

    # Separate occurrence identity from lexical binding identity. Conditional
    # assignments to one function local are one binding, even when Jedi goto
    # returns only that branch's declaration. Keep physical reference locations
    # distinct; aliases, globals and nested scopes must not be merged by name.
    local_binding_keys = {}
    class LocalStores(ast.NodeVisitor):
        def __init__(self):
            self.positions, self.excluded = {}, set()
        def visit_Name(self, node):
            if isinstance(node.ctx, ast.Store):
                self.positions.setdefault(node.id, []).append((node.lineno, node.col_offset))
        def visit_arg(self, node):
            self.positions.setdefault(node.arg, []).append((node.lineno, node.col_offset))
        def visit_Global(self, node):
            self.excluded.update(node.names)
        visit_Nonlocal = visit_Global
        def visit_Import(self, node):
            self.excluded.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
        def visit_ImportFrom(self, node):
            self.excluded.update(alias.asname or alias.name for alias in node.names)
        def visit_FunctionDef(self, node):
            self.excluded.add(node.name)
        visit_AsyncFunctionDef = visit_FunctionDef
        visit_ClassDef = visit_FunctionDef
        def visit_Lambda(self, node):
            pass
        visit_ListComp = visit_Lambda
        visit_SetComp = visit_Lambda
        visit_DictComp = visit_Lambda
        visit_GeneratorExp = visit_Lambda
    for current, tree in trees.items():
        path = str((root/current).resolve())
        for function in ast.walk(tree):
            if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            stores = LocalStores()
            for argument in [*function.args.posonlyargs, *function.args.args,
                             *function.args.kwonlyargs, function.args.vararg, function.args.kwarg]:
                if argument is not None: stores.visit_arg(argument)
            for statement in function.body: stores.visit(statement)
            for spelling, entries in stores.positions.items():
                if spelling in stores.excluded: continue
                positions = [(line, ast_column(current, line, column)) for line, column in entries]
                positions = [position for position in positions if position in tokens[current]]
                if not positions: continue
                canonical = (path, *min(positions))
                for position in positions: local_binding_keys[(path, *position)] = canonical

    def rename_identity(name):
        key = identity(name)
        return local_binding_keys.get(key, key)

    def local_names(binding):
        token = binding["token"]
        return [name for name in script(binding["file"]).get_references(
            token.start[0], token.start[1], include_builtins=False, scope="file"
        ) if name.module_path is not None
            and views.original_path(name.module_path) == (root / binding["file"]).resolve()
            and name.name == binding["local"]]

    def follow(name, seen=None, stop_alias=False):
        seen = set() if seen is None else seen
        key = identity(name)
        if key is None or key in seen:
            return [name]
        seen = seen | {key}
        try:
            current = views.original_path(name.module_path).relative_to(root).as_posix()
        except ValueError:
            return [name]
        binding = imports.get((current, (name.line, name.column)))
        if stop_alias and binding is not None and binding['explicit'] and (name.line,name.column) == binding['token'].start:
            return [name]
        if binding is None or binding["module"] is None:
            return [name]
        target = module_source(binding['file'], binding["module"])
        if target is None:
            return [name]
        if target not in exported_names:
            exported_names[target] = script(target).get_names(all_scopes=False, definitions=True, references=False)
        found = [n for n in exported_names[target]
                 if n.name == binding["export"]]
        return [resolved for n in found for resolved in follow(n, seen, stop_alias)] or [name]

    def rename_targets(current, start):
        binding = imports.get((current, start))
        if binding is not None and start == binding['origin'].start:
            if binding['module'] is None:
                raise ValueError('Python module/file moves are not supported by symbol rename')
            target = module_source(binding['file'], binding['module'])
            if target is not None:
                if target not in exported_names:
                    exported_names[target] = script(target).get_names(all_scopes=False, definitions=True, references=False)
                return [resolved for name in exported_names[target] if name.name == binding['export']
                        for resolved in follow(name, stop_alias=True)]
        return [resolved for name in script(current).goto(start[0],start[1],follow_imports=False)
                for resolved in follow(name, stop_alias=True)]

    def rename_keys(current, start):
        binding = imports.get((current,start))
        if binding is not None and binding['explicit'] and start == binding['token'].start:
            # Jedi goto on the alias declaration itself already follows it.
            # The AST still identifies this local binding unambiguously.
            return {(str((root/current).resolve()),*start)}
        return {rename_identity(name) for name in rename_targets(current,start) if identity(name) is not None}

    def targets(current, line, column):
        names = script(current).goto(line, column, follow_imports=False)
        followed = [result for name in names for result in follow(name)]
        if followed and len(names) == len(followed) and all(identity(a) == identity(b) for a, b in zip(names, followed)):
            resolved = script(current).goto(line, column, follow_imports=True, follow_builtin_imports=False)
            return resolved or followed
        return followed

    def references(current, line, column):
        found = script(current).get_references(line, column, include_builtins=False, scope="project")
        target_keys = {identity(name) for name in targets(current, line, column) if identity(name) is not None}
        for binding in bindings:
            if binding["module"] is None:
                continue
            token = binding["token"]
            definitions = script(binding["file"]).goto(token.start[0], token.start[1], follow_imports=False)
            if any(identity(resolved) in target_keys for name in definitions for resolved in follow(name)):
                found.extend(local_names(binding))
        if settings['execution_environments']:
            spelling = next((token.string for token in tokens[current].values() if token.start <= (line,column) < token.end), None)
            for caller in sources:
                for name in script(caller).get_names(all_scopes=True, definitions=True, references=True):
                    if name.name == spelling and name.line is not None and any(identity(target) in target_keys for target in targets(caller,name.line,name.column)):
                        found.append(name)
        return {identity(name): name for name in found}.values()
    results, changed, rename = [], {}, None
    file = query.get("file")
    action = query["action"]
    if action == "diagnostics":
        results = [item for item in syntax if file is None or item["file"] == file]
    elif action in ("outline", "symbols"):
        for current in ([file] if action == "outline" else sorted(sources)):
            for name in script(current).get_names(all_scopes=True, definitions=True, references=False):
                if action == "symbols" and query["query"].casefold() not in name.name.casefold():
                    continue
                item = location(name)
                if item is not None:
                    parent = name.parent()
                    item["parent"] = parent.name if parent is not None else ""
                    results.append(item)
    elif action == "definition":
        results = [
            item for name in targets(file, query["line"], query["python_column"])
            if (item := location(name)) is not None
        ]
    elif action == "references":
        for name in references(file, query["line"], query["python_column"]):
            item = location(name)
            if item is not None:
                item["is_definition"] = name.is_definition()
                results.append(item)
    elif action == "rename_preview":
        if read_only(file):
            raise ValueError('Python rename refuses a read-only dependency or stub target')
        new_name = query.get("new_name", "")
        if not new_name.isidentifier() or keyword.iskeyword(unicodedata.normalize('NFKC', new_name)):
            raise ValueError("new_name must be a valid non-keyword Python identifier")
        if syntax:
            raise ValueError("Python rename refuses a snapshot with syntax errors; inspect diagnostics")
        cursor = next((token.start for token in tokens[file].values()
                       if token.start <= (query['line'],query['python_column']) < token.end), None)
        if cursor is None:
            raise ValueError('Python rename requires a captured identifier token')
        selected_keys = rename_keys(file, cursor)
        selected_spelling = tokens[file][cursor].string
        if not selected_keys:
            raise ValueError('Python rename cannot resolve the selected binding')
        writable_paths = {str((root/current).resolve()) for current in sources if not read_only(current)}
        if any(key[0] not in writable_paths for key in selected_keys):
            raise ValueError('Python rename resolves to a read-only dependency or environment definition')
        alias = next((binding for binding in bindings if binding['explicit']
                      and (str((root/binding['file']).resolve()),*binding['token'].start) in selected_keys), None)
        positions = {}
        def replace(current, start):
            if current not in sources or read_only(current):
                raise ValueError("Python rename touches read-only or uncaptured sources")
            if start not in tokens[current]:
                raise ValueError("Python rename location is outside captured identifier tokens")
            positions.setdefault(current, set()).add(start)
        for key, canonical in local_binding_keys.items():
            if canonical in selected_keys:
                current = pathlib.Path(key[0]).relative_to(root).as_posix()
                replace(current, key[1:])
        if alias is not None:
            replace(alias['file'], alias['token'].start)
            for name in local_names(alias):
                replace(alias['file'], (name.line, name.column))
        else:
            refactoring = script(file).rename(
            query["line"], query["python_column"], new_name=new_name,
            )
            if refactoring.get_renames():
                raise ValueError("Python module/file moves are not supported by symbol rename")
            for path, replacement in refactoring.get_changed_files().items():
                try:
                    current = views.original_path(path).relative_to(root).as_posix()
                except ValueError:
                    raise ValueError("Python rename touches a read-only environment")
                if current not in all_source_names:
                    raise ValueError('Python rename touches uncaptured sources')
                if current not in sources: continue
                if read_only(current):
                    raise ValueError("Python rename touches read-only or uncaptured sources")
                before = list(tokenize.generate_tokens(io.StringIO(sources[current].removeprefix('\ufeff')).readline))
                after = list(tokenize.generate_tokens(io.StringIO(replacement.get_new_code().removeprefix('\ufeff')).readline))
                if len(before) != len(after):
                    raise ValueError('Python rename changed token structure')
                for old, new in zip(before, after):
                    if old.string == new.string or old.type in (tokenize.NEWLINE, tokenize.NL):
                        continue
                    if old.type != tokenize.NAME or new.type != tokenize.NAME or new.string != new_name:
                        raise ValueError('Python rename changed non-identifier text')
                    replace(current, old.start)
        for name in references(file, query['line'], query['python_column']):
            item = location(name)
            if item is not None and not item.get('read_only'):
                replace(item['file'], (name.line, name.column))
        # A caller's environment can import a source under a different module
        # name than the declaration's own environment. Jedi's initial refactor
        # may omit its import origin while reporting only the local alias.
        for binding in bindings:
            if binding['module'] is not None and rename_keys(binding['file'], binding['origin'].start) & selected_keys:
                replace(binding['file'], binding['origin'].start)
        if settings['execution_environments']:
            # Resolve matching identifier tokens in each file's own context.
            # This also covers `import module as m; m.member(...)`; spelling
            # alone never authorizes a change, and shadows/other modules remain.
            for current, entries in tokens.items():
                for start, candidate in entries.items():
                    binding = imports.get((current,start))
                    if binding is not None and binding['module'] is None and start == binding['origin'].start:
                        continue
                    if candidate.string == selected_spelling and rename_keys(current, start) & selected_keys:
                        replace(current, start)
        # Follow transparent imports, but stop at explicit API aliases. This
        # preserves downstream callers even when an alias repeats the old name.
        for current, starts in positions.items():
            keep = set()
            for start in starts:
                keys = rename_keys(current,start)
                if not keys:
                    raise ValueError('Python rename cannot resolve a candidate binding; no partial plan is returned')
                if keys & selected_keys:
                    keep.add(start)
            positions[current] = keep
        edits = []
        for current, starts in positions.items():
            if not starts:
                continue
            code = sources[current].removeprefix('\ufeff')
            lines = code.splitlines(keepends=True)
            offsets = [0]
            for line in lines: offsets.append(offsets[-1] + len(line))
            for start in sorted(starts, reverse=True):
                token = tokens[current][start]
                edits.append({'file':current,'line':start[0],'column':start[1],
                              'end_line':token.end[0],'end_column':token.end[1],
                              'old_text':token.string,'new_text':new_name})
                a, b = offsets[start[0]-1]+start[1], offsets[token.end[0]-1]+token.end[1]
                code = code[:a] + new_name + code[b:]
            ast.parse(code, filename=current)
            changed[current] = ('\ufeff' if sources[current].startswith('\ufeff') else '') + code
        rename = {"can_rename": bool(changed)}
    else:
        raise ValueError("Unsupported Python action")
    return {
        "ok": True, "results": results, "changed": changed, "rename": rename,
        "edits": edits if action == 'rename_preview' else [],
        "python_version": ".".join(map(str, sys.version_info[:3])),
        "jedi_version": jedi.__version__, "parso_version": parso.__version__,
        "import_settings": settings,
        "source_selection": selection,
    }


try:
    data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    result = analyze(data)
except Exception as error:
    result = {"ok": False, "error": str(error), "error_type": type(error).__name__}
sys.stdout.write(json.dumps(result, ensure_ascii=False))
