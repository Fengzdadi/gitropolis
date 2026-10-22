// Every building gets a shape that comes from its file: role and structure pick the form,
// age picks the era, the busiest files get spires and the most-edited ones keep a crane on site.
import * as THREE from 'three';
import { addFacadeDetail } from './surfaces.js';

const PERIPHERY = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|samples?|examples?|docs?|playgrounds?|templates?|benchmarks?)(\/|$)/;
// a training run, a fine-tune (as the classifier counts them)
const TRAIN_RE = /(^|\/)(train|finetune|fine_tune|pretrain)[^/]*\.(py|c|cu)$/i;
const ROOF_BY_CITY = { farm: 'gable', port: 'flat', paris: 'mansard', smalltown: 'gable', la: 'flat', venice: 'hip', barcelona: 'flat' };
// each language builds in its own vernacular
// kinds of infrastructure as code → port industry (Terraform is decided by size: plant or factory)
// kinds of page → campus buildings
const PAGE_FORM = { guide: 'college', page: 'college', i18n: 'college', index: 'chapel', api: 'hall', blog: 'house' };
const INFRA_FORM = { k8s: 'containers', yaml: 'containers', chart: 'warehouse', values: 'warehouse', kustomize: 'warehouse', ansible: 'warehouse', jsonnet: 'tanks', nix: 'tanks', tmpl: 'shed' };
const STYLE_BY_LANG = { rs: 'rust', c: 'c', cpp: 'cpp', go: 'go', py: 'python', js: 'js', ts: 'ts', java: 'java', kt: 'java', rb: 'ruby', php: 'php', sh: 'shell' };
const CODE = new Set(Object.keys(STYLE_BY_LANG));

// district paint: language picks the material, the district picks the colour it's painted, so each
// neighbourhood reads as one (strongly in a small town, as a hint of roof colour elsewhere)
const ROOF_PAINT = ['#b5523b', '#3f5f7a', '#4f7a3a', '#c9902f', '#6e4a6e', '#2f7a72', '#8a3b30', '#4a4458'];
const WALL_PAINT = ['#f2e3c6', '#cfe0ea', '#d6ebd3', '#f4e2a1', '#d9d4ea', '#f0cfcf', '#e6d2b5', '#f2efe9'];
const DISTRICT_RE = /^(packages|apps|libs|crates|modules|plugins|services|projects)\/[^/]+/;
const districtKey = p => (DISTRICT_RE.exec(p) || [p.includes('/') ? p.split('/')[0] : '·'])[0];

export function buildingSpecs({ files, B, inDeg, hub: hubIdx, unit, kind, t01 }) {
  const N = files.length;
  const rank = (vals) => { const order = [...vals.keys()].sort((a, b) => vals[a] - vals[b]); const r = new Array(N); order.forEach((i, k) => { r[i] = k / Math.max(1, N - 1); }); return r; };
  const bornRank = rank(files.map(f => f.born));
  const outDeg = files.map(f => f.imp.length);
  const top = (vals, share, min = 1) => new Set([...vals.keys()].filter(i => vals[i] >= min).sort((a, b) => vals[b] - vals[a]).slice(0, Math.max(1, Math.round(N * share))));
  const spires = top(inDeg, 0.004, 3);
  const antennas = top(outDeg, 0.03, 6);
  const recentChurn = files.map(f => t01(f.last) > 0.95 ? f.churn : 0);
  const cranes = top(recentChurn, 0.015, 5);
  const locs = files.map(f => f.loc).sort((a, b) => a - b), medLoc = locs[N >> 1] || 1;
  const crowdLoc = N > 6000 ? locs[Math.floor(N * 0.8)] : 0;
  let entry = 0, biggest = -1;
  for (let i = 0; i < N; i++) if (i !== hubIdx && files[i].g && (biggest < 0 || files[i].loc > files[biggest].loc)) biggest = i;
  for (let i = 1; i < N; i++) if (outDeg[i] > outDeg[entry]) entry = i;
  const nbLocs = files.filter(f => f.a?.r === 'notebook').map(f => f.loc).sort((a, b) => a - b);
  const barnLoc = nbLocs.length ? nbLocs[Math.floor(nbLocs.length * 0.85)] : Infinity; // only the biggest notebooks are barns
  // the city's own vernacular (for manifests, docs and other non-code buildings): its biggest language
  const byLang = {};
  for (const f of files) if (CODE.has(f.lang)) byLang[f.lang] = (byLang[f.lang] || 0) + f.loc;
  const mainLang = Object.keys(byLang).sort((a, b) => byLang[b] - byLang[a])[0];
  const cityStyle = STYLE_BY_LANG[mainLang] || 'default';
  // one airport per city: the biggest deploy file
  // only a handful of the very newest source files are building sites, or the whole city is scaffolding
  // (a boomtown is different: there the newest 12% of its source files are cranes and scaffolding)
  const sites = new Set([...files.keys()].filter(i => (kind === 'desert' || (files[i].s || []).includes('new')) && (files[i].a?.r || 'source') === 'source')
    .sort((a, b) => files[b].born - files[a].born).slice(0, Math.max(2, Math.round(N * (kind === 'desert' ? 0.12 : 0.01)))));
  // districts ranked by size get palette slots in order, so the biggest ones get the most distinct colours
  // when one top-level directory holds most of the code (a lone src/ or source/), its subdirectories
  // are the real neighbourhoods: paint by those instead, so single-directory repos aren't one colour
  const topCount = new Map();
  for (const f of files) topCount.set(districtKey(f.p), (topCount.get(districtKey(f.p)) || 0) + 1);
  const [domKey, domN] = [...topCount].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const refine = domN / Math.max(1, files.length) > 0.7;
  const paintKey = p => {
    const k = districtKey(p);
    if (!refine || k !== domKey) return k;
    const rest = k === '·' ? p : p.slice(k.length + 1);
    return rest.includes('/') ? `${k}/${rest.split('/')[0]}` : k;
  };
  const dSize = new Map();
  for (const f of files) dSize.set(paintKey(f.p), (dSize.get(paintKey(f.p)) || 0) + f.loc);
  const dSlot = new Map([...dSize].sort((a, b) => b[1] - a[1]).map(([k], n) => [k, n]));
  const town = kind === 'smalltown';
  const deploys = [...files.keys()].filter(i => files[i].a?.r === 'deploy').sort((a, b) => files[b].loc - files[a].loc);

  return files.map((f, i) => {
    const b = B[i], a = f.a || {};
    let role = a.r || (f.lang === 'cfg' ? 'manifest' : 'source'), pageKind = a.k;
    const nested = PERIPHERY.test(f.p) || f.p.split('/').length > 3;
    // only a project's (or a package's) own manifests and lockfiles are infrastructure; the hundreds inside fixtures are sheds
    if ((role === 'manifest' || role === 'lock') && nested) role = 'config';
    if ((role === 'readme' || role === 'license' || role === 'changelog') && nested) role = 'docs';
    if (kind === 'university' && f.lang === 'doc' && f.p.includes('/')) role = 'page', pageKind = 'index'; // a chapter's README is its contents page
    if (role === 'deploy' && i !== deploys[0]) role = 'build';
    const slender = b.h > 2.4 * Math.min(b.w, b.d);
    let form;
    switch (role) {
      case 'manifest': form = 'plant'; break;
      case 'readme': form = 'cityhall'; break;
      case 'license': form = 'courthouse'; break;
      case 'changelog': form = 'clocktower'; break;
      case 'lock': form = 'port'; break;
      case 'deploy': form = 'airport'; break;
      case 'build': case 'config': form = 'shed'; break;
      case 'index': form = 'hall'; break;
      case 'types': form = 'frame'; break;
      case 'test': case 'docs': form = 'house'; break;
      // infrastructure is the port's industry: what a file describes decides what stands on the quay
      // prose is the university's fabric: chapters are colleges, contents pages are chapels
      // (a huge campus, like a 40,000-page wiki, keeps colleges for its longer pages: the rest are row houses)
      // the farm: notebooks are farmhouses (the big ones barns), datasets bales in their field, models silos
      case 'notebook': form = f.loc >= barnLoc ? 'barn' : 'house'; break;
      case 'field': form = 'bales'; break;
      case 'silo': form = 'silo'; break;
      case 'page': form = f.loc < medLoc * 0.3 || f.loc < crowdLoc ? 'house' : PAGE_FORM[pageKind] || 'college'; break;
      case 'infra': form = INFRA_FORM[a.k] || 'containers';
        if (a.k === 'tf') form = f.loc > medLoc * 2 ? 'plant' : 'shed';
        break;
      default:
        if (f.loc < medLoc * 0.35) form = 'house';
        else if ((a.c || 0) >= 2 && b.h > unit * 1.2) form = 'setback';
        else if (b.h > unit * 2 && Math.min(b.w, b.d) > unit * 1.4) form = 'podium';
        else if (slender) form = 'tower';
        else form = 'slab';
    }
    // the city's landmark is always a tower, whatever kind of file it is: the one hub the planner gave
    // the landmark's plot (with no imports at all that's the first file, so the plot is never empty)
    const hub = i === hubIdx;
    const status = new Set(f.s || []);
    if (status.has('giant') && role === 'source') form = 'mega';
    else if (hub) form = town ? 'clocktower' : kind === 'port' ? 'lighthouse' : kind === 'university' ? 'library' : kind === 'capital' ? 'congress' : kind === 'desert' ? 'needle' : kind === 'farm' ? 'windmill' : kind === 'industrial' ? 'cooling' : kind === 'science' ? 'ring' : kind === 'themepark' ? 'castle' : (a.c || 0) >= 2 ? 'setback' : 'tower';
    else if (kind === 'capital' && i === entry) form = 'cathedral'; // the file that imports the most: where the plan is read from
    else if (status.has('dead')) form = 'ruin';
    else if (sites.has(i)) form = 'site';
    // on a farm, scripts are workshops in the yard
    if (kind === 'farm' && ['slab', 'tower', 'setback', 'podium', 'hall', 'frame', 'mega'].includes(form)) form = 'shed';
    // the boomtown's strip: anything that tall is a supertall
    if (kind === 'desert' && !hub && b.h > unit * 2.8 && ['slab', 'tower', 'setback', 'podium', 'hall', 'frame', 'mega', 'house', 'shed'].includes(form)) form = 'supertall';
    if (kind === 'capital' && ['slab', 'tower', 'setback', 'podium', 'house', 'hall', 'frame', 'mega'].includes(form)) form = 'pilotis';
    // the industrial town: code is made in saw-tooth works (small files in workshops, giants in power
    // plants), and headers are the warehouses its parts are kept in; tests and docs are the terraces
    if (kind === 'industrial' && !hub && role !== 'test' && role !== 'docs') {
      if (/\.(h|hh|hpp|hxx|cuh)$/.test(f.p) && ['slab', 'tower', 'setback', 'podium', 'hall', 'frame', 'house'].includes(form)) form = 'warehouse';
      else if (['slab', 'tower', 'setback', 'podium', 'hall', 'frame'].includes(form)) form = 'factory';
      else if (form === 'house') form = 'shed';
      else if (form === 'mega') form = 'plant';
    }
    // the theme park: the biggest script is the Ferris wheel, big ones are big tops, slender ones drop
    // towers, the rest carousels; everything that isn't a script for the engine (tests, docs, the
    // project's other code) is a stall along the paths
    if (kind === 'themepark' && !hub && ['slab', 'tower', 'setback', 'podium', 'hall', 'frame', 'mega', 'house', 'shed'].includes(form)) {
      if (i === biggest) form = 'ferris';
      else if (!f.g || role === 'test' || role === 'docs') form = 'stall';
      else form = f.loc > medLoc * 2.2 ? 'bigtop' : slender && i % 4 === 0 ? 'droptower' : 'carousel';
    }
    // the science park: code works in glass labs, training runs (and giants) in data centres, and the
    // tests are the greenhouses the experiments grow in
    if (kind === 'science' && !hub) {
      if (role === 'test') form = 'greenhouse';
      else if (role !== 'docs' && (TRAIN_RE.test(f.p) || form === 'mega')) form = 'datacenter';
      else if (role !== 'docs' && ['slab', 'tower', 'setback', 'podium', 'hall', 'frame', 'house'].includes(form)) form = 'lab';
    }
    const era = town && hub ? 'old' : bornRank[i] < 0.34 ? 'old' : bornRank[i] < 0.67 ? 'mid' : 'new';
    const LOW = { house: 1.1, shed: 1.4, hall: 1.4, plant: 1.4, cityhall: 1.8, courthouse: 1.4, port: 0.6, airport: 0.9, containers: 0.5, tanks: 0.7, warehouse: 0.8 };
    let h = LOW[form] ? Math.min(b.h, unit * LOW[form]) : b.h;
    if (form === 'clocktower') h = Math.max(b.h, unit * 2.6);
    if (form === 'lighthouse') h = Math.max(b.h, unit * 3);
    if (form === 'chapel') h = Math.max(b.h, unit * 1.7);
    if (form === 'library') h = Math.max(b.h, unit * 2.4);
    if (form === 'needle') h = Math.max(b.h, unit * 8);
    if (form === 'windmill') h = Math.max(b.h, unit * 2.2);
    if (form === 'cooling') h = Math.max(b.h, unit * 3.5);
    if (form === 'ferris') h = Math.max(b.h, unit * 3.2);
    if (form === 'stall') h = Math.min(b.h, unit * 0.8);
    if (form === 'bigtop' || form === 'carousel') h = Math.min(b.h, Math.min(b.w, b.d) * (form === 'bigtop' ? 0.85 : 0.75)); // tents are squat
    if (form === 'datacenter' || form === 'greenhouse') h = Math.min(b.h, unit * 1.1);
    if (form === 'cathedral') h = Math.max(b.h * 0.8, unit * 1.3);
    if (form === 'ruin') h *= 0.6;
    if (form === 'site') h *= 0.35;
    return {
      w: b.w, d: b.d, h, form, era, seed: i * 7919 + 13, cu: unit * 0.13,
      // a small town's clock tower is old stone whatever the code is written in
      // prose has no vernacular: the campus is built in plain collegiate stone and brick
      style: (town && hub) || role === 'page' || form === 'library' ? 'default' : STYLE_BY_LANG[f.lang] || cityStyle,
      tiers: Math.min(4, Math.max(2, a.c || 3)),
      roof: form === 'house' ? (ROOF_BY_CITY[kind] === 'mansard' ? 'mansard' : town && (i * 2654435761 >>> 0) % 3 === 0 ? 'hip' : 'gable') : form === 'shed' && kind === 'port' ? 'hip' : ROOF_BY_CITY[kind], // port sheds are saw-tooth factories
      tint: (() => {
        const slot = dSlot.get(paintKey(f.p)) || 0;
        // in a small town, alternate between two wall colours within a district so a street isn't uniform
        return town
          ? { roof: ROOF_PAINT[slot % 8], roofMix: 0.85, wall: WALL_PAINT[(slot + (i % 3 === 0 ? 3 : 0)) % 8], wallMix: 0.7 }
          : { roof: ROOF_PAINT[slot % 8], roofMix: 0.3 };
      })(),
      props: { spire: spires.has(i) || hub, antenna: antennas.has(i) && !spires.has(i), crane: cranes.has(i) && kind !== 'industrial', smoke: cranes.has(i) && kind === 'industrial', tank: kind === 'manhattan' && era !== 'new' && i % 5 === 0, ac: era === 'mid' && i % 3 === 0 },
    };
  });
}

// repaint roofs (and walls) towards the district colour, keeping each part's shading variation
const _roof = new THREE.Color(), _wall = new THREE.Color(), _c = new THREE.Color();
function paint(g, t) {
  const col = g.attributes.color, part = g.attributes.part;
  if (!col || !part) return;
  _roof.set(t.roof);
  if (t.wall) _wall.set(t.wall);
  for (let k = 0; k < col.count; k++) {
    const p = part.getX(k);
    if (p === 1) _c.fromBufferAttribute(col, k).lerp(_roof, t.roofMix);
    else if (p === 0 && t.wall) _c.fromBufferAttribute(col, k).lerp(_wall, t.wallMix);
    else continue;
    col.setXYZ(k, _c.r, _c.g, _c.b);
  }
}

// one merged mesh for the whole city; per-vertex building id, base height and birth time
// let a shader grow every building from the ground when the timeline reaches it
export function buildCityMesh({ buildingGeometry, specs, B, files, t01, shared, unit, heat, focus, glow = null, castShadow = true }) {
  // a big repo is ~1M triangles, so the float geometry is never gathered in one place: each building
  // is packed as soon as it's built (colour and normals as bytes: palette art doesn't need floats) and
  // its float copy dropped, then the pieces are joined one attribute at a time, letting go of each
  // piece as it's copied, so the peak is about the size of the finished mesh rather than three times it
  const toBytes = (a, Type, scale) => { const out = new Type(a.length); for (let k = 0; k < a.length; k++) out[k] = Math.round(a[k] * scale); return out; };
  const pieces = [];
  let count = 0;
  specs.forEach((spec, i) => {
    if (B[i].w < 0.01) return;
    let g = buildingGeometry(spec);
    if (g.index) g = g.toNonIndexed();
    if (spec.tint) paint(g, spec.tint);
    g.rotateY(B[i].rot || 0).translate(B[i].x, B[i].y, B[i].z);
    const a = g.attributes, n = a.position.count;
    pieces.push({
      i, n, position: a.position.array,
      normal: toBytes(a.normal.array, Int8Array, 127),
      color: toBytes(a.color.array, Uint8Array, 255),
      part: a.part ? Uint8Array.from(a.part.array) : new Uint8Array(n),
    });
    count += n;
  });
  // a city with nothing to build (no recognised files) still gets a valid, empty mesh
  const geo = new THREE.BufferGeometry();
  const join = (name, Type, size, normalized) => {
    const out = new Type(count * size);
    let o = 0;
    for (const p of pieces) { out.set(p[name], o); o += p[name].length; p[name] = null; }
    geo.setAttribute(name, new THREE.BufferAttribute(out, size, normalized));
  };
  join('position', Float32Array, 3, false);
  join('normal', Int8Array, 3, true);
  join('color', Uint8Array, 3, true);
  join('part', Uint8Array, 1, false);
  // per-vertex building id, base height and birth time, the same for every vertex of a building
  const meta = new Float32Array(count * 3);
  let o = 0;
  for (const { i, n } of pieces) {
    const y = B[i].y, born = t01(files[i].born);
    for (let k = 0; k < n; k++, o += 3) { meta[o] = i; meta[o + 1] = y; meta[o + 2] = born; }
  }
  geo.setAttribute('aMeta', new THREE.BufferAttribute(meta, 3));
  // the pieces would otherwise live as long as any closure from this scope (syncState below)
  pieces.length = 0;
  // let the GPU keep the only copy once uploaded (picking uses the proxy boxes, not this mesh)
  const bytes = Object.values(geo.attributes).reduce((n, a) => n + a.array.byteLength, 0);
  // three.js still needs the bounds (for sorting) after the arrays are gone, so compute them first
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  for (const a of Object.values(geo.attributes)) a.onUpload(function () { this.array = null; });
  const grow = `
    float b0 = aMeta.z * 0.97; float grow = smoothstep(b0, b0 + 0.03, uTimeline);
    transformed.y = aMeta.y + (transformed.y - aMeta.y) * grow;
    transformed *= step(0.001, grow);`;
  // per-building live state (commit flash, focus) in a small texture the shader looks up by building id
  const SW = 1024, SH = Math.max(1, Math.ceil(files.length / SW));
  const stateData = new Uint8Array(SW * SH * 4);
  const stateTex = new THREE.DataTexture(stateData, SW, SH, THREE.RGBAFormat);
  stateTex.needsUpdate = true;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uTimeline: shared.uTimeline, uFocus: shared.uFocus, tState: { value: stateTex } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 aMeta; uniform float uTimeline; uniform sampler2D tState; varying vec3 vState;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${grow}\nvState = texture2D(tState, vec2((mod(aMeta.x, ${SW}.0) + 0.5) / ${SW}.0, (floor(aMeta.x / ${SW}.0) + 0.5) / ${SH}.0)).rgb;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vState; uniform float uFocus;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        // a building touched by a commit flashes warm; when one is focused, the rest of the city recedes
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.9, 0.6), vState.r * 0.75);
        if (uFocus >= 0.0) diffuseColor.rgb *= mix(0.55, 1.0, vState.g);
        // the district under the pointer lights up a little
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.93, 0.7), vState.b * 0.2);`);
  };
  addFacadeDetail(mat, { unit, shared });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = sh => {
    sh.uniforms.uTimeline = shared.uTimeline;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMeta; uniform float uTimeline;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${grow}`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.syncState = () => {
    for (let i = 0; i < files.length; i++) { stateData[i * 4] = Math.min(255, heat[i] * 255) | 0; stateData[i * 4 + 1] = focus[i] * 255; stateData[i * 4 + 2] = glow ? glow[i] * 255 : 0; }
    stateTex.needsUpdate = true;
  };
  mesh.userData.bytes = bytes;
  mesh.customDepthMaterial = depth;
  mesh.castShadow = mesh.receiveShadow = castShadow;
  mesh.frustumCulled = false;
  return mesh;
}
