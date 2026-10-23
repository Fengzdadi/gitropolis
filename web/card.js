// Share cards: the finished city as a poster, sized for where it's going (a link preview, a square
// post, a story), with the repo's name, what kind of city it is, its history and where to see it.
// The city is rendered off screen at art resolution and every art pixel becomes a 2×2 block, so the
// pixels survive a social network's JPEG recompression and stay crisp on phone screens.
import { canvasPNG } from './png.js';

const INK = '#14121c', SOFT = '#4a4458', PAPER = '#f2efe9', ACCENT = '#c0413b', BAR_OFF = '#cdc8d2';
const FONT = "'Pixelify Sans', monospace";
export const FORMATS = {
  landscape: { W: 1200, H: 630, label: 'link · X · LinkedIn' },
  square: { W: 1080, H: 1080, label: 'square post' },
  story: { W: 1080, H: 1920, label: 'story' },
};
// sizes that aren't offered in the dialog: GitHub's repository social preview (2:1)
const EXTRA = { social: { W: 1280, H: 640 }, brand: { W: 1200, H: 630 } }; // and the site's own link preview
const M = 36, P = 22, BORDER = 4, SHADOW = 6;


// films are always full bleed, the date ticking in a corner; sized for video (1080p) and shrunk for GIFs
export const FILM = {
  landscape: { W: 1920, H: 1080, scale: 1.6, gif: 960 },
  square: { W: 1080, H: 1080, scale: 1.25, gif: 800 },
  story: { W: 1080, H: 1920, scale: 1.7, gif: 960 },
};
export const canFilmVideo = () => typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
// the web fonts' stylesheet loads without blocking the page (index.html marks it done): wait for it,
// then for the pixel font itself, but never more than a few seconds (offline, there's no font to wait for)
async function fontsReady() {
  const sheet = document.getElementById('webfonts'), t0 = performance.now();
  while (sheet && !sheet.dataset.done && performance.now() - t0 < 4000) await new Promise(r => setTimeout(r, 50));
  await Promise.race([Promise.all([document.fonts.load(`600 40px ${FONT}`), document.fonts.load(`400 20px ${FONT}`)]), new Promise(r => setTimeout(r, 2500))]);
}

// where the text goes on a W × H design (and so the bands the city keeps clear of), and how to paint it
function layout(g, format, info, { W, H, full, scale }) {
  const lead = info.lead ?? 'built like '; // what comes before the phrase
  const font = (px, w = 400) => { g.font = `${w} ${px}px ${FONT}`; };
  const width = (txt, px, w) => { font(px, w); return g.measureText(txt).width; };
  // largest size (down to a floor) at which a line fits
  const fit = (txt, px, max, w = 600, min = 14) => { while (px > min && width(txt, px, w) > max) px -= 1; return px; };
  const wrap = (txt, px, max, lines) => {
    font(px); const out = []; let cur = '';
    for (const word of txt.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (g.measureText(next).width <= max || !cur) cur = next; else { out.push(cur); cur = word; }
    }
    if (cur) out.push(cur);
    if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, '') + '…'; }
    return out;
  };
  const panel = (x, y, w, h) => {
    g.fillStyle = INK; g.fillRect(x + SHADOW, y + SHADOW, w, h);
    g.fillRect(x, y, w, h);
    g.fillStyle = PAPER; g.fillRect(x + BORDER, y + BORDER, w - BORDER * 2, h - BORDER * 2);
  };
  const text = (txt, x, y, px, color = INK, w = 400, align = 'left') => {
    font(px, w); g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillText(txt, x, y);
  };
  // the history as a strip of pixel bars, red where it was busiest
  const spark = (x, y, w, h, fs = 14) => {
    const n = Math.max(8, Math.floor(w / 6)), bars = info.activity(n), bw = w / n;
    bars.forEach((v, i) => {
      if (!v) return;
      const bh = Math.max(2, Math.round(v * h));
      g.fillStyle = v > 0.15 ? ACCENT : BAR_OFF;
      g.fillRect(Math.round(x + i * bw), y + h - bh, Math.max(2, Math.floor(bw) - 2), bh);
    });
    text(String(info.years[0]), x, y + h + fs + 4, fs, SOFT);
    if (info.years[1] !== info.years[0]) text(String(info.years[1]), x + w, y + h + fs + 4, fs, SOFT, 400, 'right');
  };
  const statLine = info.stats.map(([n, w]) => `${n.toLocaleString('en')} ${w}`);

  // where the text goes, and so the band the city has to keep clear of
  let bands, paint;
  if (full) {
    // full bleed: the city is the picture, with a small name tag in one corner and the address in the other
    const z = n => Math.round(n * (scale || (format === 'story' ? 1.7 : format === 'square' ? 1.25 : format === 'social' || format === 'brand' ? 1.6 : 1)));
    const name = info.owner ? `${info.owner}/${info.repo}` : info.repo;
    const np = fit(name, z(30), W * 0.6), tagW = Math.max(width(name, np, 600), width(`${lead}${info.phrase}`, z(20), 600)) + P * 2;
    const tagH = P * 2 + np + z(30), urlP = z(16), urlW = width(info.url, urlP, 600) + z(14) * 2, urlH = urlP + z(14) * 2;
    bands = { top: 0, bottom: 0, fill: format === 'story' ? 2.8 : 1.8 }; // how far past 'fits' it may zoom
    paint = date => {
      if (date) { // films: the date ticks along in the top corner
        const dp = z(26), dw = width('0000-00', dp, 600) + z(14) * 2, dh = dp + z(14) * 2;
        panel(W - M - dw, M, dw, dh);
        text(date, W - M - z(14), M + z(14) + dp * 0.85, dp, INK, 600, 'right');
      }
      const x = M, y = H - M - tagH;
      panel(x, y, tagW, tagH);
      text(name, x + P, y + P + np * 0.9, np, INK, 600);
      text(lead, x + P, y + P + np + z(24), z(18), SOFT);
      text(info.phrase, x + P + width(lead, z(18)), y + P + np + z(24), z(20), ACCENT, 600);
      panel(W - M - urlW, H - M - urlH, urlW, urlH);
      text(info.url, W - M - z(14), H - M - z(14) - urlP * 0.15, urlP, INK, 600, 'right');
    };
  } else if (format === 'landscape') {
    const PW = 384, iw = PW - P * 2;
    bands = { left: (M + PW + 12) / W, right: 12 / W, top: 16 / H, bottom: 16 / H };
    paint = () => {
      panel(M, M, PW, H - M * 2);
      const x = M + P; let y = M + P + 18;
      if (info.owner) { text(`${info.owner} /`, x, y, 20, SOFT); y += 10; }
      const rp = fit(info.repo, 58, iw); y += rp; text(info.repo, x, y, rp, INK, 600);
      y += 40; text(lead.trim(), x, y, 20, SOFT);
      const pp = fit(info.phrase, 40, iw); y += pp + 8; text(info.phrase, x, y, pp, ACCENT, 600);
      y += 10;
      y += 6;
      for (const r of info.reasons.slice(0, 2)) for (const l of wrap(r, 17, iw, 2)) { y += 24; text(l, x, y, 17, SOFT); }
      // bottom up: the address, the numbers, the history
      let b = H - M - P - 4;
      text(info.url, x, b, fit(info.url, 24, iw), INK, 600);
      b -= 34;
      const two = [statLine.slice(0, 2).join(' · '), statLine.slice(2).join(' · ')].filter(Boolean);
      for (let i = two.length - 1; i >= 0; i--) { text(two[i], x, b, fit(two[i], 17, iw, 400, 11), SOFT); b -= 24; }
      spark(x, b - 82, iw, 56);
    };
  } else {
    // square and story: a title panel on top, the history and numbers below; a story has the room
    // for bigger type and the numbers as a row of big figures
    const story = format === 'story', big = story ? 1.7 : 1.2, iw = W - M * 2 - P * 2, z = n => Math.round(n * big);
    const rp = fit(info.repo, z(56), iw), reasons = info.reasons.slice(0, story ? 2 : 1).map(r => wrap(r, z(17), iw, 1)[0]);
    const topH = P * 2 + (info.owner ? z(26) : 0) + rp + z(16) + z(30) + reasons.length * z(26) + z(6);
    const sparkH = z(52), figH = story ? z(44) + z(24) + z(20) : 0;
    const botH = P * 2 + sparkH + z(24) + figH + z(36);
    const topW = story ? W - M * 2 : Math.min(W - M * 2, Math.max(width(info.repo, rp, 600), width(`${lead}${info.phrase}`, z(28), 600), ...reasons.map(r => width(r, z(17)))) + P * 2 + 8);
    bands = { top: (M + topH + 12) / H, bottom: (M + botH + 12) / H };
    paint = () => {
      panel(M, M, topW, topH);
      const x = M + P; let y = M + P;
      if (info.owner) { y += z(20); text(`${info.owner} /`, x, y, z(20), SOFT); y += z(6); }
      y += rp; text(info.repo, x, y, rp, INK, 600);
      y += z(16) + z(28);
      text(lead, x, y, z(24), SOFT);
      text(info.phrase, x + width(lead, z(24)), y, z(28), ACCENT, 600);
      for (const r of reasons) { y += z(26); text(r, x, y, z(17), SOFT); }
      const by = H - M - botH;
      panel(M, by, W - M * 2, botH);
      spark(x, by + P, iw, sparkH, z(13));
      let row = by + P + sparkH + z(24);
      if (story) { // the numbers, big
        const col = iw / info.stats.length;
        info.stats.forEach(([n, w], i) => {
          const cx = x + col * i;
          text(n.toLocaleString('en'), cx, row + z(44), fit(n.toLocaleString('en'), z(40), col - 12), INK, 600);
          text(w, cx, row + z(44) + z(24), z(17), SOFT);
        });
        row += figH;
      }
      row += z(30);
      const url = fit(info.url, z(26), story ? iw : iw * 0.55);
      text(info.url, story ? x : x + iw, row, url, INK, 600, story ? 'left' : 'right');
      if (!story) {
        const stats = statLine.join(' · ');
        text(stats, x, row, fit(stats, z(17), iw - width(info.url, url, 600) - 24, 400, 10), SOFT);
      }
    };
  }

  return { bands, paint };
}

// info: { owner, repo, phrase, reasons[], stats: [[n, word]…], years: [a, b], activity(n) → 0..1 bars, url }
// capture(artW, artH, bands) → ImageData of the grown city framed inside the bands (fractions of the frame)
export async function drawCard(format, info, capture, { k = 2, full = false } = {}) {
  const { W, H } = FORMATS[format] || EXTRA[format];
  await fontsReady();
  const out = document.createElement('canvas');
  out.width = W * k; out.height = H * k;
  const g = out.getContext('2d');
  g.scale(k, k);
  const { bands, paint } = layout(g, format, info, { W, H, full });
  // the city fills the card (its sky and ground are the background), framed between the panels
  blit(g, capture(Math.round(W * k / 2), Math.round(H * k / 2), bands), W, H);
  paint();
  return out;
}

// art pixels → 2×2 blocks
let tmp = null;
function blit(g, art, W, H) {
  tmp ??= document.createElement('canvas');
  if (tmp.width !== art.width || tmp.height !== art.height) { tmp.width = art.width; tmp.height = art.height; }
  tmp.getContext('2d').putImageData(art, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, 0, 0, W, H);
}

// A film of the city growing, shot frame by frame off screen (so it's smooth however slow the machine):
// kind 'gif' (12 fps, then a long look at the finished city) or 'mp4' (30 fps H.264 at 8 Mbps).
// stage(artW, artH, bands) → { rewind(seconds), frame(u, dt) → { img, date }, end() }
export async function filmCity(kind, format, info, stage, { progress = () => {}, cancelled = () => false } = {}) {
  const f = FILM[format], gif = kind === 'gif';
  const k = gif ? f.gif / Math.max(f.W, f.H) : 1;
  const artW = Math.round(f.W * k / 2), artH = Math.round(f.H * k / 2), OW = artW * 2, OH = artH * 2;
  await fontsReady();
  const out = document.createElement('canvas');
  out.width = OW; out.height = OH;
  const g = out.getContext('2d', { willReadFrequently: gif });
  g.scale(OW / f.W, OH / f.H);
  const { bands, paint } = layout(g, format, info, { W: f.W, H: f.H, full: true, scale: f.scale });
  const st = stage(artW, artH, bands);
  const draw = ({ img, date }) => { blit(g, img, f.W, f.H); paint(date); };
  const fps = gif ? 12 : 30, grow = gif ? 6 : 8, hold = gif ? 0 : 2, total = Math.round(fps * (grow + hold));
  const tick = () => new Promise(r => setTimeout(r, 0));
  try {
    if (gif) {
      // one palette for the whole film, taken from the finished city (plus a slot for "unchanged")
      draw(st.frame(1, 0));
      // the encoders are only fetched for a film, not with every page
      const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
      const palette = quantize(g.getImageData(0, 0, OW, OH).data, 255);
      while (palette.length < 255) palette.push([0, 0, 0]);
      palette.push([0, 0, 0]);
      st.rewind(grow * 0.8);
      const enc = GIFEncoder();
      let prev = null;
      for (let i = 0; i < total; i++) {
        if (cancelled()) return null;
        const u = Math.min(1, i / (total - 1) / 0.92); // the last few frames show the finished city
        draw(st.frame(u, 1 / fps));
        const idx = applyPalette(g.getImageData(0, 0, OW, OH).data, palette);
        // pixels that didn't change since the last frame are left transparent: a much smaller file
        const frame = prev ? idx.map((v, p) => v === prev[p] ? 255 : v) : idx;
        enc.writeFrame(frame, OW, OH, { palette, delay: i === total - 1 ? 3000 : Math.round(1000 / fps), transparent: !!prev, transparentIndex: 255, dispose: 1 });
        prev = idx;
        progress(i + 1, total);
        await tick();
      }
      enc.finish();
      return new Blob([enc.bytes()], { type: 'image/gif' });
    }
    // H.264 plays everywhere; a browser without an H.264 encoder gets VP9 in the same MP4
    const base = { width: OW, height: OH, bitrate: 8e6, framerate: fps };
    let config = null, muxCodec = 'avc';
    for (const [codec, mc] of [['avc1.640028', 'avc'], ['avc1.4d0028', 'avc'], ['avc1.42e028', 'avc'], ['vp09.00.40.08', 'vp9']]) {
      if ((await VideoEncoder.isConfigSupported({ ...base, codec }).catch(() => ({})))?.supported) { config = { ...base, codec }; muxCodec = mc; break; }
    }
    if (!config) throw new Error("this browser can't encode video");
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: muxCodec, width: OW, height: OH }, fastStart: 'in-memory' });
    let failed = null;
    const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failed = e; } });
    encoder.configure(config);
    st.rewind(grow * 0.8);
    for (let i = 0; i < total; i++) {
      if (cancelled() || failed) break;
      const u = Math.min(1, i / (fps * grow));
      draw(st.frame(u, 1 / fps));
      const vf = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      progress(i + 1, total);
      while (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 5));
      await tick();
    }
    if (failed) throw failed;
    if (cancelled()) { encoder.close(); return null; }
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  } finally {
    st.end();
  }
}

// the share dialog: pick a shape and a kind (picture, GIF, video), see it, download it, copy it,
// or hand it to the phone's share sheet
const KINDS = { png: 'image', gif: 'GIF', mp4: 'video', badge: 'README badge' };
const BADGES = [['', 'shields style'], ['pixel', 'pixel'], ['card', 'info card']];
export function openShareDialog({ info, capture, stage, link, filename, badge }) {
  document.getElementById('card-dialog')?.remove();
  const box = document.createElement('div');
  box.id = 'card-dialog';
  box.innerHTML = `<div class="card-panel" role="dialog" aria-modal="true" aria-label="Share this city">
    <div class="card-head"><b>share this city</b><button class="card-x" aria-label="Close">×</button></div>
    <div class="card-kinds">${Object.entries(KINDS).map(([id, l]) => `<button data-k="${id}">${l}</button>`).join('')}</div>
    <div class="card-formats">${Object.entries(FORMATS).map(([id, f]) => `<button data-f="${id}">${id}<small>${f.label}</small></button>`).join('')}</div>
    <div class="card-view"><span>drawing…</span><img alt="Share card preview"><video muted loop playsinline controls hidden></video>
      <div class="card-badges" hidden>${BADGES.map(([st, l]) => `<div><img data-b="${st}" alt="${l} badge"><button data-md="${st}">copy Markdown</button><small>${l}</small></div>`).join('')}</div></div>
    <div class="card-actions">
      <label class="card-hd"><input type="checkbox" data-o="full"> full bleed</label>
      <label class="card-hd"><input type="checkbox" data-o="hd"> extra sharp (3×)</label>
      <button data-a="download">download</button><button data-a="copy">copy image</button>
      <button data-a="share" hidden>share…</button><button data-a="link">copy link</button>
    </div></div>`;
  document.body.append(box);
  const $ = s => box.querySelector(s), img = $('img'), video = $('video'), status = $('.card-view span');
  if (!canFilmVideo()) $('[data-k=mp4]').hidden = true;
  if (!badge) $('[data-k=badge]').hidden = true; // badges are served by gitropolis.dev, for public repos
  const badgeUrl = st => `${badge}/badge.svg${st ? `?style=${st}` : ''}`;
  const markdown = st => `[![gitropolis](${badgeUrl(st)})](${badge})`;
  let format = innerWidth < innerHeight ? 'story' : 'landscape', kind = 'png', blob = null, url = null, job = 0;
  const ext = () => kind;
  const name = () => `${filename}-${format}${kind === 'png' && $('[data-o=full]').checked ? '-full' : ''}.${ext()}`;
  const close = () => { job++; box.remove(); removeEventListener('keydown', onKey, true); if (url) URL.revokeObjectURL(url); };
  const onKey = e => { if (e.key === 'Escape') close(); if (box.contains(e.target) || e.key === 'Escape') e.stopPropagation(); };
  addEventListener('keydown', onKey, true);
  box.onclick = e => { if (e.target === box) close(); };
  $('.card-x').onclick = close;
  const flash = (btn, msg) => { const was = btn.textContent; btn.textContent = msg; setTimeout(() => { btn.textContent = was; }, 1600); };

  async function render() {
    const mine = ++job;
    const isBadge = kind === 'badge';
    $('.card-formats').hidden = isBadge; $('.card-badges').hidden = !isBadge;
    for (const sel of ['[data-a=download]', '[data-a=share]']) $(sel).hidden = isBadge || (sel === '[data-a=share]' && $(sel).hidden);
    if (isBadge) {
      box.querySelectorAll('[data-k]').forEach(b => b.classList.toggle('on', b.dataset.k === kind));
      box.querySelectorAll('.card-hd').forEach(l => { l.hidden = true; });
      $('[data-a=copy]').hidden = true; img.hidden = video.hidden = true; status.hidden = true;
      box.querySelectorAll('[data-b]').forEach(i => { i.src = badgeUrl(i.dataset.b); });
      return;
    }
    box.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === format));
    box.querySelectorAll('[data-k]').forEach(b => b.classList.toggle('on', b.dataset.k === kind));
    box.querySelectorAll('.card-hd').forEach(l => { l.hidden = kind !== 'png'; });
    $('[data-a=copy]').hidden = kind !== 'png';
    status.hidden = false; status.textContent = kind === 'png' ? 'drawing…' : 'filming…';
    img.style.opacity = video.style.opacity = 0.35; blob = null;
    await new Promise(r => setTimeout(r, 40)); // let the status show first
    let b;
    try {
      b = kind === 'png'
        ? await drawCard(format, info, capture, { k: $('[data-o=hd]').checked ? 3 : 2, full: $('[data-o=full]').checked }).then(canvasPNG)
        : await filmCity(kind === 'gif' ? 'gif' : 'mp4', format, info, stage, {
          cancelled: () => mine !== job,
          progress: (i, n) => { status.textContent = `filming… ${Math.round(i / n * 100)}%`; },
        });
    } catch (err) {
      if (mine === job) status.textContent = `couldn't make that: ${err.message || err}`;
      return;
    }
    if (mine !== job || !b) return;
    blob = b;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(b);
    const isVideo = kind === 'mp4';
    img.hidden = isVideo; video.hidden = !isVideo; $('[data-a=download]').hidden = false;
    if (isVideo) { video.src = url; video.play().catch(() => {}); } else { video.removeAttribute('src'); img.src = url; }
    img.style.opacity = video.style.opacity = 1; status.hidden = true;
    $('[data-a=download]').textContent = `download ${KINDS[kind] === 'image' ? 'PNG' : KINDS[kind]} · ${(b.size / 1e6).toFixed(1)} MB`;
    $('[data-a=share]').hidden = !navigator.canShare?.({ files: [new File([b], name(), { type: b.type })] });
  }
  box.querySelectorAll('[data-f]').forEach(b => { b.onclick = () => { format = b.dataset.f; render(); }; });
  box.querySelectorAll('[data-k]').forEach(b => { b.onclick = () => { kind = b.dataset.k; render(); }; });
  box.querySelectorAll('[data-o]').forEach(i => { i.onchange = render; });
  $('[data-a=download]').onclick = () => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = url; a.download = name(); a.click();
  };
  $('[data-a=copy]').onclick = async e => {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); flash(e.target, 'copied'); }
    catch { flash(e.target, "can't copy here"); }
  };
  $('[data-a=share]').onclick = async () => {
    try { await navigator.share({ files: [new File([blob], name(), { type: blob.type })], text: `${info.owner ? info.owner + '/' : ''}${info.repo} is built like ${info.phrase}`, url: link }); }
    catch { /* cancelled */ }
  };
  box.querySelectorAll('[data-md]').forEach(b => {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(markdown(b.dataset.md)); flash(b, 'copied'); }
      catch { prompt('Copy this into your README:', markdown(b.dataset.md)); }
    };
  });
  $('[data-a=link]').onclick = async e => {
    try { await navigator.clipboard.writeText(link); flash(e.target, 'link copied'); }
    catch { prompt('Copy this link:', link); }
  };
  render();
}
