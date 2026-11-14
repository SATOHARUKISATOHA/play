// HUD without words: health (with the recoverable part), stamina, the giant's bar under an eye glyph, a rotating
// minimap, damage vignette, key-cap hints that fade once used, an end card of pictograms + numbers.
import { HALF, N, heights, surfaceAt, POI } from './terrain.js';
import { clamp } from './util.js';

const $ = (id) => document.getElementById(id);
const ICON = {
  kills: '<svg viewBox="0 0 22 22" fill="none" stroke="#efe6d6" stroke-width="1.5"><path d="M4 18L16 6M6 4l12 12M14 4l4 4M4 14l4 4"/></svg>',
  time: '<svg viewBox="0 0 22 22" fill="none" stroke="#efe6d6" stroke-width="1.5"><path d="M6 3h10M6 19h10M7 3c0 5 8 6 8 8s-8 3-8 8M15 3c0 5-8 6-8 8s8 3 8 8"/></svg>',
  eye: '<svg viewBox="0 0 22 22" fill="none" stroke="#efe6d6" stroke-width="1.5"><path d="M2 11c4-6 14-6 18 0-4 6-14 6-18 0z"/><circle cx="11" cy="11" r="2.6" fill="#efe6d6"/></svg>',
  shield: '<svg viewBox="0 0 22 22" fill="none" stroke="#efe6d6" stroke-width="1.5"><circle cx="11" cy="11" r="7.5"/><circle cx="11" cy="11" r="2.5"/></svg>',
  roll: '<svg viewBox="0 0 22 22" fill="none" stroke="#efe6d6" stroke-width="1.5"><circle cx="11" cy="12" r="5"/><path d="M4 7a9 9 0 0 1 14 0M16 3l2 4-4 .6"/></svg>',
  club: '<svg viewBox="0 0 22 22" fill="none" stroke="#efe6d6" stroke-width="1.5"><path d="M5 19l8-8"/><path d="M12 6c2-2 6-2 6 2s-3 4-5 3" /></svg>',
  wound: '<svg viewBox="0 0 22 22" fill="none" stroke="#efe6d6" stroke-width="1.5"><path d="M11 3c3 5 5 7 5 10a5 5 0 0 1-10 0c0-3 2-5 5-10z"/></svg>',
};
export { ICON };

export class HUD {
  constructor() {
    this.root = $('hud');
    this.hpFill = this.root.querySelector('.hp .fill'); this.hpRec = this.root.querySelector('.hp .rec');
    this.stBar = this.root.querySelector('.st'); this.stFill = this.root.querySelector('.st .fill');
    this.boss = $('boss'); this.bossFill = this.boss.querySelector('.fill'); this.bossLag = this.boss.querySelector('.lag');
    this.flash = $('flash'); this.stats = $('stats'); this.keys = $('keys'); this.prompt = $('prompt');
    this.mm = $('minimap'); this.mx = this.mm.getContext('2d');
    this.flashV = 0; this.bossLagV = 1; this.cache = {}; this.used = new Set(); this.t = 0;
    this.base = this.renderBaseMap();
  }
  show(v) { this.root.classList.toggle('hidden', !v); }
  set(key, el, v, fn) { if (this.cache[key] !== v) { this.cache[key] = v; fn(el, v); } }
  markUsed(k) { this.used.add(k); }
  renderBaseMap() {
    const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), img = g.createImageData(S, S);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const x = -HALF + (i / S) * HALF * 2, z = -HALF + (j / S) * HALF * 2;
      const gi = Math.min(N, Math.round((i / S) * N)), gj = Math.min(N, Math.round((j / S) * N));
      const h = heights[gj * (N + 1) + gi];
      const hx = heights[gj * (N + 1) + Math.min(N, gi + 1)] - h, hz = heights[Math.min(N, gj + 1) * (N + 1) + gi] - h;
      const shade = clamp(1 - (hx * 0.9 + hz * 0.6) * 0.35, 0.55, 1.3);
      let r, gg, b;
      if (h < -0.05) { const d = clamp(-h / 4, 0, 1); r = 34 - d * 14; gg = 58 - d * 20; b = 72 - d * 18; }
      else {
        const s = surfaceAt(x, z);
        if (s === 'sand') { r = 176; gg = 156; b = 120; } else if (s === 'stone') { r = 128; gg = 122; b = 110; } else { r = 104; gg = 104; b = 66; }
        r *= shade; gg *= shade; b *= shade;
      }
      const k = (j * S + i) * 4; img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const toPx = (x) => ((x + HALF) / (HALF * 2)) * S;
    g.fillStyle = 'rgba(232,220,196,0.9)'; g.fillRect(toPx(POI.temple.x) - 6, toPx(POI.temple.z) - 10, 12, 20);
    g.fillStyle = 'rgba(20,14,10,0.85)'; g.beginPath(); g.arc(toPx(POI.cave.x), toPx(POI.cave.z + 2), 6, Math.PI, 0); g.fill();
    g.strokeStyle = 'rgba(210,200,180,0.7)'; g.lineWidth = 2; g.beginPath(); g.ellipse(toPx(POI.pen.x), toPx(POI.pen.z), 4.5, 3.2, 0.7, 0, Math.PI * 2); g.stroke();
    return cv;
  }
  addTents(tents) {
    const g = this.base.getContext('2d'), S = this.base.width, toPx = (x) => ((x + HALF) / (HALF * 2)) * S;
    g.fillStyle = 'rgba(70,50,36,0.95)';
    for (const t of tents) { g.beginPath(); g.arc(toPx(t.x), toPx(t.z), 3.2, 0, Math.PI * 2); g.fill(); }
  }
  hurt(k = 1) { this.flashV = Math.min(1, this.flashV + 0.5 * k); }
  update(dt, s) {
    this.t += dt;
    const P = s.player;
    this.set('hp', this.hpFill, Math.round(P.hp * 10) / 10, (el, v) => { el.style.transform = `scaleX(${clamp(v / 100, 0, 1)})`; });
    this.set('rec', this.hpRec, Math.round(P.recCeil * 10) / 10, (el, v) => { el.style.transform = `scaleX(${clamp(v / 100, 0, 1)})`; });
    this.set('st', this.stFill, Math.round(P.st), (el, v) => { el.style.transform = `scaleX(${clamp(v / 100, 0, 1)})`; });
    this.set('stlow', this.stBar, P.st < 20, (el, v) => el.classList.toggle('low', v));
    const cy = s.cyclops, bossOn = cy && cy.awake;
    this.set('boss', this.boss, bossOn, (el, v) => el.classList.toggle('hidden', !v));
    if (bossOn) {
      const f = clamp(cy.hp / cy.hpMax, 0, 1);
      this.bossLagV = this.bossLagV > f ? Math.max(f, this.bossLagV - dt * 0.22) : f;
      this.bossFill.style.transform = `scaleX(${f})`; this.bossLag.style.transform = `scaleX(${this.bossLagV})`;
    }
    this.set('prompt', this.prompt, !!s.prompt, (el, v) => el.classList.toggle('hidden', !v));
    this.flashV = Math.max(0, this.flashV - dt * 1.5);
    this.flash.style.opacity = this.flashV.toFixed(3);
    // key hints fade to a whisper after a while once most controls were used
    this.set('keysDim', this.keys, this.t > 40 || (this.used.size >= 4 && this.t > 15), (el, v) => el.classList.toggle('dim', v));
    if (s.statsText !== undefined) this.set('stats', this.stats, s.statsText, (el, v) => { el.textContent = v; });
    this.drawMinimap(s);
  }
  drawMinimap(s) {
    const g = this.mx, W = this.mm.width, R = W / 2;
    const P = s.player, range = 80, scale = R / range;
    g.save(); g.clearRect(0, 0, W, W);
    g.beginPath(); g.arc(R, R, R - 1, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#1b2a33'; g.fillRect(0, 0, W, W);
    g.translate(R, R); g.rotate(s.camYaw - Math.PI);
    const pxPerM = this.base.width / (HALF * 2);
    g.scale(scale / pxPerM, scale / pxPerM);
    g.translate(-(P.pos.x + HALF) * pxPerM, -(P.pos.z + HALF) * pxPerM);
    g.globalAlpha = 0.92; g.drawImage(this.base, 0, 0); g.globalAlpha = 1;
    g.restore();
    const ca = Math.cos(s.camYaw - Math.PI), sa = Math.sin(s.camYaw - Math.PI);
    const map = (x, z) => { const dx = (x - P.pos.x) * scale, dz = (z - P.pos.z) * scale; return [R + dx * ca - dz * sa, R + dx * sa + dz * ca]; };
    const inside = (p) => (p[0] - R) ** 2 + (p[1] - R) ** 2 < (R - 6) ** 2;
    const clampEdge = (p) => { const dx = p[0] - R, dy = p[1] - R, d = Math.hypot(dx, dy), m = R - 12; return d > m ? [R + dx / d * m, R + dy / d * m] : p; };
    for (const sh of s.ships) {
      const p = map(sh.x, sh.z); if (!inside(p)) continue;
      g.save(); g.translate(p[0], p[1]); g.rotate(-sh.yaw + (s.camYaw - Math.PI) + Math.PI / 2); g.fillStyle = '#100d0b'; g.fillRect(-4, -14, 8, 28); g.restore();
    }
    g.fillStyle = '#c9493a';
    for (const e of s.enemies) { const p = map(e.x, e.z); if (!inside(p)) continue; g.beginPath(); g.arc(p[0], p[1], 4.2, 0, Math.PI * 2); g.fill(); }
    if (s.cyclops && s.cyclops.awake && !s.cyclops.dead) {
      const p = clampEdge(map(s.cyclops.pos.x, s.cyclops.pos.z));
      g.fillStyle = '#e3a548'; g.strokeStyle = '#2a170c'; g.lineWidth = 3;
      g.beginPath(); g.arc(p[0], p[1], 11, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#2a170c'; g.beginPath(); g.arc(p[0], p[1], 4, 0, Math.PI * 2); g.fill();
    }
    g.save(); g.translate(R, R); g.rotate(-(P.yaw - s.camYaw));
    g.fillStyle = '#efe6d5'; g.strokeStyle = '#1a1410'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -12); g.lineTo(8, 9); g.lineTo(0, 4); g.lineTo(-8, 9); g.closePath(); g.fill(); g.stroke();
    g.restore();
    // north: a small bronze tick on the rim
    const n = map(P.pos.x, P.pos.z - range), nd = [n[0] - R, n[1] - R], nl = Math.hypot(nd[0], nd[1]) || 1;
    g.fillStyle = 'rgba(201,160,102,0.9)'; g.beginPath(); const tx = R + nd[0] / nl * (R - 8), ty = R + nd[1] / nl * (R - 8);
    g.arc(tx, ty, 4, 0, Math.PI * 2); g.fill();
  }
}
