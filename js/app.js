/* cram_owlviz user interface: loading, the hierarchy tree, entity sheets, search and the overview. */
(function (NS) {
  "use strict";
  const V = NS.V;
  const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
  const OWL = "http://www.w3.org/2002/07/owl#";
  const META = "http://www.ease-crc.org/ont/cram/meta#";
  const TYPE = RDF + "type";
  const DAILY = { ttl: "ontology/cram.ttl", summary: "ontology/cram.json" };
  const EXAMPLES = [
    ["DOLCE+DnS Ultralite (DUL)", "https://raw.githubusercontent.com/ease-crc/soma/master/owl/DUL.owl"],
    ["SOMA objects module", "https://raw.githubusercontent.com/ease-crc/soma/master/owl/SOMA-OBJ.owl"],
    ["Pizza", "https://raw.githubusercontent.com/owlcs/pizza-ontology/master/pizza.owl"],
  ];
  const ACCEPT = "text/turtle, application/rdf+xml;q=0.9, application/n-triples;q=0.8, application/xml;q=0.5, */*;q=0.1";

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tick = () => new Promise((r) => setTimeout(r, 16));
  const KIND = { class: "Class", op: "Object property", dp: "Data property", ap: "Annotation property", ind: "Individual" };
  const TABS = [["class", "Classes"], ["op", "Object"], ["dp", "Data"], ["ap", "Annot."], ["ind", "Individuals"]];
  const SINGULAR = { class: "class", op: "object property", dp: "data property", ap: "annotation property", ind: "individual" };
  const PLURAL = { class: "classes", op: "object properties", dp: "data properties", ap: "annotation properties", ind: "individuals" };
  const LANGS = Array.from(new Set([...(navigator.languages || []).map((l) => l.toLowerCase().split("-")[0]), "en"]));

  const store = {
    get(k, d) { try { const v = localStorage.getItem("owlviz." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("owlviz." + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const state = {
    tab: store.get("tab", "class"),
    inferred: store.get("inferred", true),
    imported: store.get("imported", false),
    labels: store.get("labels", true),
    group: store.get("group", true),
    openGroups: new Set(),
    sel: null,
    open: new Set(),
    filter: "",
  };

  // the loaded ontology
  let M = null, E = Object.create(null);
  let subA = {}, subI = {}, subP = {};
  let session = { items: [], origin: null }; // origin: {kind: "daily"|"generated"|"urls"|"local", summary?, urls?}

  // ---- names and references ---------------------------------------------------------
  const byName = (a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base", numeric: true });
  function name(id) {
    const e = E[id];
    if (!e) {
      const c = M ? M.curie(id) : id;
      return c !== id ? c : id.replace(/^.*[#/]/, "") || id;
    }
    return state.labels && e.label ? e.label : e.local;
  }
  const curie = (id) => (M ? M.curie(id) : id);
  function hashOf(id) {
    return encodeURIComponent(curie(id)).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
  }
  function idOfHash(h) {
    if (!h) return null;
    let t;
    try { t = decodeURIComponent(h); } catch (e) { t = h; }
    if (E[t]) return t;
    const x = M && M.prefixes.expand(t);
    return x && E[x] ? x : null;
  }

  function refHTML(id) {
    const e = E[id];
    if (!e) {
      const c = curie(id);
      return /^https?:/.test(id) && c === id
        ? `<a class="ref imp" href="${esc(id)}" target="_blank" rel="noopener">${esc(name(id))}</a>`
        : `<span class="imp-text" title="${esc(id)}">${esc(c)}</span>`;
    }
    const pf = !state.labels && e.imported && e.prefix ? `<span class="pf">${esc(e.prefix)}:</span>` : "";
    return `<a class="ref${e.imported ? " imp" : ""}${e.deprecated ? " deprecated" : ""}" href="#${hashOf(id)}" data-id="${esc(id)}" title="${esc(curie(id))}"><span class="cap k-${e.kind}"></span>${pf}${esc(name(id))}</a>`;
  }
  function exprHTML(tokens) {
    return tokens.map((t) => {
      if (typeof t === "string") return esc(t);
      if (t.r) return refHTML(t.r);
      if (t.k) return `<span class="kw">${esc(t.k)}</span>`;
      if (t.l !== undefined) return `<span class="lit">${esc(t.l)}</span>`;
      return "";
    }).join("");
  }

  // ---- hierarchy --------------------------------------------------------------------------
  function indexHierarchy() {
    subA = {}; subI = {}; subP = {};
    for (const e of Object.values(E)) {
      for (const p of e.supA || []) (subA[p] = subA[p] || []).push(e.id);
      for (const p of e.supI || []) (subI[p] = subI[p] || []).push(e.id);
      for (const p of e.supP || []) (subP[p] = subP[p] || []).push(e.id);
    }
  }
  const supers = (e) => (e.kind === "class" ? (state.inferred ? e.supI : e.supA) : e.supP) || [];
  function parents(id) {
    const e = E[id];
    if (!e) return [];
    let ps = supers(e).filter((p) => E[p] && E[p].kind === e.kind);
    if (!state.imported) ps = ps.filter((p) => !E[p].imported);
    return ps;
  }
  function children(id) {
    const e = E[id];
    let cs = e.kind === "class" ? (state.inferred ? subI[id] : subA[id]) : subP[id];
    cs = (cs || []).filter((c) => E[c] && E[c].kind === e.kind && (state.imported || !E[c].imported));
    return cs.slice().sort(byName);
  }
  const visible = (e) => state.imported || !e.imported;
  function roots(kind) {
    return Object.values(E).filter((e) => e.kind === kind && visible(e) && parents(e.id).length === 0).map((e) => e.id).sort(byName);
  }
  function hint(id) {
    const e = E[id];
    if (state.imported || e.kind === "ind") return "";
    const imp = supers(e).filter((p) => E[p] && E[p].imported);
    return imp.length ? "⊑ " + imp.map((p) => name(p)).join(", ") : "";
  }

  // ---- tree ----------------------------------------------------------------------------------
  const tree = $("#tree");
  const chevron = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  function matches(id) {
    const f = state.filter;
    if (!f) return true;
    const e = E[id];
    return (e.label || "").toLowerCase().includes(f) || e.local.toLowerCase().includes(f);
  }
  const subtreeMatch = new Map();
  function hasMatch(id, seen = new Set()) {
    if (subtreeMatch.has(id)) return subtreeMatch.get(id);
    if (seen.has(id)) return false;
    seen.add(id);
    const r = matches(id) || children(id).some((c) => hasMatch(c, seen));
    subtreeMatch.set(id, r);
    return r;
  }
  function nodeHTML(id, depth, path) {
    const e = E[id];
    const cyclic = path.has(id);
    const kids = e.kind === "ind" || cyclic ? [] : children(id).filter((c) => !state.filter || hasMatch(c));
    const isOpen = state.open.has(id) || (state.filter && kids.length > 0 && depth < 30);
    const h = hint(id);
    const cnt = e.kind === "class" && (e.members || []).length + (state.inferred ? (e.membersI || []).length : 0);
    let html = `<li role="treeitem" aria-expanded="${kids.length ? isOpen : "false"}"><div class="node${e.imported ? " imp" : ""}" data-id="${esc(id)}" style="padding-left:${6 + depth * 14}px" ${state.sel === id ? 'aria-current="true"' : ""}>`;
    html += `<button type="button" class="twisty${kids.length ? "" : " leaf"}" data-toggle="${esc(id)}" aria-expanded="${isOpen}" aria-label="${isOpen ? "Collapse" : "Expand"} ${esc(name(id))}" tabindex="-1">${chevron}</button>`;
    html += `<span class="cap k-${e.kind}"></span><span class="n-label${e.deprecated ? " deprecated" : ""}">${esc(name(id))}</span>`;
    if (h && depth === 0) html += `<span class="n-hint">${esc(h)}</span>`;
    if (cnt) html += `<span class="n-count" title="instances">${cnt}</span>`;
    html += `</div>`;
    if (kids.length && isOpen) {
      const next = new Set(path).add(id);
      html += `<ul role="group">${kids.map((k) => nodeHTML(k, depth + 1, next)).join("")}</ul>`;
    }
    return html + "</li>";
  }
  function individualsHTML() {
    const inds = Object.values(E).filter((e) => e.kind === "ind" && matches(e.id) && visible(e));
    const groups = {};
    for (const e of inds) {
      const t = ((e.typesA || []).find((x) => x.length === 1 && x[0].r) || [{ r: OWL + "Thing" }])[0].r;
      (groups[t] = groups[t] || []).push(e.id);
    }
    const keys = Object.keys(groups).sort(byName);
    let shown = 0;
    return keys.map((t) => {
      if (shown > 3000) return "";
      shown += groups[t].length;
      return `<div class="group-h">${esc(name(t))} <span class="n-hint">${groups[t].length}</span></div><ul>${groups[t].sort(byName).map((id) => nodeHTML(id, 0, new Set())).join("")}</ul>`;
    }).join("") + (shown > 3000 ? `<p class="group-h">Showing the first groups only. Filter or search to find more.</p>` : "");
  }
  function renderTree() {
    subtreeMatch.clear();
    let html;
    if (!M) html = `<p class="group-h">No ontology open.</p>`;
    else if (state.tab === "ind") html = individualsHTML();
    else {
      const rs = roots(state.tab).filter((r) => !state.filter || hasMatch(r));
      const groups = groupedRoots(rs);
      if (!groups) html = `<ul>${rs.map((r) => nodeHTML(r, 0, new Set())).join("")}</ul>`;
      else {
        html = groups.map(([m, ids]) => {
          const open = state.filter || state.openGroups.has(m);
          return `<button type="button" class="group-h group-t" data-group="${esc(m)}" aria-expanded="${!!open}">${chevron}<span>${esc(m)}</span> <span class="n-hint">${ids.length}</span></button>` +
            (open ? `<ul>${ids.map((r) => nodeHTML(r, 0, new Set())).join("")}</ul>` : "");
        }).join("");
      }
    }
    tree.innerHTML = html && html !== "<ul></ul>" ? html : `<p class="group-h">${state.filter ? `Nothing matches “${esc(state.filter)}”.` : "Nothing here."}</p>`;
    const cur = tree.querySelector('[aria-current="true"]');
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  // top-level entries grouped by module (e.g. the CRAM packages), when there is more than one module
  function groupedRoots(rs) {
    if (!state.group) return null;
    const groups = new Map();
    for (const r of rs) { const m = E[r].module; if (!groups.has(m)) groups.set(m, []); groups.get(m).push(r); }
    if (groups.size < 2) return null;
    return Array.from(groups.entries()).sort((a, b) => (E[a[1][0]].imported - E[b[1][0]].imported) || a[0].localeCompare(b[0]));
  }
  function renderTabs() {
    const counts = { class: 0, op: 0, dp: 0, ap: 0, ind: 0 };
    for (const e of Object.values(E)) if (visible(e)) counts[e.kind]++;
    $("#tabs").innerHTML = TABS.map(([k, label]) =>
      `<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${state.tab === k}"><b><span class="cap k-${k}"></span>${counts[k]}</b>${label}</button>`
    ).join("");
  }
  function revealInTree(id) {
    const e = E[id];
    if (!e) return;
    if (e.kind !== state.tab) { state.tab = e.kind; store.set("tab", e.kind); }
    if (e.imported && !state.imported) { state.imported = true; $("#optImported").checked = true; store.set("imported", true); }
    renderTabs();
    const seen = new Set();
    const walk = (x) => {
      const ps = parents(x);
      if (!ps.length && E[x]) state.openGroups.add(E[x].module);
      for (const p of ps) if (!seen.has(p)) { seen.add(p); state.open.add(p); walk(p); }
    };
    walk(id);
  }

  // ---- entity sheets ----------------------------------------------------------------------------
  const detail = $("#detail");
  function frame(label, items, sub) {
    const body = items.length ? items.join("") : `<li class="empty-li">none</li>`;
    return `<div class="frame"><div class="fl">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ""}</div><ul>${body}</ul></div>`;
  }
  const li = (html, tag) => `<li><span class="axiom">${html}</span>${tag ? `<span class="inf-tag">${esc(tag)}</span>` : ""}</li>`;
  const SHOWN_IN_HEADER = new Set([V.label, V.prefLabel, ...NS.DESCRIPTION_PROPS, ...NS.SYNONYM_PROPS, ...NS.MAPPING_PROPS, META + "sourceCode"]);
  function annValue(a) {
    if (a.iri) return E[a.v] ? refHTML(a.v) : `<a href="${esc(a.v)}" target="_blank" rel="noopener">${esc(a.v)}</a>`;
    return esc(a.v) + (a.lang ? ` <span class="imp-text">@${esc(a.lang)}</span>` : "") + (a.dt && !/#(string|boolean)$/.test(a.dt) ? ` <span class="imp-text">^^${esc(curie(a.dt))}</span>` : "");
  }
  function annotationsBlock(ann) {
    const rest = ann.filter((a) => !SHOWN_IN_HEADER.has(a.p));
    if (!rest.length) return "";
    return `<section class="card"><h2>Annotations</h2><table class="ann">${rest.map((a) => `<tr><td>${E[a.p] ? refHTML(a.p) : esc(curie(a.p))}</td><td>${annValue(a)}</td></tr>`).join("")}</table></section>`;
  }
  function inLanguage(list) {
    const pref = list.filter((a) => !a.lang || LANGS.includes(a.lang.split("-")[0]));
    return pref.length ? pref : list;
  }
  function crumbs(e) {
    if (e.kind === "ind") return "";
    const path = [];
    let cur = e.id, guard = 0;
    const seen = new Set([cur]);
    while (guard++ < 40) {
      const ps = supers(E[cur]).filter((p) => E[p] && !seen.has(p));
      if (!ps.length) break;
      const p = ps.find((q) => !E[q].imported) || ps[0];
      path.unshift(p);
      seen.add(p);
      cur = p;
    }
    if (!path.length) return "";
    return `<nav class="crumbs" aria-label="Superclass path">${path.map((p) => `<a href="#${hashOf(p)}" data-id="${esc(p)}">${esc(name(p))}</a><span>›</span>`).join("")}<span>${esc(name(e.id))}</span></nav>`;
  }
  function header(e) {
    const label = e.label || e.local;
    const aka = Array.from(new Set(e.ann.filter((a) => NS.SYNONYM_PROPS.includes(a.p)).map((a) => a.v)));
    const comments = inLanguage(e.ann.filter((a) => NS.DESCRIPTION_PROPS.includes(a.p)));
    const mappings = e.ann.filter((a) => NS.MAPPING_PROPS.includes(a.p));
    const src = e.ann.find((a) => a.p === META + "sourceCode" && a.iri);
    return `${crumbs(e)}
      <div class="head">
        <h1${e.deprecated ? ' class="deprecated"' : ""}><span class="cap k-${e.kind}"></span>${esc(label)}</h1>
        <div class="chips">
          <span class="chip kind">${KIND[e.kind]}</span>
          <span class="chip">${esc(curie(e.id))}</span>
          <span class="chip">${e.imported ? "imported · " : ""}${esc(e.module)}</span>
          ${e.undeclared ? '<span class="chip bad" title="Used, but not declared in the loaded files">not declared</span>' : ""}
          ${e.deprecated ? '<span class="chip bad">deprecated</span>' : ""}
          ${src ? `<a class="chip" href="${esc(src.v)}" target="_blank" rel="noopener">source code ↗</a>` : ""}
        </div>
        <div class="iri"><code id="iriText">${esc(e.iri)}</code><button class="btn" type="button" data-copy="iri">Copy IRI</button><button class="btn" type="button" data-copy="link">Copy link</button></div>
      </div>
      ${comments.map((c) => `<p class="lede">${esc(c.v)}</p>`).join("")}
      ${aka.length ? `<div class="aka">Also known as ${aka.map((a) => `<b>${esc(a)}</b>`).join(", ")}</div>` : ""}
      ${mappings.length ? `<div class="aka">Mapped to ${mappings.map((a) => `${annValue(a)} <span class="imp-text">(${esc(a.p.replace(/^.*#/, "").replace("Match", ""))})</span>`).join(", ")}</div>` : ""}`;
  }
  function usage(e) {
    if (!e.usedByCount) return "";
    const more = e.usedByCount > e.usedBy.length ? ` <span class="imp-text">+${e.usedByCount - e.usedBy.length} more</span>` : "";
    return `<section class="card"><h2>Referenced by <span class="n">${e.usedByCount}</span></h2><div class="list-refs">${e.usedBy.slice().sort(byName).map(refHTML).join("")}${more}</div></section>`;
  }
  function mostSpecific(ids) {
    const anc = new Set();
    for (const i of ids) for (const a of (E[i] && E[i].ancI) || []) if (a !== i) anc.add(a);
    return ids.filter((i) => !anc.has(i));
  }

  function classView(e) {
    const supA = new Set(e.supA || []);
    const inferredOnly = state.inferred ? (e.supI || []).filter((p) => !supA.has(p)) : [];
    const sup = [
      ...(e.supA || []).map((p) => li(refHTML(p))),
      ...(e.supAnon || []).map((x) => li(exprHTML(x))),
      ...inferredOnly.map((p) => li(refHTML(p), "inferred")),
    ];
    const kidsAll = (state.inferred ? subI[e.id] : subA[e.id]) || [];
    const kidsA = new Set(subA[e.id] || []);
    const kids = kidsAll.slice().sort(byName);
    const shownKids = kids.slice(0, 400).map((k) => li(refHTML(k), kidsA.has(k) ? "" : "inferred"));
    if (kids.length > 400) shownKids.push(`<li class="empty-li">+${kids.length - 400} more</li>`);
    const eqTold = new Set((e.equiv || []).filter((x) => x.length === 1 && x[0].r).map((x) => x[0].r));
    const eqInf = state.inferred ? (e.eqI || []).filter((x) => !eqTold.has(x)) : [];
    const inst = [...(e.members || []).map((i) => li(refHTML(i))), ...(state.inferred ? (e.membersI || []) : []).map((i) => li(refHTML(i), "inferred"))];
    return `${header(e)}
      <section class="card"><h2>Description</h2><div class="desc">
        ${frame("Equivalent to", [...(e.equiv || []).map((x) => li(exprHTML(x))), ...eqInf.map((x) => li(refHTML(x), "inferred"))], "necessary & sufficient")}
        ${frame("SubClass of", sup, "necessary")}
        ${frame("Disjoint with", (e.disj || []).slice().sort(byName).map((d) => li(refHTML(d))))}
        ${(e.disjUnion || []).length ? frame("Disjoint union of", e.disjUnion.map((l) => li(l.map(refHTML).join(", ")))) : ""}
        ${(e.keys || []).length ? frame("Keys", e.keys.map((l) => li(l.map(refHTML).join(", ")))) : ""}
        ${frame("Subclasses", shownKids, `direct · ${kids.length}`)}
        ${frame("Instances", inst.slice(0, 400))}
      </div></section>
      ${graph(e, (state.inferred ? e.supI : e.supA) || [], kidsAll, null, "superclasses", "subclasses")}
      ${usage(e)}
      ${annotationsBlock(e.ann)}`;
  }
  function propView(e) {
    const kids = (subP[e.id] || []).slice().sort(byName);
    const namedOf = (list) => list.filter((x) => x.length === 1 && x[0].r && E[x[0].r]).map((x) => x[0].r);
    return `${header(e)}
      <section class="card"><h2>Description</h2><div class="desc">
        ${e.chars && e.chars.length ? frame("Characteristics", e.chars.map((c) => li(`<span class="kw">${esc(c)}</span>`))) : ""}
        ${frame("SubProperty of", (e.supP || []).map((p) => li(refHTML(p))))}
        ${e.kind === "op" ? frame("Inverse of", (e.inverse || []).map((p) => li(refHTML(p)))) : ""}
        ${e.kind !== "ap" || (e.domain || []).length ? frame("Domain", (e.domain || []).map((x) => li(exprHTML(x)))) : ""}
        ${e.kind !== "ap" || (e.range || []).length ? frame("Range", (e.range || []).map((x) => li(exprHTML(x)))) : ""}
        ${e.chains && e.chains.length ? frame("Property chain", e.chains.map((c) => li(c.map(exprHTML).join(' <span class="kw">o</span> ')))) : ""}
        ${e.equivP && e.equivP.length ? frame("Equivalent to", e.equivP.map((p) => li(refHTML(p)))) : ""}
        ${e.disjP && e.disjP.length ? frame("Disjoint with", e.disjP.map((p) => li(refHTML(p)))) : ""}
        ${frame("Subproperties", kids.map((k) => li(refHTML(k))), "direct")}
      </div></section>
      ${graph(e, namedOf(e.domain || []), namedOf(e.range || []), null, "domain", "range")}
      ${usage(e)}
      ${annotationsBlock(e.ann)}`;
  }
  function indView(e) {
    const asserted = (e.typesA || []).filter((x) => x.length === 1 && x[0].r).map((x) => x[0].r);
    const types = (e.typesA || []).map((x) => li(exprHTML(x)));
    const inf = state.inferred ? mostSpecific([...asserted, ...(e.typesI || [])]).filter((t) => !asserted.includes(t)).sort(byName).map((t) => li(refHTML(t), "inferred")) : [];
    const facts = (e.facts || []).map((f) => li(`${refHTML(f.p)}  ${exprHTML(f.v)}`));
    const objs = (e.facts || []).filter((f) => f.o && E[f.o]);
    return `${header(e)}
      <section class="card"><h2>Description</h2><div class="desc">
        ${frame("Types", [...types, ...inf], state.inferred ? "asserted + most specific inferred" : "asserted")}
        ${frame("Property assertions", facts)}
        ${e.same && e.same.length ? frame("Same individual as", e.same.map((x) => li(refHTML(x)))) : ""}
        ${e.diff && e.diff.length ? frame("Different from", e.diff.slice(0, 200).map((x) => li(refHTML(x)))) : ""}
      </div></section>
      ${graph(e, mostSpecific([...asserted, ...(state.inferred ? e.typesI || [] : [])]), objs.map((f) => f.o), objs.map((f) => name(f.p)), "types", "related individuals")}
      ${usage(e)}
      ${annotationsBlock(e.ann)}`;
  }

  // neighbourhood: one row above, the entity, one row below (with optional edge labels)
  function graph(e, upsAll, downAll, downLabels, upName, downName) {
    const ups = upsAll.filter((p) => E[p]).slice(0, 5);
    const order = downAll.map((d, i) => [d, i]).filter(([d]) => E[d]);
    if (!downLabels) order.sort((a, b) => byName(a[0], b[0]));
    const down = order.slice(0, 7).map(([d]) => d);
    const labels = downLabels ? order.slice(0, 7).map(([, i]) => downLabels[i]) : null;
    if (!ups.length && !down.length) return "";
    const W = 760, nodeH = 30, gapX = 12, pad = 10;
    const width = (id) => Math.min(190, Math.max(70, name(id).length * 7 + 26));
    const row = (ids, y) => {
      const ws = ids.map(width);
      const total = ws.reduce((a, b) => a + b, 0) + gapX * Math.max(0, ids.length - 1);
      let x = Math.max(pad, (W - total) / 2);
      return ids.map((id, i) => { const n = { id, x, y, w: ws[i] }; x += ws[i] + gapX; return n; });
    };
    const yMid = ups.length ? 112 : 30;
    const top = row(ups, 22), mid = row([e.id], yMid), bot = row(down, yMid + 90);
    const H = (down.length ? yMid + 140 : yMid + 50);
    const c = mid[0];
    const trunc = (s, w) => { const max = Math.floor((w - 18) / 6.6); return s.length > max ? s.slice(0, max - 1) + "…" : s; };
    const box = (n, cls) => `<g class="g-node ${cls}${E[n.id] && E[n.id].imported ? " imp" : ""}" data-id="${esc(n.id)}" tabindex="0" role="link" aria-label="${esc(name(n.id))}">
        <title>${esc(curie(n.id))}</title>
        <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${nodeH}" rx="5"></rect>
        <text x="${n.x + n.w / 2}" y="${n.y + 19}" text-anchor="middle">${esc(trunc(name(n.id), n.w))}</text></g>`;
    const edge = (a, b) => {
      const x1 = a.x + a.w / 2, y1 = a.y + nodeH, x2 = b.x + b.w / 2, y2 = b.y;
      const my = (y1 + y2) / 2;
      return `<path class="g-edge" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"></path>`;
    };
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Neighbourhood of ${esc(name(e.id))}">`;
    svg += top.map((t) => edge(t, c)).join("") + bot.map((b) => edge(c, b)).join("");
    if (labels) svg += bot.map((b, i) => `<text class="g-label" x="${b.x + b.w / 2}" y="${b.y - 6}" text-anchor="middle">${esc(trunc(labels[i], b.w + 20))}</text>`).join("");
    svg += top.map((n) => box(n, "")).join("") + box(c, "center") + bot.map((n) => box(n, "")).join("");
    const moreDown = downAll.filter((d) => E[d]).length - down.length;
    if (moreDown > 0) svg += `<text class="g-label" x="${W - pad}" y="${H - 6}" text-anchor="end">+${moreDown} more</text>`;
    if (ups.length) svg += `<text class="g-label" x="${pad}" y="14">${esc(upName)}</text>`;
    if (down.length) svg += `<text class="g-label" x="${pad}" y="${yMid + 84}">${esc(downName)}</text>`;
    svg += "</svg>";
    return `<section class="card"><h2>Neighbourhood</h2><div class="graph-wrap">${svg}</div></section>`;
  }

  // ---- overview ---------------------------------------------------------------------------------
  function sourceCard() {
    const o = session.origin;
    if (!o || !o.summary) return "";
    const s = o.summary;
    const repo = `https://github.com/${s.repository}`;
    const rows = [
      ["Repository", `<a href="${esc(repo)}" target="_blank" rel="noopener">${esc(s.repository)}</a>`],
      ["Branch", esc(s.ref)],
      ["Commit", s.commit ? `<a href="${esc(repo + "/commit/" + s.commit)}" target="_blank" rel="noopener"><code>${esc(s.commit.slice(0, 12))}</code></a>` : "unknown"],
      ["Generated", esc(new Date(s.generated).toLocaleString()) + (o.kind === "daily" ? " · daily build" : " · in this browser")],
      ["Contents", `${s.statistics.classes} classes, ${s.statistics.object_properties} object properties, ${s.statistics.datatype_properties} data properties, ${s.statistics.individuals} enum members, from ${s.statistics.modules} Python modules`],
    ];
    if (s.problems && s.problems.length) rows.push(["Skipped files", s.problems.map(esc).join("<br>")]);
    return `<section class="card"><h2>Generated from CRAM</h2><div class="kv">${rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("")}</div>
      <div class="row" style="padding:10px 14px;border-top:1px solid var(--line)"><button class="btn" type="button" data-action="download">Download Turtle</button><button class="btn" type="button" data-action="share">Copy share link</button><button class="btn" type="button" data-action="open">Other fork or branch…</button></div></section>`;
  }
  function overview() {
    if (!M) return `<div class="hero"><h1>cram_owlviz</h1><p>Open an ontology to start browsing.</p><div class="row"><button class="btn primary" type="button" data-action="open">Open…</button></div></div>`;
    const ont = M.ontologies.find((o) => !M.docs[o.doc].isImport) || M.ontologies[0];
    const title = (ont && (ont.title || curie(ont.iri))) || M.docs.map((d) => d.name).join(", ");
    const mt = M.metrics;
    const caps = [["class", "Class"], ["op", "Object property"], ["dp", "Data property"], ["ap", "Annotation property"], ["ind", "Individual"]];
    const r = M.reasoning;

    // modules: grouped by the module of each entity (rdfs:isDefinedBy or source document)
    const mods = new Map();
    for (const e of Object.values(E)) {
      if (!mods.has(e.module)) mods.set(e.module, { class: 0, op: 0, dp: 0, ap: 0, ind: 0, imported: e.imported });
      mods.get(e.module)[e.kind]++;
    }
    const modRows = Array.from(mods.entries()).sort((a, b) => (a[1].imported - b[1].imported) || (b[1].class - a[1].class)).map(([m, c]) =>
      `<tr><td>${esc(m)}${c.imported ? ' <span class="imp-text">imported</span>' : ""}</td>${["class", "op", "dp", "ap", "ind"].map((k) => `<td class="num">${c[k] || ""}</td>`).join("")}</tr>`).join("");

    const docRows = M.docs.map((d) => `<tr><td><code>${esc(d.name)}</code></td><td>${d.isImport ? "import" : "main"}</td><td>${esc(NS.FORMAT_NAMES[d.format] || d.format)}</td><td class="num">${d.triples}</td><td class="d">${d.ontologies.map((o) => `<code>${esc(o)}</code>`).join(" ")}</td></tr>`).join("");
    const loadedIds = new Set(M.ontologies.flatMap((o) => [o.iri, o.versionIRI].filter(Boolean)));
    const imports = Array.from(new Set(M.ontologies.flatMap((o) => o.imports)));
    const missing = imports.filter((i) => !loadedIds.has(i));
    const importRows = imports.map((i) => `<tr><td><code>${esc(i)}</code></td><td>${loadedIds.has(i) ? '<span class="chip ok">loaded</span>' : `<button class="btn" type="button" data-import="${esc(i)}">Load</button>`}</td></tr>`).join("");

    const axiomRows = mt.axioms.filter(([, n]) => n).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="num">${n}</td></tr>`).join("");
    const constructRows = mt.constructs.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="num">${n}</td></tr>`).join("");
    const nsRows = M.namespaces.slice(0, 20).map((n) => `<tr><td><code>${esc(n.prefix === undefined ? "" : n.prefix + ":")}</code></td><td class="d"><code>${esc(n.ns)}</code></td><td class="num">${n.n}</td></tr>`).join("");
    const listSome = (ids) => ids.slice(0, 24).map(refHTML).join("") + (ids.length > 24 ? ` <span class="imp-text">+${ids.length - 24} more</span>` : "");
    const quality = [
      mt.noLabel.length ? `<div class="frame"><div class="fl">No label<small>${mt.noLabel.length} entities</small></div><div class="list-refs">${listSome(mt.noLabel)}</div></div>` : "",
      mt.undeclared.length ? `<div class="frame"><div class="fl">Not declared<small>${mt.undeclared.length} used terms</small></div><div class="list-refs">${listSome(mt.undeclared)}</div></div>` : "",
      mt.deprecated.length ? `<div class="frame"><div class="fl">Deprecated<small>${mt.deprecated.length} entities</small></div><div class="list-refs">${listSome(mt.deprecated)}</div></div>` : "",
    ].join("");
    const top = roots("class").map((id) => [id, (subI[id] || subA[id] || []).length]).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([id]) => id);
    const mostUsed = Object.values(E).filter((e) => !e.imported && e.kind !== "ap").sort((a, b) => b.usedByCount - a.usedByCount).slice(0, 14).map((e) => e.id);

    return `<div class="hero">
        <h1>${esc(title)}</h1>
        <div class="chips">
          ${ont && ont.version ? `<span class="chip">${esc(ont.version)}</span>` : ""}
          <span class="chip">${mt.triples.toLocaleString()} triples</span>
          ${caps.map(([k]) => mt.kindsLocal[k] ? `<span class="chip"><span class="cap k-${k}"></span>${mt.kindsLocal[k].toLocaleString()} ${(mt.kindsLocal[k] === 1 ? SINGULAR : PLURAL)[k]}</span>` : "").join("")}
          <span class="chip inf" title="Structural reasoning: told hierarchy, equivalences, defined classes and property domains/ranges. Not a complete DL reasoner.">structural reasoner: ${r.subsumptions} subsumptions, ${r.types} types inferred · ${r.ms} ms${r.skipped ? " · definitions skipped (too large)" : ""}</span>
        </div>
        ${ont ? `<div class="iri"><code>${esc(ont.iri)}</code></div>` : ""}
        ${ont && ont.description ? `<p>${esc(ont.description)}</p>` : ""}
        ${ont && ont.license ? `<p class="foot">License: ${/^https?:/.test(ont.license) ? `<a href="${esc(ont.license)}" target="_blank" rel="noopener">${esc(ont.license)}</a>` : esc(ont.license)}</p>` : ""}
        <div class="legend">${caps.map(([k, l]) => `<span><span class="cap k-${k}"></span>${l}</span>`).join("")}</div>
      </div>
      ${sourceCard()}
      <section class="card"><h2>Start browsing</h2>
        <div class="frame"><div class="fl">Top-level classes<small>with the most subclasses</small></div><div class="list-refs">${top.map(refHTML).join("") || '<span class="empty-li">none</span>'}</div></div>
        <div class="frame"><div class="fl">Most referenced</div><div class="list-refs">${mostUsed.map(refHTML).join("")}</div></div>
      </section>
      ${mods.size > 1 ? `<section class="card"><h2>Modules <span class="n">${mods.size}</span></h2><div class="tbl-wrap"><table class="mods"><thead><tr><th>Module</th><th class="num">Classes</th><th class="num">Obj. props</th><th class="num">Data props</th><th class="num">Annot. props</th><th class="num">Individuals</th></tr></thead><tbody>${modRows}</tbody></table></div></section>` : ""}
      <section class="card"><h2>Files <span class="n">${M.docs.length}</span></h2><div class="tbl-wrap"><table class="mods"><thead><tr><th>File</th><th>Role</th><th>Format</th><th class="num">Triples</th><th>Ontology</th></tr></thead><tbody>${docRows}</tbody></table></div>
        <div class="row" style="padding:10px 14px;border-top:1px solid var(--line)"><button class="btn" type="button" data-action="add">Add a file…</button></div></section>
      ${imports.length ? `<section class="card"><h2>Imports <span class="n">${imports.length - missing.length}/${imports.length} loaded</span></h2><div class="tbl-wrap"><table class="mods"><tbody>${importRows}</tbody></table></div>
        ${missing.length ? `<div class="row" style="padding:10px 14px;border-top:1px solid var(--line)"><button class="btn" type="button" data-action="imports">Load all imports</button><span class="imp-text" style="font-size:var(--fs-xs)">Imports are fetched from their IRIs. Servers that do not allow cross-origin requests fail; add those files with “Add a file…”.</span></div>` : ""}</section>` : ""}
      <section class="card"><h2>Metrics</h2><div class="tbl-wrap"><table class="mods"><tbody>${axiomRows}</tbody></table></div>
        ${constructRows ? `<h2 style="border-top:1px solid var(--line)">Class expression constructs</h2><div class="tbl-wrap"><table class="mods"><tbody>${constructRows}</tbody></table></div>` : ""}</section>
      ${quality ? `<section class="card"><h2>Checks</h2><div class="desc">${quality}</div></section>` : ""}
      <section class="card"><h2>Namespaces</h2><div class="tbl-wrap"><table class="mods"><thead><tr><th>Prefix</th><th>Namespace</th><th class="num">Entities</th></tr></thead><tbody>${nsRows}</tbody></table></div></section>
      <p class="foot">cram_owlviz parses and reasons in your browser; files you open are not uploaded. Built in ${M.ms} ms. <a href="https://github.com/mrsoran2009-debug/cram_owlviz" target="_blank" rel="noopener">Source on GitHub</a>.</p>`;
  }

  function renderDetail() {
    const e = state.sel && E[state.sel];
    let html;
    if (!e) html = overview();
    else if (e.kind === "class") html = classView(e);
    else if (e.kind === "ind") html = indView(e);
    else html = propView(e);
    detail.innerHTML = `<div class="sheet">${html}</div>`;
    detail.scrollTop = 0;
  }
  function select(id, opts = {}) {
    state.sel = id && E[id] ? id : null;
    if (state.sel) revealInTree(state.sel);
    renderTree();
    renderDetail();
    if (!opts.fromHash) {
      const h = state.sel ? "#" + hashOf(state.sel) : "";
      if (location.hash !== h) { try { history.pushState(null, "", location.pathname + location.search + h); } catch (err) { /* sandboxed */ } }
    }
  }

  // ---- search ---------------------------------------------------------------------------------------
  const q = $("#q"), results = $("#results");
  let hits = [], active = 0;
  function search(text) {
    const t = text.trim().toLowerCase();
    if (!t) return [];
    const scored = [];
    for (const e of Object.values(E)) {
      const label = (e.label || "").toLowerCase(), local = e.local.toLowerCase();
      let s = 0;
      if (label === t || local === t) s = 100;
      else if (label.startsWith(t) || local.startsWith(t)) s = 70;
      else if (label.includes(t) || local.includes(t)) s = 40;
      else if (e.iri.toLowerCase() === t || curie(e.iri).toLowerCase() === t) s = 90;
      else {
        const alts = e.ann.filter((a) => NS.SYNONYM_PROPS.includes(a.p)).map((a) => a.v.toLowerCase());
        if (alts.some((a) => a.startsWith(t))) s = 60;
        else if (alts.some((a) => a.includes(t))) s = 30;
      }
      if (s) scored.push([s - (e.imported ? 5 : 0) - (e.kind === "ind" ? 2 : 0), e.id]);
    }
    return scored.sort((a, b) => b[0] - a[0] || byName(a[1], b[1])).slice(0, 40).map((x) => x[1]);
  }
  function renderResults() {
    if (!hits.length) results.innerHTML = q.value.trim() ? `<div class="result" aria-disabled="true">No matching entity</div>` : "";
    else results.innerHTML = hits.map((id, i) => `<button type="button" class="result" role="option" data-id="${esc(id)}" aria-selected="${i === active}"><span class="cap k-${E[id].kind}"></span><span>${esc(name(id))}</span><span class="r-sub">${esc(curie(id))}</span></button>`).join("");
    const show = !!q.value.trim();
    results.hidden = !show;
    q.setAttribute("aria-expanded", String(show));
  }
  q.addEventListener("input", () => { hits = search(q.value); active = 0; renderResults(); });
  q.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { active = Math.min(active + 1, hits.length - 1); renderResults(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { active = Math.max(active - 1, 0); renderResults(); ev.preventDefault(); }
    else if (ev.key === "Enter" && hits[active]) pick(hits[active]);
    else if (ev.key === "Escape") { q.value = ""; hits = []; renderResults(); }
  });
  function pick(id) { q.value = ""; hits = []; renderResults(); select(id); detail.focus({ preventScroll: true }); }
  results.addEventListener("mousedown", (ev) => { const b = ev.target.closest("[data-id]"); if (b) { ev.preventDefault(); pick(b.dataset.id); } });
  q.addEventListener("blur", () => setTimeout(() => { results.hidden = true; q.setAttribute("aria-expanded", "false"); }, 120));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { ev.preventDefault(); q.focus(); }
  });

  // ---- loading ----------------------------------------------------------------------------------------
  const busyEl = $("#busy");
  function busy(message, fraction) {
    if (message === null) { busyEl.hidden = true; return; }
    busyEl.hidden = false;
    $("#busyText").textContent = message;
    const bar = $("#busyBar");
    bar.classList.toggle("det", typeof fraction === "number");
    bar.firstElementChild.style.width = typeof fraction === "number" ? Math.round(fraction * 100) + "%" : "";
  }
  function showMessage(text, info) {
    const m = $("#openMsg");
    m.hidden = !text;
    m.textContent = text || "";
    m.classList.toggle("info", !!info);
    if (text && !dialog.open) openDialog();
  }

  async function fetchText(url) {
    const tries = /^http:\/\//.test(url) && location.protocol === "https:" ? [url.replace(/^http:/, "https:"), url] : [url];
    let last;
    for (const u of tries) {
      try {
        const r = await fetch(u, { headers: { Accept: ACCEPT } });
        if (!r.ok) { last = new Error(`The server answered ${r.status} ${r.statusText} for ${u}.`); continue; }
        return { text: await r.text(), contentType: r.headers.get("content-type"), url: r.url || u };
      } catch (e) {
        last = new Error(`Could not fetch ${url}. The server probably does not allow cross-origin requests (CORS)` +
          (location.protocol === "https:" && /^http:/.test(url) ? " or is only reachable over plain http" : "") +
          ". Download the file and open it with “Choose files” instead.");
      }
    }
    throw last;
  }

  function ontologyTitle(g, iri) {
    for (const p of [V.dctTitle, V.dcTitle, V.label]) {
      const l = g.objects(iri, p).find(NS.isLit);
      if (l) return l.v;
    }
    return null;
  }

  /* items: [{name, text, url?, contentType?, role?}]. Parses everything into a fresh graph, then shows it. */
  async function openItems(items, origin, opts = {}) {
    const all = opts.merge && M ? [...session.items, ...items] : items;
    busy("Parsing…");
    await tick();
    try {
      const g = new NS.Graph();
      const docs = [];
      for (const it of all) {
        busy(`Parsing ${it.name}…`);
        await tick();
        const doc = { name: it.name, url: it.url || null, role: it.role || null, subjects: new Set(), declared: new Set(), ontologies: [], prefixes: [] };
        const res = NS.parseInto(g, it.text, {
          name: it.name, contentType: it.contentType, format: it.format, docIndex: docs.length,
          base: it.url || "file:///" + encodeURIComponent(it.name),
          onTriple: (s, p, o) => {
            if (p !== TYPE || !NS.isIRI(s)) return;
            if (o === OWL + "Ontology") { if (!doc.ontologies.includes(s)) doc.ontologies.push(s); }
            else doc.declared.add(s);
          },
        });
        doc.format = res.format;
        doc.triples = res.triples;
        doc.prefixes = res.prefixes;
        doc.title = doc.ontologies.map((o) => ontologyTitle(g, o)).find(Boolean) || null;
        docs.push(doc);
      }
      if (!g.size) throw new Error("The file contains no triples.");
      busy(`Building the model (${g.size.toLocaleString()} triples)…`);
      await tick();
      const model = NS.buildModel(g, docs, { languages: LANGS });
      let next = origin;
      if (opts.merge && session.origin) {
        // a merged view keeps the share link of what was open first; local files cannot be shared by link
        next = { ...session.origin };
        if (next.kind === "urls") {
          if (origin.kind === "urls") next.urls = [...next.urls, ...origin.urls];
          else if (origin.kind === "local") next.kind = "local";
        }
      }
      session = { items: all, origin: next };
      setModel(model);
      updateLocation();
      if (dialog.open) dialog.close();
      showMessage(null);
      return true;
    } catch (e) {
      console.error(e);
      showMessage(e.message || String(e));
      return false;
    } finally {
      busy(null);
    }
  }

  function setModel(model) {
    M = model;
    E = model.entities;
    indexHierarchy();
    state.open.clear();
    state.openGroups.clear();
    state.filter = "";
    $("#filter").value = "";
    const rs = roots("class");
    if (rs.length <= 40) for (const r of rs) if (children(r).length < 12) state.open.add(r);
    const o = session.origin;
    const text = $("#sourceText");
    const pill = $("#source");
    pill.hidden = false;
    pill.classList.toggle("local", !(o && o.summary));
    if (o && o.summary) {
      const s = o.summary;
      text.textContent = `${s.repository}@${s.ref} · ${(s.commit || "").slice(0, 7)} · ${o.kind === "daily" ? "daily build " + s.generated.slice(0, 10) : "generated in browser"}`;
    } else {
      text.textContent = M.docs.map((d) => d.name).join(" + ");
    }
    pill.title = text.textContent;
    document.title = (o && o.summary ? "CRAM ontology" : (M.ontologies[0] && M.ontologies[0].title) || M.docs[0].name) + " · cram_owlviz";
    renderTabs();
    const start = idOfHash(location.hash.slice(1));
    select(start, { fromHash: true });
  }

  function updateLocation() {
    const o = session.origin;
    const p = new URLSearchParams();
    if (o.kind === "generated") { p.set("repo", o.summary.repository); p.set("ref", o.summary.ref); }
    else if (o.kind === "urls") for (const u of o.urls) p.append("url", u);
    const qs = p.toString();
    try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch (e) { /* sandboxed */ }
  }

  let dailySummary = null;
  async function loadDaily() {
    busy("Loading the CRAM ontology…");
    try {
      const [ttl, summary] = await Promise.all([
        fetch(DAILY.ttl, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error("missing"); return r.text(); }),
        fetch(DAILY.summary, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      dailySummary = summary;
      return openItems([{ name: "cram.ttl", text: ttl, url: new URL(DAILY.ttl, location.href).href, format: "turtle" }], { kind: summary ? "daily" : "local", summary });
    } catch (e) {
      busy(null);
      showMessage("The daily build of the CRAM ontology is not available here. Generate it from a branch below, or open another ontology.", true);
      return false;
    }
  }

  async function generate(repository, ref) {
    showMessage(null);
    try {
      const result = await NS.generateCramOntology(repository, ref, (m, f) => busy(m, f));
      busy("Parsing the generated ontology…");
      return openItems([{ name: result.name, text: result.text, format: "turtle" }], { kind: "generated", summary: result.summary });
    } catch (e) {
      console.error(e);
      busy(null);
      showMessage(e.message || String(e));
      return false;
    }
  }

  async function openUrls(urls, merge) {
    showMessage(null);
    const items = [];
    for (const u of urls) {
      busy(`Downloading ${u}…`);
      try {
        const r = await fetchText(u);
        items.push({ name: decodeURIComponent(u.split(/[?#]/)[0].replace(/\/$/, "").split("/").pop() || u), text: r.text, url: r.url, contentType: r.contentType });
      } catch (e) {
        busy(null);
        showMessage(e.message);
        return false;
      }
    }
    const ok = await openItems(items, { kind: "urls", urls }, { merge });
    if (ok) rememberUrls(urls);
    return ok;
  }

  async function openFiles(fileList, merge) {
    showMessage(null);
    const items = [];
    for (const f of Array.from(fileList)) items.push({ name: f.name, text: await f.text(), contentType: f.type });
    if (items.length) return openItems(items, { kind: "local" }, { merge });
    return false;
  }

  async function loadImports(iris) {
    const items = [];
    const failed = [];
    for (const i of iris) {
      busy(`Fetching import ${i}…`);
      try {
        const r = await fetchText(i);
        items.push({ name: i.split("/").pop() || i, text: r.text, url: r.url, contentType: r.contentType, role: "import" });
      } catch (e) {
        failed.push(i);
      }
    }
    busy(null);
    if (items.length) await openItems(items, session.origin, { merge: true });
    if (failed.length) toast(`Could not fetch ${failed.length} import${failed.length > 1 ? "s" : ""}: ${failed.join(", ")}. Add ${failed.length > 1 ? "them" : "it"} with “Add a file…”.`);
  }

  function rememberUrls(urls) {
    const recent = store.get("recent", []).filter((u) => !urls.includes(u));
    store.set("recent", [...urls, ...recent].slice(0, 6));
  }

  function toast(text) {
    const t = $("#toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 9000);
  }

  function download() {
    const it = session.items[0];
    if (!it) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([it.text], { type: "text/turtle" }));
    a.download = it.name.endsWith(".ttl") ? it.name : it.name + ".ttl";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function copy(text, btn, label) {
    const done = () => { btn.textContent = "Copied"; setTimeout(() => (btn.textContent = label), 1400); };
    try { navigator.clipboard.writeText(text).then(done, () => window.prompt("Copy:", text)); } catch (e) { window.prompt("Copy:", text); }
  }

  // ---- open dialog ------------------------------------------------------------------------------------
  const dialog = $("#openDialog");
  function openDialog() {
    const info = $("#dailyInfo");
    if (dailySummary) {
      const s = dailySummary;
      info.textContent = `Built ${new Date(s.generated).toLocaleString()} from ${s.repository}@${s.ref}, commit ${(s.commit || "").slice(0, 7)}: ${s.statistics.classes} classes, ${s.statistics.object_properties + s.statistics.datatype_properties} properties.`;
    }
    const recent = store.get("recent", []);
    $("#examples").innerHTML = [...recent.map((u) => [u.split("/").pop() || u, u, true]), ...EXAMPLES.filter(([, u]) => !recent.includes(u))].map(([l, u, r]) =>
      `<button type="button" class="chip" data-url="${esc(u)}" title="${esc(u)}">${r ? "↺ " : ""}${esc(l)}</button>`).join("");
    if (!dialog.open) { try { dialog.showModal(); } catch (e) { dialog.setAttribute("open", ""); } }
  }
  const merge = () => $("#mergeOpt").checked && !!M;
  $("#openBtn").addEventListener("click", openDialog);
  $("#loadDaily").addEventListener("click", () => loadDaily());
  $("#generateForm").addEventListener("submit", (ev) => { ev.preventDefault(); generate($("#repoInput").value, $("#refInput").value); });
  $("#urlForm").addEventListener("submit", (ev) => { ev.preventDefault(); const u = $("#urlInput").value.trim(); if (u) openUrls([u], merge()); });
  $("#pasteBtn").addEventListener("click", () => {
    const t = $("#pasteInput").value;
    if (t.trim()) openItems([{ name: "pasted", text: t }], { kind: "local" }, { merge: merge() });
  });
  $("#examples").addEventListener("click", (ev) => { const b = ev.target.closest("[data-url]"); if (b) openUrls([b.dataset.url], merge()); });
  const fileInput = $("#fileInput");
  const dropArea = $("#dropArea");
  dropArea.addEventListener("click", () => fileInput.click());
  dropArea.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", () => { const add = fileInput.dataset.add === "1"; fileInput.dataset.add = ""; openFiles(fileInput.files, add || merge()); fileInput.value = ""; });

  // page-wide drag and drop
  const dropzone = $("#dropzone");
  let dragDepth = 0;
  const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragenter", (ev) => { if (!hasFiles(ev)) return; dragDepth++; dropzone.hidden = false; dropArea.classList.add("over"); });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { dropzone.hidden = true; dropArea.classList.remove("over"); } });
  window.addEventListener("dragover", (ev) => { if (hasFiles(ev)) ev.preventDefault(); });
  window.addEventListener("drop", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    dropzone.hidden = true;
    dropArea.classList.remove("over");
    openFiles(ev.dataTransfer.files, merge());
  });

  // ---- events ------------------------------------------------------------------------------------------
  $("#tabs").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-tab]");
    if (!b) return;
    state.tab = b.dataset.tab;
    store.set("tab", state.tab);
    renderTabs();
    renderTree();
  });
  tree.addEventListener("click", (ev) => {
    const grp = ev.target.closest("[data-group]");
    if (grp) {
      const m = grp.dataset.group;
      state.openGroups.has(m) ? state.openGroups.delete(m) : state.openGroups.add(m);
      renderTree();
      return;
    }
    const t = ev.target.closest("[data-toggle]");
    if (t) {
      const id = t.dataset.toggle;
      state.open.has(id) ? state.open.delete(id) : state.open.add(id);
      renderTree();
      return;
    }
    const n = ev.target.closest(".node");
    if (n) {
      const id = n.dataset.id;
      if (state.sel === id && E[id].kind !== "ind") state.open.has(id) ? state.open.delete(id) : state.open.add(id);
      select(id);
    }
  });
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-id], g[data-id]");
    if (a && !a.closest(".tree")) { ev.preventDefault(); select(a.dataset.id); return; }
    const c = ev.target.closest("[data-copy]");
    if (c) {
      if (c.dataset.copy === "iri") copy($("#iriText").textContent, c, "Copy IRI");
      else copy(location.href, c, "Copy link");
      return;
    }
    const imp = ev.target.closest("[data-import]");
    if (imp) { loadImports([imp.dataset.import]); return; }
    const act = ev.target.closest("[data-action]");
    if (!act) return;
    const action = act.dataset.action;
    if (action === "open") openDialog();
    else if (action === "add") { fileInput.dataset.add = "1"; fileInput.click(); }
    else if (action === "download") download();
    else if (action === "share") copy(location.href.split("#")[0], act, "Copy share link");
    else if (action === "imports") {
      const loaded = new Set(M.ontologies.flatMap((o) => [o.iri, o.versionIRI].filter(Boolean)));
      loadImports(Array.from(new Set(M.ontologies.flatMap((o) => o.imports))).filter((i) => !loaded.has(i)));
    }
  });
  detail.addEventListener("keydown", (ev) => {
    const g = ev.target.closest && ev.target.closest("g[data-id]");
    if (g && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); select(g.dataset.id); }
  });
  $("#brand").addEventListener("click", () => select(null));
  $("#filter").addEventListener("input", (ev) => { state.filter = ev.target.value.trim().toLowerCase(); renderTree(); });
  $("#collapse").addEventListener("click", () => { state.open.clear(); state.openGroups.clear(); if (state.sel) revealInTree(state.sel); renderTree(); });
  const groupBtn = $("#groupBtn");
  groupBtn.setAttribute("aria-pressed", String(state.group));
  groupBtn.addEventListener("click", () => { state.group = !state.group; store.set("group", state.group); groupBtn.setAttribute("aria-pressed", String(state.group)); renderTree(); });
  const bindToggle = (sel, key) => {
    const el = $(sel);
    el.checked = state[key];
    el.addEventListener("change", () => { state[key] = el.checked; store.set(key, el.checked); renderTabs(); renderTree(); renderDetail(); });
  };
  bindToggle("#optInferred", "inferred");
  bindToggle("#optImported", "imported");
  bindToggle("#optLabels", "labels");
  window.addEventListener("hashchange", () => {
    if (!M) return;
    const id = idOfHash(location.hash.slice(1));
    if (id !== state.sel) select(id, { fromHash: true });
  });
  window.addEventListener("popstate", () => {
    if (!M) return;
    const id = idOfHash(location.hash.slice(1));
    if (id !== state.sel) select(id, { fromHash: true });
  });

  // ---- boot ----------------------------------------------------------------------------------------------
  $("#repoInput").value = NS.DEFAULT_REPOSITORY;
  $("#refInput").value = NS.DEFAULT_REF;
  renderTabs();
  renderTree();
  renderDetail();
  fetch(DAILY.summary, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).then((s) => { if (s) dailySummary = s; }).catch(() => {});
  const params = new URLSearchParams(location.search);
  if (params.get("repo")) {
    $("#repoInput").value = params.get("repo");
    $("#refInput").value = params.get("ref") || NS.DEFAULT_REF;
    generate(params.get("repo"), params.get("ref"));
  } else if (params.getAll("url").length) {
    openUrls(params.getAll("url"), false);
  } else {
    loadDaily();
  }
  NS.app = { openItems, state, get model() { return M; } };
})(window.OWLViz = window.OWLViz || {});
