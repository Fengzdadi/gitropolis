// gitropolis.dev: github.com/owner/repo → gitropolis.dev/owner/repo.
//
// Static pages are the CLI's own web/ folder. The one dynamic route, /api/city/owner/repo, finds the
// default branch's head commit on GitHub, serves the city for that commit from R2 if it has been
// scanned before, and otherwise has a container clone and scan it (then keeps the result in R2).
import { Container } from '@cloudflare/containers';

export class Scanner extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const POOL = 3;               // scanners; one repo always goes to the same one, so it's scanned once
const MAX_KB = 600_000;       // GitHub's repo size (pack size, KB): bigger repos are turned away
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// default branch, its head commit and the repo's size, from GitHub (cached for ten minutes)
async function lookup(owner, repo, env, ctx) {
  const key = new Request(`https://gh.cache/${owner}/${repo}`);
  const cached = await caches.default.match(key);
  if (cached) return cached.json();
  const gh = path => fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    headers: { 'user-agent': 'gitropolis', accept: 'application/vnd.github+json', ...(env.GITHUB_TOKEN && { authorization: `Bearer ${env.GITHUB_TOKEN}` }) },
  });
  const r = await gh('');
  if (r.status === 404) return { missing: true };
  if (!r.ok) throw new Error(`GitHub said ${r.status}`);
  const meta = await r.json();
  const c = await gh(`/commits/${encodeURIComponent(meta.default_branch)}`);
  if (!c.ok) throw new Error(`GitHub said ${c.status}`);
  const info = { full: meta.full_name, private: meta.private, size: meta.size, sha: (await c.json()).sha, stars: meta.stargazers_count };
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(info), { headers: { 'cache-control': 'max-age=600' } })));
  return info;
}

const slot = name => { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `scanner-${h % POOL}`; };

async function city(owner, repo, req, env, ctx) {
  if (!NAME.test(owner) || !NAME.test(repo) || [owner, repo].some(s => s === '.' || s === '..')) return json(400, { error: 'not a GitHub repository name' });
  let info;
  try { info = await lookup(owner, repo, env, ctx); } catch (err) { return json(502, { error: err.message }); }
  if (info.missing || info.private) return json(404, { error: `github.com/${owner}/${repo} isn't a public repository` });
  if (info.size > MAX_KB) return json(413, { error: `${info.full} is too big to scan here (${Math.round(info.size / 1000)} MB) — run npx gitropolis on your own copy` });
  const key = `cities/${info.full.toLowerCase()}/${info.sha}.json`;
  const hit = await env.CITIES.get(key);
  const headers = { 'cache-control': 'public, max-age=300', 'x-city-commit': info.sha };
  if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json', 'x-city-cache': 'hit', ...headers } });
  // a new scan costs a container minute: a few per visitor per minute is plenty
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  if (env.SCAN_LIMIT && !(await env.SCAN_LIMIT.limit({ key: ip })).success) return json(429, { error: 'too many new cities at once — try again in a minute' });
  const scanner = env.SCANNER.getByName(slot(info.full.toLowerCase()));
  const res = await scanner.fetch(`http://scanner/scan?repo=${encodeURIComponent(info.full)}`);
  if (!res.ok) return json(502, { error: `couldn't build the city: ${(await res.text()).slice(0, 300)}` });
  const body = await res.text();
  ctx.waitUntil(env.CITIES.put(key, body, { httpMetadata: { contentType: 'application/json' }, customMetadata: { stars: String(info.stars) } }));
  return new Response(body, { headers: { 'content-type': 'application/json', 'x-city-cache': 'miss', ...headers } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const m = /^\/api\/city\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    if (m) return city(decodeURIComponent(m[1]), decodeURIComponent(m[2]), req, env, ctx);
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'no such endpoint' });
    return env.ASSETS.fetch(req); // pages, and /owner/repo falls through to index.html
  },
};
