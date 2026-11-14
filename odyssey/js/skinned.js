// Character asset preparation (load time, once per type):
//  - clip masks (left-arm shield layer), clip analysis (natural speed, foot contacts) on the real skeleton
//  - merging a rigged character + its bone-attached gear into ONE SkinnedMesh with a runtime texture atlas
//    (colour / normal / roughness-metalness), so a crowd costs one draw call per soldier
//  - a vertex-clustered far LOD of the merged geometry
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { DITHER } from './env.js';

// ---------------------------------------------------------------- clip masks
export const LEFT_ARM_RE = /^(clavicle_l|upperarm_l|lowerarm_l|hand_l|(index|middle|ring|pinky|thumb)_0\d(_leaf)?_l)\./;
const derived = new Map();
export function noLeftArm(clip) {
  const k = clip.uuid + ':noL';
  if (!derived.has(k)) { const c = clip.clone(); c.tracks = c.tracks.filter((t) => !LEFT_ARM_RE.test(t.name)); c.name = clip.name + '__noL'; derived.set(k, c); }
  return derived.get(k);
}
export function leftArmOnly(clip) {
  const k = clip.uuid + ':L';
  if (!derived.has(k)) { const c = clip.clone(); c.tracks = c.tracks.filter((t) => LEFT_ARM_RE.test(t.name)); c.name = clip.name + '__L'; derived.set(k, c); }
  return derived.get(k);
}
// sub-clip by time range (seconds), keeping all tracks
export function subClip(clip, name, t0, t1) {
  const c = clip.clone(); c.name = name;
  c.tracks = c.tracks.map((tr) => {
    const t = tr.clone(); t.trim(t0, t1); t.shift(-t0); return t;
  });
  c.duration = t1 - t0;
  return c;
}

// ---------------------------------------------------------------- load-time clip guard
// The first bake of anim_male.glb ended Death01 / Hit_Knockback_RM / Idle_Shield_Break on rest-pose (T-pose) keys
// and every one-shot clip on a copy of its first frame (bake bug, fixed and re-baked 2026-11-14). This guard keeps a
// bad file from ever reaching the screen again: trailing keys whose pelvis sits exactly at the rig's rest transform
// are cut, and a one-shot clip whose last key jumps back to its first frame loses that key. Returns what it did.
export function sanitizeClip(clip, restPelvis, { loop = false, bone = 'pelvis' } = {}) {
  const tp = clip.tracks.find((t) => t.name === bone + '.position'), tq = clip.tracks.find((t) => t.name === bone + '.quaternion');
  if (!tp || !tq || tp.times.length < 4) return null;
  const n = tp.times.length, P = tp.values, Q = tq.values, rp = restPelvis.p, rq = restPelvis.q;
  const atRest = (i) => {
    const k = Math.min(i, tq.times.length - 1);
    return Math.abs(P[i * 3] - rp.x) < 2e-3 && Math.abs(P[i * 3 + 1] - rp.y) < 2e-3 && Math.abs(P[i * 3 + 2] - rp.z) < 2e-3 &&
      Math.abs(Math.abs(Q[k * 4] * rq.x + Q[k * 4 + 1] * rq.y + Q[k * 4 + 2] * rq.z + Q[k * 4 + 3] * rq.w) - 1) < 2e-5;
  };
  let end = n - 1, why = null;
  // a frame-0 copy as the very last key (LoopRepeat wrap at t = duration in the bake)
  const same0 = (i) => Math.abs(P[i * 3] - P[0]) < 1e-6 && Math.abs(P[i * 3 + 1] - P[1]) < 1e-6 && Math.abs(P[i * 3 + 2] - P[2]) < 1e-6;
  const jump = (i) => Math.hypot(P[i * 3] - P[(i - 1) * 3], P[i * 3 + 1] - P[(i - 1) * 3 + 1], P[i * 3 + 2] - P[(i - 1) * 3 + 2]);
  // (a one-frame teleport back to the start; a clip that eases back to its start pose over several keys is kept)
  if (!loop && same0(end) && tp.times[end] - tp.times[end - 1] < 0.05 && jump(end) > 0.05) { end--; why = 'frame0-tail'; }
  // trailing rest-pose run (only when the clip did not start at rest, i.e. the rest keys are not real motion)
  if (!atRest(0)) { let k = end; while (k > 0 && atRest(k)) k--; if (k < end) { end = k; why = (why ? why + '+' : '') + 'rest-tail'; } }
  if (end === n - 1) return null;
  const tEnd = tp.times[end], tWas = tp.times[n - 1];
  for (const t of clip.tracks) { t.trim(0, tEnd + 1e-4); }
  clip.duration = tEnd;
  return { why, from: +tWas.toFixed(3), to: +tEnd.toFixed(3) };
}

// ---------------------------------------------------------------- root motion
// The UAL clips carry forward motion on the 'root' bone (one axis), cut from long takes: a combo segment starts
// where the previous ended, some _RM clips snap back to 0 near the end, some have single-frame drop-outs.
// We zero the root track (clip plays in place) and keep a cleaned, world-axis displacement curve that the
// controller applies, so attack lunges, rolls and knock-backs move the body exactly as far as the feet do.
export function extractRootMotion(clip, { rootName = 'root', axis = null, maxSpeed = 40 } = {}) {
  const tr = clip.tracks.find((t) => t.name === rootName + '.position');
  const out = clip.clone(); out.name = clip.name;
  if (!tr) return { clip: out, rm: null };
  const n = tr.times.length, v = tr.values;
  // local root axis -> character-space (x, z); axis = { x: [ax, az], y: [..], z: [..] } measured by FK
  const A = axis || { x: [1, 0], y: [0, 0], z: [0, 1] };
  const px = new Float32Array(n), pz = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const lx = v[k * 3], ly = v[k * 3 + 1], lz = v[k * 3 + 2];
    px[k] = lx * A.x[0] + ly * A.y[0] + lz * A.z[0];
    pz[k] = lx * A.x[1] + ly * A.y[1] + lz * A.z[1];
  }
  // clean: the baked root tracks drop to exactly the start value (0) in single frames or for the rest of the clip
  // after the body has moved; such keys are invalid -> interpolated (drop-out) or held (snap at the end)
  const valid = new Uint8Array(n); valid[0] = 1;
  let far = 0;
  for (let k = 1; k < n; k++) {
    const r = Math.hypot(px[k] - px[0], pz[k] - pz[0]);
    const prev = Math.hypot(px[k - 1] - px[0], pz[k - 1] - pz[0]);
    const snap = r < 1e-5 && far > 0.05;
    const tele = Math.hypot(px[k] - px[k - 1], pz[k] - pz[k - 1]) / Math.max(1e-3, tr.times[k] - tr.times[k - 1]) > maxSpeed && r < 0.25 * prev;
    if (!snap && !tele) { valid[k] = 1; far = Math.max(far, r); }
  }
  const cx = new Float32Array(n), cz = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (valid[k]) { cx[k] = px[k]; cz[k] = pz[k]; continue; }
    let a = k - 1; while (a > 0 && !valid[a]) a--;
    let b = k + 1; while (b < n && !valid[b]) b++;
    if (b >= n) { cx[k] = px[a]; cz[k] = pz[a]; }
    else { const u = (tr.times[k] - tr.times[a]) / (tr.times[b] - tr.times[a]); cx[k] = px[a] + (px[b] - px[a]) * u; cz[k] = pz[a] + (pz[b] - pz[a]) * u; }
  }
  for (let k = n - 1; k >= 0; k--) { cx[k] -= cx[0]; cz[k] -= cz[0]; }
  // in-place clip: root position held at the origin
  out.tracks = out.tracks.map((t) => {
    if (t !== out.tracks.find((q) => q.name === tr.name)) return t;
    const c = t.clone(); c.values = new Float32Array(c.values.length); return c;
  });
  const total = Math.hypot(cx[n - 1], cz[n - 1]);
  let maxD = 0; for (let k = 0; k < n; k++) maxD = Math.max(maxD, Math.hypot(cx[k], cz[k]));
  return { clip: out, rm: maxD > 0.05 ? { times: Float32Array.from(tr.times), x: cx, z: cz, total, maxD } : null };
}
// displacement (character space) of a root-motion curve at time t
export function rmAt(rm, t, out) {
  const T = rm.times, n = T.length;
  if (t <= T[0]) { out.x = rm.x[0]; out.z = rm.z[0]; return out; }
  if (t >= T[n - 1]) { out.x = rm.x[n - 1]; out.z = rm.z[n - 1]; return out; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  const u = (t - T[lo]) / (T[hi] - T[lo]);
  out.x = rm.x[lo] + (rm.x[hi] - rm.x[lo]) * u; out.z = rm.z[lo] + (rm.z[hi] - rm.z[lo]) * u;
  return out;
}
// which character-space direction does a unit move of the root bone's local x / y / z produce?
export function measureRootAxes(root, rootName = 'root') {
  const b = root.getObjectByName(rootName);
  const p0 = b.position.clone(), w0 = new THREE.Vector3(), w1 = new THREE.Vector3(), out = {};
  root.updateMatrixWorld(true); b.getWorldPosition(w0);
  for (const ax of ['x', 'y', 'z']) {
    b.position.copy(p0); b.position[ax] += 1; root.updateMatrixWorld(true); b.getWorldPosition(w1);
    out[ax] = [+(w1.x - w0.x).toFixed(4), +(w1.z - w0.z).toFixed(4), +(w1.y - w0.y).toFixed(4)];
  }
  b.position.copy(p0); root.updateMatrixWorld(true);
  return out;   // [dx, dz, dy] per local axis
}

// ---------------------------------------------------------------- clip analysis
// Samples a clip on a clone of the real skeleton. Each side's ground point is whichever of heel (foot) and toe
// (ball) is nearer its lowest height; the natural speed of an in-place loop is the velocity of that point while it
// is planted (the planted foot moves backward exactly as fast as the body should move forward). Contacts are the
// moments a side comes down onto the ground (hysteresis 2 cm / 6 cm).
export function analyseClip(root, clip, { sides = [['foot_l', 'ball_l'], ['foot_r', 'ball_r']], n = 120, ground = null, cyclic = false } = {}) {
  const mixer = new THREE.AnimationMixer(root);
  const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
  const bones = sides.map((s) => s.map((nm) => root.getObjectByName(nm)).filter(Boolean));
  const Y = bones.map((s) => s.map(() => [])), Z = bones.map((s) => s.map(() => []));
  const v = new THREE.Vector3();
  const dur = clip.duration;
  for (let i = 0; i <= n; i++) {
    mixer.setTime((i / n) * dur * 0.9999); root.updateMatrixWorld(true);
    bones.forEach((s, k) => s.forEach((b, j) => { b.getWorldPosition(v); Y[k][j].push(v.y); Z[k][j].push(v.z); }));
  }
  a.stop(); mixer.uncacheClip(clip); mixer.uncacheRoot(root);
  const dt = dur * 0.9999 / n;
  // ground offset of each bone = its height when standing (from a reference clip), else its own minimum
  const off = bones.map((s, k) => s.map((b, j) => (ground && ground[k] && ground[k][j] !== undefined) ? ground[k][j] : Math.min(...Y[k][j])));
  let sw = 0, sv = 0;
  const contacts = [];
  bones.forEach((s, k) => {
    const H = [];
    for (let i = 0; i <= n; i++) {
      let best = 1e9, bj = 0;
      s.forEach((b, j) => { const h = Y[k][j][i] - off[k][j]; if (h < best) { best = h; bj = j; } });
      H.push(best);
      if (i > 0 && best < 0.025) {
        const vz = (Z[k][bj][i] - Z[k][bj][i - 1]) / dt;
        const w = 1 - best / 0.025;
        sw += w; sv += w * vz;
      }
    }
    // touch-down = the side comes down through 20 % of its own lift range (after having risen past 50 %);
    // relative thresholds keep left and right symmetric even when one foot lands flatter than the other.
    // Cyclic for loops (a plant at the wrap is found), linear for one-shots.
    const hmin = Math.min(...H), hmax = Math.max(...H), rng = hmax - hmin;
    if (rng > 0.06) {
      const thr = hmin + 0.2 * rng, hi = hmin + 0.5 * rng;
      let up = cyclic ? false : H[0] > hi;
      for (let i = 1; i <= (cyclic ? 2 * n : n); i++) {
        const h = H[i % n];
        if (h > hi) up = true;
        if (up && h < thr) { if (!cyclic || i > n) contacts.push({ t: (i % n) / n, side: k }); up = false; }
      }
    }
  });
  contacts.sort((p, q) => p.t - q.t);
  // natural speed = how far the planted foot travels backward while it is down, per second it is down: each side's
  // stance is the run of samples in which min(heel, toe) is within 2.5 cm of its own lowest height in this clip, and
  // the speed is the summed ball travel over the summed stance time. (The first estimate weighted only the samples
  // near the IDLE standing height; a walking foot rarely sinks that low, so the toe-off push dominated and the feet
  // slid 11-15 cm per step, critic round 1 defect 7. A median of mid-stance velocities over-shoots instead.)
  let speed = sw > 0 ? Math.max(0, -sv / sw) : 0;
  if (cyclic) {
    let dist = 0, time = 0;
    bones.forEach((s, k) => {
      const N = n;   // samples 0..n-1 cover the cycle once (sample n == sample 0)
      const h = []; for (let i = 0; i < N; i++) { let m = 1e9; s.forEach((b, j) => { m = Math.min(m, Y[k][j][i]); }); h.push(m); }
      const hmin = Math.min(...h), on = h.map((v) => v < hmin + 0.025);
      const jb = s.length - 1;   // ball (or the only foot bone)
      let i0 = on.findIndex((v) => !v); if (i0 < 0) return;
      let runStart = -1;
      for (let q = 1; q <= N; q++) {
        const i = (i0 + q) % N;
        if (on[i] && runStart < 0) runStart = q;
        if ((!on[i] || q === N) && runStart >= 0) {
          const a = (i0 + runStart) % N, bq = on[i] ? q : q - 1, b = (i0 + bq) % N;
          const steps = bq - runStart;
          if (steps >= 2) { let dz = Z[k][jb][a] - Z[k][jb][b]; dist += dz; time += steps * dt; }
          runStart = -1;
        }
      }
    });
    if (time > 0.02 && dist > 0) speed = dist / time;
  }
  return { speed, contacts, duration: dur, standing: bones.map((s, k) => s.map((b, j) => Y[k][j][0])) };
}

// ---------------------------------------------------------------- atlas helpers
function drawRegion(ctx, img, x, y, s, g, tile) {
  // draws img scaled into the square (x,y,s) with a gutter g on every side; the gutter repeats the
  // image (wrap) so mip-mapped tiling materials do not bleed neighbours in
  ctx.save();
  ctx.beginPath(); ctx.rect(x - g, y - g, s + 2 * g, s + 2 * g); ctx.clip();
  const reps = tile ? [-1, 0, 1] : [0];
  for (const dy of reps) for (const dx of reps) ctx.drawImage(img, x + dx * s, y + dy * s, s, s);
  if (!tile) { // clamp-extend the edges
    ctx.drawImage(img, 0, 0, img.width, 1, x, y - g, s, g);
    ctx.drawImage(img, 0, img.height - 1, img.width, 1, x, y + s, s, g);
    ctx.drawImage(img, 0, 0, 1, img.height, x - g, y, g, s);
    ctx.drawImage(img, img.width - 1, 0, 1, img.height, x + s, y, g, s);
  }
  ctx.restore();
}
function fillRegion(ctx, css, x, y, s, g) { ctx.fillStyle = css; ctx.fillRect(x - g, y - g, s + 2 * g, s + 2 * g); }
const imgOf = (t) => (t && t.image ? t.image : null);

// gather drawable parts of a character: skinned meshes (geometry in bind space) + rigid gear (as bone-rigid skin)
function collectParts(src, { hide = null, gear = [], gearSrc = {}, attach = {}, boneIndex, skeleton }) {
  const parts = [];
  src.updateMatrixWorld(true);
  src.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    if (hide && hide.test(o.name)) return;
    if (o.visible === false) return;
    const g = o.geometry;
    // remap this mesh's joint indices into the shared skeleton's bone order (by bone name)
    const map = o.skeleton.bones.map((b) => boneIndex.get(b.name));
    parts.push({ kind: 'skin', geo: g, mat: o.material, M: o.bindMatrix.clone(), jointMap: map, name: o.name });
  });
  for (const name of gear) {
    const e = attach[name], node = gearSrc[name];
    if (!e || !node) continue;
    const bi = boneIndex.get(e.bone);
    if (bi === undefined) continue;
    const ibmInv = skeleton.boneInverses[bi].clone().invert();
    const n = node.clone(true);
    n.position.fromArray(e.position); n.quaternion.fromArray(e.quaternion); n.scale.set(1, 1, 1);
    n.updateMatrixWorld(true);
    n.traverse((m) => {
      if (!m.isMesh) return;
      parts.push({ kind: 'rigid', geo: m.geometry, mat: m.material, M: ibmInv.clone().multiply(m.matrixWorld), bone: bi, name: name + '/' + m.name });
    });
  }
  return parts;
}

// Merge a rigged glTF scene + gear into one SkinnedMesh with one atlas material.
// Returns { template } : an Object3D (bones + 1 SkinnedMesh) to SkeletonUtils.clone per instance.
export function buildMergedCharacter(gltfScene, { hide = null, gear = [], gearSrc = {}, attach = {}, tints = [], atlasSize = 2048, name = 'merged' } = {}) {
  const root = SkeletonUtils.clone(gltfScene);
  let skel = null;
  root.traverse((o) => { if (o.isSkinnedMesh && !skel) skel = o.skeleton; });
  const boneIndex = new Map(skel.bones.map((b, i) => [b.name, i]));
  const parts = collectParts(root, { hide, gear, gearSrc, attach, boneIndex, skeleton: skel });

  // ---- regions: one per unique (map, normal, mr, factor) material
  const regions = new Map();
  for (const p of parts) {
    const m = p.mat;
    const key = [m.map && m.map.uuid, m.normalMap && m.normalMap.uuid, m.roughnessMap && m.roughnessMap.uuid, m.roughness.toFixed(2), m.metalness.toFixed(2)].join('|');
    if (!regions.has(key)) {
      const src = imgOf(m.map);
      const size = !src ? 16 : (src.width >= 2048 && !/hair/i.test(m.name)) ? 1024 : (/eye/i.test(m.name) ? 128 : 256);
      regions.set(key, { key, m, size, x: 0, y: 0 });
    }
    p.region = regions.get(key);
  }
  // shelf packing (largest first), 8 px gutters
  const G = 8, list = [...regions.values()].sort((a, b) => b.size - a.size);
  let cx = G, cy = G, shelfH = 0;
  for (const r of list) {
    if (cx + r.size + G > atlasSize) { cx = G; cy += shelfH + 2 * G; shelfH = 0; }
    r.x = cx; r.y = cy; cx += r.size + 2 * G; shelfH = Math.max(shelfH, r.size);
  }
  if (cy + shelfH + G > atlasSize) console.warn('atlas overflow', name);
  const mk = (s) => { const c = document.createElement('canvas'); c.width = c.height = s; return c; };
  const cC = mk(atlasSize), cN = mk(atlasSize), cR = mk(atlasSize / 2);
  const xC = cC.getContext('2d'), xN = cN.getContext('2d'), xR = cR.getContext('2d');
  xN.fillStyle = 'rgb(128,128,255)'; xN.fillRect(0, 0, atlasSize, atlasSize);
  for (const r of list) {
    const m = r.m, tile = true;
    const cimg = imgOf(m.map);
    if (cimg) drawRegion(xC, cimg, r.x, r.y, r.size, G, tile); else fillRegion(xC, '#ffffff', r.x, r.y, r.size, G);
    const nimg = imgOf(m.normalMap);
    if (nimg) drawRegion(xN, nimg, r.x, r.y, r.size, G, tile);
    const h = 0.5, rimg = imgOf(m.roughnessMap);
    const rx = r.x * h, ry = r.y * h, rs = r.size * h, rg = G * h;
    if (rimg) {
      drawRegion(xR, rimg, rx, ry, rs, rg, tile);
      xR.save(); xR.globalCompositeOperation = 'multiply';
      fillRegion(xR, `rgb(255,${Math.round(255 * m.roughness)},${Math.round(255 * m.metalness)})`, rx, ry, rs, rg);
      xR.restore();
    } else fillRegion(xR, `rgb(255,${Math.round(255 * m.roughness)},${Math.round(255 * m.metalness)})`, rx, ry, rs, rg);
  }
  const tex = (c, srgb) => {
    const t = new THREE.CanvasTexture(c); t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t;
  };
  const mapT = tex(cC, true), norT = tex(cN, false), ormT = tex(cR, false);

  // ---- merged geometry
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.geo.attributes.position.count; ni += p.geo.index ? p.geo.index.count : p.geo.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
  const sIdx = new Uint16Array(nv * 4), sW = new Float32Array(nv * 4), atl = new Float32Array(nv * 4), part = new Float32Array(nv);
  const index = new Uint32Array(ni);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3(), c = new THREE.Color();
  let vo = 0, io = 0;
  parts.forEach((p, pi) => {
    const g = p.geo, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color;
    const SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
    nm.getNormalMatrix(p.M);
    const r = p.region, has = !!imgOf(p.mat.map);
    // tiling detection (UVs beyond [0,1])
    let tiled = false;
    if (U) for (let i = 0; i < U.count; i++) { const a = U.getX(i), b = U.getY(i); if (a < -0.01 || a > 1.01 || b < -0.01 || b > 1.01) { tiled = true; break; } }
    const ox = r.x / atlasSize, oy = r.y / atlasSize, sc = has ? r.size / atlasSize : 0;
    const base = p.mat.color || c.setRGB(1, 1, 1);
    let tint = null;
    for (const t of tints) if (t.re.test(p.mat.name)) tint = t.rgb;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(p.M);
      pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
      if (N) { v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nor[(vo + i) * 3] = v.x; nor[(vo + i) * 3 + 1] = v.y; nor[(vo + i) * 3 + 2] = v.z; }
      if (U) { uv[(vo + i) * 2] = U.getX(i); uv[(vo + i) * 2 + 1] = U.getY(i); }
      let cr = base.r, cg = base.g, cb = base.b;
      if (C) { cr *= C.getX(i); cg *= C.getY(i); cb *= C.getZ(i); }
      if (tint) { cr *= tint[0]; cg *= tint[1]; cb *= tint[2]; }
      col[(vo + i) * 3] = cr; col[(vo + i) * 3 + 1] = cg; col[(vo + i) * 3 + 2] = cb;
      if (p.kind === 'skin') {
        for (let k = 0; k < 4; k++) {
          const j = SI.getComponent(i, k), w = SW.getComponent(i, k);
          sIdx[(vo + i) * 4 + k] = w > 0 ? (p.jointMap[j] ?? 0) : 0; sW[(vo + i) * 4 + k] = w;
        }
      } else { sIdx[(vo + i) * 4] = p.bone; sW[(vo + i) * 4] = 1; }
      atl[(vo + i) * 4] = ox; atl[(vo + i) * 4 + 1] = oy; atl[(vo + i) * 4 + 2] = sc; atl[(vo + i) * 4 + 3] = tiled ? 1 : 0;
      part[vo + i] = pi;
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) index[io + i] = g.index.getX(i) + vo;
    else for (let i = 0; i < P.count; i++) index[io + i] = vo + i;
    vo += P.count; io += g.index ? g.index.count : P.count;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(sIdx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sW, 4));
  geo.setAttribute('aAtlas', new THREE.BufferAttribute(atl, 4));
  geo.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1.6);

  const material = makeAtlasMaterial(mapT, norT, ormT);
  // where the black aspis sits in this atlas (its painted device is replaced per soldier in the shader)
  { const sp = parts.find((p) => p.mat && /aspis_black/.test(p.mat.name) && p.region && imgOf(p.mat.map));
    if (sp) material.userData.uniforms.uShieldRect.value.set(sp.region.x / atlasSize, sp.region.y / atlasSize, sp.region.size / atlasSize); }
  // template: bones of the cloned scene + the merged mesh (old meshes removed)
  const old = []; root.traverse((o) => { if (o.isMesh) old.push(o); });
  for (const o of old) o.parent.remove(o);
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.name = name;
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(skel.bones, skel.boneInverses), new THREE.Matrix4());
  mesh.frustumCulled = true;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1.6);
  return { template: root, geometry: geo, material, atlas: { map: mapT, normal: norT, orm: ormT, canvas: cC }, parts: parts.map((p) => p.name), tris: index.length / 3 };
}

// Six shield devices of the period as distance fields in the field's unit disc: lambda, crescent, eight-rayed star,
// trident, the apotropaic eye, the wheel
const EMBLEM_GLSL = `
float eSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float emblemSDF(vec2 q, float id) {
  if (id < 0.5) return min(eSeg(q, vec2(-0.46, -0.55), vec2(0.0, 0.62)), eSeg(q, vec2(0.0, 0.62), vec2(0.46, -0.55))) - 0.1;
  if (id < 1.5) return max(length(q) - 0.64, -(length(q - vec2(0.24, 0.14)) - 0.56));
  if (id < 2.5) { float a = atan(q.y, q.x), r = length(q), s = 6.2831853 / 8.0; float ray = abs(fract(a / s + 0.5) - 0.5) * s * r; return min(r - 0.2, max(ray - 0.055, r - 0.74)); }
  if (id < 3.5) { float d = min(eSeg(q, vec2(0.0, -0.72), vec2(0.0, 0.66)), eSeg(q, vec2(-0.4, 0.18), vec2(0.4, 0.18))); d = min(d, min(eSeg(q, vec2(-0.4, 0.18), vec2(-0.4, 0.6)), eSeg(q, vec2(0.4, 0.18), vec2(0.4, 0.6)))); return d - 0.07; }
  if (id < 4.5) { float r = length(q * vec2(1.0, 1.7)); return min(abs(r - 0.62) - 0.07, length(q) - 0.16); }
  float r = length(q); return min(abs(r - 0.6) - 0.075, max(min(abs(q.x), abs(q.y)) - 0.05, r - 0.6));
}`;

// MeshStandardMaterial that samples three atlases with per-vertex rectangles (tiling via fract + textureGrad,
// so mips never jump at the wrap seam).
export function makeAtlasMaterial(map, normalMap, orm) {
  const mat = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1, vertexColors: true, side: THREE.DoubleSide });
  mat.name = 'atlasChar';
  mat.userData.uniforms = { uTint: { value: new THREE.Color(1, 1, 1) }, uFlash: { value: 0 }, uFade: { value: 0 }, uShieldRect: { value: new THREE.Vector3(-1, -1, 0) }, uEmblem: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, mat.userData.uniforms, DITHER);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aAtlas; varying vec4 vAtlas;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvAtlas = aAtlas;');
    // explicit LOD (textureGrad is unreliable on some ANGLE/Metal drivers): mip from the continuous UV, so tiling wraps leave no seam
    const S = (tex, uvv) => `textureLod(${tex}, atlasUV(${uvv}), atlasLod(${uvv}, float(textureSize(${tex}, 0).x)))`;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vAtlas; uniform vec3 uTint; uniform float uFlash; uniform float uFade; uniform vec2 uDitherOff; uniform vec3 uShieldRect; uniform float uEmblem;
${EMBLEM_GLSL}
vec2 atlasUV(vec2 uv) { vec2 f = vAtlas.w > 0.5 ? fract(uv) : clamp(uv, 0.0, 1.0); return vAtlas.xy + f * vAtlas.z; }
float atlasLod(vec2 uv, float size) { vec2 dx = dFdx(uv) * vAtlas.z * size, dy = dFdy(uv) * vAtlas.z * size; return max(0.0, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8))); }`)
      // includes are still unexpanded here: substitute whole chunks with atlas-sampling copies
      .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', S('map', 'vMapUv')))
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz', `vec3 mapN = ${S('normalMap', 'vNormalMapUv')}.xyz`))
      .replace('#include <roughnessmap_fragment>', THREE.ShaderChunk.roughnessmap_fragment.replace('texture2D( roughnessMap, vRoughnessMapUv )', S('roughnessMap', 'vRoughnessMapUv')))
      .replace('#include <metalnessmap_fragment>', THREE.ShaderChunk.metalnessmap_fragment.replace('texture2D( metalnessMap, vMetalnessMapUv )', S('metalnessMap', 'vMetalnessMapUv')))
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= uTint;
// the shield device (episema): the shared atlas carried one red sign on every man's shield, a modern-looking logo
// (critic rounds 2 and 3); each man now gets one of six old devices in red ochre or bone white
if (uShieldRect.z > 0.0 && abs(vAtlas.x - uShieldRect.x) + abs(vAtlas.y - uShieldRect.y) < 1e-4) {
  vec2 eq = (clamp(vMapUv, 0.0, 1.0) - vec2(0.340, 0.672)) / 0.205;
  if (dot(eq, eq) < 0.94) {
    float oldRed = smoothstep(0.03, 0.08, diffuseColor.r - max(diffuseColor.g, diffuseColor.b));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.0105) * uTint, oldRed);
    float ed = emblemSDF(eq, mod(uEmblem, 6.0)), ew = max(fwidth(ed), 0.015);
    vec3 ec = mod(floor(uEmblem / 6.0), 2.0) < 0.5 ? vec3(0.17, 0.028, 0.02) : vec3(0.52, 0.45, 0.33);
    diffuseColor.rgb = mix(diffuseColor.rgb, ec, 1.0 - smoothstep(-ew, ew, ed));
  }
}`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.92, 0.82), uFlash * 0.55);
if (uFade > 0.0) { ivec2 q = ivec2(mod(gl_FragCoord.xy + uDitherOff, 4.0)); const float B4[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.); if ((B4[q.x + q.y * 4] + 0.5) / 16.0 < uFade) discard; }
${(typeof window !== 'undefined' && window.__atlasDebug) ? 'gl_FragColor = vec4(' + window.__atlasDebug + ', 1.0);' : ''}`);
  };
  mat.customProgramCacheKey = () => 'atlasChar3' + ((typeof window !== 'undefined' && window.__atlasDebug) || '');
  return mat;
}

// per-instance material clone sharing the compiled program (uniforms differ per soldier)
export function instanceMaterial(base) {
  const m = base.clone();
  m.userData.uniforms = { uTint: { value: new THREE.Color(1, 1, 1) }, uFlash: { value: 0 }, uFade: { value: 0 }, uShieldRect: base.userData.uniforms.uShieldRect, uEmblem: { value: 0 } };
  m.onBeforeCompile = (sh, r) => { base.onBeforeCompile.call(m, sh, r); Object.assign(sh.uniforms, m.userData.uniforms); };
  m.customProgramCacheKey = base.customProgramCacheKey;
  return m;
}

// ---------------------------------------------------------------- far LOD by vertex clustering
// Vertices of the same part that fall in the same grid cell collapse to one representative; degenerate
// triangles vanish. Linear time, keeps skin weights and atlas attributes of the representative.
export function clusterLOD(geo, cell = 0.045, { uvSeams = true } = {}) {
  const P = geo.attributes.position, part = geo.attributes.aPart, idx = geo.index, Nn = geo.attributes.normal, U = geo.attributes.uv;
  const map = new Map(), remap = new Int32Array(P.count);
  const keep = [];
  for (let i = 0; i < P.count; i++) {
    // same part, same cell, same facing octant (front / back of thin shells stay apart) and same UV patch
    // (no merging across texture seams)
    const oct = (Nn.getX(i) > 0 ? 1 : 0) | (Nn.getY(i) > 0 ? 2 : 0) | (Nn.getZ(i) > 0 ? 4 : 0);
    const uvk = U && uvSeams ? `${Math.floor(U.getX(i) * 5)}:${Math.floor(U.getY(i) * 5)}` : '';
    const k = `${part.getX(i)}|${Math.round(P.getX(i) / cell)}|${Math.round(P.getY(i) / cell)}|${Math.round(P.getZ(i) / cell)}|${oct}|${uvk}`;
    let r = map.get(k);
    if (r === undefined) { r = keep.length; keep.push(i); map.set(k, r); }
    remap[i] = r;
  }
  const out = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) {
    const arr = new a.array.constructor(keep.length * a.itemSize);
    keep.forEach((src, j) => { for (let c = 0; c < a.itemSize; c++) arr[j * a.itemSize + c] = a.array[src * a.itemSize + c]; });
    out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  const tri = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = remap[idx.getX(i)], b = remap[idx.getX(i + 1)], c = remap[idx.getX(i + 2)];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  out.setIndex(tri);
  out.boundingSphere = geo.boundingSphere.clone();
  return out;
}
