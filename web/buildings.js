// Procedural building generator for the pixel-art isometric look.
//
// buildingGeometry(spec) -> THREE.BufferGeometry (non-indexed, flat normals)
//   attributes: position, normal, color (linear rgb), part (float, see PARTS)
//   local space: footprint centred on x/z origin, base at y = 0, +y up.
//
// Everything is hand-assembled from boxes, lofts and struts instead of stock
// three primitives: we never emit bottom faces, we skip degenerate triangles,
// and we control winding, which keeps a building at 30-300 triangles so that
// ~10k of them can be merged into one mesh.
import * as THREE from 'three';

// ------------------------------------------------------------ palette
// Original 32-colour retro palette. Designed for a single sun at upper left:
// base colours sit in the mid-tones so the lit top face lands one step lighter
// and the right-hand face one step darker after quantisation.
export const PALETTE = {
  brick:    ['#b5523b', '#8a3b30', '#d1855a'],
  stone:    ['#e2c99a', '#c4a875', '#b8b2a2'],
  concrete: ['#d2cfc6', '#a3a39e', '#737880', '#ece4d2'],
  glass:    ['#86bccf', '#4e94aa', '#2d6c88', '#ade0d8'],
  roof:     ['#c3653c', '#7b4b3b', '#4b5762', '#5aa38e'], // clay, brown, slate, copper
  metal:    ['#8d9aa6', '#57626e', '#c8d1d8'],
  accent:   ['#ebb83c', '#d9583b', '#f4f1e8', '#2e3040'], // yellow, red, white, dark
  green:    ['#66a550', '#3f7d3e'],
  water:    ['#3f7ab4', '#86b9de'],
  ground:   ['#dccfa4', '#a6a28c', '#8aa569'],
};

export const FORMS = ['slab', 'tower', 'setback', 'podium', 'house', 'shed', 'plant', 'hall', 'frame'];
export const ERAS = ['old', 'mid', 'new'];
export const ROOFS = ['flat', 'gable', 'hip', 'mansard', 'spire', 'dome'];
export const PARTS = { wall: 0, roof: 1, trim: 2, glass: 3, accent: 4, podium: 5 };
const WALL = 0, ROOF = 1, TRIM = 2, GLASS = 3, ACC = 4, POD = 5;

const TAU = Math.PI * 2, SQ = Math.SQRT2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const _c = new THREE.Color();
const rgb = hex => { _c.set(hex); return [_c.r, _c.g, _c.b]; };

function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ mesh builder
class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.k = []; this.swap = false; }

  // One triangle, CCW seen from outside. `ref` (optional) is a point known to be
  // inside the solid: the winding is flipped if the normal points toward it.
  tri(a, b, c, part, col, ref) {
    if (this.swap) { // x<->z mirror reverses winding, so swap b/c back
      a = [a[2], a[1], a[0]]; const t = [c[2], c[1], c[0]];
      c = [b[2], b[1], b[0]]; b = t;
      if (ref) ref = [ref[2], ref[1], ref[0]];
    }
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return; // degenerate (collapsed roof ridge, zero-height box...)
    nx /= l; ny /= l; nz /= l;
    if (ref) {
      const d = nx * ((a[0] + b[0] + c[0]) / 3 - ref[0]) + ny * ((a[1] + b[1] + c[1]) / 3 - ref[1]) +
        nz * ((a[2] + b[2] + c[2]) / 3 - ref[2]);
      if (d < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }
    }
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) { this.n.push(nx, ny, nz); this.c.push(col[0], col[1], col[2]); this.k.push(part); }
  }

  quad(a, b, c, d, part, col, ref) { this.tri(a, b, c, part, col, ref); this.tri(a, c, d, part, col, ref); }

  // Box whose top may be sloped: h = top y at corners (x0,z0) (x1,z0) (x0,z1) (x1,z1).
  // side/top are [part, color]. skip lists faces to omit (px nx pz nz top).
  boxH(x0, x1, z0, z1, y0, h, side, top, skip) {
    const [h00, h10, h01, h11] = h, s = f => !(skip || []).includes(f);
    if (s('px')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, h10, z0], [x1, h11, z1], side[0], side[1]);
    if (s('nx')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, h01, z1], [x0, h00, z0], side[0], side[1]);
    if (s('pz')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, h11, z1], [x0, h01, z1], side[0], side[1]);
    if (s('nz')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, h00, z0], [x1, h10, z0], side[0], side[1]);
    if (s('top') && top) this.quad([x0, h01, z1], [x1, h11, z1], [x1, h10, z0], [x0, h00, z0], top[0], top[1]);
  }
  box(x0, x1, y0, y1, z0, z1, side, top, skip) { this.boxH(x0, x1, z0, z1, y0, [y1, y1, y1, y1], side, top, skip); }

  // n-sided prism/cone stack. rings: [y, rx, rz]. Used for chimneys, domes, spires.
  loft(cx, cz, rings, n, side, o = {}) {
    const rot = o.rot || 0;
    const pt = (i, k) => {
      const a = rot + (k % n) / n * TAU;
      return [cx + rings[i][1] * Math.cos(a), rings[i][0], cz + rings[i][2] * Math.sin(a)];
    };
    for (let i = 0; i < rings.length - 1; i++) {
      for (let k = 0; k < n; k++) this.quad(pt(i, k + 1), pt(i, k), pt(i + 1, k), pt(i + 1, k + 1), side[0], side[1]);
    }
    if (o.cap) {
      const last = rings.length - 1, ctr = [cx, rings[last][0], cz];
      for (let k = 0; k < n; k++) this.tri(ctr, pt(last, k + 1), pt(last, k), o.cap[0], o.cap[1]);
    }
  }

  // Four-sided frustum (w/d at each end) -- roofs, chamfers, spires.
  taper(cx, cz, w0, d0, w1, d1, y0, y1, side, cap) {
    this.loft(cx, cz, [[y0, w0 * SQ / 2, d0 * SQ / 2], [y1, w1 * SQ / 2, d1 * SQ / 2]], 4, side, { rot: Math.PI / 4, cap });
  }

  // Thin square-section bar between two arbitrary points (crane jib, ties, braces).
  strut(p0, p1, t, part, col, cap = false) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2], L = Math.hypot(dx, dy, dz);
    if (L < 1e-9) return;
    const d = [dx / L, dy / L, dz / L], up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l * t / 2); };
    const a = norm(cross(d, up)), b = norm(cross(d, norm(cross(d, up)).map(x => x)));
    const sg = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    const ring = p => sg.map(([s, r]) => [p[0] + a[0] * s + b[0] * r, p[1] + a[1] * s + b[1] * r, p[2] + a[2] * s + b[2] * r]);
    const r0 = ring(p0), r1 = ring(p1), mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
    for (let k = 0; k < 4; k++) this.quad(r0[k], r0[(k + 1) % 4], r1[(k + 1) % 4], r1[k], part, col, mid);
    if (cap) for (let k = 1; k < 3; k++) this.tri(r1[0], r1[k], r1[k + 1], part, col, mid); // end cap, only where the tip shows
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('part', new THREE.Float32BufferAttribute(this.k, 1));
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------ style
// Colours per era. Old = warm masonry, mid = neutral concrete, new = cool glass.
function makeStyle(spec, rng) {
  const P = {};
  for (const k of Object.keys(PALETTE)) P[k] = spec.palette && spec.palette[k] ? [].concat(spec.palette[k]) : PALETTE[k];
  const pick = (role, i) => rgb(P[role][i % P[role].length]);
  const shade = c => { const f = 0.95 + rng() * 0.1; return c.map(v => clamp(v * f, 0, 1)); }; // per-building tint
  const era = ERAS.includes(spec.era) ? spec.era : 'mid';
  const S = { era, P, pick, rng };
  S.accent = pick('accent', rng() < 0.5 ? 0 : 1);
  S.white = pick('accent', 2); S.dark = pick('accent', 3);
  S.steel = pick('metal', 1); S.alu = pick('metal', 2); S.metal = pick('metal', 0);
  if (era === 'old') {
    const brick = rng() < 0.62;
    S.wall = shade(brick ? pick('brick', Math.floor(rng() * 3)) : pick('stone', 1 + Math.floor(rng() * 2)));
    S.trim = pick('stone', 0);
    S.base = brick ? pick('stone', 1) : pick('stone', 2);
    S.ground = S.base; S.solid = S.wall;
    S.flat = pick('concrete', 2);
    S.pitch = pick('roof', rng() < 0.6 ? 0 : 1); S.slate = pick('roof', 2);
    S.spireC = pick('roof', 3); S.domeC = pick('roof', 3);
  } else if (era === 'mid') {
    const l = rng() < 0.5;
    S.wall = shade(pick('concrete', l ? 0 : 3));
    S.trim = pick('concrete', l ? 1 : 1);
    S.base = pick('concrete', 2); S.ground = S.base; S.solid = S.wall;
    S.flat = pick('concrete', 1);
    S.pitch = pick('roof', rng() < 0.5 ? 2 : 1); S.slate = pick('roof', 2);
    S.spireC = pick('metal', 0); S.domeC = pick('metal', 0);
  } else {
    S.wall = shade(pick('glass', rng() < 0.6 ? 1 : 0));
    S.trim = pick('metal', 2);
    S.base = pick('glass', 2); S.ground = S.base;
    S.solid = pick('concrete', 3);
    S.flat = pick('metal', 0);
    S.pitch = pick('metal', 1); S.slate = pick('metal', 1);
    S.spireC = pick('glass', 2); S.domeC = pick('glass', 3);
  }
  return S;
}

// ------------------------------------------------------------ blocks
// Era-styled walls from y0 to y1, *including* its own top cap. Returns the
// usable top rect so roofs/props/upper tiers can sit on it.
//   o: cx cz w d y0 y1, ground (base storey), wallPart/wallCol, top, fins
function block(M, S, o) {
  const { cx, cz, w, d, y0, y1 } = o;
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  const u = Math.min(w, d), H = y1 - y0, e = u * 0.05;
  const wp = o.wallPart ?? (S.era === 'new' ? GLASS : WALL), wc = o.wallCol ?? S.wall;
  const grounded = o.ground !== false;
  const out = { cx, cz, w, d, y: y1, ex: 0, flat: true };

  if (S.era === 'old') {
    const bh = grounded ? Math.min(H * 0.07, u * 0.2) : 0;   // projecting base course
    const ch = Math.min(u * 0.12, H * 0.07), ce = e * 1.4;   // cornice
    if (bh > 0) M.box(x0 - e, x1 + e, y0, y0 + bh, z0 - e, z1 + e, [POD, S.base], [TRIM, S.trim]);
    M.box(x0, x1, y0 + bh, y1 - ch, z0, z1, [wp, wc], null, ['top']);
    if (H > u * 1.1) { // string course
      const ys = y0 + bh + (H - bh) * 0.55, sh = ch * 0.3;
      M.box(x0 - e * 0.6, x1 + e * 0.6, ys, ys + sh, z0 - e * 0.6, z1 + e * 0.6, [TRIM, S.trim], [TRIM, S.trim]);
    }
    const q = e * 1.6; // corner quoins read as masonry at 16px
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const qx = sx < 0 ? x0 - e * 0.5 : x1 + e * 0.5, qz = sz < 0 ? z0 - e * 0.5 : z1 + e * 0.5;
      M.box(Math.min(qx, qx - sx * q), Math.max(qx, qx - sx * q), y0 + bh, y1 - ch,
        Math.min(qz, qz - sz * q), Math.max(qz, qz - sz * q), [TRIM, S.trim], null, ['top']);
    }
    M.box(x0 - e * 0.7, x1 + e * 0.7, y1 - ch, y1 - ch * 0.45, z0 - e * 0.7, z1 + e * 0.7, [TRIM, S.trim], null, ['top']);
    M.box(x0 - ce, x1 + ce, y1 - ch * 0.45, y1, z0 - ce, z1 + ce, [TRIM, S.trim], [ROOF, S.flat]);
    out.ex = ce;
  } else if (S.era === 'mid') {
    const gh = grounded ? Math.min(H * 0.12, u * 0.35) : 0;
    const gH = clamp(u * 0.5, H / 8, H / 3), bandH = gH * 0.17, lip = bandH * 1.5;
    const nb = Math.max(0, Math.floor((H - gh) / gH));
    if (gh > 0) M.box(x0 - e * 0.5, x1 + e * 0.5, y0, y0 + gh, z0 - e * 0.5, z1 + e * 0.5, [POD, S.ground], [TRIM, S.trim]);
    M.box(x0, x1, y0 + gh, y1 - lip, z0, z1, [wp, wc], null, ['top']);
    for (let k = 1; k < nb; k++) { // strong horizontal band per floor group
      const y = y0 + gh + k * (H - gh) / nb;
      M.box(x0 - e, x1 + e, y - bandH / 2, y + bandH / 2, z0 - e, z1 + e, [TRIM, S.trim], [TRIM, S.trim]);
    }
    M.box(x0 - e, x1 + e, y1 - lip, y1, z0 - e, z1 + e, [TRIM, S.trim], [ROOF, S.flat]);
    out.ex = e;
  } else {
    const gh = grounded ? Math.min(H * 0.1, u * 0.3) : 0;
    const style = o.top || 'flat';
    const zone = Math.min(H * 0.08, u * 0.35);
    const yb = style === 'chamfer' ? y1 - zone : style === 'slant' ? y1 - zone : y1;
    if (gh > 0) M.box(x0 - e * 0.4, x1 + e * 0.4, y0, y0 + gh, z0 - e * 0.4, z1 + e * 0.4, [POD, S.ground], [TRIM, S.trim]);
    if (style === 'chamfer') {
      M.box(x0, x1, y0 + gh, yb, z0, z1, [wp, wc], null, ['top']);
      M.taper(cx, cz, w, d, w * 0.68, d * 0.68, yb, y1, [wp, wc], [ROOF, S.flat]);
      out.w = w * 0.68; out.d = d * 0.68;
    } else if (style === 'slant') {
      M.box(x0, x1, y0 + gh, yb, z0, z1, [wp, wc], null, ['top']);
      const lo = yb + zone * 0.2, alongX = S.rng() < 0.5;
      // high side at the back so the sloped top faces the camera
      M.boxH(x0, x1, z0, z1, yb, alongX ? [y1, lo, y1, lo] : [y1, y1, lo, lo], [wp, wc], [ROOF, S.flat]);
      out.flat = false;
    } else {
      M.box(x0, x1, y0 + gh, y1, z0, z1, [wp, wc], [ROOF, S.flat]);
    }
    if (o.fins !== false) {
      const fw = Math.max(u * 0.03, 1e-4), fp = e * 0.8, fy0 = y0 + gh, fy1 = yb;
      const cnt = span => clamp(Math.round(span / (u * 0.4)) - 1, 0, 3);
      const nzx = cnt(w), nzz = cnt(d);
      for (let i = 0; i < nzx + 2; i++) { // z-facing fins, corners included
        const t = i / (nzx + 1), x = x0 + fw / 2 + (w - fw) * t;
        M.box(x - fw / 2, x + fw / 2, fy0, fy1, z1, z1 + fp, [TRIM, S.trim], null, ['nz', 'top']);
        M.box(x - fw / 2, x + fw / 2, fy0, fy1, z0 - fp, z0, [TRIM, S.trim], null, ['pz', 'top']);
      }
      for (let i = 1; i <= nzz; i++) { // x-facing fins, inner only
        const z = z0 + d * i / (nzz + 1);
        M.box(x1, x1 + fp, fy0, fy1, z - fw / 2, z + fw / 2, [TRIM, S.trim], null, ['nx', 'top']);
        M.box(x0 - fp, x0, fy0, fy1, z - fw / 2, z + fw / 2, [TRIM, S.trim], null, ['px', 'top']);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ roofs
// Roof height budget (taken out of the total h so forms stay within spec.h).
function planRoof(type, w, d, h, cap) {
  const u = Math.min(w, d);
  switch (type) {
    case 'gable': case 'hip': return Math.min(u * 0.5, h * cap);
    case 'mansard': return Math.min(u * 0.3, h * cap * 0.7);
    case 'spire': return Math.min(u * 1.5, h * cap);
    case 'dome': return Math.min(u * 0.52, h * cap);
    default: return 0;
  }
}

// Gable with ridge along x (or z via the swap trick). Eaves overhang by ov and
// keep the slope, so they dip slightly below the wall top like real eaves.
function gable(M, cx, cz, W, D, y0, rise, ov, axis, roofC, endPart, endC) {
  if (axis === 'z') { M.swap = true; gable(M, cz, cx, D, W, y0, rise, ov, 'x', roofC, endPart, endC); M.swap = false; return; }
  const x0 = cx - W / 2, x1 = cx + W / 2, zf = cz + D / 2, zb = cz - D / 2;
  const yr = y0 + rise, yE = y0 - rise * ov / (D / 2);
  M.quad([x0, yE, zf + ov], [x1, yE, zf + ov], [x1, yr, cz], [x0, yr, cz], ROOF, roofC);
  M.quad([x1, yE, zb - ov], [x0, yE, zb - ov], [x0, yr, cz], [x1, yr, cz], ROOF, roofC);
  M.tri([x1, y0, zf], [x1, y0, zb], [x1, yr, cz], endPart, endC);
  M.tri([x0, y0, zb], [x0, y0, zf], [x0, yr, cz], endPart, endC);
}

function roofOn(M, S, r, type, rise, axis) {
  const W = r.w + 2 * r.ex, D = r.d + 2 * r.ex, u = Math.min(W, D), y0 = r.y, cx = r.cx, cz = r.cz;
  const T = { cx, cz, w: r.w, d: r.d, y: y0, flat: r.flat };
  if (type === 'flat' || rise <= 0) return T;
  T.flat = false; T.y = y0 + rise; T.w = T.d = u * 0.2;
  if (type === 'gable') {
    const ax = axis || (W >= D ? 'x' : 'z');
    gable(M, cx, cz, W, D, y0, rise, u * 0.04, ax, S.pitch, S.era === 'new' ? TRIM : WALL, S.era === 'new' ? S.trim : S.wall);
  } else if (type === 'hip') {
    const i = u / 2;
    M.taper(cx, cz, W + u * 0.06, D + u * 0.06, Math.max(W - 2 * i, 0), Math.max(D - 2 * i, 0), y0, y0 + rise, [ROOF, S.pitch]);
  } else if (type === 'mansard') {
    const i1 = u * 0.14, i2 = u * 0.25, ya = y0 + rise * 0.74, yb = y0 + rise;
    M.taper(cx, cz, W, D, W - 2 * i1, D - 2 * i1, y0, ya, [ROOF, S.slate]);
    M.taper(cx, cz, W - 2 * i1, D - 2 * i1, W - 2 * i2, D - 2 * i2, ya, yb, [ROOF, S.pitch], [ROOF, S.flat]);
    T.flat = true; T.w = W - 2 * i2; T.d = D - 2 * i2;
  } else if (type === 'spire') {
    // two-stage broach spire: fat skirt, then a slender needle
    const ya = y0 + rise * 0.34;
    M.taper(cx, cz, W * 0.96, D * 0.96, W * 0.4, D * 0.4, y0, ya, [ROOF, S.spireC]);
    M.taper(cx, cz, W * 0.4, D * 0.4, 0, 0, ya, y0 + rise, [ROOF, S.spireC]);
  } else if (type === 'dome') {
    const R = u * 0.44, dh = rise * 0.28, domeH = rise - dh, n = 10;
    M.loft(cx, cz, [[y0, R * 0.96, R * 0.96], [y0 + dh, R * 0.96, R * 0.96]], n, [TRIM, S.trim], { cap: [TRIM, S.trim] });
    const rings = [[y0 + dh, R, R]];
    for (const a of [26, 50, 72]) rings.push([y0 + dh + Math.sin(a * Math.PI / 180) * domeH, R * Math.cos(a * Math.PI / 180), R * Math.cos(a * Math.PI / 180)]);
    rings.push([y0 + rise, 0, 0]);
    M.loft(cx, cz, rings, n, [ROOF, S.domeC]);
  }
  return T;
}

// New-era flat roofs become a slanted or chamfered crown; props that need a
// flat deck force the chamfer (inset flat top) instead.
const topFor = (S, rt) => (S.era !== 'new' || rt !== 'flat') ? 'flat' : (S.needsDeck ? 'chamfer' : (S.rng() < 0.55 ? 'slant' : 'chamfer'));

// ------------------------------------------------------------ props
function spireProp(M, S, x, y, z, Tu) {
  const H = clamp(S.h * 0.4, S.u * 1.2, S.u * 6), r = Math.max(Tu * 0.07, S.u * 0.03), c = r * 1.7;
  M.box(x - c, x + c, y, y + c * 0.8, z - c, z + c, [TRIM, S.alu], [TRIM, S.alu]);
  const y1 = y + c * 0.8;
  M.loft(x, z, [[y1, r * SQ, r * SQ], [y1 + H * 0.55, r * 0.5 * SQ, r * 0.5 * SQ]], 4, [TRIM, S.alu], { rot: Math.PI / 4 });
  M.loft(x, z, [[y1 + H * 0.55, r * 0.5 * SQ, r * 0.5 * SQ], [y1 + H, 0, 0]], 4, [ACC, S.accent], { rot: Math.PI / 4 });
}

function antennaProp(M, S, x, y, z, Tu) {
  const H = clamp(S.h * 0.26, S.u * 0.9, S.u * 4), t = Math.max(Tu * 0.045, S.u * 0.02);
  M.box(x - t * 1.6, x + t * 1.6, y, y + t * 2, z - t * 1.6, z + t * 1.6, [TRIM, S.steel], [TRIM, S.steel]);
  M.box(x - t / 2, x + t / 2, y + t * 2, y + H, z - t / 2, z + t / 2, [TRIM, S.alu], [TRIM, S.alu]);
  for (const f of [0.62, 0.82]) { // cross bars
    const yy = y + H * f, L = Tu * (1.1 - f) * 0.35 + t * 2;
    M.box(x - L, x + L, yy, yy + t * 0.7, z - t * 0.35, z + t * 0.35, [TRIM, S.alu], [TRIM, S.alu]);
  }
  M.box(x - t * 0.7, x + t * 0.7, y + H, y + H + t * 1.6, z - t * 0.7, z + t * 0.7, [ACC, S.accent], [ACC, S.accent]);
}

function tankProp(M, S, x, y, z, Tu) {
  const r = Tu * 0.19, lh = r * 1.0, bh = r * 1.5, lg = r * 0.14;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const lx = x + sx * r * 0.68, lz = z + sz * r * 0.68;
    M.box(lx - lg, lx + lg, y, y + lh, lz - lg, lz + lg, [TRIM, S.steel], null, ['top']);
  }
  const wood = S.P.roof[1];
  M.loft(x, z, [[y + lh, r, r], [y + lh + bh, r, r]], 8, [TRIM, rgb(wood)], { rot: Math.PI / 8 });
  M.loft(x, z, [[y + lh + bh, r * 1.08, r * 1.08], [y + lh + bh + r * 0.6, 0, 0]], 8, [ROOF, S.slate], { rot: Math.PI / 8 });
}

function acProp(M, S, x, y, z, Tu) {
  const s = Tu * 0.14;
  const items = [[-0.9, -0.4, 1, 0.7], [0.8, 0.1, 1.3, 0.55], [-0.1, 0.9, 0.8, 0.95]];
  for (const [ox, oz, k, hk] of items) {
    const cx = x + ox * s * 1.4, cz = z + oz * s * 1.4, hw = s * k * 0.5;
    M.box(cx - hw, cx + hw, y, y + s * hk, cz - hw, cz + hw, [TRIM, S.metal], [TRIM, S.alu], null);
  }
}

function craneProp(M, S, x, y, z) {
  const t = S.u * 0.06, Hm = Math.max(S.u * 0.75, S.h * 0.2), Lj = S.u * 1.1;
  const dirx = S.rng() < 0.5, sg = S.rng() < 0.5 ? 1 : -1;
  const dv = dirx ? [sg, 0, 0] : [0, 0, sg];
  const at = (k, yy) => [x + dv[0] * k, yy, z + dv[2] * k];
  const Y = S.accent[0] > 0.8 && S.accent[1] > 0.6 ? S.accent : rgb(S.P.accent[0]); // crane is always signal yellow
  M.box(x - t * 1.5, x + t * 1.5, y, y + t, z - t * 1.5, z + t * 1.5, [POD, S.base], [TRIM, S.trim]);
  const ym = y + Hm, yj = ym + t * 0.8;
  M.strut([x, y + t, z], [x, ym, z], t, ACC, Y);                                   // mast
  M.box(x - t, x + t, ym - t * 0.2, ym + t * 1.4, z - t, z + t, [ACC, Y], [ACC, Y]); // slewing cab
  M.strut(at(-Lj * 0.3, yj), at(Lj, yj), t * 0.7, ACC, Y, true);                          // jib + counter-jib
  const cw = at(-Lj * 0.3, yj - t * 0.9), c2 = t * 0.9;
  M.box(cw[0] - c2, cw[0] + c2, cw[1] - t * 0.4, cw[1] + t * 1.2, cw[2] - c2, cw[2] + c2, [TRIM, S.base], [TRIM, S.trim]);
  const apex = [x, yj + Hm * 0.24, z];
  M.strut([x, yj, z], apex, t * 0.6, ACC, Y);                                       // A-frame
  M.strut(apex, at(Lj, yj), t * 0.2, TRIM, S.steel);                                 // tie lines
  M.strut(apex, at(-Lj * 0.3, yj), t * 0.2, TRIM, S.steel);
  const hk = at(Lj * 0.72, yj), hy = yj - Hm * 0.32;                                 // hook + load
  M.strut(hk, [hk[0], hy, hk[2]], t * 0.16, TRIM, S.steel);
  M.box(hk[0] - t * 0.7, hk[0] + t * 0.7, hy - t * 1.2, hy, hk[2] - t * 0.7, hk[2] + t * 0.7, [ACC, rgb(S.P.accent[1])], [ACC, rgb(S.P.accent[1])]);
}

function addProps(M, S, T) {
  const p = S.props, Tu = T.flat ? Math.min(T.w, T.d) : S.u * 0.5;
  const rot = Math.floor(S.rng() * 4), quads = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
  let si = rot;
  const slot = () => { const [sx, sz] = quads[si++ % 4]; return [T.cx + sx * T.w * 0.25, T.cz + sz * T.d * 0.25]; };
  if (S.era === 'mid' && T.flat && S.form !== 'frame' && S.form !== 'shed') { // rooftop bulkhead
    const [bx, bz] = slot(), bw = T.w * 0.26, bd = T.d * 0.26, bh = Math.min(S.h * 0.05, Tu * 0.2);
    M.box(bx - bw / 2, bx + bw / 2, T.y, T.y + bh, bz - bd / 2, bz + bd / 2, [WALL, S.wall], [ROOF, S.flat]);
  }
  if (p.spire) spireProp(M, S, T.cx, T.y, T.cz, Tu);
  if (p.antenna) { const [x, z] = T.flat ? slot() : [T.cx, T.cz]; antennaProp(M, S, p.spire && !T.flat ? T.cx + Tu * 0.2 : x, T.y, z, Tu); }
  if (p.crane) {
    if (T.flat) { const [x, z] = S.form === 'frame' ? [T.cx + T.w / 2 * S.cs[0] * 0.9, T.cz + T.d / 2 * S.cs[1] * 0.9] : slot(); craneProp(M, S, x, T.y, z); }
    else craneProp(M, S, S.w / 2 + S.u * 0.06, 0, S.d / 2 + S.u * 0.06);
  }
  if (T.flat) {
    if (p.tank) { const [x, z] = slot(); tankProp(M, S, x, T.y, z, Tu); }
    if (p.ac) { const [x, z] = slot(); acProp(M, S, x, T.y, z, Tu); }
  }
}

// ------------------------------------------------------------ forms
function buildSlab(M, S) {
  const rt = S.roof, rise = planRoof(rt, S.w, S.d, S.h, 0.25);
  const r = block(M, S, { cx: 0, cz: 0, w: S.w, d: S.d, y0: 0, y1: S.h - rise, top: topFor(S, rt) });
  return roofOn(M, S, r, rt, rise);
}

function buildTower(M, S) {
  // plinth + slender shaft + lantern crown: reads as "tower" even on slab-like input
  const { w, d, h, u } = S, rt = S.roof;
  const ph = Math.min(h * 0.1, u * 0.7), sw = w * 0.78, sd = d * 0.78, cw = w * 0.46, cd = d * 0.46;
  const lh = Math.min(h * 0.05, u * 0.45), rise = planRoof(rt, cw, cd, h, 0.26);
  const sh = h - lh - rise;
  block(M, S, { cx: 0, cz: 0, w, d, y0: 0, y1: ph, top: 'flat' });
  block(M, S, { cx: 0, cz: 0, w: sw, d: sd, y0: ph, y1: sh, ground: false, top: 'flat' });
  const r = block(M, S, { cx: 0, cz: 0, w: cw, d: cd, y0: sh, y1: sh + lh, ground: false, top: topFor(S, rt) });
  return roofOn(M, S, r, rt, rise);
}

function buildSetback(M, S) {
  const n = clamp(Math.round(S.spec.tiers || 3), 2, 4), rt = S.roof;
  const k = (0.62 / n) * (0.9 + S.rng() * 0.2);
  const sc = Array.from({ length: n }, (_, i) => Math.max(1 - i * k, 0.28));
  const wts = [1, 0.8, 0.66, 0.56].slice(0, n), ws = wts.reduce((a, b) => a + b, 0);
  const tw = S.w * sc[n - 1], td = S.d * sc[n - 1];
  const rise = planRoof(rt, tw, td, S.h, 0.24), avail = S.h - rise;
  let y = 0, r;
  for (let i = 0; i < n; i++) {
    const hi = avail * wts[i] / ws;
    r = block(M, S, { cx: 0, cz: 0, w: S.w * sc[i], d: S.d * sc[i], y0: y, y1: y + hi, ground: i === 0, top: i === n - 1 ? topFor(S, rt) : 'flat' });
    y += hi;
  }
  return roofOn(M, S, r, rt, rise);
}

function buildPodium(M, S) {
  const { w, d, h, u } = S, rt = S.roof;
  const ph = Math.min(h * 0.26, u * 0.55);
  const fw = w * (0.5 + S.rng() * 0.15), fd = d * (0.5 + S.rng() * 0.15);
  const ox = (S.rng() - 0.5) * (w - fw) * 0.8, oz = -S.rng() * (d - fd) * 0.45;
  block(M, S, { cx: 0, cz: 0, w, d, y0: 0, y1: ph, wallPart: POD, wallCol: S.era === 'new' ? S.base : S.era === 'old' ? S.base : S.ground, top: 'flat', fins: false });
  // entrance canopy, the one splash of accent colour at street level
  const cw = w * 0.3, cx = clamp(ox * 0.5, -w * 0.2, w * 0.2);
  M.box(cx - cw / 2, cx + cw / 2, ph * 0.5, ph * 0.58, d / 2, d / 2 + u * 0.1, [ACC, S.accent], [ACC, S.accent]);
  const rise = planRoof(rt, fw, fd, h - ph, 0.26);
  const r = block(M, S, { cx: ox, cz: oz, w: fw, d: fd, y0: ph, y1: h - rise, ground: false, top: topFor(S, rt) });
  return roofOn(M, S, r, rt, rise);
}

function buildHouse(M, S) {
  const { w, d, h, u } = S, rt = S.roof, e = u * 0.04;
  const rise = rt === 'flat' ? 0 : planRoof(rt, w, d, h, 0.5);
  const mono = S.era === 'new' && rt === 'flat', sl = mono ? Math.min(h * 0.22, u * 0.3) : 0;
  const wallH = h - rise - sl, ph = Math.min(wallH * 0.13, u * 0.15);
  const wallC = S.era === 'new' ? S.solid : S.wall;
  M.box(-w / 2 - e, w / 2 + e, 0, ph, -d / 2 - e, d / 2 + e, [POD, S.base], [TRIM, S.trim]);
  M.box(-w / 2, w / 2, ph, wallH, -d / 2, d / 2, [WALL, wallC], null, ['top']);
  let r = { cx: 0, cz: 0, w, d, y: wallH, ex: e * 1.6, flat: true };
  if (rt === 'flat') {
    if (mono) { // monopitch roof, high at the back
      M.boxH(-w / 2, w / 2, -d / 2, d / 2, wallH, [wallH + sl, wallH + sl, wallH + sl * 0.2, wallH + sl * 0.2], [WALL, wallC], [ROOF, S.flat]);
      r.flat = false;
    } else {
      M.box(-w / 2 - e, w / 2 + e, wallH, wallH + e, -d / 2 - e, d / 2 + e, [TRIM, S.trim], [ROOF, S.flat]);
      r.y = wallH + e; r.ex = e;
    }
  }
  // door + little porch roof on the +z face
  const dx = (S.rng() < 0.5 ? -1 : 1) * w * 0.2, dw = Math.min(w * 0.2, u * 0.2), dh = Math.min(wallH * 0.62, u * 0.4);
  M.box(dx - dw / 2, dx + dw / 2, ph, ph + dh, d / 2, d / 2 + e * 0.6, [TRIM, rgb(S.P.accent[1])], [TRIM, S.trim]);
  M.box(dx - dw * 0.8, dx + dw * 0.8, ph + dh, ph + dh + e * 0.8, d / 2, d / 2 + e * 3, [TRIM, S.trim], [TRIM, S.trim]);
  if (S.era === 'new') M.box(-dx - w * 0.17, -dx + w * 0.17, wallH * 0.22, wallH * 0.82, d / 2, d / 2 + e * 0.5, [GLASS, rgb(S.P.glass[0])], null, ['top']);
  const T = roofOn(M, S, r, rt, rise);
  if (rt === 'gable') { // brick chimney sitting on the ridge
    const ax = w >= d ? 'x' : 'z', cs = u * 0.1, off = (S.rng() < 0.5 ? -1 : 1) * (ax === 'x' ? w : d) * 0.27;
    const cx = ax === 'x' ? off : 0, cz = ax === 'x' ? 0 : off, br = rgb(S.P.brick[1]);
    M.box(cx - cs, cx + cs, wallH + rise * 0.5, wallH + rise + cs * 1.7, cz - cs, cz + cs, [WALL, br], [TRIM, S.trim]);
  }
  return T;
}

function buildShed(M, S) {
  const { w, d, h, u } = S, rt = S.spec.roof;
  const alongX = w >= d, L = alongX ? w : d, W = alongX ? d : w; // teeth stack along the long side
  const saw = !(rt === 'flat' || rt === 'gable');
  let n = clamp(Math.round(L / Math.max(h * 1.05, L / 7)), 2, 8);
  const pitch = L / n, rise = saw ? Math.min(h * 0.4, pitch * 0.62) : (rt === 'gable' ? planRoof('gable', w, d, h, 0.4) : 0);
  const wallH = h - rise, e = u * 0.04;
  const low = S.era === 'old' ? S.base : S.era === 'mid' ? S.ground : rgb(S.P.glass[2]);
  const up = S.era === 'new' ? rgb(S.P.metal[2]) : S.wall;
  const lh = wallH * 0.32;
  M.box(-w / 2 - e * 0.5, w / 2 + e * 0.5, 0, lh, -d / 2 - e * 0.5, d / 2 + e * 0.5, [POD, low], [TRIM, S.trim]);
  M.box(-w / 2, w / 2, lh, wallH, -d / 2, d / 2, [WALL, up], saw ? null : [ROOF, S.flat], saw ? ['top'] : []);
  // roller doors
  const dk = S.dark;
  const dw = Math.min(W * 0.3, wallH * 1.3), dxs = (S.rng() < 0.5 ? -1 : 1) * w * 0.18;
  M.box(dxs - dw / 2, dxs + dw / 2, 0, wallH * 0.62, d / 2, d / 2 + e * 0.5, [TRIM, dk], [TRIM, dk]);
  M.box(w / 2, w / 2 + e * 0.5, 0, wallH * 0.55, -dw / 2 * 0.8, dw / 2 * 0.8, [TRIM, dk], [TRIM, dk]);
  let T = { cx: 0, cz: 0, w, d, y: wallH, flat: !saw && rt !== 'gable' };
  if (saw) {
    const glass = rgb(S.P.glass[0]), roofC = S.era === 'old' ? S.pitch : S.era === 'mid' ? S.slate : S.pitch;
    M.swap = !alongX; // build with teeth along local z, then mirror if the long side is x
    const half = W / 2, y0 = wallH;
    for (let i = 0; i < n; i++) {
      const zb = -L / 2 + i * pitch, zf = zb + pitch, ym = y0 + rise * 0.62, zm = zf - pitch * 0.62;
      M.quad([-half, y0, zf], [half, y0, zf], [half, ym, zm], [-half, ym, zm], ROOF, roofC);
      M.quad([-half, ym, zm], [half, ym, zm], [half, y0 + rise, zb], [-half, y0 + rise, zb], GLASS, glass); // north-light strip
      M.quad([half, y0, zb], [-half, y0, zb], [-half, y0 + rise, zb], [half, y0 + rise, zb], WALL, up);
      M.tri([half, y0, zf], [half, y0, zb], [half, y0 + rise, zb], WALL, up);
      M.tri([-half, y0, zb], [-half, y0, zf], [-half, y0 + rise, zb], WALL, up);
    }
    M.swap = false;
    T = { cx: 0, cz: 0, w: 0, d: 0, y: wallH + rise, flat: false };
  } else if (rt === 'gable') {
    T = roofOn(M, S, { cx: 0, cz: 0, w, d, y: wallH, ex: e, flat: true }, 'gable', rise);
  }
  // stub chimney: factories always have one
  const cr = u * 0.06, cxs = -w * 0.34 * (S.rng() < 0.5 ? -1 : 1), czs = -d * 0.3, ch = Math.min(h * 0.5, u * 0.7);
  M.loft(cxs, czs, [[wallH * 0.9, cr * 1.2, cr * 1.2], [wallH + ch, cr * 0.9, cr * 0.9]], 6, [TRIM, S.steel], { cap: [TRIM, S.dark] });
  return T;
}

function buildPlant(M, S) {
  const { w, d, h, u } = S, rt = S.roof;
  const cooling = S.rng() < 0.42, towers = d > w * 0.9 && S.rng() < 0.5 ? 2 : 1;
  const bh = h * 0.36, e = u * 0.05;
  const R = Math.min(w * 0.24, d * (towers === 2 ? 0.24 : 0.4));
  const bw = cooling ? w - R * 2.1 : w, bcx = cooling ? -w / 2 + bw / 2 : 0;
  const rise = planRoof(rt, bw, d, bh, 0.5);
  const r = block(M, S, { cx: bcx, cz: 0, w: bw, d, y0: 0, y1: bh - rise, top: 'flat', wallPart: WALL, wallCol: S.era === 'new' ? S.solid : S.wall, fins: false });
  const T = roofOn(M, S, r, rt, rise);
  const conc = S.era === 'old' ? S.P.stone[2] : S.era === 'mid' ? S.P.concrete[0] : S.P.concrete[3];
  const concC = rgb(conc), red = rgb(S.P.accent[1]), white = S.white;
  if (cooling) {
    const prof = [[0, 1], [0.22, 0.9], [0.45, 0.78], [0.68, 0.7], [0.85, 0.73], [1, 0.8]];
    for (let t = 0; t < towers; t++) {
      const cx = w / 2 - R, cz = towers === 2 ? (t ? d / 2 - R : -d / 2 + R) : -d / 2 + R + (d - 2 * R) * 0.2;
      const Ht = h * (t ? 0.62 : 0.76);
      M.loft(cx, cz, prof.map(([f, k]) => [Ht * f, R * k, R * k]), 10, [TRIM, concC], { cap: [TRIM, S.dark] });
      M.loft(cx, cz, [[Ht, R * 0.8, R * 0.8], [Ht + R * 0.06, R * 0.84, R * 0.84]], 10, [TRIM, S.steel]);
      // steam: three stacked puffs reading as one plume
      let py = Ht + R * 0.1;
      for (const [k, dx] of [[0.6, 0], [0.52, 0.18], [0.38, 0.3]]) {
        const pr = R * k;
        M.loft(cx + dx * R, cz - dx * R * 0.4, [[py, pr * 0.8, pr * 0.8], [py + pr * 0.55, pr, pr], [py + pr * 1.1, pr * 0.6, pr * 0.6]], 6, [ACC, white], { cap: [ACC, white] });
        py += pr * 0.85;
      }
    }
    // boiler house beside the tower
    M.box(w / 2 - R * 2.1, w / 2 - R * 0.1, 0, bh * 0.55, d * 0.1 - R * 0.35, d * 0.1 + R * 0.9, [WALL, S.solid], [ROOF, S.flat]);
  } else {
    const cnt = 1 + Math.floor(S.rng() * 3), sr = Math.min(u * 0.08, bw / (cnt * 3.2));
    for (let i = 0; i < cnt; i++) {
      const x = bcx - bw / 2 + bw * (i + 0.6) / (cnt + 0.2), z = -d / 2 + sr * 2;
      const y0 = T.flat ? T.y : bh, Hs = (h - y0) * (i === 0 ? 1 : 0.82 - i * 0.04);
      const seg = (a, b, ra, rb, part, c) => M.loft(x, z, [[y0 + Hs * a, sr * ra, sr * ra], [y0 + Hs * b, sr * rb, sr * rb]], 6, [part, c]);
      M.loft(x, z, [[y0, sr * 1.5, sr * 1.5], [y0 + Hs * 0.08, sr * 1.3, sr * 1.3]], 6, [TRIM, S.trim]);
      seg(0.08, 0.66, 1.15, 0.82, TRIM, concC);
      seg(0.66, 0.78, 0.82, 0.78, ACC, red);
      seg(0.78, 0.88, 0.78, 0.74, ACC, white);
      seg(0.88, 0.98, 0.74, 0.7, ACC, red);
      M.loft(x, z, [[y0 + Hs * 0.98, sr * 0.86, sr * 0.86], [y0 + Hs, sr * 0.86, sr * 0.86]], 6, [TRIM, S.dark], { cap: [TRIM, S.dark] });
    }
  }
  return { ...T, flat: false };
}

function buildHall(M, S) {
  const { w, d, h, u } = S, rt = S.roof, era = S.era;
  const st = Math.min(h * 0.06, u * 0.08), ins = u * 0.03;
  M.box(-w / 2, w / 2, 0, st, -d / 2, d / 2, [POD, S.base], [TRIM, S.trim]);
  M.box(-w / 2 + ins, w / 2 - ins, st, st * 2, -d / 2 + ins, d / 2 - ins, [POD, S.base], [TRIM, S.trim]);
  const y0 = st * 2, back = -d / 2 + ins * 2, front = d / 2 - ins * 2;
  const bw = w * 0.92, bd = d * 0.72, bcz = back + bd / 2, zf = back + bd;
  const rise = planRoof(rt, bw, bd, h, 0.3), top = h - rise, bH = top - y0;
  const r = block(M, S, { cx: 0, cz: bcz, w: bw, d: bd, y0, y1: top, ground: false, top: topFor(S, rt) });
  const pw = w * 0.5, yc = y0 + bH * 0.76, et = bH * 0.12;
  const n = clamp(Math.round(pw / (bH * 0.5)) + 1, 4, 8), colH = yc - y0;
  const cr = Math.min(pw / (n * 2.6), colH * 0.08), zc = front - cr * 1.6;
  const xs = Array.from({ length: n }, (_, i) => -pw / 2 + cr + (pw - 2 * cr) * i / (n - 1));
  if (era === 'old') {
    for (const x of xs) M.loft(x, zc, [[y0, cr * 1.15, cr * 1.15], [yc, cr * 0.9, cr * 0.9]], 6, [TRIM, S.trim]);
    const ew = pw + cr * 4, ez0 = zf, ez1 = front;
    M.box(-ew / 2, ew / 2, yc, yc + et, ez0, ez1, [TRIM, S.trim], [TRIM, S.trim]);
    const prise = Math.min(ew * 0.14, bH * 0.16);
    gable(M, 0, (ez0 + ez1) / 2, ew, ez1 - ez0, yc + et, prise, 0, 'z', S.pitch, TRIM, S.trim);
  } else if (era === 'mid') {
    for (const x of xs) M.box(x - cr, x + cr, y0, yc, zc - cr, zc + cr, [TRIM, S.trim], null, ['top']);
    M.box(-pw / 2 - cr * 3, pw / 2 + cr * 3, yc, yc + et * 0.8, zf, front + cr * 2, [TRIM, S.trim], [ROOF, S.flat]);
  } else {
    const nn = Math.max(3, n - 2);
    for (let i = 0; i < nn; i++) {
      const x = -pw / 2 + cr + (pw - 2 * cr) * i / (nn - 1);
      M.box(x - cr * 0.6, x + cr * 0.6, y0, yc, zc - cr * 0.6, zc + cr * 0.6, [TRIM, S.steel], null, ['top']);
    }
    const lift = et * 1.4, xx0 = -pw / 2 - cr * 3, xx1 = pw / 2 + cr * 3, zz0 = zf, zz1 = front + cr * 2;
    M.boxH(xx0, xx1, zz0, zz1, yc, [yc + et + lift, yc + et + lift, yc + et * 0.6, yc + et * 0.6], [TRIM, S.trim], [GLASS, rgb(S.P.glass[3])]);
  }
  return roofOn(M, S, r, rt, rise, 'x');
}

function buildFrame(M, S) {
  const { w, d, h, u } = S;
  const nf = clamp(Math.round(h / (u * 0.38)), 2, 8), fh = h / nf, sth = fh * 0.13;
  const built = Math.max(1, nf - 1 - (S.rng() < 0.5 ? 1 : 0));
  const nx = clamp(Math.round(w / (u * 0.45)) + 1, 2, 4), nz = clamp(Math.round(d / (u * 0.45)) + 1, 2, 4);
  const cw = Math.max(u * 0.065, 1e-4), bw = cw * 0.9;
  const col = S.era === 'old' ? S.P.brick[1] : S.era === 'mid' ? S.P.metal[1] : S.P.glass[2];
  const slabC = S.era === 'old' ? S.P.stone[2] : S.era === 'mid' ? S.P.concrete[0] : S.P.metal[2];
  const colC = rgb(col), slabCc = rgb(slabC);
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  M.box(x0 - cw, x1 + cw, 0, sth * 0.9, z0 - cw, z1 + cw, [POD, S.ground], [TRIM, S.trim]); // foundation plate
  for (let k = 1; k <= built; k++) {
    const y = k * fh - sth;
    M.box(x0, x1, y, y + sth, z1 - bw, z1, [TRIM, slabCc], [TRIM, slabCc], ['nx', 'px', 'nz']);
    M.box(x0, x1, y, y + sth, z0, z0 + bw, [TRIM, slabCc], [TRIM, slabCc], ['nx', 'px', 'pz']);
    M.box(x1 - bw, x1, y, y + sth, z0 + bw, z1 - bw, [TRIM, slabCc], [TRIM, slabCc], ['nz', 'pz', 'nx']);
    M.box(x0, x0 + bw, y, y + sth, z0 + bw, z1 - bw, [TRIM, slabCc], [TRIM, slabCc], ['nz', 'pz', 'px']);
  }
  const pos = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    if (i && i < nx - 1 && j && j < nz - 1) continue; // perimeter columns only
    pos.push([x0 + cw / 2 + (w - cw) * i / (nx - 1), z0 + cw / 2 + (d - cw) * j / (nz - 1), (i === 0 || i === nx - 1) && (j === 0 || j === nz - 1)]);
  }
  for (const [x, z, corner] of pos) {
    const top = corner ? h : h - fh * (S.rng() < 0.5 ? 0 : 1) - (S.rng() * 0.3) * fh * 0;
    M.box(x - cw / 2, x + cw / 2, sth * 0.9, top, z - cw / 2, z + cw / 2, [TRIM, colC], [TRIM, colC]);
  }
  // one diagonal brace per visible face in the bottom bay: steelwork, not walls
  const bx = (w - cw) / (nx - 1), bz = (d - cw) / (nz - 1);
  M.strut([x0 + cw, sth, z1 - cw / 2], [x0 + bx, fh - sth, z1 - cw / 2], cw * 0.45, ACC, S.accent);
  M.strut([x1 - cw / 2, sth, z1 - cw], [x1 - cw / 2, fh - sth, z1 - bz], cw * 0.45, ACC, S.accent);
  S.cs = [S.rng() < 0.5 ? -1 : 1, S.rng() < 0.5 ? -1 : 1];
  return { cx: 0, cz: 0, w: w - cw * 2, d: d - cw * 2, y: h, flat: true };
}

const BUILDERS = { slab: buildSlab, tower: buildTower, setback: buildSetback, podium: buildPodium, house: buildHouse, shed: buildShed, plant: buildPlant, hall: buildHall, frame: buildFrame };

const DEFAULT_ROOF = {
  slab:    { old: 'mansard', mid: 'flat', new: 'flat' },
  tower:   { old: 'hip', mid: 'flat', new: 'spire' },
  setback: { old: 'spire', mid: 'spire', new: 'flat' },
  podium:  { old: 'hip', mid: 'flat', new: 'flat' },
  house:   { old: 'gable', mid: 'gable', new: 'flat' },
  shed:    { old: 'flat', mid: 'flat', new: 'flat' },
  plant:   { old: 'flat', mid: 'flat', new: 'flat' },
  hall:    { old: 'dome', mid: 'flat', new: 'flat' },
  frame:   { old: 'flat', mid: 'flat', new: 'flat' },
};

// ------------------------------------------------------------ public API
export function buildingGeometry(spec = {}) {
  const form = BUILDERS[spec.form] ? spec.form : 'slab';
  const rng = mulberry32((spec.seed | 0) * 2654435761 + 12345);
  const S = makeStyle(spec, rng);
  const w = Math.max(+spec.w || 4, 1e-3), d = Math.max(+spec.d || 4, 1e-3), h = Math.max(+spec.h || 8, 1e-3);
  const props = spec.props || {};
  Object.assign(S, { spec, form, w, d, h, u: Math.min(w, d), props });
  // old slabs alternate between mansard and a flat cornice so a street isn't all roofs
  S.roof = ROOFS.includes(spec.roof) ? spec.roof : (form === 'slab' && S.era === 'old' && rng() < 0.5 ? 'flat' : DEFAULT_ROOF[form][S.era]);
  S.needsDeck = !!(props.tank || props.ac || props.crane);
  const M = new Builder();
  const T = BUILDERS[form](M, S);
  if (T) addProps(M, S, T);
  return M.geometry();
}
