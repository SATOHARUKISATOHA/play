// PBR terrain splat for the v1 heightfield (aBiome = sand, grass, stone, path weights per vertex).
// Layers: sand, grass (dry), earth (paths / dry patches), rock (triplanar on steep faces).
// Each layer = diff (sRGB) + nor (OpenGL) + arh (R=AO, G=roughness, B=height). Height-blended, anti-tiled,
// wet sand toward the waterline. 4 layers x 3 maps = 12 samplers + env + shadow = 14 (WebGL2 guarantees 16).
import * as THREE from 'three';

const LAYERS = ['sand', 'grass', 'earth', 'rock'];

export async function loadTerrainTextures(base, anisotropy = 8) {
  const L = new THREE.TextureLoader();
  const out = {};
  await Promise.all(LAYERS.map(async (n) => {
    const [d, nr, a] = await Promise.all(['diff', 'nor', 'arh'].map((k) => L.loadAsync(`${base}/${n}/${n}_${k}.jpg`)));
    for (const t of [d, nr, a]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = anisotropy; }
    d.colorSpace = THREE.SRGBColorSpace;
    out[n] = { d, n: nr, a };
  }));
  return out;
}

// tiles: metres per texture repeat (from materials.json: sand 30 (macro ripples), grass 2.51, earth 4, rock 5.75)
export function makeTerrainMaterial(tex, { tiles = { sand: 9.0, grass: 3.2, earth: 4.0, rock: 6.0 }, triplanar = true, waterLevel = 0.0 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.userData.uniforms = {
    uTime: { value: 0 }, uWater: { value: waterLevel },
  };
  mat.onBeforeCompile = (sh) => {
    for (const n of LAYERS) {
      sh.uniforms[`t_${n}_d`] = { value: tex[n].d };
      sh.uniforms[`t_${n}_n`] = { value: tex[n].n };
      sh.uniforms[`t_${n}_a`] = { value: tex[n].a };
      sh.uniforms[`s_${n}`] = { value: 1 / tiles[n] };
    }
    Object.assign(sh.uniforms, mat.userData.uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aBiome;
varying vec4 vBiome; varying vec3 vWPos; varying vec3 vWNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vBiome = aBiome; vWPos = (modelMatrix * vec4(position, 1.0)).xyz; vWNormal = normalize(mat3(modelMatrix) * normal);`);
    const decl = LAYERS.map((n) => `uniform sampler2D t_${n}_d, t_${n}_n, t_${n}_a; uniform float s_${n};`).join('\n');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${decl}
uniform float uTime, uWater;
varying vec4 vBiome; varying vec3 vWPos; varying vec3 vWNormal;
float th21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float tvn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(th21(i),th21(i+vec2(1,0)),u.x), mix(th21(i+vec2(0,1)),th21(i+vec2(1,1)),u.x), u.y); }
// anti-tiling: blend two differently rotated/offset lookups by a low-frequency noise
vec2 rot2(vec2 p, float a){ float c=cos(a), s=sin(a); return vec2(c*p.x - s*p.y, s*p.x + c*p.y); }
struct Lyr { vec3 c; vec3 n; vec3 arh; };
// cotangent frame from screen-space derivatives of the planar world-XZ UV (same maths as three's getTangentFrame)
mat3 tangentFrameXZ(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos), q1 = dFdy(eye_pos); vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 N = normalize(surf_norm); vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x, B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B)); float sc = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * sc, B * sc, N);
}
Lyr sampleL(sampler2D d, sampler2D nm, sampler2D a, vec2 uv, float mixk) {
  vec2 uv2 = rot2(uv, 1.7) + vec2(0.37, 0.61);
  Lyr A; A.c = texture2D(d, uv).rgb; A.n = texture2D(nm, uv).xyz * 2.0 - 1.0; A.arh = texture2D(a, uv).rgb;
  if (mixk > 0.01) {
    vec3 c2 = texture2D(d, uv2).rgb; vec3 n2 = texture2D(nm, uv2).xyz * 2.0 - 1.0; vec3 a2 = texture2D(a, uv2).rgb;
    n2.xy = rot2(n2.xy, 1.7);
    A.c = mix(A.c, c2, mixk); A.n = normalize(mix(A.n, n2, mixk)); A.arh = mix(A.arh, a2, mixk);
  }
  return A;
}
// one triplanar axis, anti-tiled: a second sampling (0.61x, turned 1.9 rad) shows through a 15-20 m noise mask, so a
// long cliff no longer repeats the same 6 m tile side by side (critic round 2, defect 13)
vec3 rkC(vec2 u, vec2 v, float k) { return mix(texture2D(t_rock_d, u).rgb, texture2D(t_rock_d, v).rgb, k); }
vec3 rkA(vec2 u, vec2 v, float k) { return mix(texture2D(t_rock_a, u).rgb, texture2D(t_rock_a, v).rgb, k); }
vec3 rkN(vec2 u, vec2 v, float k) { vec3 n1 = texture2D(t_rock_n, u).xyz * 2.0 - 1.0, n2 = texture2D(t_rock_n, v).xyz * 2.0 - 1.0; n2.xy = rot2(n2.xy, -1.9); return normalize(mix(n1, n2, k)); }
Lyr triRock(vec3 p, vec3 wn) {
  vec3 b = pow(abs(wn), vec3(4.0)); b /= (b.x + b.y + b.z);
  vec2 ux = p.zy * s_rock, uy = p.xz * s_rock, uz = p.xy * s_rock;
  vec2 vx = rot2(ux * 0.61, 1.9) + vec2(0.31, 0.77), vy = rot2(uy * 0.61, 1.9) + vec2(0.53, 0.19), vz = rot2(uz * 0.61, 1.9) + vec2(0.71, 0.43);
  float k = smoothstep(0.32, 0.68, tvn(p.xz * 0.055 + vec2(p.y * 0.04, 2.7)));
  Lyr R;
  R.c = rkC(ux, vx, k) * b.x + rkC(uy, vy, k) * b.y + rkC(uz, vz, k) * b.z;
  R.c *= 0.9 + 0.2 * tvn(p.xz * 0.11 + p.y * 0.07);
  R.arh = rkA(ux, vx, k) * b.x + rkA(uy, vy, k) * b.y + rkA(uz, vz, k) * b.z;
  // whiteout-style triplanar normals, result in WORLD space (flag: n.z = 99 marks world-space)
  vec3 nx = rkN(ux, vx, k), ny = rkN(uy, vy, k), nz = rkN(uz, vz, k);
  vec3 wx = vec3(0.0, nx.y, nx.x) + vec3(wn.x, 0.0, 0.0);
  vec3 wy = vec3(ny.x, 0.0, ny.y) + vec3(0.0, wn.y, 0.0);
  vec3 wz = vec3(nz.x, nz.y, 0.0) + vec3(0.0, 0.0, wn.z);
  R.n = normalize(wx * b.x + wy * b.y + wz * b.z);
  return R;
}
`)
      .replace('#include <map_fragment>', `
vec2 wp = vWPos.xz;
float macro = tvn(wp * 0.021) * 0.65 + tvn(wp * 0.083) * 0.35;
float anti = smoothstep(0.35, 0.65, tvn(wp * 0.05 + 3.1));
// layer weights from the baked biome + noise breakup
vec4 w = vec4(vBiome.r, vBiome.g, 0.0, vBiome.b);              // sand, grass, earth, rock
float dry = smoothstep(0.52, 0.78, macro);                     // dry earth patches inside grass
w.z = w.y * dry * 0.8 + vBiome.a * 0.9;                        // paths are earth
w.y *= 1.0 - dry * 0.8;
w.x *= 1.0 - vBiome.a * 0.6;
float slope = 1.0 - clamp(vWNormal.y, 0.0, 1.0);
w.w = max(w.w, smoothstep(0.30, 0.55, slope));                 // steep = rock regardless of biome
Lyr Ls = sampleL(t_sand_d, t_sand_n, t_sand_a, wp * s_sand, anti);
Lyr Lg = Ls; Lyr Le = Ls; Lyr Lr = Ls;
if (w.y > 0.002) Lg = sampleL(t_grass_d, t_grass_n, t_grass_a, wp * s_grass, anti);
if (w.z > 0.002) Le = sampleL(t_earth_d, t_earth_n, t_earth_a, wp * s_earth, anti);
${triplanar ? `if (w.w > 0.002) Lr = triRock(vWPos, normalize(vWNormal)); else Lr.n = vec3(0.0, 0.0, 1.0);` :
    `if (w.w > 0.002) Lr = sampleL(t_rock_d, t_rock_n, t_rock_a, wp * s_rock, 0.0);`}
// height blend: the layer whose height map pokes through wins the transition
vec4 hgt = vec4(Ls.arh.b, Lg.arh.b, Le.arh.b, Lr.arh.b);
vec4 hw = w * (hgt + 0.25);
float hmax = max(max(hw.x, hw.y), max(hw.z, hw.w));
vec4 bw = max(hw - (hmax - 0.18), 0.0);
bw /= (bw.x + bw.y + bw.z + bw.w + 1e-5);
vec3 albedo = Ls.c * bw.x + Lg.c * bw.y + Le.c * bw.z + Lr.c * bw.w;
vec3 arh = Ls.arh * bw.x + Lg.arh * bw.y + Le.arh * bw.z + Lr.arh * bw.w;
// macro colour variation so 300 m of ground never reads as one tile
albedo *= 0.88 + 0.24 * macro;
// wet sand toward the waterline (darker, glossier)
float wet = 1.0 - smoothstep(uWater + 0.08, uWater + 0.9, vWPos.y);
albedo = mix(albedo, albedo * vec3(0.58, 0.56, 0.52), wet * (bw.x + bw.z) * 0.9);
diffuseColor.rgb *= albedo;
float tAO = arh.r;
float tWet = wet * (bw.x + bw.z);
vec3 tanN = normalize(Ls.n * bw.x + Lg.n * bw.y + Le.n * bw.z + (${triplanar ? 'vec3(0.0,0.0,1.0)' : 'Lr.n'}) * bw.w);
`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(arh.g, 0.28, tWet * 0.85);`)
      .replace('#include <normal_fragment_maps>', `
{
  // tangent frame from world XZ (the splat UV) -> view space
  mat3 tbnXZ = tangentFrameXZ( - vViewPosition, normal, wp );
  vec3 nView = normalize( tbnXZ * tanN );
  ${triplanar ? `if (bw.w > 0.002) { vec3 rn = normalize((viewMatrix * vec4(Lr.n, 0.0)).xyz); nView = normalize(mix(nView, rn, bw.w)); }` : ''}
  normal = nView;
}
`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
reflectedLight.indirectDiffuse *= mix(1.0, tAO, 0.85);
reflectedLight.indirectSpecular *= mix(1.0, tAO, 0.85);`);
  };
  return mat;
}
