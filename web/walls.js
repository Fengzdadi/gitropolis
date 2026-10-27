// The old walled city (the classifier's 'walled' state): a repo twenty years old whose first five
// years still stand keeps them behind a city wall. The wall goes round the blocks where those
// founding files cluster, down the middle of the streets between them and the newer town, so it
// never cuts through a building whatever the plan. Towers stand along it, gates open where it
// meets the widest streets, and it goes up when the founding years end.
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

// → { cell, runs: [[x0, x1, z]] wall pieces (one row of cells each), towers: [[x, z]], gates: [[x, z]] }, or null
export function planWall({ layout, files, until }) {
  const u = layout.unit;
  const live = [...files.keys()].filter(i => !files[i].gone && layout.lots[i] && layout.lots[i].w > 0.01);
  const old = live.map(i => files[i].born < until ? 1 : 0);
  const oldAll = old.reduce((s, x) => s + x, 0);
  if (oldAll < 6 || live.length < 20) return null;
  const pos = live.map(i => [layout.lots[i].x, layout.lots[i].z]);

  // the old town: the round patch of the city where founding buildings are thickest, the one with the
  // most of them over what the city's average would put there (a quarter of the city at most)
  const floor = oldAll / live.length, least = Math.max(8, Math.ceil(live.length * 0.04)), most = Math.ceil(live.length * 0.25);
  const olds = live.map((_, k) => k).filter(k => old[k]);
  const step = Math.max(1, Math.floor(olds.length / 200));
  let best = null;
  for (let c = 0; c < olds.length; c += step) {
    const [cx, cz] = pos[olds[c]];
    const order = live.map((_, k) => [Math.hypot(pos[k][0] - cx, pos[k][1] - cz), k]).sort((a, b) => a[0] - b[0]);
    let gain = 0;
    for (let m = 0; m < most; m++) {
      gain += old[order[m][1]] - floor;
      if (m + 1 >= least && (!best || gain > best.gain)) best = { gain, order, m: m + 1 };
    }
  }
  if (!best || best.gain <= 0) return null;
  const inTown = new Uint8Array(live.length);
  for (let m = 0; m < best.m; m++) inTown[best.order[m][1]] = 1;
  // a block goes in or out whole, so the wall keeps to the streets; only a block too big for that
  // (a whole compound of the factory town) is split between its buildings
  const blocks = layout.blocks.map(b => {
    const xs = b.poly.map(p => p[0]), zs = b.poly.map(p => p[1]);
    return { poly: b.poly, box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)], lots: [] };
  });
  live.forEach((_, k) => {
    const [x, z] = pos[k];
    blocks.find(b => x >= b.box[0] && x <= b.box[2] && z >= b.box[1] && z <= b.box[3] && inside([x, z], b.poly))?.lots.push(k);
  });
  for (const b of blocks) {
    if (!b.lots.length || b.lots.length > best.m * 0.3) continue;
    const keep = b.lots.filter(k => inTown[k]).length >= b.lots.length / 2 ? 1 : 0;
    for (const k of b.lots) inTown[k] = keep;
  }
  if (live.reduce((s, _, k) => s + (inTown[k] && old[k]), 0) < 6) return null;

  // every patch of ground, labelled with its nearest building's lot (a chamfer distance transform):
  // the wall runs where ground that belongs to the old town meets ground that belongs to the rest
  let X0 = Infinity, Z0 = Infinity, X1 = -Infinity, Z1 = -Infinity;
  const foot = live.map(i => { const l = layout.lots[i]; return { ...l, r: Math.hypot(l.w, l.d) / 2, c: Math.cos(l.rot || 0), s: Math.sin(l.rot || 0) }; });
  for (const l of foot) { X0 = Math.min(X0, l.x - l.r); Z0 = Math.min(Z0, l.z - l.r); X1 = Math.max(X1, l.x + l.r); Z1 = Math.max(Z1, l.z + l.r); }
  const reach = u * 0.7; // how far out from its buildings a wall stands when nothing is across the street
  X0 -= reach * 2; Z0 -= reach * 2; X1 += reach * 2; Z1 += reach * 2;
  const cell = Math.max(u * 0.12, Math.max(X1 - X0, Z1 - Z0) / 1600);
  const W = Math.ceil((X1 - X0) / cell), H = Math.ceil((Z1 - Z0) / cell);
  const lab = new Int32Array(W * H).fill(-1), dist = new Float32Array(W * H).fill(1e9);
  foot.forEach((l, k) => {
    const i0 = Math.max(0, Math.floor((l.x - l.r - X0) / cell)), i1 = Math.min(W - 1, Math.ceil((l.x + l.r - X0) / cell));
    const j0 = Math.max(0, Math.floor((l.z - l.r - Z0) / cell)), j1 = Math.min(H - 1, Math.ceil((l.z + l.r - Z0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // three.js turns a lot's +x to (cos r, -sin r) and +z to (sin r, cos r)
      const dx = X0 + (i + 0.5) * cell - l.x, dz = Z0 + (j + 0.5) * cell - l.z;
      if (Math.abs(dx * l.c - dz * l.s) <= l.w / 2 && Math.abs(dx * l.s + dz * l.c) <= l.d / 2) { lab[j * W + i] = k; dist[j * W + i] = 0; }
    }
  });
  const R2 = Math.SQRT2;
  const relax = (p, q, w) => { if (dist[q] + w < dist[p]) { dist[p] = dist[q] + w; lab[p] = lab[q]; } };
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
  const near = reach / cell;

  // the wall: the old town's ground along its edge, two cells thick, out in the street (not on a block)
  const own = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) own[p] = lab[p] >= 0 && inTown[lab[p]] && dist[p] <= near ? 1 : 0;
  // one town in one piece: the biggest stretch of its ground (not a few lots across the canal), and
  // with no holes in it (a yard in the middle is inside the walls, not walled off)
  const pieces = (want) => {
    const id = new Int32Array(W * H).fill(-1), size = [], queue = new Int32Array(W * H);
    for (let s = 0; s < W * H; s++) {
      if (own[s] !== want || id[s] >= 0) continue;
      const k = size.length;
      let head = 0, tail = 0, n = 0, edge = false;
      queue[tail++] = s; id[s] = k;
      while (head < tail) {
        const p = queue[head++], i = p % W;
        n++;
        if (i === 0 || i === W - 1 || p < W || p >= W * (H - 1)) edge = true;
        for (const q of [i > 0 ? p - 1 : -1, i < W - 1 ? p + 1 : -1, p - W, p + W]) {
          if (q >= 0 && q < W * H && own[q] === want && id[q] < 0) { id[q] = k; queue[tail++] = q; }
        }
      }
      size.push({ n, edge });
    }
    return { id, size };
  };
  const land = pieces(1);
  const main = land.size.reduce((b, s, k) => s.n > land.size[b].n ? k : b, 0);
  for (let p = 0; p < W * H; p++) if (own[p] && land.id[p] !== main) own[p] = 0;
  const holes = pieces(0);
  for (let p = 0; p < W * H; p++) if (!own[p] && !holes.size[holes.id[p]].edge) own[p] = 1;
  const edge = (src) => {
    const out = new Uint8Array(W * H);
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
  for (let p = 0; p < W * H; p++) if (wall[p]) wallCells.push(p);
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
  const gateHalf = u * 0.45;
  const gap = p => { const [x, z] = at(p); return gates.some(g => Math.hypot(x - g[0], z - g[1]) < gateHalf); };
  for (const p of wallCells) if (gap(p)) wall[p] = 0;

  // towers: a pair flanking each gate, then one every few lots along the wall
  const towers = [];
  const free = ([x, z], d) => towers.every(t => Math.hypot(x - t[0], z - t[1]) >= d);
  for (const g of gates) {
    const ring = wallCells.filter(p => wall[p] && Math.abs(Math.hypot(at(p)[0] - g[0], at(p)[1] - g[1]) - gateHalf - cell) < cell * 1.5).map(at);
    if (!ring.length) continue;
    const a = ring[0], b = ring.reduce((m, q) => Math.hypot(q[0] - a[0], q[1] - a[1]) > Math.hypot(m[0] - a[0], m[1] - a[1]) ? q : m, a);
    towers.push(a); if (b !== a) towers.push(b);
  }
  for (const p of wallCells) if (wall[p] && e1[p] && dist[p] >= 2 && free(at(p), u * 3)) towers.push(at(p));

  // the wall as runs of cells along each row, so it's a handful of boxes rather than thousands
  const runs = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!wall[j * W + i]) continue;
      let k = i;
      while (k + 1 < W && wall[j * W + k + 1]) k++;
      runs.push([X0 + i * cell, X0 + (k + 1) * cell, Z0 + (j + 0.5) * cell]);
      i = k;
    }
  }
  return { cell, runs, towers, gates };
}
