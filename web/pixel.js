// Retro pixel-art output: render the lit scene at a fraction of the resolution, then in one pass
// quantise it to a fixed palette with ordered dithering, ink the silhouettes where depth jumps,
// and blow it up with hard square pixels.
import * as THREE from 'three';
import { PALETTE as BUILDING_PALETTE } from './buildings.js';

// an original 32-colour palette tuned for a sunlit isometric city
export const PIXEL_PALETTE = [
  '#14121c', '#2b2737', '#4a4458', '#6e6880', '#9c97a8', '#cdc8d2', '#f2efe9', // ink → paper
  '#5a2e2a', '#8c4a3c', '#b8684e', '#d9926a', '#f0c49a',                       // brick, terracotta, sandstone
  '#6b6250', '#968a6e', '#bdb293', '#e0d7b8',                                   // concrete, stone
  '#1f3d5a', '#2f6188', '#4d8db5', '#86bfd9', '#c4e4ee',                        // glass, water, sky
  '#24402a', '#3d6b36', '#61944a', '#93bf62', '#c9df8f',                        // parks, grass
  '#7a2a35', '#c0413b', '#e8833a', '#f2c14e',                                   // accents: signage, cranes, the hub
  '#3a3a3f', '#58585e',                                                         // asphalt
];

const flatHex = p => typeof p === 'string' ? [p] : Array.isArray(p) ? p.flatMap(flatHex) : Object.values(p).flatMap(flatHex);

export function createPixelPipeline(renderer, scene, camera, { pixel = 3, outline = '#14121c', pxUniform = null } = {}) {
  const size = new THREE.Vector2();
  const lowRes = new THREE.Vector2();
  const target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthTexture: new THREE.DepthTexture(1, 1),
  });
  // terrain colours plus the architecture's own, so brick stays brick and glass stays glass
  const hexes = [...new Set([...PIXEL_PALETTE, ...flatHex(BUILDING_PALETTE)].map(h => h.toLowerCase()))];
  const palette = hexes.map(h => new THREE.Color().setStyle(h, THREE.SRGBColorSpace)).map(c => c.convertLinearToSRGB()); // compare in sRGB
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      tColor: { value: target.texture }, tDepth: { value: target.depthTexture },
      uRes: { value: lowRes }, uPalette: { value: palette.map(c => new THREE.Vector3(c.r, c.g, c.b)) },
      uInk: { value: new THREE.Color(outline) }, uNear: { value: 1 }, uFar: { value: 1000 }, uOrtho: { value: 1 }, uEdgePx: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tColor, tDepth; uniform vec2 uRes; uniform vec3 uPalette[${palette.length}];
      uniform vec3 uInk; uniform float uNear, uFar, uOrtho, uEdgePx; varying vec2 vUv;
      float lin(float d) {
        return uOrtho > 0.5 ? uNear + d * (uFar - uNear)
          : (uNear * uFar) / (uFar - d * (uFar - uNear));
      }
      float depthAt(vec2 px) { return lin(texture2D(tDepth, (px + 0.5) / uRes).r); }
      float bayer4(vec2 p) {
        int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
        int i = x + y * 4;
        float m[16] = float[16](0.,8.,2.,10., 12.,4.,14.,6., 3.,11.,1.,9., 15.,7.,13.,5.);
        return m[i] / 16.0 - 0.5;
      }
      vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main() {
        vec2 px = floor(vUv * uRes);
        vec3 c = toSRGB(clamp(texture2D(tColor, (px + 0.5) / uRes).rgb, 0.0, 1.0));
        c += bayer4(px) * 0.022; // just enough to break up banding; more reads as noise (and muddies the overview)
        // nearest palette entry, weighted towards how the eye judges brightness: per channel, 9·w² for
        // the luma weights w = (0.30, 0.59, 0.11) plus 0.35 overall, folded into one dot product (this
        // loop runs for every pixel against every palette colour)
        vec3 best = uPalette[0]; float bd = 1e9;
        for (int k = 0; k < ${palette.length}; k++) {
          vec3 d = c - uPalette[k];
          float e = dot(d * d, vec3(0.30 * 0.30 * 9.0 + 0.35, 0.59 * 0.59 * 9.0 + 0.35, 0.11 * 0.11 * 9.0 + 0.35));
          if (e < bd) { bd = e; best = uPalette[k]; }
        }
        // ink a pixel when a neighbour is much farther away: the silhouette of whatever is in front
        float d0 = depthAt(px);
        float far = max(max(depthAt(px + vec2(1, 0)), depthAt(px - vec2(1, 0))), max(depthAt(px + vec2(0, 1)), depthAt(px - vec2(0, 1))));
        // in the isometric view a jump of a few art pixels' worth of depth is a building's edge: ink
        // every silhouette, so neighbours read as separate blocks even from far off
        float edge = step(uEdgePx > 0.0 ? uEdgePx : d0 * 0.012 + 2.0, far - d0);
        gl_FragColor = vec4(mix(best, uInk, edge * 0.85), 1.0);
      }`,
  }));
  const postScene = new THREE.Scene(); postScene.add(quad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function resize() {
    renderer.getDrawingBufferSize(size);
    // one art pixel = `pixel` CSS pixels, whatever the screen density
    const pr = renderer.getPixelRatio();
    lowRes.set(Math.max(1, Math.floor(size.x / (pixel * pr))), Math.max(1, Math.floor(size.y / (pixel * pr))));
    target.setSize(lowRes.x, lowRes.y);
  }
  resize();

  function draw(out) {
    const u = quad.material.uniforms;
    // tell surface shaders how big one art pixel is in world units, so their patterns can match it
    if (pxUniform && camera.isOrthographicCamera) pxUniform.value = (camera.top - camera.bottom) / camera.zoom / lowRes.y;
    u.uEdgePx.value = camera.isOrthographicCamera ? 3 * (camera.top - camera.bottom) / camera.zoom / lowRes.y : 0;
    u.uNear.value = camera.near; u.uFar.value = camera.far; u.uOrtho.value = camera.isOrthographicCamera ? 1 : 0;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(out);
    renderer.render(postScene, postCam);
    renderer.setRenderTarget(null);
  }
  let shot = null;

  return {
    resize,
    render() { draw(null); },
    // the current view at exactly w × h art pixels, off screen (for share cards): an ImageData
    capture(w, h) {
      const keep = lowRes.clone();
      lowRes.set(w, h); target.setSize(w, h);
      shot ??= new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      shot.setSize(w, h);
      draw(shot);
      const buf = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(shot, 0, 0, w, h, buf);
      lowRes.copy(keep); target.setSize(keep.x, keep.y);
      // WebGL rows run bottom-up
      const img = new ImageData(w, h), row = w * 4;
      for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      return img;
    },
  };
}
