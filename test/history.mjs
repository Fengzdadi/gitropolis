#!/usr/bin/env node
// History test: small repos built on the spot, one per thing the history pass has to get right that the
// pinned repos don't show (moves git doesn't pair, merges, deletions, a truncated history), checked
// against what the scanner says about each file's birth and about the files deleted along the way.
//
//   node test/history.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepo } from '../src/scan.mjs';

const DAY = 86400;
let clock = 1_600_000_000; // every commit a day after the last, so the history's order is the commits' order
const made = [];

function git(dir, args, { ok = false } = {}) {
  const date = `${clock} +0000`;
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' } });
  } catch (e) { if (ok) return ''; throw e; }
}
function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitropolis-history-'));
  made.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'test']); git(dir, ['config', 'user.email', 'test@example.com']);
  return dir;
}
// files: { path: text, or null to delete it }; returns the commit's time
function commit(dir, files, msg = 'change') {
  clock += DAY;
  for (const [p, text] of Object.entries(files)) {
    if (text === null) { rmSync(path.join(dir, p)); continue; }
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), text);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
  return clock;
}
// merge `branch` into the current one; on a conflict, `resolve` settles each path (true keeps it, false deletes it)
function merge(dir, branch, resolve = {}) {
  clock += DAY;
  git(dir, ['merge', '-q', '--no-ff', '--no-edit', branch], { ok: true });
  for (const [p, keep] of Object.entries(resolve)) git(dir, keep ? ['add', p] : ['rm', '-q', p]);
  git(dir, ['commit', '-q', '--no-edit'], { ok: true }); // (nothing to commit when the merge went through)
  return clock;
}
// a source file with its own lines, so two of them are never alike enough for git to pair
const src = (seed, n = 12) => Array.from({ length: n }, (_, k) => `export const v${k} = '${seed}-${k}';`).join('\n') + '\n';

const cases = [];
const check = (name, fn) => cases.push([name, fn]);
const born = (city, p) => city.files.find(f => f.p === p)?.born;
const gone = (city, p) => city.gone.find(g => g.p === p);

check('a file rewritten in another format keeps its birth (same folder and stem)', async () => {
  const dir = repo();
  const t0 = commit(dir, { 'README.rst': 'Title\n=====\n\nSome words about it.\n', 'lib/foo.js': src('js'), 'main.py': 'print(1)\n' });
  commit(dir, { 'README.rst': null, 'README.md': '# A different title\n\nNothing in common with the old one.\n', 'lib/foo.js': null, 'lib/foo.ts': src('ts') });
  const city = await scanRepo(dir);
  return [[born(city, 'README.md'), t0], [born(city, 'lib/foo.ts'), t0], [gone(city, 'README.rst'), undefined], [gone(city, 'lib/foo.js'), undefined]];
});

check('a file only takes over the history of one in the same language', async () => {
  const dir = repo();
  commit(dir, { 'analysis/results.py': src('py').replace(/export const/g, 'x ='), 'other.js': src('o') });
  const t1 = commit(dir, { 'analysis/results.py': null, 'analysis/results.csv': 'a,b\n1,2\n' });
  const city = await scanRepo(dir);
  return [[gone(city, 'analysis/results.py')?.died, t1]];
});

check('a file of the same name in another folder is another file, where git compared them', async () => {
  const dir = repo();
  commit(dir, { 'app/one/register.js': src('one'), 'keep.js': src('k') });
  const t1 = commit(dir, { 'app/one/register.js': null, 'app/two/register.js': src('two') });
  const city = await scanRepo(dir);
  return [[born(city, 'app/two/register.js'), t1], [gone(city, 'app/one/register.js')?.died, t1]];
});

check('in a commit too big for git to look for renames, files whose paths end the same are one file', async () => {
  const dir = repo();
  const N = 1001; // git's rename limit is 1000: 1001 × 1001 candidates and it doesn't compare them
  const old = {}, moved = {};
  for (let k = 0; k < N; k++) { old[`test/samples/s${k}/_config.js`] = src(`old${k}`, 3); }
  const t0 = commit(dir, old);
  for (let k = 0; k < N; k++) { moved[`test/samples/s${k}/_config.js`] = null; moved[`tests/samples/s${k}/_config.js`] = src(`new${k}`, 3); }
  commit(dir, moved);
  const city = await scanRepo(dir);
  return [[born(city, 'tests/samples/s7/_config.js'), t0], [born(city, `tests/samples/s${N - 1}/_config.js`), t0], [city.gone.length, 0]];
});

check('a file deleted and added back is the same file, not a deleted one', async () => {
  const dir = repo();
  const t0 = commit(dir, { 'a.js': src('a'), 'b.js': src('b') });
  commit(dir, { 'a.js': null });
  commit(dir, { 'a.js': src('a2') });
  const city = await scanRepo(dir);
  return [[born(city, 'a.js'), t0], [gone(city, 'a.js'), undefined]];
});

check('a file a merge kept, though a branch deleted it, keeps its history', async () => {
  const dir = repo();
  commit(dir, { 'base.js': src('base') });
  const t1 = commit(dir, { 'f.js': src('f') });
  git(dir, ['checkout', '-q', '-b', 'x']);
  git(dir, ['checkout', '-q', 'main']);
  commit(dir, { 'f.js': src('f2') });            // main edits f.js …
  git(dir, ['checkout', '-q', 'x']);
  commit(dir, { 'f.js': null });                 // … later, branch x deletes it …
  git(dir, ['checkout', '-q', 'main']);
  merge(dir, 'x', { 'f.js': true });             // … and the merge keeps it
  const city = await scanRepo(dir);
  return [[born(city, 'f.js'), t1], [gone(city, 'f.js'), undefined]];
});

check('a file deleted on one branch and edited later on another stays deleted', async () => {
  const dir = repo();
  commit(dir, { 'base.js': src('base'), 'g.js': src('g') });
  git(dir, ['checkout', '-q', '-b', 'y']);
  git(dir, ['checkout', '-q', 'main']);
  const t2 = commit(dir, { 'g.js': null });      // main deletes g.js …
  git(dir, ['checkout', '-q', 'y']);
  commit(dir, { 'g.js': src('g2') });            // … branch y edits it after …
  git(dir, ['checkout', '-q', 'main']);
  merge(dir, 'y', { 'g.js': false });            // … and the merge keeps it deleted
  const city = await scanRepo(dir);
  return [[gone(city, 'g.js')?.died, t2], [born(city, 'g.js'), undefined]];
});

check('in a history read only in part, an edited file is no new file to pair with a deleted one', async () => {
  const dir = repo();
  const t0 = commit(dir, { 'a/foo.js': src('js'), 'a/foo.ts': src('ts') });
  const t1 = commit(dir, { 'a/foo.js': null, 'a/foo.ts': src('ts2') });
  const city = await scanRepo(dir, { maxCommits: 1 }); // only the last commit: both files were there before it
  const g = gone(city, 'a/foo.js');
  return [[g?.died, t1], [g?.last, t1], [g?.born, t0], [born(city, 'a/foo.ts'), t0]];
});

check('in a history read only in part, the files there before it keep their births', async () => {
  const dir = repo();
  const t0 = commit(dir, { 'a.js': src('a') });
  const t1 = commit(dir, { 'b.js': src('b') });
  commit(dir, { 'c.js': src('c') });
  const t3 = commit(dir, { 'b.js': src('b2') });
  const city = await scanRepo(dir, { maxCommits: 1 });
  return [[born(city, 'a.js'), t0], [born(city, 'b.js'), t1], [city.files.find(f => f.p === 'a.js')?.last, t3]];
});

check('in a history read only in part, a file moved before it keeps the birth of its old path', async () => {
  const dir = repo();
  const t0 = commit(dir, { 'old/x.js': src('x'), 'keep.js': src('k') });
  commit(dir, { 'old/x.js': null, 'new/x.js': src('x') });
  commit(dir, { 'keep.js': src('k2') });
  const city = await scanRepo(dir, { maxCommits: 1 });
  return [[born(city, 'new/x.js'), t0]];
});

check('in a history read only in part, a file rewritten in another language before it keeps its birth', async () => {
  const dir = repo();
  const t0 = commit(dir, { 'lib/util.js': src('j'), 'keep.js': src('k') });
  commit(dir, { 'lib/util.js': null, 'lib/util.ts': src('t', 30) }); // nothing alike: only the name says it's the same file
  commit(dir, { 'keep.js': src('k2') });
  const city = await scanRepo(dir, { maxCommits: 1 });
  return [[born(city, 'lib/util.ts'), t0]];
});

check('in a history read only in part, a new package\'s config is no older than the package', async () => {
  const dir = repo();
  const config = '{\n  "compilerOptions": { "strict": true }\n}\n';
  commit(dir, { 'types/a/tsconfig.json': config, 'types/a/index.ts': src('a') });
  const t1 = commit(dir, { 'types/a/tsconfig.json': null, 'types/a/index.ts': null, 'types/b/tsconfig.json': config, 'types/b/index.ts': src('b') });
  commit(dir, { 'types/b/index.ts': src('b2') });
  const city = await scanRepo(dir, { maxCommits: 1 });
  return [[born(city, 'types/b/tsconfig.json'), t1], [born(city, 'types/b/index.ts'), t1]];
});

check('a history exactly as long as the commits read has nothing before it', async () => {
  const dir = repo();
  const t0 = commit(dir, { 'a.js': src('a') });
  commit(dir, { 'b.js': src('b') });
  const city = await scanRepo(dir, { maxCommits: 2 });
  return [[born(city, 'a.js'), t0]];
});

check('in a history read only in part, commit rates are measured over the commits read', async () => {
  const dir = repo();
  commit(dir, { 'a.js': src('a'), 'README.md': '# a\n' });
  clock += 365 * DAY;
  commit(dir, { 'a.js': src('a2') });
  clock += 13 * DAY;
  commit(dir, { 'a.js': src('a3') });
  const city = await scanRepo(dir, { maxCommits: 2 }); // two commits, two weeks apart
  return [[city.identity.metrics.commitsPerWeek, 1]];
});

check('a partial clone is scanned without fetching what it doesn\'t have', async () => {
  const dir = repo();
  git(dir, ['config', 'uploadpack.allowFilter', 'true']);
  const t0 = commit(dir, { 'old/x.js': src('x'), 'keep.js': src('k') });
  commit(dir, { 'old/x.js': null, 'new/x.js': src('x') + 'export const more = 1;\n' }); // git would read both to pair them
  commit(dir, { 'keep.js': src('k2') });
  const copy = mkdtempSync(path.join(os.tmpdir(), 'gitropolis-history-'));
  made.push(copy);
  git(copy, ['clone', '-q', '--no-local', '--filter=blob:none', `file://${dir}`, '.']);
  const missing = () => git(copy, ['rev-list', '--objects', '--all', '--missing=print']).split('\n').filter(l => l.startsWith('?')).length;
  const before = missing();
  const city = await scanRepo(copy, { maxCommits: 1 });
  return [[before > 0, true], [missing(), before], [born(city, 'new/x.js'), t0]];
});

check('a deleted file drawn from its size alone is drawn without reading it', async () => {
  const dir = repo();
  const lock = JSON.stringify({ packages: Array.from({ length: 30000 }, (_, k) => ({ name: `p${k}`, version: '1.0.0' })) });
  commit(dir, { 'index.js': src('i'), 'package-lock.json': lock });
  commit(dir, { 'package-lock.json': null });
  const city = await scanRepo(dir);
  return [[lock.length > 1_000_000, true], [gone(city, 'package-lock.json')?.loc, Math.round(lock.length / 40)]];
});

let failed = 0;
try {
  for (const [name, fn] of cases) {
    const wrong = (await fn()).filter(([got, want]) => got !== want);
    if (!wrong.length) continue;
    failed++;
    console.log(`✗ ${name}`);
    for (const [got, want] of wrong) console.log(`    got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
} finally {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.log(`history: ${failed} of ${cases.length} cases failed`); process.exitCode = 1; }
else console.log(`history: all ${cases.length} cases pass`);
