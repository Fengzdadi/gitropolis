#!/usr/bin/env node
// gitropolis [repo] [--port 4173] [--out city.json] [--no-open]
//           [--style pixel|maquette|plan|nocturne|neon] [--city auto|<archetype>] [--pixel 1] [--zoom 1]
//           [--still frame.png] [--shot hero|aerial|street|plan] [--no-hud] [--card card.png] [--shape landscape|square|story] [--full]
//           [--video city.mp4] [--gif city.gif] [--static] [--duration 20] [--fps 30] [--size 1920x1080] [--max-mb 9.5] [--headed]
//           [--bench] [--help] [--version]
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, stat } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { exec, spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo } from '../src/scan.mjs';

const args = process.argv.slice(2);
// anything after a lone -- is the repo, never an option (a folder's name can start with a dash)
const afterDashes = args.includes('--') ? args.splice(args.indexOf('--')).slice(1) : [];
const PKG =JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (args.includes('--version') || args.includes('-v')) { console.log(PKG.version); process.exit(0); }
if (args.includes('--help') || args.includes('-h')) {
  console.log(`gitropolis ${PKG.version} — your git repo as a pixel-art city

  gitropolis [repo]                     open the city in your browser (repo defaults to .)

  --style pixel|maquette|plan|nocturne  look (default pixel)
  --city auto|farm|desert|capital|mountain|university|port|industrial|science|themepark|resort|smalltown|manhattan|hongkong|tokyo|la|paris|venice|barcelona
                                        city plan (default: picked from the code)
  --pixel <n>  --zoom <n>               art-pixel size (default 1, 2 for chunkier art), close-up factor
  --still <file.png> [--shot hero|aerial|street|plan] [--no-hud]
  --card <file.png> [--shape landscape|square|story] [--full]   a share card (pixel style)
  --video <file.mp4>  --gif <file.gif>  film the city growing (needs ffmpeg and Chrome)
  --static  --duration <s>  --fps <n>  --size <WxH>  --max-mb <n>  --headed
  --port <n>  --no-open  --out <city.json>  --bench`);
  process.exit(0);
}
// a mistyped option should say so, not turn into a folder name or a silently ignored setting
const fail = msg => { console.error(`gitropolis: ${msg}`); process.exit(1); };
const flag = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) fail(`${name} needs a value (see --help)`);
  args.splice(i, 2);
  return v;
};
const bool = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const oneOf = (name, v, ok) => ok.includes(v) ? v : fail(`${name} is one of ${ok.join(', ')} (not ${v})`);
const num = (name, v) => v === undefined || +v > 0 ? v : fail(`${name} takes a number above 0 (not ${v})`);
const portGiven = args.includes('--port') || !!process.env.PORT;
let port = +num('--port', flag('--port', process.env.PORT || 4173));
const out = flag('--out');
const video = flag('--video');
const gif = flag('--gif');
const duration = +num('--duration', flag('--duration', 20));
const fps = +num('--fps', flag('--fps', 30));
const frame = flag('--size', '1920x1080');
if (!/^[1-9]\d*x[1-9]\d*$/.test(frame)) fail(`--size is width x height, like 1920x1080 (not ${frame})`);
const [w, h] = frame.split('x').map(Number);
const maxMB = +num('--max-mb', flag('--max-mb', 9.5)); // GitHub README uploads cap at 10 MB
const headed = bool('--headed');
// (neon and chip aren't in --help: neon is the first prototype, chip the easter egg a plain visit rolls now and then)
const styleAsked = args.includes('--style'); // if not, the live view leaves the page to pick (and maybe roll chip)
const style = oneOf('--style', flag('--style', 'pixel'), ['pixel', 'maquette', 'plan', 'nocturne', 'neon', 'chip']);
const pxOpt = num('--pixel', flag('--pixel')); // pixel style: size of one art pixel (default 1; 2 for chunkier art)
const zoomOpt = num('--zoom', flag('--zoom')); // close-up factor (pixel style)
const cityOpt = oneOf('--city', flag('--city', 'auto'), ['auto', 'classic', 'farm', 'desert', 'capital', 'mountain', 'university', 'port', 'industrial', 'science', 'themepark', 'resort',
  'smalltown', 'manhattan', 'hongkong', 'tokyo', 'la', 'paris', 'venice', 'barcelona']);
const card = flag('--card'); // a share card instead of a photo
const cardShape = flag('--shape', 'landscape');
const cardFull = bool('--full');
const still = flag('--still') || card;
if (card && !['landscape', 'square', 'story', 'brand', 'social'].includes(cardShape)) { console.error(`gitropolis: --shape is landscape, square or story`); process.exit(1); }
const shot = oneOf('--shot', flag('--shot', 'hero'), ['hero', 'aerial', 'street', 'plan']);
const noHud = bool('--no-hud');
const fixedCam = bool('--static'); // films: hold the establishing shot instead of pushing in
const benchMode = bool('--bench'); // measure setup and frame cost in headless Chrome
const noOpen = bool('--no-open');
// what's left is the repo: a word starting with a dash is a mistyped option, unless it's a folder that's there
const unknown = args.find(a => a.startsWith('-') && !existsSync(a));
if (unknown) fail(`unknown option ${unknown} (see --help)`);
args.push(...afterDashes);
if (args.length > 1) fail(`one repo at a time (got ${args.join(', ')})`);
const repo = args[0] || process.cwd();
if (!existsSync(repo)) { console.error(`gitropolis: no such folder ${repo}`); process.exit(1); }
try { execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); } catch {
  console.error(`gitropolis: ${path.resolve(repo)} isn't a git repository (or git isn't installed)`);
  process.exit(1);
}
const recording = !!(video || gif || still || benchMode);

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const pink = s => `\x1b[35m${s}\x1b[0m`, cyan = s => `\x1b[36m${s}\x1b[0m`;

if (video || gif) {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch {
    console.error('gitropolis: --video/--gif needs ffmpeg on your PATH (macOS: brew install ffmpeg)');
    process.exit(1);
  }
}

process.stdout.write(`${pink('▲ gitropolis')} scanning ${path.resolve(repo)} … `);
const city = await scanRepo(repo);
const json = JSON.stringify(city);
const s = city.stats;
console.log(`done in ${city.scanMs}ms\n  ${s.files} buildings · ${s.loc.toLocaleString()} LOC · ${s.edges} roads · ${s.commits} commits`);
const id = city.identity;
console.log(`\n  this repo is ${pink(id.name)}${id.reasons.length ? ' — ' + id.reasons.join('; ') : ''}`);
for (const st of id.states) console.log(`  + ${st.reason}`);
console.log('');

// nothing to draw (only images, binaries, vendored code…): say so instead of opening an empty page
if (!city.files.length && !out) {
  console.error('  gitropolis: no source files here that gitropolis knows how to draw');
  process.exit(1);
}

if (out) {
  await writeFile(out, json);
  console.log(`  wrote ${out}`);
  process.exit(0);
}

// ---------------------------------------------------------------- recording pipeline
let rec = null;
if (recording) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'gitropolis-'));
  // frames land in a near-lossless master first; the size-capped outputs are encoded from it
  const mp4 = path.join(tmp, 'master.mp4');
  const ff = still || benchMode ? null : spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', mp4],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = ff && new Promise(r => ff.on('close', r));
  // ffmpeg dying mid-film (bad build, disk full) ends the recording with a message, not an EPIPE crash
  ff?.stdin.on('error', () => {});
  ff?.on('close', code => { if (code && !quitting) { console.error(`\n  gitropolis: ffmpeg stopped (exit ${code})`); quit(1); } });
  rec = { tmp, mp4, ff, ffDone, total: still ? 1 : Math.round(fps * duration), got: 0, browser: null, t0: Date.now() };
}

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

// The server is for this machine's browser only: it listens on loopback, answers only requests
// addressed to localhost (a DNS-rebinding page can't read the city), and takes POSTs only from its
// own page (another site can't end a recording or write the --still file).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const server = createServer((req, res) => handle(req, res).catch(err => {
  console.error(`\n  gitropolis: ${err.message}`);
  if (!res.headersSent) res.writeHead(500);
  res.end();
}));

async function handle(req, res) {
  if (!LOCAL_HOST.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://x').pathname;
  if (url === '/city.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(json);
  }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (!rec || (origin && !LOCAL_HOST.test(origin.replace(/^https?:\/\//, '')))) { res.writeHead(403); return res.end(); }
    const body = await readBody(req);
    if (url === '/meta') {
      try { rec.meta = JSON.parse(body); } catch {}
      return res.writeHead(204).end();
    }
    if (url === '/fail') {
      console.error(`\n  gitropolis: the page failed to build the city:\n    ${String(body).split('\n').slice(0, 6).join('\n    ')}`);
      res.writeHead(204).end();
      return quit(1);
    }
    if (url === '/bench') {
      let r;
      try { r = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      console.log(`\n  bench — ${r.files} files, ${r.style}/${r.city}, ${r.size}`);
      for (const [k, v] of Object.entries(r.setupMs)) console.log(`    setup  ${k.padEnd(28)} ${String(v).padStart(6)} ms`);
      console.log(`    frame  avg ${r.frameMs.avg} ms  p95 ${r.frameMs.p95} ms   (cpu tick avg ${r.cpuTickMs.avg} ms)`);
      console.log(`    ${r.triangles.toLocaleString()} triangles, ${r.drawCalls} draw calls, ${r.vehicles} vehicles`);
      console.log(`    city mesh ${r.cityMeshMB} MB of vertex data, JS heap ${r.jsHeapMB} MB`);
      console.log(`    heap at load ${r.heapAtLoadMB} MB; retained per step: ${Object.entries(r.heapGrowthMB).map(([k, v]) => `${k} ${v}`).join(', ')}`);
      res.writeHead(204).end();
      return quit(0);
    }
    if (url === '/frame' && still) {
      await writeFile(path.resolve(still), body);
    } else if (url === '/frame') {
      if (!rec.ff.stdin.write(body)) await new Promise(r => rec.ff.stdin.once('drain', r));
      rec.got++;
      const pct = rec.got / rec.total;
      const bar = '█'.repeat(Math.round(pct * 30)).padEnd(30, '░');
      process.stdout.write(`\r  ${pink('● REC')} ${bar} ${rec.got}/${rec.total} frames`);
    } else if (url === '/log') {
      console.error(`\n  browser error: ${body}`);
    } else if (url === '/done') {
      res.writeHead(204).end();
      return finishRecording();
    }
    return res.writeHead(204).end();
  }
  const file = path.join(WEB, path.normalize(url === '/' ? '/index.html' : url));
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

// One way out, whatever happened: stop headless Chrome and wait until it has let go of its profile,
// stop ffmpeg, remove the temp folder, then exit. (Killing Chrome and deleting straight away leaves
// the profile behind: Chrome writes it back on the way down.)
let quitting = false;
async function quit(code) {
  if (quitting) return;
  quitting = true;
  const b = rec?.browser;
  if (b && b.exitCode === null && b.signalCode === null) {
    const gone = new Promise(r => b.once('exit', r));
    b.kill();
    await Promise.race([gone, new Promise(r => setTimeout(r, 4000))]);
    if (b.exitCode === null && b.signalCode === null) b.kill('SIGKILL');
  }
  if (rec?.ff && rec.ff.exitCode === null) rec.ff.kill('SIGKILL');
  if (rec) try { rmSync(rec.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  server.close();
  process.exit(code);
}
process.on('SIGINT', () => quit(130));
process.on('SIGTERM', () => quit(143));
process.on('uncaughtException', err => { console.error(`\n  gitropolis: ${err.stack || err}`); quit(1); });
process.on('unhandledRejection', err => { console.error(`\n  gitropolis: ${err?.stack || err}`); quit(1); });

// a busy default port moves on to the next one; a port you asked for is reported, not changed
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && !portGiven && port < 4173 + 20) { port++; return server.listen(port, '127.0.0.1'); }
  console.error(err.code === 'EADDRINUSE' ? `  gitropolis: port ${port} is already in use — try --port <n>` : `  gitropolis: ${err.message}`);
  quit(1);
});
server.listen(port, '127.0.0.1');
server.on('listening', () => {
  const link = `http://localhost:${port}`;
  if (!rec) {
    const view = `${link}/?${styleAsked ? `style=${style}&` : ''}city=${cityOpt}${pxOpt ? `&px=${pxOpt}` : ''}${zoomOpt ? `&zoom=${zoomOpt}` : ''}`;
    console.log(`  city open at ${cyan(view)}`);
    if (!noOpen) openBrowser(view);
    return;
  }
  const recUrl = card ? `${link}/?card=${encodeURIComponent(cardShape)}&post=1&city=${cityOpt}${cardFull ? '&full=1' : ''}`
    : `${link}/?record=1&w=${w}&h=${h}&fps=${fps}&dur=${duration}&style=${style}&city=${cityOpt}${pxOpt ? `&px=${pxOpt}` : ''}${zoomOpt ? `&zoom=${zoomOpt}` : ''}` +
    (still ? `&still=1&shot=${shot}${noHud ? '&hud=0' : ''}` : '') + (fixedCam ? '&static=1' : '') + (benchMode ? '&bench=1' : '');
  console.log(card ? `  drawing a ${cardShape} share card …` : still ? `  photographing ${style} / ${shot} at ${w}x${h} …` : `  filming ${duration}s at ${w}x${h}@${fps}fps …`);
  // a browser that never sends a frame (GPU trouble, blocked CDN) shouldn't hang the CLI forever;
  // a still is one frame, which on a software GPU can take a while for a big city
  setTimeout(() => {
    if (rec.got) return;
    console.error('\n  gitropolis: the browser never sent a frame — try --headed to watch what happens');
    quit(1);
  }, benchMode || still ? 300_000 : 90_000).unref();
  const chrome = findChrome();
  if (chrome && !headed) {
    rec.browser = spawn(chrome, ['--headless=new', `--window-size=${w},${h}`, '--hide-scrollbars', '--mute-audio',
      '--enable-gpu', '--use-angle=default', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', ...(benchMode ? ['--js-flags=--expose-gc --no-concurrent-array-buffer-sweeping', '--enable-precise-memory-info'] : []),
      `--user-data-dir=${path.join(rec.tmp, 'chrome')}`, recUrl], { stdio: 'ignore' });
  } else {
    console.log(`  open ${cyan(recUrl)} and keep the tab in front until it finishes`);
    openBrowser(recUrl);
  }
});

async function finishRecording() {
  if (still) {
    console.log(`\n  ${cyan(card ? 'card' : 'still')} ${path.resolve(still)} (${await size(still)})`);
    return quit(0);
  }
  rec.ff.stdin.end();
  await rec.ffDone;
  const secs = ((Date.now() - rec.t0) / 1000).toFixed(0);
  console.log(`\n  rendered in ${secs}s`);
  if (video) {
    process.stdout.write(`  encoding video (≤ ${maxMB} MB) … `);
    await encodeVideo(rec.mp4, path.resolve(video), rec.tmp);
    console.log(`done\n  ${cyan('video')} ${path.resolve(video)} (${await size(video)})`);
  }
  if (gif) {
    process.stdout.write(`  encoding gif (≤ ${maxMB} MB) … `);
    const used = await encodeGif(rec.mp4, path.resolve(gif));
    console.log(`done\n  ${cyan('gif')}   ${path.resolve(gif)} (${await size(gif)}, ${used})`);
  }
  return quit(0);
}

// ---------------------------------------------------------------- encoding
// two-pass H.264 at the bitrate that lands just under the size cap
async function encodeVideo(src, dst, tmp) {
  const kbps = Math.floor(maxMB * 8000 * 0.92 / duration);
  const common = ['-y', '-loglevel', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'slow', '-b:v', `${kbps}k`,
    '-pix_fmt', 'yuv420p', '-an', '-passlogfile', path.join(tmp, 'pass')];
  await run('ffmpeg', [...common, '-pass', '1', '-f', 'mp4', os.devNull]);
  await run('ffmpeg', [...common, '-pass', '2', '-movflags', '+faststart', dst]);
}
// GIFs can't be bitrate-targeted: shrink width / fps until it fits
async function encodeGif(src, dst) {
  // pixel art: shrink by exactly the art-pixel size with nearest-neighbour (one GIF pixel per art pixel),
  // keep the palette as it is and don't dither again; flat colours make it compress very well
  if (style === 'pixel') {
    const px = Math.max(1, Math.round(rec.meta?.px || +pxOpt || 1)); // the art-pixel size the page used
    for (const div of [1, 2]) {
      for (const gfps of [15, 12, 10, 8]) {
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf',
          `fps=${gfps},scale=iw/${px * div}:ih/${px * div}:flags=neighbor,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none`, dst]);
        if ((await stat(dst)).size <= maxMB * 1e6) return `${Math.round(w / px / div)}px @ ${gfps}fps, 1 GIF pixel = ${div} art pixel${div > 1 ? 's' : ''}`;
      }
    }
    return 'over the size cap — try a shorter --duration';
  }
  const tries = [[800, 15], [720, 12], [640, 12], [560, 10], [480, 10], [400, 8]];
  for (const [gw, gfps] of tries) {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf',
      `fps=${gfps},scale=${Math.min(gw, w)}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];` +
      `[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, dst]);
    if ((await stat(dst)).size <= maxMB * 1e6) return `${gw}px @ ${gfps}fps`;
  }
  return 'over the size cap even at 400px — try a shorter --duration';
}

// ---------------------------------------------------------------- helpers
function openBrowser(link) {
  exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} "${link}"`);
}
function findChrome() {
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`],
  }[process.platform] || [];
  return candidates.find(p => p && existsSync(p));
}
function run(cmd, argv) {
  return new Promise((resolve, reject) => spawn(cmd, argv, { stdio: 'inherit' })
    .on('close', c => c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
}
async function size(p) {
  const b = (await stat(p)).size;
  return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`;
}
