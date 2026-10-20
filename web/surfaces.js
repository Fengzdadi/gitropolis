// Pixel-scale surface detail painted in the shader, so thousands of buildings cost no extra geometry:
// brick bond, concrete panel joints and rain streaks, glass reflections and mullions, roof tiles,
// gravel; water ripples, grass tufts and paving on the ground. Every pattern fades out once its
// features shrink below about one art pixel, so a distant city stays clean instead of noisy.

const COMMON = /* glsl */`
  uniform float uUnit, uTime;
  varying vec3 vSurfWP, vSurfN;
  float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  // 1 when a pattern's cells are comfortably larger than a pixel, 0 when they'd alias
  float sFade(vec2 cells) { vec2 w = fwidth(cells); return 1.0 - smoothstep(0.28, 0.6, max(w.x, w.y)); }
  // 2D facade coordinates on any vertical face, in building units
  vec2 sFacade(vec3 p, vec3 n) {
    vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n + vec3(1e-4, 0.0, 0.0)));
    return vec2(dot(p, t), p.y) / uUnit;
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
        // running bond: courses offset by half a brick, light mortar, a little tone per brick
        vec2 b = f / vec2(0.11, 0.05);
        b.x += 0.5 * mod(floor(b.y), 2.0);
        vec2 g = fract(b);
        float fade = sFade(b);
        float mortar = max(step(g.y, 0.2), step(g.x, 0.08));
        col *= 1.0 + (sHash(floor(b)) - 0.5) * 0.22 * fade;
        col = mix(col, mix(col, vec3(0.78, 0.74, 0.68), 0.45), mortar * fade);
      } else {
        // concrete / stone: panel joints and rain streaks running down from the top
        vec2 p = f / vec2(0.24, 0.16);
        vec2 g = fract(p);
        float fade = sFade(p);
        float joint = max(step(g.x, 0.05), step(g.y, 0.07));
        float streak = step(0.72, sHash(vec2(floor(f.x / 0.045), 3.0))) * (0.6 + 0.4 * fract(f.y * 3.1));
        col = mix(col, col * 0.8, joint * fade);
        col = mix(col, col * 0.88, streak * fade * 0.8);
      }
    }
  } else if (abs(vSurfPart - 3.0) < 0.5) {
    // glass: a diagonal sky reflection sweeping across, mullion grid, lighter towards the top
    vec2 f = sFacade(vSurfWP, sN);
    float d = fract((f.x * 0.7 + f.y) * 0.9);
    float band = smoothstep(0.0, 0.05, d) * (1.0 - smoothstep(0.16, 0.24, d));
    vec2 m = f / vec2(0.1, 0.13);
    vec2 g = fract(m);
    float mull = max(step(g.x, 0.1), step(g.y, 0.1));
    col = mix(col, col * 1.4 + vec3(0.1, 0.12, 0.14), band * 0.55 * sFade(vec2(f.x * 0.9)));
    col = mix(col, col * 0.55, mull * sFade(m));
  } else if (abs(vSurfPart - 1.0) < 0.5) {
    if (sN.y < 0.97 && sN.y > 0.15) {
      // pitched roof: rows of overlapping tiles
      vec3 down = normalize(vec3(sN.x, 0.0, sN.z) + vec3(1e-4, 0.0, 0.0));
      vec3 along = normalize(cross(vec3(0.0, 1.0, 0.0), down));
      vec2 b = vec2(dot(vSurfWP, along), vSurfWP.y) / uUnit / vec2(0.08, 0.045);
      b.x += 0.5 * mod(floor(b.y), 2.0);
      vec2 g = fract(b);
      float fade = sFade(b);
      col = mix(col, col * 0.72, step(g.y, 0.28) * fade);
      col = mix(col, col * 0.85, step(g.x, 0.07) * fade);
    } else if (sN.y >= 0.97) {
      // flat roof: gravel
      vec2 c = vSurfWP.xz / uUnit / 0.025;
      col = mix(col, col * 0.84, step(0.82, sHash(floor(c))) * sFade(c));
    }
  }
  diffuseColor.rgb = col;
`;

const GROUND = {
  // little light dashes drifting across the water
  water: /* glsl */`
    // two scales: big swells that read from afar, small glints for close-ups
    float wave = 0.0;
    for (int k = 0; k < 2; k++) {
      vec2 sz = k == 0 ? vec2(3.0, 0.9) : vec2(0.8, 0.25);
      vec2 c = vSurfWP.xz / uUnit / sz;
      c.x += uTime * (k == 0 ? 0.15 : 0.5) * (0.5 + sHash(vec2(floor(c.y), 7.0 + float(k))));
      vec2 g = fract(c);
      float w = step(k == 0 ? 0.8 : 0.84, sHash(floor(c) + float(k) * 13.0)) * step(g.y, 0.35) * step(0.15, g.x) * step(g.x, 0.85);
      wave = max(wave, w * sFade(c));
    }
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.5 + 0.08, wave);`,
  // grass tufts: scattered darker and lighter specks
  grass: /* glsl */`
    vec2 c = vSurfWP.xz / uUnit / 0.03;
    float h = sHash(floor(c));
    float fade = sFade(c);
    diffuseColor.rgb *= 1.0 + (step(0.9, h) * 0.18 - step(h, 0.08) * 0.16) * fade;`,
  // paving slabs on sidewalks and plazas
  paving: /* glsl */`
    vec2 c = vSurfWP.xz / uUnit / 0.12;
    vec2 g = fract(c);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.86, max(step(g.x, 0.06), step(g.y, 0.06)) * sFade(c));`,
};

// add our varyings to any built-in material; chains with an existing onBeforeCompile
function inject(material, { unit, shared, withPart, fragment, key }) {
  const prev = material.onBeforeCompile;
  // three.js caches programs by onBeforeCompile's source text, which is the same for every surface kind
  const prevKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${prevKey()}|surface:${key}`;
  material.onBeforeCompile = (sh, r) => {
    prev?.call(material, sh, r);
    sh.uniforms.uUnit = { value: unit };
    sh.uniforms.uTime = shared.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSurfWP, vSurfN;${withPart ? '\nattribute float part; varying float vSurfPart;' : ''}`)
      .replace('#include <project_vertex>', `vSurfWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSurfN = normalize(mat3(modelMatrix) * objectNormal);${withPart ? '\nvSurfPart = part;' : ''}\n#include <project_vertex>`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${COMMON}${withPart ? '\nvarying float vSurfPart;' : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n{${fragment}\n}`);
  };
  material.needsUpdate = true;
}

export function addFacadeDetail(material, opts) {
  inject(material, { ...opts, withPart: true, fragment: FACADE, key: 'facade' });
}

export function addGroundDetail(material, kind, opts) {
  // dense cities have tiny lots; ground texture shouldn't shrink with them or it fades away entirely
  if (GROUND[kind]) inject(material, { ...opts, unit: Math.max(opts.unit, 14), withPart: false, fragment: GROUND[kind], key: kind });
}
