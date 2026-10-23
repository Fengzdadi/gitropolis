#!/usr/bin/env node
// index.html preloads every module the page imports, so the browser asks for them all at once instead
// of discovering them one import level at a time. This checks that list against the real import graph
// (static imports from main.js, through the import map): a module added or dropped fails here.
//
//   node test/preload.mjs          check
//   node test/preload.mjs --print  print the <link> lines the page should have
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]).imports;

// a specifier, as the page would resolve it from `from` (both relative to web/)
function resolve(spec, from) {
  if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const key = Object.keys(map).filter(k => k.endsWith('/') ? spec.startsWith(k) : spec === k).sort((a, b) => b.length - a.length)[0];
  if (!key) throw new Error(`${from}: no import map entry for ${spec}`);
  return path.posix.normalize(map[key].replace(/^\.\//, '') + spec.slice(key.length));
}
// static imports and re-exports only: a dynamic import() is fetched when it's needed, not up front
const STATIC = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?['"]([^'"]+)['"]/g;
const graph = new Set();
(function walk(file) {
  if (graph.has(file)) return;
  graph.add(file);
  const src = readFileSync(path.join(WEB, file), 'utf8');
  for (const m of src.matchAll(STATIC)) walk(resolve(m[1], file));
})('main.js');

const listed = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]);
if (process.argv.includes('--print')) {
  for (const f of graph) console.log(`<link rel="modulepreload" href="${f}">`);
  process.exit(0);
}
const missing = [...graph].filter(f => !listed.includes(f)), extra = listed.filter(f => !graph.has(f));
if (missing.length || extra.length) {
  if (missing.length) console.error(`index.html doesn't preload: ${missing.join(', ')}`);
  if (extra.length) console.error(`index.html preloads what nothing imports: ${extra.join(', ')}`);
  console.error('(node test/preload.mjs --print gives the list)');
  process.exit(1);
}
console.log(`preload: index.html preloads all ${graph.size} modules`);
