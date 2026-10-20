// Pixel-scale surface detail painted in the shader, so thousands of buildings cost no extra geometry.
// Patterns are pinned to the surfaces (they don't swim when the camera pans) but sized in *art pixels*,
// the way a sprite artist works: a brick course is ~3 pixels tall whether the building is a shed or a
// tower, and whether we're zoomed in or out. Sizes snap to powers of two so zooming steps between
// detail levels instead of shimmering.

// land is prepared before anyone builds on it: a block and its streets open this much of the timeline
// ahead of its first file (a few months in a decade-old repo), so the city is laid out, then filled in
export const LAND_LEAD = 0.04;

const COMMON = /* glsl */`
  uniform float uTime, uWave, uPx, uTimeline;
  varying vec3 vSurfWP, vSurfN;
  float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  // world size of n art pixels, snapped to a power of two
  float P(float n) { return exp2(floor(log2(max(uPx * n, 1e-4)) + 0.5)); }
  // guard for the moments a snapped pattern lands just under a pixel
  float sFade(vec2 cells) { vec2 w = fwidth(cells); return 1.0 - smoothstep(0.45, 0.9, max(w.x, w.y)); }
  // 2D world coordinates across any vertical face
  vec2 sFacade(vec3 p, vec3 n) {
    vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n + vec3(1e-4, 0.0, 0.0)));
    return vec2(dot(p, t), p.y);
  }
  vec3 sGrass(vec3 c) {
    float h = sHash(floor(vSurfWP.xz / P(2.0)));
    return c * (1.0 + step(0.95, h) * 0.12 - step(h, 0.04) * 0.12); // sparse: a lawn, not static
  }
`;

const FACADE = /* glsl */`
  vec3 sN = normalize(vSurfN);
  vec3 col = diffuseColor.rgb;
  if (vSurfPart < 0.5 || abs(vSurfPart - 5.0) < 0.5) {
    if (abs(sN.y) < 0.5) {
      vec2 f = sFacade(vSurfWP, sN);
      bool brick = col.r > col.g * 1.15 && col.r > col.b * 1.3;
      if (brick) {
        // running bond: 3-pixel courses offset by half a brick, 1-pixel light mortar, tone per brick
        float course = P(3.0);
        vec2 b = f / vec2(course * 2.3, course);
        b.x += 0.5 * mod(floor(b.y), 2.0);
        vec2 g = fract(b);
        float fade = sFade(b);
        float mortar = max(step(g.y, 0.34), step(g.x, 0.15));
        col *= 1.0 + (sHash(floor(b)) - 0.5) * 0.22 * fade;
        col = mix(col, mix(col, vec3(0.78, 0.74, 0.68), 0.45), mortar * fade);
      } else {
        // concrete / stone: panel joints and rain streaks running down each panel
        vec2 p = f / vec2(P(14.0), P(9.0));
        vec2 g = fract(p);
        float fade = sFade(p);
        float joint = max(step(g.x, 0.08), step(g.y, 0.12));
        float streak = step(0.72, sHash(vec2(floor(f.x / P(2.0)), 3.0))) * (0.5 + 0.5 * (1.0 - g.y));
        col = mix(col, col * 0.8, joint * fade);
        col = mix(col, col * 0.9, streak * fade);
      }
    }
  } else if (abs(vSurfPart - 3.0) < 0.5 || vSurfPart > 5.5) {
    // glass: a diagonal sky reflection sweeping across, 1-pixel mullion grid
    vec2 f = sFacade(vSurfWP, sN);
    float d = fract((f.x * 0.7 + f.y) / P(40.0));
    float band = step(0.04, d) * (1.0 - step(0.2, d));
    vec2 m = f / vec2(P(5.0), P(6.0));
    vec2 g = fract(m);
    float mull = max(step(g.x, 0.2), step(g.y, 0.17));
    col = mix(col, col * 1.4 + vec3(0.1, 0.12, 0.14), band * 0.55);
    col = mix(col, col * 0.55, mull * sFade(m));
  } else if (abs(vSurfPart - 1.0) < 0.5) {
    if (sN.y < 0.97 && sN.y > 0.15) {
      // pitched roof: rows of overlapping tiles
      vec3 down = normalize(vec3(sN.x, 0.0, sN.z) + vec3(1e-4, 0.0, 0.0));
      vec3 along = normalize(cross(vec3(0.0, 1.0, 0.0), down));
      vec2 b = vec2(dot(vSurfWP, along), vSurfWP.y) / vec2(P(4.0), P(3.0));
      b.x += 0.5 * mod(floor(b.y), 2.0);
      vec2 g = fract(b);
      float fade = sFade(b);
      col = mix(col, col * 0.72, step(g.y, 0.34) * fade);
      col = mix(col, col * 0.85, step(g.x, 0.25) * fade);
    } else if (sN.y >= 0.97) {
      // flat roof: gravel
      col = mix(col, col * 0.84, step(0.85, sHash(floor(vSurfWP.xz / P(2.0)))));
    }
  }
  diffuseColor.rgb = col;
`;

const GROUND = {
  // little light dashes drifting across the water, at two scales
  water: /* glsl */`
    float wave = 0.0;
    for (int k = 0; k < 2; k++) {
      vec2 sz = k == 0 ? vec2(P(24.0), P(6.0)) : vec2(P(9.0), P(3.0));
      vec2 c = vSurfWP.xz / sz;
      c.x += uWave * (k == 0 ? 0.15 : 0.5) * (0.5 + sHash(vec2(floor(c.y), 7.0 + float(k))));
      vec2 g = fract(c);
      float w = step(k == 0 ? 0.8 : 0.84, sHash(floor(c) + float(k) * 13.0)) * step(g.y, 0.35) * step(0.15, g.x) * step(g.x, 0.85);
      wave = max(wave, w * sFade(c));
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.5 + 0.08, wave);`,
  // ploughed rows: a dark furrow every few art pixels, the crop between them a little patchy
  cropx: /* glsl */`
    vec2 c = vSurfWP.xz / vec2(P(3.0), P(2.0));
    float furrow = step(fract(c.x), 0.34) * sFade(c);
    diffuseColor.rgb *= (1.0 - furrow * 0.28) * (1.0 + (sHash(floor(c)) - 0.5) * 0.08);`,
  cropz: /* glsl */`
    vec2 c = vSurfWP.xz / vec2(P(2.0), P(3.0));
    float furrow = step(fract(c.y), 0.34) * sFade(c);
    diffuseColor.rgb *= (1.0 - furrow * 0.28) * (1.0 + (sHash(floor(c)) - 0.5) * 0.08);`,
  grass: /* glsl */`
    diffuseColor.rgb = sGrass(diffuseColor.rgb);`,
  paving: /* glsl */`
    vec2 c = vSurfWP.xz / P(8.0);
    vec2 g = fract(c);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.86, max(step(g.x, 0.12), step(g.y, 0.12)) * sFade(c));`,
  // the open ground: asphalt only where streets are (near blocks, from a distance field), a dashed
  // centre line found as the ridge of that field, grass everywhere else
  street: /* glsl */`
    vec2 suv = (vSurfWP.xz - uStreetMin) / uStreetSize;
    vec4 st = texture2D(tStreet, suv);
    float D = st.r * 255.0;
    float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
    vec3 col = sGrass(uGrass);
    // the street is paved once the block beside it has opened (G = when, over the timeline)
    // (on the same clock as the block rising beside it, so no road appears before its land)
    if (inside > 0.5 && D > 0.5 && D <= uMaxHalf && st.g * 0.97 - ${LAND_LEAD.toFixed(3)} + 0.012 <= uTimeline) {
      col = uAsphalt * (1.0 + (sHash(floor(vSurfWP.xz / P(1.5))) - 0.5) * 0.08);
      // across-street direction (towards the nearest block); the centre line is where D peaks across it
      float a = st.b * 3.14159265;
      vec2 n = vec2(cos(a), sin(a));
      float du = uPx * 0.9 / uStreetSize;
      float D1 = texture2D(tStreet, suv + n * du).r * 255.0, D2 = texture2D(tStreet, suv - n * du).r * 255.0;
      float ridge = step(D1, D + 0.02) * step(D2, D + 0.02) * step(1.5, D);
      vec2 along = vec2(-n.y, n.x);
      float dash = step(0.55, fract(dot(vSurfWP.xz, along) / P(8.0)));
      col = mix(col, uMark, ridge * dash);
    }
    diffuseColor.rgb = col;`,
};

// add our varyings and uniforms to any built-in material; chains with an existing onBeforeCompile
function inject(material, { shared, withPart, fragment, key, uniforms = {}, decl = '' }) {
  const prev = material.onBeforeCompile;
  // three.js caches programs by onBeforeCompile's source text, which is the same for every surface kind
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|surface:${key}`;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    Object.assign(sh.uniforms, { uTime: shared.uTime, uWave: shared.uWave, uPx: shared.uPx, uTimeline: shared.uTimeline }, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSurfWP, vSurfN;${withPart ? '\nattribute float part; varying float vSurfPart;' : ''}`)
      .replace('#include <project_vertex>', `vSurfWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSurfN = normalize(mat3(modelMatrix) * objectNormal);${withPart ? '\nvSurfPart = part;' : ''}\n#include <project_vertex>`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}${decl}${withPart ? '\nvarying float vSurfPart;' : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n{${fragment}\n}`);
  };
  material.needsUpdate = true;
}

export function addFacadeDetail(material, opts) {
  inject(material, { ...opts, withPart: true, fragment: FACADE, key: 'facade' });
}

export function addGroundDetail(material, kind, opts) {
  if (kind === 'street') {
    const s = opts.street;
    inject(material, {
      ...opts, withPart: false, fragment: GROUND.street, key: 'street',
      decl: '\nuniform sampler2D tStreet; uniform vec2 uStreetMin; uniform float uStreetSize, uMaxHalf; uniform vec3 uAsphalt, uGrass, uMark;',
      uniforms: {
        tStreet: { value: s.texture }, uStreetMin: { value: s.min }, uStreetSize: { value: s.size },
        uMaxHalf: { value: s.maxHalf }, uAsphalt: { value: s.asphalt }, uGrass: { value: s.grass }, uMark: { value: s.mark },
      },
    });
  } else if (GROUND[kind]) inject(material, { ...opts, withPart: false, fragment: GROUND[kind], key: kind });
}

// Land that opens over time: each vertex carries aGrow = (when its block opens, the slab's base
// height). Until then the slab lies flat and out of sight; then it rises from its base in a moment.
const GROW = /* glsl */`
  float gOpen = smoothstep(aGrow.x * 0.97 - ${LAND_LEAD.toFixed(3)}, aGrow.x * 0.97 - ${LAND_LEAD.toFixed(3)} + 0.02, uTimeline);
  transformed.y = aGrow.y + (transformed.y - aGrow.y) * gOpen;
  if (gOpen < 0.001) transformed.y -= 1e5;`;
export function addGrowth(material, shared) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|grow`;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    sh.uniforms.uTimeline = shared.uTimeline;
    if (!sh.vertexShader.includes('uniform float uTimeline')) sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTimeline;');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aGrow;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GROW}`);
  };
  material.needsUpdate = true;
  return material;
}
