// Streets, derived rather than drawn: rasterise every city block, then a vector distance transform
// tells each patch of ground how far it is from the nearest block and in which direction. That one
// field gives us, for any city layout, where the streets are (near blocks), where their centre lines
// run (where two blocks are equally far) and how wide each street is — so we can paint asphalt only
// where streets actually are and drive traffic down the right lanes.
import * as THREE from 'three';
import { LAND_LEAD } from './surfaces.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';


function inside([x, z], poly) {
  let c = false;
  for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
    const [xa, za] = poly[k], [xb, zb] = poly[m];
    if ((za > z) !== (zb > z) && x < xa + (z - za) / (zb - za) * (xb - xa)) c = !c;
  }
  return c;
}

export function buildStreets({ layout, B, files, inDeg, SIZE, t01 }) {
  // resolution follows the city's grain: dense cities have narrow alleys that need finer texels
  const x0 = -SIZE * 0.6, S = SIZE * 1.2;
  const W = Math.min(2560, Math.max(1024, Math.ceil(S / (layout.unit * 0.06))));
  const tex = S / W;
  const toTex = v => (v - x0) / tex;
  const label = new Int32Array(W * W).fill(-1);
  const blocks = layout.blocks;

  // --- rasterise blocks (even-odd fill per texel centre)
  const fill = (poly, set) => {
    const P = poly.map(([x, z]) => [toTex(x), toTex(z)]);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of P) { a0 = Math.min(a0, x); a1 = Math.max(a1, x); b0 = Math.min(b0, z); b1 = Math.max(b1, z); }
    for (let j = Math.max(0, Math.floor(b0)); j <= Math.min(W - 1, Math.ceil(b1)); j++) {
      const zc = j + 0.5;
      // crossings of this scanline with the polygon's edges
      const xs = [];
      for (let k = 0, m = P.length - 1; k < P.length; m = k++) {
        const [xa, za] = P[k], [xb, zb] = P[m];
        if ((za > zc) !== (zb > zc)) xs.push(xa + (zc - za) / (zb - za) * (xb - xa));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let i = Math.max(0, Math.ceil(xs[k] - 0.5)); i <= Math.min(W - 1, Math.floor(xs[k + 1] - 0.5)); i++) set(j * W + i);
      }
    }
  };
  blocks.forEach((b, id) => fill(b.poly, p => { label[p] = id; }));

  // --- where the water is: everything but the land in water cities, plus rivers; bridges stay dry
  const wet = new Uint8Array(W * W);
  if (layout.groundIsWater) { wet.fill(1); for (const poly of [...layout.land, ...layout.shore]) fill(poly, p => { wet[p] = 0; }); }
  for (const poly of layout.water) fill(poly, p => { wet[p] = 1; });
  for (const b of layout.bridges) {
    const dx = b.b[0] - b.a[0], dz = b.b[1] - b.a[1], L = Math.hypot(dx, dz) || 1, nx = -dz / L * b.w / 2, nz = dx / L * b.w / 2;
    fill([[b.a[0] + nx, b.a[1] + nz], [b.b[0] + nx, b.b[1] + nz], [b.b[0] - nx, b.b[1] - nz], [b.a[0] - nx, b.a[1] - nz]], p => { wet[p] = 0; });
  }

  // --- vector distance transform (two-pass, 8SSEDT-style): offset from each texel to its nearest block texel
  const INF = 30000;
  const vx = new Int16Array(W * W), vz = new Int16Array(W * W);
  for (let p = 0; p < W * W; p++) if (label[p] < 0) { vx[p] = INF; vz[p] = INF; }
  const d2 = p => vx[p] * vx[p] + vz[p] * vz[p];
  const relax = (p, q, ox, oz) => {
    if (vx[q] === INF) return;
    const cx = vx[q] + ox, cz = vz[q] + oz;
    if (cx * cx + cz * cz < d2(p)) { vx[p] = cx; vz[p] = cz; }
  };
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (i > 0) relax(p, p - 1, -1, 0);
      if (j > 0) { relax(p, p - W, 0, -1); if (i > 0) relax(p, p - W - 1, -1, -1); if (i < W - 1) relax(p, p - W + 1, 1, -1); }
    }
    for (let i = W - 2; i >= 0; i--) relax(j * W + i, j * W + i + 1, 1, 0);
  }
  for (let j = W - 1; j >= 0; j--) {
    for (let i = W - 1; i >= 0; i--) {
      const p = j * W + i;
      if (i < W - 1) relax(p, p + 1, 1, 0);
      if (j < W - 1) { relax(p, p + W, 0, 1); if (i < W - 1) relax(p, p + W + 1, 1, 1); if (i > 0) relax(p, p + W - 1, -1, 1); }
    }
    for (let i = 1; i < W; i++) relax(j * W + i, j * W + i - 1, -1, 0);
  }

  // --- pack: R = distance in texels; B, A = the street's centre line (below)
  const data = new Uint8Array(W * W * 4);
  const D = new Float32Array(W * W);
  for (let p = 0; p < W * W; p++) {
    const d = vx[p] === INF ? 255 : Math.sqrt(d2(p));
    D[p] = d;
    data[p * 4] = Math.min(255, Math.round(d));
    data[p * 4 + 2] = 255;
  }
  const texture = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  // streets are at most this far from a block (half an LA freeway); farther is open land
  const maxHalf = Math.min(250, Math.max(3, (layout.unit * 1.2) / tex));

  // --- centre lines: a street's centre is where its two blocks are equally far, so it runs where the
  // nearest block changes from one texel to the next. From there a band a few texels wide either side
  // learns which block is across the street; in it the distances to the two blocks' outlines give
  // B = signed distance to the centre line (128 on it, 1/32 texel a step: signed, so it filters to 0
  // on a line that falls between texels), A = 255 where a line may be drawn, and a second texture
  // where along it the dashes fall: the length round the lower-numbered block's outline, as an angle
  // (cos, sin) so it interpolates without a seam, over DASH_TURN dashes
  const own = p => (vx[p] === INF ? -1 : label[p + vz[p] * W + vx[p]]);
  const street = p => label[p] < 0 && D[p] <= maxHalf;
  const other = new (blocks.length < 32767 ? Int16Array : Int32Array)(W * W).fill(-1);
  const band = [];
  // the centre: two street texels side by side whose nearest blocks differ, and face each other (not
  // two blocks side by side, whose boundary runs on out into the street they both front)
  const meet = (p, q) => {
    if (!street(q)) return;
    const mine = own(p), theirs = own(q);
    if (mine < 0 || theirs < 0 || theirs === mine) return;
    if (vx[p] * vx[q] + vz[p] * vz[q] > -0.5 * Math.hypot(vx[p], vz[p]) * Math.hypot(vx[q], vz[q])) return;
    if (other[p] < 0) { other[p] = theirs; band.push(p); }
    if (other[q] < 0) { other[q] = mine; band.push(q); }
  };
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!street(p)) continue;
      if (i < W - 1) meet(p, p + 1);
      if (j < W - 1) meet(p, p + W);
    }
  }
  // out from the centre: far enough that every texel near the line has its neighbours filled in
  const spread = (p, q) => {
    if (other[q] >= 0 || !street(q)) return;
    const theirs = own(q), across = theirs === own(p) ? other[p] : own(p);
    if (theirs < 0 || across === theirs) return;
    other[q] = across;
    band.push(q);
  };
  for (let from = 0, depth = 0; depth < 8; depth++) {
    const to = band.length;
    for (let n = from; n < to; n++) {
      const p = band[n], i = p % W;
      if (i > 0) spread(p, p - 1);
      if (i < W - 1) spread(p, p + 1);
      if (p >= W) spread(p, p - W);
      if (p < W * W - W) spread(p, p + W);
    }
    from = to;
  }
  // how far each street texel is from the water, in texels (8-neighbour steps, never more than the
  // true distance; 255 = farther than a street is wide): which streets run along a bank, and how near
  // the water a car may come
  const toWater = new Uint8Array(W * W).fill(255);
  let shore = [];
  for (let p = 0; p < W * W; p++) {
    if (wet[p] || !street(p)) continue;
    const i = p % W;
    if ((i > 0 && wet[p - 1]) || (i < W - 1 && wet[p + 1]) || (p >= W && wet[p - W]) || (p < W * W - W && wet[p + W])) { toWater[p] = 1; shore.push(p); }
  }
  for (let d = 2; d <= Math.min(254, maxHalf) && shore.length; d++) {
    const next = [];
    for (const p of shore) {
      const i = p % W;
      for (let dj = -W; dj <= W; dj += W) {
        for (let di = -1; di <= 1; di++) {
          const q = p + dj + di;
          if ((di < 0 && i === 0) || (di > 0 && i === W - 1) || q < 0 || q >= W * W || toWater[q] !== 255 || wet[q] || !street(q)) continue;
          toWater[q] = d;
          next.push(q);
        }
      }
    }
    shore = next;
  }
  // the nearest point of a river bank or shore to (x, z): how far, and which way (fx, fz)
  const banks = layout.groundIsWater ? [...layout.land, ...layout.shore, ...layout.water] : layout.water;
  const bank = (x, z) => {
    let best = Infinity, fx = 0, fz = 0;
    for (const poly of banks) {
      for (let m = 0; m < poly.length; m++) {
        const a = poly[m], b = poly[(m + 1) % poly.length], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
        const px = a[0] + ex * t - x, pz = a[1] + ez * t - z;
        if (px * px + pz * pz < best) { best = px * px + pz * pz; fx = px; fz = pz; }
      }
    }
    const d = Math.sqrt(best);
    return { d, fx: fx / (d || 1), fz: fz / (d || 1) };
  };
  // dashes a little over a quarter of a lot long, a power of two so the shader's pixel sizes divide it
  const dash = 2 ** Math.round(Math.log2(layout.unit * 0.28)), DASH_TURN = 16;
  const along = new Uint8Array(W * W * 2).fill(128);
  const cum = new Map(); // block -> running length round its outline at each corner
  const outline = id => {
    if (!cum.has(id)) { const poly = blocks[id].poly, c = [0]; for (let k = 0; k < poly.length; k++) { const a = poly[k], b = poly[(k + 1) % poly.length]; c.push(c[k] + Math.hypot(b[0] - a[0], b[1] - a[1])); } cum.set(id, c); }
    return cum.get(id);
  };
  // the side of a block's outline a street runs along at (x, z): of the sides about as near, the one
  // running most along the street (across it is (nx, nz)). Distances are to that side's line, which
  // carries on across the mouth of a side street, and so does the centre line; `over` is how far
  // (x, z) is past the side's end, out into a junction
  const ds = new Float64Array(Math.max(1, ...blocks.map(b => b.poly.length)));
  const nearSide = (poly, x, z, nx, nz) => {
    const n = poly.length;
    let dMin = Infinity;
    for (let m = 0; m < n; m++) {
      const a = poly[m], b = poly[(m + 1) % n], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
      const dx = x - a[0] - ex * t, dz = z - a[1] - ez * t;
      ds[m] = dx * dx + dz * dz;
      if (ds[m] < dMin) dMin = ds[m];
    }
    const near = (Math.sqrt(dMin) + tex) ** 2;
    let k = 0, bestAcross = Infinity;
    for (let m = 0; m < n; m++) {
      if (ds[m] > near) continue;
      const a = poly[m], b = poly[(m + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const across = Math.abs(((b[0] - a[0]) * nx + (b[1] - a[1]) * nz) / L);
      if (across < bestAcross) { bestAcross = across; k = m; }
    }
    const a = poly[k], b = poly[(k + 1) % poly.length], ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez) || 1;
    const t = ((x - a[0]) * ex + (z - a[1]) * ez) / L, side = ((x - a[0]) * ez - (z - a[1]) * ex) / L;
    // (fx, fz): from (x, z) towards the side
    return { k, t, d: Math.abs(side), fx: -Math.sign(side) * ez / L, fz: Math.sign(side) * ex / L, over: Math.max(0, -t, t - L) };
  };
  for (const p of band) {
    if (wet[p]) continue;
    const i = p % W, j = (p - i) / W;
    const x = x0 + (i + 0.5) * tex, z = x0 + (j + 0.5) * tex;
    const nL = Math.hypot(vx[p], vz[p]) || 1, nx = vx[p] / nL, nz = vz[p] / nL; // across the street
    const a = Math.min(own(p), other[p]), b = Math.max(own(p), other[p]);
    const sa = nearSide(blocks[a].poly, x, z, nx, nz), sb = nearSide(blocks[b].poly, x, z, nx, nz);
    const width = (sa.d + sb.d) / tex;
    if (width > maxHalf * 2 || width < 3) continue; // no block across; an alley
    if (sa.fx * sb.fx + sa.fz * sb.fz > -0.5) continue; // not across the street from each other
    // a river between them: the street runs along its bank (below), not across the river
    if (toWater[p] * tex < Math.max(sa.d, sb.d)) {
      const w = bank(x, z);
      if ((w.fx * sa.fx + w.fz * sa.fz > 0.5 && w.d < sa.d) || (w.fx * sb.fx + w.fz * sb.fz > 0.5 && w.d < sb.d)) continue;
    }
    const off = (sb.d - sa.d) / 2 / tex;
    data[p * 4 + 2] = Math.max(0, Math.min(255, Math.round(128 + off * 32)));
    // across a side street narrower than this one the line carries on; out in a junction it stops.
    // (Only near the line, so the mask's edge never falls where B changes sign)
    if (Math.abs(off) < 3 && Math.max(sa.over, sb.over) <= (sa.d + sb.d) / 2 * 0.6) data[p * 4 + 3] = 255;
    const turn = (outline(a)[sa.k] + sa.t) / (dash * DASH_TURN) * 2 * Math.PI;
    along[p * 2] = Math.round(127.5 + 127.5 * Math.cos(turn));
    along[p * 2 + 1] = Math.round(127.5 + 127.5 * Math.sin(turn));
  }
  // streets with a block on one side only: the asphalt stops maxHalf from the block where open land
  // lies beyond, or at the bank of a river; the centre line runs halfway across
  for (let p = 0; p < W * W; p++) {
    if (data[p * 4 + 2] !== 255 || wet[p] || !street(p) || own(p) < 0) continue;
    const d = D[p], w = toWater[p];
    const byLand = Math.abs(d - maxHalf / 2) < 6, byWater = w < 255 && w >= d / 1.42 - 6 && w <= d + 6;
    if (!byLand && !byWater) continue;
    const i = p % W, j = (p - i) / W;
    const x = x0 + (i + 0.5) * tex, z = x0 + (j + 0.5) * tex;
    const nL = Math.hypot(vx[p], vz[p]) || 1, nx = vx[p] / nL, nz = vz[p] / nL; // towards the block
    const a = own(p), sa = nearSide(blocks[a].poly, x, z, nx, nz);
    let far = Infinity;
    if (byWater) { const b = bank(x, z); if (b.fx * sa.fx + b.fz * sa.fz < -0.5) far = b.d; }
    if (byLand) {
      // open land past the far edge (not a wide street with a block across it)
      const qi = Math.round(i - nx * (maxHalf - d + 2)), qj = Math.round(j - nz * (maxHalf - d + 2)), q = qj * W + qi;
      if (qi >= 0 && qj >= 0 && qi < W && qj < W && label[q] < 0 && D[q] > maxHalf) far = Math.min(far, maxHalf * tex - sa.d);
    }
    if (!(far < Infinity) || (sa.d + far) / tex < 3) continue;
    const off = (far - sa.d) / 2 / tex;
    data[p * 4 + 2] = Math.max(0, Math.min(255, Math.round(128 + off * 32)));
    if (Math.abs(off) < 3 && sa.over <= (sa.d + far) / 2 * 0.6) data[p * 4 + 3] = 255;
    const turn = (outline(a)[sa.k] + sa.t) / (dash * DASH_TURN) * 2 * Math.PI;
    along[p * 2] = Math.round(127.5 + 127.5 * Math.cos(turn));
    along[p * 2 + 1] = Math.round(127.5 + 127.5 * Math.sin(turn));
  }
  const alongTexture = new THREE.DataTexture(along, W, W, THREE.RGFormat);
  alongTexture.magFilter = THREE.LinearFilter;
  alongTexture.minFilter = THREE.LinearFilter;
  alongTexture.unpackAlignment = 1;
  alongTexture.needsUpdate = true;

  // --- which block each building stands on, for traffic weights and when the block "opens"
  const sample = (x, z) => {
    const i = Math.floor(toTex(x)), j = Math.floor(toTex(z));
    return i < 0 || j < 0 || i >= W || j >= W ? -1 : j * W + i;
  };
  const weight = new Float64Array(blocks.length), born = new Float64Array(blocks.length).fill(1);
  files.forEach((f, i) => {
    const p = sample(B[i].x, B[i].z);
    const id = p < 0 ? -1 : label[p];
    if (id < 0) return;
    weight[id] += inDeg[i] + f.imp.length;
    born[id] = Math.min(born[id], t01(f.born));
  });
  const maxW = Math.max(1, ...weight);

  // --- when each block "opens": its first file's birth. Blocks with no files of their own (a park, a
  // plaza, a fallow field) open with the nearest files; a terrace never opens after one standing on it.
  const centroid = poly => [poly.reduce((a, q) => a + q[0], 0) / poly.length, poly.reduce((a, q) => a + q[1], 0) / poly.length];
  blocks.forEach((b, id) => {
    if (born[id] < 1) return;
    const [cx, cz] = centroid(b.poly);
    let best = Infinity, bt = 0;
    files.forEach((f, i) => { if (!(B[i].w > 0.01)) return; const d = Math.hypot(B[i].x - cx, B[i].z - cz); if (d < best) { best = d; bt = t01(f.born); } });
    born[id] = best < Infinity ? bt : 0;
  });
  const raised = [...blocks.keys()].filter(id => blocks[id].h > 0);
  for (const a of raised) for (const c of raised) {
    if (blocks[c].h > blocks[a].h && born[c] < born[a] && inside(centroid(blocks[c].poly), blocks[a].poly)) born[a] = born[c];
  }
  // G channel: when the nearest block opens (0–255 over the timeline); the street shader paves only then
  const bornOf = p => { const q = vx[p] === INF ? -1 : p + vz[p] * W + vx[p]; const id = label[p] >= 0 ? label[p] : q >= 0 ? label[q] : -1; return id >= 0 ? born[id] : 0; };
  for (let p = 0; p < W * W; p++) data[p * 4 + 1] = Math.round(Math.min(1, bornOf(p)) * 255);
  const bornAt = (x, z) => { const p = sample(x, z); return p < 0 ? 0 : bornOf(p); };

  // --- lanes: every block is circled by a lane halfway between its kerb and the street's centre line,
  // so the two blocks either side of a street give it traffic in both directions. Each side of a block
  // keeps its own distance, so a block with a wide road on one side and a canal on another drives
  // both right
  const lanes = [], curbs = [];
  blocks.forEach((b, id) => {
    if (b.type === 'park') return;
    const poly = b.poly;
    let area = 0;
    for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) area += (poly[m][0] - poly[k][0]) * (poly[m][1] + poly[k][1]);
    const out = area > 0 ? 1 : -1; // sign that turns an edge normal outward
    const gaps = poly.map(() => NaN), roads = poly.map(() => NaN);
    for (let k = 0; k < poly.length; k++) {
      const [ax, az] = poly[k], [bx, bz] = poly[(k + 1) % poly.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < tex * 2) continue;
      const nx = out * (bz - az) / L, nz = -out * (bx - ax) / L;
      // walk outward until the distance stops growing: that's the street's centre. A street with no
      // block across has its centre halfway to the river bank, or to where the asphalt stops. A long
      // side is walked from five places and the middle answer kept, so one bridge doesn't decide it
      const walks = (L > tex * 16 ? [0.2, 0.35, 0.5, 0.65, 0.8] : [0.5]).map(f => {
        let best = 0, s = 1;
        for (; s < maxHalf; s++) {
          const p = sample(ax + (bx - ax) * f + nx * s * tex, az + (bz - az) * f + nz * s * tex);
          if (p < 0 || label[p] >= 0) break;
          if (wet[p]) return [best, s / 2];
          if (D[p] < best - 0.5) break;
          best = Math.max(best, D[p]);
        }
        return [best, s >= maxHalf ? maxHalf / 2 : best];
      });
      const mid = i => walks.map(w => w[i]).sort((p, q) => p - q)[walks.length >> 1];
      gaps[k] = mid(0);
      roads[k] = mid(1);
    }
    const sides = gaps.filter(g => g === g).sort((p, q) => p - q);
    if (!sides.length) return;
    const typical = roads.filter(r => r === r).sort((p, q) => p - q);
    const half = sides[Math.floor(sides.length * 0.3)], road = typical[Math.floor(typical.length * 0.3)];
    if (half < 1.5) return; // alleys too narrow for a car
    // sides too short to measure (rounded corners) take the narrower of the sides either side of them
    const fill = v => v.map((x, k) => {
      if (x === x) return x;
      let p = k, q = k;
      do p = (p - 1 + v.length) % v.length; while (v[p] !== v[p]);
      do q = (q + 1) % v.length; while (v[q] !== v[q]);
      return Math.min(v[p], v[q]);
    });
    const lane = fill(roads).map(r => r * tex * 0.5), gap = fill(gaps);
    if (road >= 1.5) lanes.push({ pts: offset(poly, out, lane), lane: road * tex * 0.5, weight: 0.15 + 0.85 * Math.sqrt(weight[id] / maxW), born: Math.max(0, born[id] - LAND_LEAD) }); // traffic comes with the road
    // a line just off the kerb, where street trees go, kept far enough in from the lane that a tree's
    // canopy (up to ~0.18 unit) clears a passing bus (~0.1 unit either side of the lane); a side too
    // narrow for that gets none (where cars drive)
    const room = lane.map(l => l - layout.unit * 0.28);
    const kerb = room.map((r, k) => Math.max(0, Math.min(gap[k] * tex * 0.2, r)));
    curbs.push({ pts: offset(poly, out, kerb), bare: room.map(r => road >= 1.5 && r < 0), half: half * tex, born: born[id] });
  });

  // --- boats: loops out on the water around each island
  const boats = layout.groundIsWater
    ? layout.land.map(poly => {
      let area = 0;
      for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) area += (poly[m][0] - poly[k][0]) * (poly[m][1] + poly[k][1]);
      return { pts: offset(poly, area > 0 ? 1 : -1, layout.unit * 0.9), lane: layout.unit * 0.4, weight: 1, born: 0 };
    })
    : [];

  // cars only on open street ground; boats only on water
  const at = (x, z) => sample(x, z);
  const drivable = (x, z) => { const p = at(x, z); return p >= 0 && label[p] < 0 && !wet[p] && D[p] <= maxHalf + 1; };
  const navigable = (x, z) => { const p = at(x, z); return p >= 0 && wet[p] === 1; };
  // how far a car at (x, z) is from the water, at least
  const clearance = (x, z) => { const p = at(x, z); return p < 0 || toWater[p] === 255 ? Infinity : (toWater[p] - 0.5) * tex; };
  return { texture, alongTexture, dash, dashTurn: DASH_TURN, min: new THREE.Vector2(x0, x0), size: S, texel: tex, maxHalf, lanes, curbs, boats, drivable, navigable, clearance, blockBorn: born, bornAt };
}

// push a polygon outward by `d` (mitred corners, clamped so sharp corners don't spike)
// d is one distance, or one per side (side k runs from poly[k] to poly[k + 1])
function offset(poly, out, d) {
  const n = poly.length;
  return poly.map((p, k) => {
    const a = poly[(k - 1 + n) % n], b = poly[(k + 1) % n];
    const e1 = norm([p[0] - a[0], p[1] - a[1]]), e2 = norm([b[0] - p[0], b[1] - p[1]]);
    const n1 = [out * e1[1], -out * e1[0]], n2 = [out * e2[1], -out * e2[0]];
    const d1 = typeof d === 'number' ? d : d[(k - 1 + n) % n], d2 = typeof d === 'number' ? d : d[k];
    const det = n1[0] * n2[1] - n1[1] * n2[0];
    // two sides at different distances meet where their offset lines cross; nearly straight on, halfway
    if (d1 !== d2 && Math.abs(det) > 0.3) return [p[0] + (d1 * n2[1] - d2 * n1[1]) / det, p[1] + (d2 * n1[0] - d1 * n2[0]) / det];
    const m = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const s = (d1 + d2) / 2 / Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    return [p[0] + m[0] * s, p[1] + m[1] * s];
  });
}
function norm([x, z]) { const L = Math.hypot(x, z) || 1; return [x / L, z / L]; }

// little vehicle models in a unit box (length along x, width along z, height in units of length).
// Colour attributes are white where the instance's paint should show and dark for glass, tyres, trim.
function part(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
  const c = new THREE.Color(hex), n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
const PAINT = '#ffffff', GLASS = '#3b4a5c', TYRE = '#14121c', LAMP = '#fff2c4', TRIM = '#58585e';
const wheels = (y = 0) => [-0.3, 0.3].flatMap(x => [-0.42, 0.42].map(z => part(0.2, 0.09, 0.14, x, y, z, TYRE)));
const MODELS = {
  car: () => mergeGeometries([
    ...wheels(),
    part(1.0, 0.14, 0.9, 0, 0.05, 0, PAINT),          // body
    part(0.5, 0.12, 0.8, -0.06, 0.19, 0, GLASS),      // cabin windows
    part(0.42, 0.03, 0.72, -0.06, 0.31, 0, PAINT),    // roof
    part(0.04, 0.05, 0.22, 0.5, 0.1, -0.28, LAMP), part(0.04, 0.05, 0.22, 0.5, 0.1, 0.28, LAMP),
  ]),
  taxi: () => mergeGeometries([
    ...wheels(),
    part(1.0, 0.14, 0.9, 0, 0.05, 0, PAINT),
    part(0.5, 0.12, 0.8, -0.06, 0.19, 0, GLASS),
    part(0.42, 0.03, 0.72, -0.06, 0.31, 0, PAINT),
    part(0.14, 0.06, 0.4, -0.06, 0.34, 0, TRIM),       // roof sign
  ]),
  bus: () => mergeGeometries([
    ...[-0.36, 0.3].flatMap(x => [-0.44, 0.44].map(z => part(0.12, 0.05, 0.12, x, 0, z, TYRE))),
    part(1.0, 0.24, 0.96, 0, 0.03, 0, PAINT),
    part(0.94, 0.07, 0.98, 0.0, 0.17, 0, GLASS),      // window band
    part(0.04, 0.12, 0.8, 0.5, 0.06, 0, GLASS),       // windscreen
  ]),
  boat: () => mergeGeometries([
    part(0.8, 0.12, 0.9, -0.1, 0, 0, PAINT),          // hull
    part(0.24, 0.12, 0.6, 0.38, 0, 0, PAINT),         // bow
    part(0.06, 0.03, 0.92, -0.1, 0.0, 0, '#2f6188'),  // waterline stripe
    part(0.32, 0.12, 0.6, -0.25, 0.12, 0, '#e0d7b8'), // cabin
    part(0.28, 0.04, 0.62, -0.25, 0.17, 0, GLASS),
  ]),
};

const CAR_PAINT = ['#c0413b', '#f2efe9', '#2f6188', '#58585e', '#86bfd9', '#e8833a', '#3d6b36', '#b8b2a2', '#7a2a35'];

// cars, taxis, buses and boats running round their routes; positions updated on the CPU each frame
// (a couple of thousand matrices is nothing next to rendering the city). Every route is resampled
// evenly and each sample remembers whether a vehicle may be there — cars hide where a lane would
// cross water and reappear on the far bank, boats keep to the water.
export function buildTraffic({ streets, unit }) {
  const routes = [];
  const prep = (r, kind) => {
    const step = Math.max(streets.texel, r.lane * 0.5);
    // each sample also keeps how far it is from the water: a car shows only where all of it is clear
    const pts = [], ok = [], room = [];
    for (let k = 0; k < r.pts.length; k++) {
      const a = r.pts[k], b = r.pts[(k + 1) % r.pts.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / step));
      for (let t = 0; t < n; t++) {
        const x = a[0] + (b[0] - a[0]) * t / n, z = a[1] + (b[1] - a[1]) * t / n;
        pts.push([x, z]);
        ok.push(kind === 'boat' ? streets.navigable(x, z) : streets.drivable(x, z));
        room.push(kind === 'boat' ? Infinity : streets.clearance(x, z));
      }
    }
    const good = ok.filter(Boolean).length;
    if (good < 3) return;
    routes.push({ ...r, kind, pts, ok, room, step: null, cum: null, good });
  };
  streets.lanes.forEach(r => prep(r, 'car'));
  streets.boats.forEach(r => prep(r, 'boat'));
  for (const r of routes) {
    r.cum = [0];
    for (let k = 0; k < r.pts.length; k++) { const a = r.pts[k], b = r.pts[(k + 1) % r.pts.length]; r.cum.push(r.cum[k] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    r.L = r.cum[r.cum.length - 1];
  }

  const vehicles = [];
  let id = 0;
  for (const [ri, r] of routes.entries()) {
    // narrow streets would shrink cars to a dot; keep them readable next to the buildings
    const len = r.kind === 'boat' ? unit * 0.6 : Math.max(unit * 0.2, Math.min(r.lane * 1.6, unit * 0.32));
    const validL = r.L * (r.good / r.ok.length);
    const n = r.kind === 'boat' ? Math.min(5, Math.round(validL / (unit * 7))) : Math.round((validL / (len * 7)) * r.weight);
    for (let k = 0; k < n; k++, id++) {
      // busy streets get buses; one car in seven is a taxi
      const type = r.kind === 'boat' ? 'boat' : r.weight > 0.6 && id % 6 === 0 ? 'bus' : id % 7 === 3 ? 'taxi' : 'car';
      const L = type === 'bus' ? len * 2.2 : len;
      vehicles.push({ ri, type, s0: (k / Math.max(1, n)) * r.L + Math.random() * len, speed: unit * (r.kind === 'boat' ? 0.25 : type === 'bus' ? 0.5 : 0.7) * (0.75 + Math.random() * 0.5), len: L, wid: type === 'bus' ? len * 0.62 : type === 'boat' ? len * 0.4 : len * 0.5 });
    }
  }
  // keep the city lively but not jammed
  const CAP = 1800;
  if (vehicles.length > CAP) {
    for (let k = vehicles.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [vehicles[k], vehicles[j]] = [vehicles[j], vehicles[k]]; }
    vehicles.length = CAP;
  }
  // dense cities have thousands of routes; keep only the ones somebody drives, packed into typed arrays
  const used = [...new Set(vehicles.map(v => v.ri))];
  const remap = new Map(used.map((ri, k) => [ri, k]));
  const kept = used.map(ri => {
    const r = routes[ri], n = r.pts.length;
    const xy = new Float32Array(n * 2), cum = new Float32Array(r.cum), ok = new Uint8Array(n), room = new Float32Array(r.room);
    r.pts.forEach(([x, z], k) => { xy[k * 2] = x; xy[k * 2 + 1] = z; ok[k] = r.ok[k] ? 1 : 0; });
    return { kind: r.kind, born: r.born, L: r.L, n, xy, cum, ok, room };
  });
  for (const v of vehicles) v.ri = remap.get(v.ri);
  routes.length = 0;
  routes.push(...kept);

  // one instanced mesh per vehicle type
  const group = new THREE.Group();
  const fleets = {};
  for (const type of Object.keys(MODELS)) {
    const list = vehicles.filter(v => v.type === type);
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(MODELS[type](), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), list.length);
    const c = new THREE.Color();
    list.forEach((v, k) => mesh.setColorAt(k, c.set(type === 'taxi' ? '#f2c14e' : type === 'bus' ? (k % 2 ? '#c0413b' : '#f2c14e') : type === 'boat' ? '#f2efe9' : CAR_PAINT[(k * 5) % CAR_PAINT.length])));
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    fleets[type] = { mesh, list };
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  function update(time, timeline, baseY) {
    for (const { mesh, list } of Object.values(fleets)) {
      list.forEach((v, k) => {
        const r = routes[v.ri];
        if (timeline < r.born) { mesh.setMatrixAt(k, hidden); return; }
        const s = ((v.s0 + time * v.speed) % r.L + r.L) % r.L;
        let lo = 0, hi = r.cum.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (r.cum[mid] <= s) lo = mid; else hi = mid; }
        const nx = (lo + 1) % r.n;
        if (!r.ok[lo] || !r.ok[nx] || r.room[lo] < v.len / 2 || r.room[nx] < v.len / 2) { mesh.setMatrixAt(k, hidden); return; }
        const ax = r.xy[lo * 2], az = r.xy[lo * 2 + 1], bx = r.xy[nx * 2], bz = r.xy[nx * 2 + 1];
        const t = (s - r.cum[lo]) / Math.max(1e-6, r.cum[lo + 1] - r.cum[lo]);
        pos.set(ax + (bx - ax) * t, v.type === 'boat' ? 0 : baseY, az + (bz - az) * t);
        q.setFromAxisAngle(UP, -Math.atan2(bz - az, bx - ax));
        mesh.setMatrixAt(k, m.compose(pos, q, scl.set(v.len, v.len, v.wid)));
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  return { mesh: group, update, count: vehicles.length };
}
