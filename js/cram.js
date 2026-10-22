/* Generate the CRAM ontology in the browser from any GitHub fork or branch.
 *
 * Runs generator/cram_ontology.py (the same script the daily build uses) under Pyodide. The Python sources are
 * downloaded file by file from raw.githubusercontent.com, because GitHub's zip archives cannot be fetched cross-origin.
 * Two GitHub API calls are made per run (commit lookup and file tree); unauthenticated clients get 60 per hour.
 */
(function (NS) {
  "use strict";
  const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
  const PARALLEL_DOWNLOADS = 24;
  let pyodideReady = null;

  NS.DEFAULT_REPOSITORY = "cram2/cognitive_robot_abstract_machine";
  NS.DEFAULT_REF = "main";

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  async function pyodide(progress) {
    if (!pyodideReady) {
      pyodideReady = (async () => {
        progress("Loading Python (Pyodide, about 10 MB the first time)…");
        if (typeof loadPyodide === "undefined") await loadScript(PYODIDE + "pyodide.js");
        const py = await loadPyodide({ indexURL: PYODIDE });
        const source = await (await fetch("generator/cram_ontology.py", { cache: "no-cache" })).text();
        py.FS.writeFile("/home/pyodide/cram_ontology.py", source);
        py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
        return py;
      })();
      pyodideReady.catch(() => { pyodideReady = null; });
    }
    return pyodideReady;
  }

  async function github(path) {
    const r = await fetch("https://api.github.com/" + path, { headers: { Accept: "application/vnd.github+json" } });
    if (r.status === 404 || r.status === 422) throw new Error("Repository or branch not found. Private repositories are not supported.");
    if (r.status === 403 || r.status === 429) {
      const reset = r.headers.get("x-ratelimit-reset");
      const when = reset ? " Try again after " + new Date(reset * 1000).toLocaleTimeString() + "." : "";
      throw new Error("GitHub's API limit for anonymous use (60 requests per hour) is used up." + when);
    }
    if (!r.ok) throw new Error(`GitHub API error ${r.status} for ${path}`);
    return r.json();
  }

  NS.parseRepository = function (text) {
    const t = (text || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
    const m = t.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/tree\/(.+))?$/);
    return m ? { repository: `${m[1]}/${m[2]}`, ref: m[3] || null } : null;
  };

  /* Returns {text, summary, name, commit}. progress(message, fraction?) reports what is happening. */
  NS.generateCramOntology = async function (repository, ref, progress = () => {}) {
    const parsed = NS.parseRepository(repository);
    if (!parsed) throw new Error("Enter the repository as owner/name, e.g. " + NS.DEFAULT_REPOSITORY);
    repository = parsed.repository;
    ref = (ref || parsed.ref || NS.DEFAULT_REF).trim();
    const py = pyodide(progress);
    progress(`Looking up ${repository}@${ref}…`);
    const commit = (await github(`repos/${repository}/commits/${encodeURIComponent(ref)}`)).sha;
    const tree = await github(`repos/${repository}/git/trees/${commit}?recursive=1`);
    const paths = tree.tree.filter((x) => x.type === "blob").map((x) => x.path);
    const generator = (await py).pyimport("cram_ontology");
    const wanted = generator.select_paths((await py).toPy(paths)).toJs();
    if (!wanted.length) throw new Error(`No Python packages found in ${repository}@${ref}.`);
    const files = {};
    let done = 0, next = 0;
    const worker = async () => {
      while (next < wanted.length) {
        const path = wanted[next++];
        const url = `https://raw.githubusercontent.com/${repository}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
        let text = null;
        for (let attempt = 0; attempt < 3 && text === null; attempt++) {
          try { const r = await fetch(url); if (r.ok) text = await r.text(); else if (r.status === 404) break; } catch (e) { /* retry */ }
        }
        if (text !== null) files[path] = text;
        done++;
        if (done % 20 === 0 || done === wanted.length) progress(`Downloading sources ${done} / ${wanted.length}`, done / wanted.length);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_DOWNLOADS }, worker));
    progress("Generating the ontology…");
    await new Promise((r) => setTimeout(r, 30));
    const pyFiles = (await py).toPy(files);
    const result = generator.generate(pyFiles, repository, ref, commit);
    const [text, summary] = result.toJs();
    result.destroy();
    pyFiles.destroy();
    generator.destroy();
    return { text, summary: JSON.parse(summary), name: `cram-${repository.replace("/", "-")}-${ref.replace(/[^\w.-]/g, "_")}.ttl`, commit, repository, ref };
  };
})(window.OWLViz = window.OWLViz || {});
