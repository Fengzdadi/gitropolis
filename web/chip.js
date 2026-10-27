// The easter egg (?style=chip, --style chip): any repo drawn as a circuit board, on the one board
// plan (layouts.js): every file a chip package on green solder mask, every import a copper trace from
// one chip to the other, passives and vias round them, silkscreen outlines, designators and names.
// Only loaded when it's asked for; studio.js builds the rest (light, land, the bodies, picking).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// packages lie low and flat: a big file is a thicker package, never a tower
export const chipHeight = (b, unit) => unit * (0.12 + 0.16 * Math.min(1, b.h / (unit * 6)));

// how far the leads stick out on [x, z]: from the long sides of a long package (a DIP, an SOIC),
// from all four of a squarish one (a QFP)
export function leadMargins(B, unit) {
  return B.map(b => {
    const s = Math.min(b.w, b.d), p = Math.min(unit * 0.1, s * 0.14);
    if (Math.max(b.w, b.d) < s * 1.6) return [p, p];
    return b.w > b.d ? [0, p] : [p, 0];
  });
}

// the lid, in the bodies' fragment shader: a pin-1 dimple by one corner, and the part number etched
// along the long side in two rows (left out where a package is too small, or too far, to read)
export const LID = /* glsl */`
  {
    vec2 c = vObj.xz * vSz.xz, hs = vSz.xz * 0.5;
    float s = min(hs.x, hs.y), L = max(hs.x, hs.y), lid = step(0.5, vON.y);
    float dimple = 1.0 - smoothstep(s * 0.1, s * 0.13, length(c + hs - s * 0.34));
    vec2 q = hs.x >= hs.y ? c : c.yx;
    float row = s * 0.16, ch = q.x / (row * 0.8);
    float etch = step(abs(abs(q.y) - row * 0.75), row * 0.26) * step(abs(q.x), L * 0.55) * step(0.2, fract(ch))
      * step(0.3, hash2(vec2(floor(ch), sign(q.y)) + vInfo.x * 17.0)) * step(uWin * 1.8, s)
      * (1.0 - smoothstep(0.3, 0.8, fwidth(ch)));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3), lid * max(dimple * 0.8, etch * 0.6));
  }`;

// the leads: one flat box under each body as big as its whole footprint, cut in the shader to a row
// of leads in the margin round the body
const LEADS = /* glsl */`
  vec2 w = vObj.xz * vSz.xz;                 // from the package's centre, world units
  vec2 fw = fwidth(w) / uPitch;
  vec2 hs = vSz.xz * 0.5 - vLead;            // the body's half size
  vec2 o = abs(w) - hs;                      // how far beyond the body, along each axis
  if ((o.x > 0.0) == (o.y > 0.0)) discard;   // under the body, or a corner
  bool xSide = o.x > 0.0;                    // leads on the ±x sides are spaced along z
  float along = xSide ? w.y : w.x, span = xSide ? hs.y : hs.x, f = xSide ? fw.y : fw.x;
  float n = max(1.0, floor(span * 2.0 / uPitch - 0.3));
  float t = (along + n * uPitch * 0.5) / uPitch; // counted from the first lead
  if (t < 0.0 || t > n) discard;
  float lead = step(0.22, fract(t)) * step(fract(t), 0.78);
  float far = smoothstep(0.35, 0.7, f);      // too fine to draw one by one: a dimmer strip
  if (far < 0.5 && lead < 0.5) discard;
  diffuseColor.rgb *= mix(1.0, 0.6, far);
  if (uFocus >= 0.0) diffuseColor.rgb *= mix(0.35, 1.0, vFocus);`;

export function buildLeads({ bodies, B, H, leads, unit, S, shared, grow }) {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  for (const k of ['aInfo', 'aDied', 'aFocus']) geo.setAttribute(k, bodies.geometry.attributes[k]); // the bodies' own buffers
  geo.setAttribute('aLead', new THREE.InstancedBufferAttribute(Float32Array.from(leads.flat()), 2));
  const mat = new THREE.MeshStandardMaterial({ color: S.leads, roughness: 0.35, metalness: 0.7 });
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uTimeline: shared.uTimeline, uFocus: shared.uFocus, uPitch: { value: unit * 0.09 } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aInfo; attribute vec2 aLead; attribute float aDied, aFocus; uniform float uTimeline;
        varying vec3 vObj, vSz; varying vec2 vLead; varying float vFocus;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${grow}
        vObj = position; vLead = aLead; vFocus = aFocus;
        vSz = vec3(length(instanceMatrix[0].xyz), 0.0, length(instanceMatrix[2].xyz));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uFocus, uPitch; varying vec3 vObj, vSz; varying vec2 vLead; varying float vFocus;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${LEADS}`);
  };
  const mesh = new THREE.InstancedMesh(geo, mat, B.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  B.forEach((b, i) => {
    q.setFromAxisAngle(UP, b.rot || 0);
    m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, H[i] * 0.3, b.d));
    mesh.setMatrixAt(i, m);
  });
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

// A part (or a trace) is on the board from when its file is born until it's deleted: aWhen = (born, died)
function during(material, shared, { focus = false } = {}) {
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|during${focus ? '+focus' : ''}`;
  material.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uTimeline: shared.uTimeline, uFocus: shared.uFocus });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aWhen; uniform float uTimeline;${focus ? ' attribute vec2 aEnds; uniform float uFocus; varying float vLit;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (uTimeline < aWhen.x * 0.97 + 0.03 || uTimeline > aWhen.y * 0.97 + 0.02) transformed.y -= 1e5;${focus ? `
        vLit = uFocus < 0.0 ? 1.0 : (abs(aEnds.x - uFocus) < 0.5 || abs(aEnds.y - uFocus) < 0.5) ? 1.8 : 0.3;` : ''}`);
    if (focus) sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLit;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vLit;');
  };
  return material;
}
const tag = (g, attrs) => {
  const n = g.attributes.position.count;
  for (const [name, v] of Object.entries(attrs)) {
    const a = new Float32Array(n * v.length);
    for (let k = 0; k < n; k++) a.set(v, k * v.length);
    g.setAttribute(name, new THREE.BufferAttribute(a, v.length));
  }
  return g;
};

// A small binary heap of (priority, item) for the router
function heap() {
  let f = new Float64Array(1024), s = new Int32Array(1024), n = 0;
  return {
    get size() { return n; },
    clear() { n = 0; },
    push(p, x) {
      if (n === f.length) { const f2 = new Float64Array(n * 2), s2 = new Int32Array(n * 2); f2.set(f); s2.set(s); f = f2; s = s2; }
      let k = n++;
      while (k > 0) { const up = (k - 1) >> 1; if (f[up] <= p) break; f[k] = f[up]; s[k] = s[up]; k = up; }
      f[k] = p; s[k] = x;
    },
    pop() {
      const top = s[0], p = f[--n], x = s[n];
      let k = 0;
      for (;;) {
        let c = k * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && f[c + 1] < f[c]) c++;
        if (f[c] >= p) break;
        f[k] = f[c]; s[k] = s[c]; k = c;
      }
      f[k] = p; s[k] = x;
      return top;
    },
  };
}

// The copper of the board, laid out on a grid over it, every part's footprint (its leads included)
// kept clear:
//   - each import a signal trace from one chip to the other, routed in 45° steps round the parts in
//     between, shortest connections first, a via where it turns square (a trace that can't be routed
//     in time is left out)
//   - a decoupling capacitor beside every chip, a resistor beside every third, where there's room
//   - fan-out: short stubs off some of each chip's leads to a via
//   - reference designators in silkscreen: U for the chips, C and R for the passives
export function buildBoard({ B, files, leads, unit, top, S, shared, budgetMs = 900 }) {
  const live = B.map((b, i) => !files[i].gone && b.w > 0.01);
  const when = i => [B[i].born, B[i].died ?? 2];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  B.forEach(b => { if (b.w > 0.01) { x0 = Math.min(x0, b.x - b.w / 2); x1 = Math.max(x1, b.x + b.w / 2); z0 = Math.min(z0, b.z - b.d / 2); z1 = Math.max(z1, b.z + b.d / 2); } });
  const group = new THREE.Group();
  if (!Number.isFinite(x0)) return group;
  x0 -= unit; z0 -= unit; x1 += unit; z1 += unit;
  const cell = Math.max(unit * 0.07, Math.max(x1 - x0, z1 - z0) / 300);
  const nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil((z1 - z0) / cell), NC = nx * nz;
  const ix = x => Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / cell))), iz = z => Math.min(nz - 1, Math.max(0, Math.floor((z - z0) / cell)));
  const cx = c => x0 + (c % nx + 0.5) * cell, cz = c => z0 + (Math.floor(c / nx) + 0.5) * cell;
  const owner = new Int32Array(NC); // 0: free; i + 1: part i's footprint; -1: a passive
  const used = new Uint8Array(NC); // copper already there
  // the cells whose centres fall inside a rectangle (a part only a little over a cell's edge leaves it free)
  const lo = (v, o) => Math.max(0, Math.ceil((v - o) / cell - 0.5)), hi = (v, o, n) => Math.min(n - 1, Math.floor((v - o) / cell - 0.5));
  const rect = (xa, za, xb, zb, fn) => { for (let r = lo(za, z0); r <= hi(zb, z0, nz); r++) for (let c = lo(xa, x0); c <= hi(xb, x0, nx); c++) fn(r * nx + c); };
  // (no clearance round them: inside a block the parts stand only a cell or two apart, and a margin
  // would wall the middle ones in)
  B.forEach((b, i) => { if (b.w > 0.01) rect(b.x - b.w / 2, b.z - b.d / 2, b.x + b.w / 2, b.z + b.d / 2, c => { if (!owner[c]) owner[c] = i + 1; }); });
  const free = c => owner[c] === 0 && !used[c];
  // the open ground in connected pieces: a route between two parts is only tried when some piece
  // touches both (a part packed in tight on every side has no way out, and searching for one is slow)
  const piece = new Int32Array(NC).fill(-1), stack = [];
  for (let c0 = 0, id = 0; c0 < NC; c0++) {
    if (owner[c0] || piece[c0] >= 0) continue;
    piece[c0] = id; stack.push(c0);
    while (stack.length) {
      const c = stack.pop(), x = c % nx;
      for (const c2 of [x > 0 ? c - 1 : -1, x < nx - 1 ? c + 1 : -1, c - nx, c + nx]) if (c2 >= 0 && c2 < NC && !owner[c2] && piece[c2] < 0) { piece[c2] = id; stack.push(c2); }
    }
    id++;
  }
  const reach = i => {
    const b = B[i], out = new Set();
    rect(b.x - b.w / 2 - cell, b.z - b.d / 2 - cell, b.x + b.w / 2 + cell, b.z + b.d / 2 + cell, c => { if (piece[c] >= 0) out.add(piece[c]); });
    return out;
  };

  const h = unit * 0.012, tw = cell * 0.5;
  const copper = [], drills = [];
  const via = (x, z, r, w, ends = [-1, -1]) => {
    copper.push(tag(new THREE.CylinderGeometry(r, r, h * 1.6, 12).translate(x, top + h * 0.8, z), { aWhen: w, aEnds: ends }));
    drills.push(tag(new THREE.CylinderGeometry(r * 0.45, r * 0.45, h * 1.8, 8).translate(x, top + h * 0.9, z), { aWhen: w }));
  };
  const trace = (ax, az, bx, bz, w, ends = [-1, -1]) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L > 1e-6) copper.push(tag(new THREE.BoxGeometry(L + tw, h, tw).rotateY(-Math.atan2(bz - az, bx - ax)).translate((ax + bx) / 2, top + h / 2, (az + bz) / 2), { aWhen: w, aEnds: ends }));
  };

  // ---- signal traces: A* over the cells, each remembering the heading it was reached on, so turns
  // cost and a trace only bends by 45° (or, at a cost, 90°) at a time
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DZ = [0, 1, 1, 1, 0, -1, -1, -1];
  const g = new Float32Array(NC), from = new Int32Array(NC), head = new Int8Array(NC), seen = new Int32Array(NC), done = new Int32Array(NC);
  const open = heap();
  let stamp = 0;
  const pairs = new Map();
  files.forEach((f, i) => { if (live[i]) for (const j of f.imp) if (live[j] && i !== j) pairs.set(i < j ? `${i},${j}` : `${j},${i}`, [i, j]); });
  const edges = [...pairs.values()].sort((p, q) => Math.hypot(B[p[0]].x - B[p[1]].x, B[p[0]].z - B[p[1]].z) - Math.hypot(B[q[0]].x - B[q[1]].x, B[q[0]].z - B[q[1]].z));
  const t0 = performance.now();
  for (const [a, b] of edges.slice(0, 400)) {
    if (performance.now() - t0 > budgetMs) break;
    const ra = reach(a);
    if (![...reach(b)].some(p => ra.has(p))) continue;
    const s0 = iz(B[a].z) * nx + ix(B[a].x), goal = iz(B[b].z) * nx + ix(B[b].x);
    const gx = goal % nx, gz = Math.floor(goal / nx);
    const pass = c => owner[c] === 0 || owner[c] === a + 1 || owner[c] === b + 1 || c === goal;
    // (weighted 1.5 over the octile distance: a little longer than the shortest, found many times faster)
    const est = c => { const dx = Math.abs(c % nx - gx), dz = Math.abs(Math.floor(c / nx) - gz); return 1.5 * (Math.max(dx, dz) + 0.414 * Math.min(dx, dz)); };
    stamp++; open.clear();
    seen[s0] = stamp; g[s0] = 0; from[s0] = -1; head[s0] = -1; open.push(est(s0), s0);
    let found = false, steps = 0;
    while (open.size && steps++ < 25000) {
      const c = open.pop();
      if (done[c] === stamp) continue; // (an older, costlier entry for a cell already settled)
      done[c] = stamp;
      if (c === goal) { found = true; break; }
      const x = c % nx, z = (c - x) / nx, k = head[c];
      for (let k2 = 0; k2 < 8; k2++) {
        const turn = k < 0 ? 0 : Math.abs(((k2 - k + 12) % 8) - 4); // eighths of a turn, either way
        if (turn > 2) continue;
        const x2 = x + DX[k2], z2 = z + DZ[k2];
        if (x2 < 0 || z2 < 0 || x2 >= nx || z2 >= nz) continue;
        const c2 = z2 * nx + x2;
        if (done[c2] === stamp || !pass(c2)) continue;
        if (k2 & 1 && (!pass(z * nx + x2) || !pass(z2 * nx + x))) continue; // no cutting a part's corner
        const cost = g[c] + (k2 & 1 ? 1.414 : 1) + (turn === 1 ? 0.6 : turn === 2 ? 2.5 : 0) + (used[c2] ? 4 : 0);
        if (seen[c2] === stamp && g[c2] <= cost) continue;
        seen[c2] = stamp; g[c2] = cost; from[c2] = c; head[c2] = k2;
        open.push(cost + est(c2), c2);
      }
    }
    if (!found) continue;
    // back from the goal: one straight run per heading, a via where it turns square
    const path = [];
    for (let c = goal; c >= 0; c = from[c]) path.push(c);
    path.reverse();
    const w = [Math.max(B[a].born, B[b].born), Math.min(B[a].died ?? 2, B[b].died ?? 2)], ends = [a, b];
    let runStart = path[0];
    for (let p = 1; p < path.length; p++) {
      const c = path[p], k = head[c], next = path[p + 1];
      used[c] = 1;
      if (next !== undefined && head[next] === k) continue;
      trace(cx(runStart), cz(runStart), cx(c), cz(c), w, ends);
      if (next !== undefined && (head[next] - k + 8) % 4 === 2 && owner[c] === 0) via(cx(c), cz(c), tw * 1.3, w, ends);
      runStart = c;
    }
  }

  // ---- passives: a capacitor beside each chip, a resistor beside every third, on a side with room
  const passives = []; // { x, z, along: 'x' | 'z', L, W, kind: 'C' | 'R', when }
  const L = Math.max(unit * 0.16, cell * 2.6), W = L * 0.5;
  const fits = (x, z, hx, hz) => { let ok = true; rect(x - hx, z - hz, x + hx, z + hz, c => { if (!free(c)) ok = false; }); return ok; };
  B.forEach((b, i) => {
    if (!live[i]) return;
    const want = i % 3 === 0 ? ['C', 'R'] : ['C'];
    const sides = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    let s = i % 4;
    for (const kind of want) {
      for (let n = 0; n < 4; n++, s = (s + 1) % 4) {
        const [sx, sz] = sides[s], alongX = sz !== 0;
        const hx = alongX ? L / 2 : W / 2, hz = alongX ? W / 2 : L / 2;
        const t = (((i * 0.618) % 1) - 0.5) * 0.6; // somewhere along the side, not always its middle
        const x = b.x + (sx ? sx * (b.w / 2 + cell * 2.4 + hx) : t * b.w), z = b.z + (sz ? sz * (b.d / 2 + cell * 2.4 + hz) : t * b.d);
        if (!fits(x, z, hx, hz)) continue;
        rect(x - hx, z - hz, x + hx, z + hz, c => { owner[c] = -1; });
        passives.push({ x, z, alongX, kind, when: when(i) });
        s = (s + 1) % 4;
        break;
      }
    }
  });

  // ---- fan-out: every third lead of a chip gets a stub out and a via, where there's room
  B.forEach((b, i) => {
    if (!live[i] || !leads) return;
    const [lx, lz] = leads[i], pitch = unit * 0.09;
    for (const [axis, margin] of [['x', lx], ['z', lz]]) {
      if (!margin) continue;
      const span = axis === 'x' ? b.d / 2 - lz : b.w / 2 - lx;
      const n = Math.max(1, Math.floor(span * 2 / pitch - 0.3));
      for (const side of [-1, 1]) {
        let made = 0;
        for (let m = 1; m < n && made < 4; m += 3) {
          const along = (m + 0.5 - n / 2) * pitch, dir = Math.sign(along) || 1;
          const out = cell * 1.6, diag = cell * 1.4;
          const [ax, az] = axis === 'x' ? [b.x + side * b.w / 2, b.z + along] : [b.x + along, b.z + side * b.d / 2];
          const [bx, bz] = axis === 'x' ? [ax + side * out, az] : [ax, az + side * out];
          const [vx, vz] = axis === 'x' ? [bx + side * diag, bz + dir * diag] : [bx + dir * diag, bz + side * diag];
          const c1 = iz(bz) * nx + ix(bx), c2 = iz(vz) * nx + ix(vx);
          if (owner[c2] !== 0 || used[c2] || used[c1] || (owner[c1] !== 0 && owner[c1] !== i + 1)) continue;
          used[c1] = used[c2] = 1;
          trace(ax, az, bx, bz, when(i), [i, i]); trace(bx, bz, vx, vz, when(i), [i, i]); via(vx, vz, tw * 1.2, when(i), [i, i]);
          made++;
        }
      }
    }
  });

  for (const [geos, mat, focus] of [
    [copper, new THREE.MeshStandardMaterial({ color: S.copper, roughness: 0.38, metalness: 0.55 }), true],
    [drills, new THREE.MeshStandardMaterial({ color: '#0b0c0b', roughness: 0.9 }), false],
  ]) {
    if (!geos.length) continue;
    const geo = mergeGeometries(geos);
    geo.computeBoundingBox(); geo.computeBoundingSphere(); // (three.js wants the bounds after the arrays are gone)
    for (const at of Object.values(geo.attributes)) at.onUpload(function () { this.array = null; }); // (the GPU keeps its own copy)
    const mesh = new THREE.Mesh(geo, during(mat, shared, { focus }));
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  if (passives.length) group.add(passiveMeshes(passives, { L, W, top, S, shared }));

  // ---- reference designators, numbered in reading order (top row first, left to right)
  const order = list => list.sort((p, q) => Math.round(p.z / unit) - Math.round(q.z / unit) || p.x - q.x);
  const chips = order(B.map((b, i) => ({ i, x: b.x, z: b.z })).filter(p => live[p.i]));
  const th = Math.max(unit * 0.12, cell * 1.4), m = unit * 0.05;
  const marks = chips.map(({ i }, n) => ({ text: `U${n + 1}`, x: B[i].x - B[i].w / 2 - m, z: B[i].z - B[i].d / 2 - m - th * 0.65, h: th, when: when(i) }));
  const count = { C: 0, R: 0 };
  for (const p of order(passives)) marks.push({ text: `${p.kind}${++count[p.kind]}`, x: p.x - (p.alongX ? L / 2 : W / 2), z: p.z - (p.alongX ? W / 2 : L / 2) - th * 0.45, h: th * 0.6, when: p.when });
  group.add(silkText(marks, { y: top + unit * 0.012, S, shared }));
  return group;
}

// chip resistors and capacitors: a body between two tinned end caps
function passiveMeshes(list, { L, W, top, S, shared }) {
  const group = new THREE.Group();
  const H = W * 0.6, cap = L * 0.2;
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), during(new THREE.MeshStandardMaterial({ roughness: 0.6 }), shared), list.length);
  const ends = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), during(new THREE.MeshStandardMaterial({ color: S.leads, roughness: 0.35, metalness: 0.7 }), shared), list.length * 2);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const bodyWhen = new Float32Array(list.length * 2), endWhen = new Float32Array(list.length * 4);
  list.forEach((p, k) => {
    const [ux, uz] = p.alongX ? [1, 0] : [0, 1];
    m.compose(new THREE.Vector3(p.x, top, p.z), q, new THREE.Vector3(p.alongX ? L - cap * 2 : W, H, p.alongX ? W : L - cap * 2));
    body.setMatrixAt(k, m);
    body.setColorAt(k, c.set(p.kind === 'C' ? '#b49a6c' : '#1b1b1b'));
    bodyWhen.set(p.when, k * 2);
    [-1, 1].forEach((s, e) => {
      m.compose(new THREE.Vector3(p.x + ux * s * (L - cap) / 2, top, p.z + uz * s * (L - cap) / 2), q, new THREE.Vector3(p.alongX ? cap : W * 1.02, H * 1.02, p.alongX ? W * 1.02 : cap));
      ends.setMatrixAt(k * 2 + e, m);
      endWhen.set(p.when, (k * 2 + e) * 2);
    });
  });
  body.geometry.setAttribute('aWhen', new THREE.InstancedBufferAttribute(bodyWhen, 2));
  ends.geometry.setAttribute('aWhen', new THREE.InstancedBufferAttribute(endWhen, 2));
  for (const mesh of [body, ends]) { mesh.frustumCulled = false; mesh.receiveShadow = true; group.add(mesh); }
  return group;
}

// silkscreen text, one flat quad per character, read from above (top of the letters towards -z)
const GLYPHS = '0123456789UCR';
function silkText(marks, { y, S, shared }) {
  const cw = 32, chH = 48, canvas = document.createElement('canvas');
  canvas.width = cw * GLYPHS.length; canvas.height = chH;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.font = `600 40px 'JetBrains Mono', ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
  [...GLYPHS].forEach((ch, k) => g.fillText(ch, k * cw + cw / 2, chH / 2 + 2));
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const quads = [];
  for (const mk of marks) [...mk.text].forEach((ch, k) => quads.push([mk.x + (k + 0.5) * mk.h * 0.62, mk.z, mk.h, GLYPHS.indexOf(ch), ...mk.when]));
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTimeline: shared.uTimeline, uAtlas: { value: tex }, uColor: { value: new THREE.Color(S.silk) }, uY: { value: y }, uN: { value: GLYPHS.length } },
    vertexShader: `attribute vec4 aGlyph; attribute vec2 aWhen; uniform float uTimeline, uY, uN; varying vec2 vUv;
      void main(){
        if (uTimeline < aWhen.x * 0.97 + 0.03 || uTimeline > aWhen.y * 0.97 + 0.02) { gl_Position = vec4(0., 0., -2., 1.); return; }
        vUv = vec2((aGlyph.w + uv.x) / uN, uv.y);
        vec3 p = vec3(aGlyph.x + position.x * aGlyph.z * 0.62, uY, aGlyph.y + position.z * aGlyph.z);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: `uniform sampler2D uAtlas; uniform vec3 uColor; varying vec2 vUv;
      void main(){ float a = texture2D(uAtlas, vUv).a; if (a < 0.05) discard; gl_FragColor = vec4(uColor, a * 0.9); }`,
  }), quads.length);
  const glyph = new Float32Array(quads.length * 4), w = new Float32Array(quads.length * 2);
  quads.forEach((qd, k) => { glyph.set(qd.slice(0, 4), k * 4); w.set(qd.slice(4), k * 2); });
  geo.setAttribute('aGlyph', new THREE.InstancedBufferAttribute(glyph, 4));
  geo.setAttribute('aWhen', new THREE.InstancedBufferAttribute(w, 2));
  mesh.frustumCulled = false;
  return mesh;
}

// silkscreen: an outline round each package's footprint, its pin-1 corner cut off, there while the
// package is
export function buildSilkscreen({ B, unit, S, shared }) {
  const pos = [], when = [];
  const m = unit * 0.05;
  B.forEach(b => {
    if (!(b.w > 0.01)) return;
    const hw = b.w / 2 + m, hd = b.d / 2 + m, y = b.y + unit * 0.01, k = Math.min(unit * 0.12, hw * 0.6, hd * 0.6);
    const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
    const P = ([x, z]) => [b.x + x * c + z * s, y, b.z - x * s + z * c];
    const ring = [[-hw + k, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd + k]];
    ring.forEach((p, j) => {
      const q = ring[(j + 1) % ring.length];
      pos.push(...P(p), ...P(q));
      when.push(b.born, b.died ?? 2, b.born, b.died ?? 2);
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWhen', new THREE.Float32BufferAttribute(when, 2));
  const lines = new THREE.LineSegments(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTimeline: shared.uTimeline, uColor: { value: new THREE.Color(S.silk) } },
    vertexShader: `attribute vec2 aWhen; uniform float uTimeline; varying float vA;
      void main(){ vA = step(aWhen.x * 0.97 + 0.03, uTimeline) * step(uTimeline, aWhen.y * 0.97 + 0.02); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ if (vA <= 0.0) discard; gl_FragColor = vec4(uColor, 0.7); }`,
  }));
  lines.frustumCulled = false;
  return lines;
}
