// The scanner as a service, for the hosted site: GET /scan?repo=owner/name clones the public GitHub
// repo into a temp folder, runs the same scanner the CLI uses, and answers with the city JSON.
// One scan at a time per container (they're memory-hungry); a repo already being scanned is shared.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanRepo } from '../src/scan.mjs';

const PORT = 8080;
const CLONE_TIMEOUT = 90_000;
const NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const valid = r => NAME.test(r) && r.split('/').every(s => s !== '.' && s !== '..');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timed out')); }, opts.timeout || CLONE_TIMEOUT);
  p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `${cmd} exited ${code}`)); });
});

async function scan(repo) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'scan-'));
  try {
    // only public repos, never a credential prompt, no hooks or LFS downloads
    await run('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-tags', '--single-branch',
      `https://github.com/${repo}.git`, path.join(dir, 'r')], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' } });
    const city = await scanRepo(path.join(dir, 'r'));
    city.name = repo.split('/')[1];
    return JSON.stringify(city);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

let queue = Promise.resolve();
const inflight = new Map();
const scanOnce = repo => {
  if (!inflight.has(repo)) {
    const job = queue.then(() => scan(repo));
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
  try {
    const json = await scanOnce(repo);
    res.writeHead(200, { 'content-type': 'application/json', 'x-scan-ms': String(Date.now() - t0) });
    res.end(json);
  } catch (err) {
    console.error(`scan ${repo} failed: ${err.message}`);
    res.writeHead(502, { 'content-type': 'text/plain' }).end(err.message);
  }
}).listen(PORT, () => console.log(`scanner listening on ${PORT}`));
