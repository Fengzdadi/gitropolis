#!/usr/bin/env node
// Scanner snapshot test: scan a few real repos, each pinned to a commit, and compare what the
// scanner found (and which city it chose) with the snapshot committed in test/snapshots/.
//
//   node test/snapshot.mjs              check every repo
//   node test/snapshot.mjs flask ky     check only these
//   node test/snapshot.mjs --update     rewrite the snapshots (then read the git diff)
//
// Clones are cached in test/.repos (or $GITROPOLIS_TEST_REPOS), so only the first run downloads.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS = path.join(HERE, 'snapshots');
const CACHE = path.resolve(process.env.GITROPOLIS_TEST_REPOS || path.join(HERE, '.repos'));
const REPOS = JSON.parse(readFileSync(path.join(HERE, 'repos.json'), 'utf8'));
const SIZE_WARN = 1 << 20; // a snapshot bigger than this is too big to review: snapshot less of the city

// The same repo must give the same city on any machine, any day. Two things would leak in from
// outside: the clock (how long a repo has been idle decides a ghost town, and a pinned commit only
// gets older) and the locale (1,234 buildings or 1.234). Freeze both before the scanner loads.
const NOW = Date.UTC(2027, 0, 1);
Date.now = () => NOW;
const toLocale = Number.prototype.toLocaleString;
Number.prototype.toLocaleString = function (locales, options) { return toLocale.call(this, locales ?? 'en-US', options); };
const { scanRepo } = await import('../src/scan.mjs');

const args = process.argv.slice(2);
const update = args.includes('--update');
const unknown = args.filter(a => a.startsWith('-') && a !== '--update');
if (unknown.length) { console.error(`unknown option ${unknown[0]} (the only one is --update)`); process.exit(2); }
const only = args.filter(a => !a.startsWith('-'));
const picked = REPOS.filter(r => !only.length || only.some(o => r.repo === o || r.repo.split('/')[1] === o));
if (!picked.length) { console.error(`no repo called ${only.join(', ')} in test/repos.json`); process.exit(2); }

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// a full clone (history is what the scanner reads), checked out at exactly the pinned commit
function checkout({ repo, sha }) {
  const dir = path.join(CACHE, repo);
  if (!existsSync(path.join(dir, '.git'))) {
    console.log(`  cloning ${repo}…`);
    mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['clone', '--quiet', '--no-checkout', `https://github.com/${repo}.git`, dir], { stdio: 'inherit' });
  }
  try { git(dir, 'cat-file', '-e', `${sha}^{commit}`); }
  catch { git(dir, 'fetch', '--quiet', 'origin', sha); }
  git(dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', sha);
  return dir;
}

// What's compared: everything the scanner hands the city, minus timings. File and import references
// are by path, not by index, so one added file shows as one added file and not as every file shifting.
function normalize(city) {
  const { scannedAt, scanMs, files, gone, commits, identity, ...rest } = city;
  const { idleYears, ...metrics } = identity.metrics; // the frozen clock talking, not the scanner
  const paths = files.map(f => f.p);
  const commitList = commits.map(([t, ...idx]) => [t, ...idx.map(i => paths[i])]);
  return {
    ...rest,
    identity: { ...identity, metrics },
    // the timeline is long and every file's born / last / churn already tells its story: keep a fingerprint
    commits: { count: commitList.length, digest: createHash('sha256').update(JSON.stringify(commitList)).digest('hex').slice(0, 16) },
    files: Object.fromEntries(files.map(({ p, imp, ...f }) => [p, { ...f, imp: imp.map(i => paths[i]) }])),
    gone: Object.fromEntries(gone.map(({ p, ...f }) => [p, f])),
  };
}

// pretty JSON, except that a file, a list, and anything else short is one line: a change to a
// file or a ranking is a one-line diff in git
function pretty(v, pad = '', rowsFlat = false) {
  const flat = JSON.stringify(v);
  if (!v || typeof v !== 'object' || Array.isArray(v) || flat.length <= 60) return flat;
  const inner = pad + '  ';
  const rows = Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${rowsFlat ? JSON.stringify(x) : pretty(x, inner, !pad && (k === 'files' || k === 'gone'))}`);
  return `{\n${rows.join(',\n')}\n${pad}}`;
}
const stringify = snap => pretty(snap) + '\n';

// ---- reading a mismatch: what moved, in the order someone changing the scanner cares about

const show = v => {
  const s = typeof v === 'number' ? String(+v.toFixed(4)) : JSON.stringify(v);
  return s === undefined ? '(none)' : s.length > 90 ? s.slice(0, 87) + '…' : s;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function arrayChange(a, b) {
  // a ranking, [[id, score], …]: say which ids moved, by how much
  const pairs = x => x.every(e => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string');
  if (a.length && b.length && pairs(a) && pairs(b)) {
    const ma = new Map(a), mb = new Map(b);
    const moved = [...new Set([...ma.keys(), ...mb.keys()])].filter(k => !same(ma.get(k), mb.get(k))).map(k => `${k} ${show(ma.get(k))} → ${show(mb.get(k))}`);
    const order = x => x.map(e => e[0]).join(' ');
    return [...moved, ...(order(a) !== order(b) && !moved.length ? ['reordered'] : [])].join(', ');
  }
  const ka = a.map(x => JSON.stringify(x)), kb = b.map(x => JSON.stringify(x));
  const added = kb.filter(k => !ka.includes(k)), removed = ka.filter(k => !kb.includes(k));
  if (!added.length && !removed.length) return 'reordered';
  return [...added.map(k => `+${k}`), ...removed.map(k => `−${k}`)].join(' ');
}
const change = (a, b) => Array.isArray(a) && Array.isArray(b) ? arrayChange(a, b) : `${show(a)} → ${show(b)}`;

// every differing leaf as "dotted.path: old → new" (arrays are compared whole)
function leaves(a, b, at, out) {
  if (same(a, b)) return out;
  const obj = x => x && typeof x === 'object' && !Array.isArray(x);
  if (obj(a) && obj(b)) for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) leaves(a[k], b[k], at ? `${at}.${k}` : k, out);
  else out.push([at, change(a, b)]);
  return out;
}

function summarize(want, got) {
  const lines = [];
  const list = (title, items, max = 12) => {
    if (!items.length) return;
    if (title) lines.push(title);
    for (const s of items.slice(0, max)) lines.push(`      ${s}`);
    if (items.length > max) lines.push(`      … and ${items.length - max} more`);
  };
  const wi = want.identity, gi = got.identity;
  if (wi.city !== gi.city) lines.push(`    CITY CHANGED: ${wi.name} → ${gi.name} (score ${wi.score} → ${gi.score}, runner-up ${wi.runnerUp} → ${gi.runnerUp})`);
  else if (wi.score !== gi.score) lines.push(`    still ${gi.name}, score ${wi.score} → ${gi.score}`);
  const states = s => s.map(x => x.id).join(', ') || 'none';
  const statesMoved = !same(wi.states.map(s => s.id), gi.states.map(s => s.id));
  if (statesMoved) lines.push(`    states: ${states(wi.states)} → ${states(gi.states)}`);
  for (const k of ['files', 'loc', 'edges', 'commits']) if (want.stats[k] !== got.stats[k]) lines.push(`    ${k}: ${want.stats[k]} → ${got.stats[k]}`);

  const { files: wf, gone: wg = {}, ...wrest } = want, { files: gf, gone: gg = {}, ...grest } = got;
  // which files came and went from a list of them, and what changed in the ones on both sides
  const fileList = (wf, gf, what) => {
    const s = n => n === 1 ? '' : 's';
    const added = Object.keys(gf).filter(p => !(p in wf)), removed = Object.keys(wf).filter(p => !(p in gf));
    list(`    ${added.length} ${what}file${s(added.length)} added:`, added);
    list(`    ${removed.length} ${what}file${s(removed.length)} removed:`, removed);
    const changed = Object.keys(gf).filter(p => p in wf && !same(wf[p], gf[p]));
    const fields = {};
    for (const p of changed) for (const [k] of leaves(wf[p], gf[p], '', [])) fields[k] = (fields[k] || 0) + 1;
    if (changed.length) lines.push(`    ${changed.length} ${what}file${s(changed.length)} changed (${Object.entries(fields).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ')}):`);
    list('', changed.map(p => `${p}  ${leaves(wf[p], gf[p], '', []).map(([k, c]) => `${k} ${c}`).join('; ')}`));
  };
  fileList(wf, gf, '');
  fileList(wg, gg, 'deleted ');

  const skip = new Set(['identity.city', 'identity.name', 'identity.score', 'identity.runnerUp', statesMoved && 'identity.states']);
  list('    identity:', leaves(wrest.identity, grest.identity, 'identity', []).filter(([p]) => !skip.has(p)).map(([p, c]) => `${p.slice(9)}: ${c}`), 20);
  delete wrest.identity; delete grest.identity;
  list('    other fields:', leaves(wrest, grest, '', []).filter(([p]) => !p.startsWith('stats.')).map(([p, c]) => `${p}: ${c}`));

  return lines;
}

// ----

let failed = 0;
for (const r of picked) {
  const name = r.repo.split('/')[1];
  const file = path.join(SNAPSHOTS, `${name}.json`);
  const label = `${r.repo} @ ${r.ref}`;
  let got;
  try {
    got = normalize(await scanRepo(checkout(r)));
  } catch (e) {
    console.log(`✗ ${label}: could not scan\n    ${String(e.stderr || e.message).trim().split('\n').join('\n    ')}`);
    failed++;
    continue;
  }
  const text = stringify(got);
  const city = `${got.identity.name}, ${got.stats.files} files`;
  if (text.length > SIZE_WARN) console.log(`  warning: ${name}.json is ${(text.length / 1024).toFixed(0)} KB, too big to review`);
  if (update) {
    const old = existsSync(file) && readFileSync(file, 'utf8');
    if (old !== text) { mkdirSync(SNAPSHOTS, { recursive: true }); writeFileSync(file, text); }
    console.log(`${old === text ? '=' : old ? '↻' : '+'} ${label}: ${city}${old === text ? '' : old ? ' (snapshot updated)' : ' (snapshot written)'}`);
    continue;
  }
  if (!existsSync(file)) {
    console.log(`✗ ${label}: no snapshot yet (run npm test -- --update)`);
    failed++;
    continue;
  }
  const want = JSON.parse(readFileSync(file, 'utf8'));
  if (same(want, JSON.parse(text))) { console.log(`✓ ${label}: ${city}`); continue; }
  failed++;
  console.log(`✗ ${label}: the scan no longer matches test/snapshots/${name}.json`);
  for (const l of summarize(want, got)) console.log(l);
}

if (failed && !update) {
  console.log(`\n${failed} of ${picked.length} repos changed. If that's what your change is meant to do,`);
  console.log('run `npm test -- --update` and say in the pull request why each one moved.');
  process.exitCode = 1;
} else if (failed) process.exitCode = 1;
