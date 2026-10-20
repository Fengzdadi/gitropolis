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
  // vernacular (spec.style) additions
  corten:   ['#c0662c', '#8f4a26', '#5e3626', '#e0893a'], // weathering steel: orange, brown, heavily rusted, fresh bright
  raw:      ['#9a978d'],                         // board-marked concrete
  primary:  ['#3a5fa8'],                         // modernist blue / corporate blue
  pop:      ['#d9739a', '#7b5ea7'],              // postmodern pink, purple
  beige:    ['#d6c9a8', '#b3a583'],              // office-park beige, shadow beige
  ruby:     ['#a3303f', '#74222f', '#efe2bd'],   // Victorian red brick, dark brick, cream stone
  wood:     ['#b98b5a'],                         // plywood / timber additions
  tin:      ['#7f948f'],                         // corrugated sheet
};

export const BASE_FORMS = ['slab', 'tower', 'setback', 'podium', 'house', 'shed', 'plant', 'hall', 'frame'];
export const LANDMARKS = ['cityhall', 'courthouse', 'clocktower', 'port', 'airport', 'ruin', 'site', 'mega'];
export const INDUSTRY = ['containers', 'tanks', 'warehouse', 'lighthouse']; // the port city
export const CAMPUS = ['college', 'chapel', 'library']; // the university town
export const CAPITAL = ['pilotis', 'congress', 'cathedral']; // the planned capital
export const DESERT = ['supertall', 'needle']; // the desert boomtown
export const FARMSTEAD = ['barn', 'silo', 'windmill', 'bales']; // the farm village
export const FORMS = [...BASE_FORMS, ...LANDMARKS, ...INDUSTRY, ...CAMPUS, ...CAPITAL, ...DESERT, ...FARMSTEAD];
export const STYLES = ['rust', 'c', 'cpp', 'go', 'python', 'js', 'ts', 'java', 'ruby', 'php', 'shell', 'default'];
export const ERAS = ['old', 'mid', 'new'];
export const ROOFS = ['flat', 'gable', 'hip', 'mansard', 'spire', 'dome'];
// window: a pane laid on a wall (glass, but the city drops it when buildings are too small to show it)
export const PARTS = { wall: 0, roof: 1, trim: 2, glass: 3, accent: 4, podium: 5, window: 6 };
const WALL = 0, ROOF = 1, TRIM = 2, GLASS = 3, ACC = 4, POD = 5, WIN = 6;

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
  S.win = pick('glass', 2);                       // default window colour
  S.style = STYLES.includes(spec.style) ? spec.style : 'default';
  S.nb = 1;                                       // blocks in this building (styled detail thins out as it grows)
  if (S.style !== 'default') applyStyle(S, shade);
  return S;
}

// ------------------------------------------------------------ blocks
// Era-styled walls from y0 to y1, *including* its own top cap. Returns the
// usable top rect so roofs/props/upper tiers can sit on it.
//   o: cx cz w d y0 y1, ground (base storey), wallPart/wallCol, top, fins
function block(M, S, o) {
  if (S.style !== 'default') return styleBlock(M, S, o);
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

// ------------------------------------------------------------ vernacular (spec.style)
// Style = the regional language of a building: materials, roof preference and a
// couple of ornaments. It never changes the form; era still decides how old and
// weathered the materials are (each style defines an old / mid / new variant).
function applyStyle(S, shade) {
  const R = S.pick, o = S.era === 'old' ? 0 : S.era === 'mid' ? 1 : 2, by = (...a) => a[o];
  const set = (wall, trim, base, flat, pitch, slate) => {
    S.wall = shade(wall); S.trim = trim; S.base = base; S.ground = base; S.solid = S.wall;
    S.flat = flat; S.pitch = pitch; S.slate = slate;
  };
  S.win = S.dark;
  switch (S.style) {
    case 'rust':
      set(by(R('corten', 2), R('corten', 0), R('corten', 3)), by(R('metal', 1), R('metal', 1), S.dark),
        R('metal', 1), R('metal', 1), R('corten', 1), R('corten', 2));
      S.spireC = R('metal', 1); S.domeC = R('corten', 1); S.steel = R('metal', 1);
      break;
    case 'c': case 'cpp':
      set(by(R('concrete', 2), R('raw', 0), R('concrete', 1)), by(R('raw', 0), R('concrete', 0), R('concrete', 3)),
        R('concrete', 2), R('concrete', 1), R('concrete', 2), R('concrete', 2));
      S.spireC = S.domeC = R('concrete', 1);
      break;
    case 'go':
      set(by(R('concrete', 3), S.white, S.white), by(R('concrete', 2), R('concrete', 2), R('metal', 1)),
        R('concrete', 2), R('concrete', 0), R('metal', 1), R('metal', 1));
      S.accent = [R('accent', 1), R('accent', 0), R('primary', 0)][Math.floor(S.rng() * 3)]; // one primary colour
      S.win = by(R('glass', 2), R('glass', 2), R('glass', 1));
      S.spireC = S.domeC = R('metal', 1);
      break;
    case 'python':
      set(by(R('brick', 1), R('brick', 0), R('brick', 0)), S.white, by(R('stone', 2), R('stone', 2), R('concrete', 2)),
        R('concrete', 2), R('roof', 0), R('roof', 2));
      S.win = by(S.dark, R('glass', 2), R('glass', 2));
      break;
    case 'js': {
      const pools = [
        [R('brick', 2), R('roof', 3), R('accent', 0), R('stone', 0)],
        [R('pop', 0), R('accent', 0), R('roof', 3), R('accent', 1), R('pop', 1)],
        [R('pop', 0), R('glass', 0), R('accent', 0), R('pop', 1), R('roof', 3), S.white],
      ];
      S.pool = pools[o];
      const pk = () => S.pool[Math.floor(S.rng() * S.pool.length)];
      set(pk(), pk(), by(R('stone', 2), R('concrete', 2), R('metal', 1)), R('concrete', 1), pk(), R('roof', 2));
      S.js0 = 0; S.win = S.dark;
      break;
    }
    case 'ts':
      set(by(R('concrete', 2), R('glass', 1), R('glass', 0)), by(R('concrete', 1), R('metal', 2), S.white),
        R('metal', 1), R('metal', 0), R('metal', 1), R('metal', 1));
      S.win = R('glass', by(1, 1, 0)); S.spireC = R('glass', 2); S.domeC = R('glass', 3);
      break;
    case 'java':
      set(by(R('beige', 1), R('beige', 0), R('beige', 0)), by(R('stone', 2), R('beige', 1), R('concrete', 3)),
        R('beige', 1), R('concrete', 2), R('roof', 1), R('roof', 2));
      S.win = R('glass', by(2, 2, 1));
      break;
    case 'ruby':
      set(by(R('ruby', 1), R('ruby', 0), R('ruby', 0)), R('ruby', 2), by(R('stone', 1), R('ruby', 2), R('ruby', 2)),
        R('concrete', 2), R('roof', 2), R('roof', 2));
      S.spireC = R('roof', 2); S.domeC = R('roof', 3);
      break;
    case 'php': {
      S.pool = [R('wood'), R('tin'), R('beige', 0), S.white, R('pop', 0), R('green', 0), R('accent', 0)];
      set(by(R('wood'), R('beige', 0), R('tin')), R('stone', 0), R('stone', 2), R('metal', 0), R('roof', 1), R('roof', 2));
      break;
    }
    case 'shell':
      set(by(R('metal', 1), R('tin'), R('metal', 2)), by(R('metal', 0), R('metal', 2), S.white),
        R('concrete', 2), R('metal', 1), R('metal', 1), R('metal', 1));
      S.win = R('glass', 0);
      break;
  }
}

const STYLE_ROOF = {
  rust: { _: 'flat', house: 'gable' }, c: { _: 'flat' }, cpp: { _: 'flat' }, go: { _: 'flat' },
  python: { _: 'flat', house: 'gable' }, js: { _: 'flat', house: 'hip' }, ts: { _: 'flat' },
  java: { _: 'flat', house: 'hip' }, ruby: { _: 'mansard', house: 'gable', shed: 'flat', plant: 'flat', frame: 'flat', hall: 'default' },
  php: { _: 'flat', house: 'gable' }, shell: { _: 'flat', house: 'gable', slab: 'gable' },
};

const eps = g => Math.max(g.u * 0.012, 0.004);
const lo = (g, f) => f ? g.z0 : g.x0, hi = (g, f) => f ? g.z1 : g.x1;
const rectG = (cx, cz, w, d) => ({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2, u: Math.min(w, d) });
const floorsFor = (g, ya, yb, k, cap) => clamp(Math.round((yb - ya) / (g.u * k)), 1, cap);

// Flat quad laid on a visible face. f=0: the +z face (a..b along x), f=1: the +x face (a..b along z).
function put(M, g, f, a, b, ya, yb, off, part, col) {
  if (part === GLASS) part = WIN; // glass laid on a wall is a window pane
  if (f === 0) { const z = g.z1 + off; M.quad([a, ya, z], [b, ya, z], [b, yb, z], [a, yb, z], part, col); }
  else { const x = g.x1 + off; M.quad([x, ya, b], [x, ya, a], [x, yb, a], [x, yb, b], part, col); }
}
// Box standing proud of a visible face (only the faces the camera can see).
function ledge(M, g, f, a, b, ya, yb, out, side, top) {
  if (f === 0) M.box(a, b, ya, yb, g.z1, g.z1 + out, side, top, ['nx', 'nz']);
  else M.box(g.x1, g.x1 + out, ya, yb, a, b, side, top, ['nx', 'nz', 'pz']);
}
function band(M, g, ya, yb, out, side, top) {
  ledge(M, g, 0, g.x0 - out, g.x1 + out, ya, yb, out, side, top);
  ledge(M, g, 1, g.z0 - out, g.z1, ya, yb, out, side, top);
}
// Grid / ribbon of flat window quads on both visible faces.
function windows(M, g, W) {
  const n = W.n, fh = (W.yb - W.ya) / n, off = W.off ?? eps(g);
  for (let f = 0; f < 2; f++) {
    const a0 = lo(g, f), span = hi(g, f) - a0;
    const nc = W.ribbon ? 1 : clamp(Math.round(span / W.bay), 1, W.maxC || 4), bw = span / nc;
    for (let j = W.from || 0; j < n; j++) {
      const ya = W.ya + j * fh + fh * (W.y0 ?? (1 - W.wh) / 2), yb = ya + fh * W.wh;
      for (let i = 0; i < nc; i++) {
        const ww = (W.ribbon ? W.rib : W.ww) * bw, c = a0 + bw * (i + 0.5);
        if (W.frame) {
          const px = ww * W.frame[1], py = fh * W.frame[1] * 0.6;
          put(M, g, f, c - ww / 2 - px, c + ww / 2 + px, ya - py, yb + py, off * 0.5, TRIM, W.frame[0]);
        }
        put(M, g, f, c - ww / 2, c + ww / 2, ya, yb, off, W.part ?? GLASS, W.colFn ? W.colFn(i, j, f) : W.col);
      }
    }
  }
}
// Stack of shrinking brick bands standing on a wall top: the stepped gable.
function steppedGable(M, cx, zf, W, y0, H, thick, wallC, trimC, n = 4) {
  const sh = H / n;
  for (let i = 0; i < n; i++) {
    const hw = W / 2 * (1 - i / n * 0.8);
    M.box(cx - hw, cx + hw, y0 + i * sh, y0 + (i + 1) * sh, zf - thick, zf, [WALL, wallC], [TRIM, trimC], ['nx', 'nz']);
  }
}

const plinth = (M, g, hh, ext, side, top) => {
  if (g.grounded && hh > 0) M.box(g.x0 - ext, g.x1 + ext, g.y0, g.y0 + hh, g.z0 - ext, g.z1 + ext, side, top);
};
const walls = (M, g, ya, yb, wall) => M.box(g.x0, g.x1, ya, yb, g.z0, g.z1, [g.wallPart ?? wall[0], g.wallCol ?? wall[1]], null, ['top']);
const capSlab = (M, g, ya, yb, ext, side, top) => M.box(g.x0 - ext, g.x1 + ext, ya, yb, g.z0 - ext, g.z1 + ext, side, top);
const done = (g, y, ex, extra) => ({ cx: g.cx, cz: g.cz, w: g.w, d: g.d, y, ex: ex || 0, flat: true, ...extra });

const STY = {};

// weathering-steel industrial: exposed girder frame, small dark openings, rust patches when old
STY.rust = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb, hs = g.last ? Math.min(u * 0.4, H * 0.16) : 0, Y1 = g.y1 - hs;
  const gh = g.grounded ? Math.min(H * 0.09, u * 0.28) : 0, lip = Math.min(u * 0.08, H * 0.07);
  const steel = [TRIM, S.trim], ya = y0 + gh, yb = Y1 - lip, t = Math.max(u * 0.055, 1e-3), out = e * 0.9;
  plinth(M, g, gh, e * 0.8, [POD, S.base], steel);
  walls(M, g, ya, yb, [WALL, S.wall]);
  capSlab(M, g, yb, Y1, e * 0.8, steel, [ROOF, S.flat]);
  const n = floorsFor(g, ya, yb, 0.6, lod > 1 ? 3 : 4), fh = (yb - ya) / n;
  if (S.era === 'old' && lod === 1) { // rust blotches
    const pc = S.pick('corten', 1);
    for (let f = 0; f < 2; f++) for (let k = 0; k < 2; k++) {
      const a = lo(g, f) + (hi(g, f) - lo(g, f)) * (0.1 + S.rng() * 0.6), ww = u * (0.12 + S.rng() * 0.2);
      const ys = ya + (yb - ya) * S.rng() * 0.6;
      put(M, g, f, a, a + ww, ys, ys + (yb - ya) * (0.15 + S.rng() * 0.25), eps(g) * 0.4, WALL, pc);
    }
  }
  windows(M, g, { ya, yb, n, bay: u * 0.55, maxC: 3, ww: 0.3, wh: 0.28, col: S.win, part: GLASS });
  for (let f = 0; f < 2; f++) { // exposed columns
    const a0 = lo(g, f), span = hi(g, f) - a0, nc = clamp(Math.round(span / (u * 0.55)), 1, lod > 1 ? 2 : 3);
    for (let k = 0; k <= nc; k++) {
      if (f && k === nc) continue;
      const a = clamp(a0 + span * k / nc, a0 + t / 2, a0 + span - t / 2);
      ledge(M, g, f, a - t / 2, a + t / 2, ya, yb, out, steel, steel);
    }
  }
  for (let j = 1; j < n; j++) band(M, g, ya + j * fh - t * 0.4, ya + j * fh + t * 0.4, out * 1.2, steel, steel); // girders
  if (g.last) { // flue stack
    const r = u * 0.055;
    M.loft(g.x0 + u * 0.17, g.z0 + u * 0.17, [[Y1, r, r], [Y1 + hs, r * 0.85, r * 0.85]], 5, [TRIM, S.steel], { cap: [TRIM, S.dark] });
  }
  return done(g, Y1, e * 0.8);
};

// brutalist concrete: chunky slabs, deep dark recesses; cpp = the same family, busier
function brutal(M, S, g, busy) {
  const { y0, H, u, e } = g, lod = S.nb, hs = g.last ? Math.min(u * 0.22, H * 0.1) : 0, Y1 = g.y1 - hs;
  const gh = g.grounded ? Math.min(H * 0.13, u * 0.4) : 0, ts = Math.min(u * 0.16, H * 0.11), oh = e * 2, sl = [TRIM, S.trim];
  const ya = y0 + gh, yb = Y1 - ts;
  plinth(M, g, gh, e * 1.4, [POD, S.base], sl);
  if (busy && gh > 0) M.box(g.x0 - e * 2.4, g.x1 + e * 2.4, y0, y0 + gh * 0.4, g.z0 - e * 2.4, g.z1 + e * 2.4, [POD, S.base], sl);
  walls(M, g, ya, yb, [WALL, S.wall]);
  capSlab(M, g, yb, Y1, oh, sl, [ROOF, S.flat]);
  if (busy) { // second, inset crown slab: layered
    M.box(g.x0 + e, g.x1 - e, Y1, Y1 + ts * 0.5, g.z0 + e, g.z1 - e, [WALL, S.wall], [ROOF, S.flat]);
  }
  const n = floorsFor(g, ya, yb, 0.62, lod > 1 ? 3 : 4), fh = (yb - ya) / n, st = Math.min(fh * 0.16, u * 0.07);
  for (let j = 1; j < n; j++) band(M, g, ya + j * fh - st / 2, ya + j * fh + st / 2, e * 1.5, sl, sl);
  windows(M, g, { ya, yb, n, bay: u * 0.5, maxC: 3, ww: 0.5, wh: 0.5, y0: 0.14, col: S.win, part: GLASS });
  if (busy && lod === 1 && n > 1) { // protruding boxes, each with a blue-glazed face
    const blue = S.pick('primary', 0), cream = S.pick('concrete', 3);
    for (let f = 0; f < 2; f++) {
      const a0 = lo(g, f), span = hi(g, f) - a0, bw = span * 0.28, a = a0 + span * (f ? 0.18 : 0.58), j = f ? 1 : 2;
      const yy = ya + clamp(j, 1, n - 1) * fh + st, out = u * 0.14;
      ledge(M, g, f, a, a + bw, yy, yy + fh * 0.72, out, [TRIM, cream], [TRIM, cream]);
      put(M, f ? { ...g, x1: g.x1 + out } : { ...g, z1: g.z1 + out }, f, a + bw * 0.12, a + bw * 0.88, yy + fh * 0.12, yy + fh * 0.6, eps(g), GLASS, blue);
    }
  }
  if (g.last) { // mechanical penthouse
    const bw = g.w * 0.42, bd = g.d * 0.4, bx = g.cx - g.w * 0.12, bz = g.cz - g.d * 0.1;
    M.box(bx - bw / 2, bx + bw / 2, Y1, Y1 + hs * 0.65, bz - bd / 2, bz + bd / 2, [WALL, S.wall], [ROOF, S.flat]);
    if (busy) M.box(bx - bw * 0.22, bx + bw * 0.22, Y1 + hs * 0.65, Y1 + hs, bz - bd * 0.22, bz + bd * 0.22, [TRIM, S.trim], [ROOF, S.flat]);
  }
  return done(g, Y1, oh);
}
STY.c = (M, S, g) => brutal(M, S, g, false);
STY.cpp = (M, S, g) => brutal(M, S, g, true);

// Bauhaus: white boxes, thin flat slab roofs, ribbon windows, one primary-colour stair tower
STY.go = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb;
  const gh = g.grounded ? Math.min(H * 0.05, u * 0.12) : 0, ts = Math.min(u * 0.05, H * 0.04), oh = e * 1.3;
  if (gh > 0) M.box(g.x0 + e, g.x1 - e, y0, y0 + gh, g.z0 + e, g.z1 - e, [POD, S.base], [TRIM, S.base]);
  const ya = y0 + gh, yb = g.y1 - ts;
  walls(M, g, ya, yb, [WALL, S.wall]);
  capSlab(M, g, yb, g.y1, oh, [TRIM, S.white], [ROOF, S.flat]);
  const n = floorsFor(g, ya, yb, 0.5, 8);
  windows(M, g, { ya, yb, n, ribbon: true, rib: 0.86, wh: 0.44, col: S.win, part: GLASS });
  if (g.last) {
    const sw = Math.min(g.w * 0.15, u * 0.2), ax = g.x0 + g.w * 0.12, out = e * 2.2;
    ledge(M, g, 0, ax, ax + sw, ya, g.y1, out, [ACC, S.accent], [ACC, S.accent]);
    put(M, { ...g, z1: g.z1 + out }, 0, ax + sw * 0.28, ax + sw * 0.72, ya + (yb - ya) * 0.06, yb - (yb - ya) * 0.04, eps(g), GLASS, S.win);
  }
  return done(g, g.y1, oh);
};

// Dutch canal house: brick, white-framed tall windows, stepped gable with a hoist beam
STY.python = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb, gab = g.last ? Math.min(u * 0.42, H * 0.2) : 0, Yt = g.y1 - gab;
  const gh = g.grounded ? Math.min(H * 0.06, u * 0.15) : 0, ch = Math.min(u * 0.09, H * 0.05), wt = [TRIM, S.trim];
  const ya = y0 + gh, yb = Yt - ch;
  plinth(M, g, gh, e * 0.5, [POD, S.base], wt);
  walls(M, g, ya, yb, [WALL, S.wall]);
  capSlab(M, g, yb, Yt, e * 1.1, wt, [ROOF, S.flat]);
  const n = floorsFor(g, ya, yb, 0.62, lod > 1 ? 3 : 3);
  windows(M, g, { ya, yb, n, bay: u * 0.38, maxC: 2, ww: 0.4, wh: 0.62, col: S.win, part: GLASS, frame: [S.trim, 0.24] });
  if (lod === 1 && n > 1) band(M, g, ya + (yb - ya) * 0.5 - e * 0.25, ya + (yb - ya) * 0.5 + e * 0.25, e * 0.5, wt, wt);
  if (g.last) {
    const zf = g.z1 + e * 1.1;
    steppedGable(M, g.cx, zf, g.w * 0.9, Yt, gab, e * 1.6, S.wall, S.trim);
    M.box(g.cx - e * 0.35, g.cx + e * 0.35, Yt + gab - e * 1.2, Yt + gab - e * 0.4, zf, zf + e * 3, wt, wt); // hoist beam
  }
  return done(g, Yt, e * 1.1);
};

// postmodern eclectic: every block its own colours, playful bay, rooftop signboard
STY.js = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb, pool = S.pool, rng = S.rng, pk = () => pool[Math.floor(rng() * pool.length)];
  const wallC = S.js0++ === 0 ? S.wall : pk(), trimC = pk(), capC = pk(), sg = g.last ? Math.min(u * 0.34, H * 0.2) : 0, Y1 = g.y1 - sg;
  const gh = g.grounded ? Math.min(H * 0.08, u * 0.22) : 0, ch = Math.min(u * 0.1, H * 0.06);
  const ya = y0 + gh, yb = Y1 - ch;
  plinth(M, g, gh, e * 0.8, [POD, pk()], [TRIM, trimC]);
  walls(M, g, ya, yb, [WALL, wallC]);
  capSlab(M, g, yb, Y1, e * 1.4, [TRIM, capC], [ROOF, capC]);
  const n = floorsFor(g, ya, yb, 0.55, lod > 1 ? 2 : 3), fh = (yb - ya) / n, wc = [S.win, S.white, pk(), S.win];
  windows(M, g, { ya, yb, n, bay: u * 0.42, maxC: 3, ww: 0.3 + rng() * 0.25, wh: 0.3 + rng() * 0.25, colFn: () => wc[Math.floor(rng() * 4)], part: GLASS, frame: lod === 1 ? [trimC, 0.18] : null });
  if (lod === 1 || g.last) { // mismatched bay
    const f = rng() < 0.5 ? 0 : 1, a0 = lo(g, f), span = hi(g, f) - a0, bw = span * 0.3, a = a0 + span * (0.1 + rng() * 0.45), bc = pk();
    const by = ya + (n > 1 ? fh : 0), bh = fh * 0.85, out = u * 0.12;
    ledge(M, g, f, a, a + bw, by, by + bh, out, [WALL, bc], [ROOF, pk()]);
    put(M, f ? { ...g, x1: g.x1 + out } : { ...g, z1: g.z1 + out }, f, a + bw * 0.2, a + bw * 0.8, by + bh * 0.25, by + bh * 0.75, eps(g), GLASS, S.win);
  }
  if (g.last) { // signboard on posts
    const bw = g.w * 0.55, bx = g.cx + (rng() - 0.5) * g.w * 0.3, bz = g.cz - g.d * 0.05, post = sg * 0.28, bc = rng() < 0.5 ? S.accent : S.pick('pop', 0);
    for (const sx of [-1, 1]) M.box(bx + sx * bw * 0.38 - e * 0.3, bx + sx * bw * 0.38 + e * 0.3, Y1, Y1 + post, bz - e * 0.3, bz + e * 0.3, [TRIM, S.steel], null, ['nx', 'nz', 'top']);
    M.box(bx - bw / 2, bx + bw / 2, Y1 + post, g.y1, bz, bz + e * 0.9, [ACC, bc], [ACC, bc], ['nx', 'nz']);
    const sy = Y1 + post + (g.y1 - Y1 - post) * 0.3, sh = (g.y1 - Y1 - post) * 0.4, zf = bz + e * 0.9 + eps(g);
    M.quad([bx - bw * 0.36, sy, zf], [bx + bw * 0.36, sy, zf], [bx + bw * 0.36, sy + sh, zf], [bx - bw * 0.36, sy + sh, zf], ACC, S.white);
  }
  return done(g, Y1, e * 1.4);
};

// disciplined corporate modern: glass curtain wall, regular mullion grid, neat logo plate
STY.ts = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb, sg = g.last ? Math.min(u * 0.16, H * 0.09) : 0, Y1 = g.y1 - sg;
  const gh = g.grounded ? Math.min(H * 0.08, u * 0.25) : 0, ts = Math.min(u * 0.05, H * 0.035), glass = S.era !== 'old';
  const ya = y0 + gh, yb = Y1 - ts, tr = [TRIM, S.trim];
  plinth(M, g, gh, e * 0.5, [POD, S.base], tr);
  walls(M, g, ya, yb, [glass ? GLASS : WALL, S.wall]);
  capSlab(M, g, yb, Y1, e * 0.6, tr, [ROOF, S.flat]);
  const n = floorsFor(g, ya, yb, 0.4, 8), fh = (yb - ya) / n, t = u * 0.022, sp = fh * 0.12, o2 = eps(g) * 1.3;
  if (!glass) windows(M, g, { ya, yb, n, bay: u * 0.42, maxC: 4, ww: 0.78, wh: 0.62, col: S.win, part: GLASS });
  for (let f = 0; f < 2; f++) {
    const a0 = lo(g, f), span = hi(g, f) - a0, nc = clamp(Math.round(span / (u * 0.42)), 2, 5);
    for (let k = 0; k <= nc; k++) {
      const a = clamp(a0 + span * k / nc, a0 + t / 2, a0 + span - t / 2);
      put(M, g, f, a - t / 2, a + t / 2, ya, yb, o2, TRIM, S.trim);
    }
    for (let j = 0; j <= n; j++) {
      const y = ya + j * fh;
      put(M, g, f, a0, a0 + span, Math.max(y - sp / 2, ya), Math.min(y + sp / 2, yb), o2 * 1.2, TRIM, S.trim);
    }
  }
  if (g.last) { // logo plate
    const bw = g.w * 0.3, bx = g.cx - g.w * 0.15, bz = g.cz + g.d * 0.3, bc = S.pick('primary', 0);
    M.box(bx - bw / 2, bx + bw / 2, Y1, g.y1, bz, bz + e * 0.7, [ACC, bc], [ACC, bc], ['nx', 'nz']);
    const zf = bz + e * 0.7 + eps(g);
    M.quad([bx - bw * 0.3, Y1 + sg * 0.4, zf], [bx + bw * 0.3, Y1 + sg * 0.4, zf], [bx + bw * 0.3, Y1 + sg * 0.6, zf], [bx - bw * 0.3, Y1 + sg * 0.6, zf], ACC, S.white);
  }
  return done(g, Y1, e * 0.6);
};

// enterprise office park: big beige blocks, identical ribbon bands, identical rooftop units
STY.java = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb, hs = g.last ? Math.min(u * 0.2, H * 0.08) : 0, Y1 = g.y1 - hs;
  const gh = g.grounded ? Math.min(H * 0.07, u * 0.2) : 0, ts = Math.min(u * 0.09, H * 0.05), tr = [TRIM, S.trim];
  const ya = y0 + gh, yb = Y1 - ts;
  plinth(M, g, gh, e * 0.5, [POD, S.base], tr);
  walls(M, g, ya, yb, [WALL, S.wall]);
  capSlab(M, g, yb, Y1, e * 0.9, tr, [ROOF, S.flat]);
  const n = floorsFor(g, ya, yb, 0.42, 8), fh = (yb - ya) / n, t = u * 0.02, o2 = eps(g) * 1.3;
  windows(M, g, { ya, yb, n, ribbon: true, rib: 0.92, wh: 0.5, col: S.win, part: GLASS });
  for (let f = 0; f < 2; f++) { // identical pane dividers
    const a0 = lo(g, f), span = hi(g, f) - a0, nc = clamp(Math.round(span / (u * 0.34)), 2, 5);
    for (let k = 1; k < nc; k++) put(M, g, f, a0 + span * k / nc - t / 2, a0 + span * k / nc + t / 2, ya, yb, o2, TRIM, S.trim);
  }
  if (g.last) {
    const bw = g.w * 0.17, bd = g.d * 0.2;
    for (let k = -1; k <= 1; k++) M.box(g.cx + k * g.w * 0.26 - bw / 2, g.cx + k * g.w * 0.26 + bw / 2, Y1, Y1 + hs * 0.8, g.cz - g.d * 0.15 - bd / 2, g.cz - g.d * 0.15 + bd / 2, tr, [ROOF, S.flat]);
  }
  return done(g, Y1, e * 0.9);
};

// refined Victorian: ruby brick, cream quoins + lintels, bracketed cornice
STY.ruby = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb, cream = [TRIM, S.trim], gh = g.grounded ? Math.min(H * 0.08, u * 0.22) : 0, ch = Math.min(u * 0.12, H * 0.07);
  const ya = y0 + gh, yb = g.y1 - ch;
  plinth(M, g, gh, e * 0.6, [POD, S.base], cream);
  walls(M, g, ya, yb, [WALL, S.wall]);
  capSlab(M, g, yb, yb + ch * 0.6, e * 0.8, cream, null);
  capSlab(M, g, yb + ch * 0.6, g.y1, e * 1.6, cream, [ROOF, S.flat]);
  const n = floorsFor(g, ya, yb, 0.6, 3);
  windows(M, g, { ya, yb, n, bay: u * 0.4, maxC: 2, ww: 0.4, wh: 0.62, col: S.win, part: GLASS, frame: [S.trim, 0.22] });
  const q = u * 0.07;
  ledge(M, g, 0, g.x0, g.x0 + q, ya, yb, e * 0.4, cream, null); ledge(M, g, 0, g.x1 - q, g.x1, ya, yb, e * 0.4, cream, null);
  ledge(M, g, 1, g.z0, g.z0 + q, ya, yb, e * 0.4, cream, null); ledge(M, g, 1, g.z1 - q, g.z1, ya, yb, e * 0.4, cream, null);
  if (lod === 1) { // cornice brackets
    const dk = [TRIM, S.pick('ruby', 1)];
    for (let f = 0; f < 2; f++) {
      const a0 = lo(g, f), span = hi(g, f) - a0, nb = clamp(Math.round(span / (u * 0.22)), 3, 5), bw = u * 0.045;
      for (let k = 0; k < nb; k++) { const a = a0 + span * (k + 0.5) / nb; ledge(M, g, f, a - bw / 2, a + bw / 2, yb - ch * 0.3, yb + ch * 0.6, e * 1.1, dk, dk); }
    }
  }
  return done(g, g.y1, e * 1.6);
};

// informal self-built: additions on additions, mismatched colours, a bolted-on extra floor
STY.php = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb, rng = S.rng, pool = S.pool, pk = () => pool[Math.floor(rng() * pool.length)];
  const ef = g.last && H > u * 0.7 ? Math.min(H * 0.24, u * 0.4) : 0, Yb = g.y1 - ef, annex = g.grounded && g.last && lod === 1;
  const aw = annex ? g.w * 0.24 : 0, mg = { ...g, x1: g.x1 - aw, w: g.w - aw, cx: g.cx - aw / 2 };
  const gh = g.grounded ? Math.min(H * 0.07, u * 0.18) : 0, ya = y0 + gh, yb = Yb - e * 0.5, tin = S.pick('metal', 0);
  plinth(M, mg, gh, e * 0.4, [POD, S.base], [TRIM, S.trim]);
  walls(M, mg, ya, yb, [WALL, S.wall]);
  capSlab(M, mg, yb, Yb, e * 0.6, [TRIM, S.trim], [ROOF, tin]);
  const n = floorsFor(g, ya, yb, 0.55, lod > 1 ? 2 : 3), fh = (yb - ya) / n, wc = [S.win, S.white, S.win, pk()];
  windows(M, mg, { ya, yb, n, bay: u * 0.4, maxC: 3, ww: 0.28 + rng() * 0.25, wh: 0.3 + rng() * 0.3, colFn: () => wc[Math.floor(rng() * 4)], part: GLASS });
  if (lod === 1 && n > 1) { // exterior stair
    const sz = mg.z1 + e * 1.2, sx = mg.x0 + g.w * 0.1;
    M.strut([sx, ya, sz], [sx + g.w * 0.34, ya + (yb - ya) * 0.55, sz], e * 0.55, TRIM, S.pick('wood'));
  }
  if (annex) { // lean-to on the side
    const ah = H * 0.42, ac = pk(), z0 = g.z0 + g.d * 0.28;
    M.boxH(mg.x1, g.x1, z0, g.z1, y0, [ah, ah * 0.62, ah, ah * 0.62], [WALL, ac], [ROOF, tin]);
    put(M, g, 0, mg.x1 + aw * 0.2, mg.x1 + aw * 0.7, y0 + ah * 0.3, y0 + ah * 0.6, eps(g), GLASS, S.win);
    put(M, g, 1, z0 + g.d * 0.12, z0 + g.d * 0.4, y0 + ah * 0.0, y0 + ah * 0.55, eps(g), TRIM, S.dark);
  }
  if (ef > 0) { // the bolted-on floor, shoved off to one side
    const ew = g.w * 0.62, ed = g.d * 0.58, ex = mg.cx - g.w * 0.1, ez = g.cz - g.d * 0.12, c = pk(), ec = pk();
    M.box(ex - ew / 2, ex + ew / 2, Yb, g.y1 - ef * 0.28, ez - ed / 2, ez + ed / 2, [WALL, c], null, ['top']);
    M.boxH(ex - ew / 2 - e, ex + ew / 2 + e, ez - ed / 2 - e, ez + ed / 2 + e, g.y1 - ef * 0.28, [g.y1, g.y1, g.y1 - ef * 0.2, g.y1 - ef * 0.2], [TRIM, ec], [ROOF, tin]);
    const eg = rectG(ex, ez, ew, ed);
    put(M, eg, 0, ex - ew * 0.3, ex + ew * 0.1, Yb + ef * 0.15, Yb + ef * 0.5, eps(g), GLASS, S.win);
    put(M, eg, 1, ez - ed * 0.25, ez + ed * 0.2, Yb + ef * 0.15, Yb + ef * 0.5, eps(g), GLASS, S.win);
    return { cx: ex, cz: ez, w: ew * 0.2, d: ed * 0.2, y: g.y1, ex: 0, flat: false };
  }
  return done(mg, Yb, e * 0.6);
};

// corrugated-metal shed: ribbed sheeting, roller door, clerestory strip, roof vent
STY.shell = (M, S, g) => {
  const { y0, H, u, e } = g, lod = S.nb, hs = g.last ? Math.min(u * 0.22, H * 0.1) : 0, Y1 = g.y1 - hs;
  const gh = g.grounded ? Math.min(H * 0.07, u * 0.18) : 0, ch = Math.min(u * 0.06, H * 0.05), tr = [TRIM, S.trim];
  const ya = y0 + gh, yb = Y1 - ch, o1 = eps(g) * 0.6;
  plinth(M, g, gh, e * 0.4, [POD, S.base], tr);
  walls(M, g, ya, yb, [WALL, S.wall]);
  capSlab(M, g, yb, Y1, e * 0.7, tr, [ROOF, S.flat]);
  for (let f = 0; f < 2; f++) { // corrugation ribs
    const a0 = lo(g, f), span = hi(g, f) - a0, nr = clamp(Math.round(span / (u * 0.13)), 4, lod > 1 ? 6 : 10), rw = span / nr;
    for (let i = 1; i < nr; i += 2) put(M, g, f, a0 + rw * i, a0 + rw * (i + 1), ya, yb, o1, WALL, S.trim);
  }
  windows(M, g, { ya, yb, n: 1, ribbon: true, rib: 0.8, wh: 0.14, y0: 0.76, col: S.win, part: GLASS });
  if (g.grounded) {
    const a0 = g.x0, span = g.w, dh = Math.min(H * 0.55, u * 0.5);
    put(M, g, 0, a0 + span * 0.12, a0 + span * 0.48, ya, ya + dh, eps(g) * 1.2, TRIM, S.dark);
    put(M, g, 0, a0 + span * 0.2, a0 + span * 0.4, ya + dh * 0.3, ya + dh * 0.75, eps(g) * 1.6, TRIM, S.pick('corten', 1)); // faded paint patch
  }
  if (g.last) {
    const r = u * 0.06;
    M.loft(g.cx + g.w * 0.22, g.cz - g.d * 0.15, [[Y1, r, r], [Y1 + hs * 0.8, r * 0.8, r * 0.8]], 6, [TRIM, S.steel], { cap: [TRIM, S.dark] });
  }
  return done(g, Y1, e * 0.7);
};

function styleBlock(M, S, o) {
  const { cx, cz, w, d, y0, y1 } = o;
  const g = { cx, cz, w, d, y0, y1, x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2, u: Math.min(w, d), H: y1 - y0,
    grounded: o.ground !== false, last: !!o.last, wallPart: o.wallPart, wallCol: o.wallCol };
  g.e = g.u * 0.05;
  return STY[S.style](M, S, g);
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
  const r = block(M, S, { cx: 0, cz: 0, w: S.w, d: S.d, y0: 0, y1: S.h - rise, top: topFor(S, rt), last: true });
  return roofOn(M, S, r, rt, rise);
}

function buildTower(M, S) {
  // plinth + slender shaft + lantern crown: reads as "tower" even on slab-like input
  const { w, d, h, u } = S, rt = S.roof;
  const ph = Math.min(h * 0.1, u * 0.7), sw = w * 0.78, sd = d * 0.78, cw = w * 0.46, cd = d * 0.46;
  const lh = Math.min(h * 0.05, u * 0.45), rise = planRoof(rt, cw, cd, h, 0.26);
  const sh = h - lh - rise;
  S.nb = 3;
  block(M, S, { cx: 0, cz: 0, w, d, y0: 0, y1: ph, top: 'flat' });
  block(M, S, { cx: 0, cz: 0, w: sw, d: sd, y0: ph, y1: sh, ground: false, top: 'flat' });
  const r = block(M, S, { cx: 0, cz: 0, w: cw, d: cd, y0: sh, y1: sh + lh, ground: false, top: topFor(S, rt), last: true });
  return roofOn(M, S, r, rt, rise);
}

function buildSetback(M, S) {
  const n = clamp(Math.round(S.spec.tiers || 3), 2, 4), rt = S.roof;
  const k = (0.62 / n) * (0.9 + S.rng() * 0.2);
  const sc = Array.from({ length: n }, (_, i) => Math.max(1 - i * k, 0.28));
  const wts = [1, 0.8, 0.66, 0.56].slice(0, n), ws = wts.reduce((a, b) => a + b, 0);
  S.nb = n;
  const tw = S.w * sc[n - 1], td = S.d * sc[n - 1];
  const rise = planRoof(rt, tw, td, S.h, 0.24), avail = S.h - rise;
  let y = 0, r;
  for (let i = 0; i < n; i++) {
    const hi = avail * wts[i] / ws;
    r = block(M, S, { cx: 0, cz: 0, w: S.w * sc[i], d: S.d * sc[i], y0: y, y1: y + hi, ground: i === 0, top: i === n - 1 ? topFor(S, rt) : 'flat', last: i === n - 1 });
    y += hi;
  }
  return roofOn(M, S, r, rt, rise);
}

function buildPodium(M, S) {
  const { w, d, h, u } = S, rt = S.roof;
  const ph = Math.min(h * 0.26, u * 0.55);
  S.nb = 2;
  const fw = w * (0.5 + S.rng() * 0.15), fd = d * (0.5 + S.rng() * 0.15);
  const ox = (S.rng() - 0.5) * (w - fw) * 0.8, oz = -S.rng() * (d - fd) * 0.45;
  block(M, S, { cx: 0, cz: 0, w, d, y0: 0, y1: ph, wallPart: POD, wallCol: S.era === 'new' ? S.base : S.era === 'old' ? S.base : S.ground, top: 'flat', fins: false });
  // entrance canopy, the one splash of accent colour at street level
  const cw = w * 0.3, cx = clamp(ox * 0.5, -w * 0.2, w * 0.2);
  M.box(cx - cw / 2, cx + cw / 2, ph * 0.5, ph * 0.58, d / 2, d / 2 + u * 0.1, [ACC, S.accent], [ACC, S.accent]);
  const rise = planRoof(rt, fw, fd, h - ph, 0.26);
  const r = block(M, S, { cx: ox, cz: oz, w: fw, d: fd, y0: ph, y1: h - rise, ground: false, top: topFor(S, rt), last: true });
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
  if (S.style !== 'default') houseStyle(M, S, { w, d, u, e, ph, wallH, dx });
  const pz = S.style === 'python';
  const T = roofOn(M, S, r, rt, rise, pz ? 'z' : undefined);
  if (pz && rt === 'gable') steppedGable(M, 0, d / 2 + r.ex + e * 0.5, w + 2 * r.ex, wallH, rise, e * 1.4, S.wall, S.trim);
  if (rt === 'gable') { // brick chimney sitting on the ridge
    const ax = pz ? 'z' : w >= d ? 'x' : 'z', cs = u * 0.1, off = (S.rng() < 0.5 ? -1 : 1) * (ax === 'x' ? w : d) * 0.27;
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
  const r = block(M, S, { cx: bcx, cz: 0, w: bw, d, y0: 0, y1: bh - rise, top: 'flat', last: true, wallPart: WALL, wallCol: S.era === 'new' ? S.solid : S.wall, fins: false });
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
  const r = block(M, S, { cx: 0, cz: bcz, w: bw, d: bd, y0, y1: top, ground: false, top: topFor(S, rt), last: true });
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

// ------------------------------------------------------------ house: style hooks
function houseStyle(M, S, k) {
  const { w, d, u, ph, wallH, dx } = k, g = rectG(0, 0, w, d), off = Math.max(u * 0.012, 0.004);
  const y0 = ph + (wallH - ph) * 0.35, y1 = ph + (wallH - ph) * 0.8, ww = Math.min(w * 0.15, u * 0.15);
  const framed = S.style === 'python' || S.style === 'ruby' || S.style === 'js' || S.style === 'java';
  const wc = S.style === 'js' ? S.pick('accent', 0) : S.win;
  if (S.era !== 'new') {
    if (framed) put(M, g, 0, -dx - ww * 1.3, -dx + ww * 1.3, y0 - (y1 - y0) * 0.15, y1 + (y1 - y0) * 0.15, off * 0.5, TRIM, S.trim);
    put(M, g, 0, -dx - ww, -dx + ww, y0, y1, off, GLASS, wc);
  }
  if (framed) put(M, g, 1, -ww * 1.3, ww * 1.3, y0 - (y1 - y0) * 0.15, y1 + (y1 - y0) * 0.15, off * 0.5, TRIM, S.trim);
  put(M, g, 1, -ww, ww, y0, y1, off, GLASS, wc);
}

// ------------------------------------------------------------ landmarks
// windows for landmarks built in the default style (styled blocks already carry their own)
function lwin(M, S, g, ya, yb, n, o = {}) {
  if (S.style !== 'default') return;
  windows(M, g, { ya, yb, n, bay: g.u * 0.4, maxC: 3, ww: 0.42, wh: 0.6, col: S.win, part: GLASS, frame: [S.trim, 0.2], ...o });
}

function flagProp(M, S, x, y, z, H) {
  M.strut([x, y, z], [x, y + H, z], H * 0.035, TRIM, S.alu);
  const fw = H * 0.5, fh = H * 0.28, yt = y + H, c = rgb(S.P.accent[1]);
  M.quad([x, yt - fh, z], [x + fw, yt - fh * 0.9, z], [x + fw, yt - fh * 0.1, z], [x, yt, z], ACC, c);
  M.quad([x, yt, z], [x + fw, yt - fh * 0.1, z], [x + fw, yt - fh * 0.9, z], [x, yt - fh, z], ACC, c);
}

function clockFace(M, S, g, yc, r) {
  const o1 = Math.max(r * 0.05, 0.004);
  for (let f = 0; f < 2; f++) {
    const a = (lo(g, f) + hi(g, f)) / 2;
    put(M, g, f, a - r, a + r, yc - r, yc + r, o1, ACC, S.dark);
    put(M, g, f, a - r * 0.82, a + r * 0.82, yc - r * 0.82, yc + r * 0.82, o1 * 2, ACC, S.white);
    put(M, g, f, a - r * 0.07, a + r * 0.07, yc, yc + r * 0.62, o1 * 3, ACC, S.dark);
    put(M, g, f, a, a + r * 0.5, yc - r * 0.07, yc + r * 0.07, o1 * 3, ACC, S.dark);
  }
}

// README: the front door. Stepped base, wings, a projecting pavilion and a clock tower or dome.
function buildCityhall(M, S) {
  const { w, d, h, u } = S, st = Math.min(h * 0.05, u * 0.08), ins = u * 0.03;
  S.nb = 3;
  const crown = S.spec.crown === 'dome' || S.spec.crown === 'tower' ? S.spec.crown : (S.rng() < 0.5 ? 'tower' : 'dome');
  M.box(-w / 2, w / 2, 0, st, -d / 2, d / 2, [POD, S.base], [TRIM, S.trim]);
  M.box(-w / 2 + ins, w / 2 - ins, st, st * 2, -d / 2 + ins, d / 2 - ins, [POD, S.base], [TRIM, S.trim]);
  const y0 = st * 2, back = -d / 2 + ins * 2, fr = d / 2 - ins * 2, wd = (fr - back) * 0.76;
  const hw = (h - y0) * 0.34, yp = y0 + (h - y0) * 0.6, cw = w * 0.36, cd = fr - back, ccz = back + cd / 2;
  block(M, S, { cx: 0, cz: back + wd / 2, w: w * 0.94, d: wd, y0, y1: y0 + hw, ground: false });
  lwin(M, S, rectG(0, back + wd / 2, w * 0.94, wd), y0 + hw * 0.12, y0 + hw * 0.9, 2, { maxC: 5, frame: null, bay: u * 0.34 });
  block(M, S, { cx: 0, cz: ccz, w: cw, d: cd, y0, y1: yp, ground: false });
  lwin(M, S, rectG(0, ccz, cw, cd), y0 + (yp - y0) * 0.5, yp - (yp - y0) * 0.06, 1, { maxC: 2, ww: 0.3 });
  const pg = rectG(0, ccz, cw, cd), dh = (yp - y0) * 0.4;
  put(M, pg, 0, -cw * 0.13, cw * 0.13, y0, y0 + dh, Math.max(u * 0.02, 0.01), TRIM, S.dark);
  ledge(M, pg, 0, -cw * 0.3, cw * 0.3, y0 + dh * 1.05, y0 + dh * 1.22, u * 0.09, [ACC, S.accent], [ACC, S.accent]);
  const flagH = Math.min(u * 0.22, h * 0.1);
  if (crown === 'tower') {
    const tw = cw * 0.62, tz = ccz - cd * 0.12, rise = Math.min(tw * 1.1, (h - yp) * 0.4), tTop = h - rise - flagH;
    const tb = block(M, S, { cx: 0, cz: tz, w: tw, d: tw, y0: yp, y1: tTop, ground: false });
    clockFace(M, S, rectG(0, tz, tw, tw), yp + (tTop - yp) * 0.56, tw * 0.3);
    roofOn(M, S, { cx: 0, cz: tz, w: tw, d: tw, y: tTop, ex: tb.ex, flat: true }, S.era === 'new' ? 'spire' : 'hip', rise);
    flagProp(M, S, 0, tTop + rise, tz, flagH);
  } else {
    const dw = cw * 0.74, tz = ccz - cd * 0.1, drum = (h - yp) * 0.26, rise = Math.min(h - yp - drum - flagH, dw * 0.66);
    const tb = block(M, S, { cx: 0, cz: tz, w: dw, d: dw, y0: yp, y1: yp + drum, ground: false });
    roofOn(M, S, { cx: 0, cz: tz, w: dw, d: dw, y: yp + drum, ex: tb.ex, flat: true }, 'dome', rise);
    flagProp(M, S, 0, yp + drum + rise, tz, flagH);
  }
  return null;
}

// LICENSE: temple front. Wide stepped approach, full-height colonnade, deep pediment.
function buildCourthouse(M, S) {
  const { w, d, h, u } = S;
  S.nb = 2;
  const ph = Math.min(h * 0.1, u * 0.2), sd = d * 0.36, zs = d / 2 - sd, pw = w * 0.62, sw = pw * 1.3, H1 = h - ph;
  const colH = H1 * 0.6, et = H1 * 0.1, prise = Math.min(pw * 0.22, H1 * 0.26), nst = 3, dt = sd / nst;
  M.box(-w / 2, w / 2, 0, ph, -d / 2, zs, [POD, S.base], [TRIM, S.trim]);
  for (let k = 0; k < nst; k++) M.box(-sw / 2, sw / 2, 0, ph * (nst - k) / nst, zs + k * dt, zs + (k + 1) * dt, [POD, S.base], [TRIM, S.trim], ['nz']);
  block(M, S, { cx: 0, cz: (zs - d / 2) / 2, w: w * 0.94, d: zs + d / 2, y0: ph, y1: ph + H1 * 0.76, ground: false, last: true });
  lwin(M, S, rectG(0, (zs - d / 2) / 2, w * 0.94, zs + d / 2), ph + H1 * 0.1, ph + H1 * 0.7, 2, { maxC: 3, ww: 0.36 });
  const n = 6, cr = Math.min(pw / (n * 2.5), colH * 0.09), zc = zs + dt * 0.5, yc = ph + colH;
  for (let i = 0; i < n; i++) {
    const x = -pw / 2 + cr + (pw - 2 * cr) * i / (n - 1);
    M.loft(x, zc, [[ph, cr * 1.15, cr * 1.15], [yc, cr * 0.9, cr * 0.9]], 6, [TRIM, S.trim]);
  }
  const ew = pw + cr * 5, ez0 = zs, ez1 = zs + dt * 0.95;
  M.box(-ew / 2, ew / 2, yc, yc + et, ez0, ez1, [TRIM, S.trim], [TRIM, S.trim]);
  gable(M, 0, (ez0 + ez1) / 2, ew, ez1 - ez0, yc + et, prise, 0, 'z', S.pitch, TRIM, S.base);
  return null;
}

// CHANGELOG: archive tower with a big clock face (accent part) and a needle spire.
function buildClocktower(M, S) {
  const { w, d, h, u } = S;
  S.nb = 4;
  const ph = h * 0.11, s1 = h * 0.54, s2 = h * 0.76, s3 = h * 0.83, fin = h * 0.05;
  block(M, S, { cx: 0, cz: 0, w, d, y0: 0, y1: ph });
  const sw = w * 0.64, sdp = d * 0.64;
  block(M, S, { cx: 0, cz: 0, w: sw, d: sdp, y0: ph, y1: s1, ground: false });
  const sg = rectG(0, 0, sw, sdp), o = Math.max(u * 0.012, 0.004);
  for (let f = 0; f < 2; f++) { // arrow slits
    const a = (lo(sg, f) + hi(sg, f)) / 2, sp = (hi(sg, f) - lo(sg, f)) * 0.22;
    for (const k of [-1, 1]) put(M, sg, f, a + k * sp - sw * 0.03, a + k * sp + sw * 0.03, ph + (s1 - ph) * 0.2, ph + (s1 - ph) * 0.65, o, TRIM, S.dark);
  }
  const cw = w * 0.78, cdp = d * 0.78;
  block(M, S, { cx: 0, cz: 0, w: cw, d: cdp, y0: s1, y1: s2, ground: false });
  clockFace(M, S, rectG(0, 0, cw, cdp), (s1 + s2) / 2, Math.min(cw * 0.34, (s2 - s1) * 0.42));
  const bw = w * 0.56, bd = d * 0.56;
  const bf = block(M, S, { cx: 0, cz: 0, w: bw, d: bd, y0: s2, y1: s3, ground: false });
  const bg = rectG(0, 0, bw, bd);
  for (let f = 0; f < 2; f++) {
    const a = (lo(bg, f) + hi(bg, f)) / 2, sp = (hi(bg, f) - lo(bg, f)) * 0.22;
    for (const k of [-1, 1]) put(M, bg, f, a + k * sp - bw * 0.07, a + k * sp + bw * 0.07, s2 + (s3 - s2) * 0.15, s2 + (s3 - s2) * 0.8, o * 1.5, TRIM, S.dark);
  }
  const rise = h - s3 - fin;
  roofOn(M, S, { cx: 0, cz: 0, w: bw, d: bd, y: s3, ex: bf.ex, flat: true }, 'spire', rise);
  M.strut([0, h - fin, 0], [0, h, 0], u * 0.02, ACC, rgb(S.P.accent[0]));
  return null;
}

const CONTAINERS = [['accent', 1], ['accent', 0], ['primary', 0], ['green', 1], ['corten', 0], ['accent', 2], ['roof', 3], ['corten', 1], ['concrete', 2], ['ruby', 0]];
const flatQuad = (M, xa, xb, za, zb, y, part, col) => M.quad([xa, y, zb], [xb, y, zb], [xb, y, za], [xa, y, za], part, col);

// lockfile: container terminal with stacked boxes, a quay and a gantry crane.
function buildPort(M, S) {
  const { w, d, h, u } = S, rng = S.rng;
  const pa = Math.min(h * 0.05, u * 0.04), qz = d / 2 - d * 0.2, conc = rgb(S.P.concrete[1]);
  M.box(-w / 2, w / 2, 0, pa, -d / 2, qz, [POD, rgb(S.P.concrete[2])], [POD, conc]);
  M.box(-w / 2, w / 2, 0, pa * 0.4, qz, d / 2, [POD, rgb(S.P.concrete[2])], [POD, rgb(S.P.water[0])]);
  for (const k of [0.3, 0.62, 0.86]) { // wave glints
    const z = qz + (d / 2 - qz) * k, x = -w / 2 + w * (0.15 + rng() * 0.5);
    flatQuad(M, x, x + w * 0.12, z - u * 0.012, z + u * 0.012, pa * 0.4 + 0.004, POD, rgb(S.P.water[1]));
  }
  const Hc = clamp(h * 0.13, 0.25, u * 0.1), Wc = Hc * 0.95, Lc = Hc * 2.4, cols = CONTAINERS.map(([r, i]) => rgb(S.P[r][i]));
  const nc = clamp(Math.floor(w * 0.9 / (Lc * 1.1)), 2, 7), z0r = -d / 2 + Wc * 0.8, zEnd = qz - d * 0.3;
  const nr = clamp(Math.floor((zEnd - z0r) / (Wc * 1.15)), 1, 4), maxLv = clamp(Math.floor(h * 0.7 / Hc), 1, 3);
  for (let i = 0; i < nc; i++) for (let r = 0; r < nr; r++) {
    if (rng() < 0.1) continue;
    const x = -w * 0.45 + (i + 0.5) * (w * 0.9 / nc), z = z0r + Wc * 0.5 + r * Wc * 1.15;
    const lv = 1 + Math.floor(rng() * (maxLv - (r === nr - 1 && maxLv > 1 ? 1 : 0)));
    for (let l = 0; l < lv; l++) {
      const c = cols[Math.floor(rng() * cols.length)];
      M.box(x - Lc / 2, x + Lc / 2, pa + l * Hc, pa + (l + 1) * Hc, z - Wc / 2, z + Wc / 2, [WALL, c], [WALL, c], ['nx', 'nz']);
    }
  }
  // gantry crane at the quay edge
  const cc = rgb(S.P.accent[rng() < 0.5 ? 0 : 1]), xc = w * 0.2 * (rng() < 0.5 ? -1 : 1), t = Math.max(u * 0.03, 0.05), Hg = h;
  const gx = Lc * 1.0, zl = qz - u * 0.22, zf = qz - u * 0.03, ztip = d / 2 - u * 0.03, zbk = zl - u * 0.1;
  for (const sx of [-1, 1]) for (const z of [zl, zf]) M.box(xc + sx * gx - t / 2, xc + sx * gx + t / 2, pa, Hg, z - t / 2, z + t / 2, [ACC, cc], null, ['nx', 'nz', 'top']);
  for (const z of [zl, zf]) M.box(xc - gx - t / 2, xc + gx + t / 2, Hg - t, Hg, z - t / 2, z + t / 2, [ACC, cc], [ACC, cc], ['nx', 'nz']);
  for (const sx of [-1, 1]) M.box(xc + sx * gx - t / 2, xc + sx * gx + t / 2, Hg, Hg + t * 0.8, zbk, ztip, [ACC, cc], [ACC, cc], ['nx', 'nz']);
  const apex = [xc, Hg + u * 0.17, (zl + zf) / 2];
  M.strut(apex, [xc, Hg + t * 0.4, ztip], t * 0.35, TRIM, S.steel);
  M.strut(apex, [xc, Hg + t * 0.4, zbk], t * 0.35, TRIM, S.steel);
  for (const sx of [-1, 1]) M.strut(apex, [xc + sx * gx, Hg, (zl + zf) / 2], t * 0.5, ACC, cc);
  const zt = qz - Wc * 0.2, hy = pa + Hc * 2.3, hc = cols[Math.floor(rng() * cols.length)];
  M.box(xc - t, xc + t, Hg + t * 0.8, Hg + t * 1.6, zt - t, zt + t, [TRIM, S.dark], [TRIM, S.dark]);
  M.strut([xc, Hg + t * 0.8, zt], [xc, hy + Hc, zt], t * 0.18, TRIM, S.steel);
  M.box(xc - Lc / 2, xc + Lc / 2, hy, hy + Hc, zt - Wc / 2, zt + Wc / 2, [WALL, hc], [WALL, hc], ['nx', 'nz']);
  return null;
}

// deploy: control tower, curved-roof hangar, terminal, runway with markings and a little plane.
function buildAirport(M, S) {
  const { w, d, h, u } = S, rng = S.rng;
  S.nb = 2;
  const pa = Math.min(h * 0.04, u * 0.04), ap = rgb(S.P.concrete[1]), asp = rgb(S.P.metal[1]), wh = S.white;
  M.box(-w / 2, w / 2, 0, pa, -d / 2, d / 2, [POD, rgb(S.P.concrete[2])], [POD, ap]);
  const rz0 = d / 2 - d * 0.3, rz1 = d / 2 - d * 0.04, rx0 = -w / 2 + w * 0.02, rx1 = w / 2 - w * 0.02, ry = pa + Math.max(u * 0.008, 0.012);
  M.box(rx0, rx1, pa, ry, rz0, rz1, [POD, asp], [POD, asp], ['nx', 'nz']);
  const my = ry + 0.004, rl = rx1 - rx0, rw = rz1 - rz0, rc = (rz0 + rz1) / 2;
  for (let k = 0; k < 6; k++) { const xa = rx0 + rl * (0.2 + k * 0.12); flatQuad(M, xa, xa + rl * 0.07, rc - rw * 0.025, rc + rw * 0.025, my, POD, wh); }
  for (const sd of [0, 1]) for (let k = 0; k < 4; k++) { // threshold bars
    const xa = sd ? rx1 - rl * 0.07 : rx0 + rl * 0.02, zc = rz0 + rw * (0.2 + k * 0.2);
    flatQuad(M, xa, xa + rl * 0.05, zc - rw * 0.03, zc + rw * 0.03, my, POD, wh);
  }
  // hangar: barrel vault, axis along z so the arch faces the camera
  const hw = w * 0.3, hdp = d * 0.4, hh = h * 0.5, wl = hh * 0.4, rx = hw / 2, ry2 = hh - wl, ns = 6;
  const hx = -w / 2 + w * 0.07 + rx, hz = -d / 2 + d * 0.07, hz1 = hz + hdp;
  const pts = [[-rx, 0], [-rx, wl]];
  for (let k = 1; k < ns; k++) { const a = Math.PI - Math.PI * k / ns; pts.push([rx * Math.cos(a), wl + ry2 * Math.sin(a)]); }
  pts.push([rx, wl], [rx, 0]);
  const inside = [hx, pa + wl * 0.6, (hz + hz1) / 2], hc = [rgb(S.P.metal[2]), rgb(S.P.metal[0])];
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1], c = hc[i & 1];
    M.quad([hx + p[0], pa + p[1], hz], [hx + q[0], pa + q[1], hz], [hx + q[0], pa + q[1], hz1], [hx + p[0], pa + p[1], hz1], ROOF, c, inside);
    M.tri([hx, pa, hz1], [hx + p[0], pa + p[1], hz1], [hx + q[0], pa + q[1], hz1], WALL, hc[0], inside);
  }
  const hg = { x1: hx + rx, z1: hz1, x0: hx - rx, z0: hz, u };
  put(M, hg, 0, hx - rx * 0.6, hx + rx * 0.6, pa, pa + wl * 1.35, Math.max(u * 0.01, 0.006), TRIM, S.dark);
  // terminal + tower on the right
  const tx = w * 0.17, tz = -d / 2 + d * 0.2, tw = w * 0.42, td = d * 0.24, th = h * 0.26;
  block(M, S, { cx: tx, cz: tz, w: tw, d: td, y0: pa, y1: pa + th, ground: false, last: true });
  const tg = rectG(tx, tz, tw, td);
  if (S.style === 'default') windows(M, tg, { ya: pa + th * 0.18, yb: pa + th * 0.8, n: 1, ribbon: true, rib: 0.84, wh: 0.5, col: S.win, part: GLASS });
  const kx = tx + tw / 2 - u * 0.1, kz = tz + td * 0.1, ks = u * 0.055, kh = h * 0.72, cabH = h * 0.1, cab = ks * 1.9;
  M.box(kx - ks, kx + ks, pa, kh, kz - ks, kz + ks, [WALL, wh], null, ['top']);
  band(M, rectG(kx, kz, ks * 2, ks * 2), pa + kh * 0.45, pa + kh * 0.5, ks * 0.25, [ACC, S.accent], [ACC, S.accent]);
  M.box(kx - cab, kx + cab, kh, kh + cabH, kz - cab, kz + cab, [GLASS, rgb(S.P.glass[0])], null, ['top']);
  M.box(kx - cab * 1.2, kx + cab * 1.2, kh + cabH, kh + cabH * 1.25, kz - cab * 1.2, kz + cab * 1.2, [ACC, S.accent], [ACC, S.accent]);
  M.strut([kx, kh + cabH * 1.25, kz], [kx, h, kz], ks * 0.2, TRIM, S.alu);
  // plane on the apron, nose to +x
  const px = -w * 0.05, pz = rz0 - d * 0.1, L = w * 0.2, pw = u * 0.075, py = pa + pw * 0.3;
  M.box(px - L / 2, px + L / 2, py, py + pw, pz - pw / 2, pz + pw / 2, [ACC, wh], [ACC, wh]);
  M.box(px + L / 2, px + L / 2 + pw * 0.5, py + pw * 0.15, py + pw * 0.85, pz - pw * 0.3, pz + pw * 0.3, [ACC, wh], [ACC, wh], ['nx']);
  M.box(px - L * 0.05, px + L * 0.2, py + pw * 0.4, py + pw * 0.55, pz - L * 0.5, pz + L * 0.5, [ACC, S.alu], [ACC, S.alu]);
  M.box(px - L / 2, px - L * 0.32, py + pw, py + pw * 2.2, pz - pw * 0.08, pz + pw * 0.08, [ACC, S.accent], [ACC, S.accent]);
  return null;
}

// dead code: broken walls, holes, rubble, weeds.
function buildRuin(M, S) {
  const { w, d, h, u } = S, rng = S.rng, t = Math.max(u * 0.07, 0.05), sl = Math.max(u * 0.03, 0.02);
  const wc = [WALL, S.wall], tc = [TRIM, S.trim], eg = Math.max(u * 0.012, 0.006), dk = S.dark;
  M.box(-w / 2, w / 2, 0, sl, -d / 2, d / 2, [POD, S.base], [POD, rgb(S.P.concrete[2])]);
  const pat = (a) => a.map(v => clamp(v * (0.85 + rng() * 0.3), 0.12, 1) * h);
  const tops = [], z0 = -d / 2 + t, z1 = d / 2 - t;
  // a wall run: columns with flat or slanted broken tops, one window hole where it stands tall
  const run = (n, P, fn) => {
    for (let i = 0; i < n; i++) {
      const Pa = P[i], Pb = P[Math.min(i + 1, n - 1)], slant = rng() < 0.4, ha = Pa, hb = slant ? (Pa + Pb) / 2 : Pa;
      fn(i, ha, hb, Math.min(ha, hb) > h * 0.62 && i % 2 === 1);
    }
  };
  const PF = pat([0.62, 0.95, 0.3, 0.2, 0.55, 1.0]);
  run(6, PF, (i, ha, hb, hole) => {
    const xa = -w / 2 + w * i / 6, xb = xa + w / 6, zf = d / 2 - t;
    if (hole) {
      M.box(xa, xb, sl, h * 0.2, zf, d / 2, wc, tc);
      M.boxH(xa, xb, zf, d / 2, h * 0.46, [ha, hb, ha, hb], wc, tc);
    } else M.boxH(xa, xb, zf, d / 2, sl, [ha, hb, ha, hb], wc, tc);
    tops.push([(xa + xb) / 2, Math.max(ha, hb), d / 2 - t / 2]);
  });
  const PR = pat([0.3, 0.55, 0.85, 0.95]);
  run(4, PR, (i, ha, hb, hole) => {
    const za = z0 + (z1 - z0) * i / 4, zb = za + (z1 - z0) / 4;
    if (hole) {
      M.box(w / 2 - t, w / 2, sl, h * 0.2, za, zb, wc, tc);
      M.boxH(w / 2 - t, w / 2, za, zb, h * 0.46, [ha, ha, hb, hb], wc, tc);
    } else M.boxH(w / 2 - t, w / 2, za, zb, sl, [ha, ha, hb, hb], wc, tc);
    tops.push([w / 2 - t / 2, Math.max(ha, hb), (za + zb) / 2]);
  });
  for (let i = 0; i < 2; i++) { // left wall: nearly gone
    const za = z0 + (z1 - z0) * i / 2, a = h * (0.08 + rng() * 0.2);
    M.box(-w / 2, -w / 2 + t, sl, a, za, za + (z1 - z0) / 2, wc, tc);
  }
  const PB = pat([0.5, 0.78, 0.6]); // back wall: its inner face is what you see through the broken front
  for (let i = 0; i < 3; i++) M.box(-w / 2 + w * i / 3, -w / 2 + w * (i + 1) / 3, sl, PB[i], -d / 2, -d / 2 + t, wc, tc, ['nz', 'nx']);
  const bg = { z1: -d / 2 + t, x1: 0, u };
  for (const i of [1, 2]) if (PB[i] > h * 0.5) { const a = -w / 2 + w * (i + 0.5) / 3; put(M, bg, 0, a - w * 0.045, a + w * 0.045, h * 0.22, h * 0.42, eg, GLASS, dk); }
  // collapsed heap + loose blocks where the front gave way
  M.taper(-w * 0.1, d * 0.28, w * 0.34, d * 0.2, w * 0.12, d * 0.07, sl, sl + h * 0.14, wc, tc);
  const bits = [S.wall, S.trim, S.pick('concrete', 2)];
  for (let k = 0; k < 6; k++) {
    const s2 = u * (0.04 + rng() * 0.05), x = -w * 0.4 + rng() * w * 0.5, z = -d * 0.05 + rng() * d * 0.4, c = bits[k % 3];
    M.box(x - s2, x + s2, sl, sl + s2 * (0.8 + rng()), z - s2 * 0.8, z + s2 * 0.8, [WALL, c], [TRIM, c], ['nx', 'nz']);
  }
  const rust = rgb(S.P.corten[1]), tall = tops.slice().sort((a, b) => b[1] - a[1]);
  for (let k = 0; k < 2; k++) { // bent rebar
    const [x, y, z] = tall[k], dx = (rng() - 0.5) * u * 0.1;
    M.strut([x, y, z], [x + dx, y + u * 0.12, z - u * 0.02], u * 0.012, TRIM, rust);
  }
  // charred rafters leaning in from the right wall
  const wood = rgb(S.P.wood[0]);
  M.strut([w / 2 - t, h * 0.6, 0], [w * 0.12, sl, -d * 0.12], u * 0.025, TRIM, rgb(S.P.accent[3]));
  M.strut([w / 2 - t, h * 0.5, d * 0.2], [w * 0.2, sl, d * 0.05], u * 0.02, TRIM, wood);
  const gr = [rgb(S.P.green[0]), rgb(S.P.green[1])];
  const tuft = (x, y, z, r, hh, k) => M.loft(x, z, [[y, r, r], [y + hh, 0, 0]], 3, [ROOF, gr[k & 1]]);
  for (let k = 0; k < 5; k++) { const [x, y, z] = tops[(k * 2 + 1) % tops.length]; tuft(x, y, z, u * 0.04, u * 0.1, k); }
  for (let k = 0; k < 4; k++) tuft(-w * 0.4 + rng() * w * 0.7, sl, -d * 0.3 + rng() * d * 0.55, u * 0.04, u * (0.07 + rng() * 0.05), k + 1);
  const gv = { z1: d / 2, x1: w / 2, u }; // ivy strips on the front wall
  for (let k = 0; k < 3; k++) {
    const a = w * (0.3 + k * 0.22) - w / 2, hh = Math.min(h * (0.25 + rng() * 0.3), PF[Math.min(5, Math.floor((a + w / 2) / (w / 6)))] * 0.9);
    put(M, gv, 0, a, a + u * 0.05, sl, sl + hh, eg, ROOF, gr[k & 1]);
  }
  return null;
}

// brand-new file: foundation, half-built frame, scaffolding, tower crane, materials.
function buildSite(M, S) {
  const { w, d, h, u } = S, rng = S.rng, sh = Math.max(u * 0.03, 0.04);
  const conc = rgb(S.P.concrete[0]), conc2 = rgb(S.P.concrete[1]), wood = rgb(S.P.wood[0]);
  M.box(-w / 2, w / 2, 0, sh, -d / 2, d / 2, [POD, rgb(S.P.concrete[2])], [POD, conc2]);
  const bw = w * 0.6, bd = d * 0.54, bx = -w * 0.14, bz = -d * 0.16, fh = h / 3.5, c = Math.max(u * 0.045, 0.05);
  const x0 = bx - bw / 2, x1 = bx + bw / 2, z0 = bz - bd / 2, z1 = bz + bd / 2;
  const colH = [[3.4, 3.4, 2.5], [3.4, 2.6, 2.0]]; // front row, back row (floors reached)
  for (let r = 0; r < 2; r++) for (let i = 0; i < 3; i++) {
    const x = x0 + c / 2 + (bw - c) * i / 2, z = r ? z0 + c / 2 : z1 - c / 2, top = sh + fh * colH[r][i];
    M.box(x - c / 2, x + c / 2, sh, top, z - c / 2, z + c / 2, [TRIM, conc], [TRIM, conc], ['nx', 'nz']);
    if (colH[r][i] < 3) M.strut([x, top, z], [x + c * 0.2, top + fh * 0.3, z], c * 0.14, TRIM, rgb(S.P.corten[1])); // rebar
  }
  M.box(x0, x1, sh + fh - c, sh + fh, z0, z1, [TRIM, conc], [TRIM, conc]);                 // first slab
  M.box(x0, x1, sh + fh * 2 - c, sh + fh * 2, z0, z0 + bd * 0.7, [TRIM, conc], [TRIM, conc]); // second slab, unfinished
  const bk = rgb(S.P.brick[0]);
  M.box(x0 + c, x1 - c, sh, sh + fh * 0.5, z1 - c * 0.8, z1, [WALL, bk], [TRIM, conc2], ['nx', 'nz']); // half-height brick wall
  // scaffolding on the front face
  const sg = z1 + c * 1.4, st = c * 0.4, alu = S.alu, ps = [x0, x0 + bw * 0.5, x1];
  for (const x of ps) M.box(x - st / 2, x + st / 2, sh, sh + fh * 2.7, sg - st / 2, sg + st / 2, [TRIM, alu], null, ['nx', 'nz']);
  for (const k of [1, 2]) {
    const y = sh + fh * k * 0.95;
    M.box(x0, x1, y - st, y, sg - c * 0.9, sg + c * 0.6, [TRIM, wood], [TRIM, wood], ['nx', 'nz']);
  }
  M.strut([x0, sh, sg], [x0 + bw * 0.5, sh + fh * 1.9, sg], st * 0.7, TRIM, alu);
  const sy = sh + fh * 1.95, nt = rgb(S.P.green[1]);
  M.quad([x0, sy, sg + c * 0.7], [x1, sy, sg + c * 0.7], [x1, sy + fh * 0.7, sg + c * 0.7], [x0, sy + fh * 0.7, sg + c * 0.7], WALL, nt);
  // tower crane, back right
  const kx = x1 + u * 0.1, kz = bz - bd * 0.2, t = Math.max(u * 0.035, 0.05), Hm = h * 0.98, Lj = u * 0.7;
  M.box(kx - t * 1.4, kx + t * 1.4, sh, sh + t, kz - t * 1.4, kz + t * 1.4, [POD, conc2], [TRIM, conc]);
  M.strut([kx, sh + t, kz], [kx, Hm * 0.93, kz], t, ACC, rgb(S.P.accent[0]));
  M.strut([kx - Lj * 0.3, Hm * 0.93, kz], [kx + Lj, Hm * 0.93, kz], t * 0.7, ACC, rgb(S.P.accent[0]), true);
  M.box(kx - Lj * 0.3 - t, kx - Lj * 0.3 + t, Hm * 0.93 - t * 1.5, Hm * 0.93 - t * 0.2, kz - t, kz + t, [TRIM, conc2], [TRIM, conc]);
  M.strut([kx, Hm * 0.93, kz], [kx, Hm, kz], t * 0.6, ACC, rgb(S.P.accent[0]));
  M.strut([kx + Lj * 0.7, Hm * 0.93, kz], [kx + Lj * 0.7, Hm * 0.55, kz], t * 0.15, TRIM, S.steel);
  M.box(kx + Lj * 0.7 - t * 0.6, kx + Lj * 0.7 + t * 0.6, Hm * 0.55 - t, Hm * 0.55, kz - t * 0.6, kz + t * 0.6, [ACC, rgb(S.P.accent[1])], [ACC, rgb(S.P.accent[1])]);
  // yard: brick pallets, sand, pipes, cabin, cones
  const yx = w * 0.18, yz = d * 0.3;
  M.box(yx - u * 0.12, yx + u * 0.05, sh, sh + u * 0.07, yz - u * 0.05, yz + u * 0.05, [WALL, bk], [TRIM, S.pick('wood')], ['nx', 'nz']);
  M.box(yx - u * 0.05, yx + u * 0.12, sh, sh + u * 0.05, yz + u * 0.07, yz + u * 0.15, [WALL, bk], [TRIM, S.pick('wood')], ['nx', 'nz']);
  M.taper(-w * 0.35, d * 0.34, u * 0.26, u * 0.2, u * 0.05, u * 0.04, sh, sh + u * 0.13, [WALL, rgb(S.P.ground[0])]);
  M.box(w * 0.3, w * 0.46, sh, sh + u * 0.1, -d * 0.4, -d * 0.4 + u * 0.14, [WALL, rgb(S.P.accent[0])], [ROOF, rgb(S.P.accent[0])], ['nx', 'nz']);
  M.box(w * 0.3 - 0.01, w * 0.46, sh, sh + u * 0.04, d * 0.05, d * 0.05 + u * 0.05, [WALL, S.steel], [TRIM, S.alu], ['nx', 'nz']);
  const cone = rgb(S.P.corten[0]);
  for (let k = 0; k < 3; k++) M.loft(-w * 0.1 + k * u * 0.14, d * 0.44, [[sh, u * 0.025, u * 0.025], [sh + u * 0.06, 0, 0]], 3, [ACC, cone]);
  return null;
}

// giant file: layered, cantilevered megastructure covered in greebles.
function buildMega(M, S) {
  const { w, d, h, u } = S;
  S.nb = 4;
  const y1 = h * 0.3, y2 = h * 0.55, y3 = h * 0.78, y4 = h * 0.93;
  const mid = { cx: -w * 0.07, cz: d * 0.05, w: w * 0.76, d: d * 0.7 }, up = { cx: w * 0.12, cz: -d * 0.08, w: w * 0.5, d: d * 0.52 }, cr = { cx: w * 0.2, cz: -d * 0.12, w: w * 0.22, d: d * 0.24 };
  block(M, S, { cx: 0, cz: 0, w, d, y0: 0, y1 });
  block(M, S, { ...mid, y0: y1, y1: y2, ground: false });
  block(M, S, { ...up, y0: y2, y1: y3, ground: false });
  block(M, S, { ...cr, y0: y3, y1: y4, ground: false, last: true });
  const e = u * 0.05, steel = [TRIM, S.steel], dark = [TRIM, S.dark];
  // lumps on the base roof
  M.box(w * 0.3, w * 0.48, y1, y1 + h * 0.1, d * 0.12, d * 0.4, [WALL, S.wall], [ROOF, S.flat]);
  M.box(-w * 0.48, -w * 0.3, y1, y1 + h * 0.07, -d * 0.4, -d * 0.1, [WALL, S.wall], [ROOF, S.flat]);
  // pipework down the side of the middle mass
  const mx1 = mid.cx + mid.w / 2, pr = u * 0.022;
  for (const k of [0.2, 0.45, 0.7]) M.loft(mx1 + pr * 1.5, mid.cz - mid.d / 2 + mid.d * k, [[y1, pr, pr], [y2 + h * 0.03, pr, pr]], 5, steel);
  M.box(mx1, mx1 + pr * 5, y2 - h * 0.04, y2 - h * 0.01, mid.cz - mid.d * 0.35, mid.cz + mid.d * 0.25, steel, steel, ['nx', 'nz']);
  // vent grille + hazard stripe on the base
  const bg = { z1: d / 2, x1: w / 2, u }, gx = -w * 0.3;
  for (let k = 0; k < 4; k++) put(M, bg, 0, gx, gx + w * 0.26, y1 * (0.3 + k * 0.14), y1 * (0.3 + k * 0.14) + y1 * 0.07, Math.max(u * 0.01, 0.006), TRIM, S.dark);
  for (let k = 0; k < 6; k++) {
    const a = -w * 0.5 + w * (0.05 + k * 0.16), c = k & 1 ? rgb(S.P.accent[0]) : S.dark;
    put(M, bg, 0, a, a + w * 0.08, y1 * 0.06, y1 * 0.16, Math.max(u * 0.01, 0.006), ACC, c);
  }
  // exhaust stacks + beacon
  for (const [x, z, hk, rk] of [[up.cx - up.w * 0.25, up.cz + up.d * 0.1, 0.1, 1], [up.cx - up.w * 0.05, up.cz + up.d * 0.25, 0.06, 0.8]]) {
    const r = u * 0.045 * rk;
    M.loft(x, z, [[y3, r * 1.15, r * 1.15], [y3 + h * hk, r, r]], 6, steel, { cap: dark });
  }
  const r = u * 0.014;
  M.strut([cr.cx, y4, cr.cz], [cr.cx, y4 + h * 0.05, cr.cz], r, TRIM, S.alu);
  M.box(cr.cx - r, cr.cx + r, y4 + h * 0.05, y4 + h * 0.05 + r * 2.2, cr.cz - r, cr.cz + r, [ACC, rgb(S.P.accent[1])], [ACC, rgb(S.P.accent[1])]);
  acProp(M, S, w * 0.1, y1, d * 0.28, u * 0.9);
  return null;
}

// ------------------------------------------------------------ the port city's industry
// Containers are sized from spec.cu (one container width, the same across the whole city) so a
// yard of a big manifest and a yard of a small one stack the same boxes, just more of them.

// container yard: rows of stacked boxes on a paved apron, aisles every two rows, a gantry over big yards
function buildContainers(M, S) {
  const { w, d, h, u } = S, rng = S.rng;
  const pa = Math.min(h * 0.04, u * 0.03);
  M.box(-w / 2, w / 2, 0, pa, -d / 2, d / 2, [POD, rgb(S.P.concrete[2])], [POD, rgb(S.P.concrete[1])]);
  const alongX = w >= d, L = alongX ? w : d, W = alongX ? d : w;
  const Wc = clamp(S.spec.cu || u * 0.16, u * 0.08, W * 0.45), Hc = Wc * 0.95, Lc = Math.min(Wc * 2.5, L * 0.9);
  const cols = CONTAINERS.map(([r, i]) => rgb(S.P[r][i]));
  const maxLv = clamp(Math.round(h / Hc), 1, 4);
  const nL = Math.max(1, Math.floor((L * 0.94) / (Lc * 1.06)));
  const rows = [];
  for (let z = -W / 2 + Wc * 0.6, r = 0; z + Wc / 2 <= W / 2 - Wc * 0.1; r++) { rows.push(z); z += Wc * (r % 2 ? 1.9 : 1.04); }
  M.swap = !alongX; // lay rows along local x, mirror when the long side is z
  for (const z of rows) for (let i = 0; i < nL; i++) {
    if (rng() < 0.08) continue;
    const x = -L / 2 + L * 0.03 + (i + 0.5) * (L * 0.94 / nL);
    const lv = 1 + Math.floor(rng() * maxLv);
    for (let l = 0; l < lv; l++) {
      const c = cols[Math.floor(rng() * cols.length)];
      // the camera never sees the back faces, or the top of a box with another on it
      M.box(x - Lc / 2, x + Lc / 2, pa + l * Hc, pa + (l + 1) * Hc, z - Wc / 2, z + Wc / 2, [WALL, c], [WALL, c], l < lv - 1 ? ['nx', 'nz', 'top'] : ['nx', 'nz']);
    }
  }
  if (L > Lc * 4 && W > Wc * 3) { // rubber-tyred gantry straddling the stacks
    const cc = rgb(S.P.accent[0]), t = Wc * 0.18, xg = -L / 2 + L * (0.2 + rng() * 0.6), Hg = Hc * (maxLv + 0.8);
    const za = -W / 2 + Wc * 0.15, zb = W / 2 - Wc * 0.15;
    for (const sx of [-1, 1]) for (const z of [za, zb]) M.box(xg + sx * Lc * 0.6 - t / 2, xg + sx * Lc * 0.6 + t / 2, pa, Hg, z - t / 2, z + t / 2, [ACC, cc], null, ['top']);
    for (const sx of [-1, 1]) M.box(xg + sx * Lc * 0.6 - t / 2, xg + sx * Lc * 0.6 + t / 2, Hg, Hg + t, za - t / 2, zb + t / 2, [ACC, cc], [ACC, cc]);
    M.box(xg - Lc * 0.6, xg + Lc * 0.6, Hg + t, Hg + t * 1.6, za, za + t * 1.5, [ACC, cc], [ACC, cc]);
  }
  M.swap = false;
  return null;
}

// tank farm: one to four squat cylinders inside a low bund wall
function buildTanks(M, S) {
  const { w, d, h, u } = S, rng = S.rng;
  const pa = Math.min(h * 0.04, u * 0.03), e = u * 0.03;
  M.box(-w / 2, w / 2, 0, pa, -d / 2, d / 2, [POD, rgb(S.P.concrete[2])], [POD, rgb(S.P.ground[1])]);
  for (const [x0, x1, z0, z1] of [[-w / 2, w / 2, d / 2 - e, d / 2], [-w / 2, w / 2, -d / 2, -d / 2 + e], [w / 2 - e, w / 2, -d / 2, d / 2], [-w / 2, -w / 2 + e, -d / 2, d / 2]])
    M.box(x0, x1, pa, pa * 3, z0, z1, [POD, rgb(S.P.concrete[0])], [POD, rgb(S.P.concrete[0])]);
  const nx = w > d * 1.6 ? 2 : 1, nz = d > w * 1.6 ? 2 : 1, many = u > (S.spec.cu || u) * 9 ? 2 : 1;
  const gx = Math.min(nx * many, 3), gz = Math.min(nz * many, 3);
  const R = Math.min(w / gx, d / gz) * 0.4;
  const shell = [S.white, S.alu, rgb(S.P.stone[0])][Math.floor(rng() * 3)];
  for (let i = 0; i < gx; i++) for (let k = 0; k < gz; k++) {
    const cx = -w / 2 + (i + 0.5) * w / gx, cz = -d / 2 + (k + 0.5) * d / gz;
    const Ht = Math.min(h, R * 1.5) * (0.8 + rng() * 0.2);
    M.loft(cx, cz, [[pa, R, R], [pa + Ht, R, R]], 12, [WALL, shell]);
    M.loft(cx, cz, [[pa + Ht * 0.72, R * 1.01, R * 1.01], [pa + Ht * 0.8, R * 1.01, R * 1.01]], 12, [ACC, S.accent]); // painted band
    M.loft(cx, cz, [[pa + Ht, R, R], [pa + Ht + R * 0.18, R * 0.25, R * 0.25]], 12, [ROOF, S.alu], { cap: [ROOF, S.alu] });
  }
  return null;
}

// warehouse: long corrugated shed with a shallow roof and a row of loading doors on the yard side
function buildWarehouse(M, S) {
  const { w, d, h, u } = S;
  const alongX = w >= d, L = alongX ? w : d, W = alongX ? d : w;
  const rise = Math.min(W * 0.14, h * 0.25), wallH = h - rise, e = u * 0.03;
  const tin = rgb(S.P.tin[0]), wallC = S.era === 'old' ? S.wall : S.era === 'mid' ? tin : rgb(S.P.metal[0]);
  M.swap = !alongX;
  M.box(-L / 2, L / 2, 0, wallH, -W / 2, W / 2, [WALL, wallC], null, ['top']);
  M.box(-L / 2 - e, L / 2 + e, wallH * 0.82, wallH * 0.9, W / 2, W / 2 + e, [ACC, S.accent], [ACC, S.accent]); // company stripe
  const n = clamp(Math.round(L / (wallH * 1.3)), 2, 8);
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + (i + 0.5) * L / n, dw = Math.min(L / n * 0.55, wallH * 0.9);
    M.box(x - dw / 2, x + dw / 2, 0, wallH * 0.62, W / 2, W / 2 + e * 0.6, [TRIM, S.dark], [TRIM, S.dark]);
  }
  gable(M, 0, 0, L + e * 2, W + e * 2, wallH, rise, e, 'x', S.era === 'new' ? S.flat : S.slate, WALL, wallC);
  M.swap = false;
  return null;
}

// the port's landmark: a striped lighthouse on a rock, its lamp lit
function buildLighthouse(M, S) {
  const { w, d, h, u } = S;
  const rock = rgb(S.P.stone[2]), red = rgb(S.P.accent[1]), white = S.white;
  const rb = u * 0.48, rt = u * 0.2, base = h * 0.06;
  M.loft(0, 0, [[0, rb, rb], [base, rb * 0.9, rb * 0.9]], 8, [POD, rock], { cap: [POD, rock], rot: Math.PI / 8 });
  const r0 = u * 0.3, top = h * 0.8, bands = 5;
  for (let b = 0; b < bands; b++) {
    const y0 = base + (top - base) * b / bands, y1 = base + (top - base) * (b + 1) / bands;
    const ra = r0 + (rt - r0) * b / bands, rb2 = r0 + (rt - r0) * (b + 1) / bands;
    M.loft(0, 0, [[y0, ra, ra], [y1, rb2, rb2]], 10, [WALL, b % 2 ? red : white]);
  }
  M.loft(0, 0, [[top, rt * 1.5, rt * 1.5], [top + h * 0.02, rt * 1.5, rt * 1.5]], 10, [TRIM, S.dark], { cap: [TRIM, S.dark] }); // gallery
  M.loft(0, 0, [[top + h * 0.02, rt * 0.9, rt * 0.9], [top + h * 0.11, rt * 0.9, rt * 0.9]], 8, [ACC, rgb(S.P.accent[0])]); // lamp room
  M.loft(0, 0, [[top + h * 0.11, rt * 1.1, rt * 1.1], [h, 0, 0]], 8, [ROOF, red]);
  return null;
}

// ------------------------------------------------------------ the university town
// Built along local x (the long side is x), so a quad can lay them on any side without rotating
// them: windows stay on the faces the camera sees.

// college range: walls, two or three floors of tall windows, a steep slate roof with chimneys,
// and on the longer ones a gate tower in the middle
function buildCollege(M, S) {
  const { w, d, h, u } = S, rng = S.rng;
  S.nb = 2; S.pitch = S.slate; // collegiate slate, whatever the era
  const alongX = w >= d, L = alongX ? w : d, W = alongX ? d : w;
  const rise = Math.min(W * 0.6, h * 0.45), wallH = h - rise;
  const b = block(M, S, { cx: 0, cz: 0, w, d, y0: 0, y1: wallH, last: true });
  const floors = clamp(Math.round(wallH / (u * 0.45)), 1, 3);
  lwin(M, S, rectG(0, 0, w, d), wallH * 0.1, wallH * 0.92, floors, { maxC: 6, bay: u * 0.32, ww: 0.32, wh: 0.72 });
  roofOn(M, S, { cx: 0, cz: 0, w, d, y: wallH, ex: b.ex, flat: true }, 'gable', rise, alongX ? 'x' : 'z');
  const cr = u * 0.07;
  for (const k of [-0.32, 0.32]) { // chimney stacks on the ridge
    const x = alongX ? L * k : 0, z = alongX ? 0 : L * k;
    M.box(x - cr, x + cr, wallH + rise * 0.5, h + u * 0.12, z - cr, z + cr, [WALL, S.wall], [TRIM, S.dark]);
  }
  if (L > W * 2.6 && rng() < 0.6) { // gate tower
    const tw = W * 0.62, th = h + u * 0.35;
    const t = block(M, S, { cx: 0, cz: 0, w: alongX ? tw : W * 1.08, d: alongX ? W * 1.08 : tw, y0: 0, y1: th, last: true });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { // corner turrets
      const x = sx * (alongX ? tw : W * 1.08) / 2, z = sz * (alongX ? W * 1.08 : tw) / 2, r = u * 0.06;
      M.box(x - r, x + r, th, th + u * 0.1, z - r, z + r, [TRIM, S.trim], [TRIM, S.trim]);
    }
    put(M, rectG(0, 0, alongX ? tw : W * 1.08, alongX ? W * 1.08 : tw), alongX ? 0 : 1, -tw * 0.18, tw * 0.18, 0, wallH * 0.45, Math.max(u * 0.015, 0.004), TRIM, S.dark); // archway
    void t;
  }
  return null;
}

// chapel: a tall narrow nave between buttresses, pointed windows, a spired tower at the west end
function buildChapel(M, S) {
  const { w, d, h, u } = S;
  S.nb = 2; S.pitch = S.slate;
  const alongX = w >= d, L = alongX ? w : d, W = alongX ? d : w;
  const nh = h * 0.42, rise = Math.min(W * 0.75, h * 0.25), tw = Math.min(W * 0.95, L * 0.3);
  const ax = v => alongX ? [v, 0] : [0, v];
  const [nx, nz] = ax(tw / 2);
  const nw = alongX ? L - tw : W, nd = alongX ? W : L - tw;
  const nb = block(M, S, { cx: nx, cz: nz, w: nw, d: nd, y0: 0, y1: nh, last: true, fins: false });
  lwin(M, S, rectG(nx, nz, nw, nd), nh * 0.15, nh * 0.9, 1, { maxC: 5, bay: u * 0.3, ww: 0.28, wh: 0.9, col: rgb(S.P.glass[0]) });
  roofOn(M, S, { cx: nx, cz: nz, w: nw, d: nd, y: nh, ex: nb.ex, flat: true }, 'gable', rise, alongX ? 'x' : 'z');
  const n = clamp(Math.round((L - tw) / (u * 0.35)), 2, 6), bt = u * 0.06;
  for (let i = 0; i <= n; i++) { // buttresses on the side the camera sees
    const a = -L / 2 + tw + (L - tw) * i / n;
    if (alongX) M.box(a - bt, a + bt, 0, nh * 0.8, W / 2, W / 2 + bt * 1.6, [TRIM, S.trim], [TRIM, S.trim], ['nz']);
    else M.box(W / 2, W / 2 + bt * 1.6, 0, nh * 0.8, a - bt, a + bt, [TRIM, S.trim], [TRIM, S.trim], ['nx']);
  }
  const [tx, tz] = ax(-L / 2 + tw / 2), ty = h * 0.7;
  const tb = block(M, S, { cx: tx, cz: tz, w: tw, d: tw, y0: 0, y1: ty, last: true, fins: false });
  lwin(M, S, rectG(tx, tz, tw, tw), ty * 0.72, ty * 0.92, 1, { maxC: 1, ww: 0.3, wh: 0.8, col: S.dark, part: TRIM, frame: null });
  roofOn(M, S, { cx: tx, cz: tz, w: tw, d: tw, y: ty, ex: tb.ex, flat: true }, 'spire', h - ty);
  return null;
}

// library: the campus's heart. A columned portico in front of an octagonal reading room under a
// great dome with a lantern.
function buildLibrary(M, S) {
  const { w, d, h, u } = S;
  S.nb = 3;
  const stone = S.era === 'new' ? S.solid : rgb(S.P.stone[0]), trim = rgb(S.P.stone[1]);
  const ph = Math.min(h * 0.06, u * 0.1);
  M.box(-w / 2, w / 2, 0, ph, -d / 2, d / 2, [POD, S.base], [TRIM, trim]);
  const R = Math.min(w, d) * 0.4, drum = h * 0.38;
  M.loft(0, -d * 0.05, [[ph, R, R], [ph + drum, R, R]], 8, [WALL, stone], { rot: Math.PI / 8 });
  M.loft(0, -d * 0.05, [[ph + drum, R * 1.06, R * 1.06], [ph + drum + h * 0.03, R * 1.06, R * 1.06]], 8, [TRIM, trim], { rot: Math.PI / 8 });
  // tall windows round the drum, on the faces that show
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k + 0.5) * Math.PI / 4, cx = Math.cos(a), cz = Math.sin(a);
    if (cx + cz < 0.2) continue;
    const r = R * Math.cos(Math.PI / 8) + 1e-3, x = cx * r, z = -d * 0.05 + cz * r, hw = R * 0.18, tx = -cz * hw, tz = cx * hw;
    const y0 = ph + drum * 0.25, y1 = ph + drum * 0.85;
    M.quad([x - tx, y0, z - tz], [x + tx, y0, z + tz], [x + tx, y1, z + tz], [x - tx, y1, z - tz], GLASS, S.win);
  }
  const yd = ph + drum + h * 0.03, dome = [];
  for (let k = 0; k <= 5; k++) { const t = k / 5 * Math.PI / 2; dome.push([yd + Math.sin(t) * R * 0.95, Math.cos(t) * R * 0.98, Math.cos(t) * R * 0.98]); }
  M.loft(0, -d * 0.05, dome, 12, [ROOF, S.domeC || rgb(S.P.roof[3])]);
  const lr = R * 0.16, ly = yd + R * 0.95;
  M.loft(0, -d * 0.05, [[ly - R * 0.05, lr, lr], [ly + h * 0.07, lr, lr]], 6, [TRIM, S.white]);
  M.loft(0, -d * 0.05, [[ly + h * 0.07, lr * 1.2, lr * 1.2], [Math.max(h, ly + h * 0.12), 0, 0]], 6, [ROOF, S.domeC || rgb(S.P.roof[3])]);
  // portico: six columns and a pediment on the front (+z)
  const pw = R * 1.5, zf = d / 2 - u * 0.06, zb = -d * 0.05 + R * 0.85, colH = drum * 0.82, cr = Math.min(pw / 16, u * 0.04);
  M.box(-pw / 2, pw / 2, ph, ph + colH, zb - R * 0.3, zb, [WALL, stone], [TRIM, trim]);
  for (let i = 0; i < 6; i++) M.loft(-pw / 2 + cr + (pw - 2 * cr) * i / 5, zf - cr, [[ph, cr, cr], [ph + colH, cr * 0.85, cr * 0.85]], 6, [TRIM, S.white]);
  M.box(-pw / 2 - cr, pw / 2 + cr, ph + colH, ph + colH + h * 0.04, zb - R * 0.3, zf, [TRIM, trim], [TRIM, trim]);
  gable(M, 0, (zb - R * 0.3 + zf) / 2, pw + cr * 2, zf - zb + R * 0.3, ph + colH + h * 0.04, Math.min(pw * 0.2, h * 0.1), 0, 'z', S.slate, TRIM, stone);
  return null;
}

// ------------------------------------------------------------ the planned capital
// modernist slab on pilotis: an open ground floor of slim columns, a long white block with ribbon
// windows, a plant room on the roof
function buildPilotis(M, S) {
  const { w, d, h, u } = S;
  S.nb = 2;
  const alongX = w >= d, L = alongX ? w : d, W = alongX ? d : w;
  const white = S.era === 'old' ? rgb(S.P.concrete[3]) : S.era === 'mid' ? rgb(S.P.concrete[0]) : S.white;
  const legs = Math.min(h * 0.18, u * 0.45), e = u * 0.03;
  M.swap = !alongX;
  const n = clamp(Math.round(L / (W * 0.8)), 2, 9), cr = Math.min(W * 0.06, u * 0.06);
  for (let i = 0; i <= n; i++) for (const zz of [-W * 0.32, W * 0.32]) {
    const x = -L * 0.44 + L * 0.88 * i / n;
    M.box(x - cr, x + cr, 0, legs, zz - cr, zz + cr, [TRIM, S.trim], null, ['top']);
  }
  M.box(-L * 0.2, L * 0.05, 0, legs * 0.85, -W * 0.18, W * 0.18, [GLASS, S.win], [ROOF, S.flat]); // lobby
  M.box(-L / 2, L / 2, legs, h, -W / 2, W / 2, [WALL, white], [ROOF, S.flat]);
  const floors = clamp(Math.round((h - legs) / (u * 0.22)), 2, 12), fh = (h - legs) / floors;
  for (let f = 0; f < floors; f++) { // ribbon windows the length of the block
    const y0 = legs + f * fh + fh * 0.3, y1 = y0 + fh * 0.45;
    M.box(-L / 2 + e, L / 2 - e, y0, y1, W / 2, W / 2 + e * 0.3, [GLASS, S.win], null, ['nz', 'top']);
    M.box(L / 2, L / 2 + e * 0.3, y0, y1, -W / 2 + e, W / 2 - e, [GLASS, S.win], null, ['nx', 'top']);
  }
  M.box(-L * 0.15, L * 0.1, h, h + Math.min(u * 0.15, h * 0.08), -W * 0.25, W * 0.25, [WALL, white], [ROOF, S.flat]);
  M.swap = false;
  return null;
}

// congress: a long low platform, twin office towers joined by a bridge, one bowl up and one bowl down
function buildCongress(M, S) {
  const { w, d, h, u } = S;
  S.nb = 3;
  const white = S.white, conc = rgb(S.P.concrete[0]), ph = h * 0.1;
  M.box(-w / 2, w / 2, 0, ph, -d / 2, d / 2, [WALL, conc], [ROOF, white]);
  M.box(-w / 2 + u * 0.05, w / 2 - u * 0.05, ph * 0.2, ph * 0.8, d / 2, d / 2 + 1e-3, [GLASS, S.win], null, ['nz', 'top']);
  const tw = u * 0.1, tl = d * 0.3, gap = u * 0.2;
  for (const sx of [-1, 1]) { // the twin towers
    const x = sx * (gap / 2 + tw / 2);
    M.box(x - tw / 2, x + tw / 2, ph, h, -d * 0.35 - tl / 2, -d * 0.35 + tl / 2, [WALL, white], [ROOF, white]);
    const floors = 12;
    for (let f = 1; f < floors; f++) {
      const y = ph + (h - ph) * f / floors;
      M.box(x - tw / 2 - 1e-3, x + tw / 2 + 1e-3, y, y + (h - ph) / floors * 0.4, -d * 0.35 - tl / 2, -d * 0.35 + tl / 2 + 1e-3, [GLASS, S.win], null, ['nx', 'nz', 'top']);
    }
  }
  M.box(-gap / 2, gap / 2, h * 0.72, h * 0.78, -d * 0.35 - tl * 0.3, -d * 0.35 + tl * 0.3, [WALL, white], [ROOF, white]);
  const R = Math.min(w * 0.2, d * 0.36);
  const bowl = (cx, up) => {
    const rings = up
      ? [[ph, R * 0.95, R * 0.95], [ph + R * 0.35, R * 0.8, R * 0.8], [ph + R * 0.6, R * 0.5, R * 0.5], [ph + R * 0.7, 0, 0]]
      : [[ph, R * 0.25, R * 0.25], [ph + R * 0.2, R * 0.7, R * 0.7], [ph + R * 0.5, R * 1.05, R * 1.05], [ph + R * 0.56, R * 1.05, R * 1.05]];
    M.loft(cx, d * 0.12, rings, 14, [WALL, white], up ? {} : { cap: [ROOF, conc] });
  };
  bowl(-w * 0.28, true); bowl(w * 0.28, false);
  return null;
}

// cathedral: sixteen curved concrete ribs rising from a ring, glass between them
function buildCathedral(M, S) {
  const { w, d, h, u } = S;
  S.nb = 2;
  const R = Math.min(w, d) * 0.42, white = S.white, glass = rgb(S.P.glass[0]);
  M.loft(0, 0, [[0, R * 1.08, R * 1.08], [h * 0.03, R * 1.08, R * 1.08]], 16, [POD, rgb(S.P.concrete[1])], { cap: [POD, rgb(S.P.concrete[1])] });
  const prof = [[0, 1], [0.35, 0.42], [0.55, 0.36], [0.8, 0.52], [1, 0.72]];
  M.loft(0, 0, prof.map(([f, k]) => [h * 0.03 + (h * 0.97) * f * 0.92, R * k * 0.92, R * k * 0.92]), 16, [GLASS, glass]);
  const t = Math.max(u * 0.035, R * 0.07);
  for (let k = 0; k < 16; k++) {
    const a = k / 16 * TAU, c = Math.cos(a), s = Math.sin(a);
    for (let i = 0; i < prof.length - 1; i++) {
      const [f0, k0] = prof[i], [f1, k1] = prof[i + 1];
      M.strut([c * R * k0, h * 0.03 + (h * 0.97) * f0, s * R * k0], [c * R * k1, h * 0.03 + (h * 0.97) * f1, s * R * k1], t, TRIM, white, i === prof.length - 2);
    }
  }
  return null;
}

// ------------------------------------------------------------ the desert boomtown
// supertall glass tower in one of three silhouettes: twisting, sail, or crowned with a spire
function buildSupertall(M, S) {
  const { w, d, h, u } = S, rng = S.rng;
  S.nb = 3;
  const kind = ['twist', 'sail', 'crown'][Math.floor(rng() * 3)];
  const g1 = rgb(S.P.glass[rng() < 0.5 ? 0 : 3]), g2 = rgb(S.P.glass[1]), mull = rgb(S.P.metal[2]);
  const R = Math.min(w, d) * 0.5 * SQ * 0.95, base = h * 0.04;
  M.box(-w / 2, w / 2, 0, base, -d / 2, d / 2, [POD, S.base], [TRIM, S.trim]);
  if (kind === 'twist') {
    const n = 14;
    for (let k = 0; k < n; k++) {
      const y0 = base + (h - base) * k / n, y1 = base + (h - base) * (k + 1) / n, r = R * (1 - 0.25 * k / n);
      M.loft(0, 0, [[y0, r, r], [y1 - (h / n) * 0.12, r, r]], 4, [GLASS, k % 2 ? g1 : g2], { rot: Math.PI / 4 + k * 0.09 });
      M.loft(0, 0, [[y1 - (h / n) * 0.12, r * 1.02, r * 1.02], [y1, r * 1.02, r * 1.02]], 4, [TRIM, mull], { rot: Math.PI / 4 + k * 0.09, cap: k === n - 1 ? [ROOF, mull] : undefined });
    }
  } else if (kind === 'sail') {
    const prof = [[base, 1], [h * 0.45, 0.95], [h * 0.75, 0.7], [h * 0.92, 0.35], [h, 0.08]];
    M.loft(0, 0, prof.map(([y, k]) => [y, R * k, R * k * 0.75]), 4, [GLASS, g1], { rot: Math.PI / 4, cap: [ROOF, mull] });
    M.strut([R * 0.45, base, R * 0.35], [R * 0.05, h * 1.04, R * 0.04], Math.max(u * 0.04, 0.02), TRIM, mull); // the mast down its spine
  } else {
    const bands = 10, top = h * 0.8;
    for (let k = 0; k < bands; k++) {
      const y0 = base + (top - base) * k / bands, y1 = base + (top - base) * (k + 1) / bands;
      M.box(-w * 0.42, w * 0.42, y0, y1 - (y1 - y0) * 0.15, -d * 0.42, d * 0.42, [GLASS, k % 3 ? g1 : g2], null, ['top']);
      M.box(-w * 0.43, w * 0.43, y1 - (y1 - y0) * 0.15, y1, -d * 0.43, d * 0.43, [TRIM, mull], [ROOF, mull]);
    }
    M.taper(0, 0, w * 0.86, d * 0.86, w * 0.1, d * 0.1, top, h * 0.95, [GLASS, g2], [ROOF, mull]);
    M.strut([0, h * 0.95, 0], [0, h * 1.08, 0], Math.max(u * 0.03, 0.015), TRIM, mull);
  }
  return null;
}

// the tallest tower in town: a stepped hexagonal shaft that keeps narrowing into a long needle
function buildNeedle(M, S) {
  const { w, d, h, u } = S;
  S.nb = 4;
  const R = Math.min(w, d) * 0.48, silver = rgb(S.P.metal[2]), glass = rgb(S.P.glass[0]), dark = rgb(S.P.glass[2]);
  M.loft(0, 0, [[0, R * 1.15, R * 1.15], [h * 0.02, R * 1.15, R * 1.15]], 6, [POD, S.base], { cap: [POD, S.base] });
  const tiers = 9, shaft = h * 0.78;
  let y = h * 0.02;
  for (let k = 0; k < tiers; k++) {
    const r = R * (1 - k / (tiers + 1.5)), th = (shaft - h * 0.02) / tiers;
    M.loft(0, 0, [[y, r, r], [y + th * 0.88, r * 0.97, r * 0.97]], 6, [GLASS, k % 2 ? glass : dark], { rot: k * 0.35 });
    M.loft(0, 0, [[y + th * 0.88, r * 1.01, r * 1.01], [y + th, r * 0.95, r * 0.95]], 6, [TRIM, silver], { rot: k * 0.35 });
    y += th;
  }
  M.loft(0, 0, [[shaft, R * 0.22, R * 0.22], [h * 0.9, R * 0.1, R * 0.1], [h, 0, 0]], 6, [TRIM, silver]);
  return null;
}

// ------------------------------------------------------------ the farm village
// barn: red boards under a gambrel roof, white trim, big doors on the gable end, a hay loft door
function buildBarn(M, S) {
  const { w, d, h, u } = S;
  const alongX = w >= d, L = alongX ? w : d, W = alongX ? d : w;
  const red = rgb(S.P.brick[S.era === 'new' ? 2 : 0]), white = S.white, roofC = S.era === 'old' ? rgb(S.P.roof[1]) : S.slate;
  const wallH = h * 0.45, k1 = h * 0.78; // eaves, knee of the gambrel
  M.swap = !alongX;
  M.box(-L / 2, L / 2, 0, wallH, -W / 2, W / 2, [WALL, red], null, ['top']);
  // gambrel: steep lower slopes, shallow upper ones (built as two gables' worth of quads)
  const e = u * 0.04, wk = W * 0.32;
  for (const sz of [-1, 1]) {
    M.quad([-L / 2 - e, wallH, sz * (W / 2 + e)], [L / 2 + e, wallH, sz * (W / 2 + e)], [L / 2 + e, k1, sz * wk], [-L / 2 - e, k1, sz * wk], ROOF, roofC, [0, wallH, 0]);
    M.quad([-L / 2 - e, k1, sz * wk], [L / 2 + e, k1, sz * wk], [L / 2 + e, h, 0], [-L / 2 - e, h, 0], ROOF, roofC, [0, wallH, 0]);
  }
  for (const sx of [-1, 1]) { // the gable ends, filled in
    const x = sx * L / 2;
    M.quad([x, wallH, -W / 2], [x, wallH, W / 2], [x, k1, wk], [x, k1, -wk], WALL, red, [0, wallH, 0]);
    M.quad([x, k1, -wk], [x, k1, wk], [x, h, 0], [x, h, 0], WALL, red, [0, wallH, 0]);
    M.tri([x, k1, -wk], [x, k1, wk], [x, h, 0], WALL, red, [0, k1, 0]);
  }
  const o = Math.max(u * 0.01, 0.003), dw = W * 0.5;
  // doors on the end the camera sees, with the white X brace, and the loft door above
  M.quad([L / 2 + o, 0, -dw / 2], [L / 2 + o, 0, dw / 2], [L / 2 + o, wallH * 0.8, dw / 2], [L / 2 + o, wallH * 0.8, -dw / 2], TRIM, white, [0, wallH * 0.4, 0]);
  M.quad([L / 2 + o * 2, wallH * 0.06, -dw / 2 + dw * 0.08], [L / 2 + o * 2, wallH * 0.06, dw / 2 - dw * 0.08], [L / 2 + o * 2, wallH * 0.74, dw / 2 - dw * 0.08], [L / 2 + o * 2, wallH * 0.74, -dw / 2 + dw * 0.08], TRIM, red, [0, wallH * 0.4, 0]);
  M.quad([L / 2 + o, k1 * 0.95, -W * 0.1], [L / 2 + o, k1 * 0.95, W * 0.1], [L / 2 + o, k1 * 0.95 + (h - k1) * 0.5, W * 0.1], [L / 2 + o, k1 * 0.95 + (h - k1) * 0.5, -W * 0.1], TRIM, S.dark, [0, wallH * 0.4, 0]);
  M.box(-L / 2, L / 2, wallH * 0.98, wallH, W / 2, W / 2 + o, [TRIM, white], null, ['nz', 'top']); // eave trim
  M.swap = false;
  return null;
}

// silo: a tall corrugated cylinder with a domed cap, a ladder, often a shorter twin beside it
function buildSilo(M, S) {
  const { w, d, h, u } = S, rng = S.rng;
  const R = Math.min(w, d) * 0.3, steel = S.era === 'old' ? rgb(S.P.concrete[0]) : S.alu, cap = S.era === 'old' ? rgb(S.P.roof[3]) : S.steel;
  const one = (x, z, r, H) => {
    M.loft(x, z, [[0, r, r], [H, r, r]], 10, [WALL, steel]);
    for (let k = 1; k < 4; k++) M.loft(x, z, [[H * k / 4, r * 1.03, r * 1.03], [H * k / 4 + H * 0.015, r * 1.03, r * 1.03]], 10, [TRIM, S.trim]);
    M.loft(x, z, [[H, r * 1.04, r * 1.04], [H + r * 0.45, r * 0.6, r * 0.6], [H + r * 0.7, 0, 0]], 10, [ROOF, cap]);
    M.box(x + r * 0.95, x + r * 1.05, 0, H, z - r * 0.1, z + r * 0.1, [TRIM, S.dark], null, ['top']); // ladder
  };
  one(-w * 0.15, -d * 0.1, R, h * 0.85);
  if (rng() < 0.6) one(w * 0.28, d * 0.22, R * 0.75, h * 0.6);
  return null;
}

// windmill: a white tapered tower, a cap, and four latticed sails
function buildWindmill(M, S) {
  const { w, d, h, u } = S;
  const R = Math.min(w, d) * 0.32, white = S.white, cap = rgb(S.P.roof[1]), sail = rgb(S.P.accent[2]);
  const top = h * 0.62;
  M.loft(0, 0, [[0, R, R], [top, R * 0.62, R * 0.62]], 8, [WALL, white], { rot: Math.PI / 8 });
  M.loft(0, 0, [[top, R * 0.7, R * 0.7], [top + R * 0.5, R * 0.4, R * 0.4], [top + R * 0.75, 0, 0]], 8, [ROOF, cap], { rot: Math.PI / 8 });
  put(M, rectG(0, 0, R * 1.6, R * 1.6), 0, -R * 0.15, R * 0.15, 0, h * 0.12, Math.max(u * 0.01, 0.003), TRIM, S.dark); // door
  const hub = [R * 0.35, top + R * 0.25, R * 0.75], L = (h - top) * 1.15, t = Math.max(u * 0.02, R * 0.07);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2, dx = Math.cos(a), dy = Math.sin(a);
    const tip = [hub[0] + dx * L * 0.7, hub[1] + dy * L, hub[2] + dx * L * 0.25];
    M.strut(hub, tip, t, TRIM, cap, true);
    const off = [-dy * L * 0.12 * 0.7, dx * L * 0.12, -dy * L * 0.12 * 0.25]; // the sail cloth beside the stock
    const p0 = hub.map((v, i) => v + (tip[i] - v) * 0.25), p1 = tip;
    M.quad(p0, p1, p1.map((v, i) => v + off[i]), p0.map((v, i) => v + off[i]), ACC, sail, null);
    M.quad(p0.map((v, i) => v + off[i]), p1.map((v, i) => v + off[i]), p1, p0, ACC, sail, null);
  }
  return null;
}

// hay bales: a few round bales lying in the field (a dataset's own marker)
function buildBales(M, S) {
  const { w, d, h, u } = S, rng = S.rng;
  const r = Math.min(u * 0.18, h * 0.5), hay = rgb(S.P.accent[0]), n = 2 + Math.floor(rng() * 4);
  for (let k = 0; k < n; k++) {
    const x = (rng() - 0.5) * w * 0.7, z = (rng() - 0.5) * d * 0.7;
    // lying on its side: a short cylinder along x (lofted upright, then laid down by swapping y/x)
    const ring = [];
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; ring.push([Math.cos(a) * r, r + Math.sin(a) * r]); }
    for (let i = 0; i < 8; i++) {
      const [y0z, y0] = ring[i], [y1z, y1] = ring[(i + 1) % 8];
      M.quad([x - r * 0.6, y0, z + y0z], [x + r * 0.6, y0, z + y0z], [x + r * 0.6, y1, z + y1z], [x - r * 0.6, y1, z + y1z], ROOF, hay, [x, r, z]);
    }
    for (const sx of [-1, 1]) for (let i = 0; i < 8; i++) {
      const [az, ay] = ring[i], [bz, by] = ring[(i + 1) % 8];
      M.tri([x + sx * r * 0.6, r, z], [x + sx * r * 0.6, ay, z + az], [x + sx * r * 0.6, by, z + bz], WALL, hay, [x, r, z]);
    }
  }
  return null;
}

// a container ship moored in a basin: not a file, just the harbour's life. Bow towards +x.
export function shipGeometry({ len, beam, seed = 1 }) {
  const M = new Builder(), rng = mulberry32(seed * 2654435761 + 7);
  const P = PALETTE, hullC = rgb([P.primary[0], P.accent[3], P.corten[2], P.green[1]][Math.floor(rng() * 4)]);
  const red = rgb(P.accent[1]), white = rgb(P.accent[2]), dark = rgb(P.accent[3]);
  const L = len, B = beam, fb = B * 0.55, wl = B * 0.12; // freeboard, red waterline band
  const xs = -L / 2, xb = L / 2 - B * 0.9; // stern, start of the bow
  M.box(xs, xb, 0, wl, -B / 2, B / 2, [POD, red], null, ['top']);
  M.box(xs, xb, wl, fb, -B / 2, B / 2, [WALL, hullC], [ROOF, rgb(P.metal[1])]);
  // bow: a wedge closing to a point
  const tip = [L / 2, fb, 0], tipL = [L / 2 - B * 0.15, 0, 0];
  M.quad([xb, 0, B / 2], [tipL[0], 0, 0], tip, [xb, fb, B / 2], WALL, hullC, [xb, fb / 2, 0]);
  M.quad([tipL[0], 0, 0], [xb, 0, -B / 2], [xb, fb, -B / 2], tip, WALL, hullC, [xb, fb / 2, 0]);
  M.tri([xb, fb, B / 2], tip, [xb, fb, -B / 2], ROOF, rgb(P.metal[1]), [xb, 0, 0]);
  // deck cargo: bays of containers between the bridge and the bow
  const cols = CONTAINERS.map(([r, i]) => rgb(P[r][i])), ch = B * 0.22, bayL = B * 0.62;
  const x0 = xs + L * 0.24, x1 = xb - B * 0.1, rows = 3, cw = B * 0.86 / rows;
  for (let x = x0; x + bayL <= x1; x += bayL * 1.06) for (let r = 0; r < rows; r++) {
    const z = -B * 0.43 + (r + 0.5) * cw, lv = 1 + Math.floor(rng() * 3);
    for (let l = 0; l < lv; l++) {
      const c = cols[Math.floor(rng() * cols.length)];
      M.box(x, x + bayL, fb + l * ch, fb + (l + 1) * ch, z - cw * 0.47, z + cw * 0.47, [WALL, c], [WALL, c], l < lv - 1 ? ['nx', 'nz', 'top'] : ['nx', 'nz']);
    }
  }
  // the bridge at the stern, its wings, and a funnel in the company colour
  const bx0 = xs + L * 0.04, bx1 = xs + L * 0.17, bh = fb + B * 1.1;
  M.box(bx0, bx1, fb, bh, -B * 0.36, B * 0.36, [WALL, white], [ROOF, white]);
  M.box(bx1 - (bx1 - bx0) * 0.3, bx1, bh - B * 0.18, bh - B * 0.06, -B * 0.5, B * 0.5, [TRIM, white], [TRIM, white]);
  M.box(bx1 - (bx1 - bx0) * 0.31, bx1 + 1e-3, bh - B * 0.4, bh - B * 0.22, -B * 0.34, B * 0.34, [GLASS, rgb(P.glass[2])], null, ['top']);
  M.box(bx0 - B * 0.12, bx0 + B * 0.14, fb, bh + B * 0.3, -B * 0.12, B * 0.12, [ACC, red], [TRIM, dark]);
  return M.geometry();
}

const BUILDERS = { slab: buildSlab, tower: buildTower, setback: buildSetback, podium: buildPodium, house: buildHouse, shed: buildShed, plant: buildPlant, hall: buildHall, frame: buildFrame,
  cityhall: buildCityhall, courthouse: buildCourthouse, clocktower: buildClocktower, port: buildPort, airport: buildAirport, ruin: buildRuin, site: buildSite, mega: buildMega,
  containers: buildContainers, tanks: buildTanks, warehouse: buildWarehouse, lighthouse: buildLighthouse,
  college: buildCollege, chapel: buildChapel, library: buildLibrary,
  pilotis: buildPilotis, congress: buildCongress, cathedral: buildCathedral,
  supertall: buildSupertall, needle: buildNeedle,
  barn: buildBarn, silo: buildSilo, windmill: buildWindmill, bales: buildBales };

const FLAT = { old: 'flat', mid: 'flat', new: 'flat' };
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
  cityhall: FLAT, courthouse: FLAT, clocktower: FLAT, port: FLAT, airport: FLAT, ruin: FLAT, site: FLAT, mega: FLAT,
  containers: FLAT, tanks: FLAT, warehouse: FLAT, lighthouse: FLAT,
  college: FLAT, chapel: FLAT, library: FLAT,
  pilotis: FLAT, congress: FLAT, cathedral: FLAT,
  supertall: FLAT, needle: FLAT,
  barn: FLAT, silo: FLAT, windmill: FLAT, bales: FLAT,
};
// landmarks that ignore the era: a ruin is always weathered, a building site is always raw
const FORCE_ERA = { ruin: 'old', site: 'mid' };

// ------------------------------------------------------------ public API
export function buildingGeometry(spec = {}) {
  const form = BUILDERS[spec.form] ? spec.form : 'slab';
  const rng = mulberry32((spec.seed | 0) * 2654435761 + 12345);
  const S = makeStyle(FORCE_ERA[form] ? { ...spec, era: FORCE_ERA[form] } : spec, rng);
  const w = Math.max(+spec.w || 4, 1e-3), d = Math.max(+spec.d || 4, 1e-3), h = Math.max(+spec.h || 8, 1e-3);
  const props = spec.props || {};
  Object.assign(S, { spec, form, w, d, h, u: Math.min(w, d), props });
  // old slabs alternate between mansard and a flat cornice so a street isn't all roofs
  S.roof = ROOFS.includes(spec.roof) ? spec.roof : (form === 'slab' && S.era === 'old' && rng() < 0.5 ? 'flat' : DEFAULT_ROOF[form][S.era]);
  const sr = STYLE_ROOF[S.style];
  if (sr && !ROOFS.includes(spec.roof)) { const v = sr[form] ?? sr._; if (v && v !== 'default') S.roof = v; }
  S.needsDeck = !!(props.tank || props.ac || props.crane);
  const M = new Builder();
  const T = BUILDERS[form](M, S);
  if (T) addProps(M, S, T);
  return M.geometry();
}
