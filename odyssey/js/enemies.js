// Cicones: heavy spearmen (black aspis, Thracian helmet) and light javelin men (pelta, pilos). Each soldier is one
// merged SkinnedMesh (one draw call) with a far LOD. Group behaviour that reads at a glance: a ring around the
// hero with attack tokens (they take turns, telegraphing with a glint), a marching shield wall whose members share
// ONE drill skeleton while in step (one animation evaluation for the whole block), javelin skirmishers that keep
// their distance and throw on a ballistic arc. Bodies stay on the ground for a while, then sink.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Actor } from './character.js';
import { instanceMaterial } from './skinned.js';
import { damp, dampAngle, clamp, wrapAngle, rand, smoothstep } from './util.js';
import { waterDepth, surfaceAt } from './terrain.js';
import { groundAt, resolve, clampWorld, pointBlocked } from './collide.js';
import { addAerialFog } from './env.js';

// Spear_Thrust_Overhand measured in the soldier's frame (fix round 1): the point leaves the wind-up 1.25 m ahead,
// 0.97 m to his right, at 1.5 m height, and with the lunge reaches 3.66 m ahead, 0.64 m right, 0.66 m high.
// He turns a little left as he strikes so the point runs into the hero's centre, and he thrusts from 1.7-3.1 m.
const SPEAR_RIGHT = 0.75, THRUST_MIN = 1.7, THRUST_MAX = 3.1;
const spearAim = (d) => Math.atan2(SPEAR_RIGHT, clamp(d, 1.8, 3.6));
const TINTS = [[1, 1, 1], [0.92, 0.9, 0.86], [1.04, 0.98, 0.9], [0.88, 0.86, 0.84], [0.97, 0.93, 0.98], [1.02, 1.0, 0.94]];
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _tip = new THREE.Vector3(), _m4 = new THREE.Matrix4();
const _a0 = new THREE.Vector3(), _a1 = new THREE.Vector3(), _sq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _hq = new THREE.Quaternion();
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3();
// shortest distance between segments p1-q1 and p2-q2
function segDist(p1, q1, p2, q2) {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let sN, tN;
  if (a <= 1e-9 && e <= 1e-9) return _r.length();
  if (a <= 1e-9) { sN = 0; tN = clamp(f / e, 0, 1); }
  else {
    const c = _d1.dot(_r);
    if (e <= 1e-9) { tN = 0; sN = clamp(-c / a, 0, 1); }
    else {
      const b = _d1.dot(_d2), den = a * e - b * b;
      sN = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      tN = (b * sN + f) / e;
      if (tN < 0) { tN = 0; sN = clamp(-c / a, 0, 1); } else if (tN > 1) { tN = 1; sN = clamp((b - c) / a, 0, 1); }
    }
  }
  const cx = p1.x + _d1.x * sN - (p2.x + _d2.x * tN), cy = p1.y + _d1.y * sN - (p2.y + _d2.y * tN), cz = p1.z + _d1.z * sN - (p2.z + _d2.z * tN);
  return Math.hypot(cx, cy, cz);
}

export class Soldier {
  constructor(mgr, type, idx) {
    this.m = mgr; this.type = type; this.idx = idx;
    const src = type === 'heavy' ? (idx % 2 === 1 && mgr.C.heavy2 ? mgr.C.heavy2 : mgr.C.heavy) : mgr.C.light;
    const root = SkeletonUtils.clone(src.template);
    root.traverse((o) => { if (o.isSkinnedMesh) { this.mesh = o; } });
    this.mesh.material = instanceMaterial(src.material);
    addAerialFog(this.mesh.material);
    this.mesh.castShadow = false; this.mesh.receiveShadow = true;
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1.6);
    this.geos = [src.lod0, src.lod, src.lod2];
    this.ownSkeleton = this.mesh.skeleton;
    this.actor = new Actor(root, mgr.C.soldierTable, { shield: true, guardClip: mgr.C.guardClip });
    if (type === 'light') {
      const jav = mgr.C.gear.javelin.clone(true);
      // (a held javelin is thin: no shadow-pass draw calls for it, 3 per light soldier)
      jav.traverse((o) => { if (o.isMesh) { o.castShadow = false; for (const mm of [].concat(o.material)) addAerialFog(mm); } });
      this.actor.attach('javelin', jav, mgr.C.attach.javelin);
      this.jav = jav;
    }
    root.visible = false;
    mgr.scene.add(root);
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.push = new THREE.Vector3();
    this.active = false; this.dead = false; this.lod = -1; this.drilled = false;
  }
  get root() { return this.actor.root; }
  spawn(x, z, mode, opt = {}) {
    this.active = true; this.dead = false; this.state = mode; this.t = 0; this.corpseT = 0;
    this.hp = this.type === 'heavy' ? 64 : 40;
    this.pos.set(x, opt.y ?? groundAt(x, z), z);
    this.vel.set(0, 0, 0); this.push.set(0, 0, 0);
    this.yaw = opt.yaw ?? 0; this.cool = rand(1.2, 3.2); this.token = false;
    this.slot = rand(-Math.PI, Math.PI); this.ring = this.type === 'heavy' ? rand(3.4, 5.0) : rand(11, 16);
    // waiting on the ring is not standing still: each man drifts round the hero and feints in and out (3-5 m)
    this.ringBase = this.ring; this.feintP = rand(0, 6.28); this.feintW = rand(0.8, 1.5); this.outer = false;
    this.orbit = rand(0.1, 0.22) * (Math.random() < 0.5 ? -1 : 1); this.orbitT = rand(3, 7); this.spearUp = 0;
    this.scale = rand(0.96, 1.05);
    this.root.scale.setScalar(this.scale);
    const tt = TINTS[(this.idx * 7) % TINTS.length];
    this.mesh.material.userData.uniforms.uTint.value.setRGB(tt[0], tt[1], tt[2]);
    if (this.mesh.material.userData.uniforms.uEmblem) this.mesh.material.userData.uniforms.uEmblem.value = (this.idx * 5 + 3) % 12;   // his own shield device
    this.mesh.material.userData.uniforms.uFade.value = 0;
    this.mesh.material.userData.uniforms.uFlash.value = 0;
    this.actor.frozen = false; this.actor.resetGround(); this.tiltDone = null;
    this.root.visible = true; this.sink = 0; this.sinkFade = 0; this.camFade = 0;
    this.jump = opt.jump || null; this.target = opt.target || null;
    this.group = opt.group || null; this.speed = 0;
    if (this.jav) this.jav.visible = true;
    this.lod = -1; this.setLOD(0, true);
    this.actor.setLoco(0, 0.01);
    if (mode === 'jump') this.actor.play('jump', { fade: 0 });
    this.place();
  }
  despawn() {
    this.active = false; this.root.visible = false;
    if (this.token) this.m.releaseToken(this);
    if (this.drilled) this.undrill();
    if (this.group) { this.group.remove(this); this.group = null; }
  }
  setLOD(l, shadow) {
    this.mesh.castShadow = shadow;
    if (l === this.lod) return;
    this.lod = l;
    this.mesh.geometry = this.geos[l];
    this.actor.halfRate = l >= 1;
  }
  place() { this.root.position.copy(this.pos); this.root.rotation.set(0, this.yaw, 0); }
  // ---- shared drill skeleton (shield wall marching in step)
  drill(sk) {
    if (this.drilled) return;
    this.drilled = true; this.actor.restoreProc();
    this.mesh.skeleton = sk; this.mesh.bindMode = 'detached';
    this.mesh.bindMatrix.identity(); this.mesh.bindMatrixInverse.identity();
  }
  undrill() {
    if (!this.drilled) return;
    this.drilled = false;
    this.mesh.skeleton = this.ownSkeleton; this.mesh.bindMode = 'attached';
    this.mesh.bindMatrix.identity();
  }
  facing(px, pz) { const dx = px - this.pos.x, dz = pz - this.pos.z, d = Math.hypot(dx, dz) || 1; return (dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw)) / d; }
  // ---- damage. returns { killed, blocked }
  takeHit(dmg, dir, opt = {}) {
    if (this.dead) return { killed: false };
    const g = this.m.game;
    // shield wall: frontal light blows ring off the aspis
    if (this.group && this.group.locked && !opt.heavy && opt.from && this.facing(opt.from.x, opt.from.z) > 0.45 && this.state !== 'stagger') {
      this.actor.play('blockHit', { fade: 0.05 });
      this.state = 'blockHit'; this.t = 0;
      this.push.copy(dir).multiplyScalar(1.6);
      return { killed: false, blocked: true };
    }
    this.hp -= dmg;
    this.mesh.material.userData.uniforms.uFlash.value = 0.5;
    if (this.token) this.m.releaseToken(this);
    if (this.drilled) this.undrill();
    this.push.copy(dir).multiplyScalar(opt.push || 3.5);
    if (this.hp <= 0) {
      this.dead = true; this.state = 'dying'; this.t = 0;
      this.yaw = Math.atan2(-dir.x, -dir.z);
      if (opt.heavy) this.actor.play('knock', { fade: 0.05 }); else this.actor.play('death', { fade: 0.06 });
      this.push.multiplyScalar(opt.heavy ? 0.6 : 1.1);
      if (this.group) { this.group.remove(this); this.group = null; }
      if (this.jav) this.jav.visible = false;
      this.m.onKill(this, opt);
      return { killed: true };
    }
    this.yaw = Math.atan2(-dir.x, -dir.z);
    if (opt.heavy) { this.state = 'knock'; this.t = 0; this.actor.play('knock', { fade: 0.05 }); }
    else { this.state = 'stagger'; this.t = 0; this.actor.play(Math.random() < 0.5 ? 'hit' : 'hit2', { fade: 0.05 }); }
    if (this.group) { this.group.remove(this); this.group = null; }
    return { killed: false };
  }
  update(dt, P) {
    const A = this.actor, g = this.m.game;
    this.t += dt;
    const dx = P.pos.x - this.pos.x, dz = P.pos.z - this.pos.z, dist = Math.hypot(dx, dz);
    const toYaw = Math.atan2(dx, dz);
    let speed = 0, mvx = 0, mvz = 0, faceYaw = null, run = false, locoFwd = null;
    const depth = waterDepth(this.pos.x, this.pos.z), wade = 1 - 0.55 * smoothstep(0.2, 1.1, depth);
    const u = this.mesh.material.userData.uniforms;
    u.uFlash.value = Math.max(0, u.uFlash.value - dt * 4);
    switch (this.state) {
      case 'jump': {
        const j = this.jump, k = clamp(this.t / j.dur, 0, 1);
        this.pos.x = j.a.x + (j.b.x - j.a.x) * k; this.pos.z = j.a.z + (j.b.z - j.a.z) * k;
        this.pos.y = j.a.y + (j.b.y - j.a.y) * k + 4 * j.h * k * (1 - k);
        this.yaw = Math.atan2(j.b.x - j.a.x, j.b.z - j.a.z);
        if (k >= 1) { this.state = 'land'; this.t = 0; A.play('land', { fade: 0.06 }); g.fx.splash(this.pos, 22, 1.1); g.audio.splash(this.pos, 1); }
        this.place(); A.update(dt); return;
      }
      case 'land': if (A.done || this.t > 0.5) { this.state = this.type === 'light' ? 'skirmish' : 'approach'; this.t = 0; A.setLoco(0, 0.2); } break;
      case 'emerge': {
        const tg = this.target, ex = tg.x - this.pos.x, ez = tg.z - this.pos.z, ed = Math.hypot(ex, ez);
        if (ed < 0.5 || this.t > 5) { this.state = this.type === 'light' ? 'skirmish' : 'approach'; this.t = 0; break; }
        speed = 1.0; mvx = ex / ed; mvz = ez / ed;
        break;
      }
      case 'form': { // member of a shield wall: hold the slot, face the front, thrust when the hero is close
        const G = this.group;
        if (!G) { this.state = 'approach'; break; }
        const s = G.slotPos(this);
        const wx = s.x - this.pos.x, wz = s.z - this.pos.z, wd = Math.hypot(wx, wz);
        faceYaw = G.yaw;
        if (wd > 0.25) { speed = Math.min(G.speed + wd * 1.2, 2.2); mvx = wx / wd; mvz = wz / wd; }
        this.inSlot = wd < 0.35;
        this.cool -= dt;
        const front = this.facing(P.pos.x, P.pos.z);
        if (P.alive && this.row === 0 && dist < THRUST_MAX && dist > THRUST_MIN && front > 0.5 && this.cool <= 0) this.startThrust();
        break;
      }
      case 'approach': {
        if (!P.alive) break;
        const want = this.ringPoint(P), wx = want.x - this.pos.x, wz = want.z - this.pos.z, wd = Math.hypot(wx, wz);
        if (dist < this.ring + 1.0) { this.state = 'circle'; this.t = 0; break; }
        speed = wd > 7 ? 5.2 : 1.2; run = speed > 2; mvx = wx / (wd || 1); mvz = wz / (wd || 1);
        break;
      }
      case 'circle': {
        if (!P.alive) { faceYaw = toYaw; break; }
        if (dist > this.ring + 5) { this.state = 'approach'; break; }
        this.cool -= dt;
        if (this.cool <= 0 && !this.token) this.m.requestToken(this, dist);
        if (!this.token && this.type === 'heavy') {
          this.orbitT -= dt; if (this.orbitT <= 0) { this.orbit = -this.orbit * rand(0.8, 1.25); this.orbitT = rand(3, 7); }
          this.slot = wrapAngle(this.slot + this.orbit * dt);
          this.ring = Math.max(3.2, (this.outer ? this.ringBase + 2.6 : this.ringBase) + 0.75 * Math.sin(this.t * this.feintW + this.feintP));
        }
        const want = this.token ? { x: P.pos.x - dx / (dist || 1) * 2.6, z: P.pos.z - dz / (dist || 1) * 2.6 } : this.ringPoint(P);
        const wx = want.x - this.pos.x, wz = want.z - this.pos.z, wd = Math.hypot(wx, wz);
        if (wd > 0.4) { speed = this.token ? 2.4 : Math.min(1.1, wd * 1.4); mvx = wx / wd; mvz = wz / wd; }
        // He keeps his face and shield toward the hero. Edging round the ring his body turns at most 60 degrees toward the
        // way he goes (or, giving ground, away from it: he walks backward), and his chest turns back to the hero. He
        // used to turn his whole body along the path and walk forward, side or back to the hero (critic round 3,
        // defect 8; there is no sidestep clip).
        if (speed < 0.35 || this.token) faceYaw = toYaw;
        else {
          const rel = wrapAngle(Math.atan2(mvx, mvz) - toYaw), off = Math.abs(rel) > Math.PI / 2 ? wrapAngle(rel - Math.PI) : rel;
          faceYaw = toYaw + clamp(off, -1.05, 1.05);
        }
        // a spear needs room: too close, he gives ground first (the point must travel to the hero, not start past him)
        if (this.token && dist < THRUST_MAX - 0.2 && dist > THRUST_MIN) this.startThrust();
        else if (this.token && dist <= THRUST_MIN && this.t > 0.2) { this.state = 'retreat'; this.t = 0; this.retreatT = 0.45; }
        break;
      }
      case 'windup':
        faceYaw = toYaw + spearAim(dist);
        if (this.t > 0.36) { this.state = 'attack'; this.t = 0; A.setTimeScale(1.15); this.hitDone = false; g.audio.swing(this.pos, 0.7); }
        break;
      case 'attack': {
        const c = A.cur, tt = c ? c.action.time : 99, e = A.meta;
        if (tt < 0.2) faceYaw = toYaw + spearAim(dist);
        // the spear point is traced every frame; the thrust stops where it meets the hero's shield or body
        if (!this.hitDone && P.alive && tt >= 0.17 && tt <= 0.47) {
          const hit = this.m.spearContact(this, P);
          if (hit) {
            this.hitDone = true; A.hold(true); this.state = 'thrustStop'; this.t = 0; this.stopKind = hit.kind;
            const r = P.takeDamage(e.dmg || 11, this.pos, { at: hit.point, onShield: hit.kind === 'shield' });
            this.stopKind = (r === 'blocked' || r === 'broken') ? 'shield' : (r === true ? 'body' : 'none');
            if (this.stopKind === 'none') { A.hold(false); this.state = 'attack'; }   // dodged / invulnerable: carry on
            break;
          }
        }
        if (A.done || tt >= (e.duration || 0.85) * 0.94) {
          this.m.releaseToken(this); this.cool = rand(2.0, 3.6); this.t = 0;
          // after the thrust he steps back out to the ring instead of standing inside it with the token gone
          if (this.group) { this.state = 'form'; } else if (dist < 2.9) { this.state = 'retreat'; this.retreatT = 0.6; } else this.state = 'circle';
          A.setLoco(0, 0.25);
        }
        break;
      }
      case 'thrustStop': {
        // the point rests where it struck for a beat, then: off the bronze it bounces back (the man reels),
        // out of flesh it is drawn back along its own path (the clip played in reverse)
        if (this.stopKind === 'shield') {
          if (this.t > 0.06) {
            A.hold(false); A.play('blockHit', { fade: 0.06, rate: 1.4 });
            this.push.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).multiplyScalar(2.4);
            this.state = 'blockHit'; this.t = 0; this.m.releaseToken(this); this.cool = rand(2.0, 3.6);
          }
        } else if (this.t > 0.09 && !this.retract) { A.hold(false); A.setTimeScale(-1.4); this.retract = true; }
        else if (this.retract && this.t > 0.3) {
          this.retract = false; this.m.releaseToken(this); this.cool = rand(2.0, 3.6); this.t = 0;
          this.state = this.group ? 'form' : dist < 2.9 ? 'retreat' : 'circle'; if (this.state === 'retreat') this.retreatT = 0.6; A.setLoco(0, 0.25);
        }
        break;
      }
      case 'blockHit': if (this.t > 0.45) { this.state = this.group ? 'form' : 'circle'; A.setLoco(0, 0.2); } break;
      case 'stagger': if (this.t > 0.45) { this.state = 'retreat'; this.t = 0; this.retreatT = rand(0.6, 1.2); A.setLoco(0, 0.2); } break;
      case 'knock': if (A.done) { this.state = 'getup'; this.t = 0; A.play('getup', { fade: 0.1 }); } break;
      case 'getup': if (A.done || A.ratio > 0.9) { this.state = this.type === 'light' ? 'skirmish' : 'circle'; this.t = 0; A.setLoco(0, 0.25); } break;
      case 'retreat':
        faceYaw = toYaw; speed = 1.0; mvx = -dx / (dist || 1); mvz = -dz / (dist || 1);
        if (this.t > this.retreatT) { this.state = this.type === 'light' ? 'skirmish' : 'circle'; this.t = 0; this.cool = rand(0.8, 2.0); }
        break;
      case 'skirmish': { // javelin man: hold 11-16 m, throw on cooldown
        if (!P.alive) break;
        this.cool -= dt;
        const want = this.ringPoint(P), wx = want.x - this.pos.x, wz = want.z - this.pos.z, wd = Math.hypot(wx, wz);
        if (dist < 4.5) { speed = 5.0; run = true; mvx = -dx / dist; mvz = -dz / dist; }
        else if (wd > 1.0) { speed = wd > 8 ? 5.0 : 1.1; run = speed > 2; mvx = wx / wd; mvz = wz / wd; }
        if (speed < 0.6) faceYaw = toYaw;
        if (this.cool <= 0 && dist > 6 && dist < 26 && this.jav.visible && this.m.throwsInAir() < 2 && this.m.canSee(this.pos, P.pos)) {
          this.state = 'throw'; this.t = 0; this.released = false; A.play('throw', { fade: 0.12 });
        }
        break;
      }
      case 'throw': {
        faceYaw = toYaw;
        const c = A.cur;
        if (!this.released && c && c.action.time >= A.meta.release) {
          this.released = true; this.jav.visible = false;
          this.m.throwJavelin(this, P);
        }
        if (A.done) { this.state = 'skirmish'; this.t = 0; this.cool = rand(3.5, 6.0); A.setLoco(0, 0.25); this.reloadT = 0.8; }
        break;
      }
      case 'flee': {
        const ax = this.pos.x - this.m.fleeFrom.x, az = this.pos.z - this.m.fleeFrom.z, ad = Math.hypot(ax, az) || 1;
        speed = 5.4; run = true; mvx = ax / ad; mvz = az / ad;
        if (this.t > 10 || (dist > 80 && this.lod >= 1)) { this.despawn(); return; }
        break;
      }
      case 'dying':
        // freeze on the clip's own end pose (lying), never on a fixed clock: a clip that ends before the clock
        // would otherwise run its last keys again, one that ends after it would freeze mid-fall
        if (!A.frozen && (A.done || this.t > 4.5)) { A.frozen = true; this.m.laySpear(this); }
        this.corpseT += dt;
        if (this.corpseT > this.m.corpseLife) { this.state = 'sink'; this.t = 0; }
        break;
      case 'sink':
        this.sink += dt * 0.25; this.sinkFade = Math.min(1, this.t / 2.5);
        if (this.t > 2.6) { this.despawn(); return; }
        break;
    }
    if (this.reloadT !== undefined && this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0 && this.jav && !this.dead) this.jav.visible = true; }
    // locomotion: velocity, facing, stride-locked blend
    const alive = this.state !== 'dying' && this.state !== 'sink';
    if (alive) {
      speed *= wade;
      this.vel.x = damp(this.vel.x, mvx * speed, 7, dt); this.vel.z = damp(this.vel.z, mvz * speed, 7, dt);
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (faceYaw !== null) this.yaw = dampAngle(this.yaw, faceYaw, 7, dt);
      else if (sp > 0.25) this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), 7, dt);
      if (['approach', 'circle', 'retreat', 'flee', 'emerge', 'skirmish', 'form'].includes(this.state)) {
        // the legs carry him only where they point: forward, or backward at a walk (the walk clip run back); what is left
        // sideways is mostly dropped, since no clip steps sideways (it slid the planted feet, critic round 3 defect 8)
        const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
        let fwd = this.vel.x * fx + this.vel.z * fz, lat = this.vel.x * fz - this.vel.z * fx;
        if (fwd < -1.3) fwd = -1.3;
        lat *= Math.exp(-83 * dt);   // (a quarter left per 1/60 s, at any frame rate)
        this.vel.x = fx * fwd + fz * lat; this.vel.z = fz * fwd - fx * lat;
        locoFwd = fwd;
      }
    } else this.vel.multiplyScalar(Math.exp(-6 * dt));
    const rm = A.rm;
    if (rm.x || rm.z) { const c = Math.cos(this.yaw), s = Math.sin(this.yaw); this.pos.x += s * rm.z + c * rm.x; this.pos.z += c * rm.z - s * rm.x; }
    const x0 = this.pos.x, z0 = this.pos.z, px0 = this.push.x, pz0 = this.push.z;
    this.pos.x += (this.vel.x + this.push.x) * dt; this.pos.z += (this.vel.z + this.push.z) * dt;
    this.push.multiplyScalar(Math.exp(-(this.dead ? 3.0 : 6) * dt));
    if (dist < 70 && this.state !== 'flee') resolve(this.pos, 0.38, this.pos.y + 0.2);
    if (!this.dead && this.state !== 'flee') clampWorld(this.pos, 0.5);
    if (P.alive && !this.dead && dist < 0.8 && dist > 0.01) { const k = (0.8 - dist) / dist; this.pos.x -= dx * k; this.pos.z -= dz * k; }
    // The stride follows where his body really went this frame: walking into a tent, a rock or the hero, the legs kept
    // striding at full speed while he stood still, and the planted feet slid under him (critic round 3, defect 8)
    if (locoFwd !== null) {
      if (dt > 1e-5) {
        const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
        const got = ((this.pos.x - x0) / dt - px0) * fx + ((this.pos.z - z0) / dt - pz0) * fz;
        const fwd = locoFwd >= 0 ? clamp(got, 0, locoFwd) : clamp(got, locoFwd, 0);
        if (Math.abs(locoFwd) > 0.05 && Math.abs(fwd) < Math.abs(locoFwd) - 0.02) { const k = fwd / locoFwd; this.vel.x *= k; this.vel.z *= k; }
        locoFwd = fwd;
      }
      A.setLoco(Math.abs(locoFwd) > 0.05 ? locoFwd : 0, 0.22);
    }
    this.pos.y = groundAt(this.pos.x, this.pos.z) - this.sink;
    this.place();
    if (!this.drilled) A.update(dt); else A.events.length = 0;
    // the chest and shield turn back to the hero while the legs walk round him (heavies on the ring, giving ground)
    if (A.updated && this.type === 'heavy' && alive && !this.drilled && this.lod <= 1 && P.alive && A.primary === 'loco' && (this.state === 'circle' || this.state === 'retreat')) {
      this.twist = damp(this.twist || 0, clamp(wrapAngle(toYaw - this.yaw), -1.1, 1.1), 6, dt * (A.halfRate ? 2 : 1));
      A.twistUpper(this.twist);
    } else if (A.updated) {
      // (and out of it smoothly when he stops circling: a thrust would start with the chest snapping round)
      this.twist = damp(this.twist || 0, 0, 9, dt * (A.halfRate ? 2 : 1));
      if (Math.abs(this.twist) > 0.01 && alive && !this.drilled) A.twistUpper(this.twist); else this.twist = 0;
    }
    // bodies on a slope lie along it (not level, legs in the hill: critic round 2, defect 6); a sinking corpse is not
    // lifted back out
    const lyingS = this.state === 'dying' || this.state === 'sink' || this.state === 'knock' || (this.state === 'getup' && A.ratio < 0.5);
    if (!this.drilled && (lyingS || this.lod <= 1)) {
      if (A.frozen && this.state === 'dying' && A.tiltW >= 1 && this.tiltDone && Math.hypot(this.push.x, this.push.z) < 0.02) { this.root.position.copy(this.tiltDone.p); this.root.quaternion.copy(this.tiltDone.q); }
      else {
        A.groundTilt(dt, groundAt, lyingS, this.yaw, this.state !== 'sink');
        if (A.frozen && this.state === 'dying' && A.tiltW >= 1) this.tiltDone = { p: this.root.position.clone(), q: this.root.quaternion.clone() };
        else this.tiltDone = null;
      }
    }
    // close soldiers plant their feet too (two-bone leg IK, as the hero), and stand on slopes with both feet; far ones
    // are not worth the bones
    // (planted while walking AND standing, on the two nearest LODs: a standing man shoved by the crowd, turning or
    //  edging round the ring now steps instead of gliding, critic round 3 defect 8)
    const walking = !this.drilled && this.lod <= 1 && alive && A.primary === 'loco' && dt > 0 && this.state !== 'jump' && this.state !== 'land';
    const uprightS = alive && this.state !== 'knock' && this.state !== 'getup' && this.state !== 'jump' && this.state !== 'land';
    // (the leg IK costs a skeleton update: on flat ground with no planted foot it is skipped)
    const sloped = uprightS && Math.abs(groundAt(this.pos.x + 0.5, this.pos.z) - groundAt(this.pos.x - 0.5, this.pos.z)) + Math.abs(groundAt(this.pos.x, this.pos.z + 0.5) - groundAt(this.pos.x, this.pos.z - 0.5)) > 0.04;
    const feetBusy = walking || sloped || (A.gDrop || 0) > 1e-3 || (A.feet && A.feet.some((f) => f.w > 0 || Math.abs(f.dy) > 1e-3));
    if (!this.drilled && this.lod <= 1 && feetBusy) A.footLock(dt, groundAt, walking, uprightS);
    // a waiting man's levelled spear must not run through the hero standing close to him: the wrist lifts it upright
    // (lod 0 and 1: the man right in front of the hero is ~5.5 m from the lens, already on the middle LOD)
    if (this.type === 'heavy' && alive && !this.drilled && this.lod <= 1 && dist < 4.5) { if (A.updated) this.m.guardSpear(this, P, dt); }
    else this.spearUp = 0;
    u.uFade.value = Math.max(this.sinkFade || 0, this.camFade || 0);
    // footsteps of close soldiers (budgeted)
    if (A.events.length && this.lod === 0 && this.m.stepBudget > 0 && dist < 18) {
      for (const ev of A.events) {
        if (this.m.stepBudget-- <= 0) break;
        const s = depth > 0.15 ? 'water' : surfaceAt(this.pos.x, this.pos.z, this.pos.y);
        g.audio.footstep(s, this.pos, 0.42);
      }
    }
  }
  startThrust() {
    this.state = 'windup'; this.t = 0; this.tipOk = false; this.retract = false;
    if (this.drilled) this.undrill();
    this.actor.play('thrust', { fade: 0.16, rate: 0.55 });
    this.m.game.onTelegraph(this);
  }
  ringPoint(P) { const a = this.slot; return { x: P.pos.x + Math.sin(a) * this.ring, z: P.pos.z + Math.cos(a) * this.ring }; }
}

// ------------------------------------------------------------------ shield wall
class Phalanx {
  constructor(mgr, members, x, z, yaw) {
    this.m = mgr; this.members = []; this.cx = x; this.cz = z; this.yaw = yaw; this.speed = 1.0; this.t = 0; this.locked = true;
    this.cols = Math.ceil(members.length / 2);
    members.forEach((s, i) => { s.group = this; s.row = Math.floor(i / this.cols); s.col = i % this.cols; s.state = 'form'; this.members.push(s); });
    this.drillActor = mgr.makeDrill();
    this.behind = 0;
  }
  remove(s) { const i = this.members.indexOf(s); if (i >= 0) this.members.splice(i, 1); if (s.drilled) s.undrill(); }
  slotPos(s) {
    const lat = (s.col - (this.cols - 1) / 2) * 1.3, back = -s.row * 1.7;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    return { x: this.cx + fz * lat + fx * back, z: this.cz - fx * lat + fz * back };
  }
  update(dt, P) {
    this.t += dt;
    const dx = P.pos.x - this.cx, dz = P.pos.z - this.cz, dist = Math.hypot(dx, dz);
    const want = Math.atan2(dx, dz);
    this.yaw = this.yaw + clamp(wrapAngle(want - this.yaw), -0.45 * dt, 0.45 * dt);
    const front = (dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw)) / (dist || 1);
    this.behind = front < -0.2 && dist < 10 ? this.behind + dt : Math.max(0, this.behind - dt);
    this.speed = dist > 3.2 ? 1.0 : 0;
    this.cx += Math.sin(this.yaw) * this.speed * dt; this.cz += Math.cos(this.yaw) * this.speed * dt;
    // the drill skeleton walks at exactly the formation speed; members in their slot borrow its pose
    this.drillActor.setLoco(this.speed, 0.3);
    this.drillActor.update(dt);
    for (const s of this.members) {
      const ok = s.state === 'form' && s.inSlot && Math.abs(wrapAngle(s.yaw - this.yaw)) < 0.25;
      if (ok && !s.drilled) { s.drill(this.drillActor.skeleton); }
      else if (!ok && s.drilled) { s.actor.loco.phase = this.drillActor.loco.phase; s.undrill(); }
    }
    // the wall breaks when thinned, outflanked or after a while
    if (this.members.length <= 3 || this.behind > 2.5 || this.t > 50 || !P.alive) this.dissolve();
  }
  dissolve() {
    this.locked = false;
    for (const s of [...this.members]) { s.group = null; if (s.drilled) s.undrill(); if (s.state === 'form') { s.state = 'circle'; s.t = 0; } }
    this.members.length = 0;
    this.done = true;
    this.m.scene.remove(this.drillActor.root);
  }
}

export class EnemyManager {
  constructor(game, C, { heavy = 22, light = 10 } = {}) {
    this.game = game; this.scene = game.scene; this.C = C;
    this.list = [];
    for (let i = 0; i < heavy; i++) this.list.push(new Soldier(this, 'heavy', i));
    for (let i = 0; i < light; i++) this.list.push(new Soldier(this, 'light', heavy + i));
    this.tokens = new Set(); this.maxTokens = 2;
    this.fleeFrom = new THREE.Vector3();
    this.stepBudget = 3; this.corpseLife = 28;
    this.blobs = []; this.groups = [];
    // LOD / shadow budget (tunable from __debug for measurements): finest mesh closer than lodNear, middle to lodMid,
    // real shadow maps for at most maxCasters soldiers nearer than casterDist (the rest get blob shadows)
    // (side-by-side renders at 5.5 / 9 / 14 m, fix round 1: the middle mesh cannot be told from the finest at 5.5 m,
    //  nor the coarse one from the middle at 9 m; was 7 / 22 m)
    // real shadows for the 4 nearest within 11 m (was 6: on a shared machine the crowd fight still dropped frames,
    // critic round 1 defect 10's fallback)
    this.lodNear = 4.5; this.lodMid = 10; this.maxCasters = 4; this.casterDist = 11;
    this.javs = [];       // flying / stuck javelins
    this.drillPool = [];
  }
  makeDrill() {
    const root = SkeletonUtils.clone(this.C.heavy.template);
    let mesh = null; root.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
    mesh.visible = false;   // bones only: never drawn
    this.scene.add(root);
    const a = new Actor(root, this.C.soldierTable, { shield: true, guardClip: this.C.guardClip });
    a.skeleton = mesh.skeleton;
    return a;
  }
  // Where does this soldier's spear point meet the hero? The point is swept from the last frame to this one and
  // tested against the hero's shield disc (crossing its plane from the front) and his body (a 0.24 m cylinder,
  // 0.55-1.75 m). Returns { kind: 'shield' | 'body', point } or null.
  // A corpse's spear lies down. The dory is skinned to the right hand, so in some death poses it stood straight up out
  // of the body (round-1 re-test, critic's corpse script). Once the pose is frozen, the wrist turns the shaft flat
  // along its own heading (the hand is small; a bent wrist on a corpse reads, a mast of a spear did not).
  laySpear(s) {
    const hand = s.actor.bones.hand_r; if (!hand) return;
    if (s.type !== 'heavy' && !(s.jav && s.jav.visible)) return;
    if (!this._spear) {
      const mk = (e) => new THREE.Matrix4().compose(new THREE.Vector3(...e.position), new THREE.Quaternion(...e.quaternion), new THREE.Vector3(1, 1, 1));
      this._spear = { heavy: { M: mk(this.C.attach.dory), len: this.C.weaponLen.dory }, light: { M: mk(this.C.attach.javelin), len: this.C.weaponLen.javelin } };
    }
    const sp = this._spear[s.type === 'heavy' ? 'heavy' : 'light'];
    s.root.updateMatrixWorld(true);
    _m4.multiplyMatrices(hand.matrixWorld, sp.M);
    const grip = _v.setFromMatrixPosition(_m4), tip = _tip.set(0, 0, -sp.len).applyMatrix4(_m4);
    const dir = tip.sub(grip).normalize();
    if (Math.abs(dir.y) < 0.35) return;
    const h = _w.set(dir.x, 0, dir.z); if (h.lengthSq() < 1e-4) h.set(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    h.normalize().setY(-0.04).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(dir, h);
    const pq = hand.parent.getWorldQuaternion(new THREE.Quaternion()), wq = hand.getWorldQuaternion(new THREE.Quaternion());
    hand.quaternion.copy(pq.invert().multiply(q.multiply(wq)));
    hand.updateMatrixWorld(true);
  }
  // The shaft of a soldier's levelled spear (grip -> point) against the hero's body axis (0.3-1.8 m above his feet):
  // closer than 0.5 m and the soldier is not thrusting -> the spear is raised upright (blended in ~0.15 s, out in
  // ~0.25 s). Before, a waiting soldier's spear passed through the hero's chest whenever he stood within ~1.2 m (critic
  // round 2, defect 8). Thrusts keep their own stop-at-contact (spearContact).
  guardSpear(s, P, dt) {
    const hand = s.actor.bones.hand_r; if (!hand) return;
    if (!this._spear) {
      const mk = (e) => new THREE.Matrix4().compose(new THREE.Vector3(...e.position), new THREE.Quaternion(...e.quaternion), new THREE.Vector3(1, 1, 1));
      this._spear = { heavy: { M: mk(this.C.attach.dory), len: this.C.weaponLen.dory }, light: { M: mk(this.C.attach.javelin), len: this.C.weaponLen.javelin } };
    }
    const sp = this._spear.heavy, busy = s.state === 'windup' || s.state === 'attack' || s.state === 'thrustStop';
    s.root.updateMatrixWorld(true);
    _m4.multiplyMatrices(hand.matrixWorld, sp.M);
    const grip = _v.setFromMatrixPosition(_m4), tip = _tip.set(0, 0, -sp.len).applyMatrix4(_m4);
    const d = segDist(grip, tip, _a0.set(P.pos.x, P.pos.y + 0.3, P.pos.z), _a1.set(P.pos.x, P.pos.y + 1.8, P.pos.z));
    const want = !busy && P.alive && d < 0.5 ? 1 : 0;
    s.spearUp = clamp(s.spearUp + clamp(want - s.spearUp, -dt / 0.25, dt / 0.15), 0, 1);
    if (s.spearUp <= 1e-3) return;
    const dir = tip.sub(grip).normalize();
    const up = _w.set(Math.sin(s.yaw) * 0.25, 1, Math.cos(s.yaw) * 0.25).normalize();
    const target = _a0.copy(dir).lerp(up, s.spearUp * s.spearUp * (3 - 2 * s.spearUp)).normalize();
    _sq.setFromUnitVectors(dir, target);
    s.actor.saveBone(hand);
    hand.parent.getWorldQuaternion(_pq); hand.getWorldQuaternion(_hq);
    hand.quaternion.copy(_pq.invert().multiply(_sq.multiply(_hq)));
    hand.updateMatrixWorld(true);
  }
  spearContact(s, P) {
    const hand = s.actor.bones.hand_r; if (!hand) return null;
    if (s.type !== 'heavy' && !(s.jav && s.jav.visible)) return null;
    if (!this._spear) {
      const mk = (e) => new THREE.Matrix4().compose(new THREE.Vector3(...e.position), new THREE.Quaternion(...e.quaternion), new THREE.Vector3(1, 1, 1));
      this._spear = { heavy: { M: mk(this.C.attach.dory), len: this.C.weaponLen.dory }, light: { M: mk(this.C.attach.javelin), len: this.C.weaponLen.javelin } };
    }
    const sp = this._spear[s.type === 'heavy' ? 'heavy' : 'light'];
    s.root.updateMatrixWorld(true);
    _m4.multiplyMatrices(hand.matrixWorld, sp.M);
    const tip = _tip.set(0, 0, -sp.len).applyMatrix4(_m4);
    if (!s.prevTip) s.prevTip = new THREE.Vector3();
    if (!s.tipOk) { s.prevTip.copy(tip); s.tipOk = true; return null; }
    const prev = s.prevTip;
    let out = null;
    const disc = P.shieldDisc ? P.shieldDisc() : null;
    if (disc) {
      const d0 = _w.copy(prev).sub(disc.c).dot(disc.n), d1 = _v.copy(tip).sub(disc.c).dot(disc.n);
      if (d0 > -0.03 && d1 <= 0 && d0 - d1 > 1e-5) {
        const u = d0 / (d0 - d1), p = prev.clone().lerp(tip, u);
        if (p.distanceTo(disc.c) < disc.r + 0.04) out = { kind: 'shield', point: p.addScaledVector(disc.n, 0.012) };
      }
    }
    if (!out) {
      for (let k = 1; k <= 5; k++) {
        const p = _v.copy(prev).lerp(tip, k / 5), h = p.y - P.pos.y;
        if (h > 0.55 && h < 1.75 && Math.hypot(p.x - P.pos.x, p.z - P.pos.z) < 0.24) { out = { kind: 'body', point: p.clone() }; break; }
      }
    }
    prev.copy(tip);
    return out;
  }
  get alive() { let n = 0; for (const e of this.list) if (e.active && !e.dead) n++; return n; }
  free(type) { return this.list.find((e) => !e.active && e.type === type) || this.list.find((e) => !e.active && e.dead && e.type === type); }
  spawn(x, z, mode, opt = {}) {
    let e = this.free(opt.type || 'heavy');
    if (!e) { // recycle the oldest corpse of that type
      const c = this.list.filter((s) => s.active && s.dead && s.type === (opt.type || 'heavy')).sort((a, b) => b.corpseT - a.corpseT)[0];
      if (!c) return null; c.despawn(); e = c;
    }
    e.spawn(x, z, mode, opt); return e;
  }
  formPhalanx(x, z, yaw, n) {
    const members = [];
    for (let i = 0; i < n; i++) {
      const e = this.spawn(x, z, 'form', { type: 'heavy', yaw }); if (!e) break;
      members.push(e);
    }
    const G = new Phalanx(this, members, x, z, yaw);
    members.forEach((s) => { const p = G.slotPos(s); s.pos.set(p.x, groundAt(p.x, p.z), p.z); s.place(); });
    this.groups.push(G);
    return G;
  }
  requestToken(e, dist) {
    if (this.tokens.size >= this.maxTokens) return;
    const cam = this.game.cam, f = cam.forward(), P = this.game.player.pos;
    const vis = ((e.pos.x - P.x) * f.x + (e.pos.z - P.z) * f.z) / (dist || 1);
    if (vis < -0.3 && Math.random() < 0.7) { e.cool = 0.5; return; }
    this.tokens.add(e); e.token = true;
  }
  releaseToken(e) { this.tokens.delete(e); e.token = false; }
  onKill(e, opt) { this.game.onEnemyKilled(e, opt); }
  fleeAll(from) {
    this.fleeFrom.copy(from);
    for (const g of this.groups) g.dissolve();
    for (const e of this.list) if (e.active && !e.dead) { e.state = 'flee'; e.t = 0; if (e.token) this.releaseToken(e); }
  }
  killAll() { for (const e of this.list) if (e.active && !e.dead) e.takeHit(999, new THREE.Vector3(0, 0, 1), { push: 2 }); }
  canSee(a, b) {
    for (let k = 1; k < 6; k++) { const u = k / 6, x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u, y = a.y + 1.5 + (b.y - a.y) * u; if (pointBlocked(x, y, z, 0.1)) return false; }
    return true;
  }
  throwsInAir() { let n = 0; for (const j of this.javs) if (j.flying) n++; return n; }
  throwJavelin(e, P) {
    const g = this.game;
    e.root.updateMatrixWorld(true);
    const from = e.jav.getWorldPosition(new THREE.Vector3());
    const lead = P.vel.clone().multiplyScalar(0.55);
    const to = new THREE.Vector3(P.pos.x + lead.x, P.pos.y + 1.2, P.pos.z + lead.z);
    const d = from.distanceTo(to), T = clamp(d / 21, 0.45, 1.3);
    let j = this.javs.find((q) => !q.flying && q.t > 12);
    if (!j) {
      if (this.javs.length >= 10) j = this.javs.sort((a, b) => b.t - a.t)[0];
      else { const o = this.C.gear.javelin.clone(true); o.traverse((m) => { if (m.isMesh) { m.castShadow = true; for (const mm of [].concat(m.material)) addAerialFog(mm); } }); this.scene.add(o); j = { o }; this.javs.push(j); }
    }
    j.o.visible = true;
    Object.assign(j, { flying: true, t: 0, T, from: from.clone(), to, owner: e, hitDone: false });
    g.audio.swing(from, 0.6);
  }
  updateJavelins(dt, P) {
    const g = this.game;
    for (const j of this.javs) {
      j.t += dt;
      if (!j.flying) { if (j.t > 14) j.o.visible = false; continue; }
      const u = Math.min(1, j.t / j.T);
      const h = 1.2 + j.T * 2.4;
      const x = j.from.x + (j.to.x - j.from.x) * u, z = j.from.z + (j.to.z - j.from.z) * u;
      const y = j.from.y + (j.to.y - j.from.y) * u + 4 * h * u * (1 - u);
      const prev = j.o.position.clone();
      j.o.position.set(x, y, z);
      // orient along the velocity: tip (-Z) forward
      _v.set(x - prev.x, y - prev.y, z - prev.z);
      if (_v.lengthSq() > 1e-6) { _w.copy(j.o.position).sub(_v); j.o.lookAt(_w); }
      if (!j.hitDone && P.alive && Math.hypot(P.pos.x - x, P.pos.z - z) < 0.75 && y > P.pos.y + 0.2 && y < P.pos.y + 2.1) {
        j.hitDone = true;
        const r = P.takeDamage(10, j.owner ? j.owner.pos : j.from);
        if (r === 'blocked' || r === 'broken') { j.flying = false; j.t = 0; j.o.position.y = groundAt(x, z) + 0.08; j.o.rotation.set(Math.PI / 2 - 0.12, j.o.rotation.y, 0, 'YXZ'); g.fx.sparks(j.o.position.clone().setY(P.pos.y + 1.2), 10); continue; }
        if (r === true) { j.flying = false; j.o.visible = false; continue; }
      }
      const gyy = groundAt(x, z);
      if (u >= 1 || y <= gyy + 0.05) {
        j.flying = false; j.t = 0;
        // stick into the ground along the flight direction, tip buried ~0.35 m
        const tip = _v.set(0, 0, -1).applyQuaternion(j.o.quaternion);
        j.o.position.set(x, gyy, z).addScaledVector(tip, -(this.C.weaponLen.javelin - 0.35));
        g.fx.dust({ x, y: gyy, z }, 4, 0.2, 0.4, [0.7, 0.6, 0.45], 0.5, 0.9);
        g.audio.thud({ x, y: gyy, z }, 0.35);
      }
    }
  }
  update(dt, P, camPos) {
    this.stepBudget = 3;
    for (const G of this.groups) if (!G.done) {
      G.update(dt, P);
      // a wall marching in step: one heavy footfall per contact of the drill pose
      if (G.drillActor.events.length && G.members.length) { const d = Math.hypot(G.cx - camPos.x, G.cz - camPos.z); if (d < 40) this.game.audio.footstep('march', { x: G.cx, y: groundAt(G.cx, G.cz), z: G.cz }, 0.9 * clamp(G.members.length / 6, 0.5, 1.3)); }
    }
    this.groups = this.groups.filter((G) => !G.done);
    // ring slot spreading + drift toward the hero's flanks / back
    const engaged = this.list.filter((e) => e.active && !e.dead && (e.state === 'circle' || e.state === 'approach' || e.state === 'retreat' || e.state === 'skirmish'));
    const back = Math.atan2(-Math.sin(P.yaw), -Math.cos(P.yaw));
    // the inner ring (3-5 m) holds about 11 spearmen 2 m apart; the rest wait on an outer ring 2.6 m further out.
    // (Thirteen men all wanting the same 4 m ring were packed 1-3.8 m round a hero who stood still, most of them
    // stopped: critic round 2, defect 9.) Slot spacing shrinks with the count so the ring can actually hold them.
    const heavies = engaged.filter((e) => e.type === 'heavy').sort((a, b) => a.pos.distanceToSquared(P.pos) - b.pos.distanceToSquared(P.pos));
    heavies.forEach((e, i) => { e.outer = i >= 11; });
    const nIn = Math.min(11, heavies.length), limH = Math.max(0.42, Math.min(0.9, (2 * Math.PI / Math.max(1, nIn)) * 0.88));
    for (const e of engaged) {
      let push = 0;
      for (const o of engaged) {
        if (o === e || o.type !== e.type || o.outer !== e.outer) continue;
        const d = wrapAngle(e.slot - o.slot), lim = e.type === 'light' ? 0.6 : limH;
        const near = Math.abs(d) < lim ? (lim - Math.abs(d)) : 0;
        push += Math.sign(d || 0.01) * near;
      }
      const toBack = wrapAngle(back - e.slot);
      e.slot = wrapAngle(e.slot + (push * 1.1 + toBack * (e.type === 'heavy' && heavies.length < 6 ? 0.05 : 0)) * dt);
    }
    const blobs = this.blobs; blobs.length = 0;
    let casters = 0;
    for (const e of this.list) {
      if (!e.active) continue;
      const d = Math.hypot(e.pos.x - camPos.x, e.pos.z - camPos.z);
      // finest clustered LOD close to the lens, coarser beyond; real shadows for at most 6 near soldiers
      const lvl = d < this.lodNear ? 0 : d < this.lodMid ? 1 : 2;
      const near = d < this.casterDist && !(e.dead && e.t > 3) && casters < this.maxCasters;
      if (near) casters++;
      // a soldier near the lens dissolves (moving dither) instead of filling the screen: measured to his body (0.2-1.8 m),
      // not to his feet, so a man whose torso is beside the camera does not leave his hands and feet on screen (critic
      // round 2, defect 17); the javelin goes with him
      { const by = Math.max(e.pos.y + 0.2, Math.min(e.pos.y + 1.8, camPos.y)), dd = Math.hypot(d, camPos.y - by);
        e.camFade = dd < 2.2 ? Math.min(1, (2.2 - dd) / 1.0) : 0;
        if (e.jav) { const show = e.camFade < 0.6; if (e.jav.userData.camShow !== show) { e.jav.userData.camShow = show; for (const c of e.jav.children) c.visible = show; } } }
      e.setLOD(lvl, near);
      e.update(dt, P);
      if (!e.active) continue;
      if (!e.mesh.castShadow && !e.dead) blobs.push({ x: e.pos.x, y: e.pos.y, z: e.pos.z, r: 0.55 });
    }
    // separation between living soldiers (not inside a drilled wall: the slots already space them)
    const act = this.list.filter((e) => e.active && !e.dead && !e.drilled);
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.81 && d2 > 1e-6) { const d = Math.sqrt(d2), k = (0.9 - d) * 0.5 / d; a.pos.x -= dx * k; a.pos.z -= dz * k; b.pos.x += dx * k; b.pos.z += dz * k; }
    }
    // only the man with an attack token comes inside 2.9 m; the others are held out on the ring
    if (P.alive) for (const e of act) {
      if (e.token || e.type !== 'heavy' || !['circle', 'approach'].includes(e.state)) continue;
      const dx = e.pos.x - P.pos.x, dz = e.pos.z - P.pos.z, d = Math.hypot(dx, dz);
      if (d < 2.9 && d > 1e-3) { const k = Math.min(2.9 - d, 3.0 * dt) / d; e.pos.x += dx * k; e.pos.z += dz * k; }
    }
    this.updateJavelins(dt, P);
  }
}
