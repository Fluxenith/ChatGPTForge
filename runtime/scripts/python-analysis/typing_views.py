"""Build import views from captured dependencies, preserving their source identities."""
import pathlib


class DependencyViews:
    def __init__(self, root, files, site_roots, markers):
        self.root = root
        self.modules, self.paths, self.origins, self.roots = {}, {}, {}, {}
        self.complete, self.packages = {}, []
        partial = {item['file'].casefold() for item in markers if item['partial']}
        normal_candidates, stub_candidates, package_dirs = [], [], []
        normal_owners, stub_owners, partial_packages, package_initializers = {}, {}, set(), set()
        for index, folder in enumerate(site_roots):
            normal, stubs, directories = {}, {}, set()
            for file in sorted(files, key=lambda name: (not name.lower().endswith('.pyi'), name)):
                if not file.casefold().startswith(folder.casefold() + '/'):
                    continue
                suffix = file[len(folder) + 1:]
                parts = list(pathlib.PurePosixPath(suffix).parts)
                stub = len(parts) > 1 and parts[0].lower().endswith('-stubs')
                if stub:
                    if not file.lower().endswith('.pyi'):
                        continue
                    name = parts[0][:-6]
                    if not name.isidentifier():
                        continue
                    directories.add(parts[0])
                    parts[0] = name
                logical = pathlib.PurePosixPath(*parts).with_suffix('')
                pieces = list(logical.parts)
                if pieces[-1] == '__init__':
                    pieces.pop()
                    (stub_owners if stub else normal_owners).setdefault(tuple(piece.casefold() for piece in pieces), index)
                    if stub:package_initializers.add((index, tuple(piece.casefold() for piece in pieces)))
                if not pieces or not all(piece.isidentifier() for piece in pieces):
                    continue
                module = '.'.join(pieces)
                (stubs if stub else normal).setdefault(module.casefold(), (module, file, '/'.join(parts)))
            for marker in partial:
                prefix = folder.casefold() + '/'
                if not marker.startswith(prefix):
                    continue
                parts = marker[len(prefix):].split('/')[:-1]
                if parts and parts[0].endswith('-stubs'):
                    parts[0] = parts[0][:-6]
                    partial_packages.add((index, tuple(parts)))
            normal_candidates.extend((index, entry) for entry in normal.values())
            stub_candidates.extend((index, entry) for entry in stubs.values())
            package_dirs.extend((index, folder, name) for name in sorted(directories))
        def visible(index, module, owners):
            pieces = tuple(piece.casefold() for piece in module.split('.'))
            return all(owner == index for package, owner in owners.items()
                       if pieces[:len(package)] == package)
        normal, stubs = {}, {}
        for index, entry in normal_candidates:
            if visible(index, entry[0], normal_owners):normal.setdefault(entry[0].casefold(), entry)
        for index, entry in stub_candidates:
            if visible(index, entry[0], stub_owners):stubs.setdefault(entry[0].casefold(), entry)
        complete = {package for package,index in stub_owners.items()
                    if visible(index, '.'.join(package), stub_owners)
                    and not any(owner == index and package[:len(parent)] == parent
                                for owner,parent in partial_packages)}
        self.complete = {folder:complete for folder in site_roots}
        destination = root.parent / 'typing' / 'environment'
        destination.mkdir(parents=True, exist_ok=True)
        table = {}
        for key, (module, file, logical_path) in normal.items():
            pieces = tuple(piece.casefold() for piece in module.split('.'))
            if key not in stubs and not any(pieces[:len(package)] == package for package in complete):
                table[module] = file
                self._copy(destination, logical_path, file)
        for module, file, logical_path in stubs.values():
            table[module] = file
            self._copy(destination, logical_path, file)
        self.modules = {folder:table for folder in site_roots}
        self.roots = {folder:destination for folder in site_roots}
        for index,folder,package in package_dirs:
            name = package[:-6];key = (name.casefold(),)
            role = 'partial' if (index,key) in partial_packages else 'complete' if (index,key) in package_initializers else 'namespace'
            self.packages.append({'file':folder + '/' + package,'name':name,'kind':role})

    def _copy(self, destination, logical_path, file):
        path = destination / logical_path
        path.parent.mkdir(parents=True, exist_ok=True)
        assert path.resolve().is_relative_to(destination.resolve())
        path.write_bytes((self.root / file).read_bytes())
        self.paths[file] = path
        self.origins[path.resolve()] = file

    def blocked(self, folder, module):
        pieces = tuple(piece.casefold() for piece in module.split('.'))
        return any(pieces[:len(package)] == package for package in self.complete.get(folder, ()))

    def backend_roots(self, folders, file):
        result = [str(self.roots.get(folder, self.root / folder)) for folder in folders]
        # Explicit inspection of an overridden original dependency still parses
        # that captured file. Its import context does not authorize an edit.
        if file not in self.paths:
            result.extend(str(self.root / folder) for folder in self.roots
                          if file.casefold().startswith(folder.casefold() + '/'))
        return list(dict.fromkeys(result))

    def source_path(self, file):
        return self.paths.get(file, self.root / file)

    def original_path(self, path):
        path = pathlib.Path(path).resolve()
        file = self.origins.get(path)
        return (self.root / file).resolve() if file is not None else path

    def package_parts(self, folder, file):
        suffix = file[len(folder) + 1:] if folder else file
        pieces = list(pathlib.PurePosixPath(suffix).with_suffix('').parts)
        if folder in self.roots and len(pieces) > 1 and pieces[0].lower().endswith('-stubs'):
            pieces[0] = pieces[0][:-6]
        return pieces[:-1]
