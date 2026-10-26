// The lot a deleted file leaves: its foundation slab and a heap of rubble on it, in one instanced mesh
// for the whole city. They come up as the building on the lot comes down (when the timeline reaches
// the day the file went).
import * as THREE from 'three';

const CHUNKS = 5;

// per instance, aDied: when the lot's file went (0..1 along the timeline); userData.lot: whose lot it is
// (the file's index), so pointing at the rubble points at the file
export function rubbleMesh({ B, files, unit, material, colors }) {
  const lots = [...files.keys()].filter(i => files[i].gone && B[i].w > 0.01);
  const n = lots.length * (1 + CHUNKS);
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, n));
  mesh.count = n;
  const died = new Float32Array(Math.max(1, n)), lot = new Int32Array(n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), turn = new THREE.Quaternion(), tip = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  const e = new THREE.Euler();
  const p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
  let k = 0;
  // yaw turns a piece about the vertical; tilt tips it over (a broken block lies at an angle, half sunk)
  const put = (i, x, y, z, w, h, d, yaw, color, tilt = [0, 0]) => {
    q.setFromAxisAngle(UP, (B[i].rot || 0) + yaw).multiply(tip.setFromEuler(e.set(tilt[0], 0, tilt[1])));
    m.compose(p.set(x, y, z), q, s.set(w, h, d));
    mesh.setMatrixAt(k, m);
    mesh.setColorAt(k, c.set(color));
    died[k] = B[i].died; lot[k] = i;
    k++;
  };
  for (const i of lots) {
    const b = B[i], slab = Math.max(unit * 0.04, 0.02);
    // the same heap on every reload: a little generator seeded by the file's index
    let seed = (i * 2654435761) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    put(i, b.x, b.y, b.z, b.w, slab, b.d, 0, colors.slab);
    turn.setFromAxisAngle(UP, b.rot || 0);
    const side = Math.min(b.w, b.d), big = Math.min(side * 0.42, unit * 0.5);
    for (let j = 0; j < CHUNKS; j++) {
      // the first chunk is the heap in the middle, the others are scattered round it
      const r = j ? 0.18 + rnd() * 0.22 : 0, a = rnd() * Math.PI * 2;
      const o = new THREE.Vector3(Math.cos(a) * r * b.w, 0, Math.sin(a) * r * b.d).applyQuaternion(turn);
      const w = big * (j ? 0.35 + rnd() * 0.35 : 1), d = w * (0.6 + rnd() * 0.6), h = w * (j ? 0.4 + rnd() * 0.5 : 0.45);
      const tilt = j ? [(rnd() - 0.5) * 0.9, (rnd() - 0.5) * 0.9] : [0, 0];
      put(i, b.x + o.x, b.y + slab - (j ? h * 0.25 : 0), b.z + o.z, w, h, d, rnd() * Math.PI, colors.debris[j % colors.debris.length], tilt);
    }
  }
  geo.setAttribute('aDied', new THREE.InstancedBufferAttribute(died, 1));
  mesh.userData.lot = lot;
  mesh.frustumCulled = false;
  return mesh;
}

// for a vertex shader: `up` is 0 until the building on the lot has come down (the buildings' own
// shaders take it down over d0 .. d0 + 0.02), then grows to 1, the rubble's full height; done by the
// end of the timeline at the latest
export const RUBBLE_VERTEX = /* glsl */`
  float r0 = aDied * 0.97 + 0.01;
  float up = smoothstep(r0, r0 + 0.02, uTimeline);`;

// the same rubble for a lit material (the studio styles)
export function riseWithTimeline(material, shared) {
  material.onBeforeCompile = sh => {
    sh.uniforms.uTimeline = shared.uTimeline;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDied; uniform float uTimeline;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${RUBBLE_VERTEX}
        transformed.y *= up; transformed *= step(0.001, up);`);
  };
  return material;
}
