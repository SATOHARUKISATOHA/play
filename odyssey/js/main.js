// ODYSSEY v2 — bootstrap, game loop, wave director, events, debug / test API.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Assets } from './assets.js';
import { buildWorld } from './world.js';
import { addCharacterFill, CHAR_FILL, DITHER } from './env.js';
import { POI, shoreDist, groundHeight } from './terrain.js';
import { groundAt } from './collide.js';
import { loadCharacters } from './chars.js';
import { Player } from './player.js';
import { EnemyManager } from './enemies.js';
import { Cyclops } from './cyclops.js';
import { FX, FX_BOOST } from './fx.js';
import { GameAudio } from './audio.js';
import { HUD, ICON } from './hud.js';
import { Input } from './input.js';
import { CameraRig } from './camera.js';
import { clamp, rand, damp, wrapAngle } from './util.js';

// directional shadows fade toward the border of the tight box that follows the hero
THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment.replace('return shadow;',
  'float edgeD = min(min(shadowCoord.x, 1.0 - shadowCoord.x), min(shadowCoord.y, 1.0 - shadowCoord.y));\n\t\treturn mix(1.0, shadow, smoothstep(0.0, 0.12, edgeD));');

const Q = new URLSearchParams(location.search);
const DEBUG = Q.has('debug');
const TOD = Q.get('tod') === 'dusk' ? 'dusk' : 'day';
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
let pixelRatio = Q.has('dpr') ? +Q.get('dpr') : 1;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
window.__renderer = renderer;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.15, 3000);
let composer = null;
// Built once; a resize or an automatic resolution step only resizes its targets. (It used to build a new composer
// with new SMAA / output passes on every step: a 30-50 ms hitch each time the auto resolution moved, and the old
// passes' textures were never freed. Round-1 re-test: 3 frames of 33 ms in a 5 s crowd window.)
function makeComposer() {
  const pr = renderer.getPixelRatio(), w = innerWidth, h = innerHeight;
  if (composer) { composer.setPixelRatio(pr); composer.setSize(w, h); return; }
  const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType });
  const c = new EffectComposer(renderer, rt);
  c.addPass(new RenderPass(scene, camera));
  if (Q.get('post') === 'bloom') c.addPass(new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.1, 0.4, 0.98));
  c.addPass(new OutputPass());
  c.addPass(new SMAAPass(w * pr, h * pr));
  c.setPixelRatio(pr); c.setSize(w, h);
  composer = c;
}

const loadBar = document.querySelector('#loading div');
const A = new Assets((f) => { loadBar.style.width = `${Math.round(f * 100)}%`; });
const ui = {
  dead: document.getElementById('dead'), win: document.getElementById('win'), winRows: document.getElementById('win-rows'),
  mute: document.getElementById('mute'), credits: document.getElementById('credits'), creditsList: document.getElementById('credits-list'),
};

// ------------------------------------------------------------ build
const t0 = performance.now();
const world = await buildWorld(scene, renderer, A, { tod: TOD, grassN: Q.has('lowgrass') ? 9000 : 16000, legacyGround: Q.has('oldsky') });
const C = await loadCharacters(A);
// people and the giant get the soft fill from the lens side (patched before any soldier material is cloned)
{
  const mats = new Set();
  const grab = (root) => root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) mats.add(m); });
  grab(C.hop.scene); grab(C.poly.scene); for (const g of Object.values(C.gear)) grab(g);
  mats.add(C.heavy.material); mats.add(C.light.material); if (C.heavy2) mats.add(C.heavy2.material);
  if (!Q.has('nofill')) for (const m of mats) if (m.isMeshStandardMaterial) { addCharacterFill(m); m.envMapIntensity = world.sk.env; }
  CHAR_FILL.uCharFill.value.copy(world.sky.sun.color).multiplyScalar(world.sky.sun.intensity * world.sk.fill);
}
const boulderG = await A.gltf('./assets/world/models/boulder_namaqualand_05.glb');
boulderG.scene.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if ('envMapIntensity' in m) m.envMapIntensity = world.sk.env; });
const loadMs = Math.round(performance.now() - t0);
FX_BOOST.value = 0.85 / renderer.toneMappingExposure;

const input = new Input(canvas);
const cam = new CameraRig(camera);
const audio = new GameAudio();
const fx = new FX(scene, camera);
const hud = new HUD();
hud.addTents(world.tents);

const game = {
  scene, camera, renderer, input, cam, audio, fx, hud, world,
  state: 'playing', god: false, time: 0, kills: 0, wave: 0, started: false,
  hitstopT: 0, slowT: 0, slowF: 1, firsts: {}, stats: {},
};
window.__game = game;
const player = new Player(game, C);
const enemies = new EnemyManager(game, C, { heavy: 22, light: 10 });
const cyclops = new Cyclops(game, C, boulderG.scene);
game.player = player; game.enemies = enemies; game.cyclops = cyclops;

// ------------------------------------------------------------ stats
const stats = game.stats;
function resetStats() { for (const k of Object.keys(stats)) delete stats[k]; Object.assign(stats, { kills: 0, dmg: 0, blocks: 0, perfect: 0, hits: 0, weak: 0, partBreak: false, bossT0: null, bossT: null, steps: 0, assists: 0, blockedByWall: 0, guardBreaks: 0 }); }
resetStats();

// ------------------------------------------------------------ events
game.hitstop = (s) => { game.hitstopT = Math.max(game.hitstopT, s); };
game.slowmo = (f, s) => { game.slowF = f; game.slowT = Math.max(game.slowT, s); };
const _d = new THREE.Vector3();
game.onHit = (point, dir, meta, res, isBoss) => {
  stats.hits++;
  if (res && res.blocked) { // a shield wall caught the blow
    stats.blockedByWall++;
    fx.sparks(point, 14, dir.clone().negate()); audio.shieldHit(point, 1); audio.clash(point, 0.6);
    game.hitstop(0.07); cam.addShake(0.16); cam.kick(_d.copy(dir).negate().setY(0.1), 0.05);
    player.push.copy(dir).multiplyScalar(-2.6);
    return;
  }
  const weak = res && res.weak, killed = res && res.killed;
  game.hitstop(weak ? 0.13 : (meta.stop || 0.06) * (killed ? 1.3 : 1));
  cam.addShake(weak ? 0.55 : meta.heavy ? 0.4 : killed ? 0.2 : 0.11);
  cam.kick(_d.copy(dir).setY(0), meta.heavy ? 0.09 : 0.045); cam.punch(meta.heavy ? 2.2 : 0.9);
  audio.flesh(point, weak ? 1.6 : meta.heavy ? 1.3 : 0.9);
  if (Math.random() < 0.5) audio.armor(point, 0.6);
  if (isBoss) {
    fx.blood(point, dir, weak ? 18 : 7); fx.dust(point, 4, 0.4, 0.5);
    if (weak) { stats.weak++; fx.sparks(point, 12); audio.roar(point, 0.6); }
  } else {
    fx.blood(point, dir, killed ? 10 : 6);
    if (Math.random() < 0.35) fx.sparks(point, 5, dir);
  }
};
game.onBlock = (p, from, heavy, at) => {
  stats.blocks++;
  const s = at ? at.clone() : p.actor.bones.lowerarm_l.getWorldPosition(new THREE.Vector3());   // sparks where the point met the bronze
  fx.sparks(s, heavy ? 24 : 14); audio.shieldHit(s, heavy ? 1.5 : 1); audio.clash(s, heavy ? 1 : 0.5);
  cam.addShake(heavy ? 0.45 : 0.15); game.hitstop(heavy ? 0.08 : 0.05);
  cam.kick(_d.set(p.pos.x - from.x, 0, p.pos.z - from.z).normalize(), heavy ? 0.08 : 0.035);
};
game.onGuardBreak = (p) => { stats.guardBreaks++; audio.shieldHit(p.pos, 1.6); cam.addShake(0.35); fx.sparks(p.pos.clone().setY(p.pos.y + 1.3), 20); };
game.onPlayerHurt = (p, dmg, heavy, from, at) => {
  stats.dmg += dmg; hud.hurt(heavy ? 1.4 : 1); cam.addShake(heavy ? 0.65 : 0.28); audio.flesh(p.pos, 1.2); audio.armor(p.pos, 1); game.hitstop(0.05);
  if (from) cam.kick(_d.set(p.pos.x - from.x, 0, p.pos.z - from.z).normalize(), heavy ? 0.12 : 0.05);
  fx.blood(at ? at.clone() : p.pos.clone().setY(p.pos.y + 1.3), _d.set(p.pos.x - (from ? from.x : p.pos.x), 0, p.pos.z - (from ? from.z : p.pos.z)).normalize(), 5);
};
// timers in game (simulation) time: the death card used to come after 2.6 s of wall-clock time, which on a slow
// machine (dt clamped, game time behind the clock) could freeze the fall half-way (critic round 2, defect 18)
const simTimers = [];
game.after = (sec, fn) => simTimers.push({ t: sec, fn });
// The card waits for the fall to finish: the death clip is 2.4 s, and a card after 1.55 s froze him at 65 % of it, the
// pelvis 0.33 m above the sand (critic round 3, defect 5). The hero is also updated in 'dead' (no input), so he
// settles on the ground even behind the card.
game.onPlayerDeath = () => {
  game.slowmo(0.3, 1.6); game.state = 'dying';
  const t0 = game.simT || 0;
  const card = () => {
    if (game.state !== 'dying') return;
    const A = player.actor;
    if (!(A.primary === 'death' && A.done) && (game.simT || 0) - t0 < 3.4) { game.after(0.05, card); return; }
    game.state = 'dead'; ui.dead.classList.remove('hidden'); hud.show(false); if (document.exitPointerLock) document.exitPointerLock();
  };
  game.after(1.8, card);
};
game.onEnemyKilled = (e, opt) => {
  game.kills++; stats.kills++;
  if (opt && opt.heavy) cam.addShake(0.15);
  audio.armor(e.pos, 1);
};
game.onTelegraph = (e) => {
  e.root.updateMatrixWorld(true);
  const tip = new THREE.Vector3();
  const n = e.type === 'heavy' ? e.root.getObjectByName('hand_r') : e.jav;
  if (n) n.getWorldPosition(tip); else tip.copy(e.pos).setY(e.pos.y + 1.6);
  fx.add.spawn(tip.x, tip.y + 0.25, tip.z, 0, 0, 0, 0.3, 0.32, 1.0, 1.0, 0.86, 0.6, 1, 0, 0, 0);
  audio.play('clash', tip, { gain: 0.18, rate: 1.8, ref: 3 });
};
game.onPerfectDodge = () => { stats.perfect++; game.slowmo(0.35, 0.4); };
game.onClubBreak = (p) => { stats.partBreak = true; audio.play('hit_shield', p, { gain: 1, rate: 0.55, ref: 20 }); audio.roar(p, 0.8); cam.addShake(0.5); fx.debris(p, 30, 1.2); };
game.onRoar = (c) => {
  const h = c.B.head.getWorldPosition(new THREE.Vector3());
  audio.roar(h, 1.2);
  const d = h.distanceTo(player.pos);
  cam.addShake(clamp(1.2 - d / 80, 0.25, 0.9));
};
game.onImpact = (p, k) => {
  audio.boom(p, k);
  const d = Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
  cam.addShake(k * clamp(1 - d / 45, 0, 1) * 0.85);
  fx.dust(p, Math.round(14 * k), 1.6 * k, 1.4, [0.64, 0.55, 0.42], 1.6, 1.8);
};
game.onFootfall = (p) => {
  const d = Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
  audio.play('giant_step', p, { gain: 0.9, ref: 14, roll: 0.8, verb: 0.3 });
  cam.addShake(clamp(1 - d / 34, 0, 1) * 0.3);
  fx.dust(p, 6, 0.9, 1.0, [0.64, 0.55, 0.42], 0.8, 1.4);
};
game.onStagger = () => { cam.addShake(0.4); };
// a tree pushed over by the giant: the trunk cracks, then the crown lands in a cloud of dust and leaves
world.onFell = (p, phase) => {
  if (phase === 'crack') {
    const at = { x: p.x, y: groundAt(p.x, p.z) + 0.8, z: p.z };
    audio.play('step_wood', at, { gain: 1.1, rate: 0.55, ref: 10, verb: 0.25 }); audio.play('step_wood', at, { gain: 0.8, rate: 0.42, ref: 10 });
    fx.dust(at, 6, 0.6, 0.8, [0.55, 0.5, 0.38], 0.6, 1.0);
    return;
  }
  const len = 0.55 * p.height, x = p.x + p.fall.x * len, z = p.z + p.fall.z * len, c = { x, y: groundAt(x, z) + 0.4, z };
  audio.boom(c, 0.55); fx.dust(c, 18, 2.2, 1.2, [0.6, 0.53, 0.4], 1.2, 1.6); fx.debris(c, 10, 0.6);
  cam.addShake(clamp(1 - Math.hypot(x - player.pos.x, z - player.pos.z) / 30, 0, 1) * 0.25);
  stats.felled = (stats.felled || 0) + 1;
};
world.onFlatten = (T) => {
  const c = { x: T.x, y: groundAt(T.x, T.z) + 0.5, z: T.z };
  audio.play('step_wood', c, { gain: 1.0, rate: 0.6, ref: 8 }); audio.thud(c, 1.2);
  fx.dust(c, 14, 1.6, 0.9, [0.66, 0.6, 0.5], 1.0, 1.4);
  stats.tents = (stats.tents || 0) + 1;
};
game.onCyclopsWake = (c) => {
  stats.bossT0 = game.time;
  director.jobs.length = 0; for (const s of world.fleet.ships) s.queue.length = 0;
  enemies.fleeAll(c.pos);
  audio.growl(c.pos);
};
// second phase (club broken): his rage roar calls the Cicones back. They come running from behind the hero (away from
// the giant, ~30 m out), so the fight becomes the giant plus a ring of spears (critic round 2, defect 5)
game.onCyclopsCall = (c) => {
  const n = c.calls === 1 ? 6 : 4;
  const ax = player.pos.x - c.pos.x, az = player.pos.z - c.pos.z, al = Math.hypot(ax, az) || 1;
  for (let i = 0; i < n; i++) director.at(0.6 + i * 0.5, () => {
    const a = Math.atan2(ax / al, az / al) + (i - (n - 1) / 2) * 0.32, d = 28 + Math.random() * 6;
    let x = player.pos.x + Math.sin(a) * d, z = player.pos.z + Math.cos(a) * d;
    const r = Math.hypot(x, z); if (r > 118) { x *= 118 / r; z *= 118 / r; }
    if (groundAt(x, z) < -0.6) { x = player.pos.x + (x - player.pos.x) * 0.5; z = player.pos.z + (z - player.pos.z) * 0.5; }
    const type = i % 3 === 2 ? 'light' : 'heavy';
    enemies.spawn(x, z, type === 'light' ? 'skirmish' : 'approach', { type, yaw: Math.atan2(player.pos.x - x, player.pos.z - z) });
  });
  audio.shout({ x: player.pos.x + ax / al * 30, y: player.pos.y + 2, z: player.pos.z + az / al * 30 }, 1.2);
  stats.called = (stats.called || 0) + n;
};
game.onCyclopsDeath = (c) => {
  stats.bossT = game.time - (stats.bossT0 ?? game.time);
  enemies.fleeAll(c.pos);   // the men he called scatter when he falls
  game.slowmo(0.3, 2.6);
  game.after(game.fastEnd ? 0.2 : 2.0, () => {
    // closing shot: the fallen giant and the hoplite, from the side, high enough to see both. The lens stands on the
    // side of his head (his three-toed feet filled the foreground of the end card, critic round 2 defect 12)
    const ch = c.B.chest.getWorldPosition(new THREE.Vector3()), hd = c.B.head.getWorldPosition(new THREE.Vector3());
    const mid = ch.clone().lerp(player.pos, 0.35);
    const side = new THREE.Vector3(player.pos.x - ch.x, 0, player.pos.z - ch.z).normalize();
    let perp = new THREE.Vector3(-side.z, 0, side.x);
    if ((hd.x - ch.x) * perp.x + (hd.z - ch.z) * perp.z < 0) perp.negate();
    const pos = mid.clone().addScaledVector(perp, 15).addScaledVector(side, 6);
    pos.y = Math.max(groundAt(pos.x, pos.z) + 3, mid.y + 5.5);
    cam.override = { pos, look: mid.clone().setY(mid.y + 1.5), fov: 50 };
    game.win();
  });
};
game.win = () => {
  if (game.state === 'won') return;
  game.state = 'won';
  const t = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const rows = [[ICON.kills, stats.kills], [ICON.time, t(game.time)], [ICON.eye, stats.weak], [ICON.club, stats.partBreak ? '1' : '0'], [ICON.shield, stats.blocks], [ICON.roll, stats.perfect], [ICON.wound, Math.round(stats.dmg)]];
  ui.winRows.innerHTML = rows.map(([i, v]) => `${i}<span>${v}</span>`).join('');
  ui.win.classList.remove('hidden'); hud.show(false);
  if (document.exitPointerLock) document.exitPointerLock();
};

// ------------------------------------------------------------ wave director
const director = {
  reset() { this.t = 0; this.wave = 0; this.waveT = 0; this.jobs = []; },
  at(delay, fn) { this.jobs.push({ at: this.t + delay, fn }); },
  campOut(n, delay, type = 'heavy') {
    for (let i = 0; i < n; i++) this.at(delay + i * 0.8, () => {
      const tt = world.tents[Math.floor(Math.random() * world.tents.length)];
      const out = { x: tt.door.x + (tt.door.x - tt.x) * 1.4, z: tt.door.z + (tt.door.z - tt.z) * 1.4 };
      enemies.spawn(tt.door.x, tt.door.z, 'emerge', { type, yaw: Math.atan2(out.x - tt.x, out.z - tt.z), target: out });
    });
  },
  ship(i, list, dur = 16) { const s = world.fleet.ships[i]; if (world.fleet.launch(i, dur)) s.queue.push(...list); },
  startWave(n) {
    this.wave = n; this.waveT = 0; game.wave = n;
    enemies.maxTokens = n >= 3 ? 3 : 2;
    const camp = { x: POI.camp.x, y: 3, z: POI.camp.z };
    audio.shout(camp, 1.2);
    if (n === 1) { this.campOut(4, 0.5); this.ship(0, ['heavy', 'heavy', 'light', 'heavy', 'heavy', 'light'], 14); }
    else if (n === 2) {
      this.at(1.0, () => {
        const p = player.pos, fx0 = POI.camp.x + 6, fz0 = POI.camp.z + 4;
        enemies.formPhalanx(fx0, fz0, Math.atan2(p.x - fx0, p.z - fz0), 8);
      });
      this.campOut(3, 3.0, 'light');
    } else if (n === 3) {
      this.ship(1, ['heavy', 'heavy', 'light', 'heavy', 'heavy', 'light', 'heavy'], 15);
      this.ship(2, ['heavy', 'light', 'heavy', 'heavy', 'light', 'heavy', 'heavy'], 17);
      this.campOut(3, 4, 'heavy');
    }
  },
  pending() { return this.jobs.length + world.fleet.ships.reduce((a, s) => a + s.queue.length, 0); },
  update(dt) {
    this.t += dt; this.waveT += dt;
    for (let i = this.jobs.length - 1; i >= 0; i--) if (this.t >= this.jobs[i].at && enemies.alive < 26) { const j = this.jobs[i]; this.jobs.splice(i, 1); j.fn(); }
    world.fleet.ships.forEach((s, i) => {
      if (s.state !== 'landed' || !s.queue.length) return;
      s.unloadT -= dt;
      if (s.unloadT <= 0 && enemies.alive < 26) {
        s.unloadT = 0.6; const type = s.queue.shift(), k = (s.unloaded = (s.unloaded || 0) + 1);
        const ex = world.fleet.exitPoint(i, k);
        const tx = ex.x + ex.out.x * 2.8, tz = ex.z + ex.out.z * 2.8;
        enemies.spawn(ex.x, ex.z, 'jump', { type, y: ex.y, yaw: Math.atan2(ex.out.x, ex.out.z), jump: { a: { x: ex.x, y: ex.y, z: ex.z }, b: { x: tx, y: groundAt(tx, tz), z: tz }, h: 1.0, dur: 0.75 } });
        if (k === 1) audio.shout(ex, 1);
      }
    });
    if (cyclops.awake || game.manualWaves || !game.started) return;
    const alive = enemies.alive, pending = this.pending();
    if (this.wave === 0 && this.t > 3) this.startWave(1);
    else if (this.wave >= 1 && this.wave < 3 && pending === 0 && (alive <= 2 || this.waveT > 75)) this.startWave(this.wave + 1);
    else if (this.wave === 3 && ((pending === 0 && alive <= 2) || game.kills >= 34) && !cyclops.awake) wakeCyclops();
    if (game.time > 330 && !cyclops.awake) wakeCyclops();
  },
};
function wakeCyclops() { if (!cyclops.awake) cyclops.wake(); }

// ------------------------------------------------------------ flow
function begin() {
  if (game.started) return;
  game.started = true;
  if (!Q.has('noaudio')) audio.init().then(() => { for (const f of world.fires) audio.addFire(f); });
  // ?scene=wave2 | wave3 | cyclops | temple starts at that part of the island (for showing one part without playing up to it).
  const scene = Q.get('scene'), put = (x, z, yaw) => { player.pos.set(x, groundAt(x, z), z); player.yaw = yaw; cam.yaw = yaw; cam.init = false; };
  if (scene === 'wave2' || scene === 'wave3') director.startWave(scene === 'wave2' ? 2 : 3);
  else if (scene === 'cyclops') { put(POI.cave.x, POI.cave.z + 48, Math.PI); wakeCyclops(); }
  else if (scene === 'temple') { game.manualWaves = true; put(POI.temple.x, POI.temple.z + 30, Math.PI); }
}
input.enabled = true;
input.onFirst = begin;
function restart() {
  ui.dead.classList.add('hidden'); ui.win.classList.add('hidden'); simTimers.length = 0;
  for (const G of enemies.groups) G.dissolve();
  for (const e of enemies.list) if (e.active) e.despawn();
  enemies.tokens.clear(); enemies.groups.length = 0;
  for (const j of enemies.javs) { j.o.visible = false; j.flying = false; }
  player.reset(); cyclops.reset(); world.fleet.reset(); world.resetTrees(); cam.override = null;
  director.reset(); resetStats();
  game.kills = 0; game.time = 0; game.wave = 0; game.firsts = {};
  game.hitstopT = 0; game.slowT = 0; game.state = 'playing';
  cam.yaw = player.yaw; cam.pitch = 0.16; cam.init = false;
  hud.show(true); input.requestLock();
}
director.reset();
document.getElementById('retry').addEventListener('click', restart);
document.getElementById('again').addEventListener('click', restart);
const CREDITS = [
  '<b>Polyphemus</b> — based on “Troll” by SJunior3d, CC BY 4.0 (modified: one eye, tusks removed, olive-wood club replacing the mace, scaled, 8 added motions). https://sketchfab.com/3d-models/troll-bceb1cb47186457c8571a23e6aff1b8e',
  '<b>Sea serpent</b> — “Pistosaur Animated” by RickStikkelorum, CC BY 4.0. https://sketchfab.com/3d-models/pistosaur-animated-773667575a264c7baa4ec404115a044b',
  '<b>Gulls</b> — “Seagull” by Dayvable, CC BY 4.0. https://sketchfab.com/3d-models/seagull-dc42ffc81c86480e9e7f7752fa134174',
  '<b>Sheep</b> — “Bighorn Sheep” by Nioma van der Steen, CC BY 4.0. https://sketchfab.com/3d-models/bighorn-sheep-d02aca356cfb4d5b9836b7c4663bd447',
  'CC0: Quaternius (Universal Base Characters, Universal Animation Library 1–2), ninelionar (aspis), Poly Haven, ambientCG, Kenney, OpenGameArt authors, Wikimedia Commons (public domain). Full list: LICENSES.md',
];
ui.creditsList.innerHTML = CREDITS.map((c) => `<p>${c}</p>`).join('');
document.getElementById('credits-btn').addEventListener('click', () => ui.credits.classList.remove('hidden'));
// also from the death card and from the corner of the play screen (not only for those who win)
for (const b of document.querySelectorAll('.credits-open')) b.addEventListener('click', (e) => { e.stopPropagation(); if (document.exitPointerLock) document.exitPointerLock(); ui.credits.classList.remove('hidden'); });
document.getElementById('credits-close').addEventListener('click', () => ui.credits.classList.add('hidden'));
const toggleMute = () => { audio.setMuted(!audio.muted); ui.mute.classList.toggle('off', audio.muted); };
ui.mute.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'F3') game.showStats = !game.showStats;
  for (const k of ['KeyW', 'ShiftLeft', 'Space', 'KeyF', 'KeyQ']) if (e.code === k) hud.markUsed(k);
});
addEventListener('mousedown', (e) => hud.markUsed('mouse' + e.button));
function onResize() {
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  makeComposer();
  fx.setScale(innerHeight * renderer.getPixelRatio(), camera.fov);
}
// A resize clears the canvas (renderer.setSize). It used to run after the frame was drawn, so every automatic
// resolution step presented one fully black frame (critic round 3, defect 4). Now a step or a window resize only sets
// a flag, and the next frame resizes first and then draws.
let resizePending = false;
addEventListener('resize', () => { resizePending = true; });
onResize();
game.showStats = DEBUG;
cam.yaw = player.yaw; cam.pitch = 0.16; cam.dist = 4.6;

// ------------------------------------------------------------ frame
const prof = { u: 0, r: 0, long: 0, frames: 0, dts: [] };
window.__prof = prof;
let autoDpr = !Q.has('dpr'), dprT = 0, slowFrames = 0, goodWins = 0;
const _cp = new THREE.Vector3();
function frame(realDt, nowS) {
  const tU0 = performance.now();
  let dt = realDt * (game.speed || 1);
  if (game.hitstopT > 0) { game.hitstopT -= realDt; dt = 0; }
  if (game.slowT > 0) { game.slowT -= realDt; dt *= game.slowF; }
  game.simT = (game.simT || 0) + dt;
  for (let i = simTimers.length - 1; i >= 0; i--) { const T = simTimers[i]; T.t -= dt; if (T.t <= 0) { simTimers.splice(i, 1); T.fn(); } }
  const playing = game.state === 'playing' || game.state === 'dying' || game.state === 'won';
  if (game.state === 'playing') {
    cam.look(input.mouse.dx, input.mouse.dy);
    if (input.down('ArrowLeft')) cam.yaw += realDt * 2.2; if (input.down('ArrowRight')) cam.yaw -= realDt * 2.2;
    if (input.down('ArrowUp')) cam.pitch = Math.max(-0.45, cam.pitch - realDt * 1.2); if (input.down('ArrowDown')) cam.pitch = Math.min(1.0, cam.pitch + realDt * 1.2);
  }
  if (game.auto) game.auto(dt);
  if (playing) {
    if (game.state === 'playing' && game.started) game.time += dt;
    director.update(dt);
    player.update(dt);
    enemies.update(dt, player, camera.position);
    cyclops.update(dt);
  } else if (game.state === 'dead') player.update(dt);   // the body keeps settling (no input) behind the death card
  world.update(dt, nowS, player.pos, camera);
  for (const f of world.fires) if (dt > 0 && Math.hypot(f.x - camera.position.x, f.z - camera.position.z) < 70) fx.fire({ x: f.x, y: f.y + 0.1, z: f.z }, 1);
  fx.update(dt);
  fx.setBlobs(enemies.blobs);
  const bossNear = cyclops.awake && !cyclops.dead && cyclops.pos.distanceTo(player.pos) < 40;
  world.setShadowRadius(bossNear ? 50 : 36);
  // giant on all fours: frame his face (the eye) and look down over his back at the hero
  const bossDown = bossNear && (cyclops.state === 'stagger' || cyclops.state === 'staggerFall');
  const focus = bossNear ? (bossDown ? _cp.copy(cyclops.eye) : cyclops.B.chest.getWorldPosition(_cp)) : null;
  let crowd = 0; for (const e of enemies.list) if (e.active && !e.dead && e.pos.distanceTo(player.pos) < 9) crowd++;
  cam.update(realDt, {
    pos: player.pos, sprint: player.sprinting, block: player.blocking, bossNear, bossDown, focus, crowd: clamp((crowd - 2) / 6, 0, 1),
    lockTarget: game.state === 'playing' && input.down('KeyQ') && cyclops.awake && !cyclops.dead ? cyclops.pos : null,
    blocks: cyclops.awake ? (p, m) => cyclops.blocksCamera(p, m) : null,
    fade: (a) => player.setFade(a),
  });
  cyclops.fadeClub(camera.position);
  camera.updateMatrixWorld(); cyclops.updateEyeShade(camera);
  audio.setListener(camera);
  let fighters = 0; for (const e of enemies.list) if (e.active && !e.dead && e.pos.distanceTo(player.pos) < 30) fighters++;
  world.grassDist = fighters >= 6 ? 46 : 62;   // thinner far grass while a crowd fights (critic round 1, defect 10)
  const g0 = world.critters.items.find((c) => c.kind === 'gull');
  audio.update(realDt, {
    shoreDist: Math.max(0, shoreDist(player.pos.x, player.pos.z)), height: player.pos.y, fighters,
    gullPos: g0 ? g0.o.position : null,
    surfPos: { x: player.pos.x * 1.06, y: 0, z: player.pos.z * 1.06 + 8 },
  });
  hud.update(realDt, {
    player, cyclops, camYaw: cam.yaw, prompt: false,
    enemies: enemies.list.filter((e) => e.active && !e.dead).map((e) => e.pos),
    ships: world.fleet.ships.filter((s) => s.state !== 'away').map((s) => ({ x: s.o.position.x, z: s.o.position.z, yaw: s.yaw })),
    statsText: game.showStats ? `${Math.round(window.__fps || 0)} fps · ${renderer.info.render.calls} calls · ${(renderer.info.render.triangles / 1000).toFixed(0)}k tris · dpr ${renderer.getPixelRatio().toFixed(2)}` : '',
  });
  input.endFrame();
  { const k = (prof.frames || 0) & 3, O = [[0, 0], [2, 2], [2, 0], [0, 2]][k]; DITHER.uDitherOff.value.set(O[0] + ((prof.frames >> 2) & 1), O[1]); }
  const tU1 = performance.now();
  renderer.info.reset();
  composer.render(realDt);
  const tR1 = performance.now();
  prof.u = prof.u * 0.95 + (tU1 - tU0) * 0.05; prof.r = prof.r * 0.95 + (tR1 - tU1) * 0.05; prof.frames++;
}
let last = performance.now(), fpsAcc = [];
let running = true;
function loop(now) {
  if (!running) return;
  requestAnimationFrame(loop);
  const realDt = Math.min(0.05, (now - last) / 1000); last = now;
  if (resizePending) { resizePending = false; onResize(); }
  frame(realDt, now / 1000);
  prof.dts.push(realDt * 1000); if (prof.dts.length > 600) prof.dts.shift();
  if (realDt > 0.021) prof.long++;
  fpsAcc.push(realDt); if (fpsAcc.length > 90) fpsAcc.shift();
  window.__fps = fpsAcc.length / fpsAcc.reduce((a, b) => a + b, 0);
  // dynamic resolution: hold ~60 fps on a laptop by trading pixels, never below 0.7
  if (autoDpr && document.visibilityState === 'visible') {
    dprT += realDt;
    if (realDt > 0.0185) slowFrames++;
    if (dprT > 1.0) {
      const ratio = slowFrames / Math.max(1, dprT * 60);
      // (1 s windows, 10 %: on a shared machine a crowd fight ran 22-38 ms frames for 1.3 s before the old 2 s / 25 %
      //  rule reacted, if at all; a step is cheap now that the composer is only resized)
      if (ratio > 0.10 && pixelRatio > 0.72) { pixelRatio = Math.max(0.7, pixelRatio - 0.1); resizePending = true; goodWins = 0; }
      // back up only after 6 s of smooth frames, in one 0.1 step (each resize reallocates the targets: a short stall,
      // and stepping up by 0.05 every 2 s made up to six of them in a row)
      else if (ratio < 0.03 && pixelRatio < Math.min(1, devicePixelRatio)) { if (++goodWins >= 6) { pixelRatio = Math.min(1, pixelRatio + 0.1); resizePending = true; goodWins = 0; } }
      else goodWins = 0;
      dprT = 0; slowFrames = 0;
    }
  }
  window.__stats = { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, alive: enemies.alive, kills: game.kills, state: game.state, cyclops: cyclops.state, wave: game.wave };
}
// shader warm-up: every soldier type / LOD, the giant, effects, before the first frame
frame(1 / 60, performance.now() / 1000);   // (puts the camera and the sun's shadow box on the hero first)
{
  const vis = [];
  enemies.list.forEach((e, i) => { if (i % 11 === 0) { e.root.visible = true; e.pos.set(player.pos.x + (i % 6) - 3, player.pos.y, player.pos.z - 4 - Math.floor(i / 6)); e.place(); vis.push(e); } });
  const ring = fx.shockwave(player.pos), mk = fx.marker(player.pos); fx.crater(player.pos);
  cyclops.boulder.visible = true;
  // (the enemy galleys are hidden until they sail: their materials, the painted eyes among them, were compiled on first
  //  sight in the middle of a fight, critic round 2 defect 14)
  for (const sh of world.fleet.ships) sh.o.visible = true;
  // Compile for the render target the scene is really drawn into (the composer's buffer: no tone mapping, linear
  // output). Compiling for the canvas built programs with other keys that were never used, and the real ones were
  // built in play: 50-160 ms stalls in the first crowd fight and when the camera first came close to the hero (fix
  // round 2: 16 programs in one 156 ms frame). Then draw a few real frames, so the shadow pass compiles its depth
  // programs for every soldier variant as well.
  const rt0 = renderer.getRenderTarget();
  const warm = () => { renderer.setRenderTarget(composer.readBuffer); renderer.compile(scene, camera); renderer.setRenderTarget(rt0); composer.render(1 / 60); };
  for (const e of vis) e.setLOD(0, true);
  warm();
  // the hero's blended (fading) programs and the see-through club too, so the first close camera does not stall
  player.setFade(0.5); for (const m of cyclops.clubMats || []) { m.transparent = true; m.needsUpdate = true; }
  warm();
  player.setFade(1); for (const m of cyclops.clubMats || []) { m.transparent = false; m.needsUpdate = true; }
  for (const e of vis) { e.setLOD(1, true); }
  warm();
  for (const e of vis) { e.setLOD(2, false); }
  warm();
  for (const e of vis) { e.root.visible = false; e.setLOD(0, false); }
  cyclops.boulder.visible = false;
  for (const sh of world.fleet.ships) sh.o.visible = sh.state !== 'away';
  // keep the warm-up ring / marker / crater materials alive (hidden) so their programs are never deleted
  // before first use (that triggers GL_INVALID_VALUE warnings with parallel shader compilation)
  fx.rings.splice(fx.rings.indexOf(ring), 1); ring.m.visible = false;
  fx.markers.splice(fx.markers.indexOf(mk), 1); mk.m.visible = false;
  const d = fx.decals.pop(); d.m.visible = false;
  fx.update(0);
}
frame(1 / 60, performance.now() / 1000);
document.getElementById('loading').remove();
window.__ready = true;
requestAnimationFrame((n) => { last = n; loop(n); });

// ------------------------------------------------------------ debug / test API
const gl = renderer.getContext(), px = new Uint8Array(4);
// the bot goes for a spot in front of his face (eye hits only count from the front)
const _et = new THREE.Vector3(), _fdir = new THREE.Vector3();
function eyeTarget() {
  const e = cyclops.eye, f = cyclops.faceDir(_fdir); f.y = 0;
  if (f.lengthSq() < 1e-4) return e;
  f.normalize();
  return _et.set(e.x + f.x * 1.3, e.y, e.z + f.z * 1.3);
}
window.__debug = {
  loadMs,
  begin: () => begin(),
  god: (v = true) => { game.god = v; },
  teleport: (x, z, yaw) => { player.pos.set(x, groundAt(x, z), z); if (yaw !== undefined) { player.yaw = yaw; cam.yaw = yaw; } cam.init = false; },
  setCam: (yaw, pitch, dist) => { cam.yaw = yaw; if (pitch !== undefined) cam.pitch = pitch; if (dist) cam.dist = dist; cam.init = false; },
  cam: (o) => { cam.override = o; }, freeCam: () => { cam.override = null; },
  spawnRing: (n = 16, rmin = 6, rmax = 14, type = 'heavy') => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2), d = rand(rmin, rmax);
      enemies.spawn(player.pos.x + Math.sin(a) * d, player.pos.z + Math.cos(a) * d, type === 'light' ? 'skirmish' : 'approach', { type, yaw: a + Math.PI });
    }
    return enemies.alive;
  },
  phalanx: (n = 8, dist = 18) => { const p = player.pos, a = player.yaw, x = p.x + Math.sin(a) * dist, z = p.z + Math.cos(a) * dist; return enemies.formPhalanx(x, z, a + Math.PI, n).members.length; },
  attack: () => input.simClick(), heavy: () => input.simKey('KeyF', 80), dodge: () => input.simKey('Space', 80),
  hold: (code, ms) => input.simKey(code, ms), block: (v) => { input.mouse.right = v; },
  wakeCyclops: () => wakeCyclops(),
  cyclopsTo: (x, z, yaw) => { cyclops.pos.set(x, groundAt(x, z), z); if (yaw !== undefined) cyclops.yaw = yaw; },
  cyclopsAttack: (k) => cyclops.startAttack(k),
  staggerCyclops: () => { cyclops.state = 'stagger'; cyclops.t = 0; cyclops.actor.play('stagger', { fade: 0.3 }); },
  killAll: () => enemies.killAll(),
  startWave: (n) => director.startWave(n), manualWaves: (v = true) => { game.manualWaves = v; },
  director: () => ({ wave: director.wave, jobs: director.jobs.length, pending: director.pending(), t: +director.t.toFixed(1) }),
  speed: (k) => { game.speed = k; },
  stats: () => ({ ...stats }),
  state: () => ({ state: game.state, hp: +player.hp.toFixed(1), st: Math.round(player.st), pstate: player.state, kills: game.kills, alive: enemies.alive, wave: game.wave, cyclops: cyclops.state, cyHp: Math.round(cyclops.hp), clubBroken: cyclops.clubBroken, time: +game.time.toFixed(1), pos: player.pos.toArray().map((v) => +v.toFixed(1)), dpr: renderer.getPixelRatio() }),
  audioStats: () => ({ ...audio.stats, ready: audio.ready, ctx: audio.ctx ? audio.ctx.state : null }),
  groundAt: (x, z) => groundAt(x, z),
  audioLog: (on = true) => { if (on) audio.log = []; const l = audio.log; if (!on) audio.log = null; return l; },
  stepLog: (on = true) => { if (on) game.stepLog = []; const l = game.stepLog; if (!on) game.stepLog = null; return l; },
  occlusionProbe: () => {
    const save = { ...audio.listener }, cave = world.CAVE, r = {};
    Object.assign(audio.listener, { x: cave.x, y: cave.floor + 1.7, z: cave.z + 40 });
    r.behindCaveRock = audio.occluded({ x: cave.x + 13, y: cave.floor + 1, z: cave.z - 9 });
    r.openBeach = audio.occluded({ x: cave.x + 25, y: cave.floor + 1, z: cave.z + 55 });
    Object.assign(audio.listener, { x: POI.temple.x, y: groundAt(POI.temple.x, POI.temple.z + 30) + 1.7, z: POI.temple.z + 34 });
    r.behindTempleHill = audio.occluded({ x: POI.temple.x, y: groundAt(POI.temple.x, POI.temple.z - 45), z: POI.temple.z - 45 });
    Object.assign(audio.listener, save);
    return r;
  },
  locoInfo: () => { const T = C.heroTable; return { walk: T.walk.speed, run: T.run.speed, sprint: T.sprint.speed, runDur: T.run.duration, walkDur: T.walk.duration, sprintDur: T.sprint.duration, contactsRun: T.run.contacts }; },
  drilled: () => enemies.list.filter((e) => e.drilled).length,
  lod: () => ({ full: enemies.list.filter((e) => e.active && e.lod === 0).length, mid: enemies.list.filter((e) => e.active && e.lod === 1).length, far: enemies.list.filter((e) => e.active && e.lod === 2).length, shadows: enemies.list.filter((e) => e.active && e.mesh.castShadow).length, tris: [enemies.C.heavy.tris, enemies.C.heavy.lod0.index.count / 3, enemies.C.heavy.lod.index.count / 3, enemies.C.heavy.lod2.index.count / 3] }),
  // stop the RAF loop and measure n frames with the GPU forced to finish each frame (conservative CPU+GPU time)
  bench: async (n = 120, step = 1 / 60) => {
    running = false;
    await new Promise((r) => setTimeout(r, 50));
    const times = [];
    for (let i = 0; i < n + 10; i++) {
      const a = performance.now();
      frame(step, a / 1000); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (i >= 10) times.push(performance.now() - a);
      if (i % 15 === 14) await new Promise((r) => setTimeout(r, 0));
    }
    running = true; last = performance.now(); requestAnimationFrame(loop);
    times.sort((x, y) => x - y);
    const q = (f) => +times[Math.min(times.length - 1, Math.floor(times.length * f))].toFixed(2);
    return { n: times.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, dpr: renderer.getPixelRatio(), w: innerWidth, h: innerHeight };
  },
  setDpr: (v) => { autoDpr = false; pixelRatio = v; onResize(); },
  // share of near-black pixels (Rec. 709 luma < 12 of 255) in the centre of the final image (25-75 % x 20-80 %)
  crushed: () => {
    frame(0, performance.now() / 1000);
    const w = renderer.domElement.width, h = renderer.domElement.height, buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0, c = 0;
    for (let y = Math.floor(h * 0.2); y < Math.floor(h * 0.8); y++) for (let x = Math.floor(w * 0.25); x < Math.floor(w * 0.75); x++) {
      const i = (y * w + x) * 4; n++; if (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2] < 12) c++;
    }
    return +(100 * c / n).toFixed(2);
  },
  // lighting knobs for measurements: ground-bounce hemisphere intensity, character fill (x sun irradiance)
  light: (o = {}) => {
    if (o.bounce !== undefined) world.bounce.intensity = o.bounce;
    if (o.fill !== undefined) CHAR_FILL.uCharFill.value.copy(world.sky.sun.color).multiplyScalar(o.fill * world.sky.sun.intensity);
    if (o.env !== undefined) scene.traverse((m) => { if (m.material) for (const mm of [].concat(m.material)) if ('envMapIntensity' in mm && !mm.userData.__charFill) mm.envMapIntensity = o.env; });
    if (o.charEnv !== undefined) scene.traverse((m) => { if (m.material) for (const mm of [].concat(m.material)) if (mm.userData.__charFill) mm.envMapIntensity = o.charEnv; });
    return { bounce: +world.bounce.intensity.toFixed(3), fill: CHAR_FILL.uCharFill.value.toArray().map((v) => +v.toFixed(3)), sunI: +world.sky.sun.intensity.toFixed(2), exposure: renderer.toneMappingExposure, stats: world.sky.stats };
  },
  // How much of the hero reaches the screen from the current camera: the frame is drawn with and without him (his own
  // shadow off), and the pixels that change are counted; the same pair drawn with everything but him, the ground, the
  // sea and the lights hidden gives his full size. Returns visible / full (critic round 3, defect 3: tents and racks).
  heroVis: () => {
    const w = renderer.domElement.width, h = renderer.domElement.height;
    const read = () => { composer.render(0); const b = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++; return n; };
    const R = player.actor.root, casts = [];
    R.traverse((o) => { if (o.isMesh && o.castShadow) { casts.push(o); o.castShadow = false; } });
    frame(0, performance.now() / 1000);
    const a1 = read(); R.visible = false; const a0 = read(); R.visible = true;
    const keep = new Set([R, world.terrain, world.sea && (world.sea.mesh || world.sea)]), hidden = [];
    for (const o of scene.children) if (!keep.has(o) && !o.isLight && o.visible) { o.visible = false; hidden.push(o); }
    const b1 = read(); R.visible = false; const b0 = read(); R.visible = true;
    for (const o of hidden) o.visible = true;
    for (const o of casts) o.castShadow = true;
    const vis = diff(a1, a0), full = diff(b1, b0);
    return { vis, full, ratio: +(vis / Math.max(1, full)).toFixed(3), camDist: +cam.curDist.toFixed(2), lift: +(cam.lift || 0).toFixed(2) };
  },
  rafStats: () => { const d = [...prof.dts].sort((a, b) => a - b); const q = (f) => +(d[Math.min(d.length - 1, Math.floor(d.length * f))] || 0).toFixed(2); return { n: d.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), long: prof.long, u: +prof.u.toFixed(2), r: +prof.r.toFixed(2) }; },
  // ---- autopilot: a simple player bot for the headless run (moves with W toward targets, combos, blocks
  // telegraphed thrusts, rolls away from the giant's blows, goes for the eye when he is down)
  autopilot: (on = true, opt = {}) => {
    if (!on) { game.auto = null; input.keys.clear(); input.mouse.right = false; return; }
    const st = { atkT: 0, rollT: 0, heavyT: 2, assist: opt.assist ?? true, minHp: opt.minHp ?? 30 };
    game.auto = (dt) => {
      if (game.state !== 'playing' || !player.alive) { input.keys.delete('KeyW'); input.keys.delete('ShiftLeft'); input.mouse.right = false; return; }
      st.atkT -= dt; st.rollT -= dt; st.heavyT -= dt;
      if (st.assist && player.hp < st.minHp) { player.hp = Math.min(100, player.hp + 45); player.recCeil = Math.max(player.recCeil, player.hp); stats.assists++; }
      let tgt = null, dist = 1e9, threat = null;
      if (cyclops.awake && !cyclops.dead) {
        const down = cyclops.state === 'stagger' || cyclops.state === 'staggerFall';
        const z = down ? eyeTarget() : cyclops.nearestZonePoint(player.pos) || cyclops.pos;
        tgt = z; dist = Math.hypot(z.x - player.pos.x, z.z - player.pos.z);
        const danger = ['sweep', 'stomp', 'slam'].includes(cyclops.state) && cyclops.actor.ratio < 0.6 && cyclops.pos.distanceTo(player.pos) < 10;
        if (danger && st.rollT <= 0 && player.state === 'move') {
          const ax = player.pos.x - cyclops.pos.x, az = player.pos.z - cyclops.pos.z;
          cam.yaw = Math.atan2(ax, az); input.keys.add('KeyW'); input.simKey('Space', 60); st.rollT = 1.1; return;
        }
      } else {
        for (const e of enemies.list) {
          if (!e.active || e.dead || e.state === 'flee' || e.state === 'jump') continue;
          const d = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
          if (d < dist) { dist = d; tgt = e.pos; }
          if ((e.state === 'windup') && d < 3.4) threat = e;
        }
      }
      if (!tgt) { input.keys.delete('KeyW'); input.keys.delete('ShiftLeft'); input.mouse.right = false; return; }
      const giantDown = cyclops.awake && (cyclops.state === 'stagger' || cyclops.state === 'staggerFall');
      const reach = cyclops.awake ? (giantDown ? 0.8 : 2.6) : 2.1;
      // walk to the spot in front of his face, then stay and look into the face (against the way it points)
      st.atFace = giantDown && dist < (st.atFace ? 1.9 : reach);
      let yawTo = Math.atan2(tgt.x - player.pos.x, tgt.z - player.pos.z);
      if (st.atFace) { const f = cyclops.faceDir(_fdir); yawTo = Math.atan2(-f.x, -f.z); }
      cam.yaw += wrapAngle(yawTo - cam.yaw) * Math.min(1, dt * 6);
      if (threat && player.state === 'move' && !cyclops.awake) { input.mouse.right = true; input.keys.delete('KeyW'); return; }
      input.mouse.right = false;
      if (dist > reach && !st.atFace) { input.keys.add('KeyW'); if (dist > 10) input.keys.add('ShiftLeft'); else input.keys.delete('ShiftLeft'); }
      else {
        input.keys.delete('KeyW'); input.keys.delete('ShiftLeft');
        if (st.heavyT <= 0 && player.state === 'move' && player.st > 40 && Math.random() < 0.3) { input.simKey('KeyF', 60); st.heavyT = 5; }
        else if (st.atkT <= 0) { input.simClick(); st.atkT = 0.22; }
      }
    };
  },
};
