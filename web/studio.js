// Lit, art-directed alternatives to the neon look: real sun, real shadows, one material, one accent.
//   maquette  — white architectural model under a low raking sun (Panorama of NYC, Gismondi's Rome)
//   plan      — black-on-paper figure-ground print seen from straight above (Nolli map, Stamen Toner)
//   nocturne  — dark, hazy city where only recently edited files are lit from inside (Hopper, Todd Hido)
//   chip      — the easter egg: a circuit board, its parts from chip.js (passed in as ctx.chip)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingGeometry, shipGeometry } from './buildings.js';
import { buildingSpecs, buildCityMesh } from './architecture.js';
import { addGroundDetail, addGrowth, LAND_LEAD } from './surfaces.js';
import { buildStreets, buildTraffic } from './streets.js';
import { timed } from './perf.js';
import { buildTrees } from './trees.js';
import { rubbleMesh, riseWithTimeline } from './rubble.js';

export const STYLES = {
  maquette: {
    background: '#ece8e1', fog: ['#ece8e1', 0.9, 3.2],
    sun: { color: '#fff0dc', intensity: 3.2, elevation: 17, azimuth: 150 },
    hemi: { sky: '#f6f3ee', ground: '#a69d90', intensity: 1.25 },
    heightScale: 0.42, maxHeight: 4.5,
    building: '#f1ede6', buildingJitter: 0.035, ground: '#d8d1c5', plate: '#e4ded4', roughness: 0.92,
    rail: '#8f877c', water: '#b7c2c3', land: '#ddd6ca', yard: '#c9c4b8', dirt: '#c8b48f', sand: '#e6d8b5', dune: '#d6c49c', cliff: '#cbbfae', plaza: '#ece7de', park: '#c6cab0', lawn: '#d4d4bf', hill: '#d9d1c4', road: '#c9c1b4',
    windows: 0, accent: '#d8452b', edges: { color: '#2a2724', opacity: 0.07 },
    toneMapping: THREE.NeutralToneMapping, exposure: 1.15, bloom: null,
    ink: '#2a2724', inkSoft: 'rgba(42,39,36,.55)', font: "'Instrument Serif', Georgia, serif", labelCase: 'none',
  },
  plan: {
    background: '#f1ede4', fog: null, flat: true,
    building: '#1c1b1a', buildingJitter: 0, ground: '#f1ede4', plate: '#e7e2d7',
    rail: '#2f5d7c', water: '#dce3e3', land: '#f1ede4', yard: '#e4e0d6', dirt: '#e0d2b6', sand: '#f1e7d0', dune: '#e6d9bc', cliff: '#ddd5c6', plaza: '#ece8df', park: '#e1e3d0', lawn: '#ebebdf', hill: '#e4dfd4', road: '#ddd7cb',
    windows: 0, accent: '#d23c2a', edges: { color: '#d23c2a', opacity: 0.22 },
    toneMapping: THREE.NoToneMapping, exposure: 1.0, bloom: null,
    ink: '#1c1b1a', inkSoft: 'rgba(28,27,26,.55)', font: "'Instrument Serif', Georgia, serif", labelCase: 'upper',
  },
  pixel: {
    background: '#86bfd9', fog: null, pixel: true,
    sun: { color: '#fff4e0', intensity: 2.6, elevation: 50, azimuth: 75 },
    hemi: { sky: '#c4e4ee', ground: '#61944a', intensity: 1.0 },
    building: '#bdb293', buildingJitter: 0.06, ground: '#61944a', plate: '#cdc8d2', roughness: 1,
    rail: '#4a4458', water: '#2f6188', land: '#61944a', yard: '#9c97a8', dirt: '#968a6e', sand: '#dccfa4', dune: '#bdb293', cliff: '#968a6e', plaza: '#e0d7b8', park: '#3d6b36', lawn: '#93bf62', hill: '#3d6b36', road: '#6e6880',
    windows: 0, accent: '#c0413b', edges: null,
    toneMapping: THREE.NoToneMapping, exposure: 1.0, bloom: null,
    ink: '#14121c', inkSoft: 'rgba(20,18,28,.7)', font: "'Pixelify Sans', monospace", uiFont: "'Pixelify Sans', monospace", labelCase: 'none',
  },
  nocturne: {
    background: '#0d1018', fog: ['#2a2629', 0.25, 1.9], sky: ['#0a0d15', '#2b2830', '#6a4a35'],
    sun: { color: '#8fa3c7', intensity: 0.35, elevation: 35, azimuth: 120 },
    hemi: { sky: '#56607e', ground: '#17151a', intensity: 1.15 },
    heightScale: 0.55, maxHeight: 6,
    building: '#3d4049', buildingJitter: 0.04, ground: '#14161c', plate: '#24262e', roughness: 0.8,
    rail: '#6d6050', water: '#0b1626', land: '#1c1e25', yard: '#25272e', dirt: '#2a241c', sand: '#2a2620', dune: '#221f1a', cliff: '#1d1f25', plaza: '#2d2f37', park: '#18211a', lawn: '#1b211d', hill: '#15161c', road: '#0e0f13',
    windows: 1, windowColor: '#ffc27a', accent: '#ffc27a', edges: { color: '#ffc27a', opacity: 0.018 }, hubEdgeBoost: 3,
    toneMapping: THREE.ACESFilmicToneMapping, exposure: 1.1, bloom: { strength: 0.35, radius: 0.4, threshold: 0.85 },
    ink: '#e8e2d6', inkSoft: 'rgba(232,226,214,.55)', font: "'Instrument Serif', Georgia, serif", labelCase: 'none',
  },
  chip: {
    background: '#060d09', fog: ['#060d09', 0.9, 3.0], chip: true,
    sun: { color: '#fff6e8', intensity: 2.6, elevation: 55, azimuth: 130 },
    hemi: { sky: '#dfe9e1', ground: '#0b2a1a', intensity: 0.9 },
    building: '#1c1c1f', buildingJitter: 0.03, ground: '#0e4a2b', plate: '#13583a', roughness: 0.5,
    rail: '#b9bcc2', water: '#121514', land: '#0e4a2b', yard: '#13583a', dirt: '#8a6136', sand: '#13583a', dune: '#10502f', cliff: '#0c3f25', plaza: '#13583a', park: '#13583a', lawn: '#10502f', hill: '#141416', road: '#c8803f',
    copper: '#c8803f', leads: '#c9ccd2', silk: '#ecebe2',
    windows: 0, accent: '#d6a648', edges: { color: '#ecebe2', opacity: 0.05, straight: true },
    toneMapping: THREE.ACESFilmicToneMapping, exposure: 1.05, bloom: null,
    ink: '#ecebe2', inkSoft: 'rgba(236,235,226,.55)', font: "'JetBrains Mono', ui-monospace, monospace", uiFont: "'JetBrains Mono', ui-monospace, monospace", labelCase: 'upper',
  },
};

const UP = new THREE.Vector3(0, 1, 0);

// polygons in the xz plane → one merged, extruded mesh per surface type
function slab(polys, base, depth) {
  const geos = polys.map(poly => {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 }).rotateX(-Math.PI / 2).translate(0, base, 0);
  });
  return geos.length ? mergeGeometries(geos) : null;
}

// one extruded slab per [poly, base, depth, born?]: terraces each stand at their own height, and a
// block that opens partway through the history carries when (aGrow = born, base) for the shader
function slabEach(list) {
  const geos = list.map(([poly, base, depth, born]) => {
    const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 }).rotateX(-Math.PI / 2).translate(0, base, 0);
    const n = g.attributes.position.count, a = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) { a[k * 2] = born ?? 0; a[k * 2 + 1] = base; }
    g.setAttribute('aGrow', new THREE.BufferAttribute(a, 2));
    return g;
  });
  return geos.length ? mergeGeometries(geos) : null;
}

function buildTerrain(scene, layout, S, plateStep, shared, street, blockBorn) {
  const mat = color => S.flat ? new THREE.MeshBasicMaterial({ color })
    : new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true });
  const add = (geo, color, surface) => {
    if (!geo) return;
    const m = mat(color);
    if (S.pixel && surface) addGroundDetail(m, surface === 'grass-or-street' ? (street ? 'street' : 'grass') : surface, { shared, street });
    const mesh = new THREE.Mesh(geo, m);
    mesh.receiveShadow = mesh.castShadow = !S.flat;
    if (geo.attributes.aGrow) { // land that opens over time (its shadow too)
      addGrowth(m, shared);
      mesh.customDepthMaterial = addGrowth(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), shared);
    }
    scene.add(mesh);
  };
  // when each block opens (from the street field); without one, everything is there from the start
  const bornOf = b => blockBorn ? blockBorn[layout.blocks.indexOf(b)] : 0;
  const landTop = layout.groundIsWater ? plateStep * 0.8 : 0;
  if (layout.groundIsWater) add(slab([...layout.land, ...layout.shore], 0, landTop), S.land, 'grass-or-street');
  // lakes and rivers; on a city whose ground is the sea, they're pools sitting on the land
  if (layout.water.length) add(slab(layout.water, layout.groundIsWater ? landTop : 0, plateStep * 0.05), S.water, 'water');
  const colors = { block: S.plate, park: S.park, plaza: S.plaza, lawn: S.lawn, yard: S.yard, beach: S.sand };
  // terraces (a mountain city): rock cliffs up to each terrace, its surface laid on top
  const raised = layout.blocks.filter(b => b.h > 0);
  if (raised.length) add(slabEach(raised.map(b => [b.poly, landTop, b.h, bornOf(b)])), S.cliff || S.plate);
  // farm fields: each its own crop colour, furrows running one way or the other
  const crops = new Map();
  for (const b of layout.blocks) if (b.type === 'crop') { const k = b.color + '|' + b.rows; if (!crops.has(k)) crops.set(k, []); crops.get(k).push(b); }
  for (const [k, bs] of crops) { const [color, rows] = k.split('|'); add(slabEach(bs.map(b => [b.poly, landTop, plateStep * 0.6, bornOf(b)])), color, rows === 'x' ? 'cropx' : 'cropz'); }
  for (const type of Object.keys(colors)) {
    const of = layout.blocks.filter(b => b.type === type);
    const depth = type === 'park' ? plateStep * 1.4 : plateStep;
    // each block rises from its own base (a terrace from its cliff top) when it opens
    const geo = blockBorn || of.some(b => b.h > 0) ? slabEach(of.map(b => [b.poly, landTop + (b.h || 0), depth, bornOf(b)])) : slab(of.map(b => b.poly), landTop, depth);
    add(geo, colors[type], { block: 'paving', plaza: 'paving', park: 'grass', lawn: 'grass', yard: 'paving', beach: 'grass' }[type]);
  }
  if (S.flat) {
    // plan: hairline outline around every block
    const pts = [];
    for (const b of layout.blocks) b.poly.forEach((p, k) => { const q = b.poly[(k + 1) % b.poly.length]; pts.push(p[0], landTop + plateStep + 0.1, p[1], q[0], landTop + plateStep + 0.1, q[1]); });
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: S.ink, transparent: true, opacity: 0.3 })));
  }
  for (const r of layout.roads) {
    const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], L = Math.hypot(dx, dz);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(L, plateStep * 0.4, r.w), mat(S.road));
    mesh.position.set((r.a[0] + r.b[0]) / 2, landTop + plateStep * 0.2, (r.a[1] + r.b[1]) / 2);
    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
  for (const b of layout.bridges) {
    const dx = b.b[0] - b.a[0], dz = b.b[1] - b.a[1], L = Math.hypot(dx, dz);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(L, plateStep * 0.7, b.w), mat(S.plate));
    mesh.position.set((b.a[0] + b.b[0]) / 2, landTop + plateStep * 0.5, (b.a[1] + b.b[1]) / 2);
    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.castShadow = mesh.receiveShadow = !S.flat;
    scene.add(mesh);
  }
  // stairways up the mountainside: one step per empty directory on the way up
  for (const st of layout.stairs || []) {
    const rise = st.top / st.n, steps = [];
    for (let k = 0; k < st.n; k++) {
      const d = (k + 0.5) * st.run, hk = st.top - k * rise;
      const g = new THREE.BoxGeometry(st.run * 1.02, plateStep + hk, st.w);
      g.rotateY(-Math.atan2(st.dz, st.dx)).translate(st.x + st.dx * d, landTop + (plateStep + hk) / 2, st.z + st.dz * d);
      steps.push(g);
    }
    add(mergeGeometries(steps), S.plaza);
  }
  // cable car across the river: a cable between the peaks, two red cabins on it
  for (const c of layout.cables || []) {
    const A = new THREE.Vector3(c.a[0], landTop + c.a[2], c.a[1]), Bv = new THREE.Vector3(c.b[0], landTop + c.b[2], c.b[1]);
    const L = A.distanceTo(Bv), mid = A.clone().add(Bv).multiplyScalar(0.5), u = layout.unit;
    const cable = new THREE.Mesh(new THREE.BoxGeometry(L, u * 0.03, u * 0.03), mat(S.ink || '#2b2737'));
    cable.position.copy(mid);
    cable.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), Bv.clone().sub(A).normalize());
    scene.add(cable);
    for (const t of [0.3, 0.68]) {
      const p = A.clone().lerp(Bv, t);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(u * 0.42, u * 0.3, u * 0.26), mat('#c0413b'));
      cab.position.set(p.x, p.y - u * 0.26, p.z);
      cab.castShadow = !S.flat;
      scene.add(cab);
      const hanger = new THREE.Mesh(new THREE.BoxGeometry(u * 0.03, u * 0.12, u * 0.03), mat(S.ink || '#2b2737'));
      hanger.position.set(p.x, p.y - u * 0.06, p.z);
      scene.add(hanger);
    }
    for (const [P, e] of [[A, c.a], [Bv, c.b]]) { // pylons on the peaks
      const py = new THREE.Mesh(new THREE.BoxGeometry(u * 0.12, u * 0.9, u * 0.12), mat(S.ink || '#2b2737'));
      py.position.set(P.x, P.y - u * 0.45, P.z);
      scene.add(py);
      void e;
    }
  }
  // elevated rail: a deck on slim pillars, platforms at the stations
  const u = layout.unit;
  for (const rail of layout.rails) {
    const pts = rail.pts.map(([x, z]) => new THREE.Vector3(x, landTop + plateStep + rail.h, z));
    const curve = new THREE.CatmullRomCurve3(pts, rail.closed, 'centripetal', 0.5);
    const n = Math.max(40, Math.round(curve.getLength() / (u * 0.4)));
    const deck = [], pillars = [];
    const P = curve.getSpacedPoints(n);
    for (let k = 0; k < P.length - 1; k++) {
      const a = P[k], b = P[k + 1], L = a.distanceTo(b);
      deck.push(new THREE.BoxGeometry(L * 1.02, u * 0.16, u * 0.42).rotateY(-Math.atan2(b.z - a.z, b.x - a.x)).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2));
      if (k % 4 === 0) pillars.push(new THREE.BoxGeometry(u * 0.12, rail.h, u * 0.12).translate(a.x, landTop + plateStep + rail.h / 2, a.z));
    }
    for (const [x, z] of rail.pts) deck.push(new THREE.BoxGeometry(u * 1.1, u * 0.2, u * 0.8).translate(x, landTop + plateStep + rail.h, z));
    add(mergeGeometries([...deck, ...pillars]), S.rail);
  }
  if (layout.decor.length) {
    add(mergeGeometries(layout.decor.map(d => new THREE.BoxGeometry(d.w, d.h, d.d).translate(d.x, landTop + plateStep + d.h / 2, d.z))), S.building);
  }
  if (layout.ships?.length) {
    const geo = mergeGeometries(layout.ships.map(sh => shipGeometry(sh).rotateY(sh.rot).translate(sh.x, plateStep * 0.05, sh.z)));
    const mesh = new THREE.Mesh(geo, S.flat ? new THREE.MeshBasicMaterial({ vertexColors: true }) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
    mesh.castShadow = mesh.receiveShadow = !S.flat;
    scene.add(mesh);
  }
  for (const h of S.flat ? [] : layout.hills) { // seen from straight above, hills are just blobs
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), mat(S.hill));
    mesh.scale.set(h.r, h.h, h.r * 0.8);
    mesh.position.set(h.x, 0, h.z);
    mesh.castShadow = mesh.receiveShadow = !S.flat;
    scene.add(mesh);
  }
}

export function buildStudio(ctx) {
  const { name, scene, renderer, B, files, districts, unit, SIZE, plateStep, cx, cz, shared, heat, focusAttr, inDeg, hub, t01, layout, chip } = ctx;
  // a desert city stands on sand: the open ground and the lawns between blocks become dunes
  const S = layout?.sand ? { ...STYLES[name], land: STYLES[name].sand, lawn: STYLES[name].dune } : STYLES[name];
  const N = files.length;
  // each style sets its own skyline proportions: a model city is squat, a night city can soar
  const H = B.map(b => S.flat ? plateStep * 0.5 : S.chip ? chip.chipHeight(b, unit) : layout ? b.h : Math.min(b.h * (S.heightScale || 1), unit * (S.maxHeight || 99)));

  renderer.toneMapping = S.toneMapping;
  renderer.toneMappingExposure = S.exposure;
  scene.background = new THREE.Color(S.background);
  if (S.fog) scene.fog = new THREE.Fog(S.fog[0], SIZE * S.fog[1], SIZE * S.fog[2]);

  // ---- light
  if (!S.flat) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = S.pixel ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap; // pixel art wants hard shadows
    // the sun stands still, and whatever casts a shadow (buildings, trees, land) moves only as the timeline
    // grows it in (vehicles cast none): redraw the shadow map when the timeline moves, not every frame
    renderer.shadowMap.autoUpdate = false;
    let shadowsAt = NaN;
    scene.onBeforeRender = () => {
      if (shared.uTimeline.value === shadowsAt) return;
      shadowsAt = shared.uTimeline.value;
      renderer.shadowMap.needsUpdate = true;
    };
    const sun = new THREE.DirectionalLight(S.sun.color, S.sun.intensity);
    const el = THREE.MathUtils.degToRad(S.sun.elevation), az = THREE.MathUtils.degToRad(S.sun.azimuth);
    sun.position.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(SIZE * 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const r = SIZE * 0.8;
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: SIZE * 4 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = unit * 0.02;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    scene.add(new THREE.HemisphereLight(S.hemi.sky, S.hemi.ground, S.hemi.intensity));
  }

  // ---- sky gradient (nocturne only)
  if (S.sky) {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(S.sky[0]) }, mid: { value: new THREE.Color(S.sky[1]) }, low: { value: new THREE.Color(S.sky[2]) } },
      vertexShader: `varying float vY; void main(){ vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `uniform vec3 top, mid, low; varying float vY;
        void main(){ vec3 c = mix(low, mid, smoothstep(-0.02, 0.08, vY)); c = mix(c, top, smoothstep(0.08, 0.5, vY)); gl_FragColor = vec4(c, 1.); }`,
    });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(SIZE * 6, 32, 16), mat));
  }

  // ---- ground
  const groundColor = !layout ? S.ground : { water: S.water, land: S.land, road: S.chip ? S.land : S.road }[layout.ground]; // (a board is all solder mask)
  const groundMat = S.flat ? new THREE.MeshBasicMaterial({ color: groundColor })
    : new THREE.MeshStandardMaterial({ color: groundColor, roughness: layout?.groundIsWater ? 0.35 : S.chip ? 0.6 : 1 });
  // pixel style: streets come from a distance field over the blocks; asphalt only where streets are
  // (chip: copper traces down them)
  const streets = (S.pixel || S.chip) && layout ? timed('streets (distance field)', () => buildStreets({ layout, B, files, inDeg, SIZE, t01 })) : null;
  // only what the street shader needs: copying the whole object would keep the routing closures (and the big field arrays they hold) alive
  // a campus has footpaths, not roads: paved stone, no centre line
  const pathC = layout?.paths ? new THREE.Color(layout.paths === 'dirt' ? S.dirt : S.plaza) : null;
  const street = streets && { texture: streets.texture, min: streets.min, size: streets.size, maxHalf: streets.maxHalf, asphalt: pathC || new THREE.Color(S.road), grass: new THREE.Color(S.land), mark: pathC || new THREE.Color('#e0d7b8') };
  if (S.pixel && layout) addGroundDetail(groundMat, layout.ground === 'water' ? 'water' : 'street', { shared, street });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 14, SIZE * 14).rotateX(-Math.PI / 2), groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- city terrain from a planner: land, raised blocks, parks, plazas, bridges, hills
  if (layout) timed('terrain', () => buildTerrain(scene, layout, S, plateStep, shared, street, streets?.blockBorn));
  // district names appear with their land
  // (a district's name goes up with its land, ahead of its first building)
  // (and not before the ground under the name itself has come up: a district's first file can be far off)
  if (layout) for (const l of layout.labels) {
    const land = streets ? streets.bornAt(l.x, l.z) : 0;
    l.born = Math.max(0, Math.max(l.bornRaw != null ? t01(l.bornRaw) : 0, land) - LAND_LEAD);
  }
  // traffic: lanes round every block, busier where the block's files import and are imported a lot
  // Venice has no cars, only boats
  if (streets && layout.paths) { streets.lanes = []; streets.boats = []; } // footpaths: no traffic
  if (streets && layout.kind === 'venice') { streets.lanes = []; streets.boats = [...streets.boats, ...streets.boats.map(b => ({ ...b, pts: [...b.pts].reverse() }))]; }
  const traffic = S.pixel && streets ? timed('traffic', () => buildTraffic({ streets, unit: layout.unit })) : null;
  if (traffic) scene.add(traffic.mesh);
  // the field's lookup tables were only needed to plan routes; the GPU keeps its own copy of the texture
  const trees = S.pixel && layout ? timed('trees', () => buildTrees({ layout, B, streets, unit: layout.unit, plateStep, shared })) : null;
  if (trees) scene.add(trees);
  const roadY = layout?.groundIsWater ? plateStep * 0.8 + 0.05 : 0.05;
  if (S.chip && streets) scene.add(timed('traces', () => chip.buildTraces({ lanes: streets.lanes, unit, y: roadY - 0.05, S, shared })));
  if (streets) { streets.drivable = streets.navigable = streets.bornAt = null; streets.curbs = null; streets.lanes = streets.boats = null; streets.texture.onUpdate = t => { t.image.data = null; }; }

  // ---- district plinths (classic treemap only)
  if (!layout) {
    const mat = S.flat ? new THREE.MeshBasicMaterial({ color: S.plate })
      : new THREE.MeshStandardMaterial({ color: S.plate, roughness: S.roughness });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), mat, districts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    districts.forEach((n, i) => {
      m.compose(new THREE.Vector3((n.x0 + n.x1) / 2 - cx, (n.depth - 1) * plateStep, (n.y0 + n.y1) / 2 - cz), q,
        new THREE.Vector3(n.x1 - n.x0, plateStep, n.y1 - n.y0));
      mesh.setMatrixAt(i, m);
    });
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    scene.add(mesh);
    if (S.flat) {
      // plan: hairline district outlines instead of raised plates
      const pts = [];
      for (const n of districts) {
        if (n.depth > 2) continue;
        const [x0, z0, x1, z1] = [n.x0 - cx, n.y0 - cz, n.x1 - cx, n.y1 - cz];
        const y = n.depth * plateStep + 0.1;
        pts.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
      }
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: S.ink, transparent: true, opacity: 0.35 })));
    }
  }

  // ---- buildings: one instanced mesh, standard material + injected growth, windows, heat and focus
  const info = new Float32Array(N * 4), died = Float32Array.from(B, b => b.died ?? 2);
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const base = new THREE.Color(S.building), accent = new THREE.Color(S.accent);
  const mat = S.flat ? new THREE.MeshBasicMaterial({ color: '#ffffff' })
    : new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: S.roughness, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const maxChurn = Math.max(1, ...files.map(f => f.churn));
  // chip: the body stands inside its leads, which take the rest of the footprint
  const leads = S.chip ? chip.leadMargins(B, unit) : null;
  files.forEach((f, i) => {
    const b = B[i];
    const h = H[i];
    const [lx, lz] = leads ? leads[i] : [0, 0];
    q.setFromAxisAngle(UP, b.rot || 0);
    m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w - lx * 2, h, b.d - lz * 2));
    mesh.setMatrixAt(i, m);
    const j = (Math.sin(i * 12.9898) * 43758.5453 % 1) * S.buildingJitter;
    mesh.setColorAt(i, i === hub ? accent : c.copy(base).offsetHSL(0, 0, j));
    info.set([Math.random(), b.born, t01(f.last), Math.log1p(f.churn) / Math.log1p(maxChurn)], i * 4);
  });
  geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
  geo.setAttribute('aDied', new THREE.InstancedBufferAttribute(died, 1));
  geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aFocus', new THREE.InstancedBufferAttribute(focusAttr, 1).setUsage(THREE.DynamicDrawUsage));

  const growVertex = `
    float b0 = aInfo.y * 0.97, d0 = aDied * 0.97;
    float grow = smoothstep(b0, b0 + 0.03, uTimeline) * (1.0 - smoothstep(d0, d0 + 0.02, uTimeline)); // a deleted file comes down
    transformed.y *= max(grow, 0.0);
    transformed *= step(0.001, grow);`;
  const decl = `attribute vec4 aInfo; attribute float aDied, aHeat, aFocus; uniform float uTimeline;`;
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uTimeline: shared.uTimeline, uTime: shared.uTime, uFocus: shared.uFocus, uHover: shared.uHover,
      uWin: { value: unit / 7 }, uWinColor: { value: new THREE.Color(S.windowColor || '#ffffff') }, uWindows: { value: S.windows },
      uAccent: { value: accent } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${decl}
        varying vec3 vWP, vObj, vSz, vON; varying vec4 vInfo; varying float vHeat, vFocus, vId;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${growVertex}
        vWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        vObj = position; vON = normal;
        vSz = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz) * grow, length(instanceMatrix[2].xyz));
        vInfo = aInfo; vHeat = aHeat; vFocus = aFocus; vId = float(gl_InstanceID);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTimeline, uTime, uFocus, uHover, uWin, uWindows; uniform vec3 uWinColor, uAccent;
        varying vec3 vWP, vObj, vSz, vON; varying vec4 vInfo; varying float vHeat, vFocus, vId;
        float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (uFocus >= 0.0) diffuseColor.rgb *= mix(0.35, 1.0, vFocus);
        if (abs(vId - uHover) < 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, 0.35);
        diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, vHeat * 0.6);${S.chip ? chip.LID : ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uWindows > 0.0 && abs(vON.y) < 0.5) {
          float u = abs(vON.x) > 0.5 ? vObj.z * vSz.z : vObj.x * vSz.x;
          vec2 cell = vec2(u / uWin, vObj.y * vSz.y / (uWin * 1.3));
          vec2 id = floor(cell), g = fract(cell);
          float far = smoothstep(0.2, 0.6, max(fwidth(cell).x, fwidth(cell).y));
          float win = step(0.25, g.x) * step(g.x, 0.75) * step(0.3, g.y) * step(g.y, 0.72);
          // recently edited files keep their lights on; old ones go dark
          float recency = 1.0 - clamp((uTimeline - vInfo.z) / 0.25, 0.0, 1.0);
          float p = mix(0.07, 0.55, recency * recency);
          float lit = step(hash2(id + vInfo.x * 37.0 + vON.xz * 11.0), p);
          vec3 near = win * lit * uWinColor * (0.6 + 1.6 * hash2(id + 3.1));
          vec3 avg = uWinColor * p * 0.12; // distant facades: a hint of light, not a lit wall
          totalEmissiveRadiance += mix(near, avg, far) * (0.25 + 0.75 * step(0.0, uFocus) * vFocus + 0.75 * step(uFocus, -0.5));
        }`);
  };
  // shadows must grow with the buildings too
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = sh => {
    sh.uniforms.uTimeline = shared.uTimeline;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${decl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${growVertex}`);
  };
  mesh.customDepthMaterial = depth;
  mesh.castShadow = mesh.receiveShadow = !S.flat;
  mesh.computeBoundingSphere();
  mesh.frustumCulled = false;
  scene.add(mesh);
  if (S.chip) scene.add(chip.buildLeads({ bodies: mesh, B, H, leads, unit, S, shared, grow: growVertex }), chip.buildSilkscreen({ B, unit, S, shared }));
  // pixel style: real architecture per file; the box mesh stays as an invisible picking proxy
  let cityMesh = null;
  if (S.pixel && layout) {
    const specs = timed('building specs', () => buildingSpecs({ files, B, inDeg, hub, unit, kind: layout.kind, t01 }));
    cityMesh = timed('building geometry + merge', () => buildCityMesh({ buildingGeometry, specs, B, files, t01, shared, unit, heat, focus: focusAttr, glow: ctx.glowAttr }));
    scene.add(cityMesh);
    mesh.material.visible = false;
    mesh.castShadow = false;
  }
  // ---- the lots the deleted files leave: bare ground and rubble, once their buildings come down
  let rubble = null;
  if (files.some(f => f.gone)) {
    const material = S.flat ? new THREE.MeshBasicMaterial({ color: '#ffffff' })
      : cityMesh ? new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true })
      : new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true });
    rubble = rubbleMesh({ B, files, unit, material: riseWithTimeline(material, shared), colors: { slab: S.dirt, debris: [S.building, S.plate, S.yard] } });
    rubble.receiveShadow = !S.flat;
    scene.add(rubble);
  }

  // ---- imports: hairline arcs (flat curves in plan), the hub's own lines in the accent colour
  if (S.edges) {
    const edges = [];
    files.forEach((f, i) => f.imp.forEach(j => edges.push([i, j])));
    const SEG = 20, curve = new THREE.QuadraticBezierCurve3();
    const pos = [], col = [], born = [];
    const ink = new THREE.Color(S.edges.color);
    // big repos: thinner ink, and only the hub's 80 strongest lines in the accent colour
    const fade = Math.min(1, Math.max(0.25, 800 / Math.max(1, edges.length)));
    let hubLines = 0;
    for (const [i, j] of edges) {
      const a = B[i], b = B[j];
      const p0 = new THREE.Vector3(a.x, S.flat ? 0.5 : a.y + H[i], a.z), p2 = new THREE.Vector3(b.x, S.flat ? 0.5 : b.y + H[j], b.z);
      const dist = p0.distanceTo(p2);
      const p1 = p0.clone().add(p2).multiplyScalar(0.5);
      if (S.flat) {
        const d = p2.clone().sub(p0);
        p1.x += -d.z * 0.18; p1.z += d.x * 0.18;
      } else if (!S.edges.straight) { // (chip: straight, the ratsnest of a board not yet routed)
        p1.y = Math.max(p0.y, p2.y) + dist * 0.3 + unit;
      }
      curve.v0 = p0; curve.v1 = p1; curve.v2 = p2;
      const isHub = (i === hub || j === hub) && hubLines++ < 80;
      const k = isHub ? accent : ink;
      const alpha = isHub ? Math.min(1, S.edges.opacity * (S.hubEdgeBoost || 6)) * Math.max(0.5, fade) : S.edges.opacity * fade;
      for (let s = 0; s < SEG; s++) {
        for (const t of [s / SEG, (s + 1) / SEG]) {
          const p = curve.getPoint(t);
          pos.push(p.x, p.y, p.z);
          col.push(k.r, k.g, k.b, alpha);
          born.push(Math.max(B[i].born, B[j].born));
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 4));
    g.setAttribute('aBorn', new THREE.Float32BufferAttribute(born, 1));
    const lm = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTimeline: shared.uTimeline, uFocus: shared.uFocus },
      vertexShader: `attribute vec4 aCol; attribute float aBorn; uniform float uTimeline; varying vec4 vC;
        void main(){ vC = aCol; vC.a *= step(aBorn * 0.97 + 0.03, uTimeline); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: `varying vec4 vC; void main(){ if (vC.a <= 0.0) discard; gl_FragColor = vC; }`,
    });
    const lines = new THREE.LineSegments(g, lm);
    lines.frustumCulled = false;
    scene.add(lines);
  }

  return {
    update: () => { traffic?.update(shared.uTime.value, shared.uTimeline.value, roadY); cityMesh?.userData.syncState(); },
    traffic,
    get meshBytes() { return cityMesh?.userData.bytes || 0; },
    style: S,
    heights: H,
    hub,
    buildings: mesh,
    rubble,
    setupPost(bloom) {
      bloom.enabled = !!S.bloom;
      if (S.bloom) Object.assign(bloom, S.bloom);
    },
  };
}
