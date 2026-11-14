// Runtime character: one AnimationMixer, weight-managed cross-fades, a phase-synced locomotion blend
// (idle / walk / jog / sprint, each clip's playback rate locked to its measured stride so feet do not slide),
// a left-arm shield layer, clip events (foot contacts, strikes), cloak spring, bone-attached gear.
import * as THREE from 'three';
import { noLeftArm, leftArmOnly, extractRootMotion, analyseClip, measureRootAxes, rmAt, sanitizeClip } from './skinned.js';
import { clamp } from './util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qw = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);
const _fa = new THREE.Vector3(), _fb = new THREE.Vector3(), _fc = new THREE.Vector3();
const _ih = new THREE.Vector3(), _ik = new THREE.Vector3(), _ia = new THREE.Vector3(), _iu = new THREE.Vector3(), _iv = new THREE.Vector3(), _in = new THREE.Vector3();
const _iq = new THREE.Quaternion(), _iq2 = new THREE.Quaternion(), _ifq = new THREE.Quaternion(), _ipq = new THREE.Quaternion();
// rotate a bone by a world-space rotation q (about its own origin)
function rotateWorld(bone, q) {
  bone.parent.getWorldQuaternion(_ipq);
  bone.getWorldQuaternion(_iq2);
  bone.quaternion.copy(_ipq.invert().multiply(q.clone().multiply(_iq2)));
  bone.updateMatrixWorld(true);
}
// analytic two-bone IK: thigh (hip) -> calf (knee) -> foot (ankle) reaches target; the knee stays in its plane,
// the foot keeps its world orientation
function twoBoneIK(thigh, calf, foot, target) {
  foot.getWorldQuaternion(_ifq);
  const H = thigh.getWorldPosition(_ih), K = calf.getWorldPosition(_ik), A = foot.getWorldPosition(_ia);
  const a = H.distanceTo(K), b = K.distanceTo(A);
  const c = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, H.distanceTo(target)));
  _iu.copy(H).sub(K); _iv.copy(A).sub(K);
  const cur = _iu.angleTo(_iv), want = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b))));
  _in.crossVectors(_iu, _iv);
  if (_in.lengthSq() > 1e-10 && Math.abs(want - cur) > 1e-5) { _in.normalize(); rotateWorld(calf, _iq.setFromAxisAngle(_in, want - cur)); }
  foot.getWorldPosition(A);
  _iu.copy(A).sub(H).normalize(); _iv.copy(target).sub(H).normalize();
  rotateWorld(thigh, _iq.setFromUnitVectors(_iu, _iv));
  // the foot back to its animated world orientation
  foot.parent.getWorldQuaternion(_ipq);
  foot.quaternion.copy(_ipq.invert().multiply(_ifq));
  foot.updateMatrixWorld(true);
}
const _r0 = { x: 0, z: 0 }, _r1 = { x: 0, z: 0 };
const _cg0 = new THREE.Vector3();

// Shared per-type clip table. spec: key -> { clip: sourceName, loop, full (uses its own left arm), rate, meta }.
// Every clip is made in-place (root motion extracted to a curve) and analysed once on the real skeleton.
export function buildClipTable(rawClips, spec, probeRoot, opts = {}) {
  const sides = opts.sides;
  const rootName = opts.rootName || 'root';
  const axes = probeRoot.getObjectByName(rootName) ? measureRootAxes(probeRoot, rootName) : { x: [1, 0, 0], y: [0, 0, 1], z: [0, 1, 0] };
  const axis = { x: [axes.x[0], axes.x[1]], y: [axes.y[0], axes.y[1]], z: [axes.z[0], axes.z[1]] };
  const T = {}, done = new Map();
  // standing heights of heel / toe bones = ground reference for contact and stride analysis
  const refName = opts.ref || (rawClips.Idle_Loop ? 'Idle_Loop' : null);
  const ground = refName ? analyseClip(probeRoot, rawClips[refName], sides ? { sides, n: 8 } : { n: 8 }).standing : null;
  const pel = probeRoot.getObjectByName('pelvis');
  const restPelvis = pel ? { p: pel.position.clone(), q: pel.quaternion.clone() } : null;
  T.__sanitized = {};
  for (const [key, s] of Object.entries(spec)) {
    let raw = rawClips[s.clip];
    if (!raw) { console.warn('missing clip', s.clip); continue; }
    let prep = done.get(s.clip);
    if (!prep) {
      if (restPelvis) {
        const c = raw.clone(); const r = sanitizeClip(c, restPelvis, { loop: !!s.loop });
        if (r) { raw = c; T.__sanitized[s.clip] = r; }
      }
      const { clip, rm } = opts.noRootMotion ? { clip: raw.clone(), rm: null } : extractRootMotion(raw, { axis, rootName });
      // drop tracks for bones this rig does not have (e.g. cloak bones in the hero-authored thrust)
      if (opts.rig) clip.tracks = clip.tracks.filter((t) => !!opts.rig.getObjectByName(t.name.split('.')[0]));
      const an = analyseClip(probeRoot, clip, sides ? { sides, ground, cyclic: !!s.loop } : { ground, cyclic: !!s.loop });
      prep = { clip, rm, an };
      done.set(s.clip, prep);
    }
    const { clip, rm, an } = prep;
    T[key] = { key, src: s.clip, clip, masked: s.full ? clip : noLeftArm(clip), full: !!s.full, loop: !!s.loop, speed: an.speed || 0,
      contacts: s.loop || s.steps !== false ? an.contacts : [], duration: clip.duration, rate: s.rate || 1, rm: s.rm === false ? null : rm, rmScale: s.rmScale ?? 1, ...(s.meta || {}) };
    // where both feet are at each of 32 phases of a locomotion loop (character space): a start from rest picks the
    // phase whose feet are nearest to where they stand (critic round 2, defect 7)
    if (s.loop && an.speed > 0.05 && !opts.noRootMotion) T[key].feetTab = footTable(probeRoot, clip, 32);
  }
  T.__axes = axes;
  return T;
}

function footTable(root, clip, n) {
  const fl = root.getObjectByName('foot_l'), fr = root.getObjectByName('foot_r');
  if (!fl || !fr) return null;
  const mixer = new THREE.AnimationMixer(root), act = mixer.clipAction(clip); act.play();
  const out = [], a = new THREE.Vector3(), b = new THREE.Vector3(), inv = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    mixer.setTime((i / n) * clip.duration); root.updateMatrixWorld(true); inv.copy(root.matrixWorld).invert();
    fl.getWorldPosition(a).applyMatrix4(inv); fr.getWorldPosition(b).applyMatrix4(inv);
    out.push([a.x, a.y, a.z, b.x, b.y, b.z]);
  }
  act.stop(); mixer.uncacheClip(clip); mixer.uncacheRoot(root);
  return out;
}
const UPPER = ['pelvis', 'spine_02', 'spine_03', 'neck_01', 'Head', 'head', 'hand_l', 'hand_r', 'lowerarm_l', 'lowerarm_r', 'cloak_01', 'cloak_02', 'cloak_03'], LOWER = ['foot_l', 'foot_r', 'calf_l', 'calf_r', 'ball_l', 'ball_r'];
const UP = new THREE.Vector3(0, 1, 0), _tq = new THREE.Quaternion(), _tq0 = new THREE.Quaternion(), _tn = new THREE.Vector3(), _tv = new THREE.Vector3(), _tm = new THREE.Matrix4();

export class Actor {
  constructor(root, table, opt = {}) {
    this.root = root;
    this.table = table;
    this.bones = {}; this.meshes = [];
    root.traverse((o) => { if (o.isBone) this.bones[o.name] = o; if (o.isSkinnedMesh || o.isMesh) this.meshes.push(o); });
    this.mixer = new THREE.AnimationMixer(root);
    this.shield = !!opt.shield;
    this.guardClip = opt.guardClip || null;   // clip whose left arm carries the shield
    this.slots = new Map();                    // key -> { action, w, target, rate }
    this.primary = null;                       // key of the one-shot / held clip, or 'loco'
    this.fade = 0.2;
    this.loco = { speed: 0, phase: 0, keys: opt.loco || ['idle', 'walk', 'run', 'sprint'], w: {} };
    this.prevRatio = 0; this.ratio = 0; this.wrapped = false; this.frozen = false;
    this.events = [];                          // contacts fired this frame: { side }
    this.overlay = null;
    if (this.shield && this.guardClip) {
      this.overlay = this.mixer.clipAction(leftArmOnly(this.guardClip));
      this.overlay.play(); this.overlay.setEffectiveWeight(1);
    }
    this.attached = {};
    this.cloak = null;
    this.halfRate = false; this.skip = 0; this.acc = 0;
    this.rm = { x: 0, z: 0 };   // root-motion displacement of this frame, character space (+z forward)
  }
  slot(key) {
    let s = this.slots.get(key);
    if (!s) {
      const e = this.table[key];
      if (!e) throw new Error('no clip ' + key);
      const a = this.mixer.clipAction(this.shield ? e.masked : e.clip);
      a.setLoop(e.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); a.clampWhenFinished = true;
      s = { key, e, action: a, w: 0, target: 0 };
      this.slots.set(key, s);
    }
    return s;
  }
  // ---------------------------------------------------------------- locomotion blend (speed in m/s)
  setLoco(speed, fade = 0.22) {
    if (this.primary !== 'loco') { this.primary = 'loco'; this.fade = fade; this.prevRatio = this.ratio = 0; }
    this.loco.speed = speed;
  }
  // ---------------------------------------------------------------- one-shot / held clip
  play(key, { fade = 0.12, restart = true, at = 0, rate = null } = {}) {
    const s = this.slot(key);
    if (this.primary === key && !restart) { if (rate !== null) s.action.timeScale = rate * s.e.rate; return s.action; }
    s.action.reset();
    s.action.enabled = true;
    s.action.timeScale = (rate ?? 1) * s.e.rate;
    s.action.time = at * s.e.duration;
    s.action.play();
    if (s.w <= 0.001) s.w = fade <= 0 ? 1 : 0;
    if (fade <= 0) { for (const o of this.slots.values()) if (o !== s) o.w = 0; this.locoWeight = 0; }
    this.primary = key; this.fade = Math.max(fade, 1e-3);
    this.prevRatio = this.ratio = at; this.wrapped = false;
    return s.action;
  }
  hold(paused) { const s = this.slots.get(this.primary); if (s) s.action.paused = paused; }
  get cur() { return this.primary && this.primary !== 'loco' ? this.slots.get(this.primary) : null; }
  get meta() { const c = this.cur; return c ? c.e : {}; }
  get done() { const c = this.cur; return !!c && !c.e.loop && c.action.time >= c.e.duration - 1e-3; }
  crossed(r) { if (this.wrapped) return r > this.prevRatio || r <= this.ratio; return this.prevRatio < r && this.ratio >= r; }
  setTimeScale(k) { const c = this.cur; if (c) c.action.timeScale = k * c.e.rate; }

  update(dt) {
    this.events.length = 0; this.updated = false;
    if (this.frozen) return;
    if (this.halfRate) { this.acc += dt; if ((this.skip = (this.skip + 1) % 2) === 1) { this.prevRatio = this.ratio; this.wrapped = false; return; } dt = this.acc; }
    this.updated = true;
    // put back the bones the leg IK / spear guard changed last frame: three's PropertyMixer only writes a bone whose
    // animated value CHANGED, so on a held or still pose (the guard, an idle leg) the procedural turn was kept and
    // compounded every frame (the right foot ended 1.6 m up while blocking, fix round 2)
    this.restoreProc();
    this.acc = 0;
    const k = Math.min(1, dt / this.fade);
    // targets
    const L = this.loco;
    let locoW = 0;
    for (const s of this.slots.values()) s.target = (s.key === this.primary) ? 1 : 0;
    if (this.primary === 'loco') locoW = 1;
    // weights move toward targets (linear cross-fade, sums stay 1)
    let sum = 0;
    for (const s of this.slots.values()) {
      if (L.keys.includes(s.key)) continue;
      s.w += clamp(s.target - s.w, -k, k);
      if (s.w < 1e-3 && s.target === 0) { s.w = 0; if (s.action.isRunning() || s.action.enabled) { s.action.stop(); } }
      sum += s.w;
    }
    this.locoWeight = this.locoWeight === undefined ? locoW : this.locoWeight + clamp(locoW - this.locoWeight, -k, k);
    if (this.primary === 'loco') this.locoWeight = Math.max(this.locoWeight, 1 - sum);
    // normalise so the total is exactly 1 (no bind-pose leaks during fades)
    const total = sum + this.locoWeight;
    const norm = total > 1e-4 ? 1 / total : 1;
    // locomotion: 1-D blend over speed, all clips phase-locked. The blend itself moves at most 1/0.18 per second: the
    // speed jumps 0 -> 0.4 m/s in the first frame of W, and the legs used to jump 16-72 cm from the stance into
    // mid-stride in that one frame (critic round 2, defect 7). A start from rest also begins the stride at the phase
    // whose feet are nearest to where the feet stand.
    // (a negative speed walks backward: the same clips with the phase running back; a man giving ground or circling the
    //  hero keeps his face and shield toward him instead of turning his back, critic round 3, defect 8)
    const vAbs = Math.abs(L.speed), vDir = L.speed < 0 ? -1 : 1;
    const lwT = this.locomotionWeights(vAbs);
    if (!L.ws) L.ws = { ...lwT };
    if (vAbs > 0.05 && (L.prevSpeed || 0) <= 0.05 && (L.ws[L.keys[0]] || 0) > 0.85 && vDir > 0) this.matchPhase();
    L.prevSpeed = vAbs;
    { const kk = Math.min(1, dt / 0.18); let tot = 0;
      for (const key of L.keys) { const t = lwT[key] || 0, c0 = L.ws[key] || 0; L.ws[key] = c0 + clamp(t - c0, -kk, kk); tot += L.ws[key]; }
      for (const key of L.keys) L.ws[key] = tot > 1e-6 ? L.ws[key] / tot : (key === L.keys[0] ? 1 : 0); }
    const lw = L.ws;
    let cyc = 0, wsum = 0;
    for (const key of L.keys) { const e = this.table[key]; if (!e || !lw[key]) continue; cyc += lw[key] * (e.speed > 0.05 ? e.speed * e.duration : 0); wsum += lw[key]; }
    const prevPhase = L.phase;
    if (this.locoWeight > 0.001) {
      if (cyc > 0.01 && vAbs > 0.05) L.phase = ((L.phase + vDir * (vAbs / (cyc / wsum)) * dt) % 1 + 1) % 1;
      else L.phase = (L.phase + dt / 2.5) % 1;
      // the idle breathes on its own clock (it is not phase-locked to the stride, so a phase match never jerks it)
      const ie = this.table[L.keys[0]]; L.idlePhase = ((L.idlePhase || 0) + dt / Math.max(0.5, ie ? ie.duration : 2.5)) % 1;
    }
    for (const key of L.keys) {
      if (!this.table[key]) continue;
      const s = this.slot(key);
      const w = (lw[key] || 0) * this.locoWeight * norm;
      // Locomotion actions run at timeScale 0 (the phase sets their time), so isRunning() is always false for them.
      // The first version therefore re-started them every frame and NEVER stopped one whose weight fell to zero: a
      // stale idle / walk / sprint kept its last weight (often 1) and frozen pose and was averaged into every stride,
      // which shrank the leg swing to about half and slid the feet (critic round 1, defect 7). Track it explicitly.
      if (w > 1e-3) {
        if (!s.loco) { s.action.reset(); s.action.play(); s.loco = true; }
        s.action.timeScale = 0;
        s.action.time = (key === L.keys[0] ? (L.idlePhase || 0) : L.phase) * s.e.duration;
        s.action.setEffectiveWeight(w);
      } else if (s.loco) { s.action.stop(); s.loco = false; }
      s.w = w;
    }
    for (const s of this.slots.values()) if (!L.keys.includes(s.key) && s.w > 0) s.action.setEffectiveWeight(s.w * norm);
    // left-arm layer = weight of every masked clip
    if (this.overlay) {
      let masked = 0;
      for (const s of this.slots.values()) if (!s.e.full) masked += L.keys.includes(s.key) ? s.w : s.w * norm;
      this.overlay.setEffectiveWeight(clamp(masked, 0, 1));
    }
    // ratio + events of the primary
    const c = this.cur;
    const before = c ? c.action.time : 0;
    this.mixer.update(dt);
    this.rm.x = 0; this.rm.z = 0;
    if (c) {
      const after = c.action.time;
      if (c.e.rm && after !== before && c.w > 0) {
        const a0 = rmAt(c.e.rm, before, _r0), a1 = rmAt(c.e.rm, after, _r1), k2 = Math.min(1, c.w * norm * 1.5);
        if (after > before) { this.rm.x = (a1.x - a0.x) * k2 * c.e.rmScale; this.rm.z = (a1.z - a0.z) * k2 * c.e.rmScale; }
      }
      this.prevRatio = this.ratio;
      this.wrapped = c.e.loop && after < before - 1e-6;
      this.ratio = after / c.e.duration;
      for (const ct of c.e.contacts) if (this.crossed(ct.t) && c.w > 0.5) this.events.push({ side: ct.side });
    } else if (this.primary === 'loco') {
      // contacts of the dominant locomotion clip, against the shared phase
      let best = null, bw = 0;
      for (const key of L.keys) if ((lw[key] || 0) > bw && this.table[key] && this.table[key].speed > 0.05) { bw = lw[key]; best = this.table[key]; }
      if (!best) for (const key of L.keys) if ((lwT[key] || 0) > bw && this.table[key] && this.table[key].speed > 0.05) { bw = lwT[key]; best = this.table[key]; }
      if (best && vAbs > 0.3) {
        if (vDir > 0) {
          const wrapped = L.phase < prevPhase;
          for (const ct of best.contacts) {
            const hit = wrapped ? (ct.t > prevPhase || ct.t <= L.phase) : (prevPhase < ct.t && L.phase >= ct.t);
            if (hit) this.events.push({ side: ct.side });
          }
        } else {   // walking backward: the phase runs down through the contacts
          const wrapped = L.phase > prevPhase;
          for (const ct of best.contacts) {
            const hit = wrapped ? (ct.t < prevPhase || ct.t >= L.phase) : (prevPhase > ct.t && L.phase <= ct.t);
            if (hit) this.events.push({ side: ct.side });
          }
        }
      }
      this.prevRatio = this.ratio = L.phase;
    }
  }
  matchPhase() {
    const L = this.loco, e = this.table[L.keys[1]];
    const tab = e && e.feetTab; if (!tab) return;
    const fl = this.bones.foot_l, fr = this.bones.foot_r; if (!fl || !fr) return;
    this.root.updateMatrixWorld(true); _tm.copy(this.root.matrixWorld).invert();
    const a = fl.getWorldPosition(_tv).applyMatrix4(_tm).toArray(), b = fr.getWorldPosition(_tv).applyMatrix4(_tm).toArray();
    let best = 0, bd = Infinity;
    tab.forEach((f, i) => { const d = (f[0] - a[0]) ** 2 + (f[1] - a[1]) ** 2 + (f[2] - a[2]) ** 2 + (f[3] - b[0]) ** 2 + (f[4] - b[1]) ** 2 + (f[5] - b[2]) ** 2; if (d < bd) { bd = d; best = i; } });
    L.phase = best / tab.length; this.phaseMatched = { phase: +L.phase.toFixed(3), err: +Math.sqrt(bd).toFixed(3) };
  }
  // speed -> weights of idle / walk / run / sprint (adjacent pairs, linear in speed between natural speeds)
  locomotionWeights(v) {
    const L = this.loco, out = {};
    const pts = L.keys.map((k) => ({ k, s: k === L.keys[0] ? 0 : (this.table[k] ? this.table[k].speed : 0) })).filter((p) => this.table[p.k]);
    if (v <= pts[0].s + 1e-4) { out[pts[0].k] = 1; return out; }
    // cross-fade over the lower half of each gap, then the faster clip alone, slowed to the speed (rate = v / natural):
    // a walk mixed into a run (or idle into a walk) does not plant its feet where the blend says
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (v <= b.s) { const t = Math.min(1, (v - a.s) / Math.max(1e-4, 0.5 * (b.s - a.s))); if (t >= 1) { out[b.k] = 1; return out; } out[a.k] = 1 - t; out[b.k] = t; return out; }
    }
    out[pts[pts.length - 1].k] = 1;
    return out;
  }
  // ---------------------------------------------------------------- gear
  attach(name, node, entry) {
    const b = this.bones[entry.bone];
    node.position.fromArray(entry.position); node.quaternion.fromArray(entry.quaternion); node.scale.set(1, 1, 1);
    b.add(node);
    this.attached[name] = node;
    return node;
  }
  // world segment of a bone-attached weapon: grip at the node origin, tip along -Z
  segment(name, len, outA, outB, from = 0.0) {
    const n = this.attached[name];
    n.updateWorldMatrix(true, false);
    outA.set(0, 0, -from * len).applyMatrix4(n.matrixWorld);
    outB.set(0, 0, -len).applyMatrix4(n.matrixWorld);
  }
  // ---------------------------------------------------------------- cloak (no clip drives cloak_01..03)
  enableCloak(names = ['cloak_01', 'cloak_02', 'cloak_03'], back = 'spine_03') {
    const bones = names.map((n) => this.bones[n]).filter(Boolean);
    if (!bones.length) return;
    // outward normal of the back (character -Z at bind time) expressed in the spine's and the pelvis' own frames,
    // so it can be followed while the body bends (called while the skeleton is still in its bind pose)
    this.root.updateMatrixWorld(true);
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const outW = new THREE.Vector3(0, 0, -1).applyQuaternion(rootQ);
    const local = (bn) => { const b = this.bones[bn]; return b ? outW.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert()) : null; };
    // how far each cloak segment points away from the back in the bind pose (the clearance we keep)
    const minDot = bones.map((b) => new THREE.Vector3(0, 1, 0).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion())).dot(outW));
    const sideW = new THREE.Vector3(1, 0, 0).applyQuaternion(rootQ);
    const sBack = this.bones[back] ? sideW.clone().applyQuaternion(this.bones[back].getWorldQuaternion(new THREE.Quaternion()).invert()) : null;
    // segment lengths (bind pose): the last one is taken as long as the one before it
    const len = bones.map((b, i) => i < bones.length - 1 ? b.getWorldPosition(new THREE.Vector3()).distanceTo(bones[i + 1].getWorldPosition(new THREE.Vector3())) : 0);
    if (len.length > 1) len[len.length - 1] = len[len.length - 2] * 1.1;
    this.cloak = { bones, len, dir: bones.map(() => null), back: this.bones[back], pelvis: this.bones.pelvis, nBack: local(back), nPelvis: local('pelvis'), sBack, minDot, rest: bones.map((b) => b.quaternion.clone()) };
  }
  // The cloak hangs from the shoulders and swings back with speed, but never closer to the body than its rigid,
  // skinned shape (which clears the cuirass / leather strips): with the torso bent forward (combat stance, running)
  // a cloak that only "hangs down" cut through the bronze back plate and the pteruges (critic round 1, defect 4).
  springCloak(dt, vel, groundAt = null) {
    const C = this.cloak; if (!C) return;
    this.root.updateMatrixWorld(true);
    const back = _v.set(0, 0, -1).applyQuaternion(C.back.getWorldQuaternion(_qw)).setY(0).normalize();
    const nB = C.nBack ? C.nBack.clone().applyQuaternion(C.back.getWorldQuaternion(_qw)).normalize() : null;
    const nP = C.nPelvis && C.pelvis ? C.nPelvis.clone().applyQuaternion(C.pelvis.getWorldQuaternion(_qw)).normalize() : nB;
    const sB = C.sBack ? C.sBack.clone().applyQuaternion(C.back.getWorldQuaternion(_qw)).normalize() : null;
    const drag = new THREE.Vector3(vel ? -vel.x : 0, 0, vel ? -vel.z : 0).multiplyScalar(0.07);
    // the leather strips (pteruges) ride on the thighs: when a thigh swings behind the hips (lunge, the first frames of
    // a combo blow) the strips flare backward and came 3-7 cm through the hem. Measure how far behind the hips each
    // knee goes (along the pelvis' back normal) and keep the lower cloak that much further out.
    let flare = 0;
    if (nP) for (const s of ['l', 'r']) {
      const th = this.bones['thigh_' + s], ca = this.bones['calf_' + s];
      if (!th || !ca) continue;
      const h = th.getWorldPosition(_fa), k = ca.getWorldPosition(_fb);
      const L = h.distanceTo(k) || 1;
      flare = Math.max(flare, (k.sub(h)).dot(nP) / L);
    }
    flare = Math.max(0, flare + 0.05);
    C.bones.forEach((b, i) => {
      b.quaternion.copy(C.rest[i]);
      b.parent.updateWorldMatrix(true, false); b.updateMatrixWorld(true);
      b.getWorldQuaternion(_q);
      const rigid = new THREE.Vector3(0, 1, 0).applyQuaternion(_q).normalize();
      const target = rigid.clone().lerp(DOWN, 0.5 + 0.15 * i).add(drag).normalize();
      if (target.dot(back) < 0.05) target.addScaledVector(back, 0.05 - target.dot(back)).normalize();
      // body-side limit: the back's outward normal for the upper cloak, the pelvis' for the hem (over the strips)
      const n = !nB ? null : i === 0 ? nB : i === 1 ? _v2.copy(nB).lerp(nP, 0.5).normalize() : nP;
      // (the hem stands a little further out than in round 1: with both feet now set on the ground by the leg IK, the
      //  thigh strips swing a few mm further back in a combo, 2.8 cm through the hem in one run)
      const min = n ? C.minDot[i] + 0.05 + 0.04 * i + (i === 2 ? 0.65 : i === 1 ? 0.35 : 0) * flare : 0;
      const rs = sB ? rigid.dot(sB) : 0;
      const limit = (v) => {
        if (!n) return;
        const d = v.dot(n); if (d < min) v.addScaledVector(n, min - d).normalize();
        // and no more than ~17 degrees of sideways lag: a twist must not leave the back bare with the cloak to one side
        if (sB) { const ds = v.dot(sB) - rs; if (Math.abs(ds) > 0.3) v.addScaledVector(sB, -(ds - Math.sign(ds) * 0.3)).normalize(); }
      };
      limit(target);
      if (!C.dir[i]) C.dir[i] = target.clone();
      C.dir[i].lerp(target, 1 - Math.exp(-dt * (10 - 2.5 * i))).normalize();
      limit(C.dir[i]);   // the lagging (smoothed) cloak must obey the limit too, or a fast twist turns the body through it
      // and it never hangs into the ground: lying on a slope its tip went 1.5 m under it (critic round 2, defect 6)
      if (groundAt && C.len[i] > 0.01) {
        const p0 = b.getWorldPosition(_cg0), L = C.len[i];
        const ex = p0.x + C.dir[i].x * L, ez = p0.z + C.dir[i].z * L, ey = p0.y + C.dir[i].y * L, gy = groundAt(ex, ez) + 0.05;
        if (ey < gy) {
          const ty = Math.max(-1, Math.min(1, (gy - p0.y) / L)), hl = Math.hypot(C.dir[i].x, C.dir[i].z) || 1, h = Math.sqrt(Math.max(0, 1 - ty * ty));
          if (hl > 1e-3) C.dir[i].set(C.dir[i].x / hl * h, ty, C.dir[i].z / hl * h); else C.dir[i].copy(back).multiplyScalar(h).setY(ty);
          C.dir[i].normalize();
        }
      }
      _q2.setFromUnitVectors(rigid, C.dir[i]);
      const world = _q2.multiply(_q);
      b.parent.getWorldQuaternion(_qw);
      b.quaternion.copy(_qw.invert().multiply(world));
      b.updateMatrixWorld(true);
    });
  }
  // ---------------------------------------------------------------- feet on the ground (two-bone leg IK)
  // Horizontal: while a foot is planted in a locomotion clip, its ball is held where it touched down (the animated
  // height is kept so heel and toe still roll), by bending knee and hip; a few cm of stride mismatch disappear
  // (critic round 1 defect 7). Vertical (slopes, critic round 2 defect 6): each foot is lifted onto the ground under
  // it and the hips drop to the lower foot, while the body is upright. Releases are eased: a stretched lock slides
  // after the foot at 2.5 m/s and a lifted foot eases out over 0.1 s (it used to snap back 14-28 cm in one frame,
  // critic round 2 defect 7).
  footLock(dt, groundAt, active, upright = false) {
    if (!this.feet) {
      this.feet = ['l', 'r'].map((s) => ({ thigh: this.bones['thigh_' + s], calf: this.bones['calf_' + s], foot: this.bones['foot_' + s], ball: this.bones['ball_' + s], hmin: 0.03, locked: false, slip: false, lock: new THREE.Vector3(), w: 0, dy: 0, go: 0 }));
      if (this.feet.some((f) => !f.thigh || !f.calf || !f.foot || !f.ball)) { this.feet = []; }
    }
    if (!this.feet.length) return;
    const R = this.root;
    if (!this.updated) {   // a skipped (half-rate) frame keeps last frame's bones: only the hip drop is re-applied
      if (this.gDrop && this.gW) { R.position.y -= this.gDrop * this.gW; }
      return;
    }
    R.updateMatrixWorld(true);
    const ry = R.position.y;
    // Running on a slope (critic round 3, defect 7: running up the temple hill the uphill foot went 0.37 m into the
    // ground) the hips drop only half as far as when standing (a full drop to the downhill foot left the uphill foot
    // 0.6-0.7 m to climb, past the 0.45 m limit), the foot follows the ground faster, and a floor rule below lifts any
    // foot that would still end under the surface.
    const moving = this.loco && this.primary === 'loco' && Math.abs(this.loco.speed) > 1.2;
    // ---- vertical: ground under each foot vs the root plane
    this.gW = clamp((this.gW || 0) + (upright ? dt / 0.15 : -dt / 0.12), 0, 1);
    let drop = 0;
    if (this.gW > 0) {
      for (const F of this.feet) { const b = F.ball.getWorldPosition(_fa); F.go = clamp(groundAt(b.x, b.z) - ry, -0.5, 0.75); }
      const want = clamp(-Math.min(this.feet[0].go, this.feet[1].go) * (moving ? 0.5 : 1), 0, moving ? 0.2 : 0.32);
      this.gDrop = (this.gDrop || 0) + clamp(want - (this.gDrop || 0), -1.5 * dt, 1.5 * dt);
      drop = this.gDrop * this.gW;
      if (drop > 1e-4) { R.position.y -= drop; R.updateMatrixWorld(true); }
    } else { this.gDrop = 0; for (const F of this.feet) F.go = 0; }
    const base = ry - drop;   // the root plane the clip's own foot heights refer to
    for (const F of this.feet) {
      const ball = F.ball.getWorldPosition(_fa), hA = ball.y - base;   // height above the clip's own floor
      // the planted height is learnt from locomotion only (a lunge or a fall used to drag it down for seconds)
      if (active) F.hmin = Math.min(hA, F.hmin + 0.03 * dt);
      F.hmin = Math.max(-0.05, Math.min(0.06, F.hmin));
      const ankle = F.foot.getWorldPosition(_fb);
      if (!active) { F.locked = false; F.slip = false; }
      else if (!F.locked && hA < F.hmin + 0.025) {
        // (re)plant where the foot is drawn right now, so a foot still easing out of the last lock does not jump
        F.lock.set(ball.x + (F.lock.x - ball.x) * F.w, ball.y, ball.z + (F.lock.z - ball.z) * F.w);
        F.locked = true; F.slip = false;
      } else if (F.locked && hA > F.hmin + 0.045) F.locked = false;
      F.w = Math.max(0, Math.min(1, F.w + (F.locked ? dt / 0.05 : -dt / 0.1)));
      const ox = F.lock.x - ball.x, oz = F.lock.z - ball.z, off = Math.hypot(ox, oz);
      if (F.locked && off > 0.12) F.slip = true;
      if (F.slip) {
        const step = Math.min(off, (moving ? 2.5 : 1.5) * dt);
        if (off > 1e-6) { F.lock.x -= (ox / off) * step; F.lock.z -= (oz / off) * step; }
        if (off - step < 0.03) F.slip = false;
      }
      // a standing man whose body has drifted off a planted foot (pushed, turning, edging round the ring) lifts it and
      // sets it down again: a short step instead of the foot gliding over the ground (critic round 3, defect 8)
      const liftT = F.slip && !moving ? Math.min(0.085, 0.7 * off) : 0;
      F.lift = (F.lift || 0) + clamp(liftT - (F.lift || 0), -0.9 * dt, 1.2 * dt);
      const tdy = clamp((F.go + drop) * this.gW, -0.12, 0.75);
      const rate = moving ? 7 : 2.5;
      F.dy += clamp(tdy - F.dy, -rate * dt, rate * dt);
      // floor: the ball no lower than its planted height over the ground under it, the ankle 5 cm over the ground
      if (this.gW > 0) {
        const need = Math.max(groundAt(ball.x, ball.z) + F.hmin - 0.01 - ball.y, groundAt(ankle.x, ankle.z) + 0.05 - ankle.y);
        if (need > F.dy) F.dy = need;
      }
      if (F.w <= 0 && Math.abs(F.dy) < 1e-3 && F.lift < 1e-3) continue;
      const dx = (F.lock.x - ball.x) * F.w, dz = (F.lock.z - ball.z) * F.w;
      _fc.set(ankle.x + dx, ankle.y + F.dy + F.lift, ankle.z + dz);
      this.saveBone(F.thigh); this.saveBone(F.calf); this.saveBone(F.foot);
      twoBoneIK(F.thigh, F.calf, F.foot, _fc);
    }
  }
  // ---------------------------------------------------------------- lying bodies follow the slope
  // As the pelvis comes down (knock-down, death), the root turns so its up axis becomes the ground normal under the
  // body, and a body part left under the surface lifts the body out. (Corpses lay level with their legs 25-40 cm in the
  // hill, the knocked-down hero's cloak 1.5 m under it: critic round 2, defect 6.) Call after place().
  groundTilt(dt, groundAt, lying, yaw, lift = true) {
    const pel = this.bones.pelvis; if (!pel) return;
    if (!lying && !this.tiltW) return;   // upright and untilted: nothing to do (no matrix work for every soldier)
    const R = this.root;
    R.updateMatrixWorld(true);
    const pw = pel.getWorldPosition(_tv), ph = pw.y - R.position.y;
    const want = lying ? 1 - Math.min(1, Math.max(0, (ph - 0.3) / 0.45)) : 0;
    this.tiltW = (this.tiltW || 0) + clamp(want - (this.tiltW || 0), -dt / 0.25, dt / 0.2);
    if (this.tiltW > 1e-3) {
      // the ground plane under the body: heights 0.9 m around the pelvis' ground point
      const cx = pw.x, cz = pw.z, e = 0.9;
      _tn.set(groundAt(cx - e, cz) - groundAt(cx + e, cz), 2 * e, groundAt(cx, cz - e) - groundAt(cx, cz + e)).normalize();
      _tq.setFromUnitVectors(UP, _tn); _tq0.identity().slerp(_tq, this.tiltW);
      // turn about the point of the clip's own floor under the pelvis, and move that point onto the ground there: the
      // body lies on the tangent plane under its middle, wherever its feet (the root) ended up. (Turning about the
      // ground point itself left a body whose pelvis lay downhill of its feet 0.45 m in the air.)
      const gx = cx, gz = cz, py = R.position.y, lift0 = (groundAt(cx, cz) - py) * this.tiltW;
      R.quaternion.setFromAxisAngle(UP, yaw).premultiply(_tq0);
      _tv.set(R.position.x - gx, 0, R.position.z - gz).applyQuaternion(_tq0);
      R.position.set(gx + _tv.x, py + lift0 + _tv.y, gz + _tv.z);
      R.updateMatrixWorld(true);
    } else this.tiltW = 0;
    // nothing under the surface: lift by the deepest of the upper body (and, once lying, the legs), at most 0.6 m. While
    // a knock-down is still falling (pelvis high, little tilt) the shoulders could reach 0.3-0.4 m into an uphill slope.
    if (lift && (lying || this.tiltW > 0)) {
      let low = 0;
      const chk = (n) => { const b = this.bones[n]; if (!b) return; b.getWorldPosition(_tv); low = Math.min(low, _tv.y - groundAt(_tv.x, _tv.z) - 0.04); };
      for (const n of UPPER) chk(n);
      if (this.tiltW > 0.6) for (const n of LOWER) chk(n);
      if (low < 0) { R.position.y += Math.min(0.6, -low) * (lying ? 1 : this.tiltW); R.updateMatrixWorld(true); }
    }
  }
  // Turn the chest (spine and neck, in equal shares) by `ang` radians about the vertical, after the clip: a soldier
  // whose legs walk round the hero keeps his shield and face toward him (critic round 3, defect 8). Restored next frame.
  twistUpper(ang) {
    if (Math.abs(ang) < 1e-3) return;
    const list = this._twist || (this._twist = ['spine_01', 'spine_02', 'spine_03', 'neck_01'].map((n) => this.bones[n]).filter(Boolean));
    if (!list.length) return;
    // each bone's own share is the same world turn seen in its parent's ORIGINAL frame (P^-1 R P), whatever its parents
    // do: all four parents are read first, then the four local turns are set (no sub-tree updates in between: the old
    // version rebuilt the whole upper body four times per soldier per frame)
    _q.setFromAxisAngle(UP, ang / list.length);
    const pq = this._twistPQ || (this._twistPQ = list.map(() => new THREE.Quaternion()));
    list.forEach((b, i) => b.parent.getWorldQuaternion(pq[i]));
    list.forEach((b, i) => { this.saveBone(b); _q2.copy(pq[i]).invert().multiply(_q).multiply(pq[i]); b.quaternion.premultiply(_q2); });
  }
  saveBone(b) { if (!this.procSaved) this.procSaved = new Map(); if (!this.procSaved.has(b)) this.procSaved.set(b, b.quaternion.clone()); }
  restoreProc() { if (!this.procSaved || !this.procSaved.size) return; for (const [b, q] of this.procSaved) b.quaternion.copy(q); this.procSaved.clear(); }
  resetGround() {
    this.tiltW = 0; this.gDrop = 0; this.gW = 0;
    if (this.feet) for (const F of this.feet) { F.w = 0; F.dy = 0; F.lift = 0; F.locked = false; F.slip = false; }
    if (this.loco) { this.loco.ws = null; this.loco.prevSpeed = 0; }
  }
  setShadow(on) { for (const m of this.meshes) m.castShadow = on; }
  setVisible(v) { this.root.visible = v; }
}
