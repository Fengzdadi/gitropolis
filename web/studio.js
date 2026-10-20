// Lit, art-directed alternatives to the neon look: real sun, real shadows, one material, one accent.
//   maquette  — white architectural model under a low raking sun (Panorama of NYC, Gismondi's Rome)
//   plan      — black-on-paper figure-ground print seen from straight above (Nolli map, Stamen Toner)
//   nocturne  — dark, hazy city where only recently edited files are lit from inside (Hopper, Todd Hido)
import * as THREE from 'three';

export const STYLES = {
  maquette: {
    background: '#ece8e1', fog: ['#ece8e1', 0.9, 3.2],
    sun: { color: '#fff0dc', intensity: 3.2, elevation: 17, azimuth: 150 },
    hemi: { sky: '#f6f3ee', ground: '#a69d90', intensity: 1.25 },
    heightScale: 0.42, maxHeight: 4.5,
    building: '#f1ede6', buildingJitter: 0.035, ground: '#d8d1c5', plate: '#e4ded4', roughness: 0.92,
    windows: 0, accent: '#d8452b', edges: { color: '#2a2724', opacity: 0.07 },
    toneMapping: THREE.NeutralToneMapping, exposure: 1.15, bloom: null,
    ink: '#2a2724', inkSoft: 'rgba(42,39,36,.55)', font: "'Instrument Serif', Georgia, serif", labelCase: 'none',
  },
  plan: {
    background: '#f1ede4', fog: null, flat: true,
    building: '#1c1b1a', buildingJitter: 0, ground: '#f1ede4', plate: '#e7e2d7',
    windows: 0, accent: '#d23c2a', edges: { color: '#d23c2a', opacity: 0.22 },
    toneMapping: THREE.NoToneMapping, exposure: 1.0, bloom: null,
    ink: '#1c1b1a', inkSoft: 'rgba(28,27,26,.55)', font: "'Instrument Serif', Georgia, serif", labelCase: 'upper',
  },
  nocturne: {
    background: '#0d1018', fog: ['#2a2629', 0.25, 1.9], sky: ['#0a0d15', '#2b2830', '#6a4a35'],
    sun: { color: '#8fa3c7', intensity: 0.35, elevation: 35, azimuth: 120 },
    hemi: { sky: '#4a5470', ground: '#141217', intensity: 0.9 },
    heightScale: 0.55, maxHeight: 6,
    building: '#34363d', buildingJitter: 0.04, ground: '#14161c', plate: '#1a1c23', roughness: 0.8,
    windows: 1, windowColor: '#ffc27a', accent: '#ffc27a', edges: { color: '#ffc27a', opacity: 0.05 },
    toneMapping: THREE.ACESFilmicToneMapping, exposure: 1.1, bloom: { strength: 0.35, radius: 0.4, threshold: 0.85 },
    ink: '#e8e2d6', inkSoft: 'rgba(232,226,214,.55)', font: "'Instrument Serif', Georgia, serif", labelCase: 'none',
  },
};

export function buildStudio(ctx) {
  const { name, scene, renderer, B, files, districts, unit, SIZE, plateStep, cx, cz, shared, heat, focusAttr, inDeg, t01 } = ctx;
  const S = STYLES[name];
  const N = files.length;
  // each style sets its own skyline proportions: a model city is squat, a night city can soar
  const H = B.map(b => S.flat ? plateStep * 0.5 : Math.min(b.h * (S.heightScale || 1), unit * (S.maxHeight || 99)));

  renderer.toneMapping = S.toneMapping;
  renderer.toneMappingExposure = S.exposure;
  scene.background = new THREE.Color(S.background);
  if (S.fog) scene.fog = new THREE.Fog(S.fog[0], SIZE * S.fog[1], SIZE * S.fog[2]);

  // ---- light
  if (!S.flat) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
  const groundMat = S.flat ? new THREE.MeshBasicMaterial({ color: S.ground })
    : new THREE.MeshStandardMaterial({ color: S.ground, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 14, SIZE * 14).rotateX(-Math.PI / 2), groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- district plinths
  {
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
  const hub = inDeg.indexOf(Math.max(...inDeg));
  const info = new Float32Array(N * 4);
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const base = new THREE.Color(S.building), accent = new THREE.Color(S.accent);
  const mat = S.flat ? new THREE.MeshBasicMaterial({ color: '#ffffff' })
    : new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: S.roughness, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
  const maxChurn = Math.max(1, ...files.map(f => f.churn));
  files.forEach((f, i) => {
    const b = B[i];
    const h = H[i];
    m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, h, b.d));
    mesh.setMatrixAt(i, m);
    const j = (Math.sin(i * 12.9898) * 43758.5453 % 1) * S.buildingJitter;
    mesh.setColorAt(i, i === hub ? accent : c.copy(base).offsetHSL(0, 0, j));
    info.set([Math.random(), b.born, t01(f.last), Math.log1p(f.churn) / Math.log1p(maxChurn)], i * 4);
  });
  geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
  geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aFocus', new THREE.InstancedBufferAttribute(focusAttr, 1).setUsage(THREE.DynamicDrawUsage));

  const growVertex = `
    float b0 = aInfo.y * 0.97; float grow = smoothstep(b0, b0 + 0.03, uTimeline);
    transformed.y *= max(grow, 0.0);
    transformed *= step(0.001, grow);`;
  const decl = `attribute vec4 aInfo; attribute float aHeat, aFocus; uniform float uTimeline;`;
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
        diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, vHeat * 0.6);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uWindows > 0.0 && abs(vON.y) < 0.5) {
          float u = abs(vON.x) > 0.5 ? vWP.z : vWP.x;
          vec2 cell = vec2(u / uWin, vObj.y * vSz.y / (uWin * 1.3));
          vec2 id = floor(cell), g = fract(cell);
          float far = smoothstep(0.2, 0.6, max(fwidth(cell).x, fwidth(cell).y));
          float win = step(0.25, g.x) * step(g.x, 0.75) * step(0.3, g.y) * step(g.y, 0.72);
          // recently edited files keep their lights on; old ones go dark
          float recency = 1.0 - clamp((uTimeline - vInfo.z) / 0.25, 0.0, 1.0);
          float p = mix(0.015, 0.55, recency * recency);
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

  // ---- imports: hairline arcs (flat curves in plan), the hub's own lines in the accent colour
  {
    const edges = [];
    files.forEach((f, i) => f.imp.forEach(j => edges.push([i, j])));
    const SEG = 20, curve = new THREE.QuadraticBezierCurve3();
    const pos = [], col = [], born = [];
    const ink = new THREE.Color(S.edges.color);
    for (const [i, j] of edges) {
      const a = B[i], b = B[j];
      const p0 = new THREE.Vector3(a.x, S.flat ? 0.5 : a.y + H[i], a.z), p2 = new THREE.Vector3(b.x, S.flat ? 0.5 : b.y + H[j], b.z);
      const dist = p0.distanceTo(p2);
      const p1 = p0.clone().add(p2).multiplyScalar(0.5);
      if (S.flat) {
        const d = p2.clone().sub(p0);
        p1.x += -d.z * 0.18; p1.z += d.x * 0.18;
      } else {
        p1.y = Math.max(p0.y, p2.y) + dist * 0.3 + unit;
      }
      curve.v0 = p0; curve.v1 = p1; curve.v2 = p2;
      const isHub = i === hub || j === hub;
      const k = isHub ? accent : ink;
      const alpha = isHub ? Math.min(1, S.edges.opacity * 6) : S.edges.opacity;
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
    style: S,
    heights: H,
    hub,
    buildings: mesh,
    setupPost(bloom) {
      bloom.enabled = !!S.bloom;
      if (S.bloom) Object.assign(bloom, S.bloom);
    },
  };
}
