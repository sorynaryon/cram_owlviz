/* A structural reasoner for the "inferred" view. It is sound for what it derives but not complete; it is not a DL reasoner.
 *
 * Classes:     told subclass axioms, named equivalences, conjuncts of equivalentClass/subClassOf intersections,
 *              members of unionOf / disjointUnionOf definitions, and classification under defined classes
 *              (D ≡ A and B and p some C ...): X ⊑ D when X's told description entails every conjunct.
 * Individuals: asserted types, rdfs:domain / rdfs:range of their property assertions (with inverse and symmetric
 *              properties), the class hierarchy, and realisation into defined classes from the individual's facts.
 *
 * Writes e.supI (direct inferred superclasses), e.eqI (equivalent classes), e.typesI, e.members, e.membersI.
 */
(function (NS) {
  "use strict";
  const { isLit, isBNode, isIRI } = NS;
  const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
  const OWL = "http://www.w3.org/2002/07/owl#";
  const XSD = "http://www.w3.org/2001/XMLSchema#";
  const TYPE = RDF + "type";
  const THING = OWL + "Thing";
  const INTEGERS = ["integer", "int", "long", "short", "byte", "nonNegativeInteger", "positiveInteger", "nonPositiveInteger",
    "negativeInteger", "unsignedInt", "unsignedLong", "unsignedShort", "unsignedByte"].map((x) => XSD + x);

  NS.structuralReasoner = function (g, E, ctx) {
    const t0 = performance.now();
    const allDiff = ctx.allDiff || new Map();
    const isClass = (x) => isIRI(x) && E[x] !== undefined && E[x].kind === "class";
    const classes = Object.values(E).filter((e) => e.kind === "class").map((e) => e.iri);
    const inds = Object.values(E).filter((e) => e.kind === "ind").map((e) => e.iri);

    // ---- property hierarchy
    const propUp = new Map();
    for (const e of Object.values(E)) if (e.kind === "op" || e.kind === "dp") propUp.set(e.iri, new Set([...(e.supP || []), ...(e.equivP || [])]));
    const propAncMemo = new Map();
    const propAnc = (p) => {
      if (propAncMemo.has(p)) return propAncMemo.get(p);
      const out = new Set(), stack = [p];
      while (stack.length) for (const q of propUp.get(stack.pop()) || []) if (!out.has(q)) { out.add(q); stack.push(q); }
      propAncMemo.set(p, out);
      return out;
    };
    const propSub = (a, b) => a === b || (typeof a === "string" && !a.startsWith("^") && propAnc(a).has(b));

    // ---- class expressions as conjunctions of named classes and restrictions
    const filler = (f) => (f === undefined || f === THING || f === RDFS + "Literal" ? null : isBNode(f) ? { anon: f } : f);
    const restriction = (node) => {
      const p0 = g.value(node, OWL + "onProperty");
      if (p0 === undefined) return null;
      let p = p0;
      if (isBNode(p0)) { const inv = g.value(p0, OWL + "inverseOf"); p = inv ? "^" + inv : null; }
      if (!p) return null;
      let v;
      if ((v = g.value(node, OWL + "someValuesFrom")) !== undefined) return { t: "some", p, f: filler(v) };
      if ((v = g.value(node, OWL + "allValuesFrom")) !== undefined) return { t: "only", p, f: filler(v) };
      if ((v = g.value(node, OWL + "hasValue")) !== undefined) return { t: "value", p, f: v };
      for (const [k, t] of [["minCardinality", "min"], ["minQualifiedCardinality", "min"], ["maxCardinality", "max"],
        ["maxQualifiedCardinality", "max"], ["cardinality", "exactly"], ["qualifiedCardinality", "exactly"]]) {
        if ((v = g.value(node, OWL + k)) !== undefined) {
          const n = parseInt(isLit(v) ? v.v : v, 10);
          const f = g.value(node, OWL + "onClass") !== undefined ? g.value(node, OWL + "onClass") : g.value(node, OWL + "onDataRange");
          return Number.isFinite(n) ? { t, p, n, f: filler(f) } : null;
        }
      }
      return null;
    };
    const conjuncts = (x, out = { named: [], restr: [] }, depth = 0) => {
      if (depth > 20 || isLit(x)) return null;
      if (isIRI(x)) { if (x !== THING) out.named.push(x); return out; }
      const inter = g.value(x, OWL + "intersectionOf");
      if (inter !== undefined) { for (const m of g.list(inter)) if (!conjuncts(m, out, depth + 1)) return null; return out; }
      const r = restriction(x);
      if (r) { out.restr.push(r); return out; }
      return null;
    };

    // ---- told descriptions
    const told = new Map(classes.map((c) => [c, new Set()]));
    const toldR = new Map(classes.map((c) => [c, []]));
    const defs = [];
    const addTold = (c, s) => { if (c !== s && told.has(c) && isClass(s)) told.get(c).add(s); };
    for (const c of classes) {
      for (const s of g.objects(c, RDFS + "subClassOf")) {
        const cj = conjuncts(s);
        if (cj) { cj.named.forEach((n) => addTold(c, n)); toldR.get(c).push(...cj.restr); }
      }
      const eqs = new Set([...g.objects(c, OWL + "equivalentClass"), ...g.subjects(OWL + "equivalentClass", c)]);
      for (const s of eqs) {
        if (s === c) continue;
        if (isIRI(s)) { addTold(c, s); addTold(s, c); continue; }
        const cj = conjuncts(s);
        if (cj) {
          cj.named.forEach((n) => addTold(c, n));
          toldR.get(c).push(...cj.restr);
          if ((cj.named.length || cj.restr.length) && cj.restr.every((r) => !(r.f && r.f.anon))) defs.push({ d: c, sig: cj });
          continue;
        }
        const union = g.value(s, OWL + "unionOf");
        if (union !== undefined) for (const m of g.list(union)) addTold(m, c);
      }
      for (const l of g.objects(c, OWL + "disjointUnionOf")) for (const m of g.list(l)) addTold(m, c);
    }

    // ---- ancestors
    let anc = new Map();
    const computeAncestors = () => {
      anc = new Map();
      for (const c of classes) {
        const out = new Set(), stack = [...told.get(c)];
        while (stack.length) {
          const x = stack.pop();
          if (out.has(x)) continue;
          out.add(x);
          for (const y of told.get(x) || []) if (!out.has(y)) stack.push(y);
        }
        anc.set(c, out);
      }
    };
    const below = (a, b) => a === b || (anc.has(a) && anc.get(a).has(b));
    const fillerSub = (a, b) => {
      if (b === null) return true;
      if (a === null || (a && a.anon) || (b && b.anon)) return false;
      if (isLit(a) || isLit(b)) return false;
      return below(a, b);
    };
    const sameValue = (a, b) => (isLit(a) && isLit(b) ? a.v === b.v && (a.dt || "") === (b.dt || "") && (a.lang || "") === (b.lang || "") : a === b);
    const sameFiller = (a, b) => a === b || (a !== null && b !== null && !a.anon && !b.anon && sameValue(a, b));
    // does the told restriction x entail the restriction r?
    const entails = (x, r) => {
      switch (r.t) {
        case "some":
          return ((x.t === "some" || ((x.t === "min" || x.t === "exactly") && x.n >= 1)) && propSub(x.p, r.p) && fillerSub(x.f, r.f)) ||
            (x.t === "value" && r.f === null && propSub(x.p, r.p));
        case "value": return x.t === "value" && propSub(x.p, r.p) && sameValue(x.f, r.f);
        case "min":
          return r.n <= 0 || ((((x.t === "min" || x.t === "exactly") && x.n >= r.n) || (r.n === 1 && x.t === "some")) && propSub(x.p, r.p) && fillerSub(x.f, r.f));
        case "exactly": return x.t === "exactly" && x.n === r.n && x.p === r.p && sameFiller(x.f, r.f);
        case "max": return (x.t === "max" || x.t === "exactly") && x.n <= r.n && propSub(r.p, x.p) && fillerSub(r.f, x.f);
        case "only": return x.t === "only" && propSub(r.p, x.p) && (r.f === null || fillerSub(x.f, r.f));
        default: return false;
      }
    };

    // ---- classification under defined classes
    let subsumptions = 0, skipped = false;
    if (defs.length * classes.length > 6e7) skipped = true;
    computeAncestors();
    for (let round = 0; round < 6 && !skipped && defs.length; round++) {
      const desc = new Map();
      for (const c of classes) for (const a of anc.get(c)) { if (!desc.has(a)) desc.set(a, []); desc.get(a).push(c); }
      const inheritedMemo = new Map();
      const inherited = (c) => {
        if (inheritedMemo.has(c)) return inheritedMemo.get(c);
        const out = [...toldR.get(c)];
        for (const a of anc.get(c)) if (toldR.has(a)) out.push(...toldR.get(a));
        inheritedMemo.set(c, out);
        return out;
      };
      let changed = false;
      for (const { d, sig } of defs) {
        if (!sig.restr.length && sig.named.length < 2) continue;
        const candidates = sig.named.length ? [sig.named[0], ...(desc.get(sig.named[0]) || [])] : classes;
        for (const x of candidates) {
          if (x === d || !anc.has(x) || anc.get(x).has(d)) continue;
          if (!sig.named.every((n) => below(x, n))) continue;
          if (sig.restr.length) {
            const R = inherited(x);
            if (!sig.restr.every((r) => R.some((xr) => entails(xr, r)))) continue;
          }
          told.get(x).add(d);
          subsumptions++;
          changed = true;
        }
      }
      if (!changed) break;
      computeAncestors();
    }

    // ---- direct superclasses and equivalents
    for (const c of classes) {
      const a = anc.get(c);
      const eq = [...a].filter((b) => b !== c && anc.get(b) && anc.get(b).has(c));
      const eqSet = new Set(eq);
      const strict = [...a].filter((b) => b !== c && !eqSet.has(b));
      const direct = strict.filter((p) => !strict.some((q) => q !== p && anc.get(q) && anc.get(q).has(p) && !(anc.get(p) && anc.get(p).has(q))));
      E[c].supI = direct;
      E[c].eqI = eq;
      E[c].ancI = a;
    }

    // ---- individuals
    const facts = new Map(inds.map((i) => [i, []]));
    for (const i of inds) {
      for (const [p, os] of g.predicates(i)) {
        const pe = E[p];
        if (!pe || (pe.kind !== "op" && pe.kind !== "dp")) continue;
        for (const o of os) {
          facts.get(i).push({ p, o });
          if (pe.kind === "op" && isIRI(o) && facts.has(o)) {
            for (const q of pe.inverse || []) facts.get(o).push({ p: q, o: i });
            if ((pe.chars || []).includes("Symmetric")) facts.get(o).push({ p, o: i });
          }
        }
      }
    }
    const classesOf = (p, pred) => {
      const out = new Set();
      for (const q of [p, ...propAnc(p)]) for (const x of g.objects(q, pred)) { const cj = conjuncts(x); if (cj) cj.named.forEach((n) => isClass(n) && out.add(n)); }
      return out;
    };
    const domainMemo = new Map(), rangeMemo = new Map();
    const domains = (p) => { if (!domainMemo.has(p)) domainMemo.set(p, classesOf(p, RDFS + "domain")); return domainMemo.get(p); };
    const ranges = (p) => { if (!rangeMemo.has(p)) rangeMemo.set(p, E[p] && E[p].kind === "op" ? classesOf(p, RDFS + "range") : new Set()); return rangeMemo.get(p); };
    const T = new Map(), indRestr = new Map();
    for (const i of inds) {
      const s = new Set(), rs = [];
      for (const t of g.objects(i, TYPE)) { const cj = conjuncts(t); if (cj) { cj.named.forEach((n) => isClass(n) && s.add(n)); rs.push(...cj.restr); } }
      for (const { p } of facts.get(i)) for (const c of domains(p)) s.add(c);
      T.set(i, s);
      indRestr.set(i, rs);
    }
    for (const i of inds) for (const { p, o } of facts.get(i)) if (isIRI(o) && T.has(o)) for (const c of ranges(p)) T.get(o).add(c);
    const close = (s) => { for (const c of [...s]) for (const a of anc.get(c) || []) s.add(a); };
    inds.forEach((i) => close(T.get(i)));

    const datatypeFits = (lit, f) => {
      if (!isIRI(f)) return false;
      if (lit.dt === f) return true;
      if (!lit.dt && !lit.lang) return f === XSD + "string";
      if (lit.lang) return f === RDF + "langString" || f === RDF + "PlainLiteral";
      if (f === XSD + "decimal") return INTEGERS.includes(lit.dt);
      if (f === XSD + "integer") return INTEGERS.includes(lit.dt);
      return false;
    };
    const objectFits = (o, f) => f === null || (isLit(o) ? datatypeFits(o, f) : !f.anon && T.has(o) && (T.get(o).has(f) || o === f));
    const restrictionsOf = (i) => {
      const out = [...indRestr.get(i)];
      for (const c of T.get(i)) if (toldR.has(c)) out.push(...toldR.get(c));
      return out;
    };
    const distinctCount = (objs) => {
      const lits = new Set(), iris = [];
      for (const o of objs) {
        if (isLit(o)) lits.add(o.v + "|" + (o.dt || ""));
        else if (!iris.includes(o) && iris.every((x) => allDiff.has(x) && allDiff.get(x).has(o))) iris.push(o);
      }
      return lits.size + iris.length;
    };
    const individualFits = (i, r) => {
      const fs = facts.get(i).filter((x) => propSub(x.p, r.p));
      if (r.t === "some" && fs.some((x) => objectFits(x.o, r.f))) return true;
      if (r.t === "value" && fs.some((x) => sameValue(x.o, r.f))) return true;
      if (r.t === "min" && (r.n <= 0 || distinctCount(fs.filter((x) => objectFits(x.o, r.f)).map((x) => x.o)) >= r.n)) return true;
      return restrictionsOf(i).some((x) => entails(x, r));
    };
    let types = 0;
    for (let round = 0; round < 5 && defs.length && !skipped; round++) {
      let changed = false;
      for (const { d, sig } of defs) {
        for (const i of inds) {
          const t = T.get(i);
          if (t.has(d) || !sig.named.every((n) => t.has(n))) continue;
          if (!sig.restr.every((r) => individualFits(i, r))) continue;
          t.add(d);
          close(t);
          types++;
          changed = true;
        }
      }
      if (!changed) break;
    }

    for (const c of classes) E[c].membersI = [];
    for (const i of inds) {
      const asserted = new Set(g.objects(i, TYPE).filter(isClass));
      E[i].typesI = [...T.get(i)].filter((c) => !asserted.has(c) && isClass(c));
      for (const c of E[i].typesI) E[c].membersI.push(i);
    }
    return { defined: defs.length, subsumptions, types, skipped, ms: Math.round(performance.now() - t0) };
  };
})(window.OWLViz = window.OWLViz || {});
