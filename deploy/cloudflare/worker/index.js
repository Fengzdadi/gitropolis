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
// the container gives up on its own (a slow clone or scan, too many waiting); this is for one that never answers
const SCAN_WAIT = 12 * 60_000;
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
  let res;
  try {
    res = await Promise.race([
      scanner.fetch(`http://scanner/scan?repo=${encodeURIComponent(info.full)}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the scanner took too long to answer')), SCAN_WAIT)),
    ]);
  } catch (err) { return json(502, { error: `couldn't build the city: ${err.message}` }); }
  if (res.status === 503) return json(503, { error: 'every city builder is busy — try again in a few minutes' }, { 'retry-after': '120' });
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

const CARD = 2;               // bump when the card's look (or its encoding) changes
const esc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cardKey = (info, v = CARD) => `cards/v${SCANNER}.${v}/${info.full.toLowerCase()}/${info.sha}.png`;
const cityKey = info => `cities/v${SCANNER}/${info.full.toLowerCase()}/${info.sha}.json`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// One drawing per repo and commit at a time: a link posted in a chat brings several preview crawlers
// at once, and each would otherwise start a headless browser of its own. The card, BUSY when it's
// already being drawn, or null when it couldn't be. (The mark is in this data centre's cache, so
// crawlers arriving through different data centres can still each draw one.)
const BUSY = Symbol('busy');
async function drawOnce(info, origin, env) {
  const busy = new Request(`https://card.busy/${info.full.toLowerCase()}/${info.sha}`);
  if (await caches.default.match(busy)) return BUSY;
  await caches.default.put(busy, new Response('1', { headers: { 'cache-control': 'max-age=90' } }));
  try { return await renderCard(info, origin, env); } catch (err) { console.log('card failed', info.full, String(err)); return null; }
}

// Link-preview crawlers don't wait long, and one that times out remembers "no picture" for days. So a
// card is drawn ahead of time: as soon as a city is built, or when a city built before cards existed
// is next opened.
async function prepareCard(info, origin, env) {
  if (env.BROWSER && !(await env.CITIES.head(cardKey(info)))) await drawOnce(info, origin, env);
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
  if (!env.BROWSER || !(await env.CITIES.head(cityKey(info)))) return fallback();
  // a card drawn before its look last changed stands in, briefly, while the new one is drawn
  const old = await env.CITIES.get(cardKey(info, CARD - 1));
  if (old) {
    ctx.waitUntil(prepareCard(info, req.url, env));
    return new Response(old.body, { headers: { ...headers, 'cache-control': 'public, max-age=600' } });
  }
  let png = await drawOnce(info, req.url, env);
  // someone else is drawing it: wait for it to land rather than draw it again
  for (let i = 0; png === BUSY && i < 12; i++) {
    await sleep(2000);
    const done = await env.CITIES.get(cardKey(info));
    if (done) png = await done.arrayBuffer();
  }
  return png && png !== BUSY ? new Response(png, { headers }) : fallback();
}

// what a badge needs to know about a built city, kept beside it (a city file can run to megabytes),
// and again as the repo's latest, which a badge can read without asking GitHub for the head commit
const summaryKey = info => `meta/v${SCANNER}/${info.full.toLowerCase()}/${info.sha}.json`;
const latestKey = full => `meta/v${SCANNER}/${full.toLowerCase()}/latest.json`;
const putJSON = (env, key, value) => env.CITIES.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
async function saveSummary(env, info, body) {
  const city = JSON.parse(body);
  const summary = { kind: city.identity?.city || 'smalltown', buildings: city.files?.length || 0 };
  await Promise.all([putJSON(env, summaryKey(info), summary), putJSON(env, latestKey(info.full), summary)]);
  return summary;
}
async function summary(env, info) {
  const hit = await env.CITIES.get(summaryKey(info));
  if (hit) return hit.json();
  const city = await env.CITIES.get(cityKey(info));
  return city ? saveSummary(env, info, await city.text()) : null; // cities built before summaries existed
}

// /owner/repo/badge.svg[?style=pixel|card]: for READMEs. Never sets off a scan: a repo that hasn't
// been built says "see the city" instead of what it's built like. Badges are fetched far more often
// than cities are opened, so they show the last city built (a repo's type rarely changes between
// commits) and only ask GitHub when there's none on record yet.
async function badge(owner, repo, url, env, ctx) {
  const style = url.searchParams.get('style');
  let city = null;
  if (NAME.test(owner) && NAME.test(repo)) {
    try {
      const latest = await env.CITIES.get(latestKey(`${owner}/${repo}`));
      if (latest) city = await latest.json();
      else {
        const info = await lookup(owner, repo, env, ctx);
        if (!info.missing && !info.private) city = await summary(env, info);
        if (city) ctx.waitUntil(putJSON(env, latestKey(info.full), city)); // built before latest existed
      }
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
