/* Triple store and document loading.
 *
 * Terms: IRIs are plain strings, blank nodes are strings starting with "_:",
 * literals are objects {v, dt?, lang?}.
 */
(function (NS) {
  "use strict";
  const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const OWL = "http://www.w3.org/2002/07/owl#";

  const isLit = (t) => typeof t === "object" && t !== null;
  const isBNode = (t) => typeof t === "string" && t.startsWith("_:");
  const isIRI = (t) => typeof t === "string" && !t.startsWith("_:");
  const termKey = (t) => (isLit(t) ? '"' + t.v + '"' + (t.lang ? "@" + t.lang : "^^" + (t.dt || "")) : t);

  class Graph {
    constructor() {
      this.spo = new Map(); // s -> Map(p -> [o])
      this.ops = new Map(); // o (IRI/bnode) -> Map(p -> [s])
      this.keys = new Set();
      this.size = 0;
    }
    add(s, p, o) {
      const key = s + " " + p + " " + termKey(o);
      if (this.keys.has(key)) return false;
      this.keys.add(key);
      let m = this.spo.get(s);
      if (!m) this.spo.set(s, (m = new Map()));
      let l = m.get(p);
      if (!l) m.set(p, (l = []));
      l.push(o);
      if (!isLit(o)) {
        let r = this.ops.get(o);
        if (!r) this.ops.set(o, (r = new Map()));
        let ls = r.get(p);
        if (!ls) r.set(p, (ls = []));
        ls.push(s);
      }
      this.size++;
      return true;
    }
    objects(s, p) { const m = this.spo.get(s); return (m && m.get(p)) || []; }
    value(s, p) { const l = this.objects(s, p); return l.length ? l[0] : undefined; }
    subjects(p, o) { const m = this.ops.get(o); return (m && m.get(p)) || []; }
    has(s, p, o) { return this.keys.has(s + " " + p + " " + termKey(o)); }
    predicates(s) { return this.spo.get(s) || new Map(); }
    incoming(o) { return this.ops.get(o) || new Map(); }
    *triples() {
      for (const [s, m] of this.spo) for (const [p, l] of m) for (const o of l) yield [s, p, o];
    }
    list(head) {
      const out = [];
      const seen = new Set();
      while (head && head !== RDF + "nil" && !seen.has(head)) {
        seen.add(head);
        const f = this.value(head, RDF + "first");
        if (f === undefined) break;
        out.push(f);
        head = this.value(head, RDF + "rest");
      }
      return out;
    }
  }

  // ---- format detection --------------------------------------------------------
  const EXT = {
    ttl: "turtle", turtle: "turtle", nt: "ntriples", ntriples: "ntriples", nq: "nquads", trig: "trig", n3: "n3",
    rdf: "rdfxml", rdfs: "rdfxml", xml: "xml", owl: "auto", owx: "owlxml", ofn: "functional", omn: "manchester",
    jsonld: "jsonld", json: "jsonld", obo: "obo",
  };
  const CTYPE = [
    [/turtle/, "turtle"], [/n-triples/, "ntriples"], [/n-quads/, "nquads"], [/trig/, "trig"], [/n3/, "n3"],
    [/rdf\+xml/, "rdfxml"], [/owl\+xml/, "owlxml"], [/ld\+json/, "jsonld"], [/functional/, "functional"], [/manchester/, "manchester"],
  ];
  const FORMAT_NAMES = {
    turtle: "Turtle", ntriples: "N-Triples", nquads: "N-Quads", trig: "TriG", n3: "N3", rdfxml: "RDF/XML",
    owlxml: "OWL/XML", functional: "OWL Functional Syntax", manchester: "Manchester Syntax", jsonld: "JSON-LD", obo: "OBO flat file",
  };
  NS.FORMAT_NAMES = FORMAT_NAMES;

  function sniff(text) {
    const head = text.replace(/^﻿/, "").slice(0, 4096);
    const body = head.replace(/^(\s|#[^\n]*\n)*/, "");
    if (/^</.test(body) && /^<(\?xml|!--|!DOCTYPE|[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?[\s>])/.test(body)) {
      if (/<(\w+:)?Ontology[\s>]/.test(head) && /xmlns(:\w+)?="http:\/\/www\.w3\.org\/2002\/07\/owl#"/.test(head) && !/<rdf:RDF|RDF\s+xmlns/.test(head)) return "owlxml";
      return "rdfxml";
    }
    if (/^(Prefix|Ontology|Import)\s*\(/.test(body)) return "functional";
    if (/^(Prefix:|Ontology:)/.test(body)) return "manchester";
    if (/^format-version:/.test(body)) return "obo";
    if (/^[{[]/.test(body)) return "jsonld";
    return "turtle";
  }

  NS.detectFormat = function (name, contentType, text) {
    const ext = ((name || "").split(/[?#]/)[0].match(/\.([A-Za-z0-9]+)$/) || [])[1];
    let f = ext && EXT[ext.toLowerCase()];
    if ((!f || f === "auto" || f === "xml") && contentType) {
      const hit = CTYPE.find(([re]) => re.test(contentType));
      if (hit) f = hit[1];
    }
    if (!f || f === "auto" || f === "xml") return sniff(text);
    // a wrong extension, e.g. RDF/XML saved as .ttl
    const s = sniff(text);
    if (s !== "turtle" && f !== s && !(f === "jsonld" && s === "jsonld")) return s;
    return f;
  };

  const UNSUPPORTED_HINT = "Convert it to Turtle, RDF/XML or OWL Functional Syntax first, for example with ROBOT (robot convert -i in.owx -o out.ttl) or by saving it from Protégé.";

  /* Parse one document into the graph. Returns {format, triples, prefixes, base}. */
  NS.parseInto = function (graph, text, opts) {
    const format = opts.format && opts.format !== "auto" ? opts.format : NS.detectFormat(opts.name, opts.contentType, text);
    const bp = "_:d" + opts.docIndex + "_";
    const prefixes = [];
    let added = 0;
    const emit = (s, p, o) => {
      if (opts.onTriple) opts.onTriple(s, p, o); // every triple of this document, also those another document already added
      if (graph.add(s, p, o)) added++;
    };
    if (format === "rdfxml") {
      NS.parseRDFXML(text, opts.base, emit, (p, ns) => prefixes.push([p, ns]), bp);
    } else if (format === "functional") {
      NS.parseFunctional(text, emit, (p, ns) => prefixes.push([p, ns]), bp);
    } else if (["turtle", "ntriples", "nquads", "trig", "n3"].includes(format)) {
      if (typeof N3 === "undefined") throw new Error("The N3.js parser did not load.");
      const fmt = { turtle: "text/turtle", ntriples: "application/n-triples", nquads: "application/n-quads", trig: "application/trig", n3: "text/n3" }[format];
      const parser = new N3.Parser({ baseIRI: opts.base || undefined, format: fmt, blankNodePrefix: "" });
      const conv = (t) => {
        if (t.termType === "NamedNode") return t.value;
        if (t.termType === "BlankNode") return bp + t.value;
        if (t.termType === "Literal") {
          const o = { v: t.value };
          if (t.language) o.lang = t.language.toLowerCase();
          else if (t.datatype && t.datatype.value !== "http://www.w3.org/2001/XMLSchema#string") o.dt = t.datatype.value;
          return o;
        }
        return null;
      };
      const quads = parser.parse(text, null, (p, iri) => prefixes.push([p, typeof iri === "string" ? iri : iri.value]));
      for (const q of quads) {
        const s = conv(q.subject), p = conv(q.predicate), o = conv(q.object);
        if (s !== null && typeof p === "string" && o !== null) emit(s, p, o);
      }
    } else {
      throw new Error(`${FORMAT_NAMES[format] || format} is not supported yet. ${UNSUPPORTED_HINT}`);
    }
    return { format, triples: added, prefixes };
  };

  NS.Graph = Graph;
  NS.isLit = isLit;
  NS.isBNode = isBNode;
  NS.isIRI = isIRI;
  NS.RDF = RDF;
  NS.OWL = OWL;
})(window.OWLViz = window.OWLViz || {});
