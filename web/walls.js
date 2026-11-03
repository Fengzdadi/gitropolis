// The old walled city (the classifier's 'walled' state): a repo twenty years old whose first five
// years still stand keeps them behind a city wall. The wall goes round the blocks where those
// founding files cluster, down the middle of the streets between them and the newer town, so it
// never cuts through a building whatever the plan. Towers stand along it, gates open where it
// meets the widest streets, and it goes up when the founding years end. When the founding files are
// spread evenly through the city there is no old quarter to pick out: the whole city is the old town,
// and the wall goes round its edge.
//
// planWall works on the finished layout and returns plain numbers; the studio turns them into walls.

const YEAR = 365.25 * 86400;

// the end of the founding years, by the same founding day the classifier counts from
export function foundingEnd(data) {
  const founded = data.truncated && data.firstCommit ? data.firstCommit : data.start;
  return founded + 5 * YEAR;
}

function inside([x, z], poly) {
  let c = false;
  for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
    const [xa, za] = poly[k], [xb, zb] = poly[m];
    if ((za > z) !== (zb > z) && x < xa + (z - za) / (zb - za) * (xb - xa)) c = !c;
  }
  return c;
}

// convex hull of points [x, z] (monotone chain), in order round it
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let k = pts.length - 1; k >= 0; k--) { const p = pts[k]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

// the old town: the round patch of the city where founding buildings are thickest, the one with the
// most of them over what the city's average would put there (a quarter of the city at most); null
// when there is none (founding files spread evenly, or too few files for a quarter of their own)
function oldTown(layout, xs, zs, old) {
  const u = layout.unit, n = xs.length;
  let oldAll = 0;
  for (const o of old) oldAll += o;
  const floor = oldAll / n, least = Math.max(8, Math.ceil(n * 0.04)), most = Math.ceil(n * 0.25);
  if (oldAll < 6 || least > most) return null;
  const olds = [];
  for (let k = 0; k < n; k++) if (old[k]) olds.push(k);
  let X0 = Infinity, Z0 = Infinity, X1 = -Infinity, Z1 = -Infinity;
  for (let k = 0; k < n; k++) { X0 = Math.min(X0, xs[k]); Z0 = Math.min(Z0, zs[k]); X1 = Math.max(X1, xs[k]); Z1 = Math.max(Z1, zs[k]); }
  // the lots round each centre are counted in thin rings out from it rather than sorted by distance
  // (a sort per centre took a second on a city of 30,000 files)
  const ring = u * 0.1, R = Math.ceil(Math.hypot(X1 - X0, Z1 - Z0) / ring) + 1;
  const ringOf = (k, cx, cz) => Math.floor(Math.sqrt((xs[k] - cx) ** 2 + (zs[k] - cz) ** 2) / ring);
  const count = new Int32Array(R), founding = new Int32Array(R);
  let best = null;
  for (let c = 0; c < olds.length; c += Math.ceil(olds.length / 200)) {
    const cx = xs[olds[c]], cz = zs[olds[c]];
    count.fill(0); founding.fill(0);
    for (let k = 0; k < n; k++) { const r = ringOf(k, cx, cz); count[r]++; founding[r] += old[k]; }
    for (let r = 0, m = 0, gain = 0; r < R; r++) {
      m += count[r]; gain += founding[r] - floor * count[r];
      if (m > most) break;
      if (m >= least && (!best || gain > best.gain)) best = { gain, cx, cz, r, m };
    }
  }
  if (!best || best.gain <= 0) return null;
  const town = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (ringOf(k, best.cx, best.cz) <= best.r) town[k] = 1;
  // a block goes in or out whole, so the wall keeps to the streets; only a block too big for that
  // (a whole compound of the factory town) is split between its buildings. Blocks are filed under the
  // squares of a coarse grid they cover, so a lot only tries the few around it
  const g = u * 4, GW = Math.floor((X1 - X0) / g) + 1, GH = Math.floor((Z1 - Z0) / g) + 1;
  const filed = Array.from({ length: GW * GH }, () => []);
  const blocks = layout.blocks.map((b, id) => {
    const bx = b.poly.map(p => p[0]), bz = b.poly.map(p => p[1]);
    const box = [Math.min(...bx), Math.min(...bz), Math.max(...bx), Math.max(...bz)];
    for (let j = Math.max(0, Math.floor((box[1] - Z0) / g)); j <= Math.min(GH - 1, Math.floor((box[3] - Z0) / g)); j++)
      for (let i = Math.max(0, Math.floor((box[0] - X0) / g)); i <= Math.min(GW - 1, Math.floor((box[2] - X0) / g)); i++) filed[j * GW + i].push(id);
    return { poly: b.poly, box, lots: [] };
  });
  for (let k = 0; k < n; k++) {
    const x = xs[k], z = zs[k];
    const id = filed[Math.floor((z - Z0) / g) * GW + Math.floor((x - X0) / g)].find(id => {
      const b = blocks[id];
      return x >= b.box[0] && x <= b.box[2] && z >= b.box[1] && z <= b.box[3] && inside([x, z], b.poly);
    });
    if (id !== undefined) blocks[id].lots.push(k);
  }
  for (const b of blocks) {
    if (!b.lots.length || b.lots.length > best.m * 0.3) continue;
    const keep = b.lots.filter(k => town[k]).length >= b.lots.length / 2 ? 1 : 0;
    for (const k of b.lots) town[k] = keep;
  }
  let kept = 0;
  for (let k = 0; k < n; k++) kept += town[k] & old[k];
  return kept >= 6 ? town : null;
}

// → { walls: [[xa, za, xb, zb, thickness]] straight pieces of wall, towers: [[x, z]], gates: [[x, z]] },
// or null for a city with no lots at all
export function planWall({ layout, files, until }) {
  const lot = i => layout.lots[i] && layout.lots[i].w > 0.01;
  const live = [...files.keys()].filter(i => !files[i].gone && lot(i));
  // the files deleted lately stand for most of the timeline: they have no say in where the old town
  // is, but the wall goes round them like any other building
  const gone = [...files.keys()].filter(i => files[i].gone && lot(i));
  if (!live.length) return null;
  const foot = [...live, ...gone].map(i => { const l = layout.lots[i]; return { ...l, r: Math.hypot(l.w, l.d) / 2, c: Math.cos(l.rot || 0), s: Math.sin(l.rot || 0) }; });
  const here = foot.slice(0, live.length);
  const town = oldTown(layout, here.map(l => l.x), here.map(l => l.z), live.map(i => files[i].born < until ? 1 : 0));
  // with no old quarter to pick out, or none big enough to wall, the old town is the whole city
  return town && quarterWall(layout, foot, live.length, town) || cityWall(layout, foot);
}

// half a gate's width, and half a tower's (studio.js: 0.46 wide, the eaves of its roof out to 0.26), in lots
const GATE = 0.45, TOWER = 0.26;

// towers: a pair flanking each gate, then one every few lots along the wall, where `clear` lets them
// (filed by squares three lots wide, so a long wall doesn't check each spot against every tower)
function placeTowers(u, along, gates, clear) {
  const towers = [], D = u * 3, filed = new Map();
  const key = (x, z) => Math.floor(x / D) * 65536 + Math.floor(z / D);
  const put = t => { towers.push(t); const k = key(t[0], t[1]); if (!filed.has(k)) filed.set(k, []); filed.get(k).push(t); };
  const free = ([x, z]) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++)
      for (const t of filed.get(key(x + a * D, z + b * D)) || []) if (Math.hypot(x - t[0], z - t[1]) < D) return false;
    return true;
  };
  for (const g of gates) {
    const ring = along.filter(p => Math.abs(Math.hypot(p[0] - g[0], p[1] - g[1]) - u * (GATE + 0.25)) < u * 0.2 && clear(p));
    if (!ring.length) continue;
    const a = ring[0], b = ring.reduce((m, q) => Math.hypot(q[0] - a[0], q[1] - a[1]) > Math.hypot(m[0] - a[0], m[1] - a[1]) ? q : m, a);
    put(a); if (b !== a) put(b);
  }
  for (const p of along) if (free(p) && clear(p)) put(p);
  return towers;
}

// the whole city as the old town: the wall follows its outline, the hull round all its buildings
// (deleted ones too) out as far as a wall stands from them, so it's one town even where it's scattered
// over islands and open ground, and it never comes near a building
function cityWall(layout, foot) {
  const u = layout.unit, reach = u * 0.7, thick = u * 0.24;
  const corners = foot.flatMap(l => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
    // three.js turns a lot's +x to (cos r, -sin r) and +z to (sin r, cos r)
    [l.x + (l.c * a * l.w + l.s * b * l.d) / 2, l.z + (-l.s * a * l.w + l.c * b * l.d) / 2]));
  const out = hull(hull(corners).flatMap(([x, z]) => Array.from({ length: 8 }, (_, k) => [x + Math.cos(k * Math.PI / 4) * reach, z + Math.sin(k * Math.PI / 4) * reach])));
  const edges = out.map((a, k) => [a, out[(k + 1) % out.length]]);
  // gates: one to each side, straight out from the middle of the city
  let cx = 0, cz = 0;
  for (const [x, z] of out) { cx += x / out.length; cz += z / out.length; }
  const gates = [];
  for (let side = 0; side < 4; side++) {
    const dx = Math.round(Math.cos(side * Math.PI / 2)), dz = Math.round(Math.sin(side * Math.PI / 2));
    for (const [[xa, za], [xb, zb]] of edges) {
      const ex = xb - xa, ez = zb - za, den = dx * ez - dz * ex;
      if (!den) continue;
      const t = ((xa - cx) * ez - (za - cz) * ex) / den, s = ((xa - cx) * dz - (za - cz) * dx) / den;
      if (t > 0 && s >= 0 && s <= 1) { gates.push([cx + dx * t, cz + dz * t]); break; }
    }
  }
  // each edge, less the gaps for the gates; a piece runs on by half its thickness past a corner, so
  // the pieces meet there
  const walls = [], along = [];
  for (const [[xa, za], [xb, zb]] of edges) {
    const L = Math.hypot(xb - xa, zb - za);
    if (L < 1e-9) continue;
    const ux = (xb - xa) / L, uz = (zb - za) / L;
    const cuts = [];
    for (const [gx, gz] of gates) { // where this edge passes within half a gate's width of a gate
      const m = (gx - xa) * ux + (gz - za) * uz, h2 = (u * GATE) ** 2 - ((gx - xa) * uz - (gz - za) * ux) ** 2;
      if (h2 > 0) cuts.push([m - Math.sqrt(h2), m + Math.sqrt(h2)]);
    }
    cuts.sort((a, b) => a[0] - b[0]);
    let from = -thick / 2;
    for (const [c0, c1] of [...cuts, [Infinity, Infinity]]) {
      const to = Math.min(c0, L + thick / 2);
      if (to > from) walls.push([xa + ux * from, za + uz * from, xa + ux * to, za + uz * to, thick]);
      from = Math.max(from, c1);
      if (from >= L + thick / 2) break;
    }
    for (let d = 0; d < L; d += u * 0.1) along.push([xa + ux * d, za + uz * d]);
  }
  const towers = placeTowers(u, along, gates, ([x, z]) => gates.every(g => Math.hypot(x - g[0], z - g[1]) >= u * GATE));
  return { walls, towers, gates };
}

// a quarter of the city as the old town: every patch of ground labelled with its nearest building's
// lot (a chamfer distance transform), and the wall run where ground that belongs to the old town meets
// ground that belongs to the rest; null when there's too little of it to wall
function quarterWall(layout, foot, live, town) {
  const u = layout.unit;
  const reach = u * 0.7; // how far out from its buildings a wall stands when nothing is across the street
  // only the ground round the old town is needed, with room for the lots across its streets
  let X0 = Infinity, Z0 = Infinity, X1 = -Infinity, Z1 = -Infinity;
  for (let k = 0; k < live; k++) if (town[k]) { const l = foot[k]; X0 = Math.min(X0, l.x - l.r); Z0 = Math.min(Z0, l.z - l.r); X1 = Math.max(X1, l.x + l.r); Z1 = Math.max(Z1, l.z + l.r); }
  X0 -= reach * 2; Z0 -= reach * 2; X1 += reach * 2; Z1 += reach * 2;
  // cells an eighth of a lot, or bigger on a big town to keep to three million of them: counted by
  // area, so a long thin one gets cells as fine as a square one of the same size
  const cell = Math.max(u * 0.12, Math.sqrt((X1 - X0) * (Z1 - Z0) / 3e6));
  const W = Math.ceil((X1 - X0) / cell), H = Math.ceil((Z1 - Z0) / cell), N = W * H;
  const lab = new Int32Array(N).fill(-1), dist = new Float32Array(N).fill(1e9);
  // a lot takes every cell it touches, not only the ones whose middle it covers (half a cell more
  // along each of its sides, a little over for the wall's overlap), so no wall cell is on a building
  const seed = k => {
    const l = foot[k], pad = cell * 0.52 * (Math.abs(l.c) + Math.abs(l.s)), r = l.r + cell * 1.5;
    const i0 = Math.max(0, Math.floor((l.x - r - X0) / cell)), i1 = Math.min(W - 1, Math.ceil((l.x + r - X0) / cell));
    const j0 = Math.max(0, Math.floor((l.z - r - Z0) / cell)), j1 = Math.min(H - 1, Math.ceil((l.z + r - Z0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // three.js turns a lot's +x to (cos r, -sin r) and +z to (sin r, cos r)
      const dx = X0 + (i + 0.5) * cell - l.x, dz = Z0 + (j + 0.5) * cell - l.z;
      if (Math.abs(dx * l.c - dz * l.s) <= l.w / 2 + pad && Math.abs(dx * l.s + dz * l.c) <= l.d / 2 + pad) { lab[j * W + i] = k; dist[j * W + i] = 0; }
    }
  };
  const R2 = Math.SQRT2;
  const relax = (p, q, w) => { if (dist[q] + w < dist[p]) { dist[p] = dist[q] + w; lab[p] = lab[q]; } };
  const sweep = () => {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (i > 0) relax(p, p - 1, 1);
      if (j > 0) { relax(p, p - W, 1); if (i > 0) relax(p, p - W - 1, R2); if (i < W - 1) relax(p, p - W + 1, R2); }
    }
    for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
      const p = j * W + i;
      if (i < W - 1) relax(p, p + 1, 1);
      if (j < H - 1) { relax(p, p + W, 1); if (i < W - 1) relax(p, p + W + 1, R2); if (i > 0) relax(p, p + W - 1, R2); }
    }
  };
  const inTown = new Uint8Array(foot.length);
  inTown.set(town);
  for (let k = 0; k < live; k++) seed(k);
  sweep();
  if (foot.length > live) {
    // a deleted building belongs to the side of the street its ground was on without it, then stands
    // in the field like the rest, so the wall goes down the street past it, not through it
    for (let k = live; k < foot.length; k++) {
      const i = Math.floor((foot[k].x - X0) / cell), j = Math.floor((foot[k].z - Z0) / cell);
      inTown[k] = i >= 0 && j >= 0 && i < W && j < H && lab[j * W + i] >= 0 ? inTown[lab[j * W + i]] : 0;
    }
    for (let k = live; k < foot.length; k++) seed(k);
    sweep();
  }
  const near = reach / cell;

  // the wall: the old town's ground along its edge, two cells thick, out in the street (not on a block)
  const own = new Uint8Array(N);
  for (let p = 0; p < N; p++) own[p] = lab[p] >= 0 && inTown[lab[p]] && dist[p] <= near ? 1 : 0;
  // one town in one piece: the biggest stretch of its ground (not a few lots across the canal), and
  // with no holes in it (a yard in the middle is inside the walls, not walled off)
  const id = new Int32Array(N), queue = new Int32Array(N);
  const pieces = (want) => {
    const size = [];
    id.fill(-1);
    for (let s = 0; s < N; s++) {
      if (own[s] !== want || id[s] >= 0) continue;
      const k = size.length;
      let head = 0, tail = 0, edge = false;
      queue[tail++] = s; id[s] = k;
      while (head < tail) {
        const p = queue[head++], i = p % W;
        if (i === 0 || i === W - 1 || p < W || p >= N - W) edge = true;
        if (i > 0 && own[p - 1] === want && id[p - 1] < 0) { id[p - 1] = k; queue[tail++] = p - 1; }
        if (i < W - 1 && own[p + 1] === want && id[p + 1] < 0) { id[p + 1] = k; queue[tail++] = p + 1; }
        if (p >= W && own[p - W] === want && id[p - W] < 0) { id[p - W] = k; queue[tail++] = p - W; }
        if (p < N - W && own[p + W] === want && id[p + W] < 0) { id[p + W] = k; queue[tail++] = p + W; }
      }
      size.push({ n: tail, edge });
    }
    return size;
  };
  const land = pieces(1);
  const main = land.reduce((b, s, k) => s.n > land[b].n ? k : b, 0);
  for (let p = 0; p < N; p++) if (own[p] && id[p] !== main) own[p] = 0;
  const holes = pieces(0);
  for (let p = 0; p < N; p++) if (!own[p] && !holes[id[p]].edge) own[p] = 1;
  const edge = (src) => {
    const out = new Uint8Array(N);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (src[p] && (i === 0 || j === 0 || i === W - 1 || j === H - 1 || !src[p - 1] || !src[p + 1] || !src[p - W] || !src[p + W])) out[p] = 1;
    }
    return out;
  };
  const e1 = edge(own), inner = own.map((v, p) => v && !e1[p] ? 1 : 0), e2 = edge(inner);
  const wall = own.map((v, p) => (e1[p] || e2[p]) && dist[p] >= 1 ? 1 : 0);
  const at = p => [X0 + (p % W + 0.5) * cell, Z0 + (Math.floor(p / W) + 0.5) * cell];
  const wallCells = [];
  for (let p = 0; p < N; p++) if (wall[p]) wallCells.push(p);
  if (wallCells.length < 20) return null;

  // gates: one to each side of the old town, where the wall crosses the widest street there
  let cxs = 0, czs = 0;
  for (const p of wallCells) { const [x, z] = at(p); cxs += x; czs += z; }
  const c = [cxs / wallCells.length, czs / wallCells.length];
  const gates = [];
  for (let side = 0; side < 4; side++) {
    let best = -1;
    for (const p of wallCells) {
      const [x, z] = at(p), a = Math.atan2(z - c[1], x - c[0]);
      const s = ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4;
      if (s !== side || !e1[p] || dist[p] >= near * 0.95) continue; // a street between blocks, not open ground
      if (best < 0 || dist[p] > dist[best]) best = p;
    }
    if (best >= 0) gates.push(at(best));
  }
  const gap = p => { const [x, z] = at(p); return gates.some(g => Math.hypot(x - g[0], z - g[1]) < u * GATE); };
  for (const p of wallCells) if (gap(p)) wall[p] = 0;

  // a tower is wider than the wall: it stands only where none of the ground under it touches a building
  const clear = ([x, z]) => {
    const i0 = Math.floor((x - u * TOWER - X0) / cell), i1 = Math.floor((x + u * TOWER - X0) / cell);
    const j0 = Math.floor((z - u * TOWER - Z0) / cell), j1 = Math.floor((z + u * TOWER - Z0) / cell);
    if (i0 < 0 || j0 < 0 || i1 >= W || j1 >= H) return false;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (dist[j * W + i] === 0) return false;
    return true;
  };
  const towers = placeTowers(u, wallCells.filter(p => wall[p] && e1[p]).map(at), gates, clear);

  // the wall as boxes: a run of cells along a row, stacked onto the same run in the rows before it, so
  // it's a handful of boxes rather than thousands (each a hair over its cells, so they meet)
  const boxes = [];
  let open = new Map();
  for (let j = 0; j < H; j++) {
    const next = new Map();
    for (let i = 0; i < W; i++) {
      if (!wall[j * W + i]) continue;
      let k = i;
      while (k + 1 < W && wall[j * W + k + 1]) k++;
      const b = open.get(i * W + k) || boxes[boxes.push([i, k, j, j]) - 1];
      b[3] = j; next.set(i * W + k, b);
      i = k;
    }
    open = next;
  }
  const hair = cell * 0.01;
  const walls = boxes.map(([i0, i1, j0, j1]) => {
    const x0 = X0 + i0 * cell - hair, x1 = X0 + (i1 + 1) * cell + hair, z0 = Z0 + j0 * cell - hair, z1 = Z0 + (j1 + 1) * cell + hair;
    return x1 - x0 >= z1 - z0 ? [x0, (z0 + z1) / 2, x1, (z0 + z1) / 2, z1 - z0] : [(x0 + x1) / 2, z0, (x0 + x1) / 2, z1, x1 - x0];
  });
  return { walls, towers, gates };
}
