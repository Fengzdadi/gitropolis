#!/usr/bin/env node
// gitropolis [repo] [--port 4173] [--out city.json] [--no-open]
//           [--style neon|maquette|plan|nocturne] [--still frame.png] [--shot hero|aerial|street|plan] [--no-hud]
//           [--video city.mp4] [--gif city.gif] [--duration 20] [--fps 30] [--size 1920x1080] [--max-mb 9.5] [--headed]
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec, spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRepo } from '../src/scan.mjs';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const bool = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const port = +flag('--port', process.env.PORT || 4173);
const out = flag('--out');
const video = flag('--video');
const gif = flag('--gif');
const duration = +flag('--duration', 20);
const fps = +flag('--fps', 30);
const [w, h] = flag('--size', '1920x1080').split('x').map(Number);
const maxMB = +flag('--max-mb', 9.5); // GitHub README uploads cap at 10 MB
const headed = bool('--headed');
const style = flag('--style', 'neon');
const still = flag('--still');
const shot = flag('--shot', 'hero');
const noHud = bool('--no-hud');
const noOpen = bool('--no-open');
const repo = args[0] || process.cwd();
const recording = !!(video || gif || still);

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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
if (id.chip) console.log(`  (psst: hardware sources found — try --style chip)`);
console.log('');

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
  const ff = still ? null : spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', mp4],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = ff && new Promise(r => ff.on('close', r));
  rec = { tmp, mp4, ff, ffDone, total: still ? 1 : Math.round(fps * duration), got: 0, browser: null, t0: Date.now() };
}

const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  if (url === '/city.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(json);
  }
  if (rec && req.method === 'POST') {
    const body = await readBody(req);
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
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(port, () => {
  const link = `http://localhost:${port}`;
  if (!rec) {
    const view = style === 'neon' ? link : `${link}/?style=${style}`;
    console.log(`  city open at ${cyan(view)}`);
    if (!noOpen) openBrowser(view);
    return;
  }
  const recUrl = `${link}/?record=1&w=${w}&h=${h}&fps=${fps}&dur=${duration}&style=${style}` +
    (still ? `&still=1&shot=${shot}${noHud ? '&hud=0' : ''}` : '');
  console.log(still ? `  photographing ${style} / ${shot} at ${w}x${h} …` : `  filming ${duration}s at ${w}x${h}@${fps}fps …`);
  const chrome = findChrome();
  if (chrome && !headed) {
    rec.browser = spawn(chrome, ['--headless=new', `--window-size=${w},${h}`, '--hide-scrollbars', '--mute-audio',
      '--enable-gpu', '--use-angle=default', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${path.join(rec.tmp, 'chrome')}`, recUrl], { stdio: 'ignore' });
  } else {
    console.log(`  open ${cyan(recUrl)} and keep the tab in front until it finishes`);
    openBrowser(recUrl);
  }
});

async function finishRecording() {
  rec.browser?.kill();
  if (still) {
    console.log(`\n  ${cyan('still')} ${path.resolve(still)} (${await size(still)})`);
    await rm(rec.tmp, { recursive: true, force: true }).catch(() => {});
    server.close();
    process.exit(0);
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
  await rm(rec.tmp, { recursive: true, force: true }).catch(() => {});
  server.close();
  process.exit(0);
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
