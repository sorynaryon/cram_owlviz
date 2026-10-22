/* From triples to an OWL entity model: entity kinds, labels, annotations, Manchester-syntax
 * renderings of all axioms, usage, metrics, and a structural (told + definition-based) inferred hierarchy.
 */
(function (NS) {
  "use strict";
  const { isLit, isBNode, isIRI } = NS;
  const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
  const OWL = "http://www.w3.org/2002/07/owl#";
  const XSD = "http://www.w3.org/2001/XMLSchema#";
  const SKOS = "http://www.w3.org/2004/02/skos/core#";
  const DC = "http://purl.org/dc/elements/1.1/";
  const DCT = "http://purl.org/dc/terms/";
  const OBO = "http://purl.obolibrary.org/obo/";
  const OIO = "http://www.geneontology.org/formats/oboInOwl#";
  const TYPE = RDF + "type";
  const THING = OWL + "Thing";

  const V = {
    label: RDFS + "label", comment: RDFS + "comment", seeAlso: RDFS + "seeAlso", isDefinedBy: RDFS + "isDefinedBy",
    prefLabel: SKOS + "prefLabel", altLabel: SKOS + "altLabel", definition: SKOS + "definition",
    iaoDefinition: OBO + "IAO_0000115", exactSynonym: OIO + "hasExactSynonym", relatedSynonym: OIO + "hasRelatedSynonym",
    narrowSynonym: OIO + "hasNarrowSynonym", broadSynonym: OIO + "hasBroadSynonym",
    deprecated: OWL + "deprecated", versionInfo: OWL + "versionInfo", versionIRI: OWL + "versionIRI", imports: OWL + "imports",
    dcTitle: DC + "title", dctTitle: DCT + "title", dcDescription: DC + "description", dctDescription: DCT + "description",
    dctLicense: DCT + "license", dcRights: DC + "rights", dctRights: DCT + "rights", dcCreator: DC + "creator", dctCreator: DCT + "creator",
    exactMatch: SKOS + "exactMatch", closeMatch: SKOS + "closeMatch", broadMatch: SKOS + "broadMatch", narrowMatch: SKOS + "narrowMatch", relatedMatch: SKOS + "relatedMatch",
  };
  const DESCRIPTION_PROPS = [V.comment, V.definition, V.iaoDefinition, V.dctDescription, V.dcDescription];
  const SYNONYM_PROPS = [V.altLabel, V.exactSynonym, V.relatedSynonym, V.narrowSynonym, V.broadSynonym];
  const MAPPING_PROPS = [V.exactMatch, V.closeMatch, V.broadMatch, V.narrowMatch, V.relatedMatch];
  NS.V = V;
  NS.DESCRIPTION_PROPS = DESCRIPTION_PROPS;
  NS.SYNONYM_PROPS = SYNONYM_PROPS;
  NS.MAPPING_PROPS = MAPPING_PROPS;
  NS.NAMESPACES = { RDF, RDFS, OWL, XSD, SKOS, DC, DCT, OBO, OIO };

  const DEFAULT_PREFIXES = [
    ["owl", OWL], ["rdf", RDF], ["rdfs", RDFS], ["xsd", XSD], ["skos", SKOS], ["dc", DC], ["dcterms", DCT],
    ["obo", OBO], ["oboInOwl", OIO], ["foaf", "http://xmlns.com/foaf/0.1/"], ["prov", "http://www.w3.org/ns/prov#"],
    ["time", "http://www.w3.org/2006/time#"], ["vann", "http://purl.org/vocab/vann/"], ["schema", "https://schema.org/"],
    ["sh", "http://www.w3.org/ns/shacl#"], ["dul", "http://www.ontologydesignpatterns.org/ont/dul/DUL.owl#"],
    ["soma", "http://www.ease-crc.org/ont/SOMA.owl#"], ["qudt", "http://qudt.org/schema/qudt/"], ["unit", "http://qudt.org/vocab/unit/"],
  ];
  const BUILTIN = [OWL, RDF, RDFS, XSD];
  const isBuiltin = (iri) => BUILTIN.some((ns) => iri.startsWith(ns));
  const ANNOTATION_NS = [RDFS, SKOS, DC, DCT, OIO, "http://purl.org/vocab/vann/", "http://www.w3.org/ns/prov#", "http://xmlns.com/foaf/0.1/"];
  const isAnnotationNs = (iri) => ANNOTATION_NS.some((ns) => iri.startsWith(ns)) || /^http:\/\/purl\.obolibrary\.org\/obo\/IAO_/.test(iri);

  const KIND_TYPES = {
    [OWL + "Class"]: "class", [RDFS + "Class"]: "class", [OWL + "Restriction"]: null,
    [OWL + "ObjectProperty"]: "op", [OWL + "DatatypeProperty"]: "dp", [OWL + "AnnotationProperty"]: "ap",
    [OWL + "NamedIndividual"]: "ind", [RDF + "Property"]: "prop", [OWL + "FunctionalProperty"]: "prop",
    [OWL + "InverseFunctionalProperty"]: "op", [OWL + "TransitiveProperty"]: "op", [OWL + "SymmetricProperty"]: "op",
    [OWL + "AsymmetricProperty"]: "op", [OWL + "ReflexiveProperty"]: "op", [OWL + "IrreflexiveProperty"]: "op",
  };
  const KIND_RANK = { class: 0, op: 1, dp: 2, ap: 3, prop: 4, ind: 5 };
  NS.KIND_TYPES = KIND_TYPES;
  const CHARACTERISTICS = [
    [OWL + "FunctionalProperty", "Functional"], [OWL + "InverseFunctionalProperty", "Inverse functional"],
    [OWL + "TransitiveProperty", "Transitive"], [OWL + "SymmetricProperty", "Symmetric"], [OWL + "AsymmetricProperty", "Asymmetric"],
    [OWL + "ReflexiveProperty", "Reflexive"], [OWL + "IrreflexiveProperty", "Irreflexive"],
  ];
  const STRUCTURAL = new Set([TYPE, RDFS + "subClassOf", OWL + "equivalentClass", OWL + "disjointWith", RDFS + "subPropertyOf",
    RDFS + "domain", RDFS + "range", OWL + "inverseOf", OWL + "equivalentProperty", OWL + "propertyChainAxiom",
    OWL + "propertyDisjointWith", OWL + "sameAs", OWL + "differentFrom", OWL + "imports", OWL + "versionIRI",
    OWL + "disjointUnionOf", OWL + "hasKey", OWL + "members", OWL + "distinctMembers", RDF + "first", RDF + "rest"]);

  // ---- prefixes ------------------------------------------------------------------
  class Prefixes {
    constructor() { this.byPrefix = new Map(); this.byNs = new Map(); this.cache = new Map(); }
    add(p, ns) {
      if (!ns || p === undefined || p === null) return;
      const have = this.byNs.get(ns);
      if (have !== undefined) {
        if (have === "" && p !== "" && !this.byPrefix.has(p)) { this.byPrefix.delete(""); this.byPrefix.set(p, ns); this.byNs.set(ns, p); this.cache.clear(); }
        return;
      }
      let q = p;
      if (this.byPrefix.has(q)) {
        let i = 2;
        while (this.byPrefix.has(q + i)) i++;
        q = q + i;
      }
      this.byPrefix.set(q, ns);
      this.byNs.set(ns, q);
      this.cache.clear();
    }
    static split(iri) {
      const m = iri.match(/^(.*[#/:])([^#/:]*)$/);
      return m ? [m[1], m[2]] : [iri, ""];
    }
    curie(iri) {
      if (this.cache.has(iri)) return this.cache.get(iri);
      let out = null;
      const [ns, local] = Prefixes.split(iri);
      const ok = (l) => /^[^\s()<>"{}|\\^`,;[\]]*$/.test(l);
      if (this.byNs.has(ns) && ok(local)) out = [this.byNs.get(ns), local];
      else {
        let best = "";
        for (const n of this.byNs.keys()) if (n.length > best.length && iri.startsWith(n) && ok(iri.slice(n.length)) && !/[#/]/.test(iri.slice(n.length))) best = n;
        if (best) out = [this.byNs.get(best), iri.slice(best.length)];
      }
      this.cache.set(iri, out);
      return out;
    }
    expand(c) {
      const m = /^([^:/#]*):(.*)$/.exec(c);
      if (!m || !this.byPrefix.has(m[1])) return null;
      return this.byPrefix.get(m[1]) + m[2];
    }
    entries() { return Array.from(this.byPrefix.entries()).sort((a, b) => a[0].localeCompare(b[0])); }
  }
  NS.Prefixes = Prefixes;

  function autoPrefix(ns, taken) {
    let base = ns.replace(/[#/:]+$/, "").split(/[#/:]/).pop() || "ns";
    base = base.replace(/\.(owl|rdf|ttl|xml|nt|n3|jsonld|ofn|owx)$/i, "").replace(/[^A-Za-z0-9_-]/g, "").toLowerCase();
    if (!base || /^[0-9-]/.test(base) || base.length > 16) base = "ns";
    let p = base, i = 2;
    while (taken.has(p)) p = base + i++;
    return p;
  }

  // ---- Manchester rendering -------------------------------------------------------------
  // Tokens: plain strings, {r: iri} entity refs, {k: keyword}, {l: literal text}.
  class Renderer {
    constructor(g, curie) { this.g = g; this.curie = curie; }
    literal(lit) {
      const v = lit.v;
      if (lit.lang) return `"${v}"@${lit.lang}`;
      if (lit.dt) {
        const plain = [XSD + "double", XSD + "integer", XSD + "float", XSD + "decimal", XSD + "nonNegativeInteger", XSD + "positiveInteger", XSD + "int", XSD + "long", XSD + "boolean"];
        return plain.includes(lit.dt) ? v : `"${v}"^^${this.curie(lit.dt)}`;
      }
      return `"${v}"`;
    }
    ref(node, depth = 0) {
      if (isLit(node)) return [{ l: this.literal(node) }];
      if (isIRI(node)) return [{ r: node }];
      return this.expr(node, depth);
    }
    wrap(node, depth) {
      const sub = this.ref(node, depth + 1);
      return isBNode(node) && sub.length > 1 ? ["(", ...sub, ")"] : sub;
    }
    join(items, kw, depth) {
      const out = [];
      items.forEach((it, i) => { if (i) out.push(" ", { k: kw }, " "); out.push(...this.wrap(it, depth)); });
      return out;
    }
    prop(node, depth) {
      if (isBNode(node)) {
        const inv = this.g.value(node, OWL + "inverseOf");
        if (inv !== undefined) return [{ k: "inverse" }, " ", ...this.ref(inv, depth + 1)];
      }
      return this.ref(node, depth + 1);
    }
    expr(node, depth = 0) {
      const g = this.g;
      if (isIRI(node)) return [{ r: node }];
      if (depth > 30) return ["…"];
      let v;
      if ((v = g.value(node, OWL + "intersectionOf")) !== undefined) return this.join(g.list(v), "and", depth);
      if ((v = g.value(node, OWL + "unionOf")) !== undefined) return this.join(g.list(v), "or", depth);
      if ((v = g.value(node, OWL + "complementOf")) !== undefined || (v = g.value(node, OWL + "datatypeComplementOf")) !== undefined) return [{ k: "not" }, " ", ...this.wrap(v, depth)];
      if ((v = g.value(node, OWL + "oneOf")) !== undefined) {
        const out = ["{"];
        g.list(v).forEach((it, i) => { if (i) out.push(", "); out.push(...this.ref(it, depth + 1)); });
        return [...out, "}"];
      }
      const p = g.value(node, OWL + "onProperty");
      if (p !== undefined) {
        const pr = this.prop(p, depth);
        for (const [pred, kw] of [[OWL + "someValuesFrom", "some"], [OWL + "allValuesFrom", "only"], [OWL + "hasValue", "value"]]) {
          const f = g.value(node, pred);
          if (f !== undefined) return [...pr, " ", { k: kw }, " ", ...this.wrap(f, depth)];
        }
        if (g.value(node, OWL + "hasSelf") !== undefined) return [...pr, " ", { k: "Self" }];
        for (const [pred, kw] of [["minCardinality", "min"], ["maxCardinality", "max"], ["cardinality", "exactly"],
          ["minQualifiedCardinality", "min"], ["maxQualifiedCardinality", "max"], ["qualifiedCardinality", "exactly"]]) {
          const n = g.value(node, OWL + pred);
          if (n !== undefined) {
            const out = [...pr, " ", { k: kw }, " " + (isLit(n) ? n.v : n)];
            const f = g.value(node, OWL + "onClass") || g.value(node, OWL + "onDataRange");
            if (f !== undefined) out.push(" ", ...this.wrap(f, depth));
            return out;
          }
        }
      }
      const dt = g.value(node, OWL + "onDatatype");
      if (dt !== undefined) {
        const facets = [];
        for (const f of g.list(g.value(node, OWL + "withRestrictions"))) {
          for (const [fp, fos] of g.predicates(f)) for (const fo of fos) {
            const name = fp.replace(XSD, "");
            const sym = { minInclusive: ">=", maxInclusive: "<=", minExclusive: ">", maxExclusive: "<" }[name] || name;
            facets.push(`${sym} ${isLit(fo) ? fo.v : fo}`);
          }
        }
        return [...this.ref(dt, depth + 1), `[${facets.join(", ")}]`];
      }
      if ((v = g.value(node, OWL + "inverseOf")) !== undefined) return [{ k: "inverse" }, " ", ...this.ref(v, depth + 1)];
      return this.describe(node, depth);
    }
    // an anonymous individual, e.g. an inline quantity value: [Type; p v; ...]
    describe(node, depth) {
      const parts = [];
      for (const [p, os] of this.g.predicates(node)) {
        for (const o of os) {
          if (p === TYPE) { if (o !== OWL + "NamedIndividual") parts.push(this.ref(o, depth + 1)); continue; }
          if (p === RDF + "first" || p === RDF + "rest") continue;
          parts.push([...this.ref(p, depth + 1), " ", ...this.ref(o, depth + 1)]);
        }
      }
      const out = ["["];
      parts.forEach((part, i) => { if (i) out.push("; "); out.push(...part); });
      return [...out, "]"];
    }
  }
  NS.Renderer = Renderer;

  // ---- model ---------------------------------------------------------------------------------
  /* docs: [{name, url, format, role, subjects:Set, declared:Set, ontologies:[], prefixes:[[p, ns]]}] */
  NS.buildModel = function (g, docs, options = {}) {
    const t0 = performance.now();
    const langs = options.languages || ["en"];

    // prefixes: document declarations win over defaults
    const prefixes = new Prefixes();
    for (const d of docs) for (const [p, ns] of d.prefixes) prefixes.add(p, ns);
    for (const [p, ns] of DEFAULT_PREFIXES) if (!prefixes.byPrefix.has(p)) prefixes.add(p, ns);

    // document roles: a document is an import if another loaded document imports its ontology
    for (const d of docs) {
      d.imports = [];
      for (const o of d.ontologies) for (const i of g.objects(o, V.imports)) if (isIRI(i)) d.imports.push(i);
      d.versionIRIs = d.ontologies.map((o) => g.value(o, V.versionIRI)).filter(isIRI);
    }
    for (const d of docs) {
      const ids = new Set([...d.ontologies, ...d.versionIRIs]);
      d.isImport = d.role === "import" || docs.some((o) => o !== d && o.imports.some((i) => ids.has(i)));
    }
    if (docs.length && docs.every((d) => d.isImport)) docs[0].isImport = false;
    const primary = docs.filter((d) => !d.isImport);
    const ontologyIRIs = new Set(docs.flatMap((d) => d.ontologies));

    // ---- entity kinds
    const kind = new Map();
    const declared = new Set();
    const setKind = (iri, k) => {
      if (!isIRI(iri) || isBuiltin(iri) || ontologyIRIs.has(iri)) return;
      const cur = kind.get(iri);
      if (cur === undefined || (cur === "prop" && (k === "op" || k === "dp" || k === "ap")) || (KIND_RANK[k] < KIND_RANK[cur] && cur !== "prop" && k !== "prop")) kind.set(iri, k);
    };
    const datatypes = new Set(g.subjects(TYPE, RDFS + "Datatype"));
    const isDatatype = (x) => isIRI(x) && (x.startsWith(XSD) || x === RDFS + "Literal" || x === RDF + "PlainLiteral" || x === RDF + "langString" || x === RDF + "XMLLiteral" || datatypes.has(x));

    for (const [t, k] of Object.entries(KIND_TYPES)) {
      if (!k) continue;
      for (const s of g.subjects(TYPE, t)) if (isIRI(s)) { setKind(s, k); declared.add(s); }
    }
    // usage positions of undeclared terms
    const classPos = (x) => { if (isIRI(x) && !isDatatype(x) && !kind.has(x)) setKind(x, "class"); };
    for (const p of ["subClassOf", "equivalentClass", "disjointWith"]) {
      const pred = (p === "subClassOf" ? RDFS : OWL) + p;
      for (const [s, m] of g.spo) for (const o of m.get(pred) || []) { classPos(s); classPos(o); }
    }
    for (const [s, m] of g.spo) {
      for (const pred of [OWL + "intersectionOf", OWL + "unionOf", OWL + "disjointUnionOf"]) for (const l of m.get(pred) || []) g.list(l).forEach(classPos);
      for (const l of m.get(OWL + "members") || []) if (g.has(s, TYPE, OWL + "AllDisjointClasses")) g.list(l).forEach(classPos);
      for (const o of m.get(OWL + "complementOf") || []) classPos(o);
      for (const o of m.get(OWL + "onClass") || []) classPos(o);
      for (const o of m.get(TYPE) || []) if (!isBuiltin(o)) classPos(o);
      const onP = m.get(OWL + "onProperty");
      if (onP) {
        const dataish = [OWL + "someValuesFrom", OWL + "allValuesFrom"].some((q) => (m.get(q) || []).some(isDatatype)) ||
          (m.get(OWL + "hasValue") || []).some(isLit) || m.has(OWL + "onDataRange");
        for (const p of onP) if (isIRI(p) && !kind.has(p)) setKind(p, dataish ? "dp" : "op");
        if (!dataish) for (const q of [OWL + "someValuesFrom", OWL + "allValuesFrom"]) for (const f of m.get(q) || []) classPos(f);
      }
    }
    const propPos = (x) => { if (isIRI(x) && !kind.has(x)) setKind(x, "prop"); };
    for (const [s, m] of g.spo) {
      for (const pred of [RDFS + "subPropertyOf", OWL + "equivalentProperty", OWL + "inverseOf"]) for (const o of m.get(pred) || []) { propPos(s); propPos(o); }
      for (const l of m.get(OWL + "propertyChainAxiom") || []) g.list(l).forEach(propPos);
    }
    for (const [s, m] of g.spo) {
      if (!isIRI(s) || kind.get(s) !== "op" && kind.get(s) !== "prop" && kind.get(s) !== "dp") continue;
      for (const o of m.get(RDFS + "domain") || []) classPos(o);
      if (kind.get(s) !== "dp") for (const o of m.get(RDFS + "range") || []) classPos(o);
    }
    // individuals: typed by a class, or named in hasValue / oneOf / sameAs / differentFrom
    for (const [s, m] of g.spo) {
      if (!isIRI(s) || kind.has(s) || ontologyIRIs.has(s) || isBuiltin(s)) continue;
      if ((m.get(TYPE) || []).some((t) => !isBuiltin(t) || t === OWL + "Thing")) setKind(s, "ind");
    }
    for (const [s, m] of g.spo) {
      for (const o of m.get(OWL + "hasValue") || []) if (isIRI(o) && !kind.has(o)) setKind(o, "ind");
      for (const l of m.get(OWL + "oneOf") || []) for (const o of g.list(l)) if (isIRI(o) && !kind.has(o)) setKind(o, "ind");
      for (const pred of [OWL + "sameAs", OWL + "differentFrom"]) for (const o of m.get(pred) || []) { if (!kind.has(s)) setKind(s, "ind"); if (!kind.has(o)) setKind(o, "ind"); }
      for (const pred of [OWL + "distinctMembers", OWL + "members"]) for (const l of m.get(pred) || []) if (g.has(s, TYPE, OWL + "AllDifferent")) for (const o of g.list(l)) if (!kind.has(o)) setKind(o, "ind");
    }
    // predicates used on individuals are object/data properties, on everything else annotation properties
    for (const [s, m] of g.spo) {
      if (!isIRI(s)) continue;
      const sk = kind.get(s);
      for (const [p, os] of m) {
        if (STRUCTURAL.has(p) || isBuiltin(p)) continue;
        if (sk === "ind" && !isAnnotationNs(p)) {
          if (!kind.has(p) || kind.get(p) === "prop") setKind(p, os.some(isLit) ? "dp" : "op");
          if (kind.get(p) === "op") for (const o of os) if (isIRI(o) && !kind.has(o)) setKind(o, "ind");
        } else if (!kind.has(p)) setKind(p, "ap");
      }
    }
    for (const [iri, k] of kind) if (k === "prop") kind.set(iri, "op"); // untyped rdf:Property / owl:FunctionalProperty without literal values

    // ---- locality: declared in a main document, or (undeclared) in a namespace of the main documents
    const declaredIn = new Map();
    docs.forEach((d, i) => { for (const s of d.declared) { if (!declaredIn.has(s)) declaredIn.set(s, []); declaredIn.get(s).push(i); } });
    const docLabel = (d) => d.title || d.name;
    const localNs = new Set(), importNs = new Map();
    for (const [iri, ds] of declaredIn) {
      const ns = Prefixes.split(iri)[0];
      if (ds.some((i) => !docs[i].isImport)) localNs.add(ns);
      else if (!importNs.has(ns)) importNs.set(ns, docs[ds[0]]);
    }
    for (const d of primary) for (const o of d.ontologies) { localNs.add(o + "#"); localNs.add(o + "/"); }

    // ---- labels
    const pickLiteral = (lits) => {
      if (!lits.length) return null;
      for (const l of langs) { const hit = lits.find((x) => x.lang && (x.lang === l || x.lang.split("-")[0] === l)); if (hit) return hit.v; }
      const plain = lits.find((x) => !x.lang);
      return (plain || lits[0]).v;
    };
    // a label in the user's language (rdfs:label before skos:prefLabel), then an untagged one, then any
    const labelOf = (iri) => {
      const labels = g.objects(iri, V.label).filter(isLit), preferred = g.objects(iri, V.prefLabel).filter(isLit);
      for (const l of langs) {
        const hit = [...labels, ...preferred].find((x) => x.lang && (x.lang === l || x.lang.split("-")[0] === l));
        if (hit) return hit.v;
      }
      return pickLiteral(labels) || pickLiteral(preferred);
    };

    const E = Object.create(null);
    for (const [iri, k] of kind) {
      const cur = prefixes.curie(iri);
      const ds = declaredIn.get(iri) || [];
      const ns = Prefixes.split(iri)[0];
      let local, module, imported;
      if (ds.length) {
        const pd = ds.find((i) => !docs[i].isImport);
        imported = pd === undefined;
        module = docLabel(docs[pd === undefined ? ds[0] : pd]);
      } else {
        imported = !localNs.has(ns);
        module = imported ? (importNs.has(ns) ? docLabel(importNs.get(ns)) : "not declared") : docLabel(primary[0] || docs[0]);
      }
      const definedBy = g.objects(iri, V.isDefinedBy).find(isIRI);
      if (definedBy) module = labelOf(definedBy) || Prefixes.split(definedBy.replace(/[#/]$/, ""))[1] || module;
      local = cur ? cur[1] : Prefixes.split(iri)[1] || iri;
      E[iri] = {
        id: iri, iri, kind: k, label: labelOf(iri), prefix: cur ? cur[0] : null, local: local || iri,
        module, imported, undeclared: !declared.has(iri), deprecated: g.objects(iri, V.deprecated).some((o) => isLit(o) && /^(true|1)$/.test(o.v)),
      };
    }
    // prefixes for frequent namespaces that have none
    const needNs = new Map();
    for (const e of Object.values(E)) if (e.prefix === null) { const ns = Prefixes.split(e.iri)[0]; needNs.set(ns, (needNs.get(ns) || 0) + 1); }
    for (const [ns] of [...needNs].sort((a, b) => b[1] - a[1])) {
      if (ns.length < 8) continue;
      prefixes.add(autoPrefix(ns, prefixes.byPrefix), ns);
    }
    for (const e of Object.values(E)) if (e.prefix === null) { const c = prefixes.curie(e.iri); if (c) { e.prefix = c[0]; e.local = c[1] || e.local; } }
    const curie = (iri) => { const c = prefixes.curie(iri); return c ? (c[0] + ":" + c[1]) : iri; };
    const R = new Renderer(g, curie);
    const isEnt = (x) => isIRI(x) && E[x] !== undefined;

    // ---- annotations
    for (const e of Object.values(E)) {
      const out = [];
      for (const [p, os] of g.predicates(e.iri)) {
        if (STRUCTURAL.has(p)) continue;
        const pk = kind.get(p);
        if (e.kind === "ind" && pk !== "ap" && !isAnnotationNs(p) && (pk === "op" || pk === "dp")) continue; // a property assertion, not an annotation
        for (const o of os) {
          if (isBNode(o)) continue;
          out.push(isLit(o) ? { p, v: o.v, lang: o.lang || null, dt: o.dt || null } : { p, v: o, iri: true });
        }
      }
      const order = { [V.label]: 0, [V.prefLabel]: 0, [V.altLabel]: 1, [V.comment]: 2, [V.definition]: 2, [V.iaoDefinition]: 2 };
      out.sort((a, b) => (order[a.p] ?? 9) - (order[b.p] ?? 9) || a.p.localeCompare(b.p) || a.v.localeCompare(b.v));
      e.ann = out;
    }

    const namedObjs = (s, p) => g.objects(s, p).filter((o) => isIRI(o) && (isEnt(o) || o === THING));
    const uniq = (xs) => Array.from(new Set(xs));

    // ---- classes (asserted)
    const classes = Object.values(E).filter((e) => e.kind === "class");
    for (const e of classes) {
      const sup = g.objects(e.iri, RDFS + "subClassOf");
      e.supA = uniq(sup.filter(isEnt)).filter((x) => x !== e.iri);
      e.supAnon = sup.filter(isBNode).map((o) => R.expr(o));
      e.equiv = g.objects(e.iri, OWL + "equivalentClass").filter((o) => o !== e.iri).map((o) => R.ref(o));
      e.disj = uniq(g.objects(e.iri, OWL + "disjointWith").concat(g.subjects(OWL + "disjointWith", e.iri)).filter(isIRI));
      e.disjUnion = g.objects(e.iri, OWL + "disjointUnionOf").map((l) => g.list(l).filter(isIRI));
      e.keys = g.objects(e.iri, OWL + "hasKey").map((l) => g.list(l).filter(isIRI));
    }
    for (const s of g.subjects(TYPE, OWL + "AllDisjointClasses")) {
      const ms = g.list(g.value(s, OWL + "members")).filter(isIRI);
      for (const m of ms) if (E[m] && E[m].kind === "class") E[m].disj = uniq([...E[m].disj, ...ms.filter((x) => x !== m)]);
    }

    // ---- properties
    for (const e of Object.values(E).filter((x) => x.kind === "op" || x.kind === "dp" || x.kind === "ap")) {
      e.supP = uniq(g.objects(e.iri, RDFS + "subPropertyOf").filter(isEnt)).filter((x) => x !== e.iri);
      e.domain = g.objects(e.iri, RDFS + "domain").map((o) => R.ref(o));
      e.range = g.objects(e.iri, RDFS + "range").map((o) => R.ref(o));
      e.inverse = uniq(g.objects(e.iri, OWL + "inverseOf").concat(g.subjects(OWL + "inverseOf", e.iri)).filter(isIRI));
      e.chars = CHARACTERISTICS.filter(([t]) => g.has(e.iri, TYPE, t)).map(([, l]) => l);
      e.chains = g.objects(e.iri, OWL + "propertyChainAxiom").map((l) => g.list(l).map((p) => R.ref(p)));
      e.equivP = uniq(g.objects(e.iri, OWL + "equivalentProperty").concat(g.subjects(OWL + "equivalentProperty", e.iri)).filter(isIRI));
      e.disjP = uniq(g.objects(e.iri, OWL + "propertyDisjointWith").concat(g.subjects(OWL + "propertyDisjointWith", e.iri)).filter(isIRI));
    }

    // ---- individuals
    const allDiff = new Map();
    const addDiff = (a, b) => { if (a === b) return; if (!allDiff.has(a)) allDiff.set(a, new Set()); allDiff.get(a).add(b); };
    for (const [s, m] of g.spo) {
      for (const o of m.get(OWL + "differentFrom") || []) { addDiff(s, o); addDiff(o, s); }
      if (g.has(s, TYPE, OWL + "AllDifferent")) {
        for (const pred of [OWL + "distinctMembers", OWL + "members"]) for (const l of m.get(pred) || []) {
          const ms = g.list(l);
          for (const a of ms) for (const b of ms) addDiff(a, b);
        }
      }
    }
    for (const e of Object.values(E).filter((x) => x.kind === "ind")) {
      e.typesA = g.objects(e.iri, TYPE).filter((t) => t !== OWL + "NamedIndividual" && !(isIRI(t) && isBuiltin(t) && t !== THING)).map((t) => R.ref(t));
      const facts = [];
      for (const [p, os] of g.predicates(e.iri)) {
        if (STRUCTURAL.has(p) || !isEnt(p) || E[p].kind === "ap" || isBuiltin(p)) continue;
        for (const o of os) facts.push({ p, kind: E[p].kind, v: R.ref(o), o: isIRI(o) ? o : null });
      }
      facts.sort((a, b) => (a.kind !== "op") - (b.kind !== "op") || a.p.localeCompare(b.p));
      e.facts = facts;
      e.same = uniq(g.objects(e.iri, OWL + "sameAs").concat(g.subjects(OWL + "sameAs", e.iri)).filter(isIRI));
      e.diff = Array.from(allDiff.get(e.iri) || []).filter(isIRI);
    }

    // ---- usage: which named entities reference this one (through blank nodes too)
    const ownerMemo = new Map();
    const ownerOf = (b, depth = 0) => {
      if (isIRI(b)) return b;
      if (ownerMemo.has(b)) return ownerMemo.get(b);
      ownerMemo.set(b, null);
      let r = null;
      if (depth < 40) {
        for (const [, ss] of g.incoming(b)) { for (const s of ss) { r = ownerOf(s, depth + 1); if (r) break; } if (r) break; }
        if (!r) {
          // axiom annotations / AllDisjointClasses etc.: no owner
        }
      }
      ownerMemo.set(b, r);
      return r;
    };
    const usage = new Map();
    const use = (target, by) => { if (target === by) return; let u = usage.get(target); if (!u) usage.set(target, (u = new Set())); u.add(by); };
    for (const [s, m] of g.spo) {
      const owner = ownerOf(s);
      if (!owner || !isEnt(owner)) continue;
      for (const [p, os] of m) {
        if (p === V.imports) continue;
        if (isEnt(p)) use(p, owner);
        for (const o of os) if (isEnt(o)) use(o, owner);
      }
    }
    for (const e of Object.values(E)) {
      const u = usage.get(e.iri);
      e.usedByCount = u ? u.size : 0;
      e.usedBy = u ? Array.from(u).slice(0, 300) : [];
    }

    // instances of each class (asserted types only)
    for (const e of classes) e.members = [];
    for (const e of Object.values(E)) {
      if (e.kind !== "ind") continue;
      for (const t of g.objects(e.iri, TYPE)) if (E[t] && E[t].kind === "class") E[t].members.push(e.iri);
    }
    const reasoning = NS.structuralReasoner(g, E, { allDiff });

    // ---- ontology metadata
    const ontologies = [];
    docs.forEach((d, i) => {
      for (const o of d.ontologies) {
        const lit = (ps) => { for (const p of ps) { const v = pickLiteral(g.objects(o, p).filter(isLit)); if (v) return v; } return null; };
        const iri = (ps) => { for (const p of ps) { const v = g.objects(o, p).find(isIRI); if (v) return v; } return null; };
        const ann = [];
        for (const [p, os] of g.predicates(o)) {
          if (p === TYPE || p === V.imports) continue;
          for (const x of os) if (!isBNode(x)) ann.push(isLit(x) ? { p, v: x.v, lang: x.lang || null } : { p, v: x, iri: true });
        }
        ontologies.push({
          iri: o, doc: i, versionIRI: g.value(o, V.versionIRI) || null,
          version: lit([V.versionInfo]), title: lit([V.dctTitle, V.dcTitle, V.label]),
          description: lit([V.dctDescription, V.dcDescription, V.comment, V.definition]),
          license: iri([V.dctLicense, V.dcRights, V.dctRights]) || lit([V.dctLicense, V.dcRights, V.dctRights]),
          imports: g.objects(o, V.imports).filter(isIRI), ann,
        });
      }
    });

    // ---- metrics
    const count = (p) => { let n = 0; for (const [, m] of g.spo) n += (m.get(p) || []).length; return n; };
    const subNamed = classes.reduce((n, e) => n + e.supA.length, 0);
    const subAnon = classes.reduce((n, e) => n + e.supAnon.length, 0);
    const kinds = { class: 0, op: 0, dp: 0, ap: 0, ind: 0 };
    const kindsLocal = { class: 0, op: 0, dp: 0, ap: 0, ind: 0 };
    for (const e of Object.values(E)) { kinds[e.kind]++; if (!e.imported) kindsLocal[e.kind]++; }
    let factCount = 0;
    for (const e of Object.values(E)) if (e.kind === "ind") factCount += e.facts.length;
    const constructs = [
      ["some (∃)", count(OWL + "someValuesFrom")], ["only (∀)", count(OWL + "allValuesFrom")], ["value", count(OWL + "hasValue")],
      ["min / max / exactly", count(OWL + "minCardinality") + count(OWL + "maxCardinality") + count(OWL + "cardinality") +
        count(OWL + "minQualifiedCardinality") + count(OWL + "maxQualifiedCardinality") + count(OWL + "qualifiedCardinality")],
      ["and", count(OWL + "intersectionOf")], ["or", count(OWL + "unionOf")], ["not", count(OWL + "complementOf")], ["one of {…}", count(OWL + "oneOf")],
      ["inverse properties", count(OWL + "inverseOf")], ["property chains", count(OWL + "propertyChainAxiom")],
      ["transitive properties", g.subjects(TYPE, OWL + "TransitiveProperty").length], ["functional properties", g.subjects(TYPE, OWL + "FunctionalProperty").length],
      ["datatype restrictions", count(OWL + "withRestrictions")],
    ];
    const metrics = {
      triples: g.size, kinds, kindsLocal,
      axioms: [
        ["SubClassOf (named)", subNamed], ["SubClassOf (class expression)", subAnon], ["EquivalentClasses", count(OWL + "equivalentClass")],
        ["DisjointClasses", count(OWL + "disjointWith") + g.subjects(TYPE, OWL + "AllDisjointClasses").length],
        ["SubPropertyOf", count(RDFS + "subPropertyOf")], ["Domain", count(RDFS + "domain")], ["Range", count(RDFS + "range")],
        ["Class assertions", Object.values(E).filter((e) => e.kind === "ind").reduce((n, e) => n + e.typesA.length, 0)],
        ["Property assertions", factCount],
        ["Annotation assertions", Object.values(E).reduce((n, e) => n + e.ann.length, 0)],
      ],
      constructs: constructs.filter(([, n]) => n > 0),
      noLabel: Object.values(E).filter((e) => !e.imported && !e.label && e.kind !== "ind").map((e) => e.iri),
      undeclared: Object.values(E).filter((e) => e.undeclared).map((e) => e.iri),
      deprecated: Object.values(E).filter((e) => e.deprecated && !e.imported).map((e) => e.iri),
    };

    // namespace usage
    const nsCount = new Map();
    for (const e of Object.values(E)) { const ns = e.prefix !== null ? prefixes.byPrefix.get(e.prefix) : Prefixes.split(e.iri)[0]; nsCount.set(ns, (nsCount.get(ns) || 0) + 1); }

    return {
      entities: E, prefixes, curie, docs, ontologies, metrics, reasoning,
      namespaces: Array.from(nsCount.entries()).sort((a, b) => b[1] - a[1]).map(([ns, n]) => ({ ns, prefix: prefixes.byNs.get(ns), n })),
      ms: Math.round(performance.now() - t0),
    };
  };
})(window.OWLViz = window.OWLViz || {});
