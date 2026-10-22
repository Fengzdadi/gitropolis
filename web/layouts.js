// City planners. Each archetype turns the same files into a different urban form:
// where blocks go, what shape they are, where water and parks are, how tall things get.
// Planners work in "lot units" (a median file ≈ a 1×1 lot); the result is normalised to fit SIZE.
import { hierarchy, treemap, treemapSquarify, pack } from 'd3-hierarchy';

const GROUP_RE = /^(packages|apps|libs|crates|modules|plugins|services|projects)\/[^/]+/;
// tests, docs, examples… are the city's green edge rather than its core
const PERIPH_RE = /(^|\/)(tests?|__tests__|specs?|e2e|testing|fixtures?|samples?|examples?|docs?|playground|benchmarks?|bench|scripts|website|site|\.github|\.devcontainer)(\/|$)/;
// a JVM package (src/main/java/com/example/demo/…) is a namespace: its samples/ or demo/ isn't the green edge
const outerPath = p => p.replace(/((?:^|\/)src\/[\w-]+\/(?:java|kotlin|scala|groovy)\/).*\/([^/]+)$/, '$1$2');
const ground = d => d.periphery ? 'lawn' : 'block';
const hash = n => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };
const sum = xs => xs.reduce((s, x) => s + x, 0);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const rectPoly = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const circlePoly = (cx, cz, r, n = 40) => Array.from({ length: n }, (_, k) => {
  const t = (k / n) * Math.PI * 2;
  return [cx + Math.cos(t) * r, cz + Math.sin(t) * r];
});

// "packages/react-query-devtools" → "react-query-devtools"; very long names are cut
function shortLabel(t) {
  const s = t.replace(/^(packages|apps|libs|crates|modules|plugins|services|projects)\//, '');
  return s.length > 22 ? s.slice(0, 21) + '…' : s;
}

export const CITY_KINDS = ['farm', 'desert', 'capital', 'mountain', 'university', 'port', 'industrial', 'science', 'themepark', 'resort', 'smalltown', 'manhattan', 'hongkong', 'tokyo', 'la', 'paris', 'venice', 'barcelona'];

// ---------------------------------------------------------------- shared helpers

// districts: monorepo packages or top-level directories; root files share one district
function districtsOf(files, area) {
  const map = new Map();
  files.forEach((f, i) => {
    const m = GROUP_RE.exec(f.p);
    const key = m ? m[0] : (f.p.includes('/') ? f.p.split('/')[0] : '·');
    const rest = key === '·' ? f.p : f.p.slice(key.length + 1);
    const dir = rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : '';
    if (!map.has(key)) map.set(key, { name: key, items: [] });
    map.get(key).items.push({ i, a: area[i], dir, sub: dir.split('/')[0] });
  });
  const ds = [...map.values()];
  for (const d of ds) {
    d.items.sort((a, b) => a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : b.a - a.a);
    d.area = sum(d.items.map(it => it.a));
    d.periphery = PERIPH_RE.test(d.name + '/');
  }
  return ds.sort((a, b) => b.area - a.area);
}

// biggest district in the middle of the sequence, smaller ones fanning out on both sides
function middleOut(ds) {
  const out = [];
  ds.forEach((d, k) => (k % 2 ? out.push(d) : out.unshift(d)));
  return out;
}

// squarified lots inside a rect; an invisible filler keeps lots at their true size in half-empty blocks
function packRect(items, x0, z0, x1, z1, pad = 0.08) {
  const W = x1 - x0, D = z1 - z0;
  const used = sum(items.map(it => it.a));
  const kids = items.map(it => ({ it, v: it.a }));
  const free = W * D * 0.92 - used;
  if (free > 0) kids.push({ filler: true, v: free });
  const root = hierarchy({ children: kids }).sum(d => d.v || 0).sort((a, b) => b.value - a.value);
  treemap().tile(treemapSquarify.ratio(1)).size([W, D]).paddingInner(pad).paddingOuter(pad * 0.5)(root);
  return root.leaves().filter(l => !l.data.filler).map(l => ({
    i: l.data.it.i, x: x0 + (l.x0 + l.x1) / 2, z: z0 + (l.y0 + l.y1) / 2,
    w: Math.max(0.05, l.x1 - l.x0), d: Math.max(0.05, l.y1 - l.y0), rot: 0,
  }));
}

// fill blocks in order with a district's items, block by block, by capacity
function chunk(items, cap) {
  const out = [];
  let cur = [], used = 0;
  for (const it of items) {
    if (cur.length && used + it.a > cap) { out.push(cur); cur = []; used = 0; }
    cur.push(it); used += it.a;
  }
  if (cur.length) out.push(cur);
  return out;
}

// buildings along a block's four street fronts, one side after another: [side, offset, width] each.
// When they don't all fit, every building narrows a little until they do, so none runs past the
// block's last corner onto its neighbours.
function ringWidths(want, lens) {
  for (let f = 1; ; f *= 0.92) {
    const out = [];
    let s = 0, along = 0;
    for (const w0 of want) {
      let w = Math.min(w0 * f, lens[s]);
      if (along + w > lens[s] + 1e-6) {
        if (s === lens.length - 1) break;
        s++; along = 0; w = Math.min(w0 * f, lens[s]);
      }
      out.push([s, along, w]);
      along += w;
    }
    if (out.length === want.length) return out;
  }
}

function annularSector(r0, r1, t0, t1) {
  const steps = Math.max(2, Math.ceil(Math.abs(t1 - t0) / 0.06));
  const pts = [];
  for (let k = 0; k <= steps; k++) { const t = t0 + (t1 - t0) * k / steps; pts.push([Math.cos(t) * r1, Math.sin(t) * r1]); }
  for (let k = steps; k >= 0; k--) { const t = t0 + (t1 - t0) * k / steps; pts.push([Math.cos(t) * r0, Math.sin(t) * r0]); }
  return pts;
}

// strongly connected components (iterative Tarjan): component id per node, numbered so that a
// component only points at lower-numbered ones
function tarjan(adj) {
  const n = adj.length, idx = new Array(n).fill(-1), low = new Array(n).fill(0), on = new Array(n).fill(false), comp = new Array(n).fill(-1), stack = [];
  const out = adj.map(x => [...x]);
  let counter = 0, nc = 0;
  for (let s = 0; s < n; s++) {
    if (idx[s] >= 0) continue;
    const work = [[s, 0]];
    idx[s] = low[s] = counter++; stack.push(s); on[s] = true;
    while (work.length) {
      const top = work[work.length - 1], [v, k] = top;
      if (k < out[v].length) {
        top[1]++;
        const w = out[v][k];
        if (idx[w] < 0) { idx[w] = low[w] = counter++; stack.push(w); on[w] = true; work.push([w, 0]); }
        else if (on[w]) low[v] = Math.min(low[v], idx[w]);
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
        if (low[v] === idx[v]) { let w; do { w = stack.pop(); on[w] = false; comp[w] = nc; } while (w !== v); nc++; }
      }
    }
  }
  return comp;
}

// ---------------------------------------------------------------- planners
// each returns { lots[i] = {x,z,w,d,rot}, blocks: [{poly,type}], land: [poly], groundIsWater,
//               bridges: [{a,b,w}], hills: [{x,z,r,h}], labels: [{text,x,z}], height: (i, rel) => lot units }

const PLANNERS = {
  // a long gridded island: wide avenues N–S, narrow streets E–W, a park in the middle
  manhattan(ds, ctx) {
    const BW = 4.2, BD = 1.7, AV = 0.6, ST = 0.3;
    const chunks = [];
    for (const d of middleOut(ds)) for (const items of chunk(d.items, BW * BD * 0.85)) chunks.push({ d, items });
    const K = chunks.length;
    const C = clamp(Math.round(Math.sqrt(K / 2.4)), 1, 7);
    let R = Math.ceil(K / C);
    const park = C >= 3 && R >= 7 ? { c0: C >= 5 ? 1 : Math.floor(C / 2), c1: C >= 5 ? C - 2 : Math.floor(C / 2), r0: Math.round(R * 0.58), r1: Math.round(R * 0.58) + Math.max(2, Math.round(R * 0.16)) - 1 } : null;
    const inPark = (c, r) => park && c >= park.c0 && c <= park.c1 && r >= park.r0 && r <= park.r1;
    const cellX = c => c * (BW + AV), cellZ = r => -r * (BD + ST);
    const lots = [], blocks = [], labels = [], seen = new Set();
    let k = 0;
    for (let r = 0; k < K; r++) {
      for (let cc = 0; cc < C && k < K; cc++) {
        const c = r % 2 ? C - 1 - cc : cc; // serpentine keeps districts contiguous
        if (inPark(c, r)) continue;
        const { d, items } = chunks[k++];
        const x0 = cellX(c), z0 = cellZ(r) - BD;
        blocks.push({ poly: rectPoly(x0, z0, x0 + BW, z0 + BD), type: ground(d) });
        lots.push(...packRect(items, x0, z0, x0 + BW, z0 + BD, 0.07));
        if (!seen.has(d) && d.name !== '·') { seen.add(d); labels.push({ text: d.name, x: x0 + BW / 2, z: z0 + BD + ST * 0.5 }); }
      }
      R = r + 1;
    }
    if (park) blocks.push({ poly: rectPoly(cellX(park.c0), cellZ(park.r1) - BD, cellX(park.c1) + BW, cellZ(park.r0)), type: 'park' });
    const X1 = cellX(C - 1) + BW, Z0 = cellZ(R - 1) - BD, M = AV * 1.2;
    // the island, with Manhattan's tapered southern tip
    const land = [[[-M, Z0 - M], [X1 + M, Z0 - M], [X1 + M, M], [X1 * 0.6, M + 2.2], [X1 * 0.3, M + 2.6], [-M, M + 0.8]]];
    const zS = M + 3, zN = Z0 - M - 3;
    const shore = [rectPoly(-M - 16, zN - 6, -M - 4.5, zS + 6), rectPoly(X1 + M + 4.5, zN - 6, X1 + M + 18, zS + 6)];
    const bridges = [0.15, 0.4].map(f => { const z = cellZ(Math.floor(R * f)) - BD / 2; return { a: [X1 + M - 0.3, z], b: [X1 + M + 4.8, z], w: 0.45 }; });
    bridges.push({ a: [-M + 0.3, cellZ(Math.floor(R * 0.7)) - BD / 2], b: [-M - 4.8, cellZ(Math.floor(R * 0.7)) - BD / 2], w: 0.4 });
    return {
      lots, blocks, land, shore, bridges, labels, ground: 'water',
      camera: { az: 128, el: 24, dist: 1.05 },
      height: (i, rel) => Math.min(0.6 + 1.6 * Math.pow(rel, 0.55), 11) * (i === ctx.hub ? 1.2 : 1),
    };
  },

  // dense wards cut into many small irregular blocks; station towers at the busiest junctions
  tokyo(ds, ctx) {
    const total = sum(ds.map(d => d.area));
    const W = Math.sqrt(total / 0.55);
    const wards = hierarchy({ children: ds.map(d => ({ d, v: d.area })) }).sum(x => x.v || 0).sort((a, b) => b.value - a.value);
    treemap().tile(treemapSquarify.ratio(1)).size([W, W]).paddingInner(0.8).paddingOuter(0.4)(wards);
    const lots = [], blocks = [], labels = [];
    let seed = 1;
    const split = (x0, z0, x1, z1, target, out) => {
      const w = x1 - x0, h = z1 - z0;
      if (w * h <= target * 1.6 || Math.min(w, h) < 1.3) { out.push([x0, z0, x1, z1]); return; }
      const t = 0.36 + 0.28 * hash(seed++), g = 0.16;
      if (w >= h) { const m = x0 + w * t; split(x0, z0, m - g / 2, z1, target, out); split(m + g / 2, z0, x1, z1, target, out); }
      else { const m = z0 + h * t; split(x0, z0, x1, m - g / 2, target, out); split(x0, m + g / 2, x1, z1, target, out); }
    };
    for (const leaf of wards.leaves()) {
      const d = leaf.data.d;
      const cells = [];
      split(leaf.x0, leaf.y0, leaf.x1, leaf.y1, 4.5, cells);
      const capTotal = sum(cells.map(([a, b, c, e]) => (c - a) * (e - b)));
      // fill the blocks in order, each up to its share; when that leaves files over, every block takes
      // a little more, so the overflow spreads out instead of piling into the last block
      const fill = fac => {
        let idx = 0;
        const takes = cells.map(([x0, z0, x1, z1]) => {
          const cap = (x1 - x0) * (z1 - z0) * (d.area / capTotal) * fac, take = [];
          let used = 0;
          while (idx < d.items.length && (used + d.items[idx].a <= cap || !take.length)) { used += d.items[idx].a; take.push(d.items[idx++]); }
          return take;
        });
        return { takes, left: d.items.slice(idx) };
      };
      let fac = 1, plan = fill(fac);
      while (plan.left.length && fac < 4) plan = fill(fac *= 1.03);
      plan.takes[cells.length - 1].push(...plan.left); // (never more than a sliver by now)
      cells.forEach(([x0, z0, x1, z1], n) => {
        blocks.push({ poly: rectPoly(x0, z0, x1, z1), type: ground(d) });
        if (plan.takes[n].length) lots.push(...packRect(plan.takes[n], x0, z0, x1, z1, 0.06));
      });
      if (d.name !== '·') labels.push({ text: d.name, x: (leaf.x0 + leaf.x1) / 2, z: leaf.y1 + 0.4 });
    }
    // the busiest junctions become station towers
    const ranked = [...ctx.inDeg.keys()].sort((a, b) => ctx.inDeg[b] - ctx.inDeg[a]);
    const stations = new Set(ranked.slice(0, Math.max(1, Math.round(ranked.length * 0.015))).filter(i => ctx.inDeg[i] > 0));
    return {
      lots, blocks, labels, land: [rectPoly(-0.6, -0.6, W + 0.6, W + 0.6)],
      camera: { az: 35, el: 24, dist: 0.72 },
      height: (i, rel) => Math.min(0.32 + 0.95 * Math.sqrt(rel), 5) * (stations.has(i) ? 2.6 : 1),
    };
  },

  // low-rise neighbourhoods far apart, separated by freeways; one downtown cluster
  la(ds, ctx) {
    const hubD = ds.find(d => d.items.some(it => it.i === ctx.hub)) || ds[0];
    const total = sum(ds.map(d => d.area));
    const W = Math.sqrt(total / 0.32);
    const root = hierarchy({ children: ds.map(d => ({ d, v: d.area * (d === hubD ? 0.45 : 1) })) }).sum(x => x.v || 0).sort((a, b) => b.value - a.value);
    treemap().tile(treemapSquarify.ratio(1)).size([W, W]).paddingInner(3.2).paddingOuter(1.2)(root);
    const lots = [], blocks = [], labels = [];
    for (const leaf of root.leaves()) {
      const d = leaf.data.d, downtown = d === hubD;
      // tiny neighbourhoods can be squeezed to nothing by the freeway padding
      const x0 = leaf.x0, z0 = leaf.y0, w = Math.max(1.2, leaf.x1 - leaf.x0), h = Math.max(1.2, leaf.y1 - leaf.y0);
      blocks.push({ poly: rectPoly(x0, z0, x0 + w, z0 + h), type: downtown ? 'block' : 'lawn' });
      // a regular grid of house lots; shrink cells until everyone fits
      // spread the houses evenly over the whole neighbourhood
      let cs = Math.sqrt((w * h) / d.items.length), cols, rows;
      do { cols = Math.max(1, Math.floor(w / cs)); rows = Math.max(1, Math.floor(h / cs)); if (cols * rows >= d.items.length) break; cs *= 0.95; } while (cs > 0.2);
      d.items.forEach((it, k) => {
        const c = k % cols, r = Math.floor(k / cols);
        const side = Math.min(cs * (downtown ? 0.82 : 0.68), Math.sqrt(it.a) * (downtown ? 0.9 : 0.8));
        const j = hash(it.i);
        lots.push({ i: it.i, x: x0 + (c + 0.5) * (w / cols), z: z0 + (r + 0.5) * (h / rows), w: side * (1 + 0.3 * j), d: side, rot: 0 });
      });
      if (d.name !== '·') labels.push({ text: downtown ? `${d.name} (downtown)` : d.name, x: (leaf.x0 + leaf.x1) / 2, z: leaf.y1 + 0.8 });
    }
    const roads = [];
    for (const leaf of root.leaves()) {
      const o = 1.6, x0 = leaf.x0 - o, x1 = Math.max(leaf.x1, leaf.x0 + 1.2) + o, z0 = leaf.y0 - o, z1 = Math.max(leaf.y1, leaf.y0 + 1.2) + o;
      roads.push({ a: [x0, z0], b: [x1, z0], w: 0.9 }, { a: [x1, z0], b: [x1, z1], w: 0.9 }, { a: [x1, z1], b: [x0, z1], w: 0.9 }, { a: [x0, z1], b: [x0, z0], w: 0.9 });
    }
    const nh = Math.max(3, Math.ceil(W / 7));
    const hills = Array.from({ length: nh }, (_, k) => ({ x: (k + 0.5) * W / nh, z: -7 - hash(k + 4) * 6, r: 6 + hash(k + 1) * 5, h: 3 + hash(k + 2) * 4 }));
    return {
      lots, blocks, labels, roads, hills, ground: 'land', land: [rectPoly(-1, -1, W + 1, W + 1)],
      camera: { az: 50, el: 17, dist: 0.8 },
      height: (i, rel, d) => d === hubD ? Math.min(0.6 + 2.2 * Math.pow(rel, 0.6), 12) : Math.min(0.22 + 0.3 * Math.pow(rel, 0.4), 1.1),
      districtOf: i => ds.find(d => d.items.some(it => it.i === i)),
    };
  },

  // the core file is a monument on a round plaza; districts are wedges between radial avenues
  paris(ds, ctx) {
    const hubA = ctx.area[ctx.hub];
    const rest = ds.map(d => ({ ...d, items: d.items.filter(it => it.i !== ctx.hub) })).filter(d => d.items.length);
    for (const d of rest) d.area = sum(d.items.map(it => it.a));
    const total = sum(rest.map(d => d.area));
    const r0 = Math.max(2.4, Math.sqrt(hubA) * 1.6);
    const BAND = 0.95, STREET = 0.2, BLVD = 0.6, AVE = 0.6;
    const lots = [{ i: ctx.hub, x: 0, z: 0, w: Math.sqrt(hubA) * 0.75, d: Math.sqrt(hubA) * 0.75, rot: Math.PI / 4 }];
    const blocks = [{ poly: circlePoly(0, 0, r0 - 0.5, 48), type: 'plaza' }], labels = [];
    // every wedge gets at least a sliver wide enough to build on near the plaza
    const MIN = Math.min(0.35, (Math.PI * 2) / rest.length * 0.5);
    const raw = rest.map(d => (d.area / total) * Math.PI * 2);
    const short = sum(raw.map(x => Math.max(0, MIN - x)));
    const big = sum(raw.filter(x => x > MIN));
    const spans = raw.map(x => x <= MIN ? MIN : x - short * (x / big));
    // the river: a gentle S through the centre, wide enough that the plaza becomes an island
    const RH = Math.max(0.8, r0 * 0.4);
    const river = x => 0.9 * Math.sin(x / 6 + 0.4) - 0.9 * Math.sin(0.4);
    const wet = (x, z, m = 0) => Math.abs(z - river(x)) < RH + m;
    const boundaries = [];
    let t = -Math.PI / 2;
    for (const [di, d] of rest.entries()) {
      const span = spans[di];
      const t0 = t, t1 = t + span;
      t = t1;
      let r = r0 + 0.5, band = 0, k = 0;
      boundaries.push(t0);
      while (k < d.items.length && band < 400) {
        const rin = r, rout = r + BAND, rm = r + BAND / 2;
        const ga = (AVE / 2) / rm; // keeps radial avenues a constant width
        const a0 = t0 + ga, a1 = t1 - ga, avail = (a1 - a0) * rm;
        let cur = 0, seg = 0;
        const close = () => { if (cur > seg) blocks.push({ poly: annularSector(rin, rout, a0 + seg / rm, a0 + cur / rm), type: ground(d) }); };
        while (k < d.items.length && avail > 0.4) {
          const it = d.items[k];
          const w = Math.min(it.a / BAND, avail);
          if (cur + w > avail && cur > 0) break;
          const th = a0 + (cur + w / 2) / rm;
          const x = Math.cos(th) * rm, z = Math.sin(th) * rm;
          if (wet(x, z, Math.max(w, BAND) / 2 + 0.15)) { close(); cur += 0.3; seg = cur; continue; } // step over the river
          lots.push({ i: it.i, x, z, w: w * 0.92, d: BAND * 0.86, rot: -(th + Math.PI / 2) });
          cur += w; k++;
        }
        close();
        band++;
        r = rout + (band % 4 === 0 ? BLVD : STREET);
      }
      const tm = (t0 + t1) / 2, rl = r + 0.8;
      if (d.name !== '·') labels.push({ text: d.name, x: Math.cos(tm) * rl, z: Math.sin(tm) * rl });
    }
    const Rest = Math.sqrt(total / (Math.PI * 0.55)) + r0 + 4;
    const water = [[...Array.from({ length: 61 }, (_, k) => { const x = -Rest * 1.6 + k * Rest * 3.2 / 60; return [x, river(x) - RH]; }),
      ...Array.from({ length: 61 }, (_, k) => { const x = Rest * 1.6 - k * Rest * 3.2 / 60; return [x, river(x) + RH]; })]];
    // every avenue that meets the river crosses it on a bridge
    const bridges = [];
    for (const tb of boundaries) for (const dir of [tb]) {
      let inside = false, rIn = 0;
      for (let rr = r0 - 0.4; rr < Rest; rr += 0.05) {
        const w = wet(Math.cos(dir) * rr, Math.sin(dir) * rr);
        if (w && !inside) { inside = true; rIn = rr; }
        if (!w && inside) {
          inside = false;
          const a = rIn - 0.25, b = rr + 0.25;
          bridges.push({ a: [Math.cos(dir) * a, Math.sin(dir) * a], b: [Math.cos(dir) * b, Math.sin(dir) * b], w: AVE * 0.8 });
        }
      }
    }
    return {
      lots, blocks, labels, water, bridges,
      camera: { az: 62, el: 36, dist: 0.85 },
      height: (i, rel) => i === ctx.hub ? 5.5 : 0.95 + 0.18 * Math.tanh(Math.log(rel)),
    };
  },

  // every district an island; canals between; bridges where islands import each other
  venice(ds, ctx) {
    const FILL = 0.5;
    const root = hierarchy({ children: ds.map(d => ({ d, v: d.area / FILL })) }).sum(x => x.v || 0).sort((a, b) => b.value - a.value);
    const S = Math.sqrt(sum(ds.map(d => d.area)) / FILL) * 1.4;
    pack().size([S, S]).padding(1.2)(root);
    // scale so each island has room for its buildings
    let k = 1;
    for (const l of root.leaves()) k = Math.max(k, Math.sqrt(l.data.d.area / FILL / (Math.PI * l.r * l.r)));
    const lots = [], blocks = [], land = [], labels = [], isle = new Map();
    for (const l of root.leaves()) {
      const d = l.data.d, cx = l.x * k, cz = l.y * k, R = l.r * k;
      isle.set(d, { cx, cz, R });
      land.push(circlePoly(cx, cz, R, 48));
      // rows of houses across the island; when they don't all fit, the island is laid out as if it were
      // a little bigger and then drawn back to its true size, so everyone has a plot of their own
      const ROW = 0.9, GAP = 0.16, M = 0.35;
      for (let f = 1; ; f *= 0.9) {
        const Rv = R / f, myLots = [], myBlocks = [];
        let z = -Rv + M + ROW / 2, idx = 0, row = 0;
        while (idx < d.items.length && z < Rv) {
          const dz = Math.max(Math.abs(z - ROW / 2), Math.abs(z + ROW / 2));
          const half = Math.sqrt(Math.max(0, (Rv - M) ** 2 - dz * dz));
          let x = -half;
          const start = idx;
          while (idx < d.items.length && half > 0.3) {
            const it = d.items[idx], w = Math.min(it.a / ROW, half * 2);
            if (x + w > half && x > -half) break;
            myLots.push({ i: it.i, x: x + w / 2, z, w: w * 0.9, d: ROW * 0.88, rot: 0 });
            x += w; idx++;
          }
          if (idx > start) myBlocks.push({ poly: rectPoly(-half, z - ROW / 2, x, z + ROW / 2), type: ground(d) });
          row++;
          z += ROW + (row % 3 === 0 ? 0.45 : GAP);
        }
        if (idx < d.items.length) continue;
        for (const l of myLots) lots.push({ ...l, x: cx + l.x * f, z: cz + l.z * f, w: l.w * f, d: l.d * f });
        for (const b of myBlocks) blocks.push({ ...b, poly: b.poly.map(([x, z]) => [cx + x * f, cz + z * f]) });
        break;
      }
      if (d.name !== '·') labels.push({ text: d.name, x: cx, z: cz + R + 0.9 });
    }
    // bridges between islands that import each other
    const dOf = new Map();
    for (const d of ds) for (const it of d.items) dOf.set(it.i, d);
    const pairs = new Map();
    ctx.files.forEach((f, i) => f.imp.forEach(j => {
      const a = dOf.get(i), b = dOf.get(j);
      if (a && b && a !== b) { const key = a.name < b.name ? `${a.name}|${b.name}` : `${b.name}|${a.name}`; pairs.set(key, (pairs.get(key) || { a, b, n: 0 })); pairs.get(key).n++; }
    }));
    const bridges = [...pairs.values()].sort((p, q) => q.n - p.n).slice(0, 40).map(({ a, b, n }) => {
      const A = isle.get(a), Bq = isle.get(b);
      const dx = Bq.cx - A.cx, dz = Bq.cz - A.cz, L = Math.hypot(dx, dz) || 1;
      return { a: [A.cx + dx / L * (A.R - 0.4), A.cz + dz / L * (A.R - 0.4)], b: [Bq.cx - dx / L * (Bq.R - 0.4), Bq.cz - dz / L * (Bq.R - 0.4)], w: clamp(0.18 + Math.log1p(n) * 0.08, 0.2, 0.6) };
    });
    // the core file is a campanile
    const hubLot = lots.find(l => l.i === ctx.hub);
    if (hubLot) { hubLot.w = hubLot.d = 0.45; }
    return {
      lots, blocks, land, labels, bridges, ground: 'water',
      camera: { az: 40, el: 40, dist: 0.9 },
      height: (i, rel) => i === ctx.hub ? 6.5 : Math.min(0.42 + 0.45 * Math.pow(rel, 0.4), 1.8),
    };
  },

  // a thin, very dense waterfront strip between the harbour and the mountains
  hongkong(ds, ctx) {
    const total = sum(ds.map(d => d.area)) / 0.85;
    const W = Math.sqrt(total * 3.2), D = total / W;
    const root = hierarchy({ children: ds.map(d => ({ d, v: d.area })) }).sum(x => x.v || 0).sort((a, b) => b.value - a.value);
    treemap().tile(treemapSquarify.ratio(1)).size([W, D]).paddingInner(0.35).paddingOuter(0.2)(root);
    const lots = [], blocks = [], labels = [];
    for (const l of root.leaves()) {
      const d = l.data.d;
      blocks.push({ poly: rectPoly(l.x0, l.y0, l.x1, l.y1), type: ground(d) });
      lots.push(...packRect(d.items, l.x0, l.y0, l.x1, l.y1, 0.05));
      if (d.name !== '·') labels.push({ text: d.name, x: (l.x0 + l.x1) / 2, z: l.y1 + 0.5 });
    }
    const hills = [];
    const n = Math.max(3, Math.ceil(W / 5));
    for (let k = 0; k < n; k++) hills.push({ x: (k + 0.5) * W / n + (hash(k) - 0.5) * 3, z: -4 - hash(k + 9) * 5, r: 4 + hash(k + 3) * 4, h: 5 + hash(k + 5) * 7 });
    return {
      lots, blocks, labels, hills, ground: 'water', land: [rectPoly(-1, -13, W + 1, D + 0.6)],
      camera: { az: 104, el: 16, dist: 0.85 },
      height: (i, rel) => Math.min(1.1 + 2.0 * Math.sqrt(rel), 14),
    };
  },

  // identical chamfered blocks; buildings ring each block around a courtyard; one cathedral
  barcelona(ds, ctx) {
    const S = 4.4, ST = 1.0, RD = 1.1, CH = 0.9;
    const SIDE = S - 2 * CH * 0.75;
    // the north and south ranges run corner to corner; the east and west ones fit between them
    const cap = (SIDE + S - 2 * RD) * 2 * RD * 0.95;
    // one directory per block where possible: Cerdà would approve
    // a directory big enough fills its own block (Cerdà would approve); small neighbouring directories
    // share one, so a small repo isn't a grid of near-empty blocks
    const groups = [];
    for (const d of ds) {
      const byDir = new Map();
      for (const it of d.items) if (it.i !== ctx.hub) { const key = d.name + '/' + it.dir; if (!byDir.has(key)) byDir.set(key, []); byDir.get(key).push(it); }
      let cur = [], used = 0;
      const flush = () => { if (cur.length) groups.push({ d, items: cur }); cur = []; used = 0; };
      for (const items of byDir.values()) {
        const tot = sum(items.map(it => it.a));
        if (tot >= cap * 0.6) { flush(); for (const c of chunk(items, cap)) groups.push({ d, items: c }); continue; }
        if (used + tot > cap) flush();
        cur.push(...items);
        used += tot;
      }
      flush();
    }
    const K = groups.length + 1;
    const C = Math.ceil(Math.sqrt(K)), R = Math.ceil(K / C);
    const center = Math.floor(R / 2) * C + Math.floor(C / 2);
    const lots = [], blocks = [], labels = [], seen = new Set();
    const oct = (x0, z0) => [[x0 + CH, z0], [x0 + S - CH, z0], [x0 + S, z0 + CH], [x0 + S, z0 + S - CH], [x0 + S - CH, z0 + S], [x0 + CH, z0 + S], [x0, z0 + S - CH], [x0, z0 + CH]];
    let g = 0;
    // (the plaza is always laid out, even when the blocks run out before the grid's centre)
    for (let cell = 0; cell < C * R; cell++) {
      const x0 = (cell % C) * (S + ST), z0 = Math.floor(cell / C) * (S + ST);
      if (cell === center) {
        blocks.push({ poly: oct(x0, z0), type: 'plaza' });
        lots.push({ i: ctx.hub, x: x0 + S / 2, z: z0 + S / 2, w: 1.7, d: 1.7, rot: 0 });
        continue;
      }
      if (g >= groups.length) continue;
      const { d, items } = groups[g++];
      blocks.push({ poly: oct(x0, z0), type: ground(d) });
      // walk the four sides clockwise, laying buildings along the street front. Buildings are never
      // rotated (their windows face the camera): the east and west ranges swap width and depth instead.
      const sides = [[x0 + CH * 0.75, z0 + RD / 2, 1, 0], [x0 + S - RD / 2, z0 + RD, 0, 1],
        [x0 + S - CH * 0.75, z0 + S - RD / 2, -1, 0], [x0 + RD / 2, z0 + S - RD, 0, -1]];
      const ring = ringWidths(items.map(it => it.a / RD), [SIDE, S - 2 * RD, SIDE, S - 2 * RD]);
      items.forEach((it, n) => {
        const [s, along, w] = ring[n], [sx, sz, dx, dz] = sides[s];
        const x = sx + dx * (along + w / 2), z = sz + dz * (along + w / 2);
        lots.push(dx ? { i: it.i, x, z, w: w * 0.94, d: RD * 0.9, rot: 0 } : { i: it.i, x, z, w: RD * 0.9, d: w * 0.94, rot: 0 });
      });
      if (!seen.has(d) && d.name !== '·') { seen.add(d); labels.push({ text: d.name, x: x0 + S / 2, z: z0 + S + ST / 2 }); }
    }
    const W = C * (S + ST), H = R * (S + ST);
    return {
      lots, blocks, labels, land: [rectPoly(-ST, -ST, W, H)],
      camera: { az: 45, el: 46, dist: 0.85 },
      height: (i, rel) => i === ctx.hub ? 9 : 1.45 + 0.2 * Math.tanh(Math.log(rel)),
    };
  },

  // a farm village: every directory is a farm. Its datasets are fields (sized by their data), its
  // notebooks and scripts stand in the farmyard, model weights are silos beside the barns, fallow
  // strips fill out the patchwork, and the most-imported file is the windmill on the village green.
  farm(ds, ctx) {
    const files = ctx.files;
    const CROPS = ['#d9b45a', '#93bf62', '#8c6a45', '#e3cf4a', '#61944a', '#c9a96b', '#a7b85a'];
    const farms = ds.map(d => {
      const items = d.items.filter(it => it.i !== ctx.hub);
      const fields = items.filter(it => files[it.i].lang === 'data');
      const yard = items.filter(it => files[it.i].lang !== 'data');
      const fa = sum(fields.map(it => it.a * 1.6)), ya = sum(yard.map(it => it.a)) / 0.45;
      return { d, fields, yard, fa, ya, area: (fa + ya) * 1.35 + 3 };
    }).filter(f => f.fields.length + f.yard.length);
    const green = { green: true, area: 9 };
    const root = hierarchy({ children: [...farms, green] }).sum(n => n.area || 0).sort((a, b) => b.value - a.value);
    const A = sum(farms.map(f => f.area)) + 9, side = Math.sqrt(A) * 1.1;
    treemap().tile(treemapSquarify.ratio(1.3)).size([side, side]).paddingInner(0.7)(root);
    const lots = [], blocks = [], labels = [];
    let seed = 1;
    for (const l of root.leaves()) {
      const f = l.data, x0 = l.x0, z0 = l.y0, x1 = l.x1, z1 = l.y1;
      if (f.green) { // the village green and its windmill
        blocks.push({ poly: rectPoly(x0, z0, x1, z1), type: 'lawn' });
        lots.push({ i: ctx.hub, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: 1.3, d: 1.3, rot: 0 });
        continue;
      }
      // inside a farm: the yard is one patch of the patchwork, each dataset another, fallow strips the rest
      const kids = [{ yard: true, v: Math.max(f.ya, 1.5) }, ...f.fields.map(it => ({ it, v: it.a * 1.6 }))];
      const fallow = Math.max(0, (x1 - x0) * (z1 - z0) - sum(kids.map(k => k.v)));
      for (let k = 0, n = Math.min(4, Math.ceil(fallow / 6)); k < n; k++) kids.push({ fallow: true, v: fallow / n });
      const sub = hierarchy({ children: kids }).sum(n => n.v || 0).sort((a, b) => b.value - a.value);
      treemap().tile(treemapSquarify.ratio(1.6)).size([x1 - x0, z1 - z0]).paddingInner(0.14)(sub);
      for (const p of sub.leaves()) {
        const q = p.data, px0 = x0 + p.x0, pz0 = z0 + p.y0, px1 = x0 + p.x1, pz1 = z0 + p.y1;
        if (q.yard) {
          blocks.push({ poly: rectPoly(px0, pz0, px1, pz1), type: 'lawn' }); // the farmyard: grass, a few trees
          lots.push(...packRect(f.yard, px0, pz0, px1, pz1, 0.22));
        } else {
          blocks.push({ poly: rectPoly(px0, pz0, px1, pz1), type: 'crop', color: CROPS[Math.floor(hash(seed++) * CROPS.length)], rows: hash(seed++) < 0.5 ? 'x' : 'z' });
          if (q.it) lots.push({ i: q.it.i, x: (px0 + px1) / 2, z: (pz0 + pz1) / 2, w: (px1 - px0) * 0.6, d: (pz1 - pz0) * 0.6, rot: 0 });
        }
      }
      if (f.d.name !== '·') labels.push({ text: f.d.name, x: (x0 + x1) / 2, z: z1 + 0.35, weight: f.area });
    }
    return {
      lots, blocks, labels, paths: 'dirt', ground: 'land', land: [rectPoly(-1, -1, side + 1, side + 1)],
      camera: { az: 45, el: 34, dist: 0.9 },
      height: (i, rel) => {
        if (i === ctx.hub) return 3.2;
        const l = files[i].lang;
        return l === 'data' ? 0.2 : l === 'model' ? 1.8 : l === 'nb' ? Math.min(0.7 + 0.35 * Math.pow(rel, 0.4), 1.4) : Math.min(0.5 + 0.25 * Math.pow(rel, 0.4), 1);
      },
    };
  },

  // an industrial town (C and C++): works compounds on both banks of a canal, each district one paved
  // yard of saw-tooth factories, its tests and docs the workers' terraces on the green beside them, and
  // the most-included file the cooling tower at the head of the canal
  industrial(ds, ctx) {
    const items = ds.map(d => ({ d, items: d.items.filter(it => it.i !== ctx.hub) })).filter(x => x.items.length)
      .map(x => ({ ...x, v: sum(x.items.map(it => it.a)) * 1.12 + 1 })); // a little room to load; packRect's padding does the rest
    const total = sum(items.map(x => x.v)), W = Math.sqrt(total * 2.4), C = 2.4; // C: the canal and its two quays
    // biggest compounds first, each to the lighter bank, so the two banks come out even
    const banks = [[], []], load = [0, 0];
    for (const x of [...items].sort((a, b) => b.v - a.v)) { const k = load[0] <= load[1] ? 0 : 1; banks[k].push(x); load[k] += x.v; }
    const lots = [], blocks = [], labels = [];
    banks.forEach((bank, k) => {
      if (!bank.length) return;
      const D = load[k] / W, z0 = k ? C / 2 : -C / 2 - D;
      const root = hierarchy({ children: bank }).sum(x => x.v || 0).sort((a, b) => b.value - a.value);
      treemap().tile(treemapSquarify.ratio(1.4)).size([W, D]).paddingInner(0.5).paddingOuter(0.2)(root);
      for (const l of root.leaves()) {
        const { d, items } = l.data, za = z0 + l.y0, zb = z0 + l.y1;
        blocks.push({ poly: rectPoly(l.x0, za, l.x1, zb), type: d.periphery ? 'lawn' : 'yard' });
        lots.push(...packRect(items, l.x0, za, l.x1, zb, 0.18));
        if (d.name !== '·') labels.push({ text: d.name, x: (l.x0 + l.x1) / 2, z: k ? zb + 0.4 : za - 0.4 });
      }
    });
    const D0 = load[0] / W, D1 = load[1] / W, Q = 0.45; // Q: quay width
    const water = [rectPoly(-0.4, -C / 2 + Q, W + 3.2, C / 2 - Q)];
    const n = Math.max(1, Math.round(W / 7));
    const bridges = Array.from({ length: n }, (_, k) => { const x = (k + 0.5) * W / n; return { a: [x, -C / 2], b: [x, C / 2], w: 0.38 }; });
    // the cooling towers stand on their own pad where the canal ends
    const pad = clamp(Math.sqrt(total) * 0.2, 3.4, 9), px = W + 3.6; // a bigger town has bigger towers
    blocks.push({ poly: rectPoly(px, -pad / 2, px + pad, pad / 2), type: 'yard' });
    lots.push({ i: ctx.hub, x: px + pad / 2, z: 0, w: pad * 0.86, d: pad * 0.86, rot: 0 });
    return {
      lots, blocks, labels, water, bridges,
      land: [rectPoly(-0.6, -C / 2 - D0 - 0.6, px + pad + 0.6, C / 2 + D1 + 0.6)],
      camera: { az: 125, el: 26, dist: 0.9 },
      // works are low and wide; their chimneys and the cooling tower give the skyline
      height: (i, rel) => i === ctx.hub ? pad * 0.9 : Math.min(0.55 + 0.75 * Math.sqrt(rel), 2.6),
    };
  },

  // a science park (model code): institutes on round lawns around a lake, footpaths between them and no
  // traffic. The most-imported file is the ring building, beside the lake
  science(ds, ctx) {
    const FILL = 0.5; // a lab stands in its own grounds
    const plots = ds.map(d => ({ d, items: d.items.filter(it => it.i !== ctx.hub) })).filter(x => x.items.length)
      .map(x => ({ ...x, v: sum(x.items.map(it => it.a)) / FILL }));
    const A = sum(plots.map(p => p.v));
    const lake = { lake: true, v: A * 0.14 + 6 }, ring = { ring: true, v: Math.max(8, A * 0.07) }; // both grow with the park
    // the lake goes in first, so it's the middle of the park, and the ring building beside it
    const root = hierarchy({ children: [lake, ring, ...plots.sort((a, b) => b.v - a.v)] }).sum(x => x.v || 0);
    const S0 = Math.sqrt(A) * 1.5;
    pack().size([S0, S0]).padding(0.5)(root);
    let k = 1; // scale so each institute's square of labs fits inside its lawn
    for (const l of root.leaves()) if (l.data.d) k = Math.max(k, Math.sqrt(l.data.v * FILL / (2 * 0.5 * l.r * l.r)));
    const lots = [], blocks = [], labels = [], water = [];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const l of root.leaves()) {
      const q = l.data, cx = l.x * k, cz = l.y * k, R = l.r * k;
      x0 = Math.min(x0, cx - R); x1 = Math.max(x1, cx + R); z0 = Math.min(z0, cz - R); z1 = Math.max(z1, cz + R);
      if (q.lake) { water.push(circlePoly(cx, cz, R * 0.94, 48)); continue; }
      blocks.push({ poly: circlePoly(cx, cz, R, 40), type: q.d?.periphery ? 'park' : 'lawn' });
      if (q.ring) { lots.push({ i: ctx.hub, x: cx, z: cz, w: R * 1.45, d: R * 1.45, rot: 0 }); continue; }
      // the labs fill a square sized to them, in the middle of their lawn (not a corner of a bigger one)
      const s = Math.min(R * 0.7, Math.sqrt(sum(q.items.map(it => it.a)) / 0.62) / 2);
      lots.push(...packRect(q.items, cx - s, cz - s, cx + s, cz + s, 0.24));
      if (q.d.name !== '·') labels.push({ text: q.d.name, x: cx, z: cz + R + 0.4 });
    }
    return {
      lots, blocks, labels, water, ground: 'land', paths: 'paved',
      land: [rectPoly(x0 - 1, z0 - 1, x1 + 1, z1 + 1)],
      camera: { az: 45, el: 30, dist: 0.95 },
      height: (i, rel) => i === ctx.hub ? 1.1 : Math.min(0.5 + 0.55 * Math.sqrt(rel), 2),
    };
  },

  // a theme park (a game): the most-imported file is the castle on an island in the middle, and each
  // district is a land, a wedge of the ring around it, its rides scattered on the lawn between paths
  themepark(ds, ctx) {
    const FILL = 0.45;
    const lands = ds.map(d => ({ d, items: d.items.filter(it => it.i !== ctx.hub) })).filter(x => x.items.length);
    for (const l of lands) l.area = sum(l.items.map(it => it.a));
    const total = sum(lands.map(l => l.area)) || 1;
    const r0 = Math.max(2.8, Math.sqrt(ctx.area[ctx.hub] || 1) * 2.2); // the castle's island and its moat
    const R = Math.sqrt(total / (Math.PI * FILL) + (r0 + 0.8) ** 2);
    const MIN = Math.min(0.45, (Math.PI * 2) / Math.max(1, lands.length) * 0.5); // a small land still gets a slice to build on
    const raw = lands.map(l => l.area / total * Math.PI * 2);
    const short = sum(raw.map(x => Math.max(0, MIN - x))), big = sum(raw.filter(x => x > MIN)) || 1;
    const spans = raw.map(x => x <= MIN ? MIN : x - short * (x / big));
    const lots = [{ i: ctx.hub, x: 0, z: 0, w: r0 * 0.95, d: r0 * 0.95, rot: 0 }];
    const blocks = [{ poly: circlePoly(0, 0, r0 - 0.9, 48), type: 'plaza' }], labels = [];
    let t = -Math.PI / 2;
    lands.forEach((l, k) => {
      const t0 = t, t1 = t + spans[k];
      t = t1;
      const rin = r0 + 0.8, rout = R, rm = (rin + rout) / 2, ga = 0.3 / rm, a0 = t0 + ga, a1 = t1 - ga;
      blocks.push({ poly: annularSector(rin, rout, a0, a1), type: l.d.periphery ? 'park' : 'lawn' });
      // rides spread over the whole land on a loose grid (along the arc, out from the middle), then
      // bent into the wedge; each a little off its grid point so the land doesn't look planted in rows
      const W = (a1 - a0) * rm, D = rout - rin, n = l.items.length;
      const cols = Math.max(1, Math.round(Math.sqrt(n * W / D))), rows = Math.ceil(n / cols), cw = W / cols, cd = D / rows;
      [...l.items].sort((a, b) => b.a - a.a).forEach((it, m) => {
        const row = Math.floor(m / cols), col = row % 2 ? cols - 1 - m % cols : m % cols;
        const r = rin + (row + 0.5) * cd, sq = Math.min(Math.sqrt(it.a), Math.min(cw * r / rm, cd) * 0.8);
        const th = a0 + ((col + 0.5) * cw + (hash(it.i) - 0.5) * (cw - sq) * 0.8) / rm, rr = r + (hash(it.i + 7) - 0.5) * (cd - sq) * 0.8;
        lots.push({ i: it.i, x: Math.cos(th) * rr, z: Math.sin(th) * rr, w: sq, d: sq, rot: -(th + Math.PI / 2) });
      });
      const tm = (t0 + t1) / 2, rl = R + 0.7;
      if (l.d.name !== '·') labels.push({ text: l.d.name, x: Math.cos(tm) * rl, z: Math.sin(tm) * rl });
    });
    const water = [circlePoly(0, 0, r0 + 0.25, 48)];
    const bridges = [0, 1, 2, 3].map(q => { const a = q * Math.PI / 2 + Math.PI / 4; return { a: [Math.cos(a) * (r0 - 1.1), Math.sin(a) * (r0 - 1.1)], b: [Math.cos(a) * (r0 + 0.9), Math.sin(a) * (r0 + 0.9)], w: 0.5 }; });
    return {
      lots, blocks, labels, water, bridges, ground: 'land', paths: 'paved',
      land: [rectPoly(-R - 1.2, -R - 1.2, R + 1.2, R + 1.2)],
      camera: { az: 45, el: 32, dist: 0.9 },
      height: (i, rel) => i === ctx.hub ? r0 * 1.15 : Math.min(0.6 + 0.85 * Math.sqrt(rel), 3.2),
    };
  },

  // a seaside resort (an app): the town in a strip behind the promenade, its tests and docs a row of
  // beach huts on the sand, and the most-imported file the grand hotel out on its own island
  resort(ds, ctx) {
    const parts = ds.map(d => ({ d, items: d.items.filter(it => it.i !== ctx.hub) })).filter(x => x.items.length);
    const town = parts.filter(x => !x.d.periphery), sand = parts.filter(x => x.d.periphery);
    const tv = x => sum(x.items.map(it => it.a)) / 0.85;
    const total = sum(town.map(tv)) || 4;
    const W = Math.sqrt(total * 3.2), D = total / W; // a long seafront
    const lots = [], blocks = [], labels = [];
    if (town.length) {
      const root = hierarchy({ children: town.map(x => ({ x, v: tv(x) })) }).sum(n => n.v || 0).sort((a, b) => b.value - a.value);
      treemap().tile(treemapSquarify.ratio(1.2)).size([W, D]).paddingInner(0.35)(root);
      for (const l of root.leaves()) {
        const { d, items } = l.data.x;
        blocks.push({ poly: rectPoly(l.x0, l.y0, l.x1, l.y1), type: ground(d) });
        lots.push(...packRect(items, l.x0, l.y0, l.x1, l.y1, 0.1));
        if (d.name !== '·') labels.push({ text: d.name, x: (l.x0 + l.x1) / 2, z: l.y0 - 0.4 });
      }
    }
    // the beach: deep enough for its huts, which stand in loose rows along the sand
    const huts = sand.flatMap(x => x.items), hutA = sum(huts.map(it => Math.min(it.a, 0.6)));
    const z0 = D + 0.45, B = Math.max(1.6, hutA / 0.3 / W + 0.6);
    blocks.push({ poly: rectPoly(-0.6, z0, W + 0.6, z0 + B), type: 'beach' });
    if (huts.length) {
      const rows = Math.max(1, Math.round(Math.sqrt(huts.length * (B - 0.6) / W))), cols = Math.ceil(huts.length / rows);
      const cw = W / cols, cd = (B - 0.6) / rows, sq = Math.min(cw, cd) * 0.7;
      huts.forEach((it, m) => lots.push({ i: it.i, x: (m % cols + 0.5) * cw, z: z0 + 0.15 + (Math.floor(m / cols) + 0.5) * cd, w: sq, d: sq, rot: 0 }));
      for (const x of sand) if (x.d.name !== '·') { const at = huts.indexOf(x.items[0]); labels.push({ text: x.d.name, x: (at % cols + 0.5) * cw, z: z0 + B + 0.3 }); }
    }
    // the grand hotel's island, and the causeway out to it
    const rI = clamp(Math.sqrt(total) * 0.12, 1.4, 5), iz = z0 + B + 1.6 + rI, ix = W * 0.62;
    lots.push({ i: ctx.hub, x: ix, z: iz, w: rI * 1.2, d: rI * 1.2, rot: 0 });
    return {
      lots, blocks, labels, ground: 'water',
      land: [rectPoly(-0.6, -0.6, W + 0.6, z0 + B), circlePoly(ix, iz, rI, 32)],
      bridges: [{ a: [ix, z0 + B - 0.2], b: [ix, iz - rI + 0.2], w: 0.4 }],
      camera: { az: 60, el: 26, dist: 0.95 },
      height: (i, rel) => i === ctx.hub ? rI * 3.2 : Math.min(0.7 + 1.4 * Math.sqrt(rel), 7),
    };
  },

  // a desert boomtown: a city that wasn't here two years ago. The biggest files are supertall towers
  // in a line along the coast highway, the most-depended-on one a needle on a plaza with a fountain
  // lake; the rest of the code is a grid of blocks inland with empty plots of sand still waiting; and
  // the tests and docs live in villas out on a palm-shaped island.
  desert(ds, ctx) {
    const files = ctx.files;
    const items = ds.flatMap(d => d.items.map(it => ({ ...it, d }))).filter(it => it.i !== ctx.hub);
    const N = items.length;
    const T = clamp(Math.round(N * 0.04), 4, 40);
    // (only code: a lockfile or a manifest is a landmark of its own, never a tower on the strip)
    const towers = new Set(items.filter(it => !['cfg', 'doc', 'lock'].includes(files[it.i].lang)).sort((a, b) => files[b.i].loc - files[a.i].loc).slice(0, T).map(it => it.i));
    const villas = items.filter(it => !towers.has(it.i) && (PERIPH_RE.test(it.d.name + '/') || PERIPH_RE.test(outerPath(files[it.i].p))));
    const villaSet = new Set(villas.map(it => it.i));
    const lots = [], blocks = [], labels = [], water = [], roads = [];
    // the strip: towers either side of the highway, the needle's plaza in the middle
    const RD = 0.6, side = it => clamp(Math.sqrt(it.a) * 1.1, 1.0, 2.4);
    const strip = [...items].filter(it => towers.has(it.i)).sort((a, b) => files[b.i].loc - files[a.i].loc);
    const rows = [[], []];
    strip.forEach((it, n) => rows[n % 2].push(it));
    // middle-out along each row, so the tallest stand near the needle
    const arrange = list => { const out = []; list.forEach((it, n) => (n % 2 ? out.push(it) : out.unshift(it))); return out; };
    const HP = 4.5; // the needle's plaza
    const rowLen = list => sum(list.map(it => side(it) + 0.7));
    const L = Math.max(rowLen(rows[0]), rowLen(rows[1])) + HP + 2;
    rows.forEach((list, r) => {
      const arr = arrange(list), half = Math.ceil(arr.length / 2);
      let xl = -HP / 2 - 0.7, xr = HP / 2 + 0.7;
      arr.forEach((it, n) => {
        const s = side(it), left = n < half;
        const x = left ? xl - s / 2 : xr + s / 2;
        if (left) xl -= s + 0.7; else xr += s + 0.7;
        const z = r ? RD + 0.4 + s / 2 : -RD - 0.4 - s / 2;
        blocks.push({ poly: rectPoly(x - s / 2 - 0.15, z - s / 2 - 0.15, x + s / 2 + 0.15, z + s / 2 + 0.15), type: 'plaza' });
        lots.push({ i: it.i, x, z, w: s * 0.8, d: s * 0.8, rot: 0 });
      });
    });
    blocks.push({ poly: rectPoly(-HP / 2, -RD - 0.4 - HP, HP / 2, -RD - 0.4), type: 'plaza' });
    lots.push({ i: ctx.hub, x: 0, z: -RD - 0.4 - HP * 0.62, w: 1.6, d: 1.6, rot: 0 });
    water.push(circlePoly(HP / 2 + 1.5, -RD - 0.4 - HP * 0.75, 0.7, 20)); // the fountain lake beside it
    roads.push({ a: [-L / 2 - 2, 0], b: [L / 2 + 2, 0], w: RD * 1.6 });
    // inland: districts on a grid, with plots of open sand still waiting for someone to build on them
    const inland = ds.map(d => ({ d, items: d.items.filter(it => it.i !== ctx.hub && !towers.has(it.i) && !villaSet.has(it.i)) })).filter(g => g.items.length);
    const A = sum(inland.flatMap(g => g.items.map(it => it.a)));
    const cells = [];
    for (const g of inland) for (const c of chunk(g.items, 7)) cells.push({ d: g.d, items: c, a: sum(c.map(it => it.a)) });
    const vacant = Math.round(cells.length * 0.35);
    for (let k = 0; k < vacant; k++) cells.splice(Math.floor(hash(k + 3) * (cells.length + 1)), 0, { vacant: true, a: 4 + hash(k) * 4 });
    const W = Math.max(L, Math.sqrt((A + vacant * 6) / 0.55) * 1.2), D = (A + vacant * 6) / 0.55 / W + 1;
    const z0 = -RD - 0.4 - HP - 1.2;
    const root = hierarchy({ children: cells }).sum(c => c.a || 0);
    treemap().tile(treemapSquarify.ratio(1)).size([W, D]).paddingInner(0.7)(root);
    const seen = new Set();
    // (a handful of files can all be towers and villas, leaving nothing inland: the root is then its only leaf)
    for (const l of cells.length ? root.leaves() : []) {
      const c = l.data;
      if (c.vacant) continue;
      const x0 = l.x0 - W / 2, x1 = l.x1 - W / 2, zA = z0 - l.y1, zB = z0 - l.y0;
      blocks.push({ poly: rectPoly(x0, zA, x1, zB), type: ground(c.d) });
      lots.push(...packRect(c.items, x0, zA, x1, zB, 0.08));
      if (!seen.has(c.d) && c.d.name !== '·') { seen.add(c.d); labels.push({ text: c.d.name, x: (x0 + x1) / 2, z: zA - 0.35 }); }
    }
    // the sea, and the palm island in it: a trunk out from the beach, fronds of villas, a crescent
    const zSea = RD + 0.4 + 2.4 + 1.6;
    const VA = sum(villas.map(it => it.a));
    const F = clamp(Math.round(Math.sqrt(villas.length) * 1.2), villas.length ? 4 : 0, 18);
    const perFrond = Math.ceil(villas.length / Math.max(1, F)), fl = clamp(perFrond * 0.75, 2.5, 9);
    const trunkX = L * 0.22, trunkL = Math.ceil(F / 2) * 1.6 + 2.5;
    // sand to the horizon; the sea only on the coast side, with the palm and its crescent as sandbars
    const sand = poly => blocks.push({ poly, type: 'beach' });
    water.push(rectPoly(-W / 2 - 60, zSea, W / 2 + 60, zSea + trunkL + fl + 40));
    if (F) {
      sand(rectPoly(trunkX - 0.5, zSea - 0.2, trunkX + 0.5, zSea + trunkL));
      for (let k = 0; k < F; k++) {
        const z = zSea + 2.2 + Math.floor(k / 2) * 1.6, dir = k % 2 ? 1 : -1;
        const xa = trunkX + dir * 0.5, xb = trunkX + dir * (0.5 + fl);
        sand(rectPoly(Math.min(xa, xb), z - 0.4, Math.max(xa, xb), z + 0.4));
        const mine = villas.slice(k * perFrond, (k + 1) * perFrond);
        mine.forEach((it, n) => {
          const t = (n + 0.5) / Math.max(1, mine.length);
          lots.push({ i: it.i, x: xa + (xb - xa) * t, z, w: Math.min(0.62, fl / Math.max(1, mine.length) * 0.8), d: 0.5, rot: 0 });
        });
      }
      // the crescent breakwater round the palm
      const cr = [], R0 = fl + 2.2, R1 = R0 + 0.6, czc = zSea + trunkL * 0.5;
      for (let k = 0; k <= 30; k++) { const a = -0.1 + Math.PI * 1.2 * k / 30; cr.push([trunkX + Math.cos(a + Math.PI * -0.1) * R1, czc + Math.sin(a) * R1 * 0.9]); }
      for (let k = 30; k >= 0; k--) { const a = -0.1 + Math.PI * 1.2 * k / 30; cr.push([trunkX + Math.cos(a + Math.PI * -0.1) * R0, czc + Math.sin(a) * R0 * 0.9]); }
      sand(cr);
      void VA;
    }
    return {
      lots, blocks, labels, water, roads, sand: true, ground: 'land',
      camera: { az: 45, el: 30, dist: 0.9 },
      height: (i, rel) => i === ctx.hub ? 16 : towers.has(i) ? Math.min(3 + 4 * Math.pow(rel, 0.4), 11) : villaSet.has(i) ? 0.45 : Math.min(0.5 + 0.7 * Math.pow(rel, 0.5), 2.4),
    };
  },

  // a planned capital: layers of the design laid out along a monumental axis. The foundation layer
  // (what everything else builds on) stands at the head, on a plaza by a lake, with the congress; each
  // layer above it steps back down the axis in rows of superblocks; and the biggest layer, with the
  // tests and docs, sweeps across the axis as two curved wings.
  capital(ds, ctx) {
    const files = ctx.files;
    const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
    const pk = new Map(); // package (directory) → { name, items, periphery }
    for (const d of ds) for (const it of d.items) {
      if (it.i === ctx.hub) continue;
      const k = dirOf(files[it.i].p);
      if (!pk.has(k)) pk.set(k, { name: k, items: [], periphery: PERIPH_RE.test(k + '/') });
      pk.get(k).items.push(it);
    }
    const P = [...pk.values()], index = new Map(P.map((p, n) => [p.name, n]));
    // package graph → layers: a package's layer is the longest chain of packages beneath it
    const adj = P.map(() => new Set());
    for (const [n, p] of P.entries()) for (const it of p.items) for (const j of files[it.i].imp) {
      const m = index.get(dirOf(files[j].p));
      if (m !== undefined && m !== n && !P[m].periphery) adj[n].add(m);
    }
    const comp = tarjan(adj), nc = comp.reduce((m, c) => Math.max(m, c), -1) + 1, lvlC = new Array(nc).fill(0);
    const cadj = Array.from({ length: nc }, () => new Set());
    adj.forEach((out, a) => out.forEach(b => { if (comp[a] !== comp[b]) cadj[comp[a]].add(comp[b]); }));
    for (let k = 0; k < nc; k++) for (const t of cadj[k]) lvlC[k] = Math.max(lvlC[k], lvlC[t] + 1);
    P.forEach((p, n) => { p.area = sum(p.items.map(it => it.a)); p.side = clamp(Math.sqrt(p.area / 0.55), 1.6, 6.5); p.level = lvlC[comp[n]]; });
    const core = P.filter(p => !p.periphery), periph = P.filter(p => p.periphery);
    const levels = [];
    for (const p of core) (levels[p.level] ||= []).push(p);
    for (let l = 0; l < levels.length; l++) levels[l] = (levels[l] || []).sort((a, b) => b.area - a.area);
    // the wings: the biggest layer above the foundation (and every test / doc package)
    let wl = -1, wa = 0;
    levels.forEach((ps, l) => { const a = sum(ps.map(p => p.area)); if (l > 0 && ps.length >= 3 && a > wa) { wa = a; wl = l; } });
    const wing = [...(wl >= 0 ? levels[wl] : []), ...periph.sort((a, b) => b.area - a.area)];

    const lots = [], blocks = [], labels = [], water = [];
    const E = 2.2, G = 0.8; // half-width of the esplanade, gap between superblocks
    const taken = []; // every superblock (and the head) so far, as [x0, z0, x1, z1]
    const superblock = (p, x0, z0) => {
      taken.push([x0, z0, x0 + p.side, z0 + p.side]);
      blocks.push({ poly: rectPoly(x0, z0, x0 + p.side, z0 + p.side), type: 'lawn' });
      lots.push(...packRect(p.items, x0 + 0.2, z0 + 0.2, x0 + p.side - 0.2, z0 + p.side - 0.2, 0.14));
      labels.push({ text: p.name.split('/').pop(), path: p.name, x: x0 + p.side / 2, z: z0 + p.side + 0.35, weight: p.area });
    };
    // the head: the congress on its plaza, the lake behind
    const PL = 6;
    blocks.push({ poly: rectPoly(0, -E - 2, PL, E + 2), type: 'plaza' });
    taken.push([0, -E - 2, PL, E + 2]);
    lots.push({ i: ctx.hub, x: PL * 0.5, z: 0, w: 3.6, d: 2.6, rot: 0 });
    const lake = [];
    // wrapped round the head of the axis, just clear of the plaza
    const r0 = Math.hypot(PL / 2, E + 2) + 1.2, r1 = r0 + 5.5;
    for (let k = 0; k <= 36; k++) { const a = -1.75 + 3.5 * k / 36; lake.push([PL / 2 + Math.cos(a) * r0, Math.sin(a) * r0 * 1.1]); }
    for (let k = 36; k >= 0; k--) { const a = -1.75 + 3.5 * k / 36; lake.push([PL / 2 + Math.cos(a) * r1, Math.sin(a) * r1 * 1.1]); }
    water.push(lake);
    taken.push([PL / 2 + Math.cos(1.75) * r1, -r1 * 1.1, PL / 2 + r1, r1 * 1.1]);
    // the wings: an arc bowed towards the head, half each side of the axis. Laid out first round a
    // crossing at x = 0, then slid down the axis until the arc clears everything nearer the head
    const wings = () => {
      // each wing sweeps out to at most SWEEP radians; when a row is full the next row starts a block
      // further out, so a huge layer makes thicker wings rather than a ring
      const SWEEP = 1.25, total = sum(wing.map(p => p.side + G));
      const RA = clamp(total / 2 / SWEEP, 10, 40), maxS = Math.max(...wing.map(p => p.side));
      const slot = [{ row: 0, th: (E + 1.2) / RA }, { row: 0, th: (E + 1.2) / RA }];
      const mine = [[], []], at = [];
      const clash = (q, list) => list.some(o => q[0] < o[2] + G && o[0] < q[2] + G && q[1] < o[3] + G && o[1] < q[3] + G);
      wing.forEach((p, n) => {
        const sl = slot[n % 2], side = n % 2 ? 1 : -1, h = p.side / 2;
        for (;;) {
          const r = RA + sl.row * (maxS + G), a = sl.th + h / r;
          if (a + h / r > SWEEP) { sl.row++; sl.th = (E + 1.2) / (RA + sl.row * (maxS + G)); continue; }
          const px = RA - Math.cos(a) * r, pz = side * Math.sin(a) * r;
          const q = [px - h, pz - h, px + h, pz + h];
          // (squares round a curve can touch corners where the arc runs diagonal: slide on until clear)
          if (clash(q, mine[n % 2])) { sl.th += 0.15 / r; continue; }
          mine[n % 2].push(q); at.push([p, q]);
          sl.th = a + (h + G) / r;
          break;
        }
      });
      // as far up the axis as the arc can sit without reaching a superblock, the plaza or the lake
      let cx = x - 3;
      for (const [, q] of at) for (const o of taken) if (q[1] < o[3] + G && o[1] < q[3] + G) cx = Math.min(cx, o[0] - G - q[2]);
      for (const [p, q] of at) superblock(p, cx + q[0], q[1]);
      x = Math.min(x - 6, cx + Math.min(...at.map(([, q]) => q[0])) - 1.6);
    };
    // down the axis: each layer's packages in two rows either side of the esplanade
    let x = -G;
    levels.forEach((ps, l) => {
      if (l === wl) { wings(); return; } // the wings cross here
      // each side of the esplanade gets columns of superblocks stacked outward, so a big layer is
      // a deep sector rather than a very long row
      const sides = [[], []];
      ps.forEach((p, n) => sides[n % 2].push(p));
      const len = sides.map(list => {
        const K = Math.max(1, Math.ceil(Math.sqrt(list.length / 1.5)));
        let cx = x;
        for (let c = 0; c < list.length; c += K) {
          const col = list.slice(c, c + K), cw = Math.max(...col.map(p => p.side));
          let out = E + 0.6;
          for (const p of col) { superblock(p, cx - cw / 2 - p.side / 2, list === sides[1] ? out : -out - p.side); out += p.side + G; }
          cx -= cw + G;
        }
        return x - cx;
      });
      x -= Math.max(...len, 0) + 1.6;
    });
    if (wing.length && wl < 0) wings();
    // the esplanade: a long lawn from the plaza to the last layer
    blocks.push({ poly: rectPoly(x, -E + 0.4, -G * 0.5, E - 0.4), type: 'lawn' });
    return {
      lots, blocks, labels, water, ground: 'land',
      land: [rectPoly(x - 4, -E - 30, PL + 14, E + 30)],
      camera: { az: 45, el: 40, dist: 0.95 },
      // a planned city keeps an even skyline; the congress towers over it
      height: (i, rel) => i === ctx.hub ? 3.4 : 0.95 + 0.18 * Math.tanh(Math.log(rel)),
    };
  },

  // a mountain city: the directory tree *is* the mountain. Every package is a round terrace and its
  // subpackages are higher terraces inside it, like contour lines; the main code and the tests are two
  // mountains across a river, joined by bridges and a cable car; and the empty directories every path
  // climbs through (src/main/java/org/acme/…) are a long stairway up from the water.
  mountain(ds, ctx) {
    const STEP = 0.55, STAIR = 0.22, GAP = 5;
    const TEST = /(^|\/)(src\/test|tests?|__tests__|specs?|testing)\//;
    const files = ctx.files;
    const all = ds.flatMap(d => d.items);
    let banks = [all.filter(it => !TEST.test(files[it.i].p)), all.filter(it => TEST.test(files[it.i].p))];
    if (banks[1].length < all.length * 0.1) banks = [all];
    // a repo that's all tests has nothing on the main bank: one mountain then, made of the tests
    banks = banks.filter(b => b.length);
    if (!banks.length) return { lots: [], blocks: [], labels: [], ground: 'land', land: [rectPoly(-2, -2, 2, 2)], height: () => 1 };
    const lots = [], blocks = [], labels = [], stairs = [], cables = [], tops = [];
    let xOff = 0, prevR = 0;
    const placed = [];
    banks.forEach((items, b) => {
      // the bank's directory tree, with empty single-child directories collapsed into a staircase
      const root = { name: '', kids: new Map(), files: [] };
      for (const it of items) {
        let n = root;
        for (const sg of files[it.i].p.split('/').slice(0, -1)) {
          if (!n.kids.has(sg)) n.kids.set(sg, { name: sg, kids: new Map(), files: [] });
          n = n.kids.get(sg);
        }
        n.files.push(it);
      }
      // the longest run of empty floors anywhere in the bank is the stairway's flight count
      let climb = 0;
      const collapse = n => { // returns the node plus how many empty floors it swallowed
        let steps = 0;
        while (!n.files.length && n.kids.size === 1) { const [c] = n.kids.values(); n = { ...c, name: n.name ? n.name + '/' + c.name : c.name }; steps++; }
        climb = Math.max(climb, steps);
        n.kids = new Map([...n.kids].map(([k, c]) => [k, collapse(c).n]));
        return { n, steps };
      };
      const top = collapse(root);
      const toD3 = n => ({ name: n.name, children: [...[...n.kids.values()].map(toD3), ...n.files.map(it => ({ it }))] });
      const h = hierarchy(toD3(top.n)).sum(d => d.it ? d.it.a : 0).sort((p, q) => q.value - p.value);
      pack().radius(d => Math.sqrt(d.data.it.a) * 0.62).padding(d => d.depth === 0 ? 0.5 : 0.28)(h);
      const R = h.r;
      // a big mountain climbs in bigger steps, so it still reads as a mountain and not a stack of plates
      const step = clamp(R * 0.11, STEP, 2.4), base = climb * STAIR * step / STEP;
      // banks side by side across the river, the second a little downstream
      const gap = Math.max(GAP, (prevR + R) * 0.3); // tall mountains need a wider valley to see the river
      const cx = b === 0 ? 0 : xOff + prevR + gap + R, cz = b === 0 ? 0 : prevR * 0.35;
      xOff = cx; prevR = R;
      const elev = n => base + (n.depth + 1) * step;
      let peak = null;
      h.each(n => {
        const x = cx + n.x - h.x, z = cz + n.y - h.y;
        if (n.data.it) {
          const s = n.r * 1.3;
          lots.push({ i: n.data.it.i, x, z, w: s, d: s, rot: 0, y: elev(n.parent) });
          return;
        }
        const e = elev(n);
        blocks.push({ poly: circlePoly(x, z, n.r, Math.max(12, Math.min(48, Math.round(n.r * 10)))), type: 'lawn', h: e });
        if (!peak || e > peak.e || (e === peak.e && n.r > peak.r)) peak = { x, z, e, r: n.r };
        if (n.depth === 1 || (n.depth === 0 && !n.children?.some(c => c.children))) labels.push({ text: n.data.name.split('/').pop() || n.data.name, path: n.data.name, x, z: z + n.r + 0.3, y: e, weight: n.value });
      });
      tops.push(peak);
      placed.push({ cx, cz, R });
      // the stairway: one flight per empty directory, from the riverside up to the first terrace
      if (climb > 0) {
        const a = b === 0 ? 0 : Math.PI; // face the river
        const ex = cx + Math.cos(a) * R, ez = cz + Math.sin(a) * R;
        stairs.push({ x: ex, z: ez, dx: Math.cos(a), dz: Math.sin(a), n: climb, rise: STAIR, run: Math.min(0.5, GAP / 2 / climb), w: 0.6, top: base + step });
      }
    });
    // the river between the mountains (or along the one mountain), with a bend in it
    const [A, Bk] = [placed[0], placed[1]];
    const rx = A.cx + A.R + (Bk ? (Bk.cx - Bk.R - A.cx - A.R) / 2 : GAP / 2);
    const span = Math.max(A.R, Bk?.R || 0) * 5, W = Bk ? Math.max(1.7, (Bk.cx - Bk.R - A.cx - A.R) * 0.3) : 1.7;
    const left = [], right = [];
    for (let k = 0; k <= 80; k++) {
      const t = k / 80, z = -span + (2 * span + (Bk ? Bk.cz : 0)) * t;
      // the river swings wide away from the mountains and narrows between them
      const near = Math.max(0, 1 - Math.abs(z - (Bk ? Bk.cz / 2 : 0)) / (Math.max(A.R, Bk?.R || 0) * 1.1));
      const wob = Math.sin(t * Math.PI * 5) * (1 - near) * 2.2, w = W * (1.5 - 0.5 * near);
      left.push([rx - w + wob, z]); right.unshift([rx + w + wob, z]);
    }
    const water = [[...left, ...right]];
    const bridges = [];
    if (Bk) {
      for (const f of [0.2, -0.45]) { const z = A.cz + A.R * f; bridges.push({ a: [rx - W - 0.9, z], b: [rx + W + 0.9, z], w: 0.42 }); }
      const [p, q] = tops;
      cables.push({ a: [p.x, p.z, p.e + 2.6], b: [q.x, q.z, q.e + 2.6] });
    }
    const all2 = placed.map(p => [p.cx - p.R - 2, p.cz - p.R - 2, p.cx + p.R + 2, p.cz + p.R + 2]);
    const x0 = Math.min(...all2.map(r => r[0]), rx - 3), x1 = Math.max(...all2.map(r => r[2]), rx + 3);
    const z0 = Math.min(...all2.map(r => r[1])), z1 = Math.max(...all2.map(r => r[3]));
    return {
      lots, blocks, labels, water, bridges, stairs, cables, ground: 'land', land: [rectPoly(x0, z0, x1, z1)],
      camera: { az: 45, el: 32, dist: 1.05 },
      // tall, thin towers on every terrace: the city grows up because there's no room to grow out
      height: (i, rel) => i === ctx.hub ? 7 : Math.min(0.6 + 1.5 * Math.pow(rel, 0.55), 6),
    };
  },

  // a university: every directory is a quadrangle, buildings round a lawn courtyard, footpaths between
  // the quads, and the most-linked page (the table of contents, usually) as the library on the main square
  university(ds, ctx) {
    const S = 4.6, ST = 1.1, RD = 0.95, IN = 0.25;
    const SIDE = S - 2 * IN;
    const cap = (SIDE * 4 - RD * 4) * RD * 0.92;
    const groups = [];
    for (const d of ds) {
      const byDir = new Map();
      for (const it of d.items) if (it.i !== ctx.hub) { const key = d.name + '/' + it.dir; if (!byDir.has(key)) byDir.set(key, []); byDir.get(key).push(it); }
      let cur = [], used = 0;
      const flush = () => { if (cur.length) groups.push({ d, items: cur }); cur = []; used = 0; };
      for (const items of byDir.values()) {
        const tot = sum(items.map(it => it.a));
        if (tot >= cap * 0.6) { flush(); for (const c of chunk(items, cap)) groups.push({ d, items: c }); continue; }
        if (used + tot > cap) flush();
        cur.push(...items); used += tot;
      }
      flush();
    }
    const K = groups.length + 1;
    const C = Math.ceil(Math.sqrt(K * 1.3)), R = Math.ceil(K / C);
    const center = Math.floor(R / 2) * C + Math.floor(C / 2);
    const lots = [], blocks = [], labels = [], seen = new Set();
    let g = 0;
    // (the main square is always laid out, even when the quads run out before the grid's centre)
    for (let cell = 0; cell < C * R; cell++) {
      const x0 = (cell % C) * (S + ST), z0 = Math.floor(cell / C) * (S + ST);
      if (cell === center) { // the main square: the library on a paved court
        blocks.push({ poly: rectPoly(x0, z0, x0 + S, z0 + S), type: 'plaza' });
        lots.push({ i: ctx.hub, x: x0 + S / 2, z: z0 + S / 2, w: 2.2, d: 2.2, rot: 0 });
        continue;
      }
      if (g >= groups.length) continue;
      const { d, items } = groups[g++];
      blocks.push({ poly: rectPoly(x0, z0, x0 + S, z0 + S), type: 'lawn' });
      // ranges along the four sides; corners belong to the north and south ranges. Buildings are never
      // rotated (their windows face the camera); the east and west ranges just swap width and depth.
      const sides = [
        { x: x0 + IN, z: z0 + IN, dx: 1, dz: 0, len: SIDE },                  // north
        { x: x0 + S - IN - RD, z: z0 + IN + RD, dx: 0, dz: 1, len: SIDE - 2 * RD }, // east
        { x: x0 + IN, z: z0 + S - IN - RD, dx: 1, dz: 0, len: SIDE },          // south
        { x: x0 + IN, z: z0 + IN + RD, dx: 0, dz: 1, len: SIDE - 2 * RD },     // west
      ];
      const ring = ringWidths(items.map(it => Math.max(0.5, it.a / RD)), sides.map(sd => sd.len));
      items.forEach((it, n) => {
        const [s, along, w] = ring[n], sd = sides[s], c = along + w / 2;
        lots.push(sd.dx ? { i: it.i, x: sd.x + c, z: sd.z + RD / 2, w: w * 0.94, d: RD * 0.9, rot: 0 }
          : { i: it.i, x: sd.x + RD / 2, z: sd.z + c, w: RD * 0.9, d: w * 0.94, rot: 0 });
      });
      if (!seen.has(d) && d.name !== '·') { seen.add(d); labels.push({ text: d.name, x: x0 + S / 2, z: z0 + S + ST / 2 }); }
    }
    const W = C * (S + ST), H = R * (S + ST);
    return {
      lots, blocks, labels, paths: true, ground: 'land', land: [rectPoly(-ST, -ST, W, H)],
      camera: { az: 45, el: 38, dist: 1.0 },
      height: (i, rel) => i === ctx.hub ? 3.4 : Math.min(0.85 + 0.3 * Math.pow(rel, 0.4), 1.7),
    };
  },

  // a harbour: every infrastructure directory is a pier reaching into the water, basins between them
  // for the ships, a quay road along the shore, any application code in the town behind it, and the
  // most-depended-on file as a lighthouse at the end of the breakwater
  port(ds, ctx) {
    const infra = it => ctx.files[it.i].a?.r === 'infra';
    const BASIN = 1.6, FILL = 0.72;
    const sea = [], town = [];
    for (const d of ds) {
      const items = d.items.filter(it => it.i !== ctx.hub);
      if (!items.length) continue;
      (items.filter(infra).length >= items.length / 2 ? sea : town).push({ d, items });
    }
    const A = sum(sea.flatMap(g => g.items.map(it => it.a)));
    const K = clamp(Math.round(Math.sqrt(A / 7)), 1, 12); // about as many piers as keeps the harbour square-ish
    const cap = Math.max(2.4 * 3 * FILL, A / K * 1.15);
    const PW = clamp(Math.sqrt(cap) * 0.55, 2.4, 5); // long piers get wider, so none is a needle
    // a directory with a pier's worth of files gets its own pier (or several); small ones share
    const piers = [];
    let cur = null;
    for (const { d, items } of middleOut(sea.map(g => ({ ...g, area: sum(g.items.map(it => it.a)) }))).map(g => g)) {
      const tot = sum(items.map(it => it.a));
      if (tot >= cap * 0.45) { cur = null; for (const c of chunk(items, cap)) piers.push({ names: [d.name], items: c, d }); continue; }
      if (!cur || sum(cur.items.map(it => it.a)) + tot > cap) { cur = { names: [], items: [], d }; piers.push(cur); }
      cur.names.push(d.name); cur.items.push(...items);
    }
    const lots = [], blocks = [], land = [], labels = [], ships = [];
    let x = 0, maxL = 0, prevL = 0;
    for (const [k, p] of piers.entries()) {
      const used = sum(p.items.map(it => it.a));
      const L = Math.max(2.4, used / (PW * FILL) + 0.5);
      maxL = Math.max(maxL, L);
      // a ship tied up alongside, in the basin between this pier and the last
      const berth = Math.min(L, prevL);
      if (k > 0 && berth > 3 && hash(k * 7 + ctx.files.length) < 0.7) {
        const len = Math.min(berth * 0.8, 9), side = hash(k * 3) < 0.5;
        ships.push({ x: side ? x - BASIN * 0.3 : x - BASIN * 0.7, z: 0.4 + len / 2 + hash(k * 5) * (berth - len - 0.4), len, beam: 0.62, rot: hash(k * 11) < 0.5 ? Math.PI / 2 : -Math.PI / 2, seed: k });
      }
      prevL = L;
      land.push(rectPoly(x, -0.2, x + PW, L));
      blocks.push({ poly: rectPoly(x + 0.08, 0.15, x + PW - 0.08, L - 0.08), type: 'yard' });
      lots.push(...packRect(p.items, x + 0.12, 0.2, x + PW - 0.12, L - 0.12, 0.1));
      const name = p.names.filter(n => n !== '·')[0];
      if (name) labels.push({ text: p.names.length > 1 ? `${name} +${p.names.length - 1}` : name, x: x + PW / 2, z: L + 0.7 });
      x += PW + BASIN;
    }
    const X1 = Math.max(x - BASIN, PW);
    // the town behind the quay: application code, packed into ordinary blocks sized to what's there
    const townA = sum(town.flatMap(g => g.items.map(it => it.a)));
    // (sized by its own code, not by the harbour: with no piers at all it would be one pier wide)
    const TD = clamp(Math.sqrt(townA / 0.55) * 0.6, 1.2, 12), TW = townA / 0.55 / TD;
    const LD = townA ? TD + 1.0 : 1.2;
    if (townA) {
      const root = hierarchy({ children: town.map(g => ({ g, v: sum(g.items.map(it => it.a)) })) }).sum(n => n.v || 0).sort((a, b) => b.value - a.value);
      treemap().tile(treemapSquarify.ratio(1)).size([TW, TD]).paddingInner(0.35)(root);
      for (const l of root.leaves()) {
        const z0 = -LD + l.y0, z1 = -LD + l.y1;
        blocks.push({ poly: rectPoly(l.x0, z0, l.x1, z1), type: ground(l.data.g.d) });
        lots.push(...packRect(l.data.g.items, l.x0, z0, l.x1, z1, 0.07));
        if (l.data.g.d.name !== '·') labels.push({ text: l.data.g.d.name, x: (l.x0 + l.x1) / 2, z: z0 - 0.4 });
      }
    }
    // a concrete apron along the whole waterfront; grass only behind the town, where there is one
    const M = 0.8;
    const QX = Math.max(X1 + BASIN + 0.5, townA ? TW + M : 0); // the quay runs the length of the harbour and the town
    land.push(rectPoly(-M, -1.4, QX, 0));
    blocks.push({ poly: rectPoly(-M, -1.4, QX, -0.9), type: 'yard' });
    if (townA) land.push(rectPoly(-M, -LD - M, TW + M, -1.0));
    // breakwater curling round the harbour mouth, lighthouse on its head
    const bx = X1 + BASIN, bz = maxL + 1.6;
    const arm = [rectPoly(bx, -0.2, bx + 0.5, bz), rectPoly(bx - Math.min(X1 * 0.35, 6), bz - 0.5, bx + 0.5, bz)];
    land.push(...arm);
    blocks.push(...arm.map(poly => ({ poly, type: 'yard' }))); // concrete, not lawn
    const hubLot = { i: ctx.hub, x: bx - Math.min(X1 * 0.35, 6) + 0.45, z: bz - 0.25, w: 0.7, d: 0.7, rot: 0 };
    lots.push(hubLot);
    return {
      lots, blocks, land, labels, ships, ground: 'water',
      roads: [{ a: [-M, -0.45], b: [Math.max(bx + 0.5, QX), -0.45], w: 0.6 }],
      camera: { az: 60, el: 30, dist: 0.78 },
      height: (i, rel) => i === ctx.hub ? 4.2 : Math.min(0.4 + 0.35 * Math.pow(rel, 0.4), 1.4),
    };
  },

  // one main street, houses on both sides, a church on the square
  smalltown(ds, ctx) {
    const items = ds.flatMap(d => d.items).filter(it => it.i !== ctx.hub);
    const per = Math.max(6, Math.ceil(Math.sqrt(items.length * 2.5)));
    const lots = [], blocks = [], labels = [];
    const hubA = ctx.area[ctx.hub] || 1;
    lots.push({ i: ctx.hub, x: 0, z: -2.4, w: 1.4, d: 2.2, rot: 0 });
    blocks.push({ poly: rectPoly(-2.2, -4, 2.2, -1.1), type: 'plaza' });
    const rows = Math.ceil(items.length / per);
    for (let r = 0; r < rows; r++) {
      const zRow = (r % 2 ? 1.6 : -1.6) + (r >= 2 ? (r % 2 ? 1 : -1) * Math.floor(r / 2) * 4.2 : 0);
      const row = items.slice(r * per, (r + 1) * per);
      const zc = zRow + (zRow < 0 ? -0.5 : 0.5);
      const xStart = -Math.max(row.length, 6) * 0.75;
      let x = xStart, segStart = x;
      for (const it of row) {
        if (r === 0 && x < 2.4 && x + 2.2 > -2.4) { // keep the church square open
          if (x > segStart) blocks.push({ poly: rectPoly(segStart - 0.3, zc - 0.7, x - 0.15, zc + 0.7), type: 'block' });
          x = segStart = 2.6;
        }
        const w = clamp(Math.sqrt(it.a) * 1.1, 0.7, 2.2);
        lots.push({ i: it.i, x: x + w / 2, z: zc, w, d: 1.0, rot: 0 });
        x += w + 0.45;
      }
      blocks.push({ poly: rectPoly(segStart - 0.3, zc - 0.7, x - 0.15, zc + 0.7), type: 'block' });
    }
    const span = Math.max(4, ...lots.map(l => Math.abs(l.x) + l.w / 2)) + 1.2;
    return {
      lots, blocks, labels, roads: [{ a: [-span, 0], b: [span, 0], w: 1.3 }], ground: 'land',
      camera: { az: 62, el: 26, dist: 0.55 },
      height: (i, rel) => i === ctx.hub ? 2.4 : Math.min(0.35 + 0.25 * Math.pow(rel, 0.4), 0.9),
    };
  },
};

// ---------------------------------------------------------------- entry point
// civic landmarks move to where they belong: the city hall faces the camera with the courthouse and
// clock tower beside it; the port and the airport sit out at the edge. Each swaps lots with an
// ordinary file of a similar size, so nobody ends up squeezed.
function placeLandmarks(lots, files, hub, frontAz) {
  const root = r => files.findIndex(f => f.a?.r === r && !f.p.includes('/'));
  const marks = new Set([hub]);
  const live = [...lots.keys()].filter(i => lots[i] && lots[i].w > 0.01);
  if (live.length < 12) return;
  const area = i => lots[i].w * lots[i].d;
  const cx = live.reduce((s, i) => s + lots[i].x, 0) / live.length, cz = live.reduce((s, i) => s + lots[i].z, 0) / live.length;
  const ext = live.reduce((m, i) => Math.max(m, Math.hypot(lots[i].x - cx, lots[i].z - cz)), 0);
  const dist = (i, [x, z]) => Math.hypot(lots[i].x - x, lots[i].z - z);
  const pick = (i, score) => {
    const cands = live.filter(j => !marks.has(j) && j !== i && area(j) <= area(i) * 2.5 && area(j) >= area(i) * 0.4);
    if (!cands.length) return;
    const j = cands.reduce((b, j) => score(j) < score(b) ? j : b);
    [lots[i], lots[j]] = [lots[j], lots[i]];
  };
  const A = (frontAz ?? 45) * Math.PI / 180;
  const front = [cx + Math.cos(A) * ext * 0.4, cz + Math.sin(A) * ext * 0.4];
  const plan = [
    ['readme', i => dist(i, front)],
    ['license', i => dist(i, front) + 0.15 * ext],
    ['changelog', i => dist(i, front) + 0.15 * ext],
    ['lock', i => -dist(i, [cx, cz])],
    ['deploy', i => -dist(i, [cx, cz]) - 0.5 * dist(i, front)],
  ];
  let anchor = front;
  for (const [role, score] of plan) {
    const i = root(role);
    if (i < 0 || !lots[i] || marks.has(i)) continue;
    const s = role === 'license' || role === 'changelog' ? (j => dist(j, anchor)) : score;
    pick(i, s);
    marks.add(i);
    if (role === 'readme') anchor = [lots[i].x, lots[i].z];
  }
}

function districtBorn(files, text) {
  const name = text.replace(/ \(downtown\)$| \+\d+$/, '');
  let born = Infinity;
  for (const f of files) if (f.p === name || f.p.startsWith(name + '/')) born = Math.min(born, f.born);
  return born < Infinity ? born : null;
}

export function buildLayout(kind, { files, inDeg, hub, SIZE, frontAz }) {
  const N = files.length;
  const v = files.map(f => Math.sqrt(f.loc) + 3);
  const vs = [...v].sort((a, b) => a - b), medV = vs[N >> 1] || 1;
  const area = v.map(x => x / medV);
  const locs = files.map(f => f.loc).sort((a, b) => a - b), medLoc = locs[N >> 1] || 1;
  const ctx = { files, inDeg, area, hub };
  const ds = districtsOf(files, area);
  const L = PLANNERS[kind](ds, ctx);
  const areaOf = new Map(ds.map(d => [d.name, d.area]));

  // normalise into a SIZE-wide square centred on the origin
  const pts = [];
  for (const l of L.lots) if (l) { const r = Math.hypot(l.w, l.d) / 2; pts.push([l.x - r, l.z - r], [l.x + r, l.z + r]); }
  for (const b of L.blocks) pts.push(...b.poly);
  const groundKind = L.ground || (L.groundIsWater ? 'water' : 'road');
  if (groundKind === 'water') for (const p of L.land || []) pts.push(...p);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { if (!Number.isFinite(x) || !Number.isFinite(z)) continue; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const s = (SIZE * 0.92) / Math.max(x1 - x0, z1 - z0, 1e-6);
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const P = ([x, z]) => [(x - mx) * s, (z - mz) * s];
  const lots = new Array(N);
  for (const l of L.lots) lots[l.i] = { x: (l.x - mx) * s, z: (l.z - mz) * s, w: l.w * s, d: l.d * s, rot: l.rot || 0, y: (l.y || 0) * s };
  // a building's detail (windows, doors) is drawn on its local +x and +z faces, the two the camera sees
  // when it isn't turned. A turned lot (the wedges of Paris) is the same footprint turned by any quarter
  // turn with width and depth swapped: take the quarter turn that keeps those faces towards the camera.
  const camA = (frontAz ?? L.camera?.az ?? 45) * Math.PI / 180, ccx = Math.cos(camA), ccz = Math.sin(camA);
  for (const l of lots) if (l && l.rot) {
    let best = 0, bs = -Infinity;
    for (let k = 0; k < 4; k++) {
      const r = l.rot + k * Math.PI / 2; // three.js turns +x to (cos r, -sin r) and +z to (sin r, cos r)
      const sc = Math.min(Math.cos(r) * ccx - Math.sin(r) * ccz, Math.sin(r) * ccx + Math.cos(r) * ccz);
      if (sc > bs + 1e-9) { bs = sc; best = k; }
    }
    if (best) { l.rot += best * Math.PI / 2; if (best % 2) [l.w, l.d] = [l.d, l.w]; }
  }
  placeLandmarks(lots, files, hub, frontAz ?? L.camera?.az);
  const districtOf = L.districtOf || (() => null);
  const heights = files.map((f, i) => L.height(i, f.loc / medLoc, districtOf(i)) * s);

  // a rail line strung through the busiest files: the stations are the dependency hubs
  const rails = [];
  if (L.rail) {
    const pick = [...inDeg.keys()].filter(i => inDeg[i] > 0 && lots[i]).sort((a, b) => inDeg[b] - inDeg[a]).slice(0, L.rail.stations);
    if (pick.length >= 3) {
      const tour = [pick[0]], left = new Set(pick.slice(1));
      while (left.size) {
        const last = lots[tour.at(-1)];
        let best = null, bd = Infinity;
        for (const j of left) { const dd = Math.hypot(lots[j].x - last.x, lots[j].z - last.z); if (dd < bd) { bd = dd; best = j; } }
        tour.push(best); left.delete(best);
      }
      rails.push({ pts: tour.map(i => [lots[i].x, lots[i].z]), closed: L.rail.closed, h: L.rail.h * s, stations: tour });
    }
  }
  // every district gets a name: a planner may leave some out (the desert's palm villas, a small
  // town's single street), so those are named at the middle of their lots
  const labelled = L.labels.map(l => ({ ...l, path: l.path ?? l.text.replace(/ \(downtown\)$| \+\d+$/, '') }));
  const lotOf = new Map(L.lots.map(l => [l.i, l]));
  for (const d of ds) {
    if (d.name === '·' || d.items.length < 2) continue;
    if (labelled.some(l => l.path === d.name || l.path.startsWith(d.name + '/') || d.name.startsWith(l.path + '/'))) continue;
    const at = d.items.map(it => lotOf.get(it.i)).filter(Boolean);
    if (!at.length) continue;
    labelled.push({ text: d.name, path: d.name, x: sum(at.map(l => l.x)) / at.length, z: sum(at.map(l => l.z)) / at.length });
  }
  return {
    kind,
    unit: s,
    lots,
    heights,
    hub,
    blocks: L.blocks.map(b => ({ ...b, poly: b.poly.map(P), h: (b.h || 0) * s })),
    land: (L.land || []).map(p => p.map(P)),
    ground: groundKind,
    groundIsWater: groundKind === 'water',
    shore: (L.shore || []).map(p => p.map(P)),
    water: (L.water || []).map(p => p.map(P)),
    rails,
    decor: (L.decor || []).map(d => ({ x: (d.x - mx) * s, z: (d.z - mz) * s, w: d.w * s, d: d.d * s, h: d.h * s })),
    camera: L.camera ? { ...L.camera, target: L.camera.target ? P(L.camera.target) : [0, 0] } : null,
    bridges: (L.bridges || []).map(b => ({ a: P(b.a), b: P(b.b), w: b.w * s })),
    roads: (L.roads || []).map(r => ({ a: P(r.a), b: P(r.b), w: r.w * s })),
    hills: (L.hills || []).map(h => ({ x: (h.x - mx) * s, z: (h.z - mz) * s, r: h.r * s, h: h.h * s })),
    paths: L.paths || false,
    sand: !!L.sand,
    stairs: (L.stairs || []).map(st => ({ ...st, x: (st.x - mx) * s, z: (st.z - mz) * s, rise: st.rise * s, run: st.run * s, w: st.w * s, top: st.top * s })),
    cables: (L.cables || []).map(c => ({ a: [...P(c.a), c.a[2] * s], b: [...P(c.b), c.b[2] * s] })),
    ships: (L.ships || []).map(sh => ({ ...sh, x: (sh.x - mx) * s, z: (sh.z - mz) * s, len: sh.len * s, beam: sh.beam * s })),
    // a label appears with its district: when the first file under that name was born
    labels: labelled.map(l => ({ bornRaw: districtBorn(files, l.path), path: l.path, text: shortLabel(l.text), weight: l.weight ?? (areaOf.get(l.text.replace(' (downtown)', '')) || 0), x: (l.x - mx) * s, z: (l.z - mz) * s, y: (l.y || 0) * s }))
      .sort((a, b) => b.weight - a.weight),
  };
}
