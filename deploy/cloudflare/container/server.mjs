// The scanner as a service, for the hosted site: GET /scan?repo=owner/name clones the public GitHub
// repo into a temp folder, runs the same scanner the CLI uses, and answers with the city JSON.
// One scan at a time per container (they're memory-hungry); a repo already being scanned is shared.
// Each step has a time limit, and only a few repos may wait their turn: past that it says it's busy
// (503) rather than keep someone waiting behind a queue of big repos.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCANNER } from './version.mjs';

const PORT = 8080;
const CLONE_TIMEOUT = 90_000;
const SCAN_TIMEOUT = 120_000;
const MAX_WAITING = 2;        // repos queued behind the one being scanned
const SCAN = fileURLToPath(new URL('./scan.mjs', import.meta.url));
const NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const valid = r => NAME.test(r) && r.split('/').every(s => s !== '.' && s !== '..');

// Run a command in a process group of its own, so a timeout stops everything it started (a clone's
// index-pack and remote helper, a scan's git log). Resolves with what it printed.
const run = (cmd, args, { timeout, tooLong, ...opts }) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...opts });
  const out = [], err = [];
  p.stdout.on('data', d => out.push(d));
  p.stderr.on('data', d => err.push(d));
  let late = false;
  const timer = setTimeout(() => { late = true; try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, timeout);
  p.on('error', e => { clearTimeout(timer); reject(e); });
  p.on('close', code => {
    clearTimeout(timer);
    if (code === 0) return resolve(Buffer.concat(out).toString());
    reject(new Error(late ? tooLong : Buffer.concat(err).toString().trim().split('\n').pop() || `${cmd} exited ${code}`));
  });
});

async function scan(repo) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scan-'));
  try {
    // only public repos, never a credential prompt, no hooks or LFS downloads
    await run('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-tags', '--single-branch',
      `https://github.com/${repo}.git`, path.join(dir, 'r')], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
      timeout: CLONE_TIMEOUT, tooLong: `cloning took over ${CLONE_TIMEOUT / 1000}s` });
    return await run(process.execPath, [SCAN, path.join(dir, 'r'), repo.split('/')[1]],
      { timeout: SCAN_TIMEOUT, tooLong: `the scan took over ${SCAN_TIMEOUT / 1000}s — run npx gitropolis on your own copy` });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

let queue = Promise.resolve(), waiting = 0;
const inflight = new Map();
// the repo's scan (shared if it's already under way), or null when too many are waiting
const scanOnce = repo => {
  if (!inflight.has(repo)) {
    if (waiting >= MAX_WAITING) return null;
    waiting++;
    const job = queue.then(() => { waiting--; return scan(repo); });
    queue = job.catch(() => {});
    inflight.set(repo, job);
    job.finally(() => inflight.delete(repo)).catch(() => {}); // the caller handles the failure
  }
  return inflight.get(repo);
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return res.writeHead(200).end('ok');
  const repo = url.searchParams.get('repo') || '';
  if (url.pathname !== '/scan' || !valid(repo)) return res.writeHead(400).end('bad request');
  const t0 = Date.now();
  const job = scanOnce(repo);
  if (!job) return res.writeHead(503, { 'content-type': 'text/plain' }).end('busy');
  try {
    const json = await job;
    res.writeHead(200, { 'content-type': 'application/json', 'x-scan-ms': String(Date.now() - t0), 'x-scanner-version': String(SCANNER) });
    res.end(json);
  } catch (err) {
    console.error(`scan ${repo} failed: ${err.message}`);
    res.writeHead(502, { 'content-type': 'text/plain' }).end(err.message);
  }
}).listen(PORT, () => console.log(`scanner listening on ${PORT}`));
