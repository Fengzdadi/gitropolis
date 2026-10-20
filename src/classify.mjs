// Which city is this repo? Turn the scanned blueprint into a handful of metrics, score each
// city archetype from them, and explain the winner in plain words. Same repo → same city.

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
  // manifests / build files ('cfg') are buildings in the city but not part of the codebase being judged
  const codeIdx = all.map((f, i) => f.lang === 'cfg' ? -1 : i).filter(i => i >= 0);
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
  const cfgOnly = codeIdx.length < all.length;
  const start = cfgOnly && codeIdx.length ? Math.min(...codeIdx.map(i => all[i].born)) : city.start;
  const end = cfgOnly && codeIdx.length ? Math.max(...codeIdx.map(i => all[i].last)) : city.end;
  const commits = cfgOnly ? city.commits.filter(c => { for (let k = 1; k < c.length; k++) if (all[c[k]].lang !== 'cfg') return true; return false; }) : city.commits;
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
    usedCore: useCore,
  };
}

// Each archetype: a list of [score 0..1, reason] terms; the city's score is their mean.
const ARCHETYPES = {
  smalltown: m => [
    [1 - ramp(m.files, 15, 40), `only ${m.files} files — one main street`],
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
    [ramp(m.avgDepth, 2.5, 4.5), `wards inside wards — ${m.avgDepth.toFixed(1)} directories deep on average`],
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
  smalltown: 'Small Town', manhattan: 'Manhattan', hongkong: 'Hong Kong', tokyo: 'Tokyo',
  la: 'Los Angeles', paris: 'Paris', venice: 'Venice', barcelona: 'Barcelona',
};

export function classify(city) {
  const m = cityMetrics(city);
  const scored = Object.entries(ARCHETYPES).map(([id, fn]) => {
    const terms = fn(m);
    return { id, score: mean(terms.map(t => t[0])), reasons: terms.filter(t => t[0] >= 0.5).sort((a, b) => b[0] - a[0]).map(t => t[1]) };
  }).sort((a, b) => b.score - a.score);
  // tiny repos are towns, whatever else they look like
  const best = m.files < 15 ? scored.find(s => s.id === 'smalltown') : scored[0];
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
