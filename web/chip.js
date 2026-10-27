// The easter egg (?style=chip, --style chip): any city drawn as a circuit board. Same plan, other
// parts: every file a chip package on green solder mask, a copper trace round every block with a via
// wherever it turns, silkscreen outlines round the packages, the district names in silkscreen too.
// Only loaded when it's asked for; studio.js builds the rest (light, land, the bodies, picking).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addGrowth, LAND_LEAD } from './surfaces.js';

// packages lie low and flat: a big file is a thicker package, never a tower
export const chipHeight = (b, unit) => unit * (0.12 + 0.16 * Math.min(1, b.h / (unit * 6)));

// how far the leads stick out on [x, z]: from the long sides of a long package (a DIP, an SOIC),
// from all four of a squarish one (a QFP)
export function leadMargins(B, unit) {
  return B.map(b => {
    const s = Math.min(b.w, b.d), p = Math.min(unit * 0.1, s * 0.14);
    if (Math.max(b.w, b.d) < s * 1.6) return [p, p];
    return b.w > b.d ? [0, p] : [p, 0];
  });
}

// the lid, in the bodies' fragment shader: a pin-1 dimple by one corner, and the part number etched
// along the long side in two rows (left out where a package is too small, or too far, to read)
export const LID = /* glsl */`
  {
    vec2 c = vObj.xz * vSz.xz, hs = vSz.xz * 0.5;
    float s = min(hs.x, hs.y), L = max(hs.x, hs.y), lid = step(0.5, vON.y);
    float dimple = 1.0 - smoothstep(s * 0.1, s * 0.13, length(c + hs - s * 0.34));
    vec2 q = hs.x >= hs.y ? c : c.yx;
    float row = s * 0.16, ch = q.x / (row * 0.8);
    float etch = step(abs(abs(q.y) - row * 0.75), row * 0.26) * step(abs(q.x), L * 0.55) * step(0.2, fract(ch))
      * step(0.3, hash2(vec2(floor(ch), sign(q.y)) + vInfo.x * 17.0)) * step(uWin * 1.8, s)
      * (1.0 - smoothstep(0.3, 0.8, fwidth(ch)));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3), lid * max(dimple * 0.8, etch * 0.6));
  }`;

// the leads: one flat box under each body as big as its whole footprint, cut in the shader to a row
// of leads in the margin round the body
const LEADS = /* glsl */`
  vec2 w = vObj.xz * vSz.xz;                 // from the package's centre, world units
  vec2 fw = fwidth(w) / uPitch;
  vec2 hs = vSz.xz * 0.5 - vLead;            // the body's half size
  vec2 o = abs(w) - hs;                      // how far beyond the body, along each axis
  if ((o.x > 0.0) == (o.y > 0.0)) discard;   // under the body, or a corner
  bool xSide = o.x > 0.0;                    // leads on the ±x sides are spaced along z
  float along = xSide ? w.y : w.x, span = xSide ? hs.y : hs.x, f = xSide ? fw.y : fw.x;
  float n = max(1.0, floor(span * 2.0 / uPitch - 0.3));
  float t = (along + n * uPitch * 0.5) / uPitch; // counted from the first lead
  if (t < 0.0 || t > n) discard;
  float lead = step(0.22, fract(t)) * step(fract(t), 0.78);
  float far = smoothstep(0.35, 0.7, f);      // too fine to draw one by one: a dimmer strip
  if (far < 0.5 && lead < 0.5) discard;
  diffuseColor.rgb *= mix(1.0, 0.6, far);
  if (uFocus >= 0.0) diffuseColor.rgb *= mix(0.35, 1.0, vFocus);`;

export function buildLeads({ bodies, B, H, leads, unit, S, shared, grow }) {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  for (const k of ['aInfo', 'aDied', 'aFocus']) geo.setAttribute(k, bodies.geometry.attributes[k]); // the bodies' own buffers
  geo.setAttribute('aLead', new THREE.InstancedBufferAttribute(Float32Array.from(leads.flat()), 2));
  const mat = new THREE.MeshStandardMaterial({ color: S.leads, roughness: 0.35, metalness: 0.7 });
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { uTimeline: shared.uTimeline, uFocus: shared.uFocus, uPitch: { value: unit * 0.09 } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aInfo; attribute vec2 aLead; attribute float aDied, aFocus; uniform float uTimeline;
        varying vec3 vObj, vSz; varying vec2 vLead; varying float vFocus;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${grow}
        vObj = position; vLead = aLead; vFocus = aFocus;
        vSz = vec3(length(instanceMatrix[0].xyz), 0.0, length(instanceMatrix[2].xyz));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uFocus, uPitch; varying vec3 vObj, vSz; varying vec2 vLead; varying float vFocus;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${LEADS}`);
  };
  const mesh = new THREE.InstancedMesh(geo, mat, B.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  B.forEach((b, i) => {
    q.setFromAxisAngle(UP, b.rot || 0);
    m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(b.w, H[i] * 0.3, b.d));
    mesh.setMatrixAt(i, m);
  });
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

// Copper: a trace round every block, halfway out to the middle of its street (the traffic lanes of
// the pixel style), so a street carries two traces side by side, and a via wherever a trace turns.
// Each goes down with its block.
export function buildTraces({ lanes, unit, y, S, shared }) {
  const copper = [], drills = [];
  const h = unit * 0.015;
  for (const lane of lanes) {
    const pts = lane.pts, n = pts.length;
    const w = Math.min(unit * 0.11, lane.lane * 0.7), r = w * 1.15;
    const born = lane.born + LAND_LEAD; // (lanes are dated ahead of their block; the land's clock takes the lead off again)
    const opens = g => {
      const k = g.attributes.position.count, a = new Float32Array(k * 2);
      for (let j = 0; j < k; j++) { a[j * 2] = born; a[j * 2 + 1] = y; }
      return g.setAttribute('aGrow', new THREE.BufferAttribute(a, 2));
    };
    for (let k = 0; k < n; k++) {
      const [px, pz] = pts[(k - 1 + n) % n], [ax, az] = pts[k], [bx, bz] = pts[(k + 1) % n];
      const L = Math.hypot(bx - ax, bz - az);
      if (L > 1e-6) copper.push(opens(new THREE.BoxGeometry(L + w, h, w).rotateY(-Math.atan2(bz - az, bx - ax)).translate((ax + bx) / 2, y + h / 2, (az + bz) / 2)));
      const turn = Math.abs(Math.atan2((ax - px) * (bz - az) - (az - pz) * (bx - ax), (ax - px) * (bx - ax) + (az - pz) * (bz - az)));
      if (turn < 0.4) continue;
      copper.push(opens(new THREE.CylinderGeometry(r, r, h * 1.6, 16).translate(ax, y + h * 0.8, az)));
      drills.push(opens(new THREE.CylinderGeometry(r * 0.45, r * 0.45, h * 1.8, 12).translate(ax, y + h * 0.9, az)));
    }
  }
  const group = new THREE.Group();
  for (const [geos, mat] of [
    [copper, new THREE.MeshStandardMaterial({ color: S.copper, roughness: 0.38, metalness: 0.55 })],
    [drills, new THREE.MeshStandardMaterial({ color: '#0b0c0b', roughness: 0.9 })],
  ]) {
    if (!geos.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(geos), addGrowth(mat, shared));
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// silkscreen: an outline round each package's footprint, its pin-1 corner cut off, there while the
// package is
export function buildSilkscreen({ B, unit, S, shared }) {
  const pos = [], when = [];
  const m = unit * 0.05;
  B.forEach(b => {
    if (!(b.w > 0.01)) return;
    const hw = b.w / 2 + m, hd = b.d / 2 + m, y = b.y + unit * 0.01, k = Math.min(unit * 0.12, hw * 0.6, hd * 0.6);
    const c = Math.cos(b.rot || 0), s = Math.sin(b.rot || 0);
    const P = ([x, z]) => [b.x + x * c + z * s, y, b.z - x * s + z * c];
    const ring = [[-hw + k, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd + k]];
    ring.forEach((p, j) => {
      const q = ring[(j + 1) % ring.length];
      pos.push(...P(p), ...P(q));
      when.push(b.born, b.died ?? 2, b.born, b.died ?? 2);
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWhen', new THREE.Float32BufferAttribute(when, 2));
  const lines = new THREE.LineSegments(g, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTimeline: shared.uTimeline, uColor: { value: new THREE.Color(S.silk) } },
    vertexShader: `attribute vec2 aWhen; uniform float uTimeline; varying float vA;
      void main(){ vA = step(aWhen.x * 0.97 + 0.03, uTimeline) * step(uTimeline, aWhen.y * 0.97 + 0.02); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ if (vA <= 0.0) discard; gl_FragColor = vec4(uColor, 0.7); }`,
  }));
  lines.frustumCulled = false;
  return lines;
}
