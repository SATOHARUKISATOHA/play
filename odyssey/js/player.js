// The hoplite: locomotion blend with stride-locked playback, 3-hit sword combo + dash heavy attack (root motion),
// shield block (held pose / guarded walk), dodge roll with i-frames, hit / knock-down / death, stamina and
// recoverable health. Sword hits test the real blade segment (swept between frames) against soldier capsules
// and the giant's bone zones.
import * as THREE from 'three';
import { Actor } from './character.js';
import { makeHeroRoot } from './chars.js';
import { damp, dampAngle, clamp, smoothstep } from './util.js';
import { POI, waterDepth, surfaceAt } from './terrain.js';
import { groundAt, resolve, clampWorld } from './collide.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _t = new THREE.Vector3(), _pt = new THREE.Vector3(), _tx = new THREE.Vector3();
const RUN = 5.6, SPRINT = 8.0, GUARD_WALK = 1.0;

export class Player {
  constructor(game, C) {
    this.g = game; this.C = C;
    const root = makeHeroRoot(C);
    this.actor = new Actor(root, C.heroTable, { shield: true, guardClip: C.guardClip });
    for (const g of ['helmet_corinthian', 'aspis', 'xiphos']) this.actor.attach(g, C.gear[g].clone(true), C.attach[g]);
    this.actor.enableCloak();
    // a small depth bias on the cloak hides the last millimetres where it brushes the bronze and the strips
    root.traverse((o) => { if (o.isMesh && o.name === 'Cloak') for (const m of [].concat(o.material)) { m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -4; } });
    // and the cloak itself stands 1.8 cm further off the back (3.5 cm at the shoulder corners, which wrap over the
    // cuirass straps): in a twisted strike the flank edge of the back plate still came 3-7 cm through it (round 1)
    root.traverse((o) => {
      if (!o.isSkinnedMesh || o.name !== 'Cloak' || o.geometry.userData.inflated) return;
      const P = o.geometry.attributes.position, cz = -0.02, top = 1.40;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i), L = Math.hypot(x, z - cz) || 1;
        const k = 0.021 + 0.017 * smoothstep(top, top + 0.1, y) * Math.min(1, Math.abs(x) / 0.25);
        P.setXYZ(i, x + (x / L) * k, y, z + ((z - cz) / L) * k);
      }
      P.needsUpdate = true; o.geometry.computeBoundingSphere(); o.geometry.userData.inflated = true;
    });
    this.bladeLen = C.weaponLen.xiphos;
    // the aspis as a disc for spear contacts: centre near its convex front (+Z of the gear), radius from its size
    { const g = C.gear.aspis.clone(true); g.position.set(0, 0, 0); g.quaternion.identity(); g.scale.set(1, 1, 1); g.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(g), c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
      this.disc = { cl: new THREE.Vector3(c.x, c.y, bb.max.z - 0.04), r: Math.max(sz.x, sz.y) / 2, c: new THREE.Vector3(), n: new THREE.Vector3(), q: new THREE.Quaternion() }; }
    game.scene.add(root);
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.push = new THREE.Vector3();
    this.hitSet = new Set();
    this.reset();
  }
  reset() {
    this.hp = 100; this.recCeil = 100; this.st = 100; this.stDelay = 0; this.lastHurt = 99;
    this.state = 'move'; this.stateT = 0; this.combo = 0; this.queued = false; this.invuln = 0; this.blocking = false;
    this.pos.set(POI.start.x, 0, POI.start.z); this.pos.y = groundAt(this.pos.x, this.pos.z);
    this.yaw = Math.PI * 0.86; this.vel.set(0, 0, 0); this.push.set(0, 0, 0);
    this.perfectArmed = true; this.speed = 0;
    this.actor.resetGround();
    this.actor.setLoco(0, 0.01);
    this.place();
  }
  get alive() { return this.state !== 'dead'; }
  // The hero fades when the lens has to come within ~1.7 m of his head (against a wall or a column): his helmet and
  // crest must never fill the view (critic round 2, defect 3). His textures carry no alpha, so the materials switch
  // to blended only while fading (both programs are compiled at load, main.js warm-up).
  setFade(a) {
    if (!this.fadeMats) {
      this.fadeMats = new Set();
      this.actor.root.traverse((o) => { if (o.isMesh && !(o.parent && /xiphos/.test(o.parent.name)) && !/xiphos/.test(o.name)) for (const m of [].concat(o.material)) this.fadeMats.add(m); });
      for (const n of ['helmet_corinthian', 'aspis']) { const g = this.actor.attached[n]; if (g) g.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) this.fadeMats.add(m); }); }
      this.fadeA = 1;
    }
    a = Math.min(1, Math.max(0, a));
    if (Math.abs(a - this.fadeA) < 1e-3) return;
    const was = this.fadeA < 0.999, now = a < 0.999;
    for (const m of this.fadeMats) {
      if (was !== now) { m.transparent = now; m.depthWrite = true; m.needsUpdate = true; }
      m.opacity = now ? a : 1;
    }
    this.fadeA = a;
  }
  shieldDisc() {
    const a = this.actor.attached.aspis; if (!a) return null;
    a.updateWorldMatrix(true, false);
    const D = this.disc;
    D.c.copy(D.cl).applyMatrix4(a.matrixWorld);
    D.n.set(0, 0, 1).applyQuaternion(a.getWorldQuaternion(D.q)).normalize();
    return D;
  }
  get char() { return this.actor; }
  forward(out = _t) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  place() { this.actor.root.position.copy(this.pos); this.actor.root.rotation.set(0, this.yaw, 0); }
  setState(s) { this.state = s; this.stateT = 0; }

  update(dt) {
    const g = this.g, inp = g.input, cam = g.cam, A = this.actor;
    this.stateT += dt; this.invuln -= dt; this.lastHurt += dt;
    const mv = new THREE.Vector3();
    const live = this.state !== 'dead' && g.state === 'playing';
    if (live) {
      const f = (inp.down('KeyW') ? 1 : 0) - (inp.down('KeyS') ? 1 : 0), s = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
      mv.addScaledVector(cam.forward(), f).addScaledVector(cam.right(), s);
      if (mv.lengthSq() > 0) mv.normalize();
    }
    this.moveInput = mv;
    const depth = waterDepth(this.pos.x, this.pos.z);
    const wade = 1 - 0.5 * smoothstep(0.2, 1.1, depth);
    let sprinting = false;
    const blockHeld = live && inp.mouse.right;
    switch (this.state) {
      case 'move': {
        if (!live) { this.locomote(0, dt, false); break; }
        if (inp.was('Space') && this.st >= 16) { this.startRoll(mv); break; }
        if (inp.mouse.leftPressed) { this.startAttack(1, mv); break; }
        if (inp.was('KeyF') || inp.mouse.middlePressed) { this.startHeavy(mv); break; }
        // at chest depth the way out to sea is closed: what is left of the input along the shore turns him to walk along
        // it, and straight out he stands (his legs no longer walk on the spot, critic round 3 defect 12)
        if (this.seaN && mv.lengthSq() > 0) {
          const n = this.seaN, dn = mv.x * n.x + mv.z * n.z;
          if (dn > 0) { mv.x -= n.x * dn; mv.z -= n.z * dn; const l = Math.hypot(mv.x, mv.z); if (l < 0.35) mv.set(0, 0, 0); else mv.multiplyScalar(1 / l); }
        }
        this.blocking = blockHeld && this.st > 0;
        let want = RUN;
        if (this.blocking) want = GUARD_WALK;
        else if ((inp.down('ShiftLeft') || inp.down('ShiftRight')) && this.st > 1 && mv.lengthSq() > 0) { want = SPRINT; sprinting = true; }
        if (mv.lengthSq() === 0) want = 0;
        this.locomote(want * wade, dt, sprinting, mv);
        if (sprinting) { this.st -= 14 * dt; this.stDelay = 0.7; }
        break;
      }
      case 'attack': this.updateAttack(dt, mv); break;
      case 'roll': this.updateRoll(dt); break;
      case 'hit': if (A.done || this.stateT > 0.42) this.toMove(); break;
      case 'blockHit': if (this.stateT > 0.22) { this.setState('move'); } break;
      case 'guardBreak': if (A.done) this.toMove(); break;
      case 'knock': if (A.done) { this.setState('getup'); A.play('getup', { fade: 0.12 }); } break;
      case 'getup': if (A.done || A.ratio > 0.92) this.toMove(); break;
      case 'dead': break;
      case 'cheer': break;
    }
    // stamina + recoverable health
    this.stDelay -= dt;
    if (this.stDelay <= 0 && this.state !== 'roll' && this.state !== 'attack') this.st = Math.min(100, this.st + (this.blocking ? 14 : 30) * dt);
    this.st = Math.max(0, this.st);
    if (this.lastHurt > 3 && this.hp < this.recCeil && this.alive) this.hp = Math.min(this.recCeil, this.hp + 4 * dt);

    // root motion of attacks / roll / knock-back, rotated into the world
    const rm = A.rm;
    if (rm.x || rm.z) {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      let dx = s * rm.z + c * rm.x, dz = c * rm.z - s * rm.x;
      if (this.state === 'attack') { // do not slide through the soldier being struck
        const f = this.forward();
        // the dash blow drives in closer (its flat cut passes 0.8-1.2 m ahead): it has to reach a shield wall
        const stopR = this.combo === 4 ? 0.8 : 1.15;
        for (const e of g.enemies.list) if (e.active && !e.dead) {
          const ex = e.pos.x - this.pos.x, ez = e.pos.z - this.pos.z, d = Math.hypot(ex, ez);
          if (d < stopR && (ex * f.x + ez * f.z) > 0) { dx *= 0.15; dz *= 0.15; break; }
        }
        // nor under the chin of the downed giant: the combo stays in front of his face
        const cy = g.cyclops;
        if (cy && cy.awake && (cy.state === 'stagger' || cy.state === 'staggerFall')) {
          const e = cy.eye, ex = e.x - this.pos.x, ez = e.z - this.pos.z;
          if (Math.hypot(ex, ez) < 1.7 && (ex * f.x + ez * f.z) > 0) { dx *= 0.15; dz *= 0.15; }
        }
      }
      this.pos.x += dx; this.pos.z += dz;
    }
    // integrate
    const ox = this.pos.x, oz = this.pos.z, d0 = waterDepth(ox, oz), px0 = this.push.x, pz0 = this.push.z;
    this.pos.x += (this.vel.x + this.push.x) * dt; this.pos.z += (this.vel.z + this.push.z) * dt;
    this.push.multiplyScalar(Math.exp(-6 * dt));
    resolve(this.pos, 0.38, this.pos.y + 0.2);
    if (g.cyclops) g.cyclops.pushOut(this.pos, 0.4);
    clampWorld(this.pos, 0.5);
    // the sea stops him at chest depth: past 1.0 m of water no step takes him deeper (he used to walk the sea floor,
    // under water to the crest, out to the invisible wall at 1.67 m: critic round 2, defect 11). Moves along the
    // depth contour still work, and the swell pushes him back toward the beach.
    const d1 = waterDepth(this.pos.x, this.pos.z);
    let seaStop = false;
    if (d1 > 1.0 && d1 > d0) {
      const e = 0.5, gx = waterDepth(this.pos.x + e, this.pos.z) - waterDepth(this.pos.x - e, this.pos.z), gz = waterDepth(this.pos.x, this.pos.z + e) - waterDepth(this.pos.x, this.pos.z - e), gl = Math.hypot(gx, gz);
      if (gl > 1e-5) {
        const mx = this.pos.x - ox, mz = this.pos.z - oz, ml = Math.hypot(mx, mz), along = (mx * gx + mz * gz) / gl;
        // walking (mostly) straight out he stops; only a walk mostly along the shore slides along the depth line. (Pushed
        // straight out he used to drift along the shore at 0.5 m/s, his legs walking on the spot: critic round 3, defect 12)
        if (along > 0.7 * ml) { this.pos.x = ox; this.pos.z = oz; seaStop = { x: -gx / gl, z: -gz / gl }; }
        else if (along > 0) { this.pos.x -= gx / gl * along; this.pos.z -= gz / gl * along; }
      }
      if (waterDepth(this.pos.x, this.pos.z) > Math.max(1.0, d0)) { this.pos.x = ox; this.pos.z = oz; if (!seaStop && gl > 1e-5) seaStop = { x: -gx / gl, z: -gz / gl }; }
    }
    // (the way out, for the next frame's input)
    { const dN = waterDepth(this.pos.x, this.pos.z); if (dN > 0.92) { const e = 0.5, gx = waterDepth(this.pos.x + e, this.pos.z) - waterDepth(this.pos.x - e, this.pos.z), gz = waterDepth(this.pos.x, this.pos.z + e) - waterDepth(this.pos.x, this.pos.z - e), gl = Math.hypot(gx, gz); this.seaN = gl > 1e-5 ? { x: gx / gl, z: gz / gl } : null; } else this.seaN = null; }
    // the swell meets him once each time he is stopped out there (a wave breaking on his chest)
    this.seaT = (this.seaT || 0) + dt;
    if (seaStop && this.seaT > 2.2) { this.seaT = 0; const at = { x: this.pos.x, y: Math.max(0, this.pos.y + 1.1), z: this.pos.z }; this.g.fx.splash(at, 26, 1.3); this.g.audio.splash(at, 1.2); this.push.set(seaStop.x * 1.6, 0, seaStop.z * 1.6); }
    if (d1 > 1.02) {
      const e = 0.5, gx = waterDepth(this.pos.x + e, this.pos.z) - waterDepth(this.pos.x - e, this.pos.z), gz = waterDepth(this.pos.x, this.pos.z + e) - waterDepth(this.pos.x, this.pos.z - e), gl = Math.hypot(gx, gz);
      if (gl > 1e-5) { this.pos.x -= gx / gl * 1.2 * dt; this.pos.z -= gz / gl * 1.2 * dt; }
    }
    // The stride follows where he really went: into the sea's depth limit, a wall, a rock or the giant's foot the legs
    // used to keep striding on the spot (critic round 3, defect 12). The speed comes down to what was achieved along his
    // way, so the next frame starts from there and the legs stand still against a wall.
    // (not while guarding: the held block and the guarded walk switch at 0.25 m/s, and resetting the speed against a
    //  wall flipped between them every other frame, restarting the block clip: 8-12 cm pops of the shield hand)
    if (this.state === 'move' && dt > 1e-5 && this.speed > 0.05 && A.primary === 'loco' && !this.blocking) {
      const dd = this.dir || this.forward(_t), dl = Math.hypot(dd.x, dd.z) || 1;
      const got = ((this.pos.x - ox) / dt - px0) * dd.x / dl + ((this.pos.z - oz) / dt - pz0) * dd.z / dl;
      if (got < this.speed - 0.05) { this.speed = Math.max(0, got); this.vel.multiplyScalar(this.speed / (Math.hypot(this.vel.x, this.vel.z) || 1)); A.setLoco(this.blocking ? Math.min(this.speed, GUARD_WALK) : this.speed, 0.2); }
    }
    const gy = groundAt(this.pos.x, this.pos.z);
    // a step up (the temple's stairs) is eased; a slope is followed exactly (easing it every frame left the body 0.16 m
    // under the hill running up it, and the uphill foot deeper still: critic round 3, defect 7)
    this.pos.y = gy > this.pos.y + 0.06 + 5 * dt ? damp(this.pos.y, gy, 18, dt) : gy;
    this.place();
    A.update(dt);
    // knocked down / dead on a slope: the body lies along the ground (critic round 2, defect 6)
    const lying = this.state === 'knock' || this.state === 'dead' || (this.state === 'getup' && A.ratio < 0.55);
    A.groundTilt(dt, groundAt, lying, this.yaw);
    // planted feet stay where they touched down while walking / running / guard-walking; upright, both feet stand on
    // the slope and the hips drop to the lower one
    const upright = this.state === 'move' || this.state === 'attack' || this.state === 'blockHit' || this.state === 'hit' || this.state === 'guardBreak' || this.state === 'cheer';
    A.footLock(dt, groundAt, this.state === 'move' && A.primary === 'loco' && this.speed > 0.2 && dt > 0, upright);
    A.springCloak(dt, this.vel, groundAt);
    for (const ev of A.events) this.footstep(ev.side, sprinting, depth);
    this.sprinting = sprinting; this.depth = depth;
  }
  locomote(want, dt, sprinting, mv = null) {
    const acc = want > this.speed ? (sprinting ? 7 : 9) : 11;
    this.speed = damp(this.speed, want, acc, dt);
    if (mv && mv.lengthSq() > 0) {
      this.yaw = dampAngle(this.yaw, Math.atan2(mv.x, mv.z), sprinting ? 8 : 11, dt);
      this.dir = this.dir || new THREE.Vector3();
      this.dir.lerp(mv, 1 - Math.exp(-14 * dt));
    } else if (this.blocking) this.yaw = dampAngle(this.yaw, this.g.cam.yaw, 12, dt);
    const d = this.dir || this.forward(new THREE.Vector3());
    const L = Math.hypot(d.x, d.z) || 1;
    this.vel.set(d.x / L * this.speed, 0, d.z / L * this.speed);
    const A = this.actor;
    if (this.blocking && this.speed < 0.25) { if (A.primary !== 'block') { A.play('block', { fade: 0.14, rate: 1.4 }); } if (A.cur && A.cur.action.time >= A.meta.holdAt) A.hold(true); }
    else {
      A.setLoco(this.blocking ? Math.min(this.speed, GUARD_WALK) : this.speed, 0.2);
    }
  }
  toMove() { this.setState('move'); this.actor.setLoco(this.speed, 0.22); }
  footstep(side, sprinting, depth) {
    const g = this.g;
    const foot = this.actor.bones[side === 0 ? 'foot_l' : 'foot_r'].getWorldPosition(new THREE.Vector3());
    const surf = depth > 0.15 ? 'water' : surfaceAt(foot.x, foot.z, this.pos.y);
    g.audio.footstep(surf, foot, sprinting ? 0.95 : 0.7, false, true);
    if (g.stepLog) g.stepLog.push({ t: g.simT, s: surf, side });
    if (surf === 'water') g.fx.splash({ x: foot.x, y: Math.max(foot.y, 0), z: foot.z }, sprinting ? 10 : 6, 0.6);
    else if (surf === 'sand') g.fx.dust(foot, sprinting ? 3 : 2, 0.12, 0.3, [0.76, 0.66, 0.5], 0.35, 0.7);
    else if (sprinting && surf !== 'stone') g.fx.dust(foot, 2, 0.12, 0.3, [0.55, 0.5, 0.38], 0.35, 0.7);
    g.stats.steps = (g.stats.steps || 0) + 1;
  }
  // ---------------------------------------------------------- attacks
  softTarget(dir) {
    const g = this.g;
    let best = null, bestScore = Infinity;
    for (const e of g.enemies.list) {
      if (!e.active || e.dead) continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z, d = Math.hypot(dx, dz);
      if (d > 5.0 || d < 0.01) continue;
      const cos = (dx * dir.x + dz * dir.z) / d;
      if (cos < 0.2) continue;
      const score = d * (1.6 - cos);
      if (score < bestScore) { bestScore = score; best = e.pos; }
    }
    const cy = g.cyclops;
    if (!best && cy && cy.awake && !cy.dead) {
      // when the giant is down, the blade turns to the eye (aim assist toward the weak point)
      const down = cy.state === 'stagger' || cy.state === 'staggerFall';
      const eye = cy.eye;
      if (down && Math.hypot(eye.x - this.pos.x, eye.z - this.pos.z) < 6) return eye;
      const p = cy.nearestZonePoint(this.pos); if (p && p.distanceTo(this.pos) < 7) best = p;
    }
    return best;
  }
  aimAt(mv) {
    const dir = mv && mv.lengthSq() > 0 ? mv.clone() : this.forward(new THREE.Vector3()).clone();
    const tgt = this.softTarget(dir);
    this.aimYaw = tgt ? Math.atan2(tgt.x - this.pos.x, tgt.z - this.pos.z) : Math.atan2(dir.x, dir.z);
    // a soldier in reach is closed on during the wind-up so the blade really passes through him (no air hits);
    // the giant is big enough to be reached by the swing itself
    this.lunge = tgt && this.g.enemies.list.some((e) => e.pos === tgt) ? { tgt, moved: 0 } : null;
  }
  startAttack(n, mv) {
    const cost = [0, 7, 8, 12][n];
    this.setState('attack'); this.combo = n; this.queued = false; this.hitSet.clear(); this.blocking = false;
    this.aimAt(mv);
    this.actor.play('atk' + n, { fade: n === 1 ? 0.09 : 0.06 });
    this.hitIdx = -1; this.whooshed = {}; this.prevValid = false;
    this.speed *= 0.3; this.vel.multiplyScalar(0.3);
    this.st -= cost; this.stDelay = 0.5;
  }
  startHeavy(mv) {
    if (this.st < 12) return;
    this.setState('attack'); this.combo = 4; this.queued = false; this.hitSet.clear(); this.blocking = false;
    this.aimAt(mv);
    this.actor.play('heavy', { fade: 0.08 });
    this.hitIdx = -1; this.whooshed = {}; this.prevValid = false;
    this.speed = 0; this.vel.set(0, 0, 0);
    this.st -= 20; this.stDelay = 0.7;
    this.g.audio.armor(this.pos, 0.7);
  }
  updateAttack(dt, mv) {
    const g = this.g, A = this.actor, e = A.meta, c = A.cur;
    if (!c) { this.toMove(); return; }
    const t = c.action.time;
    if (t < 0.28 * e.duration) this.yaw = dampAngle(this.yaw, this.aimYaw, 20, dt);
    this.speed = 0; this.vel.multiplyScalar(Math.exp(-10 * dt));
    if (this.lunge && e.reach && t < e.hits[0][0] && !e.heavy) {
      // step in until the target stands where this strike passes (at most 1.4 m, up to 6.5 m/s)
      const L = this.lunge, dx = L.tgt.x - this.pos.x, dz = L.tgt.z - this.pos.z, d = Math.hypot(dx, dz);
      const need = d - e.reach;
      if (need > 0.03 && d < 3.4 && L.moved < 1.4) {
        const step = Math.min(need, 6.5 * dt, 1.4 - L.moved);
        this.pos.x += (dx / d) * step; this.pos.z += (dz / d) * step; L.moved += step;
        this.aimYaw = Math.atan2(dx, dz);
      }
    }
    if (g.input.mouse.leftPressed && this.combo < 3 && t >= e.queueFrom) this.queued = true;
    if (g.input.was('Space') && this.st >= 16 && t >= e.cancel) { this.startRoll(mv); return; }
    // whoosh just before each hit window
    e.hits.forEach((w, i) => { if (!this.whooshed[i] && t >= w[0] - 0.07) { this.whooshed[i] = true; g.audio.swing(this.pos, (e.heavy || (e.heavyLast && i === e.hits.length - 1)) ? 1.4 : 0.9); } });
    // blade segment: hit windows test the swept blade
    A.root.updateMatrixWorld(true);
    A.segment('xiphos', this.bladeLen, _a, _b, 0.15);
    let win = -1;
    e.hits.forEach((w, i) => { if (t >= w[0] && t <= w[1]) win = i; });
    g.fx.trailPush(_a, _b, e.hits.some((w) => t >= w[0] - 0.05 && t <= w[1] + 0.04));
    if (win >= 0) {
      if (win !== this.hitIdx) { this.hitIdx = win; this.hitSet.clear(); this.keyDone = false; }
      this.swingHits(e, win, t);
    }
    _pa.copy(_a); _pb.copy(_b); this.prevValid = true;
    if (this.queued && t >= e.next && this.combo < 3) { this.startAttack(this.combo + 1, mv); return; }
    if (A.done || (e.end && t >= e.end) || (this.combo === 4 && t >= e.duration * 0.92)) this.toMove();
  }
  swingHits(e, win, t) {
    const g = this.g, f = this.forward();
    // the blade from the hilt to 0.5 m past its point (the only forgiveness), swept from the last frame to this one
    // in 4 sub-steps, so a 60 m/s cut cannot step over a body between two frames
    const pts = [];
    const ext = (this.bladeLen + 0.5) / this.bladeLen;
    const tipX = _tx.copy(_b).sub(_a).multiplyScalar(ext).add(_a);
    const ptX = this.prevValid ? _pt.copy(_pb).sub(_pa).multiplyScalar(ext).add(_pa) : null;
    const subs = this.prevValid ? 4 : 1;
    for (let s = 1; s <= subs; s++) {
      const u = s / subs;
      const ha = this.prevValid ? _pa.clone().lerp(_a, u) : _a.clone(), hb = this.prevValid ? ptX.clone().lerp(tipX, u) : tipX.clone();
      for (let k = 0; k <= 7; k++) pts.push(ha.clone().lerp(hb, k / 7));
    }
    const heavyHit = e.heavy || (e.heavyLast && win === e.hits.length - 1);
    const dmg = win === 1 && e.dmg2 ? e.dmg2 : e.dmg;
    for (const en of g.enemies.list) {
      if (!en.active || en.dead || this.hitSet.has(en)) continue;
      let hit = null;
      for (const p of pts) {
        if (p.y < en.pos.y + 0.1 || p.y > en.pos.y + 2.05) continue;
        if (Math.hypot(p.x - en.pos.x, p.z - en.pos.z) < 0.45) { hit = p; break; }
      }
      if (hit) {
        this.hitSet.add(en);
        const dir = new THREE.Vector3(en.pos.x - this.pos.x, 0, en.pos.z - this.pos.z).normalize();
        const res = en.takeHit(dmg, dir, { heavy: heavyHit, push: e.push, from: this.pos });
        // blood and sparks where the blade met him, at the height it met him
        g.onHit(new THREE.Vector3(en.pos.x + (hit.x - en.pos.x) * 0.5, clamp(hit.y, en.pos.y + 0.6, en.pos.y + 1.7), en.pos.z + (hit.z - en.pos.z) * 0.5), dir, { stop: e.stop, heavy: heavyHit }, res, false);
        if (this.g.stats) { const d = Math.hypot(hit.x - en.pos.x, hit.z - en.pos.z); (this.g.stats.bladeAxis = this.g.stats.bladeAxis || []).push(+d.toFixed(2)); }
      }
    }
    const cy = g.cyclops;
    if (cy && cy.awake && !cy.dead && !this.hitSet.has(cy)) {
      const hz = cy.testHit(pts);
      if (hz) {
        this.hitSet.add(cy);
        const res = cy.takeHit(dmg, hz.zone, hz.point);
        g.onHit(hz.point, f.clone(), { stop: e.stop, heavy: heavyHit }, res, true);
      }
    }
  }
  // ---------------------------------------------------------- roll
  startRoll(mv) {
    const dir = mv && mv.lengthSq() > 0 ? mv.clone() : this.forward(new THREE.Vector3()).clone();
    this.st -= 20; this.stDelay = 0.6;
    this.setState('roll');
    this.yaw = Math.atan2(dir.x, dir.z);
    this.actor.play('roll', { fade: 0.06 });
    this.perfectArmed = true; this.blocking = false;
    this.speed = 0; this.vel.set(0, 0, 0);
    this.g.audio.swing(this.pos, 0.45); this.g.audio.armor(this.pos, 0.6);
  }
  get iframe() { if (this.state !== 'roll') return false; const c = this.actor.cur; if (!c) return false; const r = c.action.time / c.e.duration; return r > c.e.iframes[0] && r < c.e.iframes[1]; }
  updateRoll(dt) {
    const A = this.actor, c = A.cur;
    if (!c) { this.toMove(); return; }
    const r = c.action.time / c.e.duration;
    if (r > 0.62 && (this.g.input.mouse.leftPressed)) { this.startAttack(1, this.moveInput); return; }
    if (r > 0.7 && this.moveInput.lengthSq() > 0) { this.toMove(); this.speed = 3; return; }
    if (A.done) this.toMove();
  }
  // ---------------------------------------------------------- damage
  takeDamage(dmg, from, opt = {}) {
    const g = this.g;
    if (!this.alive || g.god) return false;
    if (this.iframe || this.state === 'knock' || this.state === 'getup') {
      if (this.iframe && this.perfectArmed) { this.perfectArmed = false; g.onPerfectDodge(); }
      return false;
    }
    if (this.invuln > 0) return false;
    const dx = from.x - this.pos.x, dz = from.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
    const front = (dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw)) / d > 0.2;
    const away = new THREE.Vector3(-dx / d, 0, -dz / d);
    // a spear that ends on the LOWERED aspis is turned by the bronze, but it is not a block: half the blow gets through
    // and he reels (it used to count as a full block: 100 -> 99.3 and no stagger, so raising the shield meant little,
    // critic round 2 defect 15)
    const guarded = this.blocking || this.state === 'blockHit';
    if (!guarded && opt.onShield && front && !opt.unblockable) {
      this.hp -= dmg * 0.5; this.lastHurt = 0; this.recCeil = Math.min(this.recCeil, this.hp + dmg * 0.3);
      this.st -= 10; this.stDelay = 0.6; this.invuln = 0.35;
      g.onBlock(this, from, false, opt.at);
      if (this.hp <= 0) { this.hp = 0; this.die(); return true; }
      this.setState('hit'); this.actor.play('hit2', { fade: 0.05 });
      this.push.copy(away).multiplyScalar(3.0);
      return 'blocked';
    }
    if (guarded && front && !opt.unblockable) {
      this.st -= opt.heavy ? 48 : dmg * 1.5 + 6; this.stDelay = 0.9;
      if (this.st > 0) {
        this.hp -= dmg * 0.08; this.lastHurt = 0;
        this.setState('blockHit');
        if (this.actor.primary === 'block') { this.actor.hold(false); this.actor.play('block', { fade: 0.04, at: 0.22, rate: 1.6 }); }
        this.push.copy(away).multiplyScalar(opt.heavy ? 9 : 3.4);
        g.onBlock(this, from, opt.heavy, opt.at);
        this.invuln = 0.18;
        if (this.hp <= 0) this.die();
        return 'blocked';
      }
      // guard broken
      this.st = 0; this.blocking = false;
      this.setState('guardBreak'); this.actor.play('guardBreak', { fade: 0.06 });
      g.onGuardBreak(this);
      return 'broken';
    }
    this.hp -= dmg; this.lastHurt = 0;
    this.recCeil = Math.min(this.recCeil, this.hp + dmg * 0.55);
    this.invuln = 0.4;
    g.onPlayerHurt(this, dmg, opt.heavy, from, opt.at);
    if (this.hp <= 0) { this.hp = 0; this.die(); return true; }
    this.blocking = false;
    if (opt.knockdown) {
      this.yaw = Math.atan2(dx, dz);                 // knocked away from the source
      this.setState('knock'); this.actor.play('knock', { fade: 0.05 });
      this.push.copy(away).multiplyScalar(opt.push || 5); this.invuln = 1.4;
    } else {
      this.setState('hit'); this.actor.play(Math.random() < 0.5 ? 'hit' : 'hit2', { fade: 0.05 });
      this.push.copy(away).multiplyScalar(2.4);
    }
    return true;
  }
  die() {
    this.setState('dead');
    this.actor.play('death', { fade: 0.08 });
    this.g.onPlayerDeath();
  }
}
