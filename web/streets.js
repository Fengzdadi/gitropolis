// Streets, derived rather than drawn: rasterise every city block, then a vector distance transform
// tells each patch of ground how far it is from the nearest block and in which direction. That one
// field gives us, for any city layout, where the streets are (near blocks), where their centre lines
// run (where the distance peaks) and how wide each street is — so we can paint asphalt only where
// streets actually are and drive traffic down the right lanes.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const W = 1536; // field resolution; ~0.8 world units per texel for a 1000-wide city

export function buildStreets({ layout, B, files, inDeg, SIZE, t01 }) {
  const x0 = -SIZE * 0.6, S = SIZE * 1.2, tex = S / W;
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

  // --- pack: R = distance in texels, B = across-street direction (to the nearest block) mod π
  const data = new Uint8Array(W * W * 4);
  const D = new Float32Array(W * W);
  for (let p = 0; p < W * W; p++) {
    const d = vx[p] === INF ? 255 : Math.sqrt(d2(p));
    D[p] = d;
    data[p * 4] = Math.min(255, Math.round(d));
    let a = Math.atan2(vz[p], vx[p]);
    if (a < 0) a += Math.PI;
    data[p * 4 + 2] = Math.round((a / Math.PI) * 255) % 256;
    data[p * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, W, W, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  // streets are at most this far from a block (half an LA freeway); farther is open land
  const maxHalf = Math.min(250, Math.max(3, (layout.unit * 1.2) / tex));

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

  // --- lanes: every block is circled by a lane halfway between its kerb and the street's centre line,
  // so the two blocks either side of a street give it traffic in both directions
  const lanes = [];
  blocks.forEach((b, id) => {
    if (b.type === 'park') return;
    const poly = b.poly;
    let area = 0;
    for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) area += (poly[m][0] - poly[k][0]) * (poly[m][1] + poly[k][1]);
    const out = area > 0 ? 1 : -1; // sign that turns an edge normal outward
    const gaps = [];
    for (let k = 0; k < poly.length; k++) {
      const [ax, az] = poly[k], [bx, bz] = poly[(k + 1) % poly.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < tex * 2) continue;
      const nx = out * (bz - az) / L, nz = -out * (bx - ax) / L;
      // walk outward until the distance stops growing: that's the street's centre
      let best = 0;
      for (let s = 1; s < maxHalf; s++) {
        const p = sample((ax + bx) / 2 + nx * s * tex, (az + bz) / 2 + nz * s * tex);
        if (p < 0 || label[p] >= 0) break;
        if (D[p] < best - 0.5) break;
        best = Math.max(best, D[p]);
      }
      gaps.push(best);
    }
    if (!gaps.length) return;
    gaps.sort((p, q) => p - q);
    const half = gaps[Math.floor(gaps.length * 0.3)];
    if (half < 1.5) return; // alleys too narrow for a car
    lanes.push({ pts: offset(poly, out, half * tex * 0.5), lane: half * tex * 0.5, weight: 0.15 + 0.85 * Math.sqrt(weight[id] / maxW), born: born[id] });
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
  return { texture, min: new THREE.Vector2(x0, x0), size: S, texel: tex, maxHalf, lanes, boats, drivable, navigable };
}

// push a polygon outward by `d` (mitred corners, clamped so sharp corners don't spike)
function offset(poly, out, d) {
  const n = poly.length;
  return poly.map((p, k) => {
    const a = poly[(k - 1 + n) % n], b = poly[(k + 1) % n];
    const e1 = norm([p[0] - a[0], p[1] - a[1]]), e2 = norm([b[0] - p[0], b[1] - p[1]]);
    const n1 = [out * e1[1], -out * e1[0]], n2 = [out * e2[1], -out * e2[0]];
    const m = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const s = d / Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
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
    const pts = [], ok = [];
    for (let k = 0; k < r.pts.length; k++) {
      const a = r.pts[k], b = r.pts[(k + 1) % r.pts.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / step));
      for (let t = 0; t < n; t++) {
        const x = a[0] + (b[0] - a[0]) * t / n, z = a[1] + (b[1] - a[1]) * t / n;
        pts.push([x, z]);
        ok.push(kind === 'boat' ? streets.navigable(x, z) : streets.drivable(x, z));
      }
    }
    const good = ok.filter(Boolean).length;
    if (good < 3) return;
    routes.push({ ...r, kind, pts, ok, step: null, cum: null, good });
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
        if (!r.ok[lo] || !r.ok[(lo + 1) % r.ok.length]) { mesh.setMatrixAt(k, hidden); return; }
        const a = r.pts[lo], b = r.pts[(lo + 1) % r.pts.length];
        const t = (s - r.cum[lo]) / Math.max(1e-6, r.cum[lo + 1] - r.cum[lo]);
        pos.set(a[0] + (b[0] - a[0]) * t, v.type === 'boat' ? 0 : baseY, a[1] + (b[1] - a[1]) * t);
        q.setFromAxisAngle(UP, -Math.atan2(b[1] - a[1], b[0] - a[0]));
        mesh.setMatrixAt(k, m.compose(pos, q, scl.set(v.len, v.len, v.wid)));
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  return { mesh: group, update, count: vehicles.length };
}
