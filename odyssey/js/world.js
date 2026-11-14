// The island from the scouted assets: HDRI sky + matched sun + aerial fog, PBR terrain, sea, Doric temple ruin,
// beach camp, sheep pen, cave mouth, scanned rocks, instanced olive / cypress / mastic and grass with wind,
// beached hero ship + enemy galleys, gulls, sheep and a sea serpent offshore. Also registers the colliders.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildTerrain, heightTexture, POI, groundHeight, HALF, surfaceAt, pathWeight, carveTerrain, shoreDist, addStoneRect } from './terrain.js';
import { addCircle, addBox, addPlatform, addRockHeights, addPropHeights, setPropsOn, initPropGrid } from './collide.js';
import { mulberry32, clamp, lerp, smoothstep, fbm } from './util.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadSky, applySky, addAerialFog, addTopCoat, FOG } from './env.js';
import { loadTerrainTextures, makeTerrainMaterial } from './terrainMat.js';
import { makeSea, seaHeight } from './water.js';
import { makeGrassChunked, cullByDistance, instanceGLB, WIND, farGeometry, updateLOD, updateSeeThrough, addTranslucency, addSeeThrough, setFelledZones } from './veg.js';
import { buildFleet } from './ships.js';

export const SKIES = {
  // env: image-based light (sky + the sunlit ground below the horizon) x2: the HDRI's sky is only ~6 % of the sun on
  // the ground, so shadows and faces turned from the sun crushed to black (critic round 1, defect 9; measured in
  // fix round 1: backlit views 10 % -> under 1 % crushed pixels). fill: the soft lens-side light on characters.
  day: { file: 'day_rustig_koppie_puresky_2k.hdr', exposure: 0.34, az: 140, fog: [0.0016, 0.012], fire: 25, env: 2.0, fill: 0.05 },
  dusk: { file: 'dusk_qwantani_sunset_puresky_2k.hdr', exposure: 0.5, az: 140, fog: [0.0015, 0.010], fire: 70, glow: 0.05, env: 2.0, fill: 0.06 },
};

// local (model space x,z) -> world, for an object at (ox, oz) rotated by ry about +Y
const toWorld = (ox, oz, ry, lx, lz) => ({ x: ox + lx * Math.cos(ry) + lz * Math.sin(ry), z: oz - lx * Math.sin(ry) + lz * Math.cos(ry) });

export async function buildWorld(scene, renderer, A, { tod = 'day', grassN = 22000, progress = () => {}, legacyGround = false } = {}) {
  const sk = SKIES[tod] || SKIES.day;
  const W = './assets/world';
  // ---------------------------------------------------------------- sky, light, fog
  const sky = await loadSky(renderer, `${W}/hdri/${sk.file}`, { sunAzimuthDeg: sk.az, legacyGround });
  progress('sky');
  renderer.toneMappingExposure = sk.exposure;
  FOG.uniforms.uFogP.value.set(sk.fog[0], sk.fog[1], 0, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.035;
  const SC = sun.shadow.camera;
  let shadowR = 36;
  const fitShadow = (R) => { shadowR = R; SC.left = -R; SC.right = R; SC.top = R; SC.bottom = -R; SC.near = 1; SC.far = 560; SC.updateProjectionMatrix(); };
  fitShadow(36);
  scene.add(sun, sun.target);
  const sunDir = sky.sun.dir.clone();
  const lightRot = new THREE.Matrix4().lookAt(new THREE.Vector3(), sunDir.clone().negate(), new THREE.Vector3(0, 1, 0));
  const lightInv = lightRot.clone().invert();
  const _p = new THREE.Vector3();
  function updateSun(focus) {
    const texel = (2 * shadowR) / sun.shadow.mapSize.x;
    _p.copy(focus).applyMatrix4(lightInv);
    _p.x = Math.round(_p.x / texel) * texel; _p.y = Math.round(_p.y / texel) * texel;
    _p.applyMatrix4(lightRot);
    sun.target.position.copy(_p);
    sun.position.copy(_p).addScaledVector(sunDir, 280);
    sun.target.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- terrain
  const terrainTex = await loadTerrainTextures(`${W}/materials`);
  const tGeo = buildTerrain();
  const CAVE = { x: POI.cave.x, z: POI.cave.z + 3 };
  CAVE.floor = groundHeight(CAVE.x, CAVE.z + 1.5);
  carveTerrain(tGeo, CAVE.x, CAVE.z, 7.5, 17, CAVE.floor);
  const tMat = makeTerrainMaterial(terrainTex, { triplanar: true });
  addAerialFog(tMat);
  const terrain = new THREE.Mesh(tGeo, tMat);
  terrain.receiveShadow = true; terrain.castShadow = false;   // (hills self-shadow little at this sun; saves the biggest shadow-pass mesh)
  terrain.matrixAutoUpdate = false; terrain.updateMatrix();
  scene.add(terrain);
  progress('terrain');

  const ripple = await A.tex(`${W}/water/water_ripples_nor.jpg`);
  const sea = makeSea({ heightTex: heightTexture, half: HALF, rippleTex: ripple });
  addAerialFog(sea.mat);
  scene.add(sea.mesh);

  // ---------------------------------------------------------------- models
  const prep = (root, { cast = true, receive = true } = {}) => {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = cast; o.receiveShadow = receive;
      for (const m of [].concat(o.material)) { addAerialFog(m); if (m.map) m.map.anisotropy = 8; }
    });
    return root;
  };
  const glb = async (name) => prep((await A.gltf(`${W}/models/${name}.glb`)).scene);
  const gy = (x, z) => groundHeight(x, z);
  const place = (obj, x, z, ry = 0, dy = 0, s = 1) => { obj.position.set(x, gy(x, z) + dy, z); obj.rotation.y = ry; obj.scale.setScalar(s); scene.add(obj); obj.updateMatrixWorld(true); return obj; };

  const [temple, rockF1, rockF2, boulder, cliff, cave, camp, firePit, pen, galley, boat] = await Promise.all(
    ['temple_ruin', 'rock_face_01', 'rock_face_02', 'boulder_namaqualand_05', 'cliff_namaqualand_01', 'cave_mouth', 'camp_scene', 'fire_pit_stone', 'sheep_pen', 'galley', 'boat_small'].map(glb));
  progress('models');
  // sand on the tops of the rocks and cliffs (critic round 3, defect 10)
  for (const r of [rockF1, rockF2, boulder, cliff]) if (r) r.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) addTopCoat(m); });

  // temple: 6 x 11 Doric peripteros on a 3-step crepidoma (dimensions from tools/world/blender/build_temple.py)
  const T = { x: POI.temple.x, z: POI.temple.z };
  const tBase = gy(T.x, T.z) - 0.35;
  temple.position.set(T.x, tBase, T.z); scene.add(temple); temple.updateMatrixWorld(true);
  // the flat block faces (steps, stylobate, walls, architraves) get box-projected UVs at the model's own marble scale:
  // their baked UVs were stretched along the steps and drew long black-and-white stripes (critic round 1, defect 11)
  temple.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, P = g.attributes.position, Nn = g.attributes.normal, U = g.attributes.uv; if (!U || !Nn) return;
    // texel scale: median UV length per metre along the edges of the up-facing faces
    const idx = g.index, ratios = [];
    for (let t = 0; t < (idx ? idx.count : P.count) && ratios.length < 4000; t += 3) {
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1;
      if (Nn.getY(a) < 0.98) continue;
      const dw = Math.hypot(P.getX(a) - P.getX(b), P.getY(a) - P.getY(b), P.getZ(a) - P.getZ(b)), du = Math.hypot(U.getX(a) - U.getX(b), U.getY(a) - U.getY(b));
      if (dw > 0.05) ratios.push(du / dw);
    }
    ratios.sort((p, q) => p - q);
    const k = ratios.length ? ratios[ratios.length >> 1] : 0.5;
    let n = 0;
    for (let i = 0; i < P.count; i++) {
      const nx = Math.abs(Nn.getX(i)), ny = Math.abs(Nn.getY(i)), nz = Math.abs(Nn.getZ(i));
      if (Math.max(nx, ny, nz) < 0.97) continue;                     // fluted / round surfaces keep their own mapping
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      if (ny >= nx && ny >= nz) U.setXY(i, x * k, z * k); else if (nx >= nz) U.setXY(i, z * k, y * k); else U.setXY(i, x * k, y * k);
      n++;
    }
    U.needsUpdate = true; o.userData.boxUV = { verts: n, k: +k.toFixed(3) };
  });
  for (let k = 0; k < 3; k++) addPlatform(T.x, T.z, 6.975 + (2 - k) * 0.52, 12.975 + (2 - k) * 0.52, tBase + 0.4 * (k + 1));
  addStoneRect(T.x, T.z, 8.1, 14.1, tBase + 0.4);
  const sty = tBase + 1.2;
  const colAt = (i, j) => ({ x: T.x - 6 + i * 2.4, z: T.z + 12 - j * 2.4 });
  const standing = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [0, 1], [0, 2], [0, 3], [0, 5], [0, 6], [5, 1], [5, 2]];
  const broken = [[5, 3, 2.52], [5, 6, 1.15], [0, 8, 3.32], [2, 10, 1.7], [3, 10, 0.86], [0, 9, 0.86], [5, 9, 1.7]];
  for (const [i, j] of standing) { const c = colAt(i, j); addCircle(c.x, c.z, 0.55, 6.5, sty - 0.2); }
  for (const [i, j, h] of broken) { const c = colAt(i, j); addCircle(c.x, c.z, 0.55, h + 0.2, sty - 0.2); }
  addBox(T.x - 2.6, T.z - 2.0, 0.4, 3.5, 0, 2.2, sty - 0.2);
  addBox(T.x + 2.6, T.z - 1.0, 0.4, 2.5, 0, 2.2, sty - 0.2);
  addBox(T.x, T.z + 5.6, 2.3, 0.4, 0, 2.2, sty - 0.2);
  for (let k = 0; k < 6; k++) { const d = k * 0.9 + 0.4; addCircle(T.x + 9.2 + Math.cos(0.35) * d, T.z - 10 - Math.sin(0.35) * d, 0.55, 1.0); }
  addCircle(T.x - 10.5, T.z + 15, 1.4, 1.2);

  // cave mouth pushed into the escarpment; colliders follow the lofted tunnel of build_props.py
  cave.position.set(CAVE.x, CAVE.floor - 0.4, CAVE.z); scene.add(cave); cave.updateMatrixWorld(true);
  for (let t = 0; t <= 1.0001; t += 1 / 14) {
    const ang = 0.5 * t * t, cx = -Math.sin(ang) * 17 * t * 0.5, cz = 1.5 - 17 * t, w = 12.5 + (7 - 12.5) * t;
    addCircle(CAVE.x + cx - w / 2 - 0.9, CAVE.z + cz, 1.3, 14, CAVE.floor - 1);
    addCircle(CAVE.x + cx + w / 2 + 0.9, CAVE.z + cz, 1.3, 14, CAVE.floor - 1);
  }
  addBox(CAVE.x - 14.5, CAVE.z - 7.5, 5.5, 9.5, 0, 16, CAVE.floor - 1);
  addBox(CAVE.x + 12.8, CAVE.z - 7.5, 5.2, 9.5, 0, 16, CAVE.floor - 1);
  addBox(CAVE.x - 2, CAVE.z - 17.5, 9, 1.2, 0, 16, CAVE.floor - 1);
  addCircle(CAVE.x + 9, CAVE.z + 2.5, 3.0, 5);
  if (cliff) {
    const o = cliff.clone(); place(o, CAVE.x + 17, CAVE.z - 4, 0.3, -1.0, 1.4); addCircle(o.position.x, o.position.z, 5, 8, null, 'rock'); regRock(o);
  }

  // rocks: scanned cliffs along the northern shore, boulders on the rocky ground
  // (their true top surface goes into the camera / sight-line height map, collide.js)
  function regRock(o) { o.updateMatrixWorld(true); o.traverse((m) => { if (m.isMesh) addRockHeights(m.geometry, [m.matrixWorld]); }); }
  const rnd = mulberry32(7);
  const lods = [];                                        // far-LOD swaps (olive trunks, scanned rocks)
  const rockLOD = (o) => o.traverse((m) => {
    if (!m.isMesh || !m.geometry.index) return;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    lods.push({ mesh: m, full: m.geometry, far: farGeometry(m.geometry, Math.max(0.1, m.geometry.boundingSphere.radius * 0.07)) });
  });
  for (let i = 0; i < 6; i++) {
    const a = -1.2 + i * 0.32, r = 108 + rnd() * 6;
    const o = cliff.clone(); const s = 1.6 + rnd() * 0.8; place(o, Math.cos(a) * r, Math.sin(a) * r - 10, a + Math.PI / 2, -1.5, s); regRock(o); rockLOD(o);
    addCircle(o.position.x, o.position.z, 4.5 * s, 8, null, 'rock');
  }
  for (const src of [rockF1, rockF2, boulder]) {
    for (let i = 0; i < 7; i++) {
      let x, z, tries = 0;
      do { x = (rnd() - 0.5) * 220; z = (rnd() - 0.5) * 220; tries++; } while (tries < 80 && (surfaceAt(x, z) !== 'stone' || Math.hypot(x - T.x, z - T.z) < 24 || Math.hypot(x - POI.camp.x, z - POI.camp.z) < 22 || Math.hypot(x - CAVE.x, z - CAVE.z) < 22));
      const o = src.clone(); const s = 0.7 + rnd() * 0.9; place(o, x, z, rnd() * 6.28, -0.3, s); regRock(o); rockLOD(o);
      const bb = new THREE.Box3().setFromObject(o); addCircle(x, z, Math.max(0.6, Math.min(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.42), bb.max.y - bb.min.y, null, 'rock');
    }
  }

  // beach camp (fix round 2, critic round 2 defect 4): ten sewn, sagging tents with guy ropes and pegs, three fires
  // (one under a cooking tripod), spear racks with shields, sacks, bedrolls, crates, jars, firewood, a drying line and
  // a stake palisade; layout from tools/world/blender/build_camp2.py (camp_layout.json, camp-local metres)
  const C = { x: POI.camp.x, z: POI.camp.z, ry: Math.PI + 0.25 };   // tents inland, open toward the sea
  const LAY = await A.json(`${W}/models/camp_layout.json`);
  place(camp, C.x, C.z, C.ry, 0);
  // tent canvas is thin: the sun shows through it on the shaded side (it drew near-black there)
  { const done = new Set(); camp.traverse((o) => { if (o.isMesh && /linen/.test(o.material.name) && !done.has(o.material)) { done.add(o.material); addTranslucency(o.material, 0.55, 0.2); } }); }
  const cy0 = gy(C.x, C.z);
  const tents = [];
  for (const t of LAY.tents) {
    const w = toWorld(C.x, C.z, C.ry, t.lx, t.lz);
    const col = addCircle(w.x, w.z, t.r, 2.4, null, 'tent');
    const dw = toWorld(C.x, C.z, C.ry, t.door[0], t.door[1]);   // door side faces the fires
    tents.push({ x: w.x, z: w.z, door: dw, lx: t.lx, lz: t.lz, r: t.r, col });
  }
  // each tent (canvas, poles, ropes and what leans on it) is its own piece, so the falling giant can flatten the one he
  // lands on (critic round 1, defect 8): triangles go to the nearest tent within 4.2 m. The camp is 36 m across on a
  // sloping beach, so every vertex is set on the ground under it (tents relative to the ground at their centre).
  {
    const parts = [];
    camp.traverse((o) => { if (o.isMesh && /^camp_/.test(o.name)) parts.push(o); });
    for (const T of tents) {
      const w = toWorld(C.x, C.z, C.ry, T.lx, T.lz); T.dy = gy(w.x, w.z) - cy0;
      T.piece = new THREE.Group(); T.piece.position.set(T.lx, T.dy, T.lz); camp.add(T.piece);
    }
    camp.updateMatrixWorld(true);
    const _cv = new THREE.Vector3();
    for (const m of parts) {
      const g = m.geometry, pos = g.attributes.position, idx = g.index; if (!idx) continue;
      const keep = [], per = tents.map(() => []), vt = new Int16Array(pos.count).fill(-1);
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
        const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3 + m.position.x, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3 + m.position.z;
        // only the tent's own canvas, poles and ropes (within its pegs) go into its piece: jars, sacks and the palisade
        // nearby stay in the one-mesh-per-material rest (each extra material in a piece is one more draw call)
        let best = -1, bd = 3.4;
        if (/linen|wood|rope/.test(m.material.name)) tents.forEach((T, k) => { const d = Math.hypot(cx - T.lx, cz - T.lz); if (d < bd) { bd = d; best = k; } });
        if (best >= 0) { per[best].push(a, b, c); vt[a] = vt[b] = vt[c] = best; } else keep.push(a, b, c);
      }
      for (let i = 0; i < pos.count; i++) {
        _cv.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld);
        const dyv = gy(_cv.x, _cv.z) - cy0;
        pos.setY(i, pos.getY(i) + dyv - (vt[i] >= 0 ? tents[vt[i]].dy : 0));
      }
      pos.needsUpdate = true; g.computeBoundingSphere();
      g.setIndex(keep);
      per.forEach((list, k) => {
        if (!list.length) return;
        const ng = new THREE.BufferGeometry();
        for (const [n, at] of Object.entries(g.attributes)) ng.setAttribute(n, at);
        ng.setIndex(list); ng.computeBoundingSphere();
        const pm = new THREE.Mesh(ng, m.material); pm.castShadow = m.castShadow; pm.receiveShadow = m.receiveShadow;
        pm.position.set(m.position.x - tents[k].lx, m.position.y, m.position.z - tents[k].lz); pm.quaternion.copy(m.quaternion); pm.scale.copy(m.scale);
        tents[k].piece.add(pm);
      });
    }
    camp.updateMatrixWorld(true);
    // The follow camera treats canvas, poles, spear racks, the palisade and the cart as solid (the same top-height map
    // as the rocks: it lifts over a tent or pulls in in front of it), and what still comes between the lens and the
    // hero dissolves like foliage. It went behind tent canvas and spear racks and lost the hero in the wave fights
    // (critic round 3, defect 3). The guy ropes are left out (a slack rope would roof the ground under it).
    initPropGrid(C.x, C.z, 30);
    const solid = (m) => m.isMesh && /linen|wood|bark/.test(m.material.name);
    const seeMats = new Set();
    camp.traverse((m) => { if (solid(m)) seeMats.add(m.material); });
    // (close in only: a whole tent wall dithering 2.8 m from the lens read as a screen door)
    // (a tent end right behind him is cut open all the way to him: the line to his chest, 0.5-1.0 m around it)
    for (const mat of seeMats) addSeeThrough(mat, { near0: 0.45, near1: 1.3, r0: 0.5, r1: 1.0, toHero: true });
    tents.forEach((T, k) => T.piece.traverse((m) => { if (solid(m)) addPropHeights(m, 'tent' + k); }));
    camp.traverse((m) => { if (solid(m) && /^camp_/.test(m.name)) addPropHeights(m, 'camp'); });
  }
  const fires = [];
  for (const [lx, lz] of LAY.fires) {
    const w = toWorld(C.x, C.z, C.ry, lx, lz), dy = gy(w.x, w.z) - cy0;
    const fp = firePit.clone(); fp.position.set(lx, 0.02 + dy, lz); camp.add(fp);
    const l = new THREE.PointLight(0xff8a3a, 0, 16, 2); l.position.set(lx, 1.0 + dy, lz); camp.add(l);
    fires.push({ x: w.x, y: gy(w.x, w.z), z: w.z, light: l });
  }
  for (const [lx, lz, r, h] of LAY.colliders) { const w = toWorld(C.x, C.z, C.ry, lx, lz); addCircle(w.x, w.z, r, h); }
  const campProps = [];     // shields and baskets placed by the game (tested: lowest point on the sand)
  const campCasters = [];   // the camp's own shadows only while the hero is near it (from the far side of the beach
                            // it sat inside the sun's shadow box and its ~80 pieces doubled the shadow pass)
  // shields leaning on the racks (the soldiers' own black aspis) and wicker baskets by the tents (Poly Haven, CC0)
  {
    const [gearG, basket] = await Promise.all([A.gltf('./assets/characters/gear.glb'), glb('wicker_basket')]);
    const asp = gearG.scene.getObjectByName('aspis_black');
    const bb = new THREE.Box3().setFromObject(basket); const bsz = bb.getSize(new THREE.Vector3());
    const bs = 0.5 / Math.max(bsz.x, bsz.z, 0.01);
    // The aspis model is a disc in its XY plane, the convex face toward +Z (the handles sit in the hollow behind it).
    // It used to be turned -1.25 rad about X, which laid it nearly flat, face up, 0.28-0.59 m above the sand: six
    // hovering black discs in the middle of the wave-1 fight (critic round 3, defect 2). Now each one stands on its rim
    // in front of the rack's spear feet, face out, leaning back ~38 degrees so its upper rim rests on the spear shafts
    // (the shafts run from 0.75-0.87 m out at the sand to the crossbar at 1.44 m), and its lowest rim point is set
    // 1.5 cm into the sand under it.
    const _sv = new THREE.Vector3();
    // their painted devices: the gear map carried one red sign (a modern-looking logo, critic rounds 2 and 3); each rack's
    // pair gets an old device painted over it on a copy of the map (lambda, eight-rayed star, wheel)
    const devMats = [];
    { let src = null; asp.traverse((m) => { if (m.isMesh && /aspis_black/.test(m.material.name) && m.material.map) src = m.material; });
      if (src && src.map.image) for (let d = 0; d < 3; d++) {
        const img = src.map.image, N = img.width || 1024, cv = document.createElement('canvas'); cv.width = cv.height = N;
        const x = cv.getContext('2d'); x.drawImage(img, 0, 0, N, N);
        const cx = 0.34 * N, cy = 0.672 * N, R = 0.205 * N;
        x.fillStyle = 'rgb(26,26,26)'; x.beginPath(); x.arc(cx, cy, R * 0.86, 0, Math.PI * 2); x.fill();
        x.strokeStyle = x.fillStyle = d === 1 ? 'rgb(110,30,24)' : 'rgb(196,180,150)'; x.lineWidth = R * 0.16; x.lineCap = 'round';
        x.beginPath();
        if (d === 0) { x.moveTo(cx - R * 0.46, cy + R * 0.55); x.lineTo(cx, cy - R * 0.62); x.lineTo(cx + R * 0.46, cy + R * 0.55); x.stroke(); }
        else if (d === 1) { for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; x.moveTo(cx, cy); x.lineTo(cx + Math.cos(a) * R * 0.72, cy + Math.sin(a) * R * 0.72); } x.lineWidth = R * 0.1; x.stroke(); x.beginPath(); x.arc(cx, cy, R * 0.2, 0, Math.PI * 2); x.fill(); }
        else { x.arc(cx, cy, R * 0.6, 0, Math.PI * 2); x.moveTo(cx - R * 0.6, cy); x.lineTo(cx + R * 0.6, cy); x.moveTo(cx, cy - R * 0.6); x.lineTo(cx, cy + R * 0.6); x.lineWidth = R * 0.12; x.stroke(); }
        const t = new THREE.CanvasTexture(cv); t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
        const m = src.clone(); m.map = t; devMats.push(m);
      } }
    let rackN = 0;
    for (const sh of LAY.shields) for (let k = 0; k < sh.n && asp; k++) {
      const o = asp.clone(true); o.position.set(0, 0, 0); o.quaternion.identity();
      if (devMats.length) { const dm = devMats[rackN % devMats.length]; o.traverse((m) => { if (m.isMesh && /aspis_black/.test(m.material.name)) m.material = dm; }); }
      if (k === sh.n - 1) rackN++;
      const out = -0.2;   // the anchor is 0.9 m out from the rack: the centre comes 0.2 m in, the lower rim ends ~1 m out
      const lx = sh.at[0] + (k - 0.5) * 0.95 * Math.cos(sh.ry) + out * Math.sin(sh.ry), lz = sh.at[1] - (k - 0.5) * 0.95 * Math.sin(sh.ry) + out * Math.cos(sh.ry);
      const w = toWorld(C.x, C.z, C.ry, lx, lz);
      o.rotation.set(-0.66 + (k ? 0.04 : -0.03), C.ry + sh.ry + (k ? 0.07 : -0.06), k ? 0.9 : -0.4, 'YXZ');
      o.position.set(w.x, 0, w.z); o.updateMatrixWorld(true);
      let low = Infinity, lowAt = null;
      o.traverse((m) => { if (!m.isMesh) return; const P = m.geometry.attributes.position; for (let i = 0; i < P.count; i++) { _sv.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld); if (_sv.y < low) { low = _sv.y; lowAt = [_sv.x, _sv.z]; } } });
      o.position.y = gy(lowAt[0], lowAt[1]) - low - 0.015;
      o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; campCasters.push(m); } });
      scene.add(o); campProps.push(o);
    }
    for (const b of LAY.baskets) {
      const o = basket.clone(); o.scale.setScalar(bs); const w = toWorld(C.x, C.z, C.ry, b.at[0], b.at[1]);
      o.position.set(w.x, gy(w.x, w.z) - bb.min.y * bs, w.z); o.rotation.y = b.ry; scene.add(o); campProps.push(o);
      o.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
    }
    camp.traverse((m) => { if (m.isMesh && m.castShadow) campCasters.push(m); });
  }

  // sheep pen (dry-stone ellipse 7 x 5 m with a gate gap)
  const P = { x: POI.pen.x, z: POI.pen.z, ry: 0.7 };
  place(pen, P.x, P.z, P.ry, -0.05);
  for (let a = 0; a < Math.PI * 2; a += 0.11) {
    if (a > -0.02 && a < 0.26) continue;
    const w = toWorld(P.x, P.z, P.ry, Math.cos(a) * 7, Math.sin(a) * 5);
    addCircle(w.x, w.z, 0.38, 1.2);
  }

  // ---------------------------------------------------------------- vegetation (instanced, wind)
  const keep = (x, z) => [POI.temple, POI.camp, POI.cave, POI.start, POI.heroShip, POI.pen].every((p) => Math.hypot(x - p.x, z - p.z) > (p === POI.temple ? 22 : p === POI.camp ? 20 : 14)) && pathWeight(x, z) < 0.2;
  const trunks = [];
  async function plant(name, n, ok, sMin, sMax, trunkR, cast = true, extra = []) {
    const src = await glb(name);
    const pl = extra.slice(); let guard = 0; n += extra.length;
    while (pl.length < n && guard++ < n * 60) {
      const x = (rnd() - 0.5) * 230, z = (rnd() - 0.5) * 230;
      if (!ok(x, z)) continue;
      pl.push({ x, y: gy(x, z) - 0.15, z, rot: rnd() * 6.28, s: sMin + rnd() * (sMax - sMin) });
    }
    const g = instanceGLB(src, pl, { castShadow: cast, fellable: !!trunkR }); scene.add(g);
    if (name === 'olive_tree') for (const im of g.children) if (/trunk/.test(im.name)) {
      // near: the gnarled trunk at 12 cm clusters (-31 % triangles, same silhouette); far (> 55 m): 30 cm clusters
      const near = farGeometry(im.geometry, 0.12), far = farGeometry(near, 0.3);
      im.geometry = near; lods.push({ mesh: im, full: near, far });
    }
    if (trunkR) for (const p of pl) {
      p.col = addCircle(p.x, p.z, trunkR * p.s, 4, null, 'tree'); p.col.tree = p;
      p.kind = name; p.height = name === 'cypress_tree' ? 11 * p.s : 6.5 * p.s;
      trunks.push(p);
    }
    return g;
  }
  // an old olive grove in rows between the landing beach and the shrine ruin (cultivated land, not wilderness)
  const grove = [];
  { const gx = -20, gz = 34, ga = 0.32, ca = Math.cos(ga), sa = Math.sin(ga);
    for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) {
      const lx = (i - 2) * 8.6 + (rnd() - 0.5) * 1.6, lz = (j - 1.5) * 8.6 + (rnd() - 0.5) * 1.6, x = gx + lx * ca + lz * sa, z = gz - lx * sa + lz * ca;
      if (surfaceAt(x, z) === 'grass' && keep(x, z) && rnd() < 0.9) grove.push({ x, y: gy(x, z) - 0.15, z, rot: rnd() * 6.28, s: 0.8 + rnd() * 0.3 });
    } }
  await plant('olive_tree', 40, (x, z) => surfaceAt(x, z) === 'grass' && gy(x, z) > 2.5 && keep(x, z), 0.85, 1.2, 0.8, true, grove);
  await plant('cypress_tree', 22, (x, z) => surfaceAt(x, z) === 'grass' && gy(x, z) > 4 && keep(x, z) && (Math.hypot(x - T.x, z - T.z) < 60 || rnd() < 0.3), 0.8, 1.15, 0.4);
  await plant('bush_mastic', 120, (x, z) => surfaceAt(x, z) !== 'water' && surfaceAt(x, z) !== 'sand' && gy(x, z) > 1.8 && keep(x, z), 0.7, 1.3, 0, false);
  progress('trees');
  const [tuftTex, seedTex] = await Promise.all([A.tex(`${W}/materials/foliage_cards/grass_tuft_rgba.png`, { srgb: true }), A.tex(`${W}/materials/grass_dry/grass_dry_rgba.png`, { srgb: true })]);
  function scatterGrass(n, hMin, tintK = 1.0) {
    const pl = []; let guard = 0;
    while (pl.length < n && guard++ < n * 10) {
      const x = (rnd() - 0.5) * 250, z = (rnd() - 0.5) * 250;
      const h = gy(x, z);
      if (h < hMin || surfaceAt(x, z) !== 'grass' || pathWeight(x, z) > 0.3) continue;
      if (Math.hypot(x - T.x, z - T.z) < 17 || Math.hypot(x - POI.camp.x, z - POI.camp.z) < 15) continue;
      const k = (0.95 + rnd() * 0.35) * tintK;
      pl.push({ x, y: h - 0.04, z, rot: rnd() * 6.28, s: 0.55 + rnd() * 0.55, tint: [k * (1.0 + rnd() * 0.1), k, k * (0.82 + rnd() * 0.12)] });
    }
    return pl;
  }
  const grass = makeGrassChunked(tuftTex, scatterGrass(grassN, 1.4), { strips: 1, w: 0.5, h: 0.42, n: 4 });
  const seeds = makeGrassChunked(seedTex, scatterGrass(Math.round(grassN / 5), 1.8, 0.72), { strips: 4, w: 0.36, h: 0.7, n: 4 });
  for (const g of [grass, seeds]) { addAerialFog(g.userData.material); scene.add(g); }

  // ---------------------------------------------------------------- inland: a ruined shrine, scattered drums, a shepherd's cart,
  // rock outcrops in the grass (the self-made temple and camp kits, otherwise unused; critic round 1, defect 11)
  {
    const [tk, ck] = await Promise.all([glb('temple_kit'), glb('camp_kit')]);
    const part = (kit, name, i = 0) => { const l = []; kit.traverse((o) => { if (o.isMesh && o.name.startsWith(name)) l.push(o); }); const o = (l[i] || l[0]).clone(); o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); return o; };
    const placed = [];
    const put = (o, x, z, ry, { rx = 0, rz = 0, dy = 0, r = 0, h = 2, box = null } = {}) => {
      o.rotation.set(rx, ry, rz, 'YXZ'); o.position.set(x, gy(x, z) + dy, z); scene.add(o); o.updateMatrixWorld(true);
      if (r) addCircle(x, z, r, h); if (box) addBox(x, z, box[0], box[1], ry, h);
      placed.push(o);
      return o;
    };
    const S = { x: -27, z: 14, ry: 0.6 }, L = (lx, lz) => toWorld(S.x, S.z, S.ry, lx, lz);
    // naiskos: a 5 x 7 m foundation of ashlar blocks (some gone), the back wall standing to 2 m, two broken columns,
    // fallen drums, a capital and an architrave block in the grass
    for (let k = 0; k < 18; k++) {
      const per = k / 18 * 24, side = per < 5 ? 0 : per < 12 ? 1 : per < 17 ? 2 : 3;
      const u = side === 0 ? per : side === 1 ? per - 5 : side === 2 ? per - 12 : per - 17;
      const lx = side === 0 ? -2.5 + u : side === 1 ? 2.5 : side === 2 ? 2.5 - u : -2.5, lz = side === 0 ? -3.5 : side === 1 ? -3.5 + u : side === 2 ? 3.5 : 3.5 - u;
      if ([3, 7, 8, 13].includes(k)) continue;
      const w = L(lx, lz); put(part(tk, 'ashlar_block'), w.x, w.z, S.ry + (side % 2 ? Math.PI / 2 : 0) + (rnd() - 0.5) * 0.12, { dy: -0.18 - rnd() * 0.1, rz: (rnd() - 0.5) * 0.06 });
    }
    { const w = L(0, 3.1); put(part(tk, 'cella_wall_ruin'), w.x, w.z, S.ry, { dy: -0.1, box: [3.0, 0.42], h: 2.0 }); }
    { const w = L(-1.9, -2.6); put(part(tk, 'column_broken_tall'), w.x, w.z, S.ry + 0.4, { dy: -0.05, r: 0.5, h: 2.6 }); }
    { const w = L(2.0, -2.4); put(part(tk, 'column_broken_short'), w.x, w.z, S.ry + 1.1, { dy: -0.05, r: 0.5, h: 1.3 }); }
    { const w = L(3.9, -5.0); put(part(tk, 'drum'), w.x, w.z, S.ry + 0.3, { rx: Math.PI / 2, dy: 0.38, r: 0.55, h: 0.9 }); }
    { const w = L(5.1, -4.0); put(part(tk, 'drum'), w.x, w.z, S.ry - 0.5, { rx: Math.PI / 2, dy: 0.38, r: 0.55, h: 0.9 }); }
    { const w = L(-3.9, -4.6); put(part(tk, 'capital'), w.x, w.z, S.ry + 0.8, { rz: 0.22, dy: -0.06 }); }
    { const w = L(0.6, -5.6); put(part(tk, 'architrave_block'), w.x, w.z, S.ry + 0.25, { rz: -0.08, dy: -0.12, box: [1.2, 0.56], h: 0.8 }); }
    // drums and blocks fallen beside the path up to the temple
    for (const [x, z, ry] of [[19, 10, 0.4], [21.5, 8.6, 2.0], [33, -17, 1.2], [-6, 47, 0.9]]) {
      if (surfaceAt(x, z) === 'water') continue;
      put(part(tk, 'drum'), x, z, ry, { rx: Math.PI / 2, dy: 0.38, r: 0.55, h: 0.9 });
    }
    put(part(tk, 'ashlar_block'), 23, 11, 0.2, { dy: -0.15 }); put(part(tk, 'ashlar_block'), -7.5, 49, 1.1, { dy: -0.2, rz: 0.1 });
    // the shepherd's cart and jars on the way to the pen, a cold fire
    put(part(ck, 'cart'), -46, -33, 2.4, { dy: 0.0, box: [1.8, 1.0], h: 1.2 });
    put(part(ck, 'amphora'), -43.6, -35.2, 0.3, { r: 0.3, h: 0.8 }); put(part(ck, 'amphora', 0), -43.0, -34.4, 1.3, { r: 0.3, h: 0.8 });
    put(part(ck, 'amphora_broken'), -44.2, -36.4, 2.0, { rz: 1.4, dy: 0.12 });
    put(part(ck, 'campfire_logs'), -41.5, -37.5, 0.4, {});
    // one draw call per material for all these static pieces (the shrine alone is ~25 meshes)
    const byMat = new Map();
    for (const o of placed) o.traverse((m) => { if (!m.isMesh) return; const k = m.material; if (!byMat.has(k)) byMat.set(k, []); byMat.get(k).push(m); });
    for (const [mat, list] of byMat) {
      if (list.length < 2) continue;
      // the kit materials multiply the vertex colours in (tint + baked shade): the merge used to drop 'color' and every
      // piece rendered black (critic round 2, defect 1). Keep it, as plain floats so all pieces merge alike.
      const geos = list.map((m) => {
        const g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld);
        for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(n)) g.deleteAttribute(n);
        const c = g.attributes.color, nv = g.attributes.position.count, col = new Float32Array(nv * 3);
        if (c) for (let i = 0; i < nv; i++) { col[i * 3] = c.getX(i); col[i * 3 + 1] = c.getY(i); col[i * 3 + 2] = c.getZ(i); } else col.fill(1);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        return g;
      });
      const merged = mergeGeometries(geos);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mm = new THREE.Mesh(merged, mat); mm.castShadow = true; mm.receiveShadow = true; mm.matrixAutoUpdate = false; mm.name = 'inland_' + (mat.name || 'merged'); scene.add(mm);
      for (const m of list) m.visible = false;
    }
    // rock outcrops in the grass: one instanced mesh per rock scan
    for (const src of [rockF1, rockF2, boulder]) {
      const mats = [];
      for (let i = 0; i < 4; i++) {
        let x, z, tries = 0;
        do { x = (rnd() - 0.5) * 200; z = (rnd() - 0.5) * 200; tries++; } while (tries < 80 && (surfaceAt(x, z) !== 'grass' || !keep(x, z) || Math.hypot(x - S.x, z - S.z) < 12));
        if (tries >= 80) continue;
        const sc = 0.55 + rnd() * 0.5, ry = rnd() * 6.28;
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, gy(x, z) - 0.35, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sc, sc, sc)));
        const bb = new THREE.Box3().setFromObject(src); const sz = bb.getSize(new THREE.Vector3()).multiplyScalar(sc);
        addCircle(x, z, Math.max(0.5, Math.min(sz.x, sz.z) * 0.42), sz.y, null, 'rock');
      }
      src.updateMatrixWorld(true);
      src.traverse((m) => {
        if (!m.isMesh || !mats.length) return;
        const g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld);
        addRockHeights(g, mats);
        const im = new THREE.InstancedMesh(g, m.material, mats.length);
        mats.forEach((M, i) => im.setMatrixAt(i, M)); im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
        im.castShadow = false; im.receiveShadow = true; scene.add(im);   // (low outcrops: their shadows are not worth the triangles)
      });
    }
  }

  // ---------------------------------------------------------------- distant islands on the horizon (v1 had them as cards; here
  // real lit landforms 1.5-2.6 km out, through a thinner haze so their ridges read; critic round 1, defect 11)
  {
    const isl = [[-2.3, 2050, 520, 210], [-1.75, 2350, 760, 260], [-1.05, 1900, 380, 120], [-0.45, 2250, 600, 170], [0.25, 2450, 440, 140],
      [2.2, 2150, 560, 190], [2.75, 1750, 330, 110], [3.3, 2400, 820, 240], [1.35, 2500, 500, 150]];
    const geos = [];
    const rr = mulberry32(91);
    for (const [ang, dist, R, Hh] of isl) {
      const rings = 30, segs = 96, pos = [], col = [], idx = [];
      const ox = Math.cos(ang) * dist, oz = Math.sin(ang) * dist, seed = rr() * 100, peaks = [[rr() - 0.5, rr() - 0.5, 0.6 + rr() * 0.4], [rr() - 0.5, rr() - 0.5, 0.4 + rr() * 0.4]];
      for (let i = 0; i <= rings; i++) for (let j = 0; j < segs; j++) {
        const a = j / segs * Math.PI * 2, u = i / rings;
        const edge = 1 + 0.22 * Math.sin(a * 3 + seed) + 0.12 * Math.sin(a * 7 + seed * 2) + 0.06 * Math.sin(a * 17 + seed * 3) + 0.035 * Math.sin(a * 31 + seed);
        const r = u * R * edge * 1.15, x = Math.cos(a) * r, z = Math.sin(a) * r * 0.62;
        let h = 0;
        for (const [px, pz, k] of peaks) { const d = Math.hypot(x / R - px * 0.8, z / R - pz * 0.5); h = Math.max(h, k * Math.exp(-d * d * 3.2)); }
        // ridged spurs and gullies (they were smooth cones, critic round 2 defect 13)
        const rdg = 1 - Math.abs(2 * fbm(x / 95 + seed * 1.7, z / 95, 4) - 1);
        h = h * (0.68 + 0.26 * fbm(x / 160 + seed, z / 160, 3) + 0.42 * rdg * rdg) - smoothstep(0.75, 1.0, u) * 0.25;
        const y = Math.max(-8, h * Hh);
        pos.push(ox + x, y, oz + z);
        const rock = smoothstep(0.35, 0.8, h), g = 0.15 + 0.05 * fbm(x / 60, z / 60, 2);   // maquis-covered slopes, paler rock above
        col.push(g * (1.0 + 0.9 * rock), g * (1.0 + 0.75 * rock), g * (0.78 + 0.6 * rock));
      }
      for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
        const a = i * segs + j, b = i * segs + (j + 1) % segs, c = a + segs, d = b + segs;
        idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx); g.computeVertexNormals(); geos.push(g);
    }
    const ig = mergeGeometries(geos); ig.computeBoundingSphere();
    const im = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    addAerialFog(im, { densityMul: 0.38 });
    const islands = new THREE.Mesh(ig, im); islands.name = 'distant_islands'; islands.matrixAutoUpdate = false;
    scene.add(islands);
  }

  // ---------------------------------------------------------------- ships (hero ship beached, enemy galleys)
  const fleet = buildFleet(scene, galley, boat, { gy });
  progress('ships');

  // ---------------------------------------------------------------- living things: gulls, sheep, sea serpent
  const critters = { mixers: [], items: [] };
  const C2 = './assets/creatures';
  const [gullG, ramG, serpG] = await Promise.all([A.gltf(`${C2}/seagull/seagull.glb`), A.gltf(`${C2}/ram/ram.glb`), A.gltf(`${C2}/sea-serpent/pistosaur.glb`)]);
  const spawnCritter = (g, scale, t0) => {
    const o = SkeletonUtils.clone(g.scene); o.scale.multiplyScalar(scale);
    o.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; for (const mm of [].concat(m.material)) addAerialFog(mm); } });
    const mx = new THREE.AnimationMixer(o); const a = mx.clipAction(g.animations[0]); a.play(); mx.setTime(t0);
    scene.add(o); critters.mixers.push(mx); return o;
  };
  // gulls circle above the beach and the cliffs
  for (let i = 0; i < 7; i++) {
    const o = spawnCritter(gullG, 1.14, rnd() * 9);
    critters.items.push({ kind: 'gull', o, c: i < 5 ? new THREE.Vector3(-10 + rnd() * 50, 0, 92 + rnd() * 24) : new THREE.Vector3(-40 + rnd() * 70, 0, -95 + rnd() * 20), r: 10 + rnd() * 18, h: 13 + rnd() * 14, w: (0.16 + rnd() * 0.1) * (rnd() < 0.5 ? 1 : -1), p: rnd() * 6.28 });
  }
  // the giant's flock in and around the pen
  for (let i = 0; i < 7; i++) {
    const o = spawnCritter(ramG, 0.0777, rnd() * 1.2);
    const inside = i < 5;
    const ang = rnd() * 6.28, rad = inside ? 1.5 + rnd() * 3 : 9 + rnd() * 6;
    critters.items.push({ kind: 'sheep', o, cx: P.x + Math.cos(ang) * rad, cz: P.z + Math.sin(ang) * rad, a: rnd() * 6.28, r: inside ? 1.0 + rnd() * 1.2 : 2 + rnd() * 2, w: (0.12 + rnd() * 0.12) * (rnd() < 0.5 ? 1 : -1), mixer: critters.mixers[critters.mixers.length - 1] });
  }
  // a long-necked sea serpent cruising far offshore, back and neck above the water
  {
    const o = spawnCritter(serpG, 2.848, 0);
    critters.items.push({ kind: 'serpent', o, a: 2.2, r: 205, w: 0.018 });
  }

  // ---------------------------------------------------------------- finish
  applySky(scene, sun, sky, { envIntensity: legacyGround ? 1.0 : sk.env, fogSunGlow: sk.glow ?? 0.12 });
  // ground bounce: the pure-sky HDRI has no ground, so faces turned away from the sun got only sky light
  // and backlit figures went black against bright sand. A ground-only hemisphere light (sky colour black)
  // adds the warm bounce from below: about the sand's albedo times the sun's ground irradiance, halved.
  const bounce = new THREE.HemisphereLight(0x000000, 0xd9c49c, 0.2 * sky.sun.intensity * Math.max(0.15, sunDir.y));
  scene.add(bounce);
  const grassGroups = [grass, seeds];
  // ---------------------------------------------------------------- trees felled by the giant
  // A tree the giant walks into, swings through or falls on is pushed over about its root (away from him and to the
  // side of his path), lands on its branches and stays as a low obstacle: he never stands or fights inside a trunk
  // (critic round 1, defect 8).
  const falling = [];
  const _fm = new THREE.Matrix4(), _fq = new THREE.Quaternion(), _fq2 = new THREE.Quaternion(), _fe = new THREE.Euler(), _fs = new THREE.Vector3(), _fp = new THREE.Vector3(), _fax = new THREE.Vector3();
  function setTreeMatrix(p, ang) {
    _fq.setFromEuler(_fe.set(0, p.rot, 0));
    _fq2.setFromAxisAngle(_fax.set(p.fall.z, 0, -p.fall.x), ang).multiply(_fq);
    _fm.compose(_fp.set(p.x + p.fall.x * 0.25 * ang, p.y - 0.12 * ang, p.z + p.fall.z * 0.25 * ang), _fq2, _fs.setScalar(p.s));
    for (const r of p.inst) { r.m.setMatrixAt(r.i, _fm); r.m.instanceMatrix.needsUpdate = true; }
  }
  const world = { onFell: null };
  const felledZones = [];
  function fellTree(p, dx, dz) {
    if (!p || p.felled || !p.inst) return false;
    const L = Math.hypot(dx, dz) || 1;
    p.felled = true; p.col.off = true;
    for (const r of p.inst) if (r.fell) { r.fell.array[r.i] = 1; r.fell.needsUpdate = true; }   // see-through crown
    { const L = Math.hypot(dx, dz) || 1, h = p.height * 0.9, y = p.y + 0.4;   // and its trunk and branches, as a zone
      felledZones.push({ a: new THREE.Vector3(p.x, y, p.z), b: new THREE.Vector3(p.x + dx / L * h, y, p.z + dz / L * h) }); setFelledZones(felledZones); }
    p.fall = { x: dx / L, z: dz / L, t: 0, ang: 0, max: p.kind === 'cypress_tree' ? 1.42 : 1.2, T: p.kind === 'cypress_tree' ? 1.5 : 1.15, landed: false };
    falling.push(p);
    if (world.onFell) world.onFell(p, 'crack');
    return true;
  }
  function updateFalling(dt) {
    for (let k = falling.length - 1; k >= 0; k--) {
      const p = falling[k], F = p.fall;
      F.t += dt;
      const u = Math.min(1, F.t / F.T);
      F.ang = F.max * u * u;                                   // tips slowly, then drops
      if (F.t > F.T) F.ang = F.max - 0.07 * Math.sin((F.t - F.T) * 14) * Math.exp(-(F.t - F.T) * 6);   // bounces on its branches
      setTreeMatrix(p, F.ang);
      if (!F.landed && u >= 1) {
        F.landed = true;
        const len = 0.55 * p.height, a = Math.atan2(-F.x, F.z);
        p.log = addBox(p.x + F.x * len * 0.5, p.z + F.z * len * 0.5, 0.45 * p.s, len * 0.5, a, 1.1, null, 'log');
        if (world.onFell) world.onFell(p, 'land');
      }
      if (F.t > F.T + 0.8) { for (const r of p.inst) r.m.computeBoundingSphere(); falling.splice(k, 1); }
    }
  }
  const flattening = [];
  function flattenTent(T, from) {
    if (T.flat) return false;
    T.flat = { t: 0, tilt: (from && ((from.x - T.x) * Math.cos(C.ry) - (from.z - T.z) * Math.sin(C.ry)) > 0 ? -1 : 1) };
    T.col.off = true; flattening.push(T);
    setPropsOn('tent' + tents.indexOf(T), false);
    if (world.onFlatten) world.onFlatten(T);
    return true;
  }
  // body points (world) of the fallen / falling giant, or an impact: tents under them are flattened
  function flattenTents(cy, points) {
    for (const T of tents) {
      if (T.flat) continue;
      for (const p of points) if (p.y - groundHeight(p.x, p.z) < 3.4 && Math.hypot(p.x - T.x, p.z - T.z) < T.r + 1.1) { flattenTent(T, p); break; }
    }
  }
  function flattenAt(x, z, r) { for (const T of tents) if (!T.flat && Math.hypot(x - T.x, z - T.z) < T.r + r) flattenTent(T, { x, z }); }
  function updateFlatten(dt) {
    for (let k = flattening.length - 1; k >= 0; k--) {
      const T = flattening[k], F = T.flat; F.t += dt;
      const u = Math.min(1, F.t / 0.32);
      T.piece.scale.set(1 + 0.25 * u, 1 - 0.86 * u * u, 1 + 0.25 * u);
      T.piece.rotation.z = F.tilt * 0.12 * u;
      if (u >= 1) flattening.splice(k, 1);
    }
  }
  function resetTrees() {
    for (const T of tents) if (T.flat) { T.flat = null; T.col.off = false; T.piece.scale.set(1, 1, 1); T.piece.rotation.set(0, 0, 0); }
    setPropsOn(null, true);
    flattening.length = 0;
    for (const p of trunks) if (p.felled) {
      p.felled = false; p.col.off = false; if (p.log) { p.log.off = true; p.log = null; }
      for (const r of p.inst) if (r.fell) { r.fell.array[r.i] = 0; r.fell.needsUpdate = true; }
      p.fall.ang = 0; setTreeMatrix(p, 0); for (const r of p.inst) r.m.computeBoundingSphere();
    }
    falling.length = 0;
    felledZones.length = 0; setFelledZones(felledZones);
  }
  const camPos = new THREE.Vector3();
  let lodTick = 0;
  let campShadow = true;
  function update(dt, t, focus, camera) {
    if (falling.length) updateFalling(dt);
    if (focus) { const near = Math.hypot(focus.x - C.x, focus.z - C.z) < 48; if (near !== campShadow) { campShadow = near; for (const m of campCasters) m.castShadow = near; } }
    if (flattening.length) updateFlatten(dt);
    WIND.uTime.value = t;
    sea.update(t, camera);
    fleet.update(dt, t);
    for (const f of fires) f.light.intensity = sk.fire * (0.75 + 0.25 * Math.sin(t * 13 + f.x) * Math.sin(t * 7.3 + f.z) + 0.08 * Math.random());
    camPos.copy(camera.position);
    updateSeeThrough(camPos, focus);
    for (const g of grassGroups) cullByDistance(g, camPos, world.grassDist || 62);
    if ((lodTick = (lodTick + 1) % 8) === 0) updateLOD(lods, camPos, 55);
    for (const m of critters.mixers) m.update(dt);
    for (const c of critters.items) {
      if (c.kind === 'gull') {
        const a = c.p + t * c.w;
        c.o.position.set(c.c.x + Math.cos(a) * c.r, c.h + Math.sin(t * 0.3 + c.p) * 2.0, c.c.z + Math.sin(a) * c.r);
        c.o.rotation.set(0, Math.atan2(-Math.sin(a) * Math.sign(c.w), Math.cos(a) * Math.sign(c.w)), -0.3 * Math.sign(c.w), 'YXZ');
      } else if (c.kind === 'sheep') {
        c.a += c.w * dt;
        const x = c.cx + Math.cos(c.a) * c.r, z = c.cz + Math.sin(c.a) * c.r;
        c.o.position.set(x, gy(x, z), z);
        c.o.rotation.y = Math.atan2(-Math.sin(c.a) * Math.sign(c.w), Math.cos(c.a) * Math.sign(c.w));
      } else if (c.kind === 'serpent') {
        c.a += c.w * dt;
        const x = Math.cos(c.a) * c.r, z = Math.sin(c.a) * c.r;
        c.o.position.set(x, seaHeight(x, z, t) - 1.35, z);
        c.o.rotation.y = Math.atan2(-Math.sin(c.a), Math.cos(c.a)) + Math.PI / 2;
      }
    }
    if (focus) updateSun(focus);
  }
  function setShadowRadius(R) { if (Math.abs(R - shadowR) > 0.5) fitShadow(R); }
  return Object.assign(world, { scene, sky, sun, bounce, sea, terrain, temple, cave, camp, campProps, pen, fleet, fires, tents, critters, grass: grassGroups, update, setShadowRadius, CAVE, tod, sk, trunks, fellTree, resetTrees, falling, flattenTents, flattenAt, lods });
}
