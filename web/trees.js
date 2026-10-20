// Trees: six low-poly species, instanced, planted where a city would have them — woods in parks,
// scattered on lawns, rows along the wider streets, one in each suburban yard. Each city plants its
// own mix (palms in LA, cherry blossom in Tokyo, cypresses in Venice…).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const hash = n => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

// a coloured, flat-shaded piece; models live in a unit box: base at y=0, height ~1
function piece(geo, hex) {
  const g = geo.toNonIndexed();
  const c = new THREE.Color(hex), n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}
const TRUNK = '#5a3b26';
const trunk = (h = 0.38, r = 0.045) => piece(new THREE.CylinderGeometry(r * 0.8, r, h, 5).translate(0, h / 2, 0), TRUNK);
const blob = (r, y, hex, sx = 1, sy = 0.85) => piece(new THREE.IcosahedronGeometry(r, 0).scale(sx, sy, sx).translate(0, y, 0), hex);

const SPECIES = {
  round: () => mergeGeometries([trunk(), blob(0.32, 0.6, '#3d6b36'), blob(0.2, 0.82, '#4f8a3f')]),
  blossom: () => mergeGeometries([trunk(), blob(0.32, 0.6, '#e8a0b8'), blob(0.2, 0.82, '#f4c4d4')]),
  autumn: () => mergeGeometries([trunk(), blob(0.32, 0.6, '#d9732f'), blob(0.2, 0.82, '#f2b14e')]),
  conifer: () => mergeGeometries([
    trunk(0.2),
    piece(new THREE.ConeGeometry(0.3, 0.42, 6).translate(0, 0.36, 0), '#24402a'),
    piece(new THREE.ConeGeometry(0.22, 0.36, 6).translate(0, 0.6, 0), '#2e5534'),
    piece(new THREE.ConeGeometry(0.13, 0.28, 6).translate(0, 0.82, 0), '#3d6b36'),
  ]),
  cypress: () => mergeGeometries([trunk(0.12, 0.04), blob(0.2, 0.55, '#24402a', 0.55, 2.4)]),
  palm: () => {
    const fronds = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      fronds.push(piece(new THREE.BoxGeometry(0.38, 0.03, 0.09).translate(0.19, 0, 0).rotateZ(-0.35).rotateY(a).translate(0, 0.95, 0), k % 2 ? '#3d6b36' : '#61944a'));
    }
    return mergeGeometries([piece(new THREE.CylinderGeometry(0.03, 0.045, 0.95, 5).translate(0, 0.475, 0), '#8a6a45'), ...fronds]);
  },
};

// which trees each city grows, by weight
const MIX = {
  paris: { round: 1 },
  manhattan: { round: 3, conifer: 1 },
  tokyo: { round: 2, blossom: 2, conifer: 1 },
  la: { palm: 3, round: 1 },
  venice: { cypress: 3, round: 1 },
  hongkong: { round: 3, palm: 1 },
  barcelona: { round: 3, palm: 1 },
  smalltown: { round: 3, conifer: 2, autumn: 2 },
  port: { conifer: 2, round: 1 },
  university: { round: 3, autumn: 2, conifer: 1, blossom: 1 },
};

function pickSpecies(kind, seed) {
  const mix = MIX[kind] || { round: 1 };
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  let r = hash(seed) * total;
  for (const [sp, w] of Object.entries(mix)) { r -= w; if (r <= 0) return sp; }
  return 'round';
}

function inPoly(x, z, poly) {
  let inside = false;
  for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
    const [xa, za] = poly[k], [xb, zb] = poly[m];
    if ((za > z) !== (zb > z) && x < xa + (z - za) / (zb - za) * (xb - xa)) inside = !inside;
  }
  return inside;
}

export function buildTrees({ layout, B, streets, unit, plateStep }) {
  const kind = layout.kind;
  // keep trees off buildings: a coarse spatial hash of building footprints
  const cell = unit, grid = new Map();
  const key = (i, j) => i * 73856093 ^ j * 19349663;
  B.forEach(b => {
    if (!(b.w > 0.01)) return;
    const r = Math.hypot(b.w, b.d) / 2;
    for (let i = Math.floor((b.x - r) / cell); i <= Math.floor((b.x + r) / cell); i++)
      for (let j = Math.floor((b.z - r) / cell); j <= Math.floor((b.z + r) / cell); j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(b);
      }
  });
  const clear = (x, z, pad) => {
    const list = grid.get(key(Math.floor(x / cell), Math.floor(z / cell))) || [];
    return !list.some(b => {
      // test in the building's own frame (it may be rotated)
      const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0), dx = x - b.x, dz = z - b.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      return Math.abs(lx) < b.w / 2 + pad && Math.abs(lz) < b.d / 2 + pad;
    });
  };

  const trees = []; // { x, z, y, s, sp, rot }
  const plant = (x, z, y, size, seed) => trees.push({ x, z, y, s: size * (0.8 + hash(seed + 3) * 0.45), sp: pickSpecies(kind, seed), rot: hash(seed + 7) * Math.PI * 2 });
  const landTop = layout.groundIsWater ? plateStep * 0.8 : 0;
  let seed = 1;

  // woods in parks, a sprinkle on lawns (lawns are where tests, docs and examples live)
  for (const b of layout.blocks) {
    if (b.type !== 'park' && b.type !== 'lawn') continue;
    const dense = b.type === 'park';
    const step = unit * (dense ? 0.42 : 0.9);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of b.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const top = landTop + plateStep * (dense ? 1.4 : 1);
    for (let x = x0 + step / 2; x < x1; x += step) {
      for (let z = z0 + step / 2; z < z1; z += step) {
        const s = seed++;
        if (!dense && hash(s + 11) > 0.45) continue;
        const px = x + (hash(s) - 0.5) * step * 0.8, pz = z + (hash(s + 1) - 0.5) * step * 0.8;
        if (inPoly(px, pz, b.poly) && clear(px, pz, unit * 0.12)) plant(px, pz, top, unit * 0.6, s);
      }
    }
  }

  // street trees along the wider streets (not in narrow alleys, never in water)
  if (streets?.curbs && kind !== 'venice') {
    const spacing = unit * 0.7;
    for (const c of streets.curbs) {
      if (c.half < unit * 0.22) continue;
      const pts = c.pts;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let t = spacing * 0.6; t < L - spacing * 0.6; t += spacing) {
          const x = a[0] + (b[0] - a[0]) * t / L, z = a[1] + (b[1] - a[1]) * t / L;
          if (streets.drivable(x, z) && clear(x, z, unit * 0.05)) plant(x, z, landTop, unit * 0.45, seed++);
        }
      }
    }
  }

  // a tree in every suburban yard
  if (kind === 'la' || kind === 'smalltown') {
    B.forEach((b, i) => {
      if (!(b.w > 0.01) || b.h > unit * 1.6) return;
      const side = hash(i + 5) > 0.5 ? 1 : -1;
      const off = Math.max(b.w, b.d) * 0.5 + unit * 0.22;
      const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
      const x = b.x + c * off * side, z = b.z - s * off * side;
      if (clear(x, z, unit * 0.05)) plant(x, z, b.y, unit * 0.55, 1000 + i);
    });
  }

  // one instanced mesh per species
  const CAP = 8000;
  if (trees.length > CAP) trees.length = CAP;
  const group = new THREE.Group();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  for (const sp of Object.keys(SPECIES)) {
    const list = trees.filter(t => t.sp === sp);
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(SPECIES[sp](), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), list.length);
    list.forEach((t, k) => {
      q.setFromAxisAngle(UP, t.rot);
      mesh.setMatrixAt(k, m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(t.s, t.s, t.s)));
      const v = 0.88 + hash(k * 3 + 1) * 0.24; // a little variation in shade
      mesh.setColorAt(k, c.setRGB(v, v, v));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  group.userData.count = trees.length;
  return group;
}
