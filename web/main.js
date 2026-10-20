import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import { buildStudio } from './studio.js';
import { buildLayout, CITY_KINDS } from './layouts.js';
import { createPixelPipeline } from './pixel.js';

const params = new URLSearchParams(location.search);
// neon (original) | maquette | plan | nocturne
const STYLE = params.get('style') || 'neon';
const NEON = STYLE === 'neon';
const PIXEL = STYLE === 'pixel';
// art-pixel size in screen pixels, and how far to zoom in (close-ups frame the city's landmark)
const PIXEL_SIZE = Math.max(1, Math.round(+params.get('px') || 2));
const ZOOM = +params.get('zoom') || 1;
const data = await fetch(params.get('data') || 'city.json').then(r => r.json());
const files = data.files;
const N = files.length;
const span = Math.max(1, data.end - data.start);
const t01 = t => (t - data.start) / span;

// ------------------------------------------------------------ layout
const SIZE = 1000;
const est = SIZE / Math.sqrt(Math.max(N, 4));

const tree = { name: data.name, children: [], m: new Map() };
files.forEach((f, i) => {
  const parts = f.p.split('/');
  let n = tree;
  for (let k = 0; k < parts.length - 1; k++) {
    let c = n.m.get(parts[k]);
    if (!c) { c = { name: parts[k], children: [], m: new Map() }; n.m.set(parts[k], c); n.children.push(c); }
    n = c;
  }
  n.children.push({ name: parts.at(-1), i });
});
// merge single-directory chains (src/flask -> one district)
(function collapse(n) {
  if (!n.children) return;
  while (n.children.length === 1 && n.children[0].children) {
    const c = n.children[0];
    n.name += '/' + c.name;
    n.children = c.children;
  }
  n.children.forEach(collapse);
})(tree);

const root = hierarchy(tree)
  .sum(d => d.i !== undefined ? Math.sqrt(files[d.i].loc) + 3 : 0)
  .sort((a, b) => b.value - a.value);
treemap()
  .tile(treemapSquarify.ratio(1))
  .size([SIZE, SIZE])
  .paddingOuter(d => d.depth === 0 ? est * 0.6 : est * Math.max(0.12, 0.35 - d.depth * 0.08))
  .paddingInner(d => d.children.some(c => c.children)
    ? est * Math.max(0.3, 1.0 - d.depth * 0.25)
    : est * 0.16)(root);

const leaves = root.leaves().filter(l => l.data.i !== undefined);
const lotSides = leaves.map(l => Math.min(l.x1 - l.x0, l.y1 - l.y0)).sort((a, b) => a - b);
let unit = lotSides[Math.floor(lotSides.length / 2)] || est;
const locs = files.map(f => f.loc).sort((a, b) => a - b);
const medianLoc = locs[Math.floor(locs.length / 2)] || 1;
let plateStep = unit * 0.05;
const cx = SIZE / 2, cz = SIZE / 2;

const HUES = [0.53, 0.86, 0.74, 0.11, 0.38, 0.95, 0.6, 0.47, 0.03, 0.68];
root.hue = 0.78;
(root.children || []).filter(c => c.children).forEach((c, k) => { c.hue = HUES[k % HUES.length]; });
root.each(n => { if (n.hue === undefined) n.hue = n.parent.hue; });

const inDeg = new Array(N).fill(0);
files.forEach(f => f.imp.forEach(j => inDeg[j]++));
const maxChurn = Math.max(1, ...files.map(f => f.churn));

// per-file render info
const B = files.map(() => ({}));
for (const l of leaves) {
  const f = files[l.data.i];
  const w = l.x1 - l.x0, d = l.y1 - l.y0;
  const set = Math.min(w, d) * 0.14;
  const rel = f.loc / medianLoc;
  const b = B[l.data.i];
  b.x = (l.x0 + l.x1) / 2 - cx;
  b.z = (l.y0 + l.y1) / 2 - cz;
  b.w = Math.max(w - set * 2, unit * 0.1);
  b.d = Math.max(d - set * 2, unit * 0.1);
  b.y = l.parent.depth * plateStep;
  b.h = Math.min(unit * (0.5 + 1.3 * Math.pow(rel, 0.6)), unit * 9);
  b.hue = l.hue;
  b.born = t01(f.born);
}

// city planners (lit styles only): ?city=auto picks the repo's own archetype, ?city=classic keeps the treemap
const CITY = params.get('city') || 'auto';
const cityKind = NEON || CITY === 'classic' ? null : CITY === 'auto' ? data.identity?.city : CITY;
const layout = cityKind && CITY_KINDS.includes(cityKind) ? buildLayout(cityKind, { files, inDeg, SIZE, frontAz: PIXEL ? 45 : undefined }) : null;
if (layout) {
  unit = layout.unit;
  plateStep = unit * 0.06;
  const base = (layout.groundIsWater ? plateStep * 0.8 : 0) + plateStep;
  files.forEach((f, i) => {
    const l = layout.lots[i] || { x: 0, z: 0, w: 0.001, d: 0.001, rot: 0 };
    Object.assign(B[i], { x: l.x, z: l.z, w: l.w * 0.88, d: l.d * 0.88, rot: l.rot, y: base, h: Math.max(layout.heights[i], unit * 0.1) });
  });
}

// ------------------------------------------------------------ renderer
// ?record=1&w=1920&h=1080&fps=30&dur=20 → deterministic frame capture driven by the CLI
const REC = params.get('record') ? {
  w: +params.get('w') || 1920, h: +params.get('h') || 1080,
  fps: +params.get('fps') || 30, dur: +params.get('dur') || 20,
  still: !!params.get('still'), shot: params.get('shot') || 'hero', hud: params.get('hud') !== '0',
} : null;
const viewW = () => REC ? REC.w : innerWidth;
const viewH = () => REC ? REC.h : innerHeight;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!REC });
renderer.setPixelRatio(REC ? (PIXEL ? 1 : 1.5) : Math.min(devicePixelRatio, 2)); // 1.5x supersampling when filming (pixel art does its own)
renderer.setSize(viewW(), viewH(), !REC);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const FOG = new THREE.Color(0.055, 0.02, 0.1);
const fogDensity = 0.75 / SIZE;
scene.background = new THREE.Color(0.012, 0.006, 0.03);

// pixel art is drawn in true isometric: an orthographic camera, no perspective
const ISO_H = SIZE * 0.36;
const camera = PIXEL
  ? new THREE.OrthographicCamera(-ISO_H * viewW() / viewH(), ISO_H * viewW() / viewH(), ISO_H, -ISO_H, -SIZE * 6, SIZE * 6)
  : new THREE.PerspectiveCamera(50, viewW() / viewH(), 0.5, SIZE * 12);
// big cities: start closer and lower so it reads as a skyline, not a carpet
const camK = N > 1000 ? 0.42 : N > 300 ? 0.6 : 0.8;
camera.position.set(SIZE * camK, SIZE * camK * (N > 1000 ? 0.45 : 0.68), SIZE * camK);
camera.lookAt(0, 0, 0);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = unit * 2;
controls.maxDistance = SIZE * 2.5;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.addEventListener('start', () => { controls.autoRotate = false; });

// each planned city has its own establishing shot: azimuth, elevation, distance (× SIZE) and a target
function planCamera({ az, el, dist, target }) {
  // pixel art keeps the classic 2:1 isometric angle for every city; the city's framing becomes zoom
  if (PIXEL) {
    camera.zoom = 0.9 / dist * ZOOM; camera.updateProjectionMatrix(); az = 45; el = 30;
    if (ZOOM > 1.5) { const h = B[inDeg.indexOf(Math.max(...inDeg))]; target = [h.x, h.z]; }
  }
  const A = THREE.MathUtils.degToRad(az), E = THREE.MathUtils.degToRad(el);
  const t = new THREE.Vector3(target[0], unit * 0.5, target[1]);
  camera.position.set(Math.cos(E) * Math.cos(A), Math.sin(E), Math.cos(E) * Math.sin(A)).multiplyScalar(SIZE * 1.25 * dist).add(t);
  camera.lookAt(t);
  controls.target.copy(t);
}
if (layout?.camera) { planCamera(layout.camera); controls.update(); }

const shared = {
  uTime: { value: 0 },
  uTimeline: { value: 0 },
  uPx: { value: 1 }, // world size of one art pixel (pixel style)
  uFogColor: { value: FOG },
  uFogDensity: { value: fogDensity },
  uFocus: { value: -1 },
  uHover: { value: -1 },
  uPixel: { value: renderer.getPixelRatio() * viewH() * 0.5 },
};

const GLSL_COMMON = /* glsl */`
  uniform float uTime, uTimeline, uFogDensity, uFocus, uHover, uPixel;
  uniform vec3 uFogColor;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec3 hsl(float h, float s, float l) {
    vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
  }
  vec3 fog(vec3 col, vec3 wpos) {
    float d = length(wpos - cameraPosition);
    return mix(col, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * d * d));
  }
`;

// ---- sky dome: horizon glow
if (NEON) {
  const geo = new THREE.SphereGeometry(SIZE * 8, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uFogColor: shared.uFogColor },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform vec3 uFogColor; varying vec3 vDir;
      void main(){ float y = vDir.y;
        vec3 top = vec3(0.008, 0.004, 0.025);
        vec3 col = mix(uFogColor * 1.3, top, smoothstep(-0.02, 0.35, y));
        col += vec3(0.25, 0.04, 0.22) * exp(-abs(y) * 22.0) * 0.5;
        gl_FragColor = vec4(col, 1.); }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
}

// ---- ground grid
if (NEON) {
  const geo = new THREE.PlaneGeometry(SIZE * 16, SIZE * 16).rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uCell: { value: unit * 2 } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: GLSL_COMMON + `uniform float uCell; varying vec3 vW;
      void main(){
        vec2 g = abs(fract(vW.xz / uCell - 0.5) - 0.5) / fwidth(vW.xz / uCell);
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        vec3 col = vec3(0.012, 0.008, 0.03) + vec3(0.18, 0.06, 0.32) * line * 0.35;
        gl_FragColor = vec4(fog(col, vW), 1.);
      }`,
  });
  const ground = new THREE.Mesh(geo, mat);
  ground.position.y = -0.01;
  scene.add(ground);
}

// ---- district plates (one instanced mesh)
const districts = [];
root.each(n => { if (n.depth >= 1 && n.children) districts.push(n); });
for (const n of districts) n.born = Math.min(...n.leaves().map(l => l.data.i !== undefined ? B[l.data.i].born : 1));
if (NEON) {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const hue = new Float32Array(districts.length * 3);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uEdge: { value: unit * 0.07 } },
    vertexShader: GLSL_COMMON + `
      attribute vec3 aInfo; // hue, depth, born
      varying vec3 vW, vL, vSize, vInfo; varying float vTop;
      void main(){
        vInfo = aInfo;
        if (uTimeline < aInfo.z) { gl_Position = vec4(0., 0., -2., 1.); return; }
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.);
        vW = w.xyz; vL = position;
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vTop = normal.y;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: GLSL_COMMON + `uniform float uEdge; varying vec3 vW, vL, vSize, vInfo; varying float vTop;
      void main(){
        vec3 neon = hsl(vInfo.x, 1.0, 0.55);
        vec3 col = hsl(vInfo.x, 0.6, 0.025 + 0.008 * vInfo.y);
        if (vTop > 0.5) {
          float e = min((0.5 - abs(vL.x)) * vSize.x, (0.5 - abs(vL.z)) * vSize.z);
          float k = vInfo.y < 1.5 ? 1.6 : 0.45;
          col += neon * k * (1.0 - smoothstep(0.0, uEdge, e));
        } else {
          col = neon * 0.35;
        }
        gl_FragColor = vec4(fog(col, vW), 1.);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, districts.length);
  const m = new THREE.Matrix4();
  districts.forEach((n, i) => {
    m.compose(new THREE.Vector3((n.x0 + n.x1) / 2 - cx, (n.depth - 1) * plateStep, (n.y0 + n.y1) / 2 - cz),
      new THREE.Quaternion(), new THREE.Vector3(n.x1 - n.x0, plateStep, n.y1 - n.y0));
    mesh.setMatrixAt(i, m);
    hue.set([n.hue, n.depth, n.born], i * 3);
  });
  geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(hue, 3));
  mesh.frustumCulled = false;
  scene.add(mesh);
}

// ---- buildings (one instanced mesh, one draw call)
const heat = new Float32Array(N);
const focusAttr = new Float32Array(N).fill(1);
const studio = NEON ? null : buildStudio({ name: STYLE, scene, renderer, B, files, districts, unit, SIZE, plateStep, cx, cz,
  shared, heat, focusAttr, inDeg, t01, layout });
if (studio) {
  document.body.classList.add('studio', `style-${STYLE}`);
  document.body.style.setProperty('--ink', studio.style.ink);
  document.body.style.setProperty('--ink-soft', studio.style.inkSoft);
  document.body.style.setProperty('--paper', studio.style.background);
}
const buildings = studio ? studio.buildings : (() => {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const info = new Float32Array(N * 4);
  const hue = new Float32Array(N);
  const mesh = new THREE.InstancedMesh(geo, new THREE.ShaderMaterial({
    uniforms: { ...shared, uWin: { value: unit / 7 } },
    vertexShader: GLSL_COMMON + `
      attribute vec4 aInfo; // seed, born, last, churn
      attribute float aHue, aHeat, aFocus;
      varying vec3 vW, vL, vN, vSize; varying vec4 vInfo; varying float vHue, vHeat, vFocus, vId;
      void main(){
        float b0 = aInfo.y * 0.97; float grow = smoothstep(b0, b0 + 0.03, uTimeline); // born at 1.0 is fully grown by 1.0
        if (grow < 0.001) { gl_Position = vec4(0., 0., -2., 1.); return; }
        vec3 p = position; p.y *= grow;
        vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.);
        vW = w.xyz; vL = position; vN = normal;
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz) * grow, length(instanceMatrix[2].xyz));
        vInfo = aInfo; vHue = aHue; vHeat = aHeat; vFocus = aFocus; vId = float(gl_InstanceID);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: GLSL_COMMON + `uniform float uWin;
      varying vec3 vW, vL, vN, vSize; varying vec4 vInfo; varying float vHue, vHeat, vFocus, vId;
      void main(){
        vec3 n = normalize(vN);
        vec3 neon = hsl(vHue, 1.0, 0.58);
        vec3 base = hsl(vHue, 0.35, 0.05);
        float age = clamp((uTimeline - vInfo.z) / 0.3, 0.0, 1.0);
        // window grid lives in world units; derivatives taken outside branches
        float u = abs(n.x) > 0.5 ? vW.z : vW.x;
        vec2 cell = vec2(u / uWin, vL.y * vSize.y / (uWin * 1.25));
        vec2 fw = fwidth(cell);
        float far = smoothstep(0.2, 0.6, max(fw.x, fw.y)); // windows < ~2px: use their average glow
        vec3 col;
        if (n.y > 0.5) {
          col = base * 1.3;
          float e = min((0.5 - abs(vL.x)) * vSize.x, (0.5 - abs(vL.z)) * vSize.z);
          col += neon * 1.2 * (1.0 - smoothstep(0.0, uWin * 0.25, e)) * (1.0 - age * 0.7);
          // beacon on hot files
          float r = length(vL.xz * vSize.xz);
          float blink = step(0.0, sin(uTime * 3.0 + vInfo.x * 20.0));
          col += vec3(3.0, 0.2, 0.25) * step(0.6, vInfo.w) * blink * (1.0 - smoothstep(uWin * 0.25, uWin * 0.45, r));
        } else {
          float shade = 0.7 + 0.2 * abs(n.x) + 0.1 * n.z;
          col = base * shade * (0.5 + 0.7 * vL.y);
          vec2 id = floor(cell), g = fract(cell);
          float win = step(0.2, g.x) * step(g.x, 0.8) * step(0.28, g.y) * step(g.y, 0.75);
          float r = hash(id + vInfo.x * 37.0 + n.xz * 11.0);
          float lit = step(r, mix(0.32, 0.03, age));
          lit = max(lit, step(0.93, hash(id + floor(uTime * (0.3 + vInfo.w * 3.0)))) * vInfo.w);
          vec3 wc = mix(vec3(1.0, 0.68, 0.38), vec3(0.5, 0.9, 1.0), step(0.72, hash(id * 1.7 + vInfo.x)));
          wc = mix(wc, neon, 0.3);
          vec3 near = win * lit * wc * (0.35 + 0.9 * hash(id + 3.1) * hash(id + 7.7));
          vec3 avg = mix(vec3(1.0, 0.68, 0.38), neon, 0.3) * mix(0.32, 0.03, age) * 0.28 * 0.57;
          col += mix(near, avg, far);
          // neon crown strip
          float top = (1.0 - vL.y) * vSize.y;
          col += neon * 1.6 * (1.0 - step(uWin * 0.22, top)) * (1.0 - age * 0.6);
        }
        col = mix(col, neon * 1.6 + 0.15, vHeat * 0.4);
        if (abs(vId - uHover) < 0.5) col += neon * 0.5;
        if (uFocus >= 0.0) col *= mix(0.12, 1.3, vFocus);
        gl_FragColor = vec4(fog(col, vW), 1.);
      }`,
  }), N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  files.forEach((f, i) => {
    const b = B[i];
    m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, b.h, b.d));
    mesh.setMatrixAt(i, m);
    info.set([Math.random(), b.born, t01(f.last), Math.log1p(f.churn) / Math.log1p(maxChurn)], i * 4);
    hue[i] = b.hue;
  });
  geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
  geo.setAttribute('aHue', new THREE.InstancedBufferAttribute(hue, 1));
  geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aFocus', new THREE.InstancedBufferAttribute(focusAttr, 1).setUsage(THREE.DynamicDrawUsage));
  mesh.computeBoundingSphere();
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
})();

// ---- dependency sky-lanes: faint arcs + flying particles (all animated on the GPU)
const MAX_EDGES = 3000;
let edges = [];
files.forEach((f, i) => f.imp.forEach(j => edges.push([i, j])));
if (edges.length > MAX_EDGES) edges = edges.sort((a, b) => inDeg[b[1]] - inDeg[a[1]]).slice(0, MAX_EDGES);
const arc = (i, j) => {
  const a = B[i], b = B[j];
  const p0 = new THREE.Vector3(a.x, a.y + a.h, a.z), p2 = new THREE.Vector3(b.x, b.y + b.h, b.z);
  const dist = p0.distanceTo(p2);
  const p1 = p0.clone().add(p2).multiplyScalar(0.5);
  p1.y = Math.max(p0.y, p2.y) + dist * 0.35 + unit;
  return [p0, p1, p2];
};
if (NEON) {
  const SEG = 24;
  const pos = new Float32Array(edges.length * SEG * 2 * 3);
  const attr = new Float32Array(edges.length * SEG * 2 * 4); // t, born, src, dst
  let o = 0;
  const curve = new THREE.QuadraticBezierCurve3();
  edges.forEach(([i, j]) => {
    [curve.v0, curve.v1, curve.v2] = arc(i, j);
    const born = Math.max(B[i].born, B[j].born);
    for (let s = 0; s < SEG; s++) {
      for (const t of [s / SEG, (s + 1) / SEG]) {
        const p = curve.getPoint(t);
        pos.set([p.x, p.y, p.z], o * 3);
        attr.set([t, born, i, j], o * 4);
        o++;
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aEdge', new THREE.BufferAttribute(attr, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: shared, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: GLSL_COMMON + `attribute vec4 aEdge; varying vec4 vE; varying vec3 vW;
      void main(){ vE = aEdge; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: GLSL_COMMON + `varying vec4 vE; varying vec3 vW;
      void main(){
        if (uTimeline < vE.y + 0.03) discard;
        vec3 col = mix(vec3(0.2, 0.9, 1.0), vec3(1.0, 0.3, 0.85), vE.x);
        float a = 0.14;
        if (uFocus >= 0.0) a = (abs(vE.z - uFocus) < 0.5 || abs(vE.w - uFocus) < 0.5) ? 0.9 : 0.01;
        float d = length(vW - cameraPosition);
        a *= exp(-uFogDensity * uFogDensity * d * d);
        gl_FragColor = vec4(col * a, 1.);
      }`,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  scene.add(lines);
}
if (NEON) {
  const PER = edges.length > 1500 ? 1 : 2;
  const n = edges.length * PER;
  const p0 = new Float32Array(n * 3), p1 = new Float32Array(n * 3), p2 = new Float32Array(n * 3);
  const extra = new Float32Array(n * 4); // offset, speed, src, dst
  const born = new Float32Array(n);
  let k = 0;
  edges.forEach(([i, j]) => {
    const [a, b, c] = arc(i, j);
    const len = a.distanceTo(c) + 2 * unit;
    for (let r = 0; r < PER; r++, k++) {
      p0.set([a.x, a.y, a.z], k * 3); p1.set([b.x, b.y, b.z], k * 3); p2.set([c.x, c.y, c.z], k * 3);
      extra.set([Math.random(), (unit * (1.5 + Math.random() * 2)) / len, i, j], k * 4);
      born[k] = Math.max(B[i].born, B[j].born);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(p0, 3));
  geo.setAttribute('aP1', new THREE.BufferAttribute(p1, 3));
  geo.setAttribute('aP2', new THREE.BufferAttribute(p2, 3));
  geo.setAttribute('aX', new THREE.BufferAttribute(extra, 4));
  geo.setAttribute('aBorn', new THREE.BufferAttribute(born, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uSize: { value: unit * 0.08 } }, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: GLSL_COMMON + `uniform float uSize; attribute vec3 aP1, aP2; attribute vec4 aX; attribute float aBorn;
      varying float vA, vT; varying vec3 vW;
      void main(){
        float t = fract(aX.x + uTime * aX.y);
        vec3 p = mix(mix(position, aP1, t), mix(aP1, aP2, t), t);
        vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.);
        vW = (modelMatrix * vec4(p, 1.)).xyz;
        vT = t;
        vA = uTimeline < aBorn + 0.03 ? 0.0 : 1.0;
        if (uFocus >= 0.0) vA *= (abs(aX.z - uFocus) < 0.5 || abs(aX.w - uFocus) < 0.5) ? 1.6 : 0.05;
        gl_PointSize = uSize * uPixel / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GLSL_COMMON + `varying float vA, vT; varying vec3 vW;
      void main(){
        if (vA <= 0.0) discard;
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        vec3 col = mix(vec3(0.3, 1.0, 1.0), vec3(1.0, 0.35, 0.9), vT) * 1.8;
        float f = exp(-uFogDensity * uFogDensity * dot(vW - cameraPosition, vW - cameraPosition));
        gl_FragColor = vec4(col * a * vA * f, 1.);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
}

// ---- street traffic: head/tail lights circling district blocks
if (NEON) {
  const rects = [];
  root.each(n => {
    if (!n.children || n.depth > 2) return;
    // road centre line sits in the middle of the gap between this node's children
    for (const c of n.children) {
      if (!c.children) continue;
      const g = (n.depth === 0 ? est * 0.6 : est * Math.max(0.3, 1.0 - n.depth * 0.25)) * 0.5;
      rects.push({ x0: c.x0 - g - cx, z0: c.y0 - g - cz, x1: c.x1 + g - cx, z1: c.y1 + g - cz, y: n.depth * plateStep, g, born: c.born ?? 0 });
    }
  });
  const cars = [];
  for (const r of rects) {
    const P = 2 * (r.x1 - r.x0 + r.z1 - r.z0);
    const count = Math.min(80, Math.ceil(P / (unit * 1.4)));
    for (let k = 0; k < count; k++) cars.push([r, P, k % 2 ? 1 : -1]);
  }
  const MAX_CARS = 6000;
  if (cars.length > MAX_CARS) cars.length = MAX_CARS;
  const rect = new Float32Array(cars.length * 4), extra = new Float32Array(cars.length * 4);
  const pos = new Float32Array(cars.length * 3);
  cars.forEach(([r, P, dir], k) => {
    const lane = dir * r.g * 0.22;
    rect.set([r.x0 + lane, r.z0 + lane, r.x1 - lane, r.z1 - lane], k * 4);
    extra.set([Math.random(), dir * unit * (0.6 + Math.random() * 0.8) / P, r.y + unit * 0.04, r.born], k * 4);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRect', new THREE.BufferAttribute(rect, 4));
  geo.setAttribute('aX', new THREE.BufferAttribute(extra, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uSize: { value: unit * 0.13 } }, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: GLSL_COMMON + `uniform float uSize; attribute vec4 aRect, aX; varying float vDir, vA; varying vec3 vW;
      vec2 perim(vec4 r, float s) {
        float w = r.z - r.x, h = r.w - r.y; s = fract(s) * 2.0 * (w + h);
        if (s < w) return vec2(r.x + s, r.y); s -= w;
        if (s < h) return vec2(r.z, r.y + s); s -= h;
        if (s < w) return vec2(r.z - s, r.w); s -= w;
        return vec2(r.x, r.w - s);
      }
      void main(){
        vec2 xz = perim(aRect, aX.x + uTime * aX.y);
        vec4 w = modelMatrix * vec4(xz.x, aX.z, xz.y, 1.);
        vec4 mv = viewMatrix * w;
        vW = w.xyz; vDir = sign(aX.y);
        vA = uTimeline < aX.w ? 0.0 : (uFocus >= 0.0 ? 0.25 : 1.0);
        gl_PointSize = uSize * uPixel / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GLSL_COMMON + `varying float vDir, vA; varying vec3 vW;
      void main(){
        if (vA <= 0.0) discard;
        float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
        vec3 col = vDir > 0.0 ? vec3(2.6, 0.25, 0.3) : vec3(2.2, 2.0, 1.6);
        float f = exp(-uFogDensity * uFogDensity * dot(vW - cameraPosition, vW - cameraPosition));
        gl_FragColor = vec4(col * a * vA * f, 1.);
      }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
}

// ------------------------------------------------------------ post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// a single NaN/inf pixel (e.g. from a degenerate lit triangle) otherwise smears into black blocks through bloom
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = min(c, vec4(64.0)); }`,
}));
const bloom = new UnrealBloomPass(new THREE.Vector2(viewW(), viewH()), 0.7, 0.45, 0.75);
composer.addPass(bloom);
studio?.setupPost(bloom);
const pix = PIXEL ? createPixelPipeline(renderer, scene, camera, { pixel: PIXEL_SIZE, pxUniform: shared.uPx }) : null;
const renderFrame = () => pix ? pix.render() : composer.render();
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  if (REC) return;
  if (camera.isOrthographicCamera) { camera.left = -ISO_H * innerWidth / innerHeight; camera.right = -camera.left; }
  else camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  shared.uPixel.value = renderer.getPixelRatio() * innerHeight * 0.5;
  pix?.resize();
});

// ------------------------------------------------------------ HUD + timeline
const $ = s => document.querySelector(s);
$('#hud h1').textContent = data.name;
$('#hud .stats').textContent =
  `${N.toLocaleString()} buildings · ${data.stats.loc.toLocaleString()} LOC · ${data.stats.edges.toLocaleString()} imports · ${data.stats.commits.toLocaleString()} commits`;
$('#loading').remove();

const fmtDate = t => new Date(t * 1000).toISOString().slice(0, 7);
const commits = data.commits; // [t, idx...]
let ci = 0;
let playing = true, speed = 1;
const INTRO_SECONDS = 16;
const slider = $('#slider');
$('#play').onclick = () => { playing = !playing; if (playing && shared.uTimeline.value >= 1) setTimeline(0); syncPlay(); };
$('#speed').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : speed === 4 ? 0.5 : 1; $('#speed').textContent = speed + '×'; setFlashSeconds(INTRO_SECONDS / speed); };
slider.oninput = () => { setTimeline(slider.value / 1000); playing = false; syncPlay(); };
addEventListener('keydown', e => { if (e.code === 'Space') { e.preventDefault(); $('#play').click(); } });
const syncPlay = () => { $('#play').textContent = playing ? '❚❚' : '▶'; };

function setTimeline(v) {
  shared.uTimeline.value = v;
  const now = data.start + v * span;
  // binary search the commit pointer when scrubbing
  let lo = 0, hi = commits.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (commits[mid][0] <= now) lo = mid + 1; else hi = mid; }
  ci = lo;
}

function advance(dt) {
  if (!playing) return;
  moveTimeline(Math.min(1, shared.uTimeline.value + dt * speed / INTRO_SECONDS));
  if (shared.uTimeline.value >= 1) { playing = false; syncPlay(); }
}

// move forward in time, flashing every building touched by the commits we pass
// busy repos pass hundreds of commits per second of playback: dim each flash so the city doesn't white out
let flashGain = 1;
const setFlashSeconds = secs => { flashGain = Math.min(1, 25 / (commits.length / secs)); };
setFlashSeconds(INTRO_SECONDS);
function moveTimeline(v) {
  const now = data.start + v * span;
  let flashed = 0;
  while (ci < commits.length && commits[ci][0] <= now) {
    if (flashed < 400) for (let k = 1; k < commits[ci].length; k++) { const j = commits[ci][k]; heat[j] = Math.max(heat[j], flashGain); flashed++; }
    ci++;
  }
  shared.uTimeline.value = v;
}

// ------------------------------------------------------------ labels for top-level districts
const labelSource = layout
  ? layout.labels.slice(0, 24).map(l => ({ data: { name: l.text }, born: 0, hue: 0, at: [l.x, l.z] }))
  : (root.children || []).filter(c => c.children).slice(0, 24);
const labelEls = labelSource.map(n => {
  const el = document.createElement('div');
  el.className = 'label';
  el.textContent = n.data.name;
  const c = new THREE.Color().setHSL(n.hue, 1, 0.65);
  el.style.color = studio ? studio.style.ink : `#${c.getHexString()}`;
  $('#labels').append(el);
  const p = n.at ? new THREE.Vector3(n.at[0], plateStep * 2, n.at[1])
    : new THREE.Vector3((n.x0 + n.x1) / 2 - cx, plateStep, n.y1 - cz + est * 0.15);
  return { el, n, p };
});
const tmp = new THREE.Vector3();
function updateLabels() {
  for (const { el, n, p } of labelEls) {
    tmp.copy(p).project(camera);
    const visible = tmp.z < 1 && shared.uTimeline.value >= n.born;
    el.style.display = visible ? '' : 'none';
    if (!visible) continue;
    el.style.left = `${(tmp.x * 0.5 + 0.5) * innerWidth}px`;
    el.style.top = `${(-tmp.y * 0.5 + 0.5) * innerHeight}px`;
    el.style.opacity = Math.max(0.15, Math.min(1, 1.6 - camera.position.distanceTo(p) / SIZE));
  }
}

// ------------------------------------------------------------ hover + focus
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tip = $('#tip');
let hoverId = -1, lastMove = 0, downAt = null;
const importers = files.map(() => []);
files.forEach((f, i) => f.imp.forEach(j => importers[j].push(i)));

function pick(e) {
  mouse.set(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObject(buildings)[0];
  return hit && B[hit.instanceId].born <= shared.uTimeline.value ? hit.instanceId : -1;
}
renderer.domElement.addEventListener('pointermove', e => {
  const t = performance.now();
  if (t - lastMove < 40) return;
  lastMove = t;
  hoverId = pick(e);
  shared.uHover.value = hoverId;
  if (hoverId < 0) { tip.style.display = 'none'; renderer.domElement.style.cursor = ''; return; }
  renderer.domElement.style.cursor = 'pointer';
  const f = files[hoverId];
  tip.innerHTML = `<b>${f.p}</b><br><span>lines</span> ${f.loc.toLocaleString()} · <span>commits</span> ${f.churn}<br>` +
    `<span>imports</span> ${f.imp.length} · <span>imported by</span> ${inDeg[hoverId]}<br>` +
    `<span>born</span> ${fmtDate(f.born)} · <span>last edit</span> ${fmtDate(f.last)}`;
  tip.style.display = 'block';
  tip.style.left = `${Math.min(e.clientX + 16, innerWidth - 380)}px`;
  tip.style.top = `${e.clientY + 16}px`;
});
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  focus(pick(e));
});
function focus(id) {
  shared.uFocus.value = id;
  focusAttr.fill(id < 0 ? 1 : 0);
  if (id >= 0) {
    focusAttr[id] = 1;
    files[id].imp.forEach(j => { focusAttr[j] = 1; });
    importers[id].forEach(j => { focusAttr[j] = 1; });
  }
  buildings.geometry.attributes.aFocus.needsUpdate = true;
}
addEventListener('keydown', e => { if (e.code === 'Escape') focus(-1); });


// ------------------------------------------------------------ loop
function tick(dt) {
  shared.uTime.value += dt;
  studio?.update?.();
  const decay = Math.exp(-dt * 4.0);
  for (let i = 0; i < N; i++) heat[i] *= decay;
  buildings.geometry.attributes.aHeat.needsUpdate = true;
}

if (!REC) {
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    advance(dt);
    tick(dt);
    slider.value = Math.round(shared.uTimeline.value * 1000);
    $('#date .d').textContent = fmtDate(data.start + shared.uTimeline.value * span);
    $('#date .c').textContent = `commit ${ci.toLocaleString()} / ${commits.length.toLocaleString()}`;
    controls.update();
    updateLabels();
    renderFrame();
  });
} else {
  record().catch(err => report('/log', String(err?.stack || err)));
}

// ------------------------------------------------------------ cinematic recorder
function report(url, body) { return fetch(url, { method: 'POST', body }); }

async function record() {
  document.body.classList.add('recording');
  controls.enabled = false;
  await document.fonts.ready;

  // the landmark the film ends on: the most imported file (the city's CBD)
  const hub = inDeg.indexOf(Math.max(...inDeg));
  const hb = B[hub];
  const hubPos = new THREE.Vector3(hb.x, hb.y + hb.h * 0.5, hb.z);
  const R = camera.position.length();
  const theta0 = Math.atan2(camera.position.z, camera.position.x);
  const ease = u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  const smooth = (a, b, u) => { const t = Math.min(1, Math.max(0, (u - a) / (b - a))); return t * t * (3 - 2 * t); };
  const pivot = new THREE.Vector3();

  function shot(u) {
    const e = ease(u);
    pivot.set(0, 0, 0).lerp(hubPos, smooth(0.5, 1, u));
    const theta = theta0 + 1.7 * e;
    const r = R * (1.15 - 0.62 * e);
    const y = R * (0.62 - 0.32 * e) + hb.h * 0.5 * smooth(0.6, 1, u);
    camera.position.set(pivot.x + Math.cos(theta) * r, y, pivot.z + Math.sin(theta) * r);
    camera.lookAt(pivot);
  }

  // 2D overlay so the HUD is baked into every frame
  const out = document.createElement('canvas');
  out.width = REC.w; out.height = REC.h;
  const g = out.getContext('2d');
  const S = REC.h / 1080;
  const font = (px, w = 600) => `${w} ${Math.round(px * S)}px 'JetBrains Mono', monospace`;
  const glowText = (txt, x, y, color, blur) => {
    g.shadowColor = color; g.shadowBlur = blur * S; g.fillStyle = '#fff'; g.fillText(txt, x, y);
    g.shadowBlur = 0;
  };
  const stats = `${N.toLocaleString()} buildings · ${data.stats.loc.toLocaleString()} LOC · ${data.stats.commits.toLocaleString()} commits`;
  const v = new THREE.Vector3();

  // quiet, print-like typography for the lit styles
  function studioOverlay() {
    const ST = studio.style;
    g.drawImage(renderer.domElement, 0, 0, REC.w, REC.h);
    if (!REC.hud) return;
    const pad = 72 * S;
    const year = t => new Date(t * 1000).getFullYear();
    g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.letterSpacing = '0px';
    g.fillStyle = ST.ink; g.font = `400 ${Math.round(76 * S)}px ${ST.font}`;
    g.fillText(data.name, pad, pad + 60 * S);
    g.fillStyle = ST.inkSoft; g.font = `400 ${Math.round(17 * S)}px ${ST.uiFont || 'Inter, sans-serif'}`;
    g.fillText(`${year(data.start)}–${year(data.end)}   ·   ${N.toLocaleString()} files   ·   ${data.stats.loc.toLocaleString()} lines`, pad, pad + 98 * S);
    if (layout && data.identity) {
      const id = data.identity;
      const name = { smalltown: 'a small town', manhattan: 'Manhattan', hongkong: 'Hong Kong', tokyo: 'Tokyo', la: 'Los Angeles', paris: 'Paris', venice: 'Venice', barcelona: 'Barcelona' }[layout.kind];
      g.fillStyle = ST.ink; g.font = `italic 400 ${Math.round(30 * S)}px ${ST.font}`;
      g.fillText(`built like ${name}`, pad, pad + 146 * S);
      if (layout.kind === id.city && id.reasons.length) {
        g.fillStyle = ST.inkSoft; g.font = `400 ${Math.round(15 * S)}px ${ST.uiFont || 'Inter, sans-serif'}`;
        id.reasons.slice(0, 2).forEach((r, k) => g.fillText(r, pad, pad + (178 + k * 22) * S));
      }
    }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${ST.labelCase === 'upper' ? 500 : 400} ${Math.round((ST.labelCase === 'upper' ? 13 : 19) * S)}px ${ST.labelCase === 'upper' ? 'Inter, sans-serif' : ST.font}`;
    g.letterSpacing = ST.labelCase === 'upper' ? `${Math.round(3 * S)}px` : '0px';
    for (const { n, p } of labelEls) {
      v.copy(p).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.95) continue;
      const txt = ST.labelCase === 'upper' ? n.data.name.toUpperCase() : n.data.name;
      g.fillText(txt, (v.x * 0.5 + 0.5) * REC.w, (-v.y * 0.5 + 0.5) * REC.h);
    }
    g.letterSpacing = '0px';
    g.textAlign = 'right'; g.textBaseline = 'alphabetic'; g.font = `400 ${Math.round(14 * S)}px ${ST.uiFont || 'Inter, sans-serif'}`;
    g.fillText('gitropolis', REC.w - pad * 0.7, REC.h - pad * 0.6);
  }

  function stillCamera(name) {
    const target = new THREE.Vector3(0, unit * 0.5, 0);
    if (STYLE === 'plan' || name === 'plan') {
      camera.fov = 12; camera.updateProjectionMatrix();
      camera.up.set(0, 0, -1);
      camera.position.set(0, (SIZE * 0.6) / Math.tan(THREE.MathUtils.degToRad(6)), 0);
      camera.lookAt(0, 0, 0);
      return;
    }
    // a small town is long and thin: come in closer so it doesn't shrink to a speck
    const near = layout?.kind === 'smalltown' ? 0.7 : 1;
    if (layout?.camera && (name === 'hero' || PIXEL)) return planCamera(layout.camera);
    const [az, el, d] = ({ hero: [35, N > 1000 ? 27 : 20, (N > 1000 ? 0.95 : 1.0) * near], aerial: [40, 42, 1.15 * near], street: [60, 7, 0.5] }[name] || [35, 13, 0.8])
      .map((x, k) => k < 2 ? THREE.MathUtils.degToRad(x) : x);
    camera.position.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
      .multiplyScalar(SIZE * camK * 1.55 * d).add(target);
    camera.lookAt(target);
  }

  function overlay(u) {
    if (studio) return studioOverlay();
    g.drawImage(renderer.domElement, 0, 0, REC.w, REC.h);
    const pad = 56 * S;
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.font = font(54, 800); glowText(data.name, pad, pad, '#ff4fd8', 28);
    g.font = font(20, 400); g.fillStyle = 'rgba(200,190,240,.75)'; g.fillText(stats, pad, pad + 74 * S);
    g.textAlign = 'right';
    g.font = font(64, 800); glowText(fmtDate(data.start + shared.uTimeline.value * span), REC.w - pad, pad - 6 * S, '#4ef0ff', 30);
    g.font = font(20, 400); g.fillStyle = 'rgba(200,190,240,.75)';
    g.fillText(`commit ${ci.toLocaleString()} / ${commits.length.toLocaleString()}`, REC.w - pad, pad + 74 * S);
    // district labels
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = font(18, 600);
    for (const { n, p, el } of labelEls) {
      if (shared.uTimeline.value < n.born) continue;
      v.copy(p).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      g.globalAlpha = Math.max(0.2, Math.min(1, 1.6 - camera.position.distanceTo(p) / SIZE)) * (1 - smooth(0.8, 0.9, u));
      g.shadowColor = el.style.color; g.shadowBlur = 10 * S; g.fillStyle = el.style.color;
      g.fillText(n.data.name.toUpperCase(), (v.x * 0.5 + 0.5) * REC.w, (-v.y * 0.5 + 0.5) * REC.h);
      g.shadowBlur = 0;
    }
    g.globalAlpha = 1;
    // finale caption: the hub
    const cap = smooth(0.84, 0.9, u);
    if (cap > 0) {
      g.globalAlpha = cap; g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.font = font(22, 400); g.fillStyle = 'rgba(200,190,240,.85)';
      g.fillText(`the busiest junction in town · imported by ${inDeg[hub]} files`, REC.w / 2, REC.h - pad - 46 * S);
      g.font = font(34, 800); glowText(files[hub].p, REC.w / 2, REC.h - pad, '#ff4fd8', 24);
      g.globalAlpha = 1;
    }
    g.textAlign = 'right'; g.textBaseline = 'bottom'; g.font = font(16, 600); g.fillStyle = 'rgba(78,240,255,.55)';
    g.fillText('made with gitropolis', REC.w - pad * 0.6, REC.h - pad * 0.5);
  }

  if (studio) await Promise.all([document.fonts.load(`400 64px ${studio.style.font}`), document.fonts.load(`400 16px ${studio.style.uiFont || 'Inter'}`)]);
  if (REC.still) {
    setTimeline(1);
    heat.fill(0);
    stillCamera(REC.shot);
    for (let i = 0; i < 3; i++) { tick(0); renderFrame(); }
    overlay(0.5);
    const blob = await new Promise(r => out.toBlob(r, 'image/png'));
    await fetch('/frame?i=0', { method: 'POST', body: blob });
    await report('/done', '1');
    return;
  }

  const total = Math.round(REC.fps * REC.dur);
  const dt = 1 / REC.fps;
  setTimeline(0);
  setFlashSeconds(REC.dur * 0.67);
  const progress = document.createElement('div');
  progress.id = 'rec';
  document.body.append(progress);
  // warm up particle/heat state without capturing
  for (let i = 0; i < 10; i++) tick(dt);

  for (let i = 0; i < total; i++) {
    const u = i / (total - 1);
    moveTimeline(Math.min(1, Math.max(0, (u - 0.03) / 0.67)));
    if (u > 0.86 && shared.uFocus.value !== hub) focus(hub);
    tick(dt);
    shot(u);
    renderFrame();
    overlay(u);
    const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.95));
    await fetch(`/frame?i=${i}`, { method: 'POST', body: blob });
    progress.textContent = `REC ${i + 1}/${total}`;
  }
  await report('/done', String(total));
  progress.textContent = 'DONE — you can close this tab';
}

window.__city = { data, root, B, unit, camera, controls, setTimeline, focus, shared, bloom, scene, renderer, studio };
