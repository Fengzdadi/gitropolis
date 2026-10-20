// Every building gets a shape that comes from its file: role and structure pick the form,
// age picks the era, the busiest files get spires and the most-edited ones keep a crane on site.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PERIPHERY = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?|samples?|examples?|docs?|playgrounds?|templates?|benchmarks?)(\/|$)/;
const ROOF_BY_CITY = { paris: 'mansard', smalltown: 'gable', la: 'flat', venice: 'hip', barcelona: 'flat' };
// each language builds in its own vernacular
const STYLE_BY_LANG = { rs: 'rust', c: 'c', cpp: 'cpp', go: 'go', py: 'python', js: 'js', ts: 'ts', java: 'java', kt: 'java', rb: 'ruby', php: 'php', sh: 'shell' };
const CODE = new Set(Object.keys(STYLE_BY_LANG));

export function buildingSpecs({ files, B, inDeg, unit, kind, t01 }) {
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
  const maxIn = Math.max(...inDeg);
  // the city's own vernacular (for manifests, docs and other non-code buildings): its biggest language
  const byLang = {};
  for (const f of files) if (CODE.has(f.lang)) byLang[f.lang] = (byLang[f.lang] || 0) + f.loc;
  const mainLang = Object.keys(byLang).sort((a, b) => byLang[b] - byLang[a])[0];
  const cityStyle = STYLE_BY_LANG[mainLang] || 'default';
  // one airport per city: the biggest deploy file
  // only a handful of the very newest source files are building sites, or the whole city is scaffolding
  const sites = new Set([...files.keys()].filter(i => (files[i].s || []).includes('new') && (files[i].a?.r || 'source') === 'source')
    .sort((a, b) => files[b].born - files[a].born).slice(0, Math.max(2, Math.round(N * 0.01))));
  const deploys = [...files.keys()].filter(i => files[i].a?.r === 'deploy').sort((a, b) => files[b].loc - files[a].loc);

  return files.map((f, i) => {
    const b = B[i], a = f.a || {};
    let role = a.r || (f.lang === 'cfg' ? 'manifest' : 'source');
    const nested = PERIPHERY.test(f.p) || f.p.split('/').length > 3;
    // only a project's (or a package's) own manifests and lockfiles are infrastructure; the hundreds inside fixtures are sheds
    if ((role === 'manifest' || role === 'lock') && nested) role = 'config';
    if ((role === 'readme' || role === 'license' || role === 'changelog') && nested) role = 'docs';
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
      default:
        if (f.loc < medLoc * 0.35) form = 'house';
        else if ((a.c || 0) >= 2 && b.h > unit * 1.2) form = 'setback';
        else if (b.h > unit * 2 && Math.min(b.w, b.d) > unit * 1.4) form = 'podium';
        else if (slender) form = 'tower';
        else form = 'slab';
    }
    // the city's landmark is always a tower, whatever kind of file it is
    const hub = inDeg[i] === maxIn && maxIn > 0;
    const status = new Set(f.s || []);
    if (status.has('giant') && role === 'source') form = 'mega';
    else if (hub) form = (a.c || 0) >= 2 ? 'setback' : 'tower';
    else if (status.has('dead')) form = 'ruin';
    else if (sites.has(i)) form = 'site';
    const era = bornRank[i] < 0.34 ? 'old' : bornRank[i] < 0.67 ? 'mid' : 'new';
    const LOW = { house: 1.1, shed: 1.4, hall: 1.4, plant: 1.4, cityhall: 1.8, courthouse: 1.4, port: 0.6, airport: 0.9 };
    let h = LOW[form] ? Math.min(b.h, unit * LOW[form]) : b.h;
    if (form === 'clocktower') h = Math.max(b.h, unit * 2.6);
    if (form === 'ruin') h *= 0.6;
    if (form === 'site') h *= 0.35;
    return {
      w: b.w, d: b.d, h, form, era, seed: i * 7919 + 13,
      style: STYLE_BY_LANG[f.lang] || cityStyle,
      tiers: Math.min(4, Math.max(2, a.c || 3)),
      roof: form === 'house' ? (ROOF_BY_CITY[kind] === 'mansard' ? 'mansard' : 'gable') : ROOF_BY_CITY[kind],
      props: { spire: spires.has(i) || hub, antenna: antennas.has(i) && !spires.has(i), crane: cranes.has(i), tank: kind === 'manhattan' && era !== 'new' && i % 5 === 0, ac: era === 'mid' && i % 3 === 0 },
    };
  });
}

// one merged mesh for the whole city; per-vertex building id, base height and birth time
// let a shader grow every building from the ground when the timeline reaches it
export function buildCityMesh({ buildingGeometry, specs, B, files, t01, shared, castShadow = true }) {
  const geos = [];
  specs.forEach((spec, i) => {
    if (B[i].w < 0.01) return;
    let g = buildingGeometry(spec);
    if (g.index) g = g.toNonIndexed();
    g.rotateY(B[i].rot || 0).translate(B[i].x, B[i].y, B[i].z);
    const n = g.attributes.position.count;
    const meta = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) meta.set([i, B[i].y, t01(files[i].born)], k * 3);
    g.setAttribute('aMeta', new THREE.BufferAttribute(meta, 3));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'part', 'aMeta'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.part) g.setAttribute('part', new THREE.BufferAttribute(new Float32Array(n), 1));
    geos.push(g);
  });
  const geo = mergeGeometries(geos);
  const grow = `
    float b0 = aMeta.z * 0.97; float grow = smoothstep(b0, b0 + 0.03, uTimeline);
    transformed.y = aMeta.y + (transformed.y - aMeta.y) * grow;
    transformed *= step(0.001, grow);`;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uTimeline = shared.uTimeline;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMeta; uniform float uTimeline;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${grow}`);
  };
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = sh => {
    sh.uniforms.uTimeline = shared.uTimeline;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMeta; uniform float uTimeline;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${grow}`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.customDepthMaterial = depth;
  mesh.castShadow = mesh.receiveShadow = castShadow;
  mesh.frustumCulled = false;
  return mesh;
}
