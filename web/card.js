// Share cards: the finished city as a poster, sized for where it's going (a link preview, a square
// post, a story), with the repo's name, what kind of city it is, its history and where to see it.
// The city is rendered off screen at art resolution and every art pixel becomes a 2×2 block, so the
// pixels survive a social network's JPEG recompression and stay crisp on phone screens.
const INK = '#14121c', SOFT = '#4a4458', PAPER = '#f2efe9', ACCENT = '#c0413b', BAR_OFF = '#cdc8d2';
const FONT = "'Pixelify Sans', monospace";
export const FORMATS = {
  landscape: { W: 1200, H: 630, label: 'link · X · LinkedIn' },
  square: { W: 1080, H: 1080, label: 'square post' },
  story: { W: 1080, H: 1920, label: 'story' },
};
const M = 36, P = 22, BORDER = 4, SHADOW = 6;

// info: { owner, repo, phrase, reasons[], stats: [[n, word]…], years: [a, b], activity(n) → 0..1 bars, url }
// capture(artW, artH, bands) → ImageData of the grown city framed inside the bands (fractions of the frame)
export async function drawCard(format, info, capture, { k = 2 } = {}) {
  const { W, H } = FORMATS[format];
  await Promise.race([document.fonts.load(`600 40px ${FONT}`), new Promise(r => setTimeout(r, 2500))]);
  const out = document.createElement('canvas');
  out.width = W * k; out.height = H * k;
  const g = out.getContext('2d');
  g.scale(k, k);
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
  if (format === 'landscape') {
    const PW = 384, iw = PW - P * 2;
    bands = { left: (M + PW + 12) / W, right: 12 / W, top: 16 / H, bottom: 16 / H };
    paint = () => {
      panel(M, M, PW, H - M * 2);
      const x = M + P; let y = M + P + 18;
      if (info.owner) { text(`${info.owner} /`, x, y, 20, SOFT); y += 10; }
      const rp = fit(info.repo, 58, iw); y += rp; text(info.repo, x, y, rp, INK, 600);
      y += 40; text('built like', x, y, 20, SOFT);
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
    const topW = story ? W - M * 2 : Math.min(W - M * 2, Math.max(width(info.repo, rp, 600), width(`built like ${info.phrase}`, z(28), 600), ...reasons.map(r => width(r, z(17)))) + P * 2 + 8);
    bands = { top: (M + topH + 12) / H, bottom: (M + botH + 12) / H };
    paint = () => {
      panel(M, M, topW, topH);
      const x = M + P; let y = M + P;
      if (info.owner) { y += z(20); text(`${info.owner} /`, x, y, z(20), SOFT); y += z(6); }
      y += rp; text(info.repo, x, y, rp, INK, 600);
      y += z(16) + z(28);
      text('built like ', x, y, z(24), SOFT);
      text(info.phrase, x + width('built like ', z(24)), y, z(28), ACCENT, 600);
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

  // the city fills the card (its sky and ground are the background), framed between the panels
  const art = capture(Math.round(W * k / 2), Math.round(H * k / 2), bands);
  const tmp = document.createElement('canvas');
  tmp.width = art.width; tmp.height = art.height;
  tmp.getContext('2d').putImageData(art, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, 0, 0, W, H);
  paint();
  return out;
}

// the share dialog: pick a shape, see the card, download it, copy it, or hand it to the phone's share sheet
export function openShareDialog({ info, capture, link, filename }) {
  document.getElementById('card-dialog')?.remove();
  const box = document.createElement('div');
  box.id = 'card-dialog';
  box.innerHTML = `<div class="card-panel" role="dialog" aria-modal="true" aria-label="Share this city">
    <div class="card-head"><b>share this city</b><button class="card-x" aria-label="Close">×</button></div>
    <div class="card-formats">${Object.entries(FORMATS).map(([id, f]) => `<button data-f="${id}">${id}<small>${f.label}</small></button>`).join('')}</div>
    <div class="card-view"><span>drawing…</span><img alt="Share card preview"></div>
    <div class="card-actions">
      <label class="card-hd"><input type="checkbox"> extra sharp (3×)</label>
      <button data-a="download">download PNG</button><button data-a="copy">copy image</button>
      <button data-a="share" hidden>share…</button><button data-a="link">copy link</button>
    </div></div>`;
  document.body.append(box);
  const $ = s => box.querySelector(s), img = $('img'), status = $('.card-view span');
  let format = innerWidth < innerHeight ? 'story' : 'landscape', blob = null, job = 0;
  const close = () => { box.remove(); removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') close(); if (box.contains(e.target) || e.key === 'Escape') e.stopPropagation(); };
  addEventListener('keydown', onKey, true);
  box.onclick = e => { if (e.target === box) close(); };
  $('.card-x').onclick = close;
  const flash = (btn, msg) => { const was = btn.textContent; btn.textContent = msg; setTimeout(() => { btn.textContent = was; }, 1600); };

  async function render() {
    const mine = ++job;
    box.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', b.dataset.f === format));
    status.hidden = false; img.style.opacity = 0.35; blob = null;
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); // let "drawing…" show first
    const canvas = await drawCard(format, info, capture, { k: $('.card-hd input').checked ? 3 : 2 });
    const b = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (mine !== job) return;
    blob = b;
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(b); img.style.opacity = 1; status.hidden = true;
    const file = new File([b], `${filename}-${format}.png`, { type: 'image/png' });
    $('[data-a=share]').hidden = !navigator.canShare?.({ files: [file] });
  }
  box.querySelectorAll('[data-f]').forEach(b => { b.onclick = () => { format = b.dataset.f; render(); }; });
  $('.card-hd input').onchange = render;
  $('[data-a=download]').onclick = () => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = img.src; a.download = `${filename}-${format}.png`; a.click();
  };
  $('[data-a=copy]').onclick = async e => {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); flash(e.target, 'copied'); }
    catch { flash(e.target, "can't copy here"); }
  };
  $('[data-a=share]').onclick = async () => {
    try { await navigator.share({ files: [new File([blob], `${filename}-${format}.png`, { type: 'image/png' })], text: `${info.owner ? info.owner + '/' : ''}${info.repo} is built like ${info.phrase}`, url: link }); }
    catch { /* cancelled */ }
  };
  $('[data-a=link]').onclick = async e => {
    try { await navigator.clipboard.writeText(link); flash(e.target, 'link copied'); }
    catch { prompt('Copy this link:', link); }
  };
  render();
}
