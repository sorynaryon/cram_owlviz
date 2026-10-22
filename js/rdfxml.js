/* RDF/XML parser (W3C RDF 1.1 XML Syntax) on top of the browser's DOMParser.
 *
 * OWLViz.parseRDFXML(text, baseIRI, emit, onPrefix, bnodePrefix)
 *   emit(s, p, o): s/p are IRIs or "_:id" blank nodes, o is the same or a literal {v, dt, lang}.
 *   onPrefix(prefix, namespace) is called for every xmlns declaration.
 *
 * Not supported (rare in OWL files): rdf:ID reification of property elements, rdf:bagID, rdf:aboutEach.
 */
(function (NS) {
  "use strict";
  const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const XMLNS = "http://www.w3.org/XML/1998/namespace";
  const SKIP = new Set(["about", "ID", "nodeID", "resource", "datatype", "parseType", "bagID", "aboutEach", "aboutEachPrefix"]);
  const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

  function resolve(iri, base) {
    if (ABSOLUTE.test(iri) || !base) return iri;
    try { return new URL(iri, base).href; } catch (e) { return iri; }
  }
  const stripFragment = (b) => (b || "").replace(/#.*$/, "");

  NS.resolveIRI = resolve;

  NS.parseRDFXML = function (text, baseIRI, emit, onPrefix, bnodePrefix) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const err = doc.getElementsByTagName("parsererror")[0];
    if (err) throw new Error("XML is not well-formed: " + err.textContent.replace(/\s+/g, " ").slice(0, 300));
    const pre = bnodePrefix || "_:x";
    let counter = 0;
    const fresh = () => pre + "g" + counter++;
    const nodeIds = new Map();
    const named = (id) => { if (!nodeIds.has(id)) nodeIds.set(id, pre + id.replace(/[^\w-]/g, "_")); return nodeIds.get(id); };
    const iriOf = (el) => (el.namespaceURI || "") + el.localName;
    const isRdf = (el, name) => el.namespaceURI === RDF && el.localName === name;
    const rdfAttr = (el, name) => (el.hasAttributeNS(RDF, name) ? el.getAttributeNS(RDF, name) : null);
    const elements = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 1);

    // declared namespaces anywhere in the document
    if (onPrefix) {
      const walkNs = (el) => {
        for (const a of Array.from(el.attributes)) {
          if (a.name === "xmlns") onPrefix("", a.value);
          else if (a.name.startsWith("xmlns:")) onPrefix(a.name.slice(6), a.value);
        }
        for (const c of elements(el)) walkNs(c);
      };
      walkNs(doc.documentElement);
    }

    function ctx(el, base, lang) {
      const b = el.getAttributeNS(XMLNS, "base");
      const l = el.getAttributeNS(XMLNS, "lang");
      return {
        base: b !== null && b !== "" ? resolve(b, base) : base,
        lang: el.hasAttributeNS(XMLNS, "lang") ? l : lang,
      };
    }
    function lit(v, lang, dt) {
      const o = { v };
      if (dt) o.dt = dt;
      else if (lang) o.lang = lang.toLowerCase();
      return o;
    }
    // property attributes (non-rdf, non-xml attributes) on a node or empty property element
    function propertyAttributes(el, s, c) {
      for (const a of Array.from(el.attributes)) {
        if (!a.namespaceURI || a.namespaceURI === XMLNS || a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
        if (a.namespaceURI === RDF) {
          if (SKIP.has(a.localName)) continue;
          if (a.localName === "type") { emit(s, RDF + "type", resolve(a.value, c.base)); continue; }
        }
        emit(s, a.namespaceURI + a.localName, lit(a.value, c.lang));
      }
    }

    function nodeElement(el, base, lang) {
      const c = ctx(el, base, lang);
      let s;
      const about = rdfAttr(el, "about"), id = rdfAttr(el, "ID"), nid = rdfAttr(el, "nodeID");
      if (about !== null) s = resolve(about, c.base);
      else if (id !== null) s = stripFragment(c.base) + "#" + id;
      else if (nid !== null) s = named(nid);
      else s = fresh();
      if (!isRdf(el, "Description")) emit(s, RDF + "type", iriOf(el));
      propertyAttributes(el, s, c);
      propertyElements(el, s, c);
      return s;
    }

    function propertyElements(el, s, c) {
      let li = 1;
      for (const child of elements(el)) {
        let p = iriOf(child);
        if (p === RDF + "li") p = RDF + "_" + li++;
        propertyElement(child, s, p, c);
      }
    }

    function propertyElement(el, s, p, outer) {
      const c = ctx(el, outer.base, outer.lang);
      const parseType = rdfAttr(el, "parseType");
      const kids = elements(el);
      if (parseType === "Resource") {
        const o = fresh();
        emit(s, p, o);
        propertyElements(el, o, c);
        return;
      }
      if (parseType === "Collection") {
        const items = kids.map((k) => nodeElement(k, c.base, c.lang));
        let head = RDF + "nil";
        for (let i = items.length - 1; i >= 0; i--) {
          const n = fresh();
          emit(n, RDF + "first", items[i]);
          emit(n, RDF + "rest", head);
          head = n;
        }
        emit(s, p, head);
        return;
      }
      if (parseType !== null) {
        const xml = Array.from(el.childNodes).map((n) => new XMLSerializer().serializeToString(n)).join("");
        emit(s, p, lit(xml, null, RDF + "XMLLiteral"));
        return;
      }
      if (kids.length === 1) {
        emit(s, p, nodeElement(kids[0], c.base, c.lang));
        return;
      }
      const res = rdfAttr(el, "resource"), nid = rdfAttr(el, "nodeID"), dt = rdfAttr(el, "datatype");
      const hasPropAttrs = Array.from(el.attributes).some((a) =>
        a.namespaceURI && a.namespaceURI !== XMLNS && !a.name.startsWith("xmlns") &&
        !(a.namespaceURI === RDF && (SKIP.has(a.localName))));
      if (res !== null || nid !== null || (hasPropAttrs && dt === null)) {
        const o = res !== null ? resolve(res, c.base) : nid !== null ? named(nid) : fresh();
        emit(s, p, o);
        propertyAttributes(el, o, c);
        return;
      }
      emit(s, p, lit(el.textContent, c.lang, dt !== null ? resolve(dt, c.base) : null));
    }

    const root = doc.documentElement;
    const top = ctx(root, baseIRI || null, null);
    if (isRdf(root, "RDF")) {
      for (const el of elements(root)) nodeElement(el, top.base, top.lang);
    } else {
      nodeElement(root, baseIRI || null, null);
    }
    return { base: top.base };
  };
})(window.OWLViz = window.OWLViz || {});
