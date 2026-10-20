// Which city is this repo? Turn the scanned blueprint into a handful of metrics, score each
// city archetype from them, and explain the winner in plain words. Same repo → same city.

const NONCODE = new Set(['cfg', 'doc', 'lock']);
// infrastructure as code: it makes a port, but never decides the shape of the code city
const INFRA = new Set(['hcl', 'yaml', 'jsonnet', 'nix', 'tmpl']);
// prose (docs sites, books): it makes a university town, and like infrastructure never shapes a code city
const PROSE = new Set(['md']);
const INFRA_NAMES = { tf: 'Terraform', k8s: 'Kubernetes manifests', chart: 'Helm charts', values: 'Helm charts', kustomize: 'Kustomize', jsonnet: 'jsonnet', ansible: 'Ansible', nix: 'Nix', tmpl: 'templates', yaml: 'YAML' };
const YEAR = 365.25 * 86400;
const TEST_RE = /(^|\/)(tests?|__tests__|specs?|e2e|testing)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/;
const GROUP_RE = /^(packages|apps|libs|crates|modules|plugins|services|projects)\/[^/]+/;
// tests, docs, examples, fixtures… are part of the city, but they don't decide which city it is
const NONCORE_RE = /(^|\/)(tests?|__tests__|specs?|e2e|testing|fixtures?|__fixtures__|samples?|examples?|docs?|playground|benchmarks?|bench|scripts|website|site|\.github)(\/|$)|\.(test|spec|stories)\.[a-z]+$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/;

const ramp = (x, a, b) => Math.min(1, Math.max(0, (x - a) / (b - a)));
const sum = xs => xs.reduce((s, x) => s + x, 0);
const mean = xs => xs.length ? sum(xs) / xs.length : 0;
const cv = xs => { const m = mean(xs); return m ? Math.sqrt(mean(xs.map(x => (x - m) ** 2))) / m : 0; };
const pct = x => `${Math.round(x * 100)}%`;

export function cityMetrics(city, now = Date.now() / 1000) {
  const all = city.files;
  // manifests / build files / docs / lockfiles ('cfg', 'doc', 'lock') are buildings in the city but not part of the codebase being judged
  // the port: how much of the repo is infrastructure, and which kinds lead
  const infraIdx = all.map((f, i) => INFRA.has(f.lang) ? i : -1).filter(i => i >= 0);
  const proseIdx = all.map((f, i) => PROSE.has(f.lang) ? i : -1).filter(i => i >= 0);
  const plainIdx = all.map((f, i) => NONCODE.has(f.lang) || INFRA.has(f.lang) || PROSE.has(f.lang) ? -1 : i).filter(i => i >= 0);
  const infraLoc = sum(infraIdx.map(i => all[i].loc)), codeLoc = sum(plainIdx.map(i => all[i].loc));
  const proseLoc = sum(proseIdx.map(i => all[i].loc));
  const workLoc = Math.max(1, infraLoc + codeLoc + proseLoc);
  // in a port the infrastructure *is* the codebase, in a university the pages are; anywhere else they don't shape the city
  const isPort = infraLoc / workLoc >= 0.5 && infraIdx.length >= 8;
  const isCampus = !isPort && proseLoc / workLoc >= 0.5 && proseIdx.length >= 10;
  const codeIdx = isPort ? [...plainIdx, ...infraIdx].sort((a, b) => a - b)
    : isCampus ? [...plainIdx, ...proseIdx].sort((a, b) => a - b) : plainIdx;
  const locales = new Set(proseIdx.filter(i => all[i].a?.k === 'i18n').map(i => all[i].p.split('/').find(s => /^([a-z]+\.)?[a-z]{2}([_-][a-zA-Z]{2,4})?$/i.test(s)) || 'i18n'));
  const kindLoc = {};
  for (const i of infraIdx) { const k = INFRA_NAMES[all[i].a?.k] || 'YAML'; kindLoc[k] = (kindLoc[k] || 0) + all[i].loc; }
  const infraKinds = Object.keys(kindLoc).sort((a, b) => kindLoc[b] - kindLoc[a]).filter((k, n) => n === 0 || kindLoc[k] > infraLoc * 0.15);
  const coreIdx = codeIdx.filter(i => !NONCORE_RE.test(all[i].p));
  // re-index imports onto the core subset (fall back to everything for tiny / test-only repos)
  const useCore = coreIdx.length >= 20;
  const remap = new Map((useCore ? coreIdx : codeIdx).map((i, k) => [i, k]));
  const F = [...remap.keys()].map(i => ({ ...all[i], imp: all[i].imp.filter(j => remap.has(j)).map(j => remap.get(j)) }));
  const n = F.length;
  const locs = F.map(f => f.loc).sort((a, b) => a - b);
  const total = sum(locs) || 1;
  const median = locs[n >> 1] || 0;
  const topK = Math.max(1, Math.ceil(n * 0.05));
  const top5Share = sum(locs.slice(-topK)) / total;

  const dirs = new Map();
  for (const f of F) {
    const d = f.p.includes('/') ? f.p.slice(0, f.p.lastIndexOf('/')) : '.';
    dirs.set(d, (dirs.get(d) || 0) + 1);
  }
  const dirSizes = [...dirs.values()];
  const avgDepth = mean(F.map(f => f.p.split('/').length - 1));
  // the mountain: directories that hold no files and a single subdirectory are just a staircase
  // (src/main/java/org/acme/…); how much of an average path is climbing, and the longest such climb
  const tree = new Map();
  const node = d => { if (!tree.has(d)) tree.set(d, { files: 0, subs: new Set() }); return tree.get(d); };
  for (const f of F) {
    const segs = f.p.split('/').slice(0, -1);
    let cur = '';
    node('');
    for (const sg of segs) { const nx = cur ? cur + '/' + sg : sg; node(cur).subs.add(nx); cur = nx; node(cur); }
    node(cur).files++;
  }
  let passSteps = 0, steps = 0;
  const climbs = new Map();
  for (const f of F) {
    const segs = f.p.split('/').slice(0, -1);
    let cur = '', len = 0, best = { len: 0, at: '' };
    for (const sg of segs) {
      cur = cur ? cur + '/' + sg : sg; steps++;
      const d = tree.get(cur), pass = d.files === 0 && d.subs.size === 1;
      if (pass) { passSteps++; len++; if (len > best.len) best = { len, at: cur }; } else len = 0;
    }
    // the climb ends where the staircase reaches a real directory: name it by the dir it arrives at
    if (best.len >= 2) { const key = [...tree.get(best.at).subs][0]; climbs.set(key, { n: (climbs.get(key)?.n || 0) + 1, len: best.len }); }
  }
  const passShare = passSteps / Math.max(1, steps);
  const top = [...climbs].sort((a, b) => b[1].n * b[1].len - a[1].n * a[1].len)[0];
  const climb = top ? { to: top[0], len: top[1].len } : { to: '', len: 0 };

  // districts: monorepo packages when present, otherwise top-level directories
  const group = p => (GROUP_RE.exec(p) || [p.includes('/') ? p.split('/')[0] : '.'])[0];
  const groupOf = F.map(f => group(f.p));
  const groupCounts = new Map();
  for (const g of groupOf) groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
  const bigGroups = [...groupCounts].filter(([, c]) => c >= n * 0.05).sort((a, b) => b[1] - a[1]);
  const monorepo = F.some(f => GROUP_RE.test(f.p));

  const inDeg = new Array(n).fill(0);
  let edges = 0, cross = 0;
  F.forEach((f, i) => f.imp.forEach(j => { inDeg[j]++; edges++; if (groupOf[i] !== groupOf[j]) cross++; }));
  const top3Share = edges ? sum([...inDeg].sort((a, b) => b - a).slice(0, 3)) / edges : 0;

  // files caught in import cycles (Tarjan SCC, iterative)
  let inCycles = 0;
  {
    const idx = new Array(n).fill(-1), low = new Array(n).fill(0), on = new Array(n).fill(false), stack = [];
    let counter = 0;
    for (let s = 0; s < n; s++) {
      if (idx[s] >= 0) continue;
      const work = [[s, 0]];
      idx[s] = low[s] = counter++; stack.push(s); on[s] = true;
      while (work.length) {
        const top = work[work.length - 1];
        const [v, k] = top;
        const out = F[v].imp;
        if (k < out.length) {
          top[1]++;
          const w = out[k];
          if (idx[w] < 0) { idx[w] = low[w] = counter++; stack.push(w); on[w] = true; work.push([w, 0]); }
          else if (on[w]) low[v] = Math.min(low[v], idx[w]);
        } else {
          work.pop();
          if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
          if (low[v] === idx[v]) {
            let size = 0, w;
            do { w = stack.pop(); on[w] = false; size++; } while (w !== v);
            if (size > 1) inCycles += size;
          }
        }
      }
    }
  }

  // Berlin: two big districts that never talk to each other
  let split = 0;
  if (bigGroups.length >= 2 && edges >= 30) {
    const [a, b] = [bigGroups[0][0], bigGroups[1][0]];
    // both halves must be real neighbourhoods: 10+ files that import each other internally
    const internal = g => { let e = 0; F.forEach((f, i) => { if (groupOf[i] === g) f.imp.forEach(j => { if (groupOf[j] === g) e++; }); }); return e; };
    if (bigGroups[1][1] >= Math.max(10, n * 0.2) && internal(a) >= 5 && internal(b) >= 5) {
      let between = 0, touching = 0;
      F.forEach((f, i) => f.imp.forEach(j => {
        const ga = groupOf[i], gb = groupOf[j];
        if ((ga === a || ga === b) || (gb === a || gb === b)) touching++;
        if ((ga === a && gb === b) || (ga === b && gb === a)) between++;
      }));
      split = touching ? 1 - between / touching : 0;
    }
  }

  // history is judged on code alone: a late package.json bump must not stretch the timeline
  const workIdx = isPort || isCampus ? codeIdx : [...codeIdx, ...infraIdx]; // infrastructure is real work for the timeline
  const cfgOnly = workIdx.length < all.length;
  const start = cfgOnly && workIdx.length ? Math.min(...workIdx.map(i => all[i].born)) : city.start;
  const end = cfgOnly && workIdx.length ? Math.max(...workIdx.map(i => all[i].last)) : city.end;
  const commits = cfgOnly ? city.commits.filter(c => { for (let k = 1; k < c.length; k++) if (!NONCODE.has(all[c[k]].lang)) return true; return false; }) : city.commits;
  const span = Math.max(1, end - start);
  const recentWindow = 90 * 86400;
  const recentCommits = commits.filter(c => c[0] > end - recentWindow).length;
  const commitCount = commits.length;
  const avgPerWindow = commits.length / Math.max(1, span / recentWindow);

  return {
    files: n,
    loc: total,
    commits: commitCount,
    medianLoc: median,
    top5Share,
    locCv: cv(locs),
    avgDepth,
    passShare,
    climb,
    dirs: dirs.size,
    filesPerDir: mean(dirSizes),
    dirCv: cv(dirSizes),
    groups: bigGroups.length,
    monorepo,
    edgesPerFile: edges / Math.max(1, n),
    top3Share,
    crossShare: edges ? cross / edges : 0,
    cycleShare: inCycles / Math.max(1, n),
    split,
    testShare: sum(codeIdx.filter(i => TEST_RE.test(all[i].p)).map(i => all[i].loc)) / Math.max(1, sum(codeIdx.map(i => all[i].loc))),
    coreFiles: n,
    totalFiles: codeIdx.length,
    ageYears: span / YEAR,
    idleYears: Math.max(0, (now - end) / YEAR),
    staleShare: F.filter(f => end - f.last > 2 * YEAR).length / Math.max(1, n),
    recentBoost: avgPerWindow && commitCount >= 200 && recentCommits >= 30 ? recentCommits / avgPerWindow : 0,
    hardware: (city.extras?.hardwareFiles || 0) > 0,
    infraFiles: infraIdx.length,
    infraShare: infraLoc / Math.max(1, infraLoc + codeLoc),
    proseFiles: proseIdx.length,
    proseShare: proseLoc / workLoc,
    proseWords: Math.round(proseLoc * 9), // ~9 words per non-empty line of prose
    proseLongest: Math.round(Math.max(0, ...proseIdx.map(i => all[i].loc)) * 9 / 100) * 100,
    locales: locales.size,
    infraKinds,
    usedCore: useCore,
  };
}

// Each archetype: a list of [score 0..1, reason] terms; the city's score is their mean.
const ARCHETYPES = {
  mountain: m => [
    [ramp(m.passShare, 0.2, 0.4), m.climb.len ? `${m.climb.len} empty directories of stairs up to ${m.climb.to}/` : `${pct(m.passShare)} of every path is stairs`],
    [ramp(m.avgDepth, 4, 7), `terraces ${m.avgDepth.toFixed(1)} directories up`],
  ],
  university: m => [
    [ramp(m.proseShare, 0.4, 0.7), `${pct(m.proseShare)} of it is prose: about ${m.proseWords.toLocaleString()} words over ${m.proseFiles} pages`],
    [ramp(m.proseFiles, 10, 60), m.locales > 1 ? `taught in ${m.locales + 1} languages` : `the longest page runs to about ${m.proseLongest.toLocaleString()} words`],
  ],
  port: m => [
    [ramp(m.infraShare, 0.3, 0.6), `${pct(m.infraShare)} of it is infrastructure: ${m.infraKinds.join(', ')}`],
    [ramp(m.infraFiles, 8, 50), `${m.infraFiles} cargo manifests on the quays`],
  ],
  smalltown: m => [
    [1 - ramp(m.files, 15, 40), `only ${m.files} file${m.files === 1 ? "" : "s"} — one main street`],
  ],
  manhattan: m => [
    [ramp(m.top5Share, 0.25, 0.55), `${pct(m.top5Share)} of all code lives in the biggest 5% of files`],
    [ramp(m.top3Share, 0.12, 0.35), `${pct(m.top3Share)} of imports point at just 3 files`],
    [1 - ramp(m.avgDepth, 2, 4), 'a flat, gridded directory layout'],
  ],
  hongkong: m => [
    [ramp(m.medianLoc, 120, 320), `the typical file is ${m.medianLoc} lines — towers everywhere`],
    [ramp(m.filesPerDir, 6, 18), `${m.filesPerDir.toFixed(1)} files squeezed into each directory`],
    [ramp(m.files, 100, 500), 'big enough to fill the harbour'],
  ],
  tokyo: m => [
    [ramp(m.files, 300, 1500), `${m.files.toLocaleString()} buildings`],
    // depth that's only an empty staircase (src/main/java/…) belongs to the mountain, not the wards
    [ramp(m.avgDepth * (1 - m.passShare), 2.5, 4.5), `wards inside wards — ${m.avgDepth.toFixed(1)} directories deep on average`],
    [1 - ramp(m.medianLoc, 120, 300), `mostly small buildings (median ${m.medianLoc} lines)`],
    [ramp(m.edgesPerFile, 0.4, 1.4), `${m.edgesPerFile.toFixed(1)} imports per file — everything connects`],
  ],
  la: m => [
    [ramp(m.files, 150, 800), `${m.files.toLocaleString()} buildings spread wide`],
    [1 - ramp(m.edgesPerFile, 0.15, 0.7), `only ${m.edgesPerFile.toFixed(2)} imports per file — everyone drives alone`],
    [1 - ramp(m.medianLoc, 60, 200), `low-rise: the median file is ${m.medianLoc} lines`],
  ],
  paris: m => [
    [ramp(m.ageYears, 6, 12), `${Math.floor(m.ageYears)} years of history`],
    [1 - ramp(m.locCv, 0.8, 1.8), 'buildings of a fairly even height'],
    [ramp(m.top3Share, 0.08, 0.25), 'avenues radiating from one centre'],
  ],
  venice: m => [
    [m.monorepo ? 1 : 0.3, m.monorepo ? 'a monorepo of separate islands' : 'distinct districts'],
    [ramp(m.groups, 3, 8), `${m.groups} islands`],
    [1 - ramp(m.crossShare, 0.05, 0.3), `only ${pct(m.crossShare)} of imports cross between islands`],
  ],
  barcelona: m => [
    [1 - ramp(m.dirCv, 0.35, 1.0), 'every block is about the same size'],
    [1 - ramp(m.locCv, 0.5, 1.2), 'every building is about the same height'],
    [ramp(m.dirs, 8, 30), `${m.dirs} near-identical blocks`],
  ],
};

const STATES = {
  ruins: m => m.staleShare > 0.35 && m.ageYears > 4 && `ancient ruins: ${pct(m.staleShare)} of files untouched for 2+ years`,
  ghost: m => m.idleYears > 1.5 && `ghost town: no commits for ${m.idleYears.toFixed(1)} years`,
  boom: m => m.recentBoost > 2.5 && `boomtown: ${m.recentBoost.toFixed(1)}× the usual commit rate lately`,
  garden: m => m.testShare > 0.6 && `garden city: ${pct(m.testShare)} of the code is tests`,
  maze: m => m.cycleShare > 0.5 && `old medina: ${pct(m.cycleShare)} of files sit in import cycles`,
  berlin: m => !m.monorepo && m.split > 0.97 && 'a divided city: its two biggest districts never import each other',
};

export const CITY_NAMES = {
  mountain: 'Mountain City', university: 'University Town', port: 'Port City', smalltown: 'Small Town', manhattan: 'Manhattan', hongkong: 'Hong Kong', tokyo: 'Tokyo',
  la: 'Los Angeles', paris: 'Paris', venice: 'Venice', barcelona: 'Barcelona',
};

export function classify(city) {
  const m = cityMetrics(city);
  const scored = Object.entries(ARCHETYPES).map(([id, fn]) => {
    const terms = fn(m);
    return { id, score: mean(terms.map(t => t[0])), reasons: terms.filter(t => t[0] >= 0.5).sort((a, b) => b[0] - a[0]).map(t => t[1]) };
  }).sort((a, b) => b.score - a.score);
  // a repo that's mostly infrastructure is a port, however little code it has; otherwise tiny repos are towns
  const port = scored.find(s => s.id === 'port');
  const best = m.infraShare >= 0.5 && m.infraFiles >= 8 ? port
    : m.proseShare >= 0.5 && m.proseFiles >= 10 ? scored.find(s => s.id === 'university')
    : m.files < 15 ? scored.find(s => s.id === 'smalltown') : scored[0];
  return {
    city: best.id,
    name: CITY_NAMES[best.id],
    score: +best.score.toFixed(2),
    reasons: best.reasons.slice(0, 3),
    runnerUp: scored.find(s => s.id !== best.id).id,
    ranking: scored.map(s => [s.id, +s.score.toFixed(2)]),
    states: Object.entries(STATES).map(([id, fn]) => [id, fn(m)]).filter(([, r]) => r).map(([id, reason]) => ({ id, reason })),
    chip: m.hardware,
    metrics: m,
  };
}
