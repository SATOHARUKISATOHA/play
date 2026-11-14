// Recorded sound (assets/audio, CC0 / public domain, see LICENSES.md): footsteps per surface, sword swings and
// clashes, shield and flesh impacts, armour rattle, the giant's roar / growl / footfalls, gulls, surf, wind, fire,
// soldiers shouting. One-shots go through a PannerNode (inverse distance) and get a simple occlusion low-pass when
// the line to the listener is blocked by rock, walls or the terrain. Water steps are synthesised (no recording).
// Nobody has listened to the mix yet: levels come from the measured loudness in audio.json.
import { pointBlocked } from './collide.js';
import { groundHeight } from './terrain.js';

const BASE = './assets/audio/';
const SURF = { sand: 'step_sand', stone: 'step_stone', grass: 'step_grass', wood: 'step_wood' };

export class GameAudio {
  constructor() {
    this.ctx = null; this.muted = false; this.ready = false; this.buf = new Map(); this.man = null;
    this.listener = { x: 0, y: 0, z: 0 };
    this.stats = { played: {}, occluded: 0, decoded: 0, failed: 0, voices: 0 };
    this.gullT = 3; this.crashT = 2;
  }
  async init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3.5; comp.attack.value = 0.005; comp.release.value = 0.25;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.amb = ctx.createGain(); this.amb.gain.value = 0.7; this.amb.connect(this.master);
    // small outdoor reverb send (procedural impulse, no file)
    this.verb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.2), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4) * (i < 500 ? i / 500 : 1); }
    this.verb.buffer = ir; this.verbSend = ctx.createGain(); this.verbSend.gain.value = 0.18; this.verbSend.connect(this.verb); this.verb.connect(this.master);
    const n = ctx.sampleRate; this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    { const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }
    try {
      this.man = await (await fetch(BASE + 'audio.json')).json();
      const files = new Set(); for (const g of Object.values(this.man.groups)) for (const f of g.files) files.add(f);
      await Promise.all([...files].map(async (f) => {
        try { const ab = await (await fetch(BASE + f)).arrayBuffer(); this.buf.set(f, await ctx.decodeAudioData(ab)); this.stats.decoded++; }
        catch (e) { this.stats.failed++; }
      }));
      this.ready = true;
      this.startAmbience();
    } catch (e) { console.warn('audio manifest failed', e); }
  }
  setMuted(m) { this.muted = m; if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05); }
  setListener(cam) {
    if (!this.ctx) return;
    const L = this.ctx.listener, p = cam.position, t = this.ctx.currentTime;
    this.listener.x = p.x; this.listener.y = p.y; this.listener.z = p.z;
    const f = cam.getWorldDirection(this._f || (this._f = cam.position.clone()));
    if (L.positionX) {
      L.positionX.setValueAtTime(p.x, t); L.positionY.setValueAtTime(p.y, t); L.positionZ.setValueAtTime(p.z, t);
      L.forwardX.setValueAtTime(f.x, t); L.forwardY.setValueAtTime(f.y, t); L.forwardZ.setValueAtTime(f.z, t);
      L.upX.setValueAtTime(0, t); L.upY.setValueAtTime(1, t); L.upZ.setValueAtTime(0, t);
    } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
  }
  // is the straight line listener -> source blocked (rock, wall, cave, ground)?
  occluded(p) {
    const L = this.listener, dx = p.x - L.x, dz = p.z - L.z, d = Math.hypot(dx, dz);
    if (d < 6) return false;
    const n = Math.min(14, Math.ceil(d / 3));
    for (let k = 1; k < n; k++) {
      const u = k / n, x = L.x + dx * u, z = L.z + dz * u, y = L.y + ((p.y || 0) + 1 - L.y) * u;
      if (y < groundHeight(x, z) + 0.2) return true;
      if (pointBlocked(x, y, z, 0.05)) return true;
    }
    return false;
  }
  // core one-shot: group variant -> [lowpass] -> panner -> sfx (+ reverb send)
  play(group, p, { gain = 1, rate = 1, ref = 3, verb = 0.12, roll = 1.0, jitter = 0.08 } = {}) {
    if (!this.ready || !this.ctx || this.ctx.state !== 'running') { this.count(group); return null; }
    const g = this.man.groups[group]; if (!g) return null;
    g._i = ((g._i ?? Math.floor(Math.random() * g.files.length)) + 1 + (Math.random() < 0.35 ? 1 : 0)) % g.files.length;
    const b = this.buf.get(g.files[g._i]); if (!b) return null;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = b;
    src.playbackRate.value = rate * (1 - jitter / 2 + Math.random() * jitter);
    const gn = ctx.createGain(); gn.gain.value = gain * (g.gain ?? 1);
    let node = src;
    if (p && this.occluded(p)) {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.6;
      node.connect(lp); node = lp; gn.gain.value *= 0.55; this.stats.occluded++;
    }
    node.connect(gn);
    let out = gn;
    if (p) {
      const pan = ctx.createPanner();
      pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = ref; pan.rolloffFactor = roll; pan.maxDistance = 400;
      if (pan.positionX) { pan.positionX.setValueAtTime(p.x, t); pan.positionY.setValueAtTime(p.y || 0, t); pan.positionZ.setValueAtTime(p.z, t); } else pan.setPosition(p.x, p.y || 0, p.z);
      gn.connect(pan); out = pan;
    }
    out.connect(this.sfx);
    if (verb > 0) { const s = ctx.createGain(); s.gain.value = verb; out.connect(s); s.connect(this.verbSend); }
    src.start(t); this.stats.voices++;
    src.onended = () => { this.stats.voices--; };
    this.count(group);
    return src;
  }
  count(group) { this.stats.played[group] = (this.stats.played[group] || 0) + 1; }
  // ---------------------------------------------------------------- game sounds
  footstep(surface, p, vol = 0.7, heavy = false, player = false) {
    if (player && this.log) this.log.push({ t: performance.now(), g: 'step:' + surface });
    if (surface === 'water') return this.splash(p, 0.35 * vol);
    if (surface === 'march') { this.play('step_sand', p, { gain: 1.1 * vol, rate: 0.82, ref: 6 }); this.play('bronze_clatter', p, { gain: 0.5 * vol, rate: 0.9, ref: 5 }); return; }
    this.play(SURF[surface] || 'step_sand', p, { gain: vol * (player ? 1.0 : 0.8), rate: heavy ? 0.8 : 1, ref: player ? 2.5 : 3 });
    if (player && Math.random() < 0.25) this.play('bronze_clatter', p, { gain: 0.18 * vol, ref: 2 });
  }
  swing(p, power = 1) { this.play('swing', p, { gain: 0.55 + 0.25 * power, rate: power > 1.5 ? 0.62 : 1.0 + (1 - power) * 0.1, ref: power > 1.5 ? 12 : 3 }); }
  clash(p, power = 1) { this.play('clash', p, { gain: 0.6 + 0.3 * power, ref: 4, verb: 0.25 }); }
  shieldHit(p, power = 1) { this.play('hit_shield', p, { gain: 0.6 + 0.35 * power, ref: 4, verb: 0.2 }); }
  flesh(p, power = 1) { this.play('hit_flesh', p, { gain: 0.55 + 0.35 * power, rate: power > 1.2 ? 0.85 : 1, ref: 3.5 }); }
  armor(p, k = 1) { this.play('bronze_clatter', p, { gain: 0.45 * k, ref: 3 }); }
  thud(p, k = 1) { this.play('giant_step', p, { gain: 0.35 * k, rate: 1.6, ref: 5 }); }
  boom(p, k = 1) { this.play('giant_step', p, { gain: Math.min(1.2, 0.7 * k), rate: 0.95, ref: 18, verb: 0.35, roll: 0.8 }); }
  roar(p, k = 1) { this.play('giant_roar', p, { gain: 1.0 * k, ref: 25, verb: 0.4, roll: 0.6, jitter: 0.04 }); }
  growl(p) { this.play('giant_growl', p, { gain: 0.7, ref: 18, verb: 0.3, roll: 0.7 }); }
  shout(p, k = 1) { this.play('crowd_shout', p, { gain: 0.55 * k, ref: 10, verb: 0.25 }); }
  gull(p) { this.play('gull', p, { gain: 0.5, ref: 12, verb: 0.2 }); }
  splash(p, k = 1) {
    this.count('splash');
    if (!this.ready || this.ctx.state !== 'running') return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(2400, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * k, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    const pan = ctx.createPanner(); pan.distanceModel = 'inverse'; pan.refDistance = 3; pan.panningModel = 'equalpower';
    if (pan.positionX) { pan.positionX.value = p.x; pan.positionY.value = p.y || 0; pan.positionZ.value = p.z; }
    src.connect(f); f.connect(g); g.connect(pan); pan.connect(this.sfx); src.start(t, Math.random() * 0.5); src.stop(t + 0.35);
  }
  // ---------------------------------------------------------------- ambience
  loop(group, gain, p = null, ref = 8) {
    const g = this.man.groups[group], b = g && this.buf.get(g.files[0]); if (!b) return null;
    const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = b; src.loop = true;
    const gn = ctx.createGain(); gn.gain.value = gain; src.connect(gn);
    if (p) { const pan = ctx.createPanner(); pan.distanceModel = 'inverse'; pan.refDistance = ref; pan.panningModel = 'equalpower'; pan.positionX.value = p.x; pan.positionY.value = p.y; pan.positionZ.value = p.z; gn.connect(pan); pan.connect(this.amb); }
    else gn.connect(this.amb);
    src.start(this.ctx.currentTime, Math.random() * b.duration);
    return gn;
  }
  startAmbience() {
    this.surfG = this.loop('surf_loop', 0.0);
    this.windG = this.loop('wind_loop', 0.0);
    this.crowdG = this.loop('crowd_loop', 0.0);
  }
  addFire(p) { if (this.ready) this.loop('fire_loop', 0.7, { x: p.x, y: p.y + 0.5, z: p.z }, 4); }
  update(dt, s) {
    if (!this.ready || !this.surfG) return;
    const t = this.ctx.currentTime;
    this.surfG.gain.setTargetAtTime(0.08 + 0.85 * Math.max(0, 1 - s.shoreDist / 60), t, 0.6);
    this.windG.gain.setTargetAtTime(0.12 + Math.min(0.4, Math.max(0, s.height) / 40), t, 0.8);
    this.crowdG.gain.setTargetAtTime(Math.min(0.5, s.fighters * 0.05), t, 0.8);
    this.gullT -= dt;
    if (this.gullT <= 0 && s.gullPos) { this.gull(s.gullPos); this.gullT = 4 + Math.random() * 8; }
    this.crashT -= dt;
    if (this.crashT <= 0 && s.shoreDist < 40) { this.play('wave_crash', s.surfPos, { gain: 0.5, ref: 14 }); this.crashT = 5 + Math.random() * 7; }
  }
}
