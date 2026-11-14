// ODYSSEY v2 world recipe: HDRI sky -> background + image-based lighting + matched sun + aerial-perspective fog.
// three.js r158. All functions are pure helpers; the integrator can copy this file into js/.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
// The ordered 4x4 dither of near-camera fades moves every frame (main.js): a still pattern read as a sandstorm of
// fixed dots on bushes and soldiers (critic round 2, defect 17); a moving one averages into a soft see-through.
export const DITHER = { uDitherOff: { value: new THREE.Vector2() } };
// Near-lens dissolve for big bodies: fragments closer to the lens than near1 metres dither away (fully gone at near0),
// with the same moving 4x4 pattern. The giant's palm or forearm right in front of the lens filled half the screen
// (critic round 3, defect 1); his skin now opens up there, as the club already did. Shadows are untouched.
export function addLensDither(material, near0 = 1.0, near1 = 2.6) {
  if (!material || material.userData.__lensDither) return material;
  material.userData.__lensDither = true;
  const prev = material.onBeforeCompile, k0 = material.customProgramCacheKey();
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(material, sh, r);
    Object.assign(sh.uniforms, DITHER);
    if (!/uniform vec2 uDitherOff/.test(sh.fragmentShader)) sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec2 uDitherOff;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
{ float lensHide = 1.0 - smoothstep(${near0.toFixed(2)}, ${near1.toFixed(2)}, length(vViewPosition));
  if (lensHide > 0.0) { ivec2 lq = ivec2(mod(gl_FragCoord.xy + uDitherOff, 4.0)); const float LB4[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
    if ((LB4[lq.x + lq.y * 4] + 0.5) / 16.0 < lensHide) discard; } }`);
  };
  material.customProgramCacheKey = () => k0 + '|lensD' + near0.toFixed(2) + ',' + near1.toFixed(2);
  material.needsUpdate = true;
  return material;
}

const RAD = Math.PI / 180;

// Loads an equirect .hdr, rotates it so the sun sits at `sunAzimuthDeg` (atan2(z, x) in three world space),
// splits the sun out of the image and returns everything the world needs.
//   background : full HDR (sun included) for scene.background
//   envMap     : PMREM of the sun-clamped HDR for scene.environment (sky light + reflections, no double sun)
//   sun        : direction / colour / intensity measured from the clipped energy (irradiance units = HDR units)
//   fogTex     : 128x64 blurred, sun-clamped sky used to colour the distance haze per view direction
export async function loadSky(renderer, url, { sunAzimuthDeg = null, clampMul = 8, legacyGround = false } = {}) {
  const tex = await new RGBELoader().setDataType(THREE.FloatType).loadAsync(url);
  const { width: W, height: H, data } = tex.image;           // RGBA float32, row 0 = top (+Y)
  const lum = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

  // 1) find the sun (energy-weighted direction of everything far above the sky)
  const sample = [];
  for (let i = 0; i < W * H; i += 7) sample.push(lum(i * 4));
  sample.sort((a, b) => a - b);
  const p99 = sample[Math.floor(sample.length * 0.99)];
  const T = Math.max(clampMul * p99, 1.0);
  const dPhi = (2 * Math.PI) / W, dTheta = Math.PI / H;
  const E = [0, 0, 0], dir = new THREE.Vector3();
  for (let y = 0; y < H; y++) {
    const theta = (0.5 - (y + 0.5) / H) * Math.PI;           // elevation
    const cosT = Math.cos(theta), dOmega = dPhi * dTheta * cosT;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, L = lum(i);
      if (L <= T) continue;
      const k = (L - T) / L;
      E[0] += data[i] * k * dOmega; E[1] += data[i + 1] * k * dOmega; E[2] += data[i + 2] * k * dOmega;
      const phi = ((x + 0.5) / W - 0.5) * 2 * Math.PI, w = (L - T) * dOmega;
      dir.x += w * cosT * Math.cos(phi); dir.y += w * Math.sin(theta); dir.z += w * cosT * Math.sin(phi);
    }
  }
  dir.normalize();

  // 2) optional yaw: circularly shift columns so the sun ends up at the requested azimuth
  let shift = 0;
  if (sunAzimuthDeg !== null) {
    const cur = Math.atan2(dir.z, dir.x), want = sunAzimuthDeg * RAD;
    shift = Math.round(((want - cur) / (2 * Math.PI)) * W);
    if (shift) {
      const row = new Float32Array(W * 4);
      for (let y = 0; y < H; y++) {
        const o = y * W * 4;
        for (let x = 0; x < W; x++) {
          const nx = ((x + shift) % W + W) % W;
          row.set(data.subarray(o + x * 4, o + x * 4 + 4), nx * 4);
        }
        data.set(row, o);
      }
      const r = Math.hypot(dir.x, dir.z);
      dir.x = r * Math.cos(want); dir.z = r * Math.sin(want);
    }
  }

  // 2b) below the horizon a "pure sky" HDRI is a dark grey nothing. Seen past the edge of the sea it drew a grey band
  // on the horizon, and blurred into the fog lookup it greyed the far sea (critic round 1, defect 11). The background
  // and the fog now continue the sky just above the horizon (a hazy sea meets a hazy sky); the lighting gets a ground.
  const rowOf = (elevDeg) => Math.min(H - 1, Math.max(0, Math.round((0.5 - elevDeg / 180) * H - 0.5)));
  const yHor = Math.floor(H / 2), yRef = rowOf(0.8);
  const below = { sum: [0, 0, 0], n: 0 };
  if (!legacyGround) for (let y = yHor; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, j = (yRef * W + x) * 4;
    below.sum[0] += data[i]; below.sum[1] += data[i + 1]; below.sum[2] += data[i + 2]; below.n++;
    data[i] = data[j]; data[i + 1] = data[j + 1]; data[i + 2] = data[j + 2];
  }

  // 3) sun-clamped copy for IBL and the fog lookup
  const clamped = new Float32Array(data);
  for (let i = 0; i < W * H * 4; i += 4) {
    const L = lum(i);
    if (L > T) { const s = T / L; clamped[i] *= s; clamped[i + 1] *= s; clamped[i + 2] *= s; }
  }
  // 3b) image-based light from below: sunlit ground. Radiance = albedo / pi x (sun + sky irradiance on the ground),
  // blended in over the first 4 degrees below the horizon. Without it bronze reflected black and every face turned
  // away from the sun had only sky light (backlit figures crushed to black, defect 9).
  const Esky = [0, 0, 0];
  for (let y = 0; y < yHor; y++) {
    const el = (0.5 - (y + 0.5) / H) * Math.PI, w = Math.sin(el) * Math.cos(el) * dPhi * dTheta;
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; Esky[0] += clamped[i] * w; Esky[1] += clamped[i + 1] * w; Esky[2] += clamped[i + 2] * w; }
  }
  const sinSun = Math.max(0.05, dir.y), albedo = [0.34, 0.29, 0.22];
  const Lg = [0, 1, 2].map((c) => albedo[c] / Math.PI * (E[c] * sinSun + Esky[c]));
  const envData = new Float32Array(clamped);
  if (!legacyGround) for (let y = yHor; y < H; y++) {
    const el = -((y + 0.5) / H - 0.5) * 180, w = Math.min(1, Math.max(0, -el / 4)), k = w * w * (3 - 2 * w);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) envData[i + c] = envData[i + c] * (1 - k) + Lg[c] * k;
    }
  }
  const envSrc = new THREE.DataTexture(envData, W, H, THREE.RGBAFormat, THREE.FloatType);
  envSrc.mapping = THREE.EquirectangularReflectionMapping;
  envSrc.colorSpace = THREE.LinearSRGBColorSpace;
  envSrc.flipY = true; envSrc.magFilter = THREE.LinearFilter; envSrc.minFilter = THREE.LinearFilter;
  envSrc.generateMipmaps = false; envSrc.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromEquirectangular(envSrc);
  pmrem.dispose(); envSrc.dispose();

  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;

  // 4) fog lookup: 128 x 64 box-filtered, then 2 blur passes (half float, linear filtering is core in WebGL2)
  const FW = 128, FH = 64, bx = W / FW, by = H / FH;
  let fog = new Float32Array(FW * FH * 4);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y * by; yy < (y + 1) * by; yy += 2) for (let xx = x * bx; xx < (x + 1) * bx; xx += 2) {
      const i = (yy * W + xx) * 4; r += clamped[i]; g += clamped[i + 1]; b += clamped[i + 2]; n++;
    }
    const o = (y * FW + x) * 4; fog[o] = r / n; fog[o + 1] = g / n; fog[o + 2] = b / n; fog[o + 3] = 1;
  }
  for (let pass = 0; pass < 2; pass++) {
    const src = fog, dst = new Float32Array(src.length);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
          const yy = Math.min(FH - 1, Math.max(0, y + dy)), xx = (x + dx + FW) % FW;
          s += src[(yy * FW + xx) * 4 + c]; n++;
        }
        dst[(y * FW + x) * 4 + c] = s / n;
      }
      dst[(y * FW + x) * 4 + 3] = 1;
    }
    fog = dst;
  }
  const half = new Uint16Array(fog.length);
  for (let i = 0; i < fog.length; i++) half[i] = THREE.DataUtils.toHalfFloat(fog[i]);
  const fogTex = new THREE.DataTexture(half, FW, FH, THREE.RGBAFormat, THREE.HalfFloatType);
  fogTex.flipY = true; fogTex.magFilter = fogTex.minFilter = THREE.LinearFilter;
  fogTex.wrapS = THREE.RepeatWrapping; fogTex.wrapT = THREE.ClampToEdgeWrapping; fogTex.needsUpdate = true;

  // horizon colour (elevation 0..3 deg) and sky irradiance on a horizontal plane, for reports / hemisphere fallbacks
  const hor = [0, 0, 0]; let hn = 0;
  for (let y = Math.floor(H / 2 - (3 / 180) * H); y < H / 2; y++) for (let x = 0; x < W; x += 4) {
    const i = (y * W + x) * 4; hor[0] += clamped[i]; hor[1] += clamped[i + 1]; hor[2] += clamped[i + 2]; hn++;
  }
  const Emax = Math.max(E[0], E[1], E[2]) || 1;
  const sun = {
    dir, elevationDeg: Math.asin(dir.y) / RAD, azimuthDeg: Math.atan2(dir.z, dir.x) / RAD,
    color: new THREE.Color(E[0] / Emax, E[1] / Emax, E[2] / Emax), intensity: Emax, irradianceRGB: E,
  };
  const stats = { groundRadiance: Lg.map((v) => +v.toFixed(3)), skyIrradiance: Esky.map((v) => +v.toFixed(2)), sunIrradiance: E.map((v) => +v.toFixed(2)), hdriBelowHorizon: below.sum.map((v) => +(v / below.n).toFixed(3)) };
  return { background: tex, envMap: envRT.texture, sun, fogTex, horizon: new THREE.Color(hor[0] / hn, hor[1] / hn, hor[2] / hn), threshold: T, shiftColumns: shift, stats };
}

// ---------------------------------------------------------------------------------------------------------------
// Aerial perspective: exponential height fog whose colour is the blurred sky in the view direction.
// Shared uniforms: update FOG.uniforms.* once and every patched material follows.
export const FOG = {
  uniforms: {
    uFogSky: { value: null },
    uFogP: { value: new THREE.Vector4(0.0016, 0.012, 0.0, 1.0) },     // density at h0 (1/m), height falloff (1/m), h0, max opacity
    uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uFogSunCol: { value: new THREE.Color(0, 0, 0) },                    // in-scatter glow toward the sun (HDR units)
    uFogTint: { value: new THREE.Color(1, 1, 1) },
  },
};

const FOG_PARS = /* glsl */`
uniform sampler2D uFogSky; uniform vec4 uFogP; uniform vec3 uFogSunDir; uniform vec3 uFogSunCol; uniform vec3 uFogTint;
varying vec3 vFogWorld;
vec3 aerialFogColor(vec3 d) {
  d.y = max(d.y, 0.015); d = normalize(d);
  vec2 uv = vec2(atan(d.z, d.x) * RECIPROCAL_PI2 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * RECIPROCAL_PI + 0.5);
  return texture2D(uFogSky, uv).rgb * uFogTint + uFogSunCol * pow(max(dot(d, uFogSunDir), 0.0), 10.0);
}
vec4 aerialFog(vec3 worldPos) {
  vec3 V = worldPos - cameraPosition; float dist = length(V); vec3 dir = V / max(dist, 1e-4);
  float k = uFogP.y, hc = cameraPosition.y - uFogP.z, dy = V.y;
  float kd = k * dy;
  float integ = abs(kd) > 1e-4 ? (1.0 - exp(-kd)) / kd : 1.0;
  float od = uFogP.x * exp(-k * hc) * dist * integ;
  float f = (1.0 - exp(-od)) * uFogP.w;
  return vec4(aerialFogColor(dir), clamp(f, 0.0, 1.0));
}`;

// Patch any built-in material (Standard/Physical/Lambert/Basic). Fog is applied in linear HDR *before*
// tone mapping (r158 applies its own fog after tone mapping, which breaks HDR fog colours).
export function addAerialFog(material, { densityMul = 1 } = {}) {
  if (!material || material.userData.__aerialFog) return material;   // idempotent: shared materials are patched once
  material.userData.__aerialFog = true;
  const prev = material.onBeforeCompile;
  // densityMul < 1: far landmarks (the distant islands) keep a silhouette through the haze
  const pars = densityMul === 1 ? FOG_PARS : FOG_PARS.replace('float od = uFogP.x *', `float od = uFogP.x * ${densityMul.toFixed(3)} *`);
  if (densityMul !== 1) material.customProgramCacheKey = () => 'aerialFogMul' + densityMul.toFixed(3);
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, FOG.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFogWorld;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
  { vec4 fw = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      fw = instanceMatrix * fw;
    #endif
    vFogWorld = (modelMatrix * fw).xyz; }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <fog_pars_fragment>', pars)
      .replace('#include <tonemapping_fragment>', `{ vec4 af = aerialFog(vFogWorld); gl_FragColor.rgb = mix(gl_FragColor.rgb, af.rgb, af.a); }
#include <tonemapping_fragment>`)
      .replace('#include <fog_fragment>', '');
  };
  material.fog = true; // keeps the fog chunks in the shader
  material.needsUpdate = true;
  return material;
}

export function aerialFogGLSL() { return FOG_PARS; }

// ---------------------------------------------------------------------------------------------------------------
// Character fill: a soft light from just above the camera, on people and the giant only (a bounce card, as in film).
// Faces turned away from the sun keep their form instead of turning into silhouettes against the bright beach.
export const CHAR_FILL = { uCharFill: { value: new THREE.Color(0, 0, 0) } };
// Sand and dust settled on the tops of rocks and cliffs: up-facing faces (flat normal from the world-position
// derivatives of the fog varying) take a dry sand colour with a little mottling. From the follow camera the east-coast
// cliff tops were flat, near-black polygons (the scan's stretched texels up there; critic round 3, defect 10).
export function addTopCoat(material, { color = [0.36, 0.29, 0.2], lo = 0.6, hi = 0.86, k = 0.82 } = {}) {
  if (!material || material.userData.__topCoat || !material.userData.__aerialFog) return material;
  material.userData.__topCoat = true;
  const prev = material.onBeforeCompile, k0 = material.customProgramCacheKey();
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(material, sh, r);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
float topCoat = 0.0;
{ vec3 tn = normalize(cross(dFdx(vFogWorld), dFdy(vFogWorld)));
  vec2 hp = floor(vFogWorld.xz * 1.7); float h = fract(sin(dot(hp, vec2(12.9898, 78.233))) * 43758.5453);
  topCoat = smoothstep(${lo.toFixed(2)}, ${hi.toFixed(2)}, abs(tn.y)) * (${k.toFixed(2)} - 0.25 * h);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${color.map((c) => c.toFixed(3)).join(', ')}) * (0.9 + 0.2 * h), topCoat); }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.95, topCoat);');
  };
  material.customProgramCacheKey = () => k0 + '|topCoat';
  material.needsUpdate = true;
  return material;
}
export function addCharacterFill(material) {
  if (!material || material.userData.__charFill) return material;
  material.userData.__charFill = true;
  const prev = material.onBeforeCompile, k0 = material.customProgramCacheKey();
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(material, sh, r);
    Object.assign(sh.uniforms, CHAR_FILL);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uCharFill;')
      .replace('#include <aomap_fragment>', `{
  vec3 fd = normalize(vec3(0.2, 0.5, 1.0));                         // view space: from above the lens
  float nd = max(dot(normal, fd), 0.0) * 0.7 + 0.3;
  reflectedLight.indirectDiffuse += uCharFill * nd * BRDF_Lambert(material.diffuseColor);
  reflectedLight.indirectSpecular += uCharFill * nd * 0.18 * material.specularColor;
}
#include <aomap_fragment>`);
  };
  material.customProgramCacheKey = () => k0 + '|charFill';
  material.needsUpdate = true;
  return material;
}

// Applies a loaded sky to the scene + a DirectionalLight. exposureComp lets dusk skies sit at the same mid-grey.
export function applySky(scene, sun, sky, { envIntensity = 1.0, sunScale = 1.0, fogSunGlow = 0.12 } = {}) {
  scene.background = sky.background;
  scene.environment = sky.envMap;
  scene.backgroundIntensity = 1.0;
  sun.color.copy(sky.sun.color);
  sun.intensity = sky.sun.intensity * sunScale;
  FOG.uniforms.uFogSky.value = sky.fogTex;
  FOG.uniforms.uFogSunDir.value.copy(sky.sun.dir);
  FOG.uniforms.uFogSunCol.value.copy(sky.sun.color).multiplyScalar(sky.sun.intensity * fogSunGlow);
  scene.traverse((o) => {
    if (o.material && 'envMapIntensity' in o.material) o.material.envMapIntensity = envIntensity;
  });
}
