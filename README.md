# cram_owlviz

A Protégé-like OWL browser that runs entirely in the browser, published as a GitHub Page. By default it shows the **CRAM ontology**, which is generated every day from the Python classes of [cram2/cognitive_robot_abstract_machine](https://github.com/cram2/cognitive_robot_abstract_machine). It can also generate the ontology from any fork or branch, or open any other OWL ontology.

**Live:** https://sorynaryon.github.io/cram_owlviz/

## What you can do

- **Browse.**
  - Class, object property, data property, annotation property and individual trees. Top-level entries can be grouped by package or module.
  - All axioms in Manchester syntax, annotations, a neighbourhood graph, "referenced by" lists, and links to the source code.
  - Search with `/`, and deep links such as `#semantic_digital_twin:Drawer`.
- **Generate the CRAM ontology from a fork or branch.**
  - Open → *Generate from a fork or branch*. You can also use a link: `?repo=owner/name&ref=branch`.
  - The page downloads the Python sources from GitHub and runs the same generator as the daily build under [Pyodide](https://pyodide.org). Allow about a minute for the first run.
- **Open any OWL ontology.**
  - Files (drag and drop), URLs (shareable as `?url=…`) or pasted text.
  - Formats: Turtle, RDF/XML, OWL Functional Syntax, N-Triples, N-Quads and TriG.
  - `owl:imports` can be loaded from the overview page.
  - Nothing is uploaded; parsing happens in the browser.
- **Inferred view.**
  - A lightweight structural reasoner covers the told hierarchy, equivalences, defined classes, and domain/range typing of individuals.
  - It never infers anything false, but it misses some inferences; it is not a full DL reasoner. Untick *Inferred* to see the asserted hierarchy.

## The CRAM ontology

`generator/cram_ontology.py` reads the repository with Python's `ast` module, so CRAM does not need to be installed. It writes OWL 2 DL Turtle:

| Python | OWL |
| --- | --- |
| package (`krrood`, `semantic_digital_twin`, …) | namespace `http://www.ease-crc.org/ont/cram/<package>#` |
| class, base classes | `owl:Class`, `rdfs:subClassOf` |
| docstring | `rdfs:comment` (first paragraph) |
| dataclass field `x: T` / `Optional[T]` / `List[T]` | property `x` with `x exactly 1 T` / `x max 1 T` / `x only T` |
| field typed `int`, `float`, `str`, `bool`, … | data property with an `xsd` datatype |
| enum members | individuals of the enum class |
| KRROOD `PropertyDescriptor` subclasses | object properties, with sub-properties, inverses and transitivity |
| classes of other libraries (`numpy.ndarray`, `Enum`, …) | classes below `ext:ExternalClass` |
| module path, source line | `cram:pythonName`, `cram:sourceCode` |

The following are left out:
- Tests, docs, experiments and scripts.
- Private classes (`_Name`). Their subclasses still inherit through them.
- `ClassVar`s and private fields.

To generate it locally:

```bash
git clone --depth 1 https://github.com/cram2/cognitive_robot_abstract_machine.git cram
python3 generator/cram_ontology.py --source cram --out ontology/cram.ttl --summary ontology/cram.json
python3 -m http.server   # then open http://localhost:8000
```

## Daily build and GitHub Pages

`.github/workflows/pages.yml` runs on every push to `main`, every day at 03:17 UTC, and on demand. A manual run can build from another repository or branch. Each run:

1. Checks out CRAM.
2. Runs the generator tests.
3. Generates `ontology/cram.ttl`.
4. Runs the browser tests in headless Chrome.
5. Deploys the site to GitHub Pages.

To enable it, set **Settings → Pages → Source** to **GitHub Actions**. GitHub pauses scheduled workflows after 60 days without commits; re-enable the workflow in the Actions tab if that happens.

## Tests

```bash
python3 -m unittest discover -s tests          # generator
python3 -m http.server                         # then open http://localhost:8000/tests/
```

The browser tests check the RDF/XML parser against rdflib and the Functional Syntax parser against the OWL API, both on fixtures. They also cover the model and the structural reasoner.

## Layout

```
index.html, css/, js/       the viewer (no build step)
  js/graph.js               triple store, format detection, Turtle family via N3.js
  js/rdfxml.js              RDF/XML parser
  js/functional.js          OWL Functional Syntax parser
  js/model.js               entities, Manchester syntax, metrics
  js/reasoner.js            structural reasoner
  js/cram.js                in-browser generation from GitHub (Pyodide)
  js/app.js                 user interface
generator/cram_ontology.py  CRAM → OWL generator (standard library only)
vendor/n3.min.js            N3.js 2.7.12 (MIT)
tests/                      generator tests (unittest) and browser tests
```

## License

MIT. The generated CRAM ontology describes CRAM's code, which is LGPL-3.0.
