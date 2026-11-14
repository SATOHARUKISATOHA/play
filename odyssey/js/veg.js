// Instanced vegetation with wind. Grass clumps are built here from the dry-grass atlas (Foliage002, 4 stems side by
// side); trees/bushes come from GLBs (trunk mesh + alpha-tested leaf-card mesh) and are instanced per sub-mesh.
import * as THREE from 'three';
import { addAerialFog, DITHER } from './env.js';

export const WIND = { uTime: { value: 0 }, uWind: { value: 1.0 }, uWindDir: { value: new THREE.Vector2(0.8, 0.6) } };

// Wind: sway grows with height above the instance origin (h0..h1 metres); phase from instance position.
// Alpha-tested cards lose coverage in lower mips (trees turn into bare branches at distance). Scale alpha by the
// mip level the GPU is sampling so the cut-out keeps its area (B. Golus, "Anti-aliased Alpha Test", 2017).
export function keepAlphaCoverage(material, texSize = 512, k = 0.25) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', `
#ifdef USE_MAP
  { vec2 tuv = vMapUv * ${texSize.toFixed(1)}; vec2 dx = dFdx(tuv), dy = dFdy(tuv);
    float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
    diffuseColor.a *= 1.0 + mip * ${k.toFixed(3)}; }
#endif
#include <alphatest_fragment>`);
  };
  material.needsUpdate = true;
  return material;
}

export function addWind(material, { h0 = 0, h1 = 1, amp = 0.15, freq = 1.7, flutter = 0.0, upNormals = 0.0 } = {}) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, WIND);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime, uWind; uniform vec2 uWindDir;`);
    // foliage cards: keep the (bent-up) normal on both faces instead of flipping it for back faces
    if (upNormals > 0) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace(/float faceDirection = gl_FrontFacing \? 1\.0 : - 1\.0;/, 'float faceDirection = 1.0;'));
    sh.vertexShader = sh.vertexShader
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), ${upNormals.toFixed(3)}));`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 ip = vec3(0.0);
  #ifdef USE_INSTANCING
    ip = instanceMatrix[3].xyz;
  #endif
  vec3 wp0 = (modelMatrix * vec4(ip, 1.0)).xyz;
  float k = clamp((position.y - ${h0.toFixed(3)}) / ${(h1 - h0).toFixed(3)}, 0.0, 1.0); k *= k;
  float ph = dot(wp0.xz, vec2(0.11, 0.17)) + uTime * ${freq.toFixed(3)};
  float gust = 0.65 + 0.35 * sin(uTime * 0.37 + wp0.x * 0.02);
  float s = (sin(ph) * 0.7 + sin(ph * 2.31 + 1.3) * 0.3) * gust * uWind;
  transformed.xz += uWindDir * s * ${amp.toFixed(3)} * k;
  ${flutter > 0 ? `transformed += normal * sin(uTime * 7.3 + dot(position, vec3(9.1, 7.7, 5.3))) * ${flutter.toFixed(4)} * k * uWind;` : ''}
}`);
  };
  material.needsUpdate = true;
  return material;
}

// Thin blades and leaves let sunlight through. Without it every grass card turned away from the sun (half of them)
// and every backlit bush was drawn near-black (round-1 re-test: the dark spiky tufts and the black mastic bushes were
// most of the remaining crushed pixels against the sun). The sun's light on the far side of a card is added to its
// diffuse at `t` strength (shadowed light stays dark: the shadow factor is already in directLight.color).
export function addTranslucency(material, t = 0.5, wrap = 0.0) {
  const prev = material.onBeforeCompile, k0 = material.customProgramCacheKey();
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    // (wrap: cards whose bent-up normal is side-on to a low sun got neither front nor back light and drew black)
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_pars_fragment>',
      THREE.ShaderChunk.lights_physical_pars_fragment.replace(
        'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
        `{ float ndl = dot( geometryNormal, directLight.direction );
  float dif = saturate( ( ndl + ${wrap.toFixed(3)} ) / ${(1 + wrap).toFixed(3)} ) + ${t.toFixed(3)} * saturate( - ndl );
  reflectedLight.directDiffuse += dif * directLight.color * BRDF_Lambert( material.diffuseColor ); }`));
  };
  material.customProgramCacheKey = () => k0 + '|trans' + t.toFixed(3) + ',' + wrap.toFixed(3);
  material.needsUpdate = true;
  return material;
}

// See-through foliage. In the olive grove the follow camera sat inside a canopy and 30 cm leaf cards filled the
// screen (round-1 re-test, shots/15-crowd-30.jpg). Leaf fragments close to the lens, or close to the line from the
// lens to the hero, dissolve with an ordered 4x4 dither (the same pattern the soldiers use), so the player keeps
// sight of the fight. Shadows are untouched (the shadow pass uses three's own depth material).
export const SEE = { uSeeCam: { value: new THREE.Vector3(0, -1e4, 0) }, uSeeFocus: { value: new THREE.Vector3(0, -1e4, 0) }, uSeeLine: { value: 0 } };
// Felled trees as zones (base -> tip, up to 8): their trunk and branch meshes open around the line to the hero too.
// Under a felled olive the hero was hidden by its bare branches once the leaves were opened (fix round 3, own test).
export const FELL = { uFellA: { value: Array.from({ length: 8 }, () => new THREE.Vector3(0, -1e4, 0)) }, uFellB: { value: Array.from({ length: 8 }, () => new THREE.Vector3(0, -1e4, 0)) }, uFellN: { value: 0 } };
export function setFelledZones(list) {
  const n = Math.min(8, list.length); FELL.uFellN.value = n;
  for (let i = 0; i < n; i++) { const z = list[list.length - n + i]; FELL.uFellA.value[i].copy(z.a); FELL.uFellB.value[i].copy(z.b); }
}
// fell: the material's instances carry an `aFell` attribute (1 = a tree the giant pushed over). A felled crown lies on
// the ground, 4-5 m across, right where the fight is; the standing-tree rules (a 0.75-1.5 m tube, only with the lens
// within 9-13 m, never the last 18 % next to the hero) left it covering him for many frames of the giant fight
// (critic round 3, defect 6). Felled crowns open a 1.6-3.2 m tube along the whole line to his chest, at any distance.
export function addSeeThrough(material, { near0 = 1.1, near1 = 2.8, r0 = 0.75, r1 = 1.5, fell = false, toHero = false, fellZones = false, fellOnly = false } = {}) {
  const prev = material.onBeforeCompile, k0 = material.customProgramCacheKey();
  material.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    Object.assign(sh.uniforms, SEE, DITHER, fellZones ? FELL : {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeeW;' + (fell ? '\nattribute float aFell; varying float vFell;' : ''))
      .replace('#include <project_vertex>', `#include <project_vertex>
{ vec4 sw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    sw = instanceMatrix * sw;
  #endif
  vSeeW = (modelMatrix * sw).xyz; }` + (fell ? '\nvFell = aFell;' : ''));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeeW; uniform vec3 uSeeCam, uSeeFocus; uniform float uSeeLine; uniform vec2 uDitherOff;' + (fell ? '\nvarying float vFell;' : '') + (fellZones ? '\nuniform vec3 uFellA[8]; uniform vec3 uFellB[8]; uniform int uFellN;' : ''))
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
{ vec3 ab = uSeeFocus - uSeeCam; float t = clamp(dot(vSeeW - uSeeCam, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  float dSeg = length(vSeeW - (uSeeCam + ab * t));
  float hide = 1.0 - smoothstep(${near0.toFixed(2)}, ${near1.toFixed(2)}, length(vSeeW - uSeeCam));
  ${fellOnly ? '' : `hide = max(hide, uSeeLine * (1.0 - smoothstep(${r0.toFixed(2)}, ${r1.toFixed(2)}, dSeg))${toHero ? '' : ' * (1.0 - smoothstep(0.82, 0.95, t))'});`}
  ${fell ? 'hide = max(hide, vFell * (1.0 - smoothstep(1.6, 3.2, dSeg)));' : ''}
  ${fellZones ? `{ float fz = 0.0; for (int i = 0; i < 8; i++) { if (i >= uFellN) break; vec3 fa = uFellA[i], fb = uFellB[i] - uFellA[i]; float fh = clamp(dot(vSeeW - fa, fb) / max(dot(fb, fb), 1e-4), 0.0, 1.0); if (length(vSeeW - fa - fb * fh) < 3.2) fz = 1.0; }
    hide = max(hide, fz * (1.0 - smoothstep(1.6, 3.2, dSeg))); }` : ''}
  if (hide > 0.0) { ivec2 q = ivec2(mod(gl_FragCoord.xy + uDitherOff, 4.0)); const float B4[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
    if ((B4[q.x + q.y * 4] + 0.5) / 16.0 < hide) discard; } }`);
  };
  material.customProgramCacheKey = () => k0 + '|see2' + (fell ? 'f' : '') + (toHero ? 'h' : '') + (fellZones ? 'z' : '') + (fellOnly ? 'o' : '');
  material.needsUpdate = true;
  return material;
}
// per frame: the lens, and the hero's chest (the line test only while the camera follows him closely)
export function updateSeeThrough(camPos, focus) {
  SEE.uSeeCam.value.copy(camPos);
  if (!focus) { SEE.uSeeLine.value = 0; return; }
  SEE.uSeeFocus.value.set(focus.x, focus.y + 1.25, focus.z);
  const d = camPos.distanceTo(SEE.uSeeFocus.value);
  SEE.uSeeLine.value = 1 - Math.min(1, Math.max(0, (d - 9) / 4));
}

// One clump: n crossed quads, each mapped to one of the atlas' 4 stem strips.
export function grassClumpGeometry({ n = 5, w = 0.42, h = 0.75, strips = 4, seed = 3 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pos = [], uv = [], nor = [], idx = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI + rnd() * 0.4;
    const ca = Math.cos(a), sa = Math.sin(a);
    const lean = (rnd() - 0.5) * 0.25, ox = (rnd() - 0.5) * 0.18, oz = (rnd() - 0.5) * 0.18;
    const hh = h * (0.75 + rnd() * 0.5), k = i % strips, u0 = k / strips + 0.01, u1 = (k + 1) / strips - 0.01;
    const b = pos.length / 3;
    const pts = [[-w / 2, 0], [w / 2, 0], [w / 2 + lean, hh], [-w / 2 + lean, hh]];
    pts.forEach(([x, y], j) => {
      pos.push(ox + x * ca, y, oz + x * sa);
      uv.push(j === 0 || j === 3 ? u0 : u1, j < 2 ? 0.03 : 0.97);
      nor.push(-sa, 0.0, ca);
    });
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Split placements into square cells so every cell is its own InstancedMesh with a real bounding sphere:
// three then frustum-culls cells for the camera *and* for the sun's shadow camera (one big InstancedMesh with
// frustumCulled=false draws every instance twice per frame). maxDist hides far cells (grass is invisible past ~70 m).
export function chunkPlacements(placements, cell = 40) {
  const cells = new Map();
  for (const p of placements) {
    const k = Math.floor(p.x / cell) + ',' + Math.floor(p.z / cell);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(p);
  }
  return [...cells.values()];
}
export function cullByDistance(group, camPos, maxDist) {
  for (const m of group.children) {
    const bs = m.boundingSphere; if (!bs) continue;
    m.visible = Math.hypot(bs.center.x - camPos.x, bs.center.z - camPos.z) < maxDist + bs.radius;
  }
}
function buildInstanced(geo, mat, pl, { castShadow = false } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, pl.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  pl.forEach((o, i) => {
    e.set(0, o.rot || 0, 0); q.setFromEuler(e); sc.setScalar(o.s || 1); p.set(o.x, o.y, o.z);
    mesh.setMatrixAt(i, m.compose(p, q, sc));
    if (o.tint) { c.setRGB(o.tint[0], o.tint[1], o.tint[2]); mesh.setColorAt(i, c); }
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();      // r158: InstancedMesh frustum culling (camera and shadow) uses this sphere
  mesh.frustumCulled = true; mesh.castShadow = castShadow; mesh.receiveShadow = true;
  return mesh;
}
export function makeGrassChunked(atlasTex, placements, opts = {}) {
  const proto = makeGrass(atlasTex, placements.slice(0, 1), opts);
  const group = new THREE.Group();
  for (const pl of chunkPlacements(placements, 44)) group.add(buildInstanced(proto.geometry, proto.material, pl));
  group.userData.material = proto.material;   // (not .material: renderer.compile() treats any .material as drawable)
  return group;
}

export function makeGrass(atlasTex, placements, { tint = 0xffffff, strips = 4, w = 0.42, h = 0.75, n = 5 } = {}) {
  atlasTex.colorSpace = THREE.SRGBColorSpace;
  atlasTex.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({ map: atlasTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.92, color: tint });
  addWind(mat, { h0: 0, h1: h, amp: 0.16, freq: 1.9, upNormals: 0.65 });
  keepAlphaCoverage(mat, atlasTex.image ? atlasTex.image.width : 1024);
  addTranslucency(mat, 0.5, 0.5);
  const geo = grassClumpGeometry({ n, w, h, strips });
  const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  placements.forEach((pl, i) => {
    e.set(0, pl.rot, 0); q.setFromEuler(e); sc.setScalar(pl.s); p.set(pl.x, pl.y, pl.z);
    mesh.setMatrixAt(i, m.compose(p, q, sc));
    c.setRGB(pl.tint[0], pl.tint[1], pl.tint[2]); mesh.setColorAt(i, c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

// Vertex clustering (same cell, same facing octant, same UV patch): a lighter copy of a dense static mesh. The olive
// trunk (3600 triangles, gnarled bark) keeps its silhouette at 9 cm cells with about half the triangles.
export function clusterDecimate(geo, cell, { loose = false } = {}) {
  const P = geo.attributes.position, Nn = geo.attributes.normal, U = geo.attributes.uv, idx = geo.index;
  if (!idx || !Nn) return geo;
  const map = new Map(), remap = new Int32Array(P.count), keep = [];
  for (let i = 0; i < P.count; i++) {
    // loose (far LOD): cells only, normals recomputed afterwards
    const oct = loose ? 0 : (Nn.getX(i) > 0 ? 1 : 0) | (Nn.getY(i) > 0 ? 2 : 0) | (Nn.getZ(i) > 0 ? 4 : 0);
    const uvk = U && !loose ? `${Math.floor(U.getX(i) * 4)}:${Math.floor(U.getY(i) * 4)}` : '';
    const k = `${Math.round(P.getX(i) / cell)}|${Math.round(P.getY(i) / cell)}|${Math.round(P.getZ(i) / cell)}|${oct}|${uvk}`;
    let r = map.get(k); if (r === undefined) { r = keep.length; keep.push(i); map.set(k, r); }
    remap[i] = r;
  }
  const out = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) {
    const arr = new a.array.constructor(keep.length * a.itemSize);
    keep.forEach((src, j) => { for (let c = 0; c < a.itemSize; c++) arr[j * a.itemSize + c] = a.array[src * a.itemSize + c]; });
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  const tri = [];
  for (let i = 0; i < idx.count; i += 3) { const a = remap[idx.getX(i)], b = remap[idx.getX(i + 1)], c = remap[idx.getX(i + 2)]; if (a !== b && b !== c && a !== c) tri.push(a, b, c); }
  out.setIndex(tri); if (loose) out.computeVertexNormals(); out.computeBoundingSphere();
  return out;
}
// Far LOD by distance: meshes registered here swap to a loose-clustered copy of their geometry beyond `far` metres
// (olive trunks, scanned rocks: a third of the triangles of the inland view were these, mostly 60-200 m away)
const lodCache = new Map();
export function farGeometry(geo, cell) {
  let g = lodCache.get(geo); if (!g) { g = clusterDecimate(geo, cell, { loose: true }); lodCache.set(geo, g); }
  return g;
}
export function updateLOD(list, camPos, far = 60) {
  for (const L of list) {
    const bs = L.mesh.boundingSphere || L.mesh.geometry.boundingSphere; if (!bs) continue;
    let c = bs.center; if (!L.mesh.isInstancedMesh) c = L.wc || (L.wc = bs.center.clone().applyMatrix4(L.mesh.matrixWorld));
    const d = Math.hypot(c.x - camPos.x, c.z - camPos.z) - (L.mesh.isInstancedMesh ? bs.radius * 0.3 : bs.radius);
    const g = d > far ? L.far : L.full; if (L.mesh.geometry !== g) L.mesh.geometry = g;
  }
}

// Instance every mesh of a loaded GLB scene at the given placements (one InstancedMesh per sub-mesh = 1 draw call each).
export function instanceGLB(root, placements, { windLeaves = true, castShadow = true, leafWind = {}, trunkWind = null, decimate = null, fellable = false } = {}) {
  const group = new THREE.Group();
  const meshes = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  for (const src of meshes) {
    let geo = src.geometry.clone().applyMatrix4(src.matrixWorld);
    if (decimate && decimate.test(src.name)) geo = clusterDecimate(geo, decimate.cell);
    const mat = src.material.clone();
    // Material.clone() drops onBeforeCompile but keeps userData, so the clone of a fogged GLB material had no aerial
    // fog and refused a second patch: every instanced tree and bush stood out of the haze (dark, crisp) at 100 m
    if (mat.userData.__aerialFog) { delete mat.userData.__aerialFog; addAerialFog(mat); }
    const isLeaf = mat.alphaTest > 0 || mat.transparent || /leaf|leaves|foliage|canopy|needle/i.test(src.name + mat.name);
    if (isLeaf) {
      mat.alphaTest = Math.max(mat.alphaTest, 0.5); mat.transparent = false; mat.side = THREE.DoubleSide;
      if (windLeaves) addWind(mat, { h0: 0.5, h1: 6, amp: 0.12, freq: 1.3, flutter: 0.02, upNormals: 0.0, ...leafWind });
      keepAlphaCoverage(mat, mat.map && mat.map.image ? mat.map.image.width : 512);
      addTranslucency(mat, 0.4, 0.25);
      addSeeThrough(mat, { fell: true });
    } else {
      if (trunkWind) addWind(mat, trunkWind);
      // a felled tree's trunk and branches open around the hero too, and any branch right at the lens dissolves (the
      // camera lifted into a canopy looked down through a cage of bare grey branches)
      if (fellable) addSeeThrough(mat, { fellZones: true, fellOnly: true, near0: 0.9, near1: 2.2 });
    }
    for (const pl of chunkPlacements(placements, 48)) {
      // leaves: each chunk gets its own view of the geometry (same buffers) with a per-instance `aFell` flag
      let g = geo, fell = null;
      if (isLeaf) {
        g = new THREE.BufferGeometry();
        for (const [n, a] of Object.entries(geo.attributes)) g.setAttribute(n, a);
        g.setIndex(geo.index); for (const gr of geo.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
        fell = new THREE.InstancedBufferAttribute(new Float32Array(pl.length), 1); g.setAttribute('aFell', fell);
      }
      const im = buildInstanced(g, mat, pl, { castShadow });
      im.name = src.name;
      // each placement keeps its instance slots (trunk + leaves), so one tree can be moved later (felled by the giant)
      pl.forEach((p, i) => { (p.inst || (p.inst = [])).push({ m: im, i, fell }); });
      group.add(im);
    }
  }
  return group;
}
