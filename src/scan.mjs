// Scan a git repository into a compact "city blueprint":
// files (LOC, language), import edges (regex-based), and git history (born / last / churn / commits).
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { classify } from './classify.mjs';

const LANGS = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  vue: 'js', svelte: 'js', py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'kt',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'cs', rb: 'rb', php: 'php',
  swift: 'swift', scala: 'scala', lua: 'lua', zig: 'zig', ex: 'ex', exs: 'ex',
  css: 'css', scss: 'css', less: 'css', html: 'html', sh: 'sh',
};
const SKIP_DIR = /(^|\/)(node_modules|vendor|third_party|deps|dist|build|out|\.next|target|__pycache__|\.git)\//;
const SKIP_FILE = /(\.min\.(js|css)|\.bundle\.js|\.d\.ts)$/;
const MAX_BYTES = 1_000_000;

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
}

export async function scanRepo(repo, { maxCommits = 20000 } = {}) {
  repo = path.resolve(repo);
  const t0 = Date.now();
  const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const listed = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);

  const files = [];
  const index = new Map(); // path -> idx
  const hardwareFiles = listed.filter(p => /\.(v|sv|svh|vhd|vhdl)$/i.test(p)).length;
  for (const p of listed) {
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    const lang = LANGS[ext];
    if (!lang || SKIP_DIR.test(p) || SKIP_FILE.test(p)) continue;
    let text;
    try {
      const full = path.join(root, p);
      if (statSync(full).size > MAX_BYTES) continue;
      text = readFileSync(full, 'utf8');
    } catch { continue; }
    let loc = 0;
    for (const line of text.split('\n')) if (line.trim()) loc++;
    if (!loc) continue;
    index.set(p, files.length);
    files.push({ p, lang, loc, text, imp: new Set(), churn: 0, born: 0, last: 0 });
  }

  resolveImports(root, files, index, listed);

  // ---- git history: one pass over `git log --numstat`, oldest first, following renames
  // so a file moved into src/ keeps the birthday of its original path.
  const commits = [];
  const alias = new Map(); // path at this point in history -> history record
  await new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', root, 'log', `--max-count=${maxCommits}`, '--numstat',
      '--format=@@%ct', '-M', '--reverse'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const rl = readline.createInterface({ input: proc.stdout });
    let cur = null;
    rl.on('line', line => {
      if (line.startsWith('@@')) {
        cur = { t: +line.slice(2), f: [] };
        commits.push(cur);
        return;
      }
      const parts = line.split('\t');
      if (!cur || parts.length < 3) return;
      const [from, to] = renamePaths(parts.slice(2).join('\t'));
      let h = alias.get(from);
      if (from !== to) { alias.delete(from); }
      if (!h) h = { born: cur.t, last: 0, churn: 0 };
      alias.set(to, h);
      h.last = cur.t;
      h.churn++;
      cur.f.push(h);
    });
    proc.on('error', reject);
    proc.on('close', resolve);
  });
  const recIdx = new Map();
  for (const [p, h] of alias) {
    const idx = index.get(p);
    if (idx === undefined) continue;
    recIdx.set(h, idx);
    Object.assign(files[idx], { born: h.born, last: h.last, churn: h.churn });
  }
  for (const c of commits) c.f = [...new Set(c.f.map(h => recIdx.get(h)).filter(i => i !== undefined))];
  const touched = commits.filter(c => c.f.length);
  const start = touched.length ? touched[0].t : 0;
  const end = touched.length ? touched[touched.length - 1].t : 0;
  for (const f of files) { if (!f.born) f.born = f.last = start; }

  const edges = files.reduce((n, f) => n + f.imp.size, 0);
  const city = {
    name: path.basename(root),
    scannedAt: Math.floor(Date.now() / 1000),
    scanMs: Date.now() - t0,
    start, end,
    stats: { files: files.length, loc: files.reduce((n, f) => n + f.loc, 0), edges, commits: touched.length },
    files: files.map(f => ({ p: f.p, lang: f.lang, loc: f.loc, imp: [...f.imp], churn: f.churn, born: f.born, last: f.last })),
    // compact: [time, fileIdx, fileIdx, ...]; skip giant sweeping commits (formatting, renames)
    commits: touched.filter(c => c.f.length < 200).map(c => [c.t, ...c.f]),
    extras: { hardwareFiles },
  };
  city.identity = classify(city);
  return city;
}

// numstat rename forms: "a.py => b.py" and "src/{old => new}/x.py" (either side of the braces may be empty)
function renamePaths(p) {
  if (!p.includes(' => ')) return [p, p];
  const m = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
  if (!m) { const [a, b] = p.split(' => '); return [a, b]; }
  const clean = s => s.replace(/\/{2,}/g, '/').replace(/^\//, '');
  return [clean(m[1] + m[2] + m[4]), clean(m[1] + m[3] + m[4])];
}

// ---------------------------------------------------------------- imports

const JS_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]/g;
const PY_RE = /^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*, ()]+)|^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const GO_BLOCK = /import\s*\(([\s\S]*?)\)|import\s+(?:\w+\s+)?"([^"]+)"/g;
const RS_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;|use\s+(crate|super|self)((?:::\w+)+)/gm;
const C_RE = /#include\s*"([^"]+)"/g;

const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

// workspace packages, so `import '@scope/pkg'` and `use my_crate::x` link across a monorepo
function workspacePackages(root, listed) {
  const js = new Map(), rust = new Map();
  for (const p of listed) {
    if (SKIP_DIR.test(p)) continue;
    const base = path.posix.basename(p);
    if (base !== 'package.json' && base !== 'Cargo.toml') continue;
    let text;
    try { text = readFileSync(path.join(root, p), 'utf8'); } catch { continue; }
    const dir = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p) + '/';
    if (base === 'package.json') {
      try { const name = JSON.parse(text).name; if (name) js.set(name, dir); } catch { }
    } else {
      const m = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(text);
      if (m) rust.set(m[1].replace(/-/g, '_'), dir);
    }
  }
  return { js, rust };
}

function resolveImports(root, files, index, listed) {
  const ws = workspacePackages(root, listed);
  const jsNames = [...ws.js.keys()].sort((a, b) => b.length - a.length);
  const addEdge = (f, target) => {
    const j = index.get(target);
    if (j !== undefined && files[j] !== f) f.imp.add(j);
  };

  // python module index: dotted path -> idx, also with a leading "src/" or package root stripped
  const pyMods = new Map();
  // go: package dir -> files
  const goDirs = new Map();
  for (const [i, f] of files.entries()) {
    if (f.lang === 'py') {
      let m = f.p.replace(/\.py$/, '').replace(/\/__init__$/, '');
      const parts = m.split('/');
      for (let k = 0; k < Math.min(parts.length, 3); k++) {
        const key = parts.slice(k).join('.');
        if (!pyMods.has(key)) pyMods.set(key, i);
      }
    } else if (f.lang === 'go') {
      const d = path.posix.dirname(f.p);
      if (!goDirs.has(d)) goDirs.set(d, []);
      goDirs.get(d).push(i);
    }
  }
  let goModule = '';
  try { goModule = /^module\s+(\S+)/m.exec(readFileSync(path.join(root, 'go.mod'), 'utf8'))[1]; } catch { }

  for (const f of files) {
    const dir = path.posix.dirname(f.p);
    const text = f.text;
    if (f.lang === 'js' || f.lang === 'ts') {
      for (const m of text.matchAll(JS_RE)) {
        const spec = m[1] || m[2] || m[3];
        if (!spec) continue;
        if (!spec.startsWith('.')) {
          // bare import of a sibling workspace package: pkg → its src/index, pkg/sub → src/sub or sub
          const name = jsNames.find(n => spec === n || spec.startsWith(n + '/'));
          if (name === undefined) continue;
          const dir = ws.js.get(name), sub = spec.slice(name.length + 1);
          const bases = sub ? [dir + 'src/' + sub, dir + sub] : [dir + 'src/index', dir + 'index', dir + 'src/main', dir + 'lib/index'];
          outer: for (const b of bases) for (const ext of JS_EXT) if (index.has(b + ext)) { addEdge(f, b + ext); break outer; }
          continue;
        }
        const base = path.posix.normalize(path.posix.join(dir, spec));
        const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, ''); // TS "import './x.js'" -> x.ts
        for (const ext of JS_EXT) {
          if (index.has(base + ext)) { addEdge(f, base + ext); break; }
          if (stripped !== base && index.has(stripped + ext)) { addEdge(f, stripped + ext); break; }
        }
      }
    } else if (f.lang === 'py') {
      for (const m of text.matchAll(PY_RE)) {
        if (m[1] !== undefined) {
          let mod = m[1];
          const dots = mod.match(/^\.*/)[0].length;
          if (dots) {
            let base = dir;
            for (let k = 1; k < dots; k++) base = path.posix.dirname(base);
            const rest = mod.slice(dots);
            const prefix = (base === '.' ? '' : base).split('/').filter(Boolean).join('.');
            mod = [prefix, rest].filter(Boolean).join('.');
          }
          // "from pkg import submodule" also links to pkg.submodule when it exists
          const names = m[2].replace(/[()]/g, '').split(',').map(s => s.trim().split(/\s+/)[0]);
          let hit = false;
          for (const n of names) {
            const j = pyMods.get(mod + '.' + n);
            if (j !== undefined && files[j] !== f) { f.imp.add(j); hit = true; }
          }
          if (!hit) { const j = pyMods.get(mod); if (j !== undefined && files[j] !== f) f.imp.add(j); }
        } else {
          for (const name of m[3].split(',')) {
            const j = pyMods.get(name.trim());
            if (j !== undefined && files[j] !== f) f.imp.add(j);
          }
        }
      }
    } else if (f.lang === 'go' && goModule) {
      for (const m of text.matchAll(GO_BLOCK)) {
        const specs = m[1] ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : [m[2]];
        for (const s of specs) {
          if (!s.startsWith(goModule + '/')) continue;
          const pkg = goDirs.get(s.slice(goModule.length + 1));
          if (!pkg) continue;
          // link to the largest file of the package (its "landmark")
          let best = pkg[0];
          for (const j of pkg) if (files[j].loc > files[best].loc) best = j;
          if (files[best] !== f) f.imp.add(best);
        }
      }
    } else if (f.lang === 'rs') {
      const crateRoot = f.p.includes('src/') ? f.p.slice(0, f.p.lastIndexOf('src/') + 4) : '';
      for (const m of text.matchAll(/\b(?:use|extern\s+crate)\s+(\w+)((?:::\w+)*)/g)) {
        const dir = ws.rust.get(m[1]);
        if (dir === undefined || m[1] === 'crate') continue;
        const segs = (m[2] || '').split('::').filter(Boolean);
        let hit = false;
        for (let k = segs.length; k > 0 && !hit; k--) {
          const b = dir + 'src/' + segs.slice(0, k).join('/');
          if (index.has(b + '.rs')) { addEdge(f, b + '.rs'); hit = true; }
          else if (index.has(b + '/mod.rs')) { addEdge(f, b + '/mod.rs'); hit = true; }
        }
        if (!hit) addEdge(f, dir + 'src/lib.rs');
      }
      for (const m of text.matchAll(RS_RE)) {
        if (m[1]) {
          const own = /(^|\/)(mod|lib|main)\.rs$/.test(f.p) ? dir : f.p.replace(/\.rs$/, '');
          const b = (own === '.' ? '' : own + '/') + m[1];
          addEdge(f, b + '.rs'); addEdge(f, b + '/mod.rs');
        } else {
          const segs = m[3].split('::').filter(Boolean);
          let base = m[2] === 'crate' ? crateRoot.replace(/\/$/, '') : dir;
          if (m[2] === 'super') base = path.posix.dirname(base);
          for (let k = segs.length; k > 0; k--) {
            const b = [base, ...segs.slice(0, k)].filter(x => x && x !== '.').join('/');
            if (index.has(b + '.rs')) { addEdge(f, b + '.rs'); break; }
            if (index.has(b + '/mod.rs')) { addEdge(f, b + '/mod.rs'); break; }
          }
        }
      }
    } else if (f.lang === 'c' || f.lang === 'cpp') {
      for (const m of text.matchAll(C_RE)) {
        addEdge(f, path.posix.normalize(path.posix.join(dir, m[1])));
      }
    }
    f.text = null;
  }
}
