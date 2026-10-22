"""Generate an OWL 2 ontology (Turtle) from the Python classes of the CRAM monorepo.

The source is read with ``ast`` only, so nothing of CRAM has to be installed or imported. This keeps the
generator fast, makes it work on any fork or branch, and lets the same file run in the browser under Pyodide.

Mapping
  Python package (krrood, semantic_digital_twin, ...)  ->  namespace  http://www.ease-crc.org/ont/cram/<package>#
  class                                                ->  owl:Class, rdfs:subClassOf its base classes
  class docstring                                      ->  rdfs:comment (first paragraph)
  dataclass field  ``name: T``                         ->  property ``name`` and a restriction on the class:
      T                    ->  name exactly 1 T
      Optional[T]          ->  name max 1 T
      List/Set/Tuple/...   ->  name only T
      Dict[K, V]           ->  name only V
    T is an object property when T is a class of the repository (or an external class),
    a datatype property when T is int, float, str, bool, ...
  Enum members                                         ->  owl:NamedIndividual of the enum class
  KRROOD PropertyDescriptor subclasses                 ->  owl:ObjectProperty, with sub-properties, inverses and
                                                           transitivity; ``Cls.field = Descriptor(Cls, "field")``
                                                           makes that field use the descriptor property
  classes of other libraries                           ->  owl:Class below ext:ExternalClass in http://www.ease-crc.org/ont/cram/external#

Private classes (``_Name``) are not written; their subclasses inherit through them.

Command line:
  python generator/cram_ontology.py --source path/to/checkout --repository cram2/cognitive_robot_abstract_machine \
      --ref main --commit <sha> --out site/ontology/cram.ttl --summary site/ontology/cram.json

In the browser, ``select_paths(paths)`` picks the files to download and ``generate(files, ...)`` returns
``(turtle, summary_json)``.
"""
from __future__ import annotations

import argparse
import ast
import datetime
import json
import re
import subprocess
import sys
import warnings
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

# %% vocabulary

BASE = "http://www.ease-crc.org/ont/cram/"
META = BASE + "meta#"
EXTERNAL = BASE + "external#"
OWL = "http://www.w3.org/2002/07/owl#"
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
RDFS = "http://www.w3.org/2000/01/rdf-schema#"
XSD = "http://www.w3.org/2001/XMLSchema#"
DCTERMS = "http://purl.org/dc/terms/"
SKOS = "http://www.w3.org/2004/02/skos/core#"

SKIPPED_DIRECTORIES = {"test", "tests", "doc", "docs", "experiments", "scripts", "examples", "build", "dist",
                       "__pycache__", "node_modules", "site-packages", "venv", ".venv"}
PROPERTY_DESCRIPTOR = "krrood.ontomatic.property_descriptor.property_descriptor.PropertyDescriptor"
TRANSITIVE_MIXIN = "krrood.ontomatic.property_descriptor.mixins.TransitiveProperty"
SYMMETRIC_MIXIN = "krrood.ontomatic.property_descriptor.mixins.SymmetricProperty"

DATATYPES = {
    "int": "integer", "float": "double", "str": "string", "bool": "boolean", "bytes": "base64Binary", "complex": "string",
    "datetime": "dateTime", "date": "string", "time": "string", "timedelta": "string",  # OWL 2 has no xsd:date, xsd:time or xsd:duration
    "Decimal": "decimal", "UUID": "string", "Path": "string", "PurePath": "string", "LiteralString": "string",
    "float16": "double", "float32": "double", "float64": "double", "int8": "integer", "int16": "integer",
    "int32": "integer", "int64": "integer", "uint8": "integer", "uint16": "integer", "uint32": "integer", "uint64": "integer",
    "bool_": "boolean", "str_": "string",
}
MANY = {"List", "list", "Set", "set", "FrozenSet", "frozenset", "Tuple", "tuple", "Sequence", "MutableSequence", "Iterable",
        "Iterator", "Collection", "Container", "Deque", "deque", "AbstractSet", "MutableSet", "Generator", "SortedSet",
        "SortedList", "OrderedSet", "WeakSet", "KeysView", "ValuesView"}
MAPPINGS = {"Dict", "dict", "Mapping", "MutableMapping", "DefaultDict", "defaultdict", "OrderedDict", "Counter",
            "ChainMap", "WeakKeyDictionary", "WeakValueDictionary", "SortedDict"}
UNWRAP = {"Final", "Annotated", "InitVar", "Required", "NotRequired", "ReadOnly"}
SKIP_FIELD = {"ClassVar"}
NO_RANGE = {"Callable", "Type", "type", "Any", "object", "TypeVar", "Self", "Awaitable", "Coroutine", "ParamSpec"}
MECHANISM_BASES = {"ABC", "ABCMeta", "Generic", "Protocol", "object", "NamedTuple", "TypedDict"}
ENUM_BASES = {"Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"}


# %% source model


@dataclass
class FieldDeclaration:
    """An annotated attribute in a class body, e.g. ``parent: Optional[Body] = None``."""

    name: str
    annotation: ast.expr
    line: int
    docstring: str | None = None


@dataclass
class ClassDeclaration:
    """A class statement of the repository, with the facts the ontology needs about it."""

    module: "ModuleSource"
    qualified_name: str
    node: ast.ClassDef
    fields: list[FieldDeclaration] = field(default_factory=list)
    enum_members: list[tuple[str, int]] = field(default_factory=list)
    base_names: list[str] = field(default_factory=list)
    resolved_bases: list[str] = field(default_factory=list)
    external_bases: list[str] = field(default_factory=list)

    @property
    def full_name(self) -> str:
        return f"{self.module.name}.{self.qualified_name}"

    @property
    def package(self) -> str:
        return self.module.package

    @property
    def is_private(self) -> bool:
        """Private helper classes (``_Name``) are not written; their subclasses inherit through them."""
        return any(part.startswith("_") for part in self.qualified_name.split("."))

    @property
    def is_abstract(self) -> bool:
        if any(b == "ABC" or b.endswith(".ABC") for b in self.base_names):
            return True
        for item in self.node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                if any(dotted_name(d) in ("abstractmethod", "abc.abstractmethod") for d in item.decorator_list):
                    return True
        return False


@dataclass
class ModuleSource:
    """One Python module of the repository."""

    name: str
    path: str
    tree: ast.Module
    imports: dict[str, str] = field(default_factory=dict)
    star_imports: list[str] = field(default_factory=list)
    classes: dict[str, ClassDeclaration] = field(default_factory=dict)
    type_variables: set[str] = field(default_factory=set)
    type_aliases: dict[str, ast.expr] = field(default_factory=dict)

    @property
    def package(self) -> str:
        return self.name.split(".")[0]

    @property
    def is_package_init(self) -> bool:
        return self.path.endswith("__init__.py")


def dotted_name(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        inner = dotted_name(node.value)
        return f"{inner}.{node.attr}" if inner else None
    if isinstance(node, ast.Call):
        return dotted_name(node.func)
    return None


def clean_docstring(text: str | None) -> str | None:
    """The first paragraph of a docstring, with Sphinx roles and literals reduced to plain text."""
    if not text:
        return None
    text = re.split(r"\n\s*\n", text.strip())[0]
    text = re.sub(r":[a-z]+:`~?([^`]+)`", r"\1", text)
    text = re.sub(r"``([^`]+)``", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:2000] or None


# %% repository reading


def module_name(path: str) -> str | None:
    """The importable module name of a repository file, or None when the file is not library code."""
    parts = PurePosixPath(path).parts
    if not path.endswith(".py") or any(p in SKIPPED_DIRECTORIES or p.startswith(".") for p in parts[:-1]):
        return None
    file_name = parts[-1]
    if file_name in ("setup.py", "conftest.py", "noxfile.py") or file_name.startswith("test_") or file_name.endswith("_test.py"):
        return None
    if "src" in parts:
        parts = parts[len(parts) - parts[::-1].index("src"):]
    elif len(parts) == 1:
        return None  # loose scripts at the repository root
    names = list(parts[:-1]) + ([] if file_name == "__init__.py" else [file_name[:-3]])
    if not names or not all(n.isidentifier() for n in names):
        return None
    return ".".join(names)


def select_paths(paths: list[str]) -> list[str]:
    """The repository files the generator reads: library modules and the packages' pyproject.toml files."""
    chosen = [p for p in paths if module_name(p)]
    chosen += [p for p in paths if re.fullmatch(r"[^/]+/pyproject\.toml", p)]
    return sorted(set(chosen))


def parse_modules(files: dict[str, str]) -> tuple[dict[str, ModuleSource], list[str]]:
    modules: dict[str, ModuleSource] = {}
    problems: list[str] = []
    for path, text in sorted(files.items()):
        name = module_name(path)
        if not name or name in modules:
            continue
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", SyntaxWarning)  # e.g. invalid escape sequences in docstrings
                tree = ast.parse(text, filename=path)
        except SyntaxError as error:
            problems.append(f"{path}: {error.msg} (line {error.lineno})")
            continue
        modules[name] = ModuleSource(name, path, tree)
    for module in modules.values():
        read_module(module)
    return modules, problems


def read_module(module: ModuleSource) -> None:
    package_parts = module.name.split(".") if module.is_package_init else module.name.split(".")[:-1]
    for node in ast.walk(module.tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    module.imports[alias.asname] = alias.name
                else:
                    top = alias.name.split(".")[0]
                    module.imports.setdefault(top, top)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package_parts[: len(package_parts) - (node.level - 1)] if node.level > 1 else package_parts
                source = ".".join(base + ([node.module] if node.module else []))
            else:
                source = node.module or ""
            for alias in node.names:
                if alias.name == "*":
                    module.star_imports.append(source)
                else:
                    module.imports[alias.asname or alias.name] = f"{source}.{alias.name}" if source else alias.name
    for node in module.tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            target = node.targets[0].id
            if isinstance(node.value, ast.Call) and (dotted_name(node.value.func) or "").split(".")[-1] in ("TypeVar", "ParamSpec", "TypeVarTuple"):
                module.type_variables.add(target)
            elif isinstance(node.value, (ast.Subscript, ast.BinOp)) or (isinstance(node.value, ast.Name) and target[:1].isupper()):
                module.type_aliases[target] = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and dotted_name(node.annotation) in ("TypeAlias", "typing.TypeAlias", "typing_extensions.TypeAlias") and node.value is not None:
            module.type_aliases[node.target.id] = node.value
        elif sys.version_info >= (3, 12) and isinstance(node, getattr(ast, "TypeAlias", ())):
            module.type_aliases[node.name.id] = node.value

    def collect(body: list[ast.stmt], prefix: str) -> None:
        for node in body:
            if isinstance(node, ast.ClassDef):
                declaration = ClassDeclaration(module, prefix + node.name, node)
                # Generic bases such as Role[Person] count as their class
                declaration.base_names = [n for n in (dotted_name(b.value if isinstance(b, ast.Subscript) else b) for b in node.bases) if n]
                read_class_body(declaration)
                module.classes[declaration.qualified_name] = declaration
                collect(node.body, declaration.qualified_name + ".")

    collect(module.tree.body, "")


def read_class_body(declaration: ClassDeclaration) -> None:
    body = declaration.node.body
    for index, item in enumerate(body):
        following = body[index + 1] if index + 1 < len(body) else None
        docstring = None
        if isinstance(following, ast.Expr) and isinstance(following.value, ast.Constant) and isinstance(following.value.value, str):
            docstring = clean_docstring(following.value.value)
        if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
            if not item.target.id.startswith("_"):
                declaration.fields.append(FieldDeclaration(item.target.id, item.annotation, item.lineno, docstring))
        elif isinstance(item, ast.Assign):
            for target in item.targets:
                if isinstance(target, ast.Name) and not target.id.startswith("_"):
                    declaration.enum_members.append((target.id, item.lineno))


# %% name resolution


class Resolver:
    """Finds the class of the repository that a name in a module refers to, following imports and re-exports."""

    def __init__(self, modules: dict[str, ModuleSource]):
        self.modules = modules
        self.classes = {c.full_name: c for m in modules.values() for c in m.classes.values()}
        self.cache: dict[tuple[str, str], str | None] = {}

    def resolve(self, module: ModuleSource, name: str) -> str | None:
        key = (module.name, name)
        if key not in self.cache:
            self.cache[key] = None  # guards against import cycles
            self.cache[key] = self._resolve(module, name, 0)
        return self.cache[key]

    def _resolve(self, module: ModuleSource, name: str, depth: int) -> str | None:
        if depth > 12:
            return None
        first, _, rest = name.partition(".")
        if name in module.classes:
            return module.classes[name].full_name
        if first in module.imports:
            return self.lookup(module.imports[first] + ("." + rest if rest else ""), depth + 1)
        for star in module.star_imports:
            hit = self.lookup(f"{star}.{name}", depth + 1)
            if hit:
                return hit
        return None

    def lookup(self, full_name: str, depth: int = 0) -> str | None:
        if full_name in self.classes:
            return full_name
        parts = full_name.split(".")
        for cut in range(len(parts) - 1, 0, -1):
            module = self.modules.get(".".join(parts[:cut]))
            if module:
                return self._resolve(module, ".".join(parts[cut:]), depth + 1)
        return None

    def external_name(self, module: ModuleSource, name: str) -> str:
        first, _, rest = name.partition(".")
        if first in module.imports:
            return module.imports[first] + ("." + rest if rest else "")
        return name


# %% type annotations


@dataclass
class FieldRange:
    """What an annotation says about the values of a field."""

    cardinality: str  # "one", "optional" or "many"
    classes: list[str] = field(default_factory=list)  # full names of repository classes
    externals: list[str] = field(default_factory=list)  # dotted names of classes of other libraries
    datatypes: list[str] = field(default_factory=list)  # xsd local names
    skip: bool = False


class AnnotationReader:
    def __init__(self, resolver: Resolver):
        self.resolver = resolver

    def read(self, module: ModuleSource, annotation: ast.expr) -> FieldRange:
        result = FieldRange("one")
        self._visit(module, annotation, result, 0)
        return result

    def _visit(self, module: ModuleSource, node: ast.expr, out: FieldRange, depth: int) -> None:
        if depth > 12:
            return
        if isinstance(node, ast.Constant):
            if node.value is None:
                if out.cardinality == "one":
                    out.cardinality = "optional"
            elif isinstance(node.value, str):  # a forward reference
                try:
                    self._visit(module, ast.parse(node.value, mode="eval").body, out, depth + 1)
                except SyntaxError:
                    pass
            return
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            self._visit(module, node.left, out, depth + 1)
            self._visit(module, node.right, out, depth + 1)
            return
        if isinstance(node, ast.Subscript):
            head = (dotted_name(node.value) or "").split(".")[-1]
            arguments = list(node.slice.elts) if isinstance(node.slice, ast.Tuple) else [node.slice]
            if head in SKIP_FIELD:
                out.skip = True
            elif head == "Optional":
                out.cardinality = "optional" if out.cardinality == "one" else out.cardinality
                self._visit(module, arguments[0], out, depth + 1)
            elif head == "Union":
                for a in arguments:
                    self._visit(module, a, out, depth + 1)
            elif head in UNWRAP:
                self._visit(module, arguments[0], out, depth + 1)
            elif head in MANY:
                out.cardinality = "many"
                for a in arguments:
                    if not (isinstance(a, ast.Constant) and a.value is Ellipsis):
                        self._visit(module, a, out, depth + 1)
            elif head in MAPPINGS:
                out.cardinality = "many"
                if len(arguments) > 1:
                    self._visit(module, arguments[-1], out, depth + 1)
            elif head == "Literal":
                values = [a.value for a in arguments if isinstance(a, ast.Constant)]
                out.datatypes.append("boolean" if values and all(isinstance(v, bool) for v in values) else
                                     "integer" if values and all(isinstance(v, int) for v in values) else "string")
            elif head not in NO_RANGE:
                self._name(module, dotted_name(node.value), out, depth)  # a generic class of the repository, e.g. Role[Person]
            return
        name = dotted_name(node)
        if name:
            self._name(module, name, out, depth)

    def _name(self, module: ModuleSource, name: str | None, out: FieldRange, depth: int) -> None:
        if not name:
            return
        last = name.split(".")[-1]
        if name == "None":
            if out.cardinality == "one":
                out.cardinality = "optional"
            return
        if last in SKIP_FIELD:
            out.skip = True
            return
        if last in NO_RANGE or name in module.type_variables:
            return
        if last in MANY or last in MAPPINGS:
            out.cardinality = "many"
            return
        resolved = self.resolver.resolve(module, name)
        if resolved:
            out.classes.append(resolved)
            return
        alias = module.type_aliases.get(name)
        if alias is not None:
            self._visit(module, alias, out, depth + 1)
            return
        imported = self.resolver.external_name(module, name)
        imported_module = self.resolver.modules.get(imported.rsplit(".", 1)[0]) if "." in imported else None
        if imported_module is not None and last in imported_module.type_aliases:
            self._visit(imported_module, imported_module.type_aliases[last], out, depth + 1)
            return
        if imported_module is not None and last in imported_module.type_variables:
            return
        if last in DATATYPES:
            out.datatypes.append(DATATYPES[last])
            return
        out.externals.append(imported)


# %% turtle output


def turtle_string(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'


SAFE_LOCAL = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*[A-Za-z0-9_-]$|^[A-Za-z_]$")


class TurtleWriter:
    def __init__(self, prefixes: dict[str, str]):
        self.prefixes = prefixes
        self.by_namespace = sorted(((ns, p) for p, ns in prefixes.items()), key=lambda x: -len(x[0]))
        self.lines: list[str] = []

    def iri(self, iri: str) -> str:
        for namespace, prefix in self.by_namespace:
            if iri.startswith(namespace):
                local = iri[len(namespace):]
                if SAFE_LOCAL.match(local) and ".." not in local:
                    return f"{prefix}:{local}"
        return f"<{iri}>"

    def subject(self, iri: str, statements: list[tuple[str, str]]) -> None:
        if statements:
            body = " ;\n    ".join(f"{p} {o}" for p, o in statements)
            self.lines.append(f"{self.iri(iri)}\n    {body} .\n")

    def text(self) -> str:
        head = "".join(f"@prefix {p}: <{ns}> .\n" for p, ns in self.prefixes.items())
        return head + "\n" + "\n".join(self.lines)


# %% ontology


@dataclass
class OntologySource:
    """Where the analysed code comes from."""

    repository: str = "cram2/cognitive_robot_abstract_machine"
    ref: str = "main"
    commit: str = ""
    generated: str = ""

    @property
    def source_url(self) -> str:
        return f"https://github.com/{self.repository}/tree/{self.commit or self.ref}"

    def file_url(self, path: str, line: int) -> str:
        return f"https://github.com/{self.repository}/blob/{self.commit or self.ref}/{path}#L{line}"


@dataclass
class PropertyUse:
    """How the fields that share one property are typed across the classes that declare them."""

    iri: str
    name: str
    object_uses: int = 0
    data_uses: int = 0
    comment: str | None = None
    owners: set[str] = field(default_factory=set)


def lower_camel(name: str) -> str:
    return name[:1].lower() + name[1:]


def generate(files: dict[str, str], repository: str = "cram2/cognitive_robot_abstract_machine", ref: str = "main",
             commit: str = "", generated: str | None = None) -> tuple[str, str]:
    """Build the ontology from ``{repository path: file text}``. Returns (turtle, summary as JSON)."""
    source = OntologySource(repository, ref, commit, generated or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
    modules, problems = parse_modules(files)
    resolver = Resolver(modules)
    reader = AnnotationReader(resolver)
    classes = resolver.classes

    # base classes
    for c in classes.values():
        for base in c.base_names:
            hit = resolver.resolve(c.module, base)
            if hit and hit != c.full_name:
                c.resolved_bases.append(hit)
            elif base.split(".")[-1] not in MECHANISM_BASES:
                c.external_bases.append(resolver.external_name(c.module, base))

    def ancestors(name: str, seen: set[str]) -> set[str]:
        for b in classes[name].resolved_bases:
            if b not in seen:
                seen.add(b)
                ancestors(b, seen)
        return seen

    ancestor_cache = {name: ancestors(name, set()) for name in classes}

    def external_base_names(name: str) -> set[str]:
        out = {e.split(".")[-1] for e in classes[name].external_bases}
        for a in ancestor_cache[name]:
            out |= {e.split(".")[-1] for e in classes[a].external_bases}
        return out

    descriptors = {n for n, anc in ancestor_cache.items() if PROPERTY_DESCRIPTOR in anc} | ({PROPERTY_DESCRIPTOR} & classes.keys())
    packages = sorted({m.package for m in modules.values()})
    namespace = {p: f"{BASE}{p}#" for p in packages}

    # local names: the class name, qualified with its module where a package has two classes of that name
    by_short: dict[tuple[str, str], list[str]] = {}
    for c in classes.values():
        by_short.setdefault((c.package, c.qualified_name), []).append(c.full_name)
    class_iri: dict[str, str] = {}
    for (package, short), names in by_short.items():
        for n in names:
            class_iri[n] = namespace[package] + (short if len(names) == 1 else n[len(package) + 1:])

    def external_iri(name: str) -> str:
        return EXTERNAL + name

    def public_bases(name: str, seen: set[str]) -> tuple[list[str], list[str]]:
        """Superclasses to write: private bases are replaced by their own public bases."""
        named, external = [], list(classes[name].external_bases)
        for b in classes[name].resolved_bases:
            if b in seen or b in descriptors:
                continue
            seen.add(b)
            if classes[b].is_private:
                more_named, more_external = public_bases(b, seen)
                named += more_named
                external += more_external
            else:
                named.append(b)
        return named, external

    # KRROOD property descriptors and the fields they manage
    descriptor_iri = {d: namespace[classes[d].package] + lower_camel(classes[d].qualified_name.split(".")[-1])
                      for d in descriptors if d != PROPERTY_DESCRIPTOR}
    descriptor_fields: dict[tuple[str, str], str] = {}
    for module in modules.values():
        for node in module.tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Attribute) and isinstance(node.value, ast.Call):
                owner = resolver.resolve(module, dotted_name(node.targets[0].value) or "")
                descriptor = resolver.resolve(module, dotted_name(node.value.func) or "")
                if owner and descriptor in descriptor_iri:
                    descriptor_fields[(owner, node.targets[0].attr)] = descriptor_iri[descriptor]

    def field_owner(c: ClassDeclaration, name: str) -> ClassDeclaration:
        """The topmost ancestor that declares the field, so that an inherited field keeps one property."""
        declaring = [a for a in ancestor_cache[c.full_name] if any(f.name == name for f in classes[a].fields)]
        roots = [a for a in declaring if not (ancestor_cache[a] & set(declaring))]
        return classes[sorted(roots)[0]] if roots else c

    properties: dict[str, PropertyUse] = {}
    restrictions: dict[str, list[tuple[str, FieldRange]]] = {}
    for c in classes.values():
        if c.full_name in descriptors or c.is_private or ENUM_BASES & external_base_names(c.full_name):
            continue
        for f in c.fields:
            value_range = reader.read(c.module, f.annotation)
            if value_range.skip:
                continue
            owner = field_owner(c, f.name)
            iri = descriptor_fields.get((c.full_name, f.name)) or namespace[owner.package] + f.name
            use = properties.setdefault(iri, PropertyUse(iri, f.name))
            if value_range.classes or value_range.externals:
                use.object_uses += 1
            elif value_range.datatypes:
                use.data_uses += 1
            use.comment = use.comment or f.docstring
            use.owners.add(c.full_name)
            restrictions.setdefault(c.full_name, []).append((iri, value_range))

    # an object/data clash on one name: the data variant gets its own property
    data_variant: dict[str, str] = {}
    for iri, use in list(properties.items()):
        if use.object_uses and use.data_uses:
            data_variant[iri] = iri + "_value"
            properties[iri + "_value"] = PropertyUse(iri + "_value", use.name + " (value)", 0, use.data_uses, use.comment, set(use.owners))
            use.data_uses = 0

    # ---- write
    prefixes = {"owl": OWL, "rdf": RDF, "rdfs": RDFS, "xsd": XSD, "dcterms": DCTERMS, "skos": SKOS, "cram": META, "ext": EXTERNAL}
    prefixes.update({p: namespace[p] for p in packages})
    w = TurtleWriter(prefixes)
    statistics = {"classes": 0, "object_properties": 0, "datatype_properties": 0, "individuals": 0, "restrictions": 0}
    w.subject(BASE + "cram", [
        ("a", "owl:Ontology"),
        ("rdfs:label", turtle_string("CRAM ontology")),
        ("dcterms:title", turtle_string("CRAM ontology")),
        ("rdfs:comment", turtle_string(
            "Generated from the Python classes of the Cognitive Robot Abstract Machine (CRAM) monorepo: classes become OWL classes, "
            "dataclass fields become properties with restrictions, enum members become individuals and KRROOD property descriptors "
            "become OWL properties. Generated by cram_owlviz; do not edit by hand.")),
        ("owl:versionInfo", turtle_string(f"{source.commit[:12] or source.ref} ({source.generated[:10]})")),
        ("dcterms:source", w.iri(source.source_url)),
        ("dcterms:created", f"{turtle_string(source.generated)}^^xsd:dateTime"),
        ("dcterms:license", "<https://www.gnu.org/licenses/lgpl-3.0.html>"),
    ])
    for iri in (DCTERMS + "title", DCTERMS + "source", DCTERMS + "created", DCTERMS + "license", SKOS + "altLabel"):
        w.subject(iri, [("a", "owl:AnnotationProperty")])
    for iri, label, comment in [
        (META + "pythonName", "python name", "The fully qualified Python name of the class, property or member this entity was generated from."),
        (META + "sourceCode", "source code", "Link to the line of the CRAM repository that declares this entity."),
        (META + "abstract", "abstract", "True when the Python class is abstract (derives from ABC or has abstract methods)."),
        (META + "package", "package", "The CRAM package (krrood, semantic_digital_twin, coraplex, ...) that declares the entity."),
    ]:
        w.subject(iri, [("a", "owl:AnnotationProperty"), ("rdfs:label", turtle_string(label)), ("rdfs:comment", turtle_string(comment))])

    package_descriptions = {}
    for path, text in files.items():
        m = re.fullmatch(r"([^/]+)/pyproject\.toml", path)
        d = m and re.search(r'^description\s*=\s*"([^"]*)"', text, re.M)
        if d:
            package_descriptions[m.group(1)] = d.group(1)
    for p in packages:
        w.subject(BASE + p, [("rdfs:label", turtle_string(p))] + ([("rdfs:comment", turtle_string(package_descriptions[p]))] if p in package_descriptions else []))

    def provenance(full_name: str, path: str, line: int, package: str) -> list[tuple[str, str]]:
        return [("cram:pythonName", turtle_string(full_name)), ("cram:sourceCode", w.iri(source.file_url(path, line))),
                ("cram:package", turtle_string(package)), ("rdfs:isDefinedBy", w.iri(BASE + package))]

    def range_expression(iri: str, value_range: FieldRange) -> tuple[str, str] | None:
        """(owl:onClass or owl:onDataRange, filler) for a restriction; None when nothing is known about the values."""
        if properties[iri].object_uses or value_range.classes or value_range.externals:
            fillers = [w.iri(class_iri[c]) for c in dict.fromkeys(value_range.classes) if c not in descriptors and not classes[c].is_private]
            fillers += [w.iri(external_iri(e)) for e in dict.fromkeys(value_range.externals)]
            if not fillers:
                return None
            return "owl:onClass", fillers[0] if len(fillers) == 1 else f"[ a owl:Class ; owl:unionOf ( {' '.join(fillers)} ) ]"
        types = [f"xsd:{t}" for t in dict.fromkeys(value_range.datatypes)]
        if not types:
            return None
        return "owl:onDataRange", types[0] if len(types) == 1 else f"[ a rdfs:Datatype ; owl:unionOf ( {' '.join(types)} ) ]"

    for name in sorted(classes):
        c = classes[name]
        if name in descriptors or c.is_private:
            continue
        statistics["classes"] += 1
        statements = [("a", "owl:Class"), ("rdfs:label", turtle_string(c.qualified_name.split(".")[-1]))]
        doc = clean_docstring(ast.get_docstring(c.node))
        if doc:
            statements.append(("rdfs:comment", turtle_string(doc)))
        if "." in c.qualified_name:
            statements.append(("skos:altLabel", turtle_string(c.qualified_name)))
        named_bases, external_bases = public_bases(name, set())
        for b in dict.fromkeys(named_bases):
            statements.append(("rdfs:subClassOf", w.iri(class_iri[b])))
        for e in dict.fromkeys(external_bases):
            statements.append(("rdfs:subClassOf", w.iri(external_iri(e))))
        for iri, value_range in restrictions.get(name, []):
            prop = data_variant[iri] if iri in data_variant and not (value_range.classes or value_range.externals) else iri
            expression = range_expression(prop, value_range)
            if value_range.cardinality == "many":
                if expression is None:
                    continue
                statements.append(("rdfs:subClassOf", f"[ a owl:Restriction ; owl:onProperty {w.iri(prop)} ; owl:allValuesFrom {expression[1]} ]"))
            elif expression is None:
                cardinality = "owl:maxCardinality" if value_range.cardinality == "optional" else "owl:cardinality"
                statements.append(("rdfs:subClassOf", f'[ a owl:Restriction ; owl:onProperty {w.iri(prop)} ; {cardinality} "1"^^xsd:nonNegativeInteger ]'))
            else:
                cardinality = "owl:maxQualifiedCardinality" if value_range.cardinality == "optional" else "owl:qualifiedCardinality"
                statements.append(("rdfs:subClassOf", f'[ a owl:Restriction ; owl:onProperty {w.iri(prop)} ; {cardinality} "1"^^xsd:nonNegativeInteger ; {expression[0]} {expression[1]} ]'))
            statistics["restrictions"] += 1
        if c.is_abstract:
            statements.append(("cram:abstract", '"true"^^xsd:boolean'))
        statements += provenance(name, c.module.path, c.node.lineno, c.package)
        w.subject(class_iri[name], statements)
        if ENUM_BASES & external_base_names(name):
            for member, line in c.enum_members:
                statistics["individuals"] += 1
                w.subject(class_iri[name] + "." + member, [
                    ("a", "owl:NamedIndividual"), ("a", w.iri(class_iri[name])), ("rdfs:label", turtle_string(member)),
                ] + provenance(f"{name}.{member}", c.module.path, line, c.package))

    # classes of other libraries: declared, below one root class
    external_names = sorted({e for c in classes.values() if not c.is_private for e in c.external_bases}
                            | {e for entries in restrictions.values() for _, value_range in entries for e in value_range.externals})
    w.subject(BASE + "external", [("rdfs:label", turtle_string("other libraries"))])
    w.subject(EXTERNAL + "ExternalClass", [
        ("a", "owl:Class"), ("rdfs:label", turtle_string("External class")), ("rdfs:isDefinedBy", w.iri(BASE + "external")),
        ("rdfs:comment", turtle_string("A class of another Python library (the standard library, numpy, sqlalchemy, ROS, ...) that CRAM classes derive from or use as field types. Only its name is known.")),
    ])
    for e in external_names:
        w.subject(external_iri(e), [("a", "owl:Class"), ("rdfs:label", turtle_string(e.split(".")[-1])),
                                    ("rdfs:subClassOf", "ext:ExternalClass"), ("cram:pythonName", turtle_string(e)),
                                    ("rdfs:isDefinedBy", w.iri(BASE + "external"))])
    statistics["external_classes"] = len(external_names)

    for iri, use in sorted(properties.items()):
        if iri in descriptor_iri.values():
            continue
        is_object = use.object_uses > 0 or (use.data_uses == 0 and iri not in data_variant.values())
        statistics["object_properties" if is_object else "datatype_properties"] += 1
        package = iri[len(BASE):].split("#")[0]
        statements = [("a", "owl:ObjectProperty" if is_object else "owl:DatatypeProperty"), ("rdfs:label", turtle_string(use.name))]
        if use.comment:
            statements.append(("rdfs:comment", turtle_string(use.comment)))
        statements += [("cram:package", turtle_string(package)), ("rdfs:isDefinedBy", w.iri(BASE + package)),
                       ("cram:pythonName", turtle_string(f"{sorted(use.owners)[0]}.{use.name.split(' ')[0]}"))]
        w.subject(iri, statements)

    for d, iri in sorted(descriptor_iri.items()):
        c = classes[d]
        statistics["object_properties"] += 1
        statements = [("a", "owl:ObjectProperty"), ("rdfs:label", turtle_string(lower_camel(c.qualified_name.split(".")[-1])))]
        doc = clean_docstring(ast.get_docstring(c.node))
        if doc:
            statements.append(("rdfs:comment", turtle_string(doc)))
        if TRANSITIVE_MIXIN in ancestor_cache[d]:
            statements.append(("a", "owl:TransitiveProperty"))
        if SYMMETRIC_MIXIN in ancestor_cache[d]:
            statements.append(("a", "owl:SymmetricProperty"))
        for b in c.resolved_bases:
            if b in descriptor_iri:
                statements.append(("rdfs:subPropertyOf", w.iri(descriptor_iri[b])))
        for item in c.node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == "get_inverse":
                for statement in ast.walk(item):
                    if isinstance(statement, ast.Return) and statement.value is not None:
                        inverse = resolver.resolve(c.module, dotted_name(statement.value) or "")
                        if inverse in descriptor_iri:
                            statements.append(("owl:inverseOf", w.iri(descriptor_iri[inverse])))
        statements += provenance(d, c.module.path, c.node.lineno, c.package)
        w.subject(iri, statements)

    statistics["modules"] = len(modules)
    statistics["packages"] = {p: sum(1 for c in classes.values() if c.package == p and c.full_name not in descriptors and not c.is_private) for p in packages}
    summary = {"repository": source.repository, "ref": source.ref, "commit": source.commit, "generated": source.generated,
               "source": source.source_url, "statistics": statistics, "problems": problems}
    return w.text(), json.dumps(summary, indent=2)


# %% command line


def read_checkout(root: Path) -> dict[str, str]:
    paths = [p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file() and (p.suffix == ".py" or p.name == "pyproject.toml")]
    return {p: (root / p).read_text(encoding="utf-8", errors="replace") for p in select_paths(paths)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--source", required=True, type=Path, help="checkout of the CRAM repository")
    parser.add_argument("--repository", default="cram2/cognitive_robot_abstract_machine", help="owner/name on GitHub (for source links)")
    parser.add_argument("--ref", default="main", help="branch or tag that was checked out")
    parser.add_argument("--commit", default="", help="commit SHA (read from the checkout when omitted)")
    parser.add_argument("--out", required=True, type=Path, help="Turtle file to write")
    parser.add_argument("--summary", type=Path, help="JSON file with source and statistics")
    args = parser.parse_args()
    commit = args.commit
    if not commit:
        try:
            commit = subprocess.run(["git", "-C", str(args.source), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        except (OSError, subprocess.CalledProcessError):
            commit = ""
    turtle, summary = generate(read_checkout(args.source), args.repository, args.ref, commit)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(turtle, encoding="utf-8")
    if args.summary:
        args.summary.write_text(summary + "\n", encoding="utf-8")
    result = json.loads(summary)
    s = result["statistics"]
    print(f"{args.out}: {s['classes']} classes, {s['object_properties']} object properties, {s['datatype_properties']} data properties, "
          f"{s['individuals']} individuals, {s['restrictions']} restrictions from {s['modules']} modules", file=sys.stderr)
    for problem in result["problems"]:
        print("skipped " + problem, file=sys.stderr)


if __name__ == "__main__":
    main()
