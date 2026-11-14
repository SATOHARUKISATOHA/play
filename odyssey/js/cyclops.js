// Polyphemus (10 m, from the creature scout): sleeps in the cave, wakes, roars and hunts. Stomp (shock-wave),
// club sweep (all around), slam (a miss leaves him on all fours: the eye comes down to sword height and takes x5),
// boulder throw (arc + crater). The club head snaps off at half health. The eye bone tracks the hero.
import * as THREE from 'three';
import { Actor } from './character.js';
import { damp, dampAngle, clamp, wrapAngle, rand } from './util.js';
import { POI } from './terrain.js';
import { groundAt, resolve, nearColliders } from './collide.js';
import { addAerialFog, addCharacterFill, addLensDither } from './env.js';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _hd = new THREE.Vector3(), _fd = new THREE.Vector3();
const _ch = new THREE.Vector3(), _ct = new THREE.Vector3(), _ce = new THREE.Vector3(), _sh = new THREE.Vector3(), _se = new THREE.Vector3(), _sp = new THREE.Vector3();
// cSweep, measured on the giant's own skeleton (fix round 1): the club rises on his right (0.05-0.30), comes down
// diagonally across the front to his LEFT where it is low (ratio 0.49-0.54, 8-14 m out at 45-60 deg), then returns
// low across the front (0.86-0.99, 4-9 m). The club is tested as a swept segment every frame between these ratios,
// and he aims the swing during the wind-up so the low part of the arc passes through the hero.
const SWEEP_ON = 0.42, SWEEP_OFF = 0.995;
function sweepAim(d) { // hero's angle in the giant's frame (+ = his left) that puts him under a low pass of the club
  if (d < 4.6) return -0.3;      // close: the end of the return pass, beside his right foot
  if (d < 7.4) return 0.0;       // the low return across the front (it reaches 5-7 m straight ahead)
  if (d < 8.8) return 0.26;      // the return, a little to his left (7-8.8 m; at 8 m straight ahead it passed 0.6-1.6 m
                                 // off the hero depending on a few hundredths of a radian, round-1 re-test)
  return 0.87;                   // far: the down-swing, low on his left (8-14 m)
}

// Skin micro-detail for the giant (canvas normal map: pores and fine creases, tiled ~70 times over the skin UVs). Close
// up his face read as a smooth rubber mask (critic round 2, defect 12); the painted texture has no pore-scale detail.
function skinDetailTexture() {
  const N = 256, h = new Float32Array(N * N);
  const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (let k = 0; k < 900; k++) {                              // pores: small soft pits
    const cx = rnd() * N, cy = rnd() * N, r = 0.8 + rnd() * 1.6, d = 0.6 + rnd() * 0.6;
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const px = ((Math.floor(cx) + x) % N + N) % N, py = ((Math.floor(cy) + y) % N + N) % N, rr = Math.hypot(x + cx % 1 - 0.5, y + cy % 1 - 0.5) / r;
      if (rr < 1.6) h[py * N + px] -= d * Math.exp(-rr * rr * 1.6);
    }
  }
  for (let k = 0; k < 70; k++) {                               // creases: short wavy grooves
    let x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI * 2; const L = 10 + rnd() * 30, w = 0.6 + rnd() * 0.6;
    for (let t = 0; t < L; t++) {
      a += (rnd() - 0.5) * 0.25; x += Math.cos(a); y += Math.sin(a);
      for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) { const px = ((Math.floor(x) + ox) % N + N) % N, py = ((Math.floor(y) + oy) % N + N) % N; h[py * N + px] -= w * Math.exp(-(ox * ox + oy * oy) / 2.2); }
    }
  }
  const cv = document.createElement('canvas'); cv.width = cv.height = N;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const hx = h[y * N + (x + 1) % N] - h[y * N + (x - 1 + N) % N], hy = h[((y + 1) % N) * N + x] - h[((y - 1 + N) % N) * N + x];
    const nx = -hx * 0.35, ny = -hy * 0.35, nz = 1, L = Math.hypot(nx, ny, nz), o = (y * N + x) * 4;
    d[o] = (nx / L * 0.5 + 0.5) * 255; d[o + 1] = (ny / L * 0.5 + 0.5) * 255; d[o + 2] = (nz / L * 0.5 + 0.5) * 255; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8;
  return t;
}
function addSkinDetail(m, tex, scale = 70, k = 0.45) {
  const prev = m.onBeforeCompile, k0 = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, r) => {
    if (prev) prev(sh, r);
    sh.uniforms.uSkinDetail = { value: tex };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uSkinDetail;')
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;',
        `mapN.xy *= normalScale; mapN.xy += (texture2D(uSkinDetail, vNormalMapUv * ${scale.toFixed(1)}).xy * 2.0 - 1.0) * ${k.toFixed(2)};`));
  };
  m.customProgramCacheKey = () => k0 + '|skin' + scale + k;
  m.needsUpdate = true;
}

// olive end grain (canvas): growth rings with a wobble, darker heartwood, a few drying checks, the bark rim
function endGrainTexture() {
  const N = 512, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
  const h = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = (i / N - 0.5) * 2.13, v = (j / N - 0.5) * 2.13, r = Math.hypot(u, v), a = Math.atan2(v, u);
    const rr = r * (1 + 0.05 * Math.sin(3 * a + 1.3) + 0.03 * Math.sin(7 * a + 0.4) + 0.015 * Math.sin(13 * a + 2.0));
    const ring = Math.pow(0.5 + 0.5 * Math.sin(rr * 52 + 2.4 * Math.sin(rr * 7.5)), 8);
    let c = rr < 0.5 ? [124, 88, 58] : [172, 134, 92];
    const grain = 0.92 + 0.08 * h(Math.floor(i / 2), Math.floor(j / 2));
    let k = (1 - 0.3 * ring) * grain;
    for (const ca of [0.6, 2.4, 4.1]) { const da = Math.abs(Math.atan2(Math.sin(a - ca), Math.cos(a - ca))); if (rr > 0.15 && rr < 0.93 && da < 0.012 + 0.02 * (rr - 0.15)) k *= 0.35; }
    if (rr > 0.94) { c = [70, 56, 42]; k = 0.9 + 0.1 * h(i, j); }
    if (rr < 0.04) k *= 0.6;
    const o = (j * N + i) * 4; d[o] = c[0] * k; d[o + 1] = c[1] * k; d[o + 2] = c[2] * k; d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export class Cyclops {
  constructor(game, C, boulderSrc) {
    this.g = game;
    const root = C.poly.scene;
    this.mats = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
      for (const m of [].concat(o.material)) {
        addAerialFog(m);
        // sun-weathered shepherd rather than a grey troll: warm the skin, darken the hair
        if (/troll_body/.test(m.name)) m.color.setRGB(1.32, 1.06, 0.86);
        if (/hair/.test(m.name)) m.color.setRGB(0.55, 0.42, 0.32);
        if (m.emissive && !this.mats.includes(m)) this.mats.push(m);
      }
    });
    this.eyeMat = this.mats.find((m) => /eye/.test(m.name)) || null;
    { const det = skinDetailTexture(), done = new Set();
      root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (/troll_body/.test(m.name) && m.normalMap && !done.has(m)) { done.add(m); addSkinDetail(m, det); } }); }
    // his skin, hair and loincloth dissolve within 0.5-1.6 m of the lens (critic round 3, defect 1: a palm filled the
    // view; the camera now keeps out of his hands, this is the backstop)
    root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m.isMeshStandardMaterial && !/club|olive/.test(m.name)) addLensDither(m, 0.5, 1.6); });
    this.actor = new Actor(root, C.cyTable, { loco: ['idle', 'walk', 'run'] });
    this.B = this.actor.bones;
    this.shadeEye();   // (still in the rest pose: no clip has been applied yet)
    this.clubHead = root.getObjectByName('club_head');
    // Polyphemus' club is "a great club of green olive wood" (Odyssey 9), not the troll's black stone mace: the
    // handle and the breakable head become one gnarled, bark-covered olive trunk (critic round 1, defect 12)
    this.makeOliveClub(root, root.getObjectByName('club_handle'), this.clubHead, game);
    // the troll's lower tusks go (a man's teeth remain)
    root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position.count === 214 && [].concat(o.material).some((m) => /troll_body/.test(m.name))) o.visible = false; });
    this.zones = C.polyMeta.zones_m.map((z) => ({ bone: this.B[z.bone], r: z.r, weak: !!z.weak, name: z.bone, p: new THREE.Vector3() }));
    game.scene.add(root);
    // debris copy of the club head (static mesh in the bone's frame)
    this.debrisMesh = null;
    if (this.clubHead) {
      const m = new THREE.Mesh(this.clubHead.geometry, this.clubHead.material);
      m.castShadow = true; m.visible = false; game.scene.add(m); this.debrisMesh = m;
    }
    const bo = boulderSrc.clone(true);
    bo.traverse((o) => { if (o.isMesh) { o.castShadow = true; for (const mm of [].concat(o.material)) addAerialFog(mm); } });
    const bb = new THREE.Box3().setFromObject(bo); const sz = bb.getSize(new THREE.Vector3());
    bo.scale.setScalar(1.9 / Math.max(sz.x, sz.y, sz.z));
    this.boulder = new THREE.Group(); this.boulder.add(bo); bo.position.set(0, 0, 0);
    this.boulder.visible = false; game.scene.add(this.boulder);
    // second phase: a handful of smaller rocks thrown at once (a volley)
    this.volley = [0, 1, 2].map((k) => { const v = new THREE.Group(); const c = bo.clone(); c.scale.multiplyScalar(0.55 + 0.08 * k); c.rotation.set(k * 1.3, k * 2.1, k * 0.7); v.add(c); v.visible = false; game.scene.add(v); return v; });
    this.pos = new THREE.Vector3();
    this.walkSpeed = clamp(C.cyTable.walk.speed || 2.3, 1.2, 4);
    this.runSpeed = clamp(C.cyTable.run.speed || 7, 4, 9);
    this.reset();
  }
  get char() { return this.actor; }
  // The one eye read as a glossy ball in a hard-edged hole, with a pale dome of white above the iris (critic rounds 2
  // and 3). Procedural lids read as a cap over it (tried in fix round 3 and dropped), so the ball is shaded instead the
  // way a brow and an upper lid shade a real eye: the part of the ball above the iris (in the HEAD's frame, so the shadow
  // stays put while the ball turns) goes dark and warm, a little below it too, and the ball is less like glass.
  shadeEye() {
    const m = this.eyeMat, head = this.B.head; if (!m || !head) return;
    this.eyeU = { uEyeC: { value: new THREE.Vector3() }, uEyeUp: { value: new THREE.Vector3(0, 1, 0) }, uEyeF: { value: new THREE.Vector3(0, 0, 1) } };
    const U = this.eyeU, prev = m.onBeforeCompile, k0 = m.customProgramCacheKey();
    m.onBeforeCompile = (sh, r) => {
      if (prev) prev.call(m, sh, r);
      Object.assign(sh.uniforms, U);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uEyeC, uEyeUp, uEyeF;')
        .replace('#include <map_fragment>', `#include <map_fragment>
float eyeSh = 0.0;
{ vec3 d = normalize(-vViewPosition - uEyeC);
  float up = dot(d, uEyeUp), fw = dot(d, uEyeF);
  float lid = smoothstep(0.18, 0.42, up) + 0.55 * smoothstep(0.42, 0.62, -up);   // under the upper lid, and the lower lid
  float rim = 1.0 - smoothstep(0.55, 0.95, fw);                                    // and toward the socket's rim all round
  float sh = clamp(lid + 0.6 * rim, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.32, 0.22, 0.18), sh); eyeSh = sh; }`)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directSpecular *= 1.0 - 0.92 * eyeSh; reflectedLight.indirectSpecular *= 1.0 - 0.85 * eyeSh;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = max(roughnessFactor, 0.32);');
    };
    m.customProgramCacheKey = () => k0 + '|eyeShade';
    m.needsUpdate = true;
    this.eyeHeadUp = new THREE.Vector3(); this.eyeHeadF = new THREE.Vector3();
    // the head's up and forward at rest, in the head's own frame (the eye's sight line and world up in the rest pose)
    this.actor.root.updateMatrixWorld(true);
    const hq = head.getWorldQuaternion(new THREE.Quaternion()).invert();
    const F = new THREE.Vector3(0, 1, 0).applyQuaternion(this.B.eye.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const Uw = new THREE.Vector3(0, 1, 0).addScaledVector(F, -F.y).normalize();
    this.eyeHeadUp.copy(Uw).applyQuaternion(hq); this.eyeHeadF.copy(F).applyQuaternion(hq);
  }
  // per frame (before the render): the eye centre and the head's up / forward, in view space
  updateEyeShade(camera) {
    const U = this.eyeU; if (!U || !this.B.eye) return;
    const hq = this.B.head.getWorldQuaternion(_q3);
    this.B.eye.getWorldPosition(U.uEyeC.value).applyMatrix4(camera.matrixWorldInverse);
    const vq = _q2.setFromRotationMatrix(camera.matrixWorldInverse);
    U.uEyeUp.value.copy(this.eyeHeadUp).applyQuaternion(hq).applyQuaternion(vq).normalize();
    U.uEyeF.value.copy(this.eyeHeadF).applyQuaternion(hq).applyQuaternion(vq).normalize();
  }
  makeOliveClub(root, H, K, game) {
    if (!H || !K) return;
    root.updateMatrixWorld(true);
    const wv = (m) => { const p = m.geometry.attributes.position, out = []; for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld)); return out; };
    const avg = (l) => l.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / l.length);
    const hv = wv(H), kv = wv(K), hc = avg(hv), kc = avg(kv);
    const dir = kc.clone().sub(hc).normalize();
    const along = (v) => v.clone().sub(hc).dot(dir);
    const t0 = Math.min(...hv.map(along)), t1 = Math.max(...kv.map(along)), th = Math.min(...kv.map(along));
    const A = hc.clone().addScaledVector(dir, t0), L = t1 - t0, headT = (th - t0) / L;
    const p1 = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize(), p2 = new THREE.Vector3().crossVectors(dir, p1);
    const knots = [[0.18, 1.1, 0.22], [0.36, 4.0, 0.18], [0.55, 2.2, 0.2], [headT + 0.05, 0.6, 0.35], [headT + 0.12, 3.6, 0.3], [0.97, 5.2, 0.25]];
    const radius = (t, a) => {
      let r = t < headT ? 0.15 + 0.1 * (t / headT) : 0.25 + 0.28 * Math.sin(Math.min(1, (t - headT) / (1 - headT) * 1.25) * Math.PI / 2);
      r *= 1 + 0.07 * Math.sin(3 * a + 9 * t) + 0.05 * Math.sin(7 * a - 17 * t) + 0.03 * Math.sin(13 * a + 31 * t);
      for (const [kt, ka, kr] of knots) { const dt = (t - kt) * L / 0.35, da = Math.atan2(Math.sin(a - ka), Math.cos(a - ka)); r *= 1 + kr * Math.exp(-dt * dt - da * da * 2.5); }
      return r;
    };
    const centre = (t) => A.clone().addScaledVector(dir, t * L).addScaledVector(p1, 0.14 * Math.sin(Math.PI * t)).addScaledVector(p2, 0.06 * Math.sin(2 * Math.PI * t + 0.5));
    const build = (ta, tb, rings) => {
      const seg = 16, pos = [], uv = [], idx = [];
      for (let i = 0; i <= rings; i++) {
        const t = ta + (tb - ta) * i / rings, c = centre(t);
        for (let j = 0; j <= seg; j++) {
          const a = j / seg * Math.PI * 2, r = radius(t, a);
          const v = c.clone().addScaledVector(p1, Math.cos(a) * r).addScaledVector(p2, Math.sin(a) * r);
          pos.push(v.x, v.y, v.z); uv.push(j / seg * 2, t * L / 1.2);
        }
      }
      for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) { const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
      // end faces in end grain (critic round 2, defect 10: they wore the bark and read as flat polygons). The break
      // between shaft and head is a splintered stump: two rings of jagged spikes; the other ends are cut, slightly domed.
      const sides = idx.length;
      for (const [t, flip, broken] of ends) {
        const c = centre(t), out = flip ? -1 : 1;
        const jag = (a, k) => broken ? (0.05 + 0.11 * Math.abs(Math.sin(3 * a + 1.1 + k)) + 0.05 * Math.sin(7 * a + 0.3 + k) + 0.03 * Math.sin(17 * a + k)) : 0.02;
        const ring = (f, k) => { const b0 = pos.length / 3; for (let j = 0; j <= seg; j++) { const a = j / seg * Math.PI * 2, r = radius(t, a) * f, v = c.clone().addScaledVector(p1, Math.cos(a) * r).addScaledVector(p2, Math.sin(a) * r).addScaledVector(dir, out * jag(a, k) * (broken ? 1 : (1 - f) * 2)); pos.push(v.x, v.y, v.z); uv.push(0.5 + 0.47 * f * Math.cos(a), 0.5 + 0.47 * f * Math.sin(a)); } return b0; };
        const r0 = ring(0.99, 0), r1 = ring(0.62, 2.1), r2 = ring(0.3, 4.2);
        const cv = c.clone().addScaledVector(dir, out * (broken ? 0.2 : 0.04)), cb = pos.length / 3; pos.push(cv.x, cv.y, cv.z); uv.push(0.5, 0.5);
        const quad = (A, B) => { for (let j = 0; j < seg; j++) { const a0 = A + j, a1 = A + j + 1, b0 = B + j, b1 = B + j + 1; flip ? idx.push(a0, b1, a1, a0, b0, b1) : idx.push(a0, a1, b1, a0, b1, b0); } };
        quad(r0, r1); quad(r1, r2);
        for (let j = 0; j < seg; j++) flip ? idx.push(cb, r2 + j + 1, r2 + j) : idx.push(cb, r2 + j, r2 + j + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals();
      g.addGroup(0, sides, 0); g.addGroup(sides, idx.length - sides, 1);
      return g;
    };
    let ends;
    ends = [[0, true, false], [headT + 0.01, false, true]]; const shaft = build(0, headT + 0.01, 40);
    ends = [[headT - 0.005, true, true], [1, false, false]]; const head = build(headT - 0.005, 1, 16);
    shaft.applyMatrix4(H.matrixWorld.clone().invert()); head.applyMatrix4(K.matrixWorld.clone().invert());
    shaft.computeBoundingSphere(); head.computeBoundingSphere();
    const tl = new THREE.TextureLoader(), B = './assets/world/materials/bark/';
    const map = tl.load(B + 'bark_diff.jpg'), nor = tl.load(B + 'bark_nor.jpg'), arm = tl.load(B + 'bark_arm.jpg');
    map.colorSpace = THREE.SRGBColorSpace; for (const t of [map, nor, arm]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
    const mat = new THREE.MeshStandardMaterial({ name: 'olive_club', map, normalMap: nor, roughnessMap: arm, roughness: 1, metalness: 0, color: new THREE.Color(0.86, 0.84, 0.74) });
    const endMat = new THREE.MeshStandardMaterial({ name: 'olive_endgrain', map: endGrainTexture(), roughness: 0.92, metalness: 0 });
    for (const m of [mat, endMat]) { addAerialFog(m); addCharacterFill(m); if (game.world && game.world.sk) m.envMapIntensity = game.world.sk.env; }
    H.geometry = shaft; K.geometry = head; H.material = [mat, endMat]; K.material = [mat, endMat];
    this.clubMats = [mat, endMat];
    this.clubLen = +L.toFixed(2);
  }
  reset() {
    const s = POI.cyclopsSleep;
    this.home = { x: POI.cave.x, z: POI.cave.z + 3 };
    this.pos.set(s.x, groundAt(s.x, s.z), s.z); this.yaw = 0.0;
    this.hpMax = 1200; this.hp = this.hpMax; this.state = 'sleep'; this.t = 0; this.legDmg = 0;
    // a knock-down is a window, not the whole fight: at most a fifth of his health per knock-down, each one shorter
    // than the last (he died inside his first one: 8 eye hits x5, critic round 2 defect 5). The club breaks at half
    // health and starts a second phase: a rage roar that calls the Cicones back, rock volleys, faster attacks.
    this.downs = 0; this.downDmg = 0; this.phase = 1; this.pendingRage = false; this.calls = 0; this.rage = false;
    if (this.volley) for (const v of this.volley) v.visible = false;
    for (const r of this.rocks || []) { r.obj.visible = false; if (r.marker) this.g.fx.removeMarker(r.marker); }
    this.rocks = [];
    this.awake = false; this.dead = false; this.clubBroken = false; this.enraged = false; this.intro = false;
    this.cool = 2; this.flinchAcc = 0; this.lastThrow = -99; this.time = 0; this.speed = 0;
    if (this.clubHead) this.clubHead.visible = true;
    if (this.debrisMesh) this.debrisMesh.visible = false;
    this.debris = null; this.boulder.visible = false; this.ring = null; this.dieYaw = undefined; this.felled = 0;
    this.actor.setLoco(0, 0.01);
    this.actor.play('sleep', { fade: 0 });
    this.place();
  }
  place() { this.actor.root.position.copy(this.pos); this.actor.root.rotation.y = this.yaw; }
  wake() {
    if (this.awake || this.dead) return;
    this.awake = true; this.state = 'waking'; this.t = 0;
    this.intro = true;   // only the wake-up roar leads to the walk out of the cave ('emerge')
    this.actor.play('wake', { fade: 0.3 });
    this.g.onCyclopsWake(this);
  }
  pushOut(p, r) {
    if (this.dead && this.t > 3) { // the fallen body
      const h = this.B.hips.getWorldPosition(_v), c = this.B.chest.getWorldPosition(new THREE.Vector3());
      for (const w of [h, c]) { const dx = p.x - w.x, dz = p.z - w.z, d = Math.hypot(dx, dz), R = 1.9 + r; if (d < R && d > 1e-4) { p.x = w.x + dx / d * R; p.z = w.z + dz / d * R; } }
      return;
    }
    const low = this.state === 'stagger' || this.state === 'staggerFall' || this.state === 'sleep';
    const circles = [[this.B.foot_L, 0.95], [this.B.foot_R, 0.95], [this.B.hips, low ? 2.3 : 1.5]];
    for (const [b, rad] of circles) {
      const w = b.getWorldPosition(_v);
      if (w.y - this.pos.y > 3.4 && b !== this.B.hips) continue;
      const dx = p.x - w.x, dz = p.z - w.z, d = Math.hypot(dx, dz), R = rad + r;
      if (d < R && d > 1e-4) { p.x = w.x + (dx / d) * R; p.z = w.z + (dz / d) * R; }
    }
  }
  // body capsules (joint to joint) for the follow camera: it may not sit inside him or right behind a leg
  // (round-1 re-test: shots/09-cyclops-vs-hero.jpg was a thigh filling the lens with the hero lying at his fist)
  updateBody() {
    if (!this.caps) {
      const C = [['thigh_L', 'shin_L', 0.9], ['shin_L', 'foot_L', 0.7], ['thigh_R', 'shin_R', 0.9], ['shin_R', 'foot_R', 0.7],
        ['hips', 'spine2', 1.35], ['spine2', 'chest', 1.45], ['chest', 'head', 1.05],
        ['upperArm_L', 'foreArm_L', 0.6], ['foreArm_L', 'hand_L', 0.55], ['upperArm_R', 'foreArm_R', 0.6], ['foreArm_R', 'hand_R', 0.55]];
      this.caps = C.filter(([a, b]) => this.B[a] && this.B[b]).map(([a, b, r]) => ({ a: this.B[a], b: this.B[b], r, pa: new THREE.Vector3(), pb: new THREE.Vector3() }));
      // the club too (hand -> 15 % past the head bone), so the lens does not sit inside it (critic round 2, defect 10)
      if (this.B.hand_R && this.B.clubTip) this.caps.push(this.clubCap = { a: this.B.hand_R, b: this.B.clubTip, r: 0.45, ext: 1.15, pa: new THREE.Vector3(), pb: new THREE.Vector3() });
      // The hands: the arm capsules ended at the wrist, and his palm and fingers reach 1.6-1.9 m past it (measured on
      // the skin), so after a slam the lens sat in his hand (critic round 3, defect 1). Wrist -> each knuckle (palm),
      // knuckle -> middle joint, middle joint -> fingertip (the last bone extended to the tip).
      this.hands = [];
      for (const side of ['R', 'L']) {
        const hand = this.B['hand_' + side]; if (!hand) continue;
        const dig = {};
        for (const n of Object.keys(this.B)) { const m = n.match(new RegExp(side + 'ArmDigit(\\d)(\\d)')); if (m) (dig[m[1]] || (dig[m[1]] = []))[+m[2] - 1] = this.B[n]; }
        const H = { bone: hand, p: new THREE.Vector3(), R: 2.3 };
        this.hands.push(H);
        for (const list of Object.values(dig)) {
          if (!list[0] || !list[1]) continue;
          this.caps.push({ a: hand, b: list[0], r: 0.42, pa: new THREE.Vector3(), pb: new THREE.Vector3(), hand: H });
          this.caps.push({ a: list[0], b: list[1], r: 0.24, pa: new THREE.Vector3(), pb: new THREE.Vector3(), hand: H });
          if (list[2]) this.caps.push({ a: list[1], b: list[2], r: 0.22, ext: 1.9, pa: new THREE.Vector3(), pb: new THREE.Vector3(), hand: H });
        }
      }
    }
    for (const c of this.caps) { c.a.getWorldPosition(c.pa); c.b.getWorldPosition(c.pb); if (c.ext) { c.pb.sub(c.pa).multiplyScalar(c === this.clubCap && this.clubBroken ? 0.85 : c.ext).add(c.pa); } }
    for (const H of this.hands) H.bone.getWorldPosition(H.p);
  }
  // the club swung past the lens covered a quarter of the screen with bark: it turns see-through within 2.4 m of the
  // camera (both its programs are compiled at load). Returns the opacity used.
  fadeClub(camPos) {
    if (!this.clubMats || !this.clubCap) return 1;
    const c = this.clubCap, abx = c.pb.x - c.pa.x, aby = c.pb.y - c.pa.y, abz = c.pb.z - c.pa.z, L2 = abx * abx + aby * aby + abz * abz || 1e-6;
    const t = Math.max(0, Math.min(1, ((camPos.x - c.pa.x) * abx + (camPos.y - c.pa.y) * aby + (camPos.z - c.pa.z) * abz) / L2));
    const d = Math.hypot(camPos.x - (c.pa.x + abx * t), camPos.y - (c.pa.y + aby * t), camPos.z - (c.pa.z + abz * t)) - 0.5;
    const a = this.awake ? Math.min(1, Math.max(0.12, (d - 0.6) / 1.8)) : 1;
    const on = a < 0.999;
    for (const m of this.clubMats) { if (m.transparent !== on) { m.transparent = on; m.needsUpdate = true; } m.opacity = a; m.depthWrite = !on || a > 0.6; }
    return a;
  }
  blocksCamera(p, margin = 0.45) {
    if (!this.awake || !this.caps) return false;
    for (const c of this.caps) {
      // (the club does not push the lens: it comes down 6 m in two frames and snapped the camera 2.4-7 m forward on
      //  every slam; near the lens it turns see-through instead, fadeClub)
      if (c === this.clubCap) continue;
      if (c.hand && c.hand.p.distanceToSquared(p) > (c.hand.R + margin) * (c.hand.R + margin)) continue;   // far from that hand
      const abx = c.pb.x - c.pa.x, aby = c.pb.y - c.pa.y, abz = c.pb.z - c.pa.z, L2 = abx * abx + aby * aby + abz * abz || 1e-6;
      const t = Math.max(0, Math.min(1, ((p.x - c.pa.x) * abx + (p.y - c.pa.y) * aby + (p.z - c.pa.z) * abz) / L2));
      const dx = p.x - (c.pa.x + abx * t), dy = p.y - (c.pa.y + aby * t), dz = p.z - (c.pa.z + abz * t);
      if (dx * dx + dy * dy + dz * dz < (c.r + margin) * (c.r + margin)) return true;
    }
    return false;
  }
  updateZones() {
    const down = this.state === 'stagger' || this.state === 'staggerFall';
    for (const z of this.zones) {
      z.bone.getWorldPosition(z.p);
      // on all fours the whole face is the target: the eye zone widens and sits a little lower
      if (z.weak) { z.r = down ? 1.45 : 0.85; if (down) z.p.y -= 0.55; }
    }
  }
  get eye() { return this.zones.find((z) => z.weak).p; }
  nearestZonePoint(from) {
    let best = null, bd = Infinity;
    for (const z of this.zones) { const d = z.p.distanceTo(from); if (d < bd && z.p.y < from.y + 3.2) { bd = d; best = z.p; } }
    return best;
  }
  // the way his face points (head bone -> eye bone)
  faceDir(out) {
    this.B.head.getWorldPosition(_hd);
    return this.zones.find((z) => z.weak).bone.getWorldPosition(out).sub(_hd).normalize();
  }
  testHit(pts) {
    let best = null;
    const f = this.faceDir(_fd); // _hd now holds the head centre
    for (const z of this.zones) {
      const R = z.r + 0.15;
      for (const p of pts) {
        // the eye is struck from in front of the face only, not through the back of the skull
        if (z.weak && (p.x - _hd.x) * f.x + (p.y - _hd.y) * f.y + (p.z - _hd.z) * f.z < -0.15) continue;
        const d = p.distanceTo(z.p);
        if (d < R && (!best || z.weak || d < best.d)) best = { zone: z.name, weak: z.weak, point: p.clone(), d };
      }
      if (best && best.weak) break;
    }
    return best;
  }
  takeHit(dmg, zone, point) {
    if (this.dead) return { dmg: 0 };
    let mult = 1, weak = false;
    const down = this.state === 'stagger' || this.state === 'staggerFall';
    if (zone === 'eye') { mult = down ? 5 : 1.6; weak = down; }
    else if (zone === 'head') mult = down ? 2 : 1.2;
    // his legs are tree trunks: a cut to a standing leg takes off a little over half of what it would elsewhere (it
    // still counts in full toward toppling him), so the fight is won in the knock-down windows, not by chipping
    const legHit = /thigh|shin|foot/.test(zone) && !down;
    let d = dmg * mult * (legHit ? 0.55 : 1);
    if (down) {   // the knock-down's share is capped; when it is spent he heaves himself up early
      d = Math.min(d, Math.max(0, this.downCap() - this.downDmg));
      this.downDmg += d;
      if (this.downDmg >= this.downCap() - 1e-3 && this.state === 'stagger') this.t = Math.max(this.t, this.staggerDur() - 0.5);
    }
    this.hp -= d;
    this.flinchAcc += d;
    // hacking at the legs topples him: down on all fours, the eye comes within reach
    if (legHit) {
      this.legDmg += dmg * mult;
      if (this.legDmg >= (this.phase === 2 ? 280 : 250) && ['hunt', 'flinch', 'stomp', 'sweep'].includes(this.state) && this.hp > 0) {
        this.legDmg = 0; this.knockDown();
        return { dmg: d, weak, zone, topple: true };
      }
    }
    if (weak) this.flash = 1;
    if (!this.clubBroken && this.hp <= this.hpMax * 0.5) this.breakClub();
    if (this.hp <= 0) { this.hp = 0; this.die(); }
    else if (this.flinchAcc > 170 && ['hunt'].includes(this.state)) {
      this.flinchAcc = 0; this.state = 'flinch'; this.t = 0; this.actor.play('hit', { fade: 0.1 });
    }
    return { dmg: d, weak, zone };
  }
  downCap() { return this.hpMax * 0.2; }
  staggerDur() { return [6.0, 4.8, 3.9, 3.3][Math.min(3, Math.max(0, this.downs - 1))]; }
  knockDown() {
    this.downs++; this.downDmg = 0;
    this.state = 'staggerFall'; this.t = 0; this.actor.play('fall', { fade: 0.15 }); this.g.onStagger(this);
  }
  breakClub() {
    this.clubBroken = true; this.enraged = true; this.phase = 2;
    // the rage roar: right away when he stands, or as soon as he is up again if it broke while he was down
    if (['stagger', 'staggerFall'].includes(this.state)) this.pendingRage = true;
    const tip = this.B.clubTip;
    const w = tip.getWorldPosition(new THREE.Vector3());
    if (this.clubHead && this.debrisMesh) {
      // static copy at the exact current transform of the (rigidly skinned) head
      const sm = this.clubHead;
      if (sm.isSkinnedMesh) {
        const bi = sm.skeleton.bones.indexOf(tip);
        _m.copy(tip.matrixWorld).multiply(sm.skeleton.boneInverses[Math.max(0, bi)]).multiply(sm.bindMatrix);
      } else _m.copy(sm.matrixWorld);
      _m.decompose(this.debrisMesh.position, this.debrisMesh.quaternion, this.debrisMesh.scale);
      this.debrisMesh.visible = true; this.clubHead.visible = false;
      const c = new THREE.Box3().setFromObject(this.debrisMesh).getCenter(new THREE.Vector3());
      this.debris = { vel: new THREE.Vector3(rand(-3, 3), 7, rand(-3, 3)), spin: new THREE.Vector3(rand(-3, 3), rand(-2, 2), rand(-3, 3)), resting: false, off: c.sub(this.debrisMesh.position) };
    }
    this.g.onClubBreak(w);
    if (!['stagger', 'staggerFall', 'dying'].includes(this.state)) this.rageRoar();
  }
  rageRoar() {
    this.pendingRage = false; this.state = 'roar'; this.t = 0; this.actor.play('roar', { fade: 0.2 }); this.roared = false; this.rage = true;
  }
  die() {
    this.dead = true; this.state = 'dying'; this.t = 0;
    this.dieYaw = this.fallYaw();
    this.actor.play('death', { fade: 0.25 });
    this.boulder.visible = false;
    for (const r of this.rocks) { r.obj.visible = false; if (r.marker) this.g.fx.removeMarker(r.marker); }
    this.rocks.length = 0; if (this.volley) for (const v of this.volley) v.visible = false;
    this.g.onCyclopsDeath(this);
  }
  // He falls forward, his body 9 m long and his arms 5 m out (measured on cDeath). Turn the fall, by at most 80
  // degrees, toward the ground with the fewest tents, rocks, columns and hulls on it; trees under him are felled.
  fallYaw() {
    const pts = [[0, 2.5], [0, 4], [0, 5.5], [0, 7], [0, 8.5], [3.6, 6], [-3.6, 6], [4.6, 6.8], [-4.6, 6.8]];
    let best = this.yaw, bestS = Infinity;
    for (const off of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4]) {
      const y = this.yaw + off, s = Math.sin(y), c = Math.cos(y);
      let score = Math.abs(off) * 0.25;
      for (const [lx, lz] of pts) {
        const x = this.pos.x + c * lx + s * lz, z = this.pos.z - s * lx + c * lz;
        nearColliders(x, z, 1.8, (o) => { score += o.kind === 'tree' ? 0.1 : o.kind === 'log' ? 0.2 : o.kind === 'tent' ? 3 : 1; });
        if (groundAt(x, z) < -1.2) score += 0.3;            // (a fall into deep water hides the body)
      }
      if (score < bestS - 1e-6) { bestS = score; best = y; }
    }
    this.fallScore = +bestS.toFixed(2);
    return best;
  }
  // Rocks, tents, columns and the beached hull push him out; trees he walks into, swings through or falls on are felled
  // (critic round 1, defect 8: he fought inside olive trees and fell dead through a tent).
  worldContacts() {
    const W = this.g.world; if (!W || !W.fellTree) return;
    const st = this.state;
    if (st === 'sleep' || st === 'waking' || this.intro) return;
    if (!this.dead && this.pos.z > this.home.z + 6) resolve(this.pos, 1.9, this.pos.y + 0.2, (o) => o.kind === 'tree' || o.kind === 'log');
    const fell = this._fell || (this._fell = (o, from) => {
      if (o.kind !== 'tree') return;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      let dx = o.x - from.x, dz = o.z - from.z; const L = Math.hypot(dx, dz) || 1;
      const side = (dx * fz - dz * fx) >= 0 ? 1 : -1;          // and to the side of his path, not into it
      dx = dx / L + fz * side * 0.9; dz = dz / L - fx * side * 0.9;
      if (W.fellTree(o.tree, dx, dz)) this.felled = (this.felled || 0) + 1;
    });
    // trunk at his feet, or a crown his body or arms pass through (olive crowns are ~4 m across, 2-7 m high;
    // cypresses are narrow and 12 m tall)
    const crown = this._crown || (this._crown = (o, from, h) => {
      if (o.kind !== 'tree') return;
      const t = o.tree, R = t.kind === 'cypress_tree' ? 1.6 : 3.1 * t.s, top = t.kind === 'cypress_tree' ? 11.5 * t.s : 6.8 * t.s;
      if (h > top || Math.hypot(o.x - from.x, o.z - from.z) > R) return;
      this._fell(o, from);
    });
    nearColliders(this.pos.x, this.pos.z, 2.1, (o) => fell(o, this.pos));
    const low = st === 'stagger' || st === 'staggerFall' || st === 'recover' || this.dead;
    for (const b of low ? ['hips', 'chest', 'head', 'hand_L', 'hand_R'] : ['hips', 'chest', 'hand_L', 'hand_R']) {
      const w = this.B[b].getWorldPosition(_v), h = w.y - groundAt(w.x, w.z);
      nearColliders(w.x, w.z, 3.8, (o) => crown(o, w, h));
    }
    if (low && W.flattenTents) W.flattenTents(this, ['hips', 'chest', 'head', 'hand_L', 'hand_R'].map((b) => this.B[b].getWorldPosition(new THREE.Vector3())));
  }
  attackChoice(dist, ang) {
    const front = Math.abs(ang) < 0.85, r = Math.random();
    if (dist > 18 && this.time - this.lastThrow > (this.phase === 2 ? 4.5 : 7)) return 'throw';
    if (this.phase === 2 && dist > 10.5 && this.time - this.lastThrow > 6 && r < 0.45) return 'throw';
    if (dist < 7.5) return front && r < 0.3 ? 'slam' : (front && !this.clubBroken && r < 0.65 ? 'sweep' : 'stomp');
    if (dist < 12.5 && front) return r < (this.clubBroken ? 0.55 : 0.65) ? 'slam' : (this.clubBroken ? 'stomp' : 'sweep');
    if (dist > 13 && this.time - this.lastThrow > 10 && r < 0.4) return 'throw';
    return null;
  }
  ev(k) { const e = this.actor.meta; return e.ev ? e.ev[k] : undefined; }
  update(dt) {
    const g = this.g, P = g.player, A = this.actor;
    this.t += dt; this.time += dt;
    const dx = P.pos.x - this.pos.x, dz = P.pos.z - this.pos.z, dist = Math.hypot(dx, dz);
    const toYaw = Math.atan2(dx, dz), ang = wrapAngle(toYaw - this.yaw);
    const turn = this.enraged ? 0.95 : 0.8;
    let want = 0;
    switch (this.state) {
      case 'sleep': break;
      case 'waking': if (A.done) { this.state = 'roar'; this.t = 0; A.play('roar', { fade: 0.25 }); this.roared = false; } break;
      case 'roar':
        if (!this.roared && A.ratio > (this.ev('roarAt') ?? 0.24)) { this.roared = true; g.onRoar(this); if (this.rage && g.onCyclopsCall) { this.calls++; g.onCyclopsCall(this); } }
        if (!this.intro) this.yaw = dampAngle(this.yaw, toYaw, turn, dt);   // a rage roar stays on the hero
        if (A.done) {
          if (this.intro) { this.intro = false; this.state = 'emerge'; this.t = 0; this.cool = 1.2; A.setLoco(0, 0.35); }
          else { this.state = 'hunt'; this.t = 0; this.cool = 0.5; this.rage = false; A.setLoco(0, 0.3); }
        }
        break;
      case 'emerge': { // walk out of the cave onto the open ground before the fight
        const tx = this.home.x, tz = this.home.z + 30, ex = tx - this.pos.x, ez = tz - this.pos.z, ed = Math.hypot(ex, ez);
        this.yaw = dampAngle(this.yaw, Math.atan2(ex, ez), 1.4, dt);
        want = this.walkSpeed;
        if (ed < 3 || this.t > 14 || (dist < 14 && this.t > 4)) { this.state = 'hunt'; this.t = 0; }
        break;
      }
      case 'hunt': {
        if (!P.alive) { A.setLoco(0, 0.4); break; }
        this.yaw = dampAngle(this.yaw, toYaw, turn * 1.5, dt);
        this.cool -= dt;
        const choice = this.cool <= 0 ? this.attackChoice(dist, ang) : null;
        if (choice) { this.startAttack(choice); break; }
        if (dist > 9) want = dist > 26 ? this.runSpeed * (this.enraged ? 1.08 : 1) : this.walkSpeed;
        if (Math.abs(ang) > 1.2) want = Math.min(want, this.walkSpeed * 0.6);
        break;
      }
      case 'flinch': if (A.done) { this.state = 'hunt'; this.cool = 0.8; A.setLoco(0, 0.3); } break;
      case 'stomp':
        if (A.ratio < 0.3) this.yaw = dampAngle(this.yaw, toYaw, turn, dt);
        if (!this.hitDone && A.ratio >= (this.ev('hitAt') ?? 0.5)) {
          this.hitDone = true;
          const f = this.B.foot_R.getWorldPosition(new THREE.Vector3()); f.y = groundAt(f.x, f.z);
          this.ring = g.fx.shockwave(f, this.enraged ? 15 : 13, 0.95);
          g.onImpact(f, 1.0);
        }
        if (this.ring && !this.ring.hitDone && P.alive) {
          const pd = Math.hypot(P.pos.x - this.ring.x, P.pos.z - this.ring.z);
          if (Math.abs(pd - this.ring.r) < 1.15 && this.ring.r > 1) { this.ring.hitDone = true; P.takeDamage(22, { x: this.ring.x, z: this.ring.z }, { heavy: true, knockdown: true, unblockable: true, push: 6 }); }
          if (this.ring.t >= this.ring.dur) this.ring = null;
        }
        if (A.done) this.endAttack();
        break;
      case 'sweep': {
        // wind-up: pivot so the low part of the arc will pass through the hero (aim depends on his distance)
        if (A.ratio < 0.38) this.yaw = dampAngle(this.yaw, toYaw - sweepAim(dist), 3.2, dt);
        if (A.crossed(this.ev('hitStart') ?? SWEEP_ON)) g.audio.swing(this.pos, 2.4);
        this.sweepClub(P, dt);
        if (A.done) this.endAttack();
        break;
      }
      case 'slam': {
        if (A.ratio < 0.36) this.yaw = dampAngle(this.yaw, toYaw, turn * 1.2, dt);
        if (!this.hitDone && A.ratio >= (this.ev('hitAt') ?? 0.62)) {
          this.hitDone = true;
          const hand = this.B.hand_R.getWorldPosition(new THREE.Vector3()), tip = this.B.clubTip.getWorldPosition(new THREE.Vector3());
          const head = this.clubBroken ? hand : tip; head.y = groundAt(head.x, head.z);
          g.onImpact(head, 1.25); g.fx.crater(head, 2.8); g.fx.debris(head, 22, 1);
          if (g.world && g.world.fellTree) { nearColliders(head.x, head.z, 3.0, (o) => { if (o.kind === 'tree') g.world.fellTree(o.tree, o.x - head.x, o.z - head.z); }); g.world.flattenAt(head.x, head.z, 2.0); }
          const pd = Math.hypot(P.pos.x - head.x, P.pos.z - head.z);
          let hit = false;
          if (pd < 3.3 && P.alive) hit = P.takeDamage(34, head, { heavy: true, knockdown: true, push: 7 }) === true;
          if (!hit) this.knockDown();
        }
        if (this.state === 'slam' && A.done) this.endAttack();
        break;
      }
      case 'staggerFall':
        if (!this.fallImpact && A.ratio >= (this.ev('impactAt') ?? 0.72)) { this.fallImpact = true; const p = this.B.chest.getWorldPosition(new THREE.Vector3()); p.y = groundAt(p.x, p.z); g.onImpact(p, 0.9); }
        if (A.done) { this.state = 'stagger'; this.t = 0; this.fallImpact = false; A.play('stagger', { fade: 0.15 }); }
        break;
      case 'stagger':
        if (this.t > this.staggerDur()) { this.state = 'recover'; this.t = 0; A.play('recover', { fade: 0.25 }); }
        break;
      case 'recover': if (A.done) { if (this.pendingRage) this.rageRoar(); else { this.state = 'hunt'; this.cool = 1.0; A.setLoco(0, 0.3); } } break;
      case 'throw': {
        if (A.ratio < 0.55) this.yaw = dampAngle(this.yaw, toYaw, turn, dt);
        // phase 1: one boulder; phase 2: a volley of three smaller rocks, fanned around where the hero is going
        const held = this.phase === 2 ? this.volley : [this.boulder];
        if (!this.grabbed && A.ratio >= (this.ev('grabAt') ?? 0.2)) { this.grabbed = true; this.released = false; for (const o of held) o.visible = true; const hp = this.B.hand_L.getWorldPosition(new THREE.Vector3()); g.fx.dust(hp.setY(groundAt(hp.x, hp.z)), 12, 1, 1.2); }
        if (this.grabbed && !this.released) { this.B.hand_L.updateMatrixWorld(true); held.forEach((o, k) => o.position.copy(_v.set(held.length > 1 ? (k - 1) * 0.4 : 0, -0.2 - (k === 1 ? 0.25 : 0), 0.25).applyMatrix4(this.B.hand_L.matrixWorld))); }
        if (this.grabbed && !this.released && A.ratio >= (this.ev('releaseAt') ?? 0.62)) {
          this.released = true;
          const lead = P.vel.clone().multiplyScalar(0.7);
          const bx = P.pos.x + lead.x, bz = P.pos.z + lead.z, dl = Math.hypot(bx - this.pos.x, bz - this.pos.z) || 1;
          const fx = (bx - this.pos.x) / dl, fz = (bz - this.pos.z) / dl;
          const offs = held.length > 1 ? [[0, 0], [3.4, -1.6], [-3.4, 2.0]] : [[0, 0]];
          held.forEach((o, k) => {
            const from = o.position.clone();
            const tx = bx + fz * offs[k][0] + fx * offs[k][1], tz = bz - fx * offs[k][0] + fz * offs[k][1];
            const to = new THREE.Vector3(tx, 0, tz); to.y = groundAt(tx, tz);
            const T = clamp(from.distanceTo(to) / 22, 1.0, 1.9) + k * 0.14;
            this.rocks.push({ obj: o, from, to, T, t: 0, small: held.length > 1, marker: g.fx.marker(to, held.length > 1 ? 2.8 : 3.8), spin: new THREE.Vector3(rand(-3, 3), rand(-3, 3), rand(-3, 3)) });
          });
          this.lastThrow = this.time; g.audio.swing(this.B.hand_L.getWorldPosition(new THREE.Vector3()), 2.6);
        }
        if (A.done) { this.grabbed = false; this.endAttack(); }
        break;
      }
      case 'dying':
        if (this.dieYaw !== undefined && A.ratio < 0.45) this.yaw = dampAngle(this.yaw, this.dieYaw, 4.5, dt);
        if (!this.impacted && A.ratio >= (this.ev('impactAt') ?? 0.64)) {
          this.impacted = true; const p = this.B.chest.getWorldPosition(new THREE.Vector3()); p.y = groundAt(p.x, p.z);
          g.onImpact(p, 1.6); g.fx.dust(p, 40, 4, 2.2, [0.62, 0.53, 0.4], 2, 2.5);
        }
        break;
    }
    // boulder flight (one boulder, or a volley of three)
    for (let i = this.rocks.length - 1; i >= 0; i--) {
      const k = this.rocks[i], o = k.obj; k.t += dt;
      const u = clamp(k.t / k.T, 0, 1);
      o.position.lerpVectors(k.from, k.to, u);
      o.position.y += Math.sin(Math.PI * u) * (6 + k.T * 3);
      o.rotation.x += k.spin.x * dt; o.rotation.y += k.spin.y * dt;
      if (u >= 1) {
        o.visible = false;
        const R = k.small ? 2.8 : 3.8;
        g.fx.removeMarker(k.marker); g.fx.crater(k.to, k.small ? 2.4 : 3.4); g.fx.debris(k.to, k.small ? 14 : 26, k.small ? 0.8 : 1.2); g.onImpact(k.to, k.small ? 0.85 : 1.3);
        if (g.world && g.world.fellTree) { nearColliders(k.to.x, k.to.z, R * 0.7, (c) => { if (c.kind === 'tree') g.world.fellTree(c.tree, c.x - k.to.x, c.z - k.to.z); }); g.world.flattenAt(k.to.x, k.to.z, k.small ? 1.6 : 2.2); }
        if (P.alive && Math.hypot(P.pos.x - k.to.x, P.pos.z - k.to.z) < R) P.takeDamage(k.small ? 20 : 30, k.to, { heavy: true, knockdown: true, push: k.small ? 6 : 7 });
        this.rocks.splice(i, 1);
      }
    }
    // club debris
    if (this.debris && !this.debris.resting) {
      const d = this.debris, m = this.debrisMesh;
      d.vel.y -= 18 * dt;
      m.position.addScaledVector(d.vel, dt);
      m.rotation.x += d.spin.x * dt; m.rotation.z += d.spin.z * dt;
      const c = m.position.clone().add(d.off), gy = groundAt(c.x, c.z) + 0.5;
      if (c.y < gy) {
        m.position.y += gy - c.y;
        if (Math.abs(d.vel.y) > 3) { d.vel.y *= -0.25; d.vel.x *= 0.4; d.vel.z *= 0.4; d.spin.multiplyScalar(0.3); g.onImpact(c, 0.5); }
        else d.resting = true;
      }
    }
    // locomotion: the walk / run blend is stride-locked, so the speed is the clip's own
    if (this.state === 'hunt' || this.state === 'emerge') {
      this.speed = damp(this.speed, want, 1.6, dt);
      A.setLoco(this.speed, 0.4);
      this.pos.x += Math.sin(this.yaw) * this.speed * dt; this.pos.z += Math.cos(this.yaw) * this.speed * dt;
    } else this.speed = damp(this.speed, 0, 4, dt);
    // once out, the cave is too low for the fight: stay on the open ground
    if (this.state !== 'sleep' && this.state !== 'waking' && this.state !== 'roar' && this.state !== 'emerge') {
      if (this.pos.z < this.home.z + 9) this.pos.z = this.home.z + 9;
      const r = Math.hypot(this.pos.x, this.pos.z); if (r > 128) { this.pos.x *= 128 / r; this.pos.z *= 128 / r; }
    }
    this.worldContacts();
    this.pos.y = groundAt(this.pos.x, this.pos.z);
    this.place();
    A.update(dt);
    if (this.state === 'staggerFall' || this.state === 'stagger' || this.state === 'recover' || this.state === 'dying') this.groundFix(dt);
    else this.gLift = 0;
    for (const e of A.events) if (this.speed > 0.4 || this.state === 'stomp') {
      const f = this.B[e.side === 0 ? 'foot_L' : 'foot_R'].getWorldPosition(new THREE.Vector3()); f.y = groundAt(f.x, f.z);
      g.onFootfall(f);
    }
    // the eye follows the hero (bone +Y is the line of sight), at most ~35 degrees
    if (!this.dead && this.awake) {
      const eye = this.B.eye;
      eye.quaternion.copy(this.eyeRest || (this.eyeRest = eye.quaternion.clone()));
      eye.updateMatrixWorld(true);
      const wp = eye.getWorldPosition(new THREE.Vector3());
      const dir = new THREE.Vector3(P.pos.x, P.pos.y + 1.6, P.pos.z).sub(wp).normalize();
      eye.parent.getWorldQuaternion(_q);
      const local = dir.applyQuaternion(_q.invert());
      const restDir = new THREE.Vector3(0, 1, 0).applyQuaternion(this.eyeRest);
      let q = new THREE.Quaternion().setFromUnitVectors(restDir, local);
      const a = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      if (a > 0.61) q = new THREE.Quaternion().slerp(q, 0.61 / a);
      eye.quaternion.premultiply(q);
    }
    // only the struck eye reddens for a moment; a whole-body emissive flash flattened the giant into a beige cut-out
    this.flash = Math.max(0, (this.flash || 0) - dt * 4);
    if (this.eyeMat) this.eyeMat.emissive.setRGB(0.9 * this.flash, 0.12 * this.flash, 0.08 * this.flash);
    this.actor.root.updateMatrixWorld(true);
    this.updateZones(); this.updateBody();
  }
  // On all fours and in death his shins, toes and fingers went up to 1.3 m into the beach (critic round 2, defect 6):
  // the body is lifted by the deepest of shins / hips / chest / head / hands, then each foot and hand turns so no
  // toe or finger joint stays under the surface.
  groundFix(dt) {
    const B = this.B, R = this.actor.root;
    R.updateMatrixWorld(true);
    let low = 0;
    for (const n of ['shin_L', 'shin_R', 'hips', 'chest', 'head', 'hand_L', 'hand_R', 'foreArm_L', 'foreArm_R']) {
      const b = B[n]; if (!b) continue; b.getWorldPosition(_v); low = Math.min(low, _v.y - groundAt(_v.x, _v.z));
    }
    const want = Math.min(0.7, Math.max(0, -low - 0.05));
    this.gLift = (this.gLift || 0) + clamp(want - (this.gLift || 0), -2 * dt, 3 * dt);
    if (this.gLift > 1e-3) { R.position.y += this.gLift; R.updateMatrixWorld(true); }
    if (!this.digits) {
      const tips = (re) => Object.keys(B).filter((n) => re.test(n)).map((n) => B[n]);
      this.digits = [[B.foot_L, tips(/LLegDigit\d2/)], [B.foot_R, tips(/RLegDigit\d2/)], [B.hand_L, tips(/LArmDigit\d3/)], [B.hand_R, tips(/RArmDigit\d3/)]].filter(([j, t]) => j && t.length);
    }
    for (const [joint, tips] of this.digits) {
      let worst = null, wd = 0.04;
      for (const t of tips) { t.getWorldPosition(_v); const d = groundAt(_v.x, _v.z) + 0.06 - _v.y; if (d > wd) { wd = d; worst = t; } }
      if (!worst) continue;
      const j = joint.getWorldPosition(_ch), tp = worst.getWorldPosition(_ct);
      const vx = tp.x - j.x, vy = tp.y - j.y, vz = tp.z - j.z, L = Math.hypot(vx, vy, vz); if (L < 1e-3) continue;
      const ty = clamp((groundAt(tp.x, tp.z) + 0.06 - j.y) / L, -1, 1), hl = Math.hypot(vx, vz), h = Math.sqrt(Math.max(0, 1 - ty * ty));
      const fx = hl > 1e-3 ? vx / hl : Math.sin(this.yaw), fz = hl > 1e-3 ? vz / hl : Math.cos(this.yaw);
      _sh.set(vx / L, vy / L, vz / L); _se.set(fx * h, ty, fz * h);
      _q.setFromUnitVectors(_sh, _se);
      this.actor.saveBone(joint);
      joint.parent.getWorldQuaternion(_q2); joint.getWorldQuaternion(_q3);
      joint.quaternion.copy(_q2.invert().multiply(_q.multiply(_q3)));
      joint.updateMatrixWorld(true);
    }
  }
  // The club as a swept segment (hand -> head), like the sword: between the last frame and this one, 4 sub-steps x
  // 11 points along the shaft against the hero's body (a 0.1-1.9 m vertical axis). Hits only while the club is moving
  // fast inside the swing, so the slow rise and the resting club do no damage. The knock-down follows the club.
  sweepClub(P, dt) {
    const A = this.actor, r = A.ratio;
    const hand = this.B.hand_R.getWorldPosition(_ch), tip = this.B.clubTip.getWorldPosition(_ct);
    const end = _ce.copy(hand).lerp(tip, this.clubBroken ? 1.0 : 1.15);
    const pc = this.prevClub;
    if (pc && pc.ok && !this.hitDone && P.alive && dt > 0 && r > SWEEP_ON && r < SWEEP_OFF) {
      const speed = end.distanceTo(pc.end) / dt;
      if (speed > 8) {
        let hit = null;
        for (let s = 1; s <= 4 && !hit; s++) {
          const u = s / 4;
          _sh.copy(pc.hand).lerp(hand, u); _se.copy(pc.end).lerp(end, u);
          for (let k = 0; k <= 10; k++) {
            _sp.copy(_sh).lerp(_se, k / 10);
            const y0 = P.pos.y + 0.1, y1 = P.pos.y + 1.9;
            const dy = _sp.y < y0 ? y0 - _sp.y : _sp.y > y1 ? _sp.y - y1 : 0;
            if (Math.hypot(_sp.x - P.pos.x, _sp.z - P.pos.z, dy) < 0.85) { hit = _sp.clone(); break; }
          }
        }
        if (hit) {
          this.hitDone = true;
          const vx = end.x - pc.end.x, vz = end.z - pc.end.z, vl = Math.hypot(vx, vz) || 1;
          // "from" is behind the hero along the club's travel, so the blow throws him the way the club moves
          const res = P.takeDamage(26, { x: P.pos.x - (vx / vl) * 2, z: P.pos.z - (vz / vl) * 2 }, { heavy: true, knockdown: true, push: 8 });
          if (res) { this.g.fx.dust(hit, 10, 0.8, 0.9, [0.62, 0.53, 0.4], 0.8, 1.2); this.g.audio.boom(hit, 0.7); this.g.hitstop(0.09); }
          this.lastSweepHit = { ratio: +r.toFixed(3), res };
        }
      }
    }
    // the club passing through a tree (below its crown) fells it
    if (pc && pc.ok && r > SWEEP_ON && r < SWEEP_OFF && this._fell) {
      for (let k = 2; k <= 10; k += 2) {
        _sp.copy(hand).lerp(end, k / 10);
        if (_sp.y - this.pos.y < 6) nearColliders(_sp.x, _sp.z, 0.9, (o) => this._fell(o, _sp));
      }
    }
    if (!this.prevClub) this.prevClub = { hand: new THREE.Vector3(), end: new THREE.Vector3(), ok: false };
    this.prevClub.hand.copy(hand); this.prevClub.end.copy(end); this.prevClub.ok = true;
  }
  startAttack(kind) {
    this.state = kind; this.t = 0; this.hitDone = false; this.grabbed = false;
    if (this.prevClub) this.prevClub.ok = false;
    this.actor.play(kind, { fade: 0.25 });
    if (kind === 'stomp' || kind === 'slam') this.g.audio.growl(this.pos);
  }
  endAttack() {
    this.state = 'hunt';
    this.cool = (this.enraged ? 0.9 : 1.5) + rand(0, 1.0);
    this.actor.setLoco(0, 0.35);
  }
}
