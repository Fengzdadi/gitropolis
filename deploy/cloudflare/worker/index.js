// gitropolis.dev: github.com/owner/repo → gitropolis.dev/owner/repo.
//
// Link previews: /owner/repo pages carry og/twitter tags pointing at /api/card/owner/repo.png, a share
// card drawn by the page itself in a headless browser (?card=og) and kept in R2 per commit.
//
// Static pages are the CLI's own web/ folder. The one dynamic route, /api/city/owner/repo, finds the
// default branch's head commit on GitHub, serves the city for that commit from R2 if it has been
// scanned before, and otherwise has a container clone and scan it (then keeps the result in R2).
import { Container } from '@cloudflare/containers';
import puppeteer from '@cloudflare/puppeteer';
import { badgeSVG } from './badge.js';

export class Scanner extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const POOL = 3;               // scanners; one repo always goes to the same one, so it's scanned once
const MAX_KB = 600_000;       // GitHub's repo size (pack size, KB): bigger repos are turned away
const SCANNER = 2;            // bump when the scanner changes what it finds: cities are cached per version
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
  const key = `cities/v${SCANNER}/${info.full.toLowerCase()}/${info.sha}.json`;
  const hit = await env.CITIES.get(key);
  const headers = { 'cache-control': 'public, max-age=300', 'x-city-commit': info.sha };
  if (hit) {
    if (!new URL(req.url).searchParams.has('for')) ctx.waitUntil(prepareCard(info, req.url, env)); // not when it's the card being drawn
    return new Response(hit.body, { headers: { 'content-type': 'application/json', 'x-city-cache': 'hit', ...headers } });
  }
  // a new scan costs a container minute: a few per visitor per minute is plenty
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  if (env.SCAN_LIMIT && !(await env.SCAN_LIMIT.limit({ key: ip })).success) return json(429, { error: 'too many new cities at once — try again in a minute' });
  const scanner = env.SCANNER.getByName(slot(info.full.toLowerCase()));
  const res = await scanner.fetch(`http://scanner/scan?repo=${encodeURIComponent(info.full)}`);
  if (!res.ok) return json(502, { error: `couldn't build the city: ${(await res.text()).slice(0, 300)}` });
  const body = await res.text();
  // keep the city, then its summary and its share card (which reads the city back through the API)
  ctx.waitUntil((async () => {
    await env.CITIES.put(key, body, { httpMetadata: { contentType: 'application/json' }, customMetadata: { stars: String(info.stars) } });
    await saveSummary(env, info, body);
    await prepareCard(info, req.url, env);
  })());
  return new Response(body, { headers: { 'content-type': 'application/json', 'x-city-cache': 'miss', ...headers } });
}

const CARD = 1;               // bump when the card's look changes
const esc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cardKey = info => `cards/v${SCANNER}.${CARD}/${info.full.toLowerCase()}/${info.sha}.png`;

// Draw a repo's share card: the page itself, in a headless browser, in its ?card=og mode. Kept in R2.
async function renderCard(info, origin, env) {
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.goto(new URL(`/${info.full}?card=og`, origin).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction('window.__card', { timeout: 60_000 });
    const url = await page.evaluate(() => window.__card);
    if (!url.startsWith('data:image/png;base64,')) throw new Error(url);
    const png = Uint8Array.from(atob(url.slice(22)), c => c.charCodeAt(0));
    await env.CITIES.put(cardKey(info), png, { httpMetadata: { contentType: 'image/png' } });
    return png;
  } finally {
    await browser?.close().catch(() => {});
  }
}

// Link-preview crawlers don't wait long, and one that times out remembers "no picture" for days. So a
// card is drawn ahead of time: as soon as a city is built, or when a city built before cards existed
// is next opened (once at a time per repo and commit).
async function prepareCard(info, origin, env) {
  if (!env.BROWSER || await env.CITIES.head(cardKey(info))) return;
  const busy = new Request(`https://card.busy/${info.full.toLowerCase()}/${info.sha}`);
  if (await caches.default.match(busy)) return;
  await caches.default.put(busy, new Response('1', { headers: { 'cache-control': 'max-age=90' } }));
  try { await renderCard(info, origin, env); } catch (err) { console.log('card failed', info.full, String(err)); }
}

// /api/card/owner/repo.png: the share card for a repo's current commit. Only cities that have been
// built get one (a link preview mustn't set off a scan); anything else gets the site's own picture.
async function card(owner, repo, req, env, ctx) {
  const fallback = () => Response.redirect(new URL('/og.png', req.url).toString(), 302);
  if (!NAME.test(owner) || !NAME.test(repo)) return fallback();
  let info;
  try { info = await lookup(owner, repo, env, ctx); } catch { return fallback(); }
  if (info.missing || info.private) return fallback();
  const headers = { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' };
  const hit = await env.CITIES.get(cardKey(info));
  if (hit) return new Response(hit.body, { headers });
  if (!env.BROWSER || !(await env.CITIES.head(`cities/v${SCANNER}/${info.full.toLowerCase()}/${info.sha}.json`))) return fallback();
  try { return new Response(await renderCard(info, req.url, env), { headers }); }
  catch (err) { console.log('card failed', info.full, String(err)); return fallback(); }
}

// what a badge needs to know about a built city, kept beside it (a city file can run to megabytes)
const summaryKey = info => `meta/v${SCANNER}/${info.full.toLowerCase()}/${info.sha}.json`;
async function saveSummary(env, info, body) {
  const city = JSON.parse(body);
  const summary = { kind: city.identity?.city || 'smalltown', buildings: city.files?.length || 0 };
  await env.CITIES.put(summaryKey(info), JSON.stringify(summary), { httpMetadata: { contentType: 'application/json' } });
  return summary;
}
async function summary(env, info) {
  const hit = await env.CITIES.get(summaryKey(info));
  if (hit) return hit.json();
  const city = await env.CITIES.get(`cities/v${SCANNER}/${info.full.toLowerCase()}/${info.sha}.json`);
  return city ? saveSummary(env, info, await city.text()) : null; // cities built before summaries existed
}

// /owner/repo/badge.svg[?style=pixel|card]: for READMEs. Never sets off a scan: a repo that hasn't
// been built says "see the city" instead of what it's built like.
async function badge(owner, repo, url, env, ctx) {
  const style = url.searchParams.get('style');
  let city = null;
  if (NAME.test(owner) && NAME.test(repo)) {
    try {
      const info = await lookup(owner, repo, env, ctx);
      if (!info.missing && !info.private) city = await summary(env, info);
    } catch { /* GitHub or R2 hiccup: the plain badge */ }
  }
  // GitHub's image proxy keeps it for a while; an hour keeps badges current after new commits
  return new Response(badgeSVG(style, city), { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': `public, max-age=${city ? 3600 : 600}` } });
}

// /owner/repo: the page, with link-preview tags for this repo
async function page(owner, repo, req, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', req.url), req));
  const name = `${owner}/${repo}`, url = new URL(`/${name}`, req.url).toString();
  const image = new URL(`/api/card/${name}.png`, req.url).toString();
  const desc = `github.com/${name} as a pixel-art city, built from its code and git history.`;
  const tags = [
    ['property', 'og:type', 'website'], ['property', 'og:site_name', 'gitropolis'], ['property', 'og:url', url],
    ['property', 'og:title', `${name} · gitropolis`], ['property', 'og:description', desc],
    ['property', 'og:image', image], ['property', 'og:image:width', '2400'], ['property', 'og:image:height', '1260'],
    ['name', 'twitter:card', 'summary_large_image'], ['name', 'twitter:title', `${name} · gitropolis`],
    ['name', 'twitter:description', desc], ['name', 'twitter:image', image], ['name', 'description', desc],
  ].map(([attr, k, v]) => `<meta ${attr}="${k}" content="${esc(v)}">`).join('');
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(`${name} · gitropolis`); } })
    .on('meta[property^="og:"], meta[name^="twitter:"], meta[name="description"]', { element(e) { e.remove(); } }) // the front page's
    .on('head', { element(e) { e.append(tags, { html: true }); } })
    .transform(res);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const m = /^\/api\/city\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    if (m) return city(decodeURIComponent(m[1]), decodeURIComponent(m[2]), req, env, ctx);
    const c = /^\/api\/card\/([^/]+)\/([^/]+?)\.png$/.exec(url.pathname);
    if (c) return card(decodeURIComponent(c[1]), decodeURIComponent(c[2]), req, env, ctx);
    const b = /^\/([^/]+)\/([^/]+)\/badge\.svg$/.exec(url.pathname);
    if (b) return badge(decodeURIComponent(b[1]), decodeURIComponent(b[2]), url, env, ctx);
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'no such endpoint' });
    // a repo page (two path segments that aren't one of the site's own files)
    const r = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (r && req.method === 'GET' && r[1] !== 'vendor' && !/\.(js|css|json|png|gif|html|md|svg|txt)$/.test(r[2])) return page(r[1], r[2], req, env);
    return env.ASSETS.fetch(req); // pages, and /owner/repo falls through to index.html
  },
};
