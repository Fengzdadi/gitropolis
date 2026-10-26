#!/usr/bin/env node
// Layout test: the deleted files still standing in a city (web/main.js puts the latest of them after the
// files that are there) get lots like any file, and never take anything from the files that are there:
// no deleted README is the city hall, no deleted district keeps its name, and every landmark the city
// has without them it has with them. Each snapshot city, planned as every kind of city, with as many
// of its deleted files as the page would ever add (a quarter of its buildings, the latest first).
//
//   node test/layout.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', 'web');
// the page's modules import 'three' and 'd3-hierarchy' through index.html's import map: resolve them the same way
const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;
const base = pathToFileURL(WEB + '/').href;
const urls = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, new URL(v, base).href]));
register('data:text/javascript,' + encodeURIComponent(`
  const urls = ${JSON.stringify(urls)};
  export async function resolve(spec, ctx, next) {
    const key = Object.keys(urls).filter(k => k.endsWith('/') ? spec.startsWith(k) : spec === k).sort((a, b) => b.length - a.length)[0];
    return key ? { url: urls[key] + spec.slice(key.length), shortCircuit: true } : next(spec, ctx);
  }`));
const { buildLayout, CITY_KINDS } = await import('../web/layouts.js');
const { buildingSpecs } = await import('../web/architecture.js');

// a snapshot keeps files and deleted files by path: back to the scanner's lists
function city(snap) {
  const paths = Object.keys(snap.files), index = new Map(paths.map((p, i) => [p, i]));
  const files = paths.map(p => ({ p, ...snap.files[p], imp: snap.files[p].imp.map(q => index.get(q)) }));
  const gone = Object.entries(snap.gone || {}).map(([p, g]) => ({ p, ...g })).sort((a, b) => a.died - b.died);
  return { ...snap, files, gone };
}

// what the page hands the planner and the architect (web/main.js), with `gone` deleted files after the rest
function plan(data, kind, gone) {
  const live = data.files.length, files = [...data.files, ...gone.map(g => ({ ...g, imp: [], gone: true }))];
  const inDeg = files.map(() => 0);
  files.forEach(f => f.imp.forEach(j => inDeg[j]++));
  let hub = 0;
  for (let i = 1; i < live; i++) if (inDeg[i] > inDeg[hub]) hub = i;
  const layout = buildLayout(kind, { files, inDeg, hub, SIZE: 1000 });
  const span = Math.max(1, data.end - data.start), t01 = t => (t - data.start) / span;
  const B = files.map((f, i) => {
    const l = layout.lots[i] || { x: 0, z: 0, w: 0.001, d: 0.001, rot: 0 };
    return { x: l.x, z: l.z, w: l.w * 0.88, d: l.d * 0.88, rot: l.rot, y: l.y || 0, h: Math.max(layout.heights[i], layout.unit * 0.1), born: t01(f.born) };
  });
  const specs = buildingSpecs({ files, B, inDeg, hub, unit: layout.unit, kind, t01 });
  return { files, layout, specs };
}

const LANDMARK = new Set(['cityhall', 'courthouse', 'port', 'airport']);
const problems = [];
let runs = 0;
for (const name of readdirSync(path.join(HERE, 'snapshots')).filter(f => f.endsWith('.json')).sort()) {
  const data = city(JSON.parse(readFileSync(path.join(HERE, 'snapshots', name), 'utf8')));
  const gone = data.gone.slice(Math.max(0, data.gone.length - Math.ceil(data.files.length / 4)));
  if (!gone.length) continue;
  for (const kind of CITY_KINDS) {
    runs++;
    const was = plan(data, kind, []), now = plan(data, kind, gone);
    const say = msg => problems.push(`${name.replace('.json', '')} as ${kind}: ${msg}`);
    const { files, layout, specs } = now, live = data.files.length;
    for (let i = live; i < files.length; i++) {
      const l = layout.lots[i];
      if (!l || !(l.w > 0) || ![l.x, l.z, l.w, l.d].every(Number.isFinite)) say(`no lot for deleted ${files[i].p}`);
      if (LANDMARK.has(specs[i].form)) say(`deleted ${files[i].p} is a ${specs[i].form}`);
    }
    for (let i = 0; i < live; i++) if (LANDMARK.has(was.specs[i].form) && specs[i].form !== was.specs[i].form) say(`${files[i].p} was a ${was.specs[i].form}, now a ${specs[i].form}`);
    for (const l of layout.labels) if (!data.files.some(f => f.p === l.path || f.p.startsWith(l.path + '/'))) say(`a name for ${l.path}, where only deleted files are`);
  }
}
if (problems.length) {
  for (const p of problems.slice(0, 40)) console.log(`✗ ${p}`);
  console.log(`layout: ${problems.length} problems in ${runs} plans`);
  process.exitCode = 1;
} else console.log(`layout: ${runs} plans, deleted files on their own lots`);
