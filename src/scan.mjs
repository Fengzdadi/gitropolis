// Scan a git repository into a compact "city blueprint":
// files (LOC, language), import edges (regex-based), and git history (born / last / churn / commits).
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { classify } from './classify.mjs';
import { fileAnatomy, docRole, LOCKFILE } from './anatomy.mjs';

const LANGS = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  vue: 'js', svelte: 'js', py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'kt',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'cs', rb: 'rb', php: 'php',
  swift: 'swift', scala: 'scala', lua: 'lua', zig: 'zig', ex: 'ex', exs: 'ex',
  dart: 'dart', gd: 'gd', cu: 'cpp', cuh: 'cpp', // Flutter, Godot's GDScript, CUDA kernels
  css: 'css', scss: 'css', less: 'css', html: 'html', sh: 'sh',
  // infrastructure as code: only kept when it's a real part of the repo (see INFRA_MIN)
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl', bicep: 'hcl', yaml: 'yaml', yml: 'yaml',
  jsonnet: 'jsonnet', libsonnet: 'jsonnet', nix: 'nix', j2: 'tmpl', tpl: 'tmpl',
  // prose: documentation pages, books, guides (only kept in repos that are mostly prose, see PROSE_MIN)
  md: 'md', mdx: 'md', markdown: 'md', rst: 'md', adoc: 'md',
};
export const PROSE = new Set(['md']);
// a farm: notebooks are the farmhouses, datasets the fields, model weights the silos
export const FARM = new Set(['nb', 'data', 'model']);
const FARM_MIN = 0.25;
const DATA_EXT = /\.(csv|tsv|xlsx?|parquet|feather|arrow|jsonl|ndjson|dta|sav)$/i;
const MODEL_EXT = /\.(pt|pth|ckpt|onnx|safetensors|h5|hdf5|pkl|pickle|joblib|npy|npz|bin|gguf)$/i;
const BINARY_FARM = /\.(xlsx?|parquet|feather|arrow|dta|sav|pt|pth|ckpt|onnx|safetensors|h5|hdf5|pkl|pickle|joblib|npy|npz|bin|gguf)$/i;
// a docs site or a book: its pages are the city (a university town). Ordinary repos' docs/ folders
// stay out, so their cities don't change.
const PROSE_MIN = 0.5;
export const INFRA = new Set(['hcl', 'yaml', 'jsonnet', 'nix', 'tmpl']);
// a repo keeps its infrastructure files as buildings when they're at least this share of its lines
// (ordinary repos sit near 0%: a few CI and config YAMLs, which stay out of the city as before).
// Test data doesn't count, or a YAML parser's fixtures would make it a port.
const INFRA_MIN = 0.1;
const INFRA_FIXTURE = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|__fixtures__|testdata|samples?|docs?)(\/|$)/;
// YAML that is a dictionary of translations (config/locales/fr.yml, i18n/) isn't infrastructure
const SMARTY = /\{\$\w|\{\/(?:if|foreach|section|block|capture|literal)\}|\{(?:include|extends)\s+file=/;
const LOCALE_DIR = /(^|\/)(locales?|i18n|l10n|translations?|lang)\//;
// non-code files that still matter in the city: dependency manifests and build/CI definitions
const CFG_FILE = /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|setup\.cfg|go\.mod|Gemfile|pom\.xml|build\.gradle(\.kts)?|requirements[^/]*\.txt|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml|fly\.toml|vercel\.json|netlify\.toml|Procfile|Makefile|tsconfig[^/]*\.json)$|^\.github\/workflows\/[^/]+\.ya?ml$/;
const SKIP_DIR = /(^|\/)(node_modules|vendor|third_party|deps|dist|build|out|\.next|target|__pycache__|\.git)\//;
const SKIP_FILE = /(\.min\.(js|css)|\.bundle\.js|\.d\.ts)$/;
const MAX_BYTES = 1_000_000;
// buildings that are landmarks, not code: they never decide the city and never join the import graph
const NONCODE = new Set(['cfg', 'doc', 'lock']);
const DAY = 86400, YEAR = 365.25 * DAY;
// only these languages get import edges, so only they can honestly be called "unimported"
const LINKED = new Set(['js', 'ts', 'py', 'go', 'rs', 'c', 'cpp', 'java', 'kt', 'dart']);
const ENTRY = /(^|\/)((main|index|cli|app|server)\.[^/]+|__main__\.py|mod\.rs|lib\.rs)$|(^|\/)(bin|cmd)\//;
// not reached by imports on purpose: samples / fixtures / generated apps, framework file conventions, test setup
const LOOSE = /(^|\/)(__\w*fixtures?__|fixtures?|examples?|templates?|integrations?|playgrounds?|e2e)\/|(^|\/)(layout|page|route|loading|error|middleware|test-setup|setup|conftest)\.[^/]+$/;
const STR_REF = /['"`]([\w@.\/-]*[\w-]\.(?:[cm]?[jt]sx?|py|rs|go))['"`]/g; // 'x.cjs' passed as a string: loaders, workers, test harnesses
const SRC_REF = /[\w@.\/-]+\.(?:[cm]?[jt]sx?|py|rs|go|c|h|cc|cpp|hpp|vue|svelte)\b/g;

const stemOf = p => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');

// What a file says about the kind of project it belongs to: model code (a tech campus), or a game made
// with an engine (a theme park). Only the project's own files count, not the examples, tests or docs
// beside it: a physics library with a pygame demo isn't a game, nor a web framework with a torch example
// a campus. An engine's own repository (bevy, pygame) is the engine, not a game made with it.
// (also as part of a folder's name: android-test-app/, sample_app/, demo-web/)
const SAMPLE_DIR = /(^|\/)(\w+[-_])?(examples?|samples?|demos?|tests?|fixtures?|playgrounds?|benchmarks?|docs?)([-_]\w+)?\//;
const ML_IMPORT = /^\s*(?:import|from)\s+(torch|tensorflow|jax|flax|keras|transformers|diffusers|lightning|pytorch_lightning|sklearn|triton|accelerate|peft|vllm|timm|xformers|mlx)\b/m;
const ENGINES = [
  ['Godot', (p, lang) => lang === 'gd'],
  ['Unity', (p, lang) => lang === 'cs' && /(^|\/)Assets\//.test(p)],
  ['Unreal', (p, lang) => lang === 'cpp' && /(^|\/)Source\//.test(p)],
  ['Bevy', (p, lang, t) => lang === 'rs' && /\buse\s+bevy::/.test(t)],
  ['pygame', (p, lang, t) => lang === 'py' && /^\s*(?:import|from)\s+(?:pygame|arcade|pyglet|ursina|panda3d)\b/m.test(t)],
  ['LÖVE', (p, lang, t) => lang === 'lua' && /\bfunction\s+love\.(?:load|update|draw|run|conf)\b/.test(t)],
  ['Phaser', (p, lang, t) => (lang === 'js' || lang === 'ts') && /\bnew\s+Phaser\.Game\b/.test(t)],
];
const ENGINE_REPO = /^(bevy|pygame|pygame-ce|arcade|pyglet|ursina|panda3d|godot|love|phaser|UnrealEngine)$/i;
function signalOf(p, ext, lang, text) {
  if (SAMPLE_DIR.test(p)) return undefined;
  if (ext === 'cu' || ext === 'cuh' || (lang === 'py' && ML_IMPORT.test(text))) return 'ml';
  for (const [name, test] of ENGINES) if (test(p, lang, text)) return name;
  return undefined;
}
// The engine the game is made with. A project file settles it for Godot, Unity and Unreal, and LÖVE's
// callbacks for LÖVE; an engine that's only a library (Bevy, pygame, Phaser) has to be used throughout,
// not by one visualiser script in a bigger project. files: the project's own files in the engine's language.
const ENGINE_LANG = { Godot: ['gd'], Unity: ['cs'], Unreal: ['cpp', 'c'], Bevy: ['rs'], pygame: ['py'], 'LÖVE': ['lua'], Phaser: ['js', 'ts'] };
function gameEngine(files, listed, name) {
  if (ENGINE_REPO.test(name)) return null;
  const marked = {};
  for (const f of files) if (f.g && f.g !== 'ml') marked[f.g] = (marked[f.g] || 0) + 1;
  const own = name => files.filter(f => ENGINE_LANG[name].includes(f.lang) && !SAMPLE_DIR.test(f.p)).length;
  const project = { Godot: listed.some(p => /(^|\/)project\.godot$/.test(p)), Unity: listed.some(p => /(^|\/)ProjectSettings\/ProjectVersion\.txt$/.test(p)), Unreal: listed.some(p => p.endsWith('.uproject')), 'LÖVE': !!marked['LÖVE'] };
  const found = Object.keys(marked).filter(e => e in project ? project[e] : marked[e] >= 10 || marked[e] >= own(e) * 0.25);
  const best = found.map(e => ({ name: e, files: own(e) })).sort((a, b) => b.files - a.files)[0];
  return best?.files ? best : null;
}
// A mobile app (not a library, and not the sample app beside one): the platforms it ships to. An Android
// app declares an activity, an iOS app has an application target, a Flutter app a lib/main.dart, and a
// React Native app its own ios/ or android/ folder.
function appPlatforms(root, listed) {
  const read = p => { try { return readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } };
  const own = listed.filter(p => !SAMPLE_DIR.test(p) && !SKIP_DIR.test(p)), ownSet = new Set(own);
  const out = new Set();
  for (const p of own) {
    const dir = p.slice(0, p.lastIndexOf('/') + 1);
    if (/(^|\/)pubspec\.yaml$/.test(p)) { if (ownSet.has(dir + 'lib/main.dart') && /^\s+flutter:/m.test(read(p))) out.add('Flutter'); }
    else if (/(^|\/)package\.json$/.test(p)) { if (/"react-native"\s*:/.test(read(p)) && own.some(q => q.startsWith(dir + 'ios/') || q.startsWith(dir + 'android/'))) out.add('React Native'); }
    else if (/(^|\/)AndroidManifest\.xml$/.test(p)) { if (/<activity\b/.test(read(p))) out.add('Android'); }
    else if (/\.xcodeproj\/project\.pbxproj$/.test(p)) { const t = read(p); if (t.includes('com.apple.product-type.application') && /SDKROOT = iphoneos|TARGETED_DEVICE_FAMILY/.test(t)) out.add('iOS'); }
  }
  return ['Flutter', 'React Native', 'Android', 'iOS'].filter(x => out.has(x));
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
}

// name: the repository's name, when the folder it's cloned into has another (the hosted scanner's)
export async function scanRepo(repo, { maxCommits = 20000, name } = {}) {
  repo = path.resolve(repo);
  const t0 = Date.now();
  const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
  name ||= path.basename(root);
  const listed = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);

  const files = [];
  const refs = new Set();
  const index = new Map(); // path -> idx
  const hardwareFiles = listed.filter(p => /\.(v|sv|svh|vhd|vhdl)$/i.test(p)).length;
  for (const p of listed) {
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    const base = p.slice(p.lastIndexOf('/') + 1);
    const lang = LOCKFILE.test(p) ? 'lock' : CFG_FILE.test(p) ? 'cfg' : docRole(base) ? 'doc'
      : ext === 'ipynb' ? 'nb' : DATA_EXT.test(p) ? 'data' : MODEL_EXT.test(p) && !/(^|\/)(node_modules|tests?)\//.test(p) ? 'model' : LANGS[ext];
    if (!lang || SKIP_DIR.test(p) || SKIP_FILE.test(p)) continue;
    if (lang === 'yaml' && LOCALE_DIR.test(p)) continue;
    let text, loc = 0;
    try {
      const full = path.join(root, p);
      const size = statSync(full).size;
      if (lang === 'data' || lang === 'model') {
        // a dataset's or a model's size is what matters, not its text: about a line per 60 bytes of
        // table, per 2 KB of weights (a field and a silo should be big, not the whole map)
        if (BINARY_FARM.test(p) || size > MAX_BYTES) { loc = Math.max(10, Math.min(lang === 'model' ? 3000 : 20000, Math.round(size / (lang === 'model' ? 2000 : 60)))); text = ''; }
        else text = readFileSync(full, 'utf8');
      } else if (lang === 'nb') {
        // a notebook's lines are its cells' source; outputs (often megabytes of images) don't count
        if (size > 30 * MAX_BYTES) continue;
        try {
          const nb = JSON.parse(readFileSync(full, 'utf8'));
          const cells = nb.cells || nb.worksheets?.[0]?.cells || [];
          const src = c => [].concat(c.source ?? c.input ?? []).join('');
          text = cells.filter(c => c.cell_type === 'code').map(src).join('\n');
          loc = cells.map(src).join('\n').split('\n').filter(l => l.trim()).length;
        } catch { continue; }
      } else if (size > MAX_BYTES) {
        // a huge lockfile is still a landmark: estimate its lines instead of reading it
        if (lang !== 'lock') continue;
        loc = Math.round(size / 40); text = '';
      } else if (base === 'bun.lockb') { loc = Math.round(size / 40); text = ''; } // binary
      else text = readFileSync(full, 'utf8');
    } catch { continue; }
    // a .tpl is infrastructure when it's a Helm / Go ({{ .Values.x }}) or Terraform (${x}, %{ if }) template,
    // not when it's a PHP Smarty page ({$title}, {if $x}…{/if}, {include file=…})
    if (ext === 'tpl' && !text.includes('{{') && SMARTY.test(text)) continue;
    // manifests, scripts and docs often name entry files (package.json exports, Makefile, README): keep their stems
    // (stems, because exports point at built `x.js` while the source is `x.ts`)
    if (text && (lang === 'cfg' || lang === 'doc')) for (const m of text.matchAll(SRC_REF)) refs.add(stemOf(m[0]));
    else if (LINKED.has(lang) && text.includes('.')) for (const m of text.matchAll(STR_REF)) refs.add(stemOf(m[1]));
    if (!loc) for (const line of text.split('\n')) if (line.trim()) loc++;
    if (!loc) continue;
    const a = FARM.has(lang) ? { c: 0, f: 0, lf: 0, x: 0, r: { nb: 'notebook', data: 'field', model: 'silo' }[lang], k: p.slice(p.lastIndexOf('.') + 1).toLowerCase() }
      : INFRA.has(lang) ? { c: 0, f: 0, lf: 0, x: 0, r: 'infra', k: infraKind(p, text, lang) }
      : PROSE.has(lang) ? { c: (text.match(/^#{1,3} /gm) || []).length, f: 0, lf: 0, x: 0, r: 'page', k: pageKind(p) }
      : fileAnatomy(p, text, lang);
    files.push({ p, lang, loc, a, text, g: signalOf(p, ext, lang, text), imp: new Set(), churn: 0, born: 0, last: 0 });
  }
  {
    // What share of the repo's lines is infrastructure, prose, notebooks and data? Each is measured
    // once, over the same total, before anything is dropped (test fixtures don't count towards a
    // category: a YAML parser's test YAML isn't infrastructure).
    const kind = f => INFRA.has(f.lang) ? 'infra' : PROSE.has(f.lang) ? 'prose' : FARM.has(f.lang) ? 'farm' : NONCODE.has(f.lang) ? null : 'code';
    const loc = { code: 0, infra: 0, prose: 0, farm: 0 }, n = { infra: 0, prose: 0, farm: 0 };
    for (const f of files) {
      const k = kind(f);
      if (!k) continue;
      if (k !== 'code' && INFRA_FIXTURE.test(k === 'prose' ? f.p.replace(/(^|\/)docs?\//, '$1') : f.p)) continue;
      loc[k] += f.loc;
      if (k !== 'code') n[k]++;
    }
    const total = Math.max(1, loc.code + loc.infra + loc.prose + loc.farm);
    const keep = { infra: n.infra >= 8 && loc.infra / total >= INFRA_MIN, prose: n.prose >= 10 && loc.prose / total >= PROSE_MIN, farm: n.farm >= 8 && loc.farm / total >= FARM_MIN };
    for (let k = files.length - 1; k >= 0; k--) { const c = kind(files[k]); if (c && c !== 'code' && !keep[c]) files.splice(k, 1); }
  }
  files.forEach((f, i) => index.set(f.p, i));

  const { tails, jvmUsed } = resolveImports(root, files, index, listed);

  // ---- git history: one pass over `git log --name-status`, oldest first, following renames
  // so a file moved into src/ keeps the birthday of its original path. (Only which files each commit
  // touched matters, not how many lines: --numstat would diff every changed file, often 10x slower.)
  const commits = [];
  const alias = new Map(); // path at this point in history -> history record
  await new Promise((resolve, reject) => {
    // quotePath=false: non-ASCII names (中文.md, café.js) come back as raw UTF-8, matching ls-files
    const proc = spawn('git', ['-C', root, '-c', 'core.quotePath=false', 'log', `--max-count=${maxCommits}`, '--name-status',
      '--format=@@%ct', '-M', '--reverse'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const rl = readline.createInterface({ input: proc.stdout });
    let cur = null;
    rl.on('line', line => {
      if (line.startsWith('@@')) {
        cur = { t: +line.slice(2), f: [] };
        commits.push(cur);
        return;
      }
      // "M\tpath", or "R097\told\tnew" for a rename (a path with a tab in it comes quoted)
      const parts = line.split('\t');
      if (!cur || parts.length < 2) return;
      const from = unquote(parts[1]), to = parts[0][0] === 'R' ? unquote(parts[2]) : from;
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
  // --max-count keeps only the newest commits: when it bit, remember when the repo really began
  const truncated = commits.length >= maxCommits;
  let firstCommit = 0;
  if (truncated) try {
    for (const t of git(root, ['log', '--max-parents=0', '--format=%ct', 'HEAD']).split('\n')) if (+t && (!firstCommit || +t < firstCommit)) firstCommit = +t;
  } catch { }

  const status = fileStatus(files, start, end, tails, refs, jvmUsed);
  const edges = files.reduce((n, f) => n + f.imp.size, 0);
  const city = {
    name,
    scannedAt: Math.floor(Date.now() / 1000),
    scanMs: Date.now() - t0,
    start, end, ...(truncated && { truncated, firstCommit }),
    stats: { files: files.length, loc: files.reduce((n, f) => n + f.loc, 0), edges, commits: touched.length },
    files: files.map(f => ({ p: f.p, lang: f.lang, loc: f.loc, imp: [...f.imp], a: f.a, churn: f.churn, born: f.born, last: f.last, ...(status.get(f) && { s: status.get(f) }), ...(f.g && { g: f.g }) })),
    // compact: [time, fileIdx, fileIdx, ...]; skip giant sweeping commits (formatting, renames)
    commits: touched.filter(c => c.f.length < 200).map(c => [c.t, ...c.f]),
    extras: { hardwareFiles, engine: gameEngine(files, listed, name), app: appPlatforms(root, listed) },
  };
  city.identity = classify(city);
  return city;
}

// Per-file status flags, once history is known. Each is deliberately conservative:
// a wrong "dead" label on a living file is worse than a missed one.
function fileStatus(files, start, end, tails, refs, jvmUsed) {
  const out = new Map();
  const add = (f, s) => { if (!out.has(f)) out.set(f, []); out.get(f).push(s); };
  const inDeg = new Array(files.length).fill(0);
  for (const f of files) for (const j of f.imp) inDeg[j]++;
  // go imports link a whole package (to its biggest file), so a package counts as used if any file in it is
  const goUsed = new Set();
  files.forEach((f, i) => { if (f.lang === 'go' && inDeg[i]) goUsed.add(path.posix.dirname(f.p)); });
  // java / kotlin: a class used from its own package needs no import (jvmUsed: named by a package-mate),
  // and kotlin's top-level functions are used without naming the file, so there the Go rule applies too
  const ktUsed = new Set();
  files.forEach((f, i) => { if (f.lang === 'kt' && (inDeg[i] || jvmUsed.has(i))) ktUsed.add(path.posix.dirname(f.p)); });

  const span = end - start, win = Math.max(span * 0.02, 21 * DAY);
  const code = files.filter(f => !NONCODE.has(f.lang));
  const locs = code.map(f => f.loc).sort((a, b) => a - b);
  const giantMin = Math.max(2000, 8 * (locs[locs.length >> 1] || 0));
  const giants = code.filter(f => f.loc >= giantMin).sort((a, b) => b.loc - a.loc).slice(0, Math.max(1, Math.floor(code.length * 0.01)));

  files.forEach((f, i) => {
    const base = f.p.slice(f.p.lastIndexOf('/') + 1);
    const stem = base.replace(/\.[^.]*$/, '');
    if (f.a.r === 'source' && LINKED.has(f.lang) && !inDeg[i] && !ENTRY.test(f.p) && !LOOSE.test(f.p) && !refs.has(stem)
        && (f.lang !== 'c' && f.lang !== 'cpp' || f.p.endsWith('.h') || f.p.endsWith('.hpp')) // .c files are compiled, not included
        && !(f.lang === 'go' && goUsed.has(path.posix.dirname(f.p)))
        && !jvmUsed.has(i) && !(f.lang === 'kt' && ktUsed.has(path.posix.dirname(f.p)))
        && !(tails.has(stem) || tails.has(path.posix.basename(path.posix.dirname(f.p)) + '/' + stem)) // aliased imports (`@/x/foo`) we could not resolve
        && (f.imp.size || f.loc >= 30) && end - f.last > 2 * YEAR) add(f, 'dead');
    if (end - f.born <= win) add(f, 'new');
    if (giants.includes(f)) add(f, 'giant');
  });
  return out;
}

// git still C-quotes a path with a tab, newline, quote or backslash in it: "a\"b.js", "x\303\251"
function unquote(p) {
  if (!(p.length > 1 && p.startsWith('"') && p.endsWith('"'))) return p;
  const bytes = [];
  const body = p.slice(1, -1);
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c !== '\\') { bytes.push(...Buffer.from(c)); continue; }
    const n = body[++k];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.substr(k, 3), 8)); k += 2; }
    else bytes.push({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

// ---------------------------------------------------------------- imports

// (between `import`/`export` and `from` there are only names, braces, commas, `*`, whitespace and comments, never
// another import or export: the run ends at the next statement, so a 40,000-line file of exports is read
// once, not once per export; a // comment runs to its line's end, so it can't be split and re-read either)
const JS_RE = /(?:import|export)\s(?:\/\/[^\n]*(?![^\n])|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/|(?!\b(?:import|export)\b)[\w$\s{},*])*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]/g;
const PY_RE = /^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*, ()]+)|^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
const GO_BLOCK = /import\s*\(([\s\S]*?)\)|import\s+(?:\w+\s+)?"([^"]+)"/g;
const RS_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;|use\s+(crate|super|self)((?:::\w+)+)/gm;
const C_RE = /#include\s*"([^"]+)"/g;
const JVM_PKG = /^\s*package\s+([\w.]+)/m;
const JVM_IMPORT = /^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;?\s*$/gm;
const DART_RE = /^\s*(?:import|export|part)\s+['"]([^'"]+\.dart)['"]/gm;
// GDScript: scripts load each other by path (preload("res://player.gd"), extends "res://enemy.gd"),
// and use each other by the global name one declares (class_name Player … extends Player, Player.new())
const GD_PATH = /\b(?:preload|load|extends)\s*\(?\s*["']((?:res:\/\/)?[^"']+\.gd)["']/g;
const GD_CLASS = /^class_name\s+(\w+)/m;

const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

// workspace packages, so `import '@scope/pkg'` and `use my_crate::x` link across a monorepo
function workspacePackages(root, listed) {
  const js = new Map(), rust = new Map(), dart = new Map();
  for (const p of listed) {
    if (SKIP_DIR.test(p)) continue;
    const base = path.posix.basename(p);
    if (base !== 'package.json' && base !== 'Cargo.toml' && base !== 'pubspec.yaml') continue;
    let text;
    try { text = readFileSync(path.join(root, p), 'utf8'); } catch { continue; }
    const dir = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p) + '/';
    if (base === 'package.json') {
      try { const name = JSON.parse(text).name; if (name) js.set(name, dir); } catch { }
    } else if (base === 'pubspec.yaml') {
      const m = /^name:\s*(\w+)/m.exec(text);
      if (m) dart.set(m[1], dir);
    } else {
      const m = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(text);
      if (m) rust.set(m[1].replace(/-/g, '_'), dir);
    }
  }
  return { js, rust, dart };
}

function resolveImports(root, files, index, listed) {
  const ws = workspacePackages(root, listed);
  const jsNames = [...ws.js.keys()].sort((a, b) => b.length - a.length);
  const tails = new Set(); // last segment of bare (aliased / unresolved) JS specifiers: proof something imports a file
  const addEdge = (f, target) => {
    const j = index.get(target);
    // manifests are buildings but never import targets (`import pkg from './package.json'`)
    // (in a book or docs site a chapter's README is a page like any other, so it can be linked to)
    if (j !== undefined && files[j] !== f && (!NONCODE.has(files[j].lang) || (files[j].lang === 'doc' && proseSuffix.size && target.includes('/')))) f.imp.add(j);
  };

  // python module index: dotted path -> idx, also by the shorter names it is imported by when it sits
  // under a directory that isn't itself a package (src/, a scripts folder): pkg/util/logging.py is
  // pkg.util.logging, never a bare `logging` (that's the standard library)
  const pyPkgDirs = new Set(listed.filter(p => /(^|\/)__init__\.py$/.test(p)).map(p => path.posix.dirname(p)));
  const pyMods = new Map();
  // go: package dir -> files
  const goDirs = new Map();
  for (const [i, f] of files.entries()) {
    if (f.lang === 'py') {
      let m = f.p.replace(/\.py$/, '').replace(/\/__init__$/, '');
      const parts = m.split('/');
      for (let k = 0; k < Math.min(parts.length, 3); k++) {
        if (k && pyPkgDirs.has(parts.slice(0, k).join('/'))) continue;
        const key = parts.slice(k).join('.');
        if (!pyMods.has(key)) pyMods.set(key, i);
      }
    } else if (f.lang === 'go') {
      const d = path.posix.dirname(f.p);
      if (!goDirs.has(d)) goDirs.set(d, []);
      goDirs.get(d).push(i);
    }
  }
  // infrastructure: files per directory, for module sources and chart values
  const infraByDir = new Map();
  for (const f of files) if (INFRA.has(f.lang)) {
    const d = path.posix.dirname(f.p);
    if (!infraByDir.has(d)) infraByDir.set(d, []);
    infraByDir.get(d).push(f.p);
  }
  infraByDir.suffix = new Map(); // "a/b.libsonnet" → path, for jsonnet's library search paths
  for (const ps of infraByDir.values()) for (const p of ps) {
    const segs = p.split('/');
    for (let k = 1; k <= Math.min(3, segs.length); k++) { const key = segs.slice(-k).join('/'); if (!infraByDir.suffix.has(key)) infraByDir.suffix.set(key, p); }
  }
  // java / kotlin: fully qualified class name → file (from the package declaration), package → files
  const jvmClass = new Map(), jvmPkg = new Map();
  for (const [i, f] of files.entries()) if ((f.lang === 'java' || f.lang === 'kt') && f.text) {
    const pkg = (JVM_PKG.exec(f.text) || [])[1] || '';
    const fq = (pkg ? pkg + '.' : '') + stemOf(f.p);
    if (!jvmClass.has(fq)) jvmClass.set(fq, i);
    if (!jvmPkg.has(pkg)) jvmPkg.set(pkg, []);
    jvmPkg.get(pkg).push(i);
  }
  // same-package use: which class names each package's files mention (a class needs no import there)
  const jvmUsed = new Set();
  for (const ids of jvmPkg.values()) {
    if (ids.length < 2) continue;
    const words = ids.map(i => new Set(files[i].text.match(/\b[A-Z][\w$]*/g) || []));
    const seen = new Map(); // capitalised word → how many of the package's files mention it
    for (const ws of words) for (const w of ws) seen.set(w, (seen.get(w) || 0) + 1);
    ids.forEach((i, k) => { const name = stemOf(files[i].p); if ((seen.get(name) || 0) > (words[k].has(name) ? 1 : 0)) jvmUsed.add(i); });
  }
  // godot: res:// is the folder holding project.godot; class_name → the file that declares it
  const godotRoots = listed.filter(p => /(^|\/)project\.godot$/.test(p)).map(p => p.slice(0, p.lastIndexOf('/') + 1)).sort((a, b) => b.length - a.length);
  const gdClass = new Map();
  for (const [i, f] of files.entries()) if (f.lang === 'gd' && f.text) { const m = GD_CLASS.exec(f.text); if (m && !gdClass.has(m[1])) gdClass.set(m[1], i); }
  // prose: "guide/intro.md" → path, for site-absolute links like (/guide/intro)
  const proseSuffix = new Map();
  for (const f of files) if (PROSE.has(f.lang) || f.lang === 'doc') {
    const segs = f.p.replace(/\.(md|mdx|markdown|rst|adoc)$/i, '').split('/');
    for (let k = 1; k <= Math.min(3, segs.length); k++) { const key = segs.slice(-k).join('/'); if (!proseSuffix.has(key)) proseSuffix.set(key, f.p); }
  }
  if (!files.some(f => PROSE.has(f.lang))) proseSuffix.clear();
  const incDirs = [...new Set(files.filter(f => f.lang === 'c' || f.lang === 'cpp').map(f => f.p.match(/^(.*\/)?include\//)?.[0]).filter(Boolean))].map(d => d.replace(/\/$/, '')).sort();
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
          if (name === undefined) {
            const segs = spec.replace(/\.[^./]*$/, '').split('/');
            tails.add(segs[segs.length - 1]); tails.add(segs.slice(-2).join('/'));
            continue;
          }
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
    } else if (f.lang === 'py' || f.lang === 'nb') {
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
      // the module a file *is*: src/a/mod.rs and src/a.rs are both `a`, but a.rs's children live in src/a/
      const own = /(^|\/)(mod|lib|main)\.rs$/.test(f.p) ? dir : f.p.replace(/\.rs$/, '');
      for (const m of text.matchAll(RS_RE)) {
        if (m[1]) {
          const b = (own === '.' ? '' : own + '/') + m[1];
          addEdge(f, b + '.rs'); addEdge(f, b + '/mod.rs');
        } else {
          const segs = m[3].split('::').filter(Boolean);
          // self:: is this module's own directory, super:: its parent's
          let base = m[2] === 'crate' ? crateRoot.replace(/\/$/, '') : own;
          if (m[2] === 'super') base = path.posix.dirname(base);
          for (let k = segs.length; k > 0; k--) {
            const b = [base, ...segs.slice(0, k)].filter(x => x && x !== '.').join('/');
            if (index.has(b + '.rs')) { addEdge(f, b + '.rs'); break; }
            if (index.has(b + '/mod.rs')) { addEdge(f, b + '/mod.rs'); break; }
          }
        }
      }
    } else if (f.lang === 'c' || f.lang === 'cpp') {
      // the include path: the file's own directory, then each directory above it up to the repo root
      // (-Isrc, -I.), then every include/ directory in the repo
      for (const m of text.matchAll(C_RE)) {
        for (let d = dir; ; d = path.posix.dirname(d)) {
          const q = path.posix.normalize(path.posix.join(d, m[1]));
          if (index.has(q)) { addEdge(f, q); break; }
          if (d === '.' || d === '/') { const hit = incDirs.map(inc => path.posix.join(inc, m[1])).find(q => index.has(q)); if (hit) addEdge(f, hit); break; }
        }
      }
    } else if ((f.lang === 'java' || f.lang === 'kt') && jvmClass.size) {
      for (const m of text.matchAll(JVM_IMPORT)) {
        let name = m[1], j;
        if (m[2]) { // wildcard: the package's biggest file stands for it
          const pkg = jvmPkg.get(name);
          if (pkg) j = pkg.reduce((b, k) => files[k].loc > files[b].loc ? k : b, pkg[0]);
        } else {
          // a.b.C, a.b.C.Nested or a static a.b.C.member: walk back to the class that has a file
          while (name.includes('.') && (j = jvmClass.get(name)) === undefined) name = name.slice(0, name.lastIndexOf('.'));
        }
        if (j !== undefined && files[j] !== f) f.imp.add(j);
      }
    } else if (f.lang === 'dart') {
      // relative, or package:<a package in this repo>/x.dart → that package's lib/x.dart
      for (const m of text.matchAll(DART_RE)) {
        const spec = m[1], pkg = /^package:(\w+)\/(.+)$/.exec(spec);
        if (pkg) { const d = ws.dart.get(pkg[1]); if (d !== undefined) addEdge(f, d + 'lib/' + pkg[2]); }
        else if (!spec.includes(':')) addEdge(f, path.posix.normalize(path.posix.join(dir, spec)));
      }
    } else if (f.lang === 'gd') {
      const res = godotRoots.find(r => f.p.startsWith(r)) ?? '';
      for (const m of text.matchAll(GD_PATH)) addEdge(f, m[1].startsWith('res://') ? res + m[1].slice(6) : path.posix.normalize(path.posix.join(dir, m[1])));
      for (const w of new Set(text.match(/\b[A-Z]\w*/g) || [])) { const j = gdClass.get(w); if (j !== undefined && files[j] !== f) f.imp.add(j); }
    } else if (INFRA.has(f.lang)) {
      linkInfra(f, dir, text, index, infraByDir, addEdge);
    } else if (PROSE.has(f.lang) || (f.lang === 'doc' && proseSuffix.size)) {
      linkPages(f, dir, text, index, proseSuffix, addEdge);
    }
    f.text = null;
  }
  return { tails, jvmUsed };
}

// ---------------------------------------------------------------- infrastructure as code
// what kind of infrastructure a file is: it decides the building (container yard, tank farm, warehouse…)
function infraKind(p, text, lang) {
  const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
  if (lang !== 'yaml') return { hcl: 'tf', jsonnet: 'jsonnet', nix: 'nix', tmpl: 'tmpl' }[lang];
  if (base === 'chart.yaml') return 'chart';
  if (/^kustomization\.ya?ml$/.test(base)) return 'kustomize';
  if (/^values[^/]*\.ya?ml$/.test(base)) return 'values';
  if (/(^|\/)templates\//.test(p) && text.includes('{{')) return 'k8s';
  if (/^\s*apiVersion:/m.test(text) && /^\s*kind:\s*\S/m.test(text)) return 'k8s';
  if (/(^|\/)(roles|playbooks?|tasks|handlers|group_vars|host_vars)\//.test(p) || /^\s*-?\s*hosts:\s/m.test(text)) return 'ansible';
  return 'yaml';
}

const TF_SOURCE = /\bsource\s*=\s*"(\.{1,2}\/[^"]*)"/g;
const JSONNET_IMPORT = /\bimport(?:str)?\s+['"]([^'"]+)['"]/g;
const ANSIBLE_REF = /\b(?:include_tasks|import_tasks|include|import_playbook|include_vars|src|template|file):\s*['"]?([\w./-]+\.(?:ya?ml|j2|tpl))/g;

function linkInfra(f, dir, text, index, byDir, addEdge) {
  const join = q => path.posix.normalize(path.posix.join(dir, q)).replace(/\/$/, '');
  // a module / directory reference lands on its main file
  const linkDir = d => {
    const ps = byDir.get(d === '' ? '.' : d);
    if (!ps) return;
    const main = ps.find(p => /\/?(main\.tf|kustomization\.ya?ml|default\.nix)$/.test(p)) || ps[0];
    addEdge(f, main);
  };
  if (f.lang === 'hcl') {
    for (const m of text.matchAll(TF_SOURCE)) linkDir(join(m[1]));
    // variables.tf is what every file in its module reads
    const vars = (dir === '.' ? '' : dir + '/') + 'variables.tf';
    if (/\bvar\.\w/.test(text) && vars !== f.p) addEdge(f, vars);
  } else if (f.lang === 'jsonnet') {
    for (const m of text.matchAll(JSONNET_IMPORT)) {
      const rel = join(m[1]);
      if (index.has(rel)) addEdge(f, rel);
      else { const hit = byDir.suffix.get(m[1].split('/').slice(-3).join('/')); if (hit) addEdge(f, hit); }
    }
  } else if (f.a.k === 'kustomize') {
    let inList = false;
    for (const line of text.split('\n')) {
      if (/^(resources|bases|components|patchesStrategicMerge|patches):/.test(line)) { inList = true; continue; }
      if (/^\S/.test(line)) inList = false;
      const m = inList && /^\s*-\s*(?:path:\s*)?['"]?([\w./-]+)['"]?\s*$/.exec(line);
      if (!m) continue;
      const q = join(m[1]);
      if (index.has(q)) addEdge(f, q); else linkDir(q);
    }
  } else if (/(^|\/)templates\//.test(f.p) && text.includes('.Values')) {
    // a chart's templates all read its values.yaml
    const chart = f.p.slice(0, f.p.lastIndexOf('templates/'));
    addEdge(f, chart + 'values.yaml');
  } else if (f.a.k === 'ansible') {
    for (const m of text.matchAll(ANSIBLE_REF)) {
      const q = m[1];
      for (const c of [join(q), join('../templates/' + q), join('../files/' + q), join('../tasks/' + q), join('../vars/' + q)]) if (index.has(c)) { addEdge(f, c); break; }
    }
    // roles: [a, b] / - role: a → roles/a/tasks/main.yml
    let inRoles = false;
    for (const line of text.split('\n')) {
      if (/^\s*roles:\s*$/.test(line)) { inRoles = true; continue; }
      const m = /^\s*-\s*(?:role:\s*)?([\w.-]+)\s*$/.exec(line) || /\brole:\s*([\w.-]+)/.exec(line);
      if (inRoles && !m && /^\s*\w/.test(line) && !/^\s*-/.test(line)) inRoles = false;
      if (!m || !(inRoles || line.includes('role:'))) continue;
      for (const root of ['roles/', dir === '.' ? 'roles/' : dir + '/roles/']) {
        for (const ext of ['yml', 'yaml']) { const t = `${root}${m[1]}/tasks/main.${ext}`; if (index.has(t)) addEdge(f, t); }
      }
    }
  }
}

// ---------------------------------------------------------------- prose
// what kind of page this is: it decides which campus building it gets
const LOCALE = /^(zh|ja|ko|fr|de|es|pt|ru|it|tr|uk|vi|id|pl|nl|ar|fa|he|hi|th|cs|sv|da|fi|no|nb|hu|ro|bn|ta|ms)([-_][a-zA-Z]{2,4})?$/;
function pageKind(p) {
  const segs = p.toLowerCase().split('/');
  const base = segs[segs.length - 1].replace(/\.[^.]+$/, '');
  // translations: zh/, pt-br/, i18n/, or tldr-style pages.zh/
  const locale = s => LOCALE.test(s) || /^(i18n|translations?|locales?)$/.test(s) || (/^[a-z]+\.[a-z]{2}([_-][a-zA-Z]{2,4})?$/.test(s) && LOCALE.test(s.slice(s.indexOf('.') + 1)));
  if (segs.slice(0, -1).some(locale)) return 'i18n';
  if (/^(index|_index|summary|toc|contents|sidebar)$/.test(base)) return 'index';
  if (segs.some(s => /^(api|reference|references|ref|apis)$/.test(s))) return 'api';
  if (segs.some(s => /^(blog|posts?|news|releases?|changelogs?)$/.test(s))) return 'blog';
  if (segs.some(s => /^(guide|guides|tutorials?|learn|chapters?|lessons?|book|src|getting-started|handbook)$/.test(s)) || /^ch\d|chapter/.test(base)) return 'guide';
  return 'page';
}

const MD_LINK = /\]\(\s*<?([^)\s>#?]+)/g;
function linkPages(f, dir, text, index, suffix, addEdge) {
  for (const m of text.matchAll(MD_LINK)) {
    const href = m[1];
    if (/^[a-z]+:/i.test(href) || /\.(png|jpe?g|gif|svg|webp|pdf|zip)$/i.test(href)) continue;
    const bare = href.replace(/\.(md|mdx|markdown|rst|adoc|html)$/i, '').replace(/\/$/, '');
    const rel = path.posix.normalize(path.posix.join(dir, bare));
    let hit = null;
    if (!href.startsWith('/')) for (const c of [href, rel + '.md', rel + '.mdx', rel + '/index.md', rel + '/README.md', rel + '.rst']) {
      const q = c === href ? path.posix.normalize(path.posix.join(dir, href)) : c;
      if (index.has(q)) { hit = q; break; }
    }
    if (!hit) {
      const segs = bare.split('/').filter(s => s && s !== '.' && s !== '..');
      for (let k = Math.min(3, segs.length); k > 0 && !hit; k--) hit = suffix.get(segs.slice(-k).join('/')) || suffix.get([...segs.slice(-k), 'index'].join('/')) || null;
    }
    if (hit && hit !== f.p) addEdge(f, hit);
  }
}
