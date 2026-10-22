// PNGs of pixel art, small. The city is drawn in a few hundred colours, so a palette PNG (one byte a
// pixel) holds a card or a still in about a quarter of the browser's own true-colour PNG — which
// matters for link previews (some apps show no picture at all past a few hundred KB) and READMEs.
// The 256 commonest colours are kept exactly and the rare rest (text edges, mostly) take the nearest
// of them. A picture that isn't pixel art (smooth shading: too many colours) is left to the browser.
const COVER = 0.995; // the share of pixels the 256 commonest colours must hold

export async function canvasPNG(canvas) {
  const browser = () => new Promise(r => canvas.toBlob(r, 'image/png'));
  const g = canvas.getContext('2d');
  if (!g || typeof CompressionStream === 'undefined') return browser();
  const { width: w, height: h } = canvas;
  // one 32-bit word a pixel (rgba, little-endian), counted in runs: pixel art repeats itself
  const px = new Uint32Array(g.getImageData(0, 0, w, h).data.buffer);
  const count = new Map();
  for (let i = 0; i < px.length;) {
    const c = px[i];
    let j = i + 1;
    while (j < px.length && px[j] === c) j++;
    count.set(c, (count.get(c) || 0) + j - i);
    i = j;
  }
  const colors = [...count].sort((a, b) => b[1] - a[1]);
  const keep = colors.slice(0, 256).map(([c]) => c);
  if (colors.slice(0, 256).reduce((n, [, k]) => n + k, 0) < px.length * COVER) return browser();
  const rgba = c => [c & 255, c >>> 8 & 255, c >>> 16 & 255, c >>> 24];
  const pal = keep.map(rgba);
  const slot = new Map(keep.map((c, i) => [c, i]));
  for (const [c] of colors.slice(256)) {
    const [r, gr, b, a] = rgba(c);
    let best = 0, bd = Infinity;
    pal.forEach(([r2, g2, b2, a2], i) => {
      const d = (r - r2) ** 2 + (gr - g2) ** 2 + (b - b2) ** 2 + (a - a2) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    slot.set(c, best);
  }

  // scanlines: filter byte 0 (none, the right filter for palette images), then an index a pixel
  const raw = new Uint8Array((w + 1) * h);
  let last = -1, idx = 0;
  for (let y = 0, o = 0, p = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++, p++) {
      if (px[p] !== last) { last = px[p]; idx = slot.get(last); }
      raw[o++] = idx;
    }
  }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

  const ihdr = new Uint8Array(13), v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h);
  ihdr.set([8, 3, 0, 0, 0], 8); // 8-bit indexed colour, deflate, no interlace
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', new Uint8Array(pal.flatMap(c => c.slice(0, 3))))];
  if (pal.some(c => c[3] < 255)) parts.push(chunk('tRNS', new Uint8Array(pal.map(c => c[3]))));
  parts.push(chunk('IDAT', z), chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

let table;
function crc32(bytes) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// length, type, data, and a CRC over type and data
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
