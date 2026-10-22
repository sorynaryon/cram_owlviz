/* OWL 2 Functional-Style Syntax parser (the format of e.g. SOMA's and DUL's .owl files), mapped to RDF triples
 * following the W3C "OWL 2 Mapping to RDF Graphs". Axiom annotations are dropped; SWRL rules are skipped.
 *
 * OWLViz.parseFunctional(text, emit, onPrefix, bnodePrefix)
 */
(function (NS) {
  "use strict";
  const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
  const OWL = "http://www.w3.org/2002/07/owl#";
  const XSD = "http://www.w3.org/2001/XMLSchema#";
  const TYPE = RDF + "type";

  // ---- tokens and s-expressions
  const TOKEN = /\s+|#[^\n]*|(<[^>\s]*>)|("(?:[^"\\]|\\.)*")(?:\^\^(<[^>\s]*>|[^\s()]*:[^\s()]*)|@([A-Za-z0-9-]+))?|([()])|(_:[^\s()]+)|([^\s()"<]+)/gy;

  function parseTree(text, expand) {
    const root = [];
    const stack = [root];
    let m;
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < text.length && (m = TOKEN.exec(text))) {
      if (!m[1] && !m[2] && !m[5] && !m[6] && !m[7]) continue; // whitespace or comment
      const top = stack[stack.length - 1];
      if (m[5] === "(") {
        // a keyword before "(" names the expression; a bare group, as in HasKey(C (p q) ()), has no head
        const last = top[top.length - 1];
        const keyword = last && last.word !== undefined && !last.word.includes(":");
        const list = { head: keyword ? top.pop() : null, args: [] };
        top.push(list);
        stack.push(list.args);
      } else if (m[5] === ")") {
        if (stack.length > 1) stack.pop();
      } else if (m[1]) top.push({ iri: m[1].slice(1, -1) });
      else if (m[2]) {
        const v = m[2].slice(1, -1).replace(/\\(["\\])/g, "$1");
        const lit = { v };
        if (m[3]) lit.dt = m[3][0] === "<" ? m[3].slice(1, -1) : expand(m[3]);
        else if (m[4]) lit.lang = m[4].toLowerCase();
        if (lit.dt === XSD + "string") delete lit.dt;
        top.push({ lit });
      } else if (m[6]) top.push({ bnode: m[6].slice(2) });
      else if (m[7]) top.push({ word: m[7] });
    }
    return root;
  }

  NS.parseFunctional = function (text, emit, onPrefix, bnodePrefix) {
    const prefixes = new Map([["owl", OWL], ["rdf", RDF], ["rdfs", RDFS], ["xsd", XSD]]);
    // Prefix(name:=<iri>) declarations, then remove them so the rest is plain s-expressions
    const body = text.replace(/Prefix\(\s*([^\s=]*)\s*=\s*<([^>]*)>\s*\)/g, (_, p, iri) => {
      const name = p.replace(/:$/, "");
      prefixes.set(name, iri);
      if (onPrefix) onPrefix(name, iri);
      return "";
    });
    const expand = (w) => {
      const i = w.indexOf(":");
      if (i < 0) return w;
      const ns = prefixes.get(w.slice(0, i));
      return ns === undefined ? w : ns + w.slice(i + 1);
    };
    const pre = bnodePrefix || "_:f";
    let counter = 0;
    const fresh = () => pre + "g" + counter++;
    const named = (id) => pre + "n" + id.replace(/[^\w-]/g, "_");

    const tree = parseTree(body, expand);
    const ontology = tree.find((x) => x.head && x.head.word === "Ontology");
    if (!ontology) throw new Error("No Ontology(...) found in the OWL Functional Syntax document.");

    const word = (x) => x && x.word;
    const isList = (x) => x && x.head !== undefined;
    const headOf = (x) => isList(x) && word(x.head);
    const term = (x) => {
      if (!x) throw new Error("Unexpected end of an axiom.");
      if (x.iri !== undefined) return x.iri;
      if (x.bnode !== undefined) return named(x.bnode);
      if (x.lit) return x.lit;
      if (x.word !== undefined) return expand(x.word);
      return expr(x);
    };
    const list = (items) => {
      let head = RDF + "nil";
      for (let i = items.length - 1; i >= 0; i--) {
        const n = fresh();
        emit(n, RDF + "first", items[i]);
        emit(n, RDF + "rest", head);
        head = n;
      }
      return head;
    };
    const withoutAnnotations = (args) => args.filter((a) => !(isList(a) && headOf(a) === "Annotation"));
    const cardinality = (n) => ({ v: String(n.word !== undefined ? n.word : n.lit ? n.lit.v : n), dt: XSD + "nonNegativeInteger" });

    function restriction(p, pairs) {
      const n = fresh();
      emit(n, TYPE, OWL + "Restriction");
      emit(n, OWL + "onProperty", term(p));
      for (const [pred, o] of pairs) emit(n, pred, o);
      return n;
    }
    function nary(type, pred, items) {
      const n = fresh();
      emit(n, TYPE, type);
      emit(n, pred, list(items.map(term)));
      return n;
    }
    function card(args, plain, qualified, onWhat) {
      const [n, p, filler] = args;
      return filler !== undefined
        ? restriction(p, [[OWL + qualified, cardinality(n)], [OWL + onWhat, term(filler)]])
        : restriction(p, [[OWL + plain, cardinality(n)]]);
    }

    function expr(x) {
      const h = headOf(x), a = x.args;
      switch (h) {
        case "ObjectIntersectionOf": return nary(OWL + "Class", OWL + "intersectionOf", a);
        case "ObjectUnionOf": return nary(OWL + "Class", OWL + "unionOf", a);
        case "ObjectComplementOf": { const n = fresh(); emit(n, TYPE, OWL + "Class"); emit(n, OWL + "complementOf", term(a[0])); return n; }
        case "ObjectOneOf": return nary(OWL + "Class", OWL + "oneOf", a);
        case "ObjectSomeValuesFrom": case "DataSomeValuesFrom": return restriction(a[0], [[OWL + "someValuesFrom", term(a[a.length - 1])]]);
        case "ObjectAllValuesFrom": case "DataAllValuesFrom": return restriction(a[0], [[OWL + "allValuesFrom", term(a[a.length - 1])]]);
        case "ObjectHasValue": case "DataHasValue": return restriction(a[0], [[OWL + "hasValue", term(a[1])]]);
        case "ObjectHasSelf": return restriction(a[0], [[OWL + "hasSelf", { v: "true", dt: XSD + "boolean" }]]);
        case "ObjectMinCardinality": return card(a, "minCardinality", "minQualifiedCardinality", "onClass");
        case "ObjectMaxCardinality": return card(a, "maxCardinality", "maxQualifiedCardinality", "onClass");
        case "ObjectExactCardinality": return card(a, "cardinality", "qualifiedCardinality", "onClass");
        case "DataMinCardinality": return card(a, "minCardinality", "minQualifiedCardinality", "onDataRange");
        case "DataMaxCardinality": return card(a, "maxCardinality", "maxQualifiedCardinality", "onDataRange");
        case "DataExactCardinality": return card(a, "cardinality", "qualifiedCardinality", "onDataRange");
        case "ObjectInverseOf": { const n = fresh(); emit(n, OWL + "inverseOf", term(a[0])); return n; }
        case "DataIntersectionOf": return nary(RDFS + "Datatype", OWL + "intersectionOf", a);
        case "DataUnionOf": return nary(RDFS + "Datatype", OWL + "unionOf", a);
        case "DataComplementOf": { const n = fresh(); emit(n, TYPE, RDFS + "Datatype"); emit(n, OWL + "datatypeComplementOf", term(a[0])); return n; }
        case "DataOneOf": return nary(RDFS + "Datatype", OWL + "oneOf", a);
        case "DatatypeRestriction": {
          const n = fresh();
          emit(n, TYPE, RDFS + "Datatype");
          emit(n, OWL + "onDatatype", term(a[0]));
          const facets = [];
          for (let i = 1; i + 1 < a.length; i += 2) { const f = fresh(); emit(f, term(a[i]), term(a[i + 1])); facets.push(f); }
          emit(n, OWL + "withRestrictions", list(facets));
          return n;
        }
        default: throw new Error(`Unknown expression ${h || JSON.stringify(x)}`);
      }
    }

    const DECLARATIONS = { Class: OWL + "Class", ObjectProperty: OWL + "ObjectProperty", DataProperty: OWL + "DatatypeProperty",
      AnnotationProperty: OWL + "AnnotationProperty", NamedIndividual: OWL + "NamedIndividual", Datatype: RDFS + "Datatype" };
    const CHARACTERISTICS = { FunctionalObjectProperty: "FunctionalProperty", FunctionalDataProperty: "FunctionalProperty",
      InverseFunctionalObjectProperty: "InverseFunctionalProperty", ReflexiveObjectProperty: "ReflexiveProperty",
      IrreflexiveObjectProperty: "IrreflexiveProperty", SymmetricObjectProperty: "SymmetricProperty",
      AsymmetricObjectProperty: "AsymmetricProperty", TransitiveObjectProperty: "TransitiveProperty" };
    const chain = (pred, items) => { for (let i = 0; i + 1 < items.length; i++) emit(term(items[i]), pred, term(items[i + 1])); };
    const allOf = (type, pred, membersPred, items) => {
      if (items.length === 2) emit(term(items[0]), pred, term(items[1]));
      else if (items.length > 2) { const n = fresh(); emit(n, TYPE, type); emit(n, membersPred, list(items.map(term))); }
    };

    function axiom(x) {
      const h = headOf(x);
      const a = withoutAnnotations(x.args);
      switch (h) {
        case "Declaration": { const d = a[0]; const t = DECLARATIONS[headOf(d)]; if (t) emit(term(d.args[0]), TYPE, t); return; }
        case "SubClassOf": emit(term(a[0]), RDFS + "subClassOf", term(a[1])); return;
        case "EquivalentClasses": chain(OWL + "equivalentClass", a); return;
        case "DisjointClasses": allOf(OWL + "AllDisjointClasses", OWL + "disjointWith", OWL + "members", a); return;
        case "DisjointUnion": emit(term(a[0]), OWL + "disjointUnionOf", list(a.slice(1).map(term))); return;
        case "SubObjectPropertyOf": case "SubDataPropertyOf": case "SubAnnotationPropertyOf":
          if (headOf(a[0]) === "ObjectPropertyChain") emit(term(a[1]), OWL + "propertyChainAxiom", list(a[0].args.map(term)));
          else emit(term(a[0]), RDFS + "subPropertyOf", term(a[1]));
          return;
        case "EquivalentObjectProperties": case "EquivalentDataProperties": chain(OWL + "equivalentProperty", a); return;
        case "DisjointObjectProperties": case "DisjointDataProperties": allOf(OWL + "AllDisjointProperties", OWL + "propertyDisjointWith", OWL + "members", a); return;
        case "InverseObjectProperties": emit(term(a[0]), OWL + "inverseOf", term(a[1])); return;
        case "ObjectPropertyDomain": case "DataPropertyDomain": case "AnnotationPropertyDomain": emit(term(a[0]), RDFS + "domain", term(a[1])); return;
        case "ObjectPropertyRange": case "DataPropertyRange": case "AnnotationPropertyRange": emit(term(a[0]), RDFS + "range", term(a[1])); return;
        case "DatatypeDefinition": emit(term(a[0]), OWL + "equivalentClass", term(a[1])); return;
        case "HasKey": emit(term(a[0]), OWL + "hasKey", list(a.slice(1).flatMap((l) => (isList(l) && l.head === null ? l.args : [l])).map(term))); return;
        case "SameIndividual": chain(OWL + "sameAs", a); return;
        case "DifferentIndividuals": allOf(OWL + "AllDifferent", OWL + "differentFrom", OWL + "members", a); return;
        case "ClassAssertion": emit(term(a[1]), TYPE, term(a[0])); return;
        case "ObjectPropertyAssertion":
          if (headOf(a[0]) === "ObjectInverseOf") emit(term(a[2]), term(a[0].args[0]), term(a[1]));
          else emit(term(a[1]), term(a[0]), term(a[2]));
          return;
        case "DataPropertyAssertion": emit(term(a[1]), term(a[0]), term(a[2])); return;
        case "NegativeObjectPropertyAssertion": case "NegativeDataPropertyAssertion": {
          const n = fresh();
          emit(n, TYPE, OWL + "NegativePropertyAssertion");
          emit(n, OWL + "sourceIndividual", term(a[1]));
          emit(n, OWL + "assertionProperty", term(a[0]));
          emit(n, h === "NegativeObjectPropertyAssertion" ? OWL + "targetIndividual" : OWL + "targetValue", term(a[2]));
          return;
        }
        case "AnnotationAssertion": emit(term(a[1]), term(a[0]), term(a[2])); return;
        default:
          if (CHARACTERISTICS[h]) { emit(term(a[0]), TYPE, OWL + CHARACTERISTICS[h]); return; }
          // DLSafeRule and unknown axioms are skipped
      }
    }

    // Ontology( [iri [versionIRI]] Import(...)* Annotation(...)* axioms* )
    const args = ontology.args;
    let i = 0;
    let ontologyIRI = null;
    if (args[i] && (args[i].iri !== undefined || args[i].word !== undefined)) {
      ontologyIRI = term(args[i++]);
      emit(ontologyIRI, TYPE, OWL + "Ontology");
      if (args[i] && (args[i].iri !== undefined || args[i].word !== undefined)) emit(ontologyIRI, OWL + "versionIRI", term(args[i++]));
    } else {
      ontologyIRI = fresh();
      emit(ontologyIRI, TYPE, OWL + "Ontology");
    }
    for (; i < args.length; i++) {
      const x = args[i];
      const h = headOf(x);
      if (h === "Import") emit(ontologyIRI, OWL + "imports", term(x.args[0]));
      else if (h === "Annotation") { const a = withoutAnnotations(x.args); emit(ontologyIRI, term(a[0]), term(a[1])); }
      else if (h) {
        try { axiom(x); } catch (e) { /* a malformed axiom does not stop the rest */ }
      }
    }
  };
})(window.OWLViz = window.OWLViz || {});
