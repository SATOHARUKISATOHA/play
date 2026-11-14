// 2D (XZ) static collision world: circles + oriented boxes in a spatial hash,
// plus raised walkable platforms (temple steps) and a camera ray test.
import { groundHeight, WALK_R } from './terrain.js';

const CELL = 10;
const grid = new Map();
const key = (i, j) => i * 73856093 ^ j * 19349663;
const circles = [], boxes = [], platforms = [];

function insert(obj, minX, minZ, maxX, maxZ) {
  for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++)
    for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) {
      const k = key(i, j);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(obj);
    }
}

export function addCircle(x, z, r, h = 3, y0 = null, kind = null) {
  const c = { t: 0, x, z, r, h, y0: y0 ?? groundHeight(x, z) - 0.5, kind };
  circles.push(c); insert(c, x - r, z - r, x + r, z + r);
  return c;
}
export function addBox(cx, cz, hx, hz, ang = 0, h = 3, y0 = null, kind = null) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const b = { t: 1, x: cx, z: cz, hx, hz, c, s, h, y0: y0 ?? groundHeight(cx, cz) - 0.5, kind };
  const R = Math.hypot(hx, hz);
  boxes.push(b); insert(b, cx - R, cz - R, cx + R, cz + R);
  return b;
}
// walkable raised rectangle (axis aligned), top height
export function addPlatform(cx, cz, hx, hz, top) { platforms.push({ cx, cz, hx, hz, top }); }

export function groundAt(x, z) {
  let h = groundHeight(x, z);
  for (const p of platforms) if (Math.abs(x - p.cx) <= p.hx && Math.abs(z - p.cz) <= p.hz && p.top > h) h = p.top;
  return h;
}

const seen = new Set();
// Push position p (Vector3-like) out of colliders for a body of radius r. Returns true if touched.
export function resolve(p, r, y = null, skip = null) {
  let hit = false;
  const i0 = Math.floor((p.x - r) / CELL), i1 = Math.floor((p.x + r) / CELL);
  const j0 = Math.floor((p.z - r) / CELL), j1 = Math.floor((p.z + r) / CELL);
  seen.clear();
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const list = grid.get(key(i, j));
    if (!list) continue;
    for (const o of list) {
      if (seen.has(o)) continue; seen.add(o);
      if (o.off || (skip && skip(o))) continue;
      if (y !== null && (y > o.y0 + o.h || y + 1.8 < o.y0)) continue;
      if (o.t === 0) {
        const dx = p.x - o.x, dz = p.z - o.z, d2 = dx * dx + dz * dz, R = o.r + r;
        if (d2 < R * R && d2 > 1e-8) { const d = Math.sqrt(d2), push = R - d; p.x += (dx / d) * push; p.z += (dz / d) * push; hit = true; }
      } else {
        const dx = p.x - o.x, dz = p.z - o.z;
        let lx = dx * o.c + dz * o.s, lz = -dx * o.s + dz * o.c;
        const qx = Math.max(-o.hx, Math.min(o.hx, lx)), qz = Math.max(-o.hz, Math.min(o.hz, lz));
        let ox = lx - qx, oz = lz - qz;
        const d2 = ox * ox + oz * oz;
        if (d2 < r * r) {
          if (d2 > 1e-8) { const d = Math.sqrt(d2), push = r - d; lx += (ox / d) * push; lz += (oz / d) * push; }
          else { // inside: push out along the smallest axis
            const px = o.hx - Math.abs(lx), pz = o.hz - Math.abs(lz);
            if (px < pz) lx = Math.sign(lx || 1) * (o.hx + r); else lz = Math.sign(lz || 1) * (o.hz + r);
          }
          p.x = o.x + lx * o.c - lz * o.s; p.z = o.z + lx * o.s + lz * o.c; hit = true;
        }
      }
    }
  }
  return hit;
}

// Colliders near (x, z) within reach R (for the giant's contacts): calls fn(o, distance to its edge)
const seen2 = new Set();
export function nearColliders(x, z, R, fn) {
  const seen = seen2; seen.clear();
  for (let i = Math.floor((x - R) / CELL); i <= Math.floor((x + R) / CELL); i++)
    for (let j = Math.floor((z - R) / CELL); j <= Math.floor((z + R) / CELL); j++) {
      const list = grid.get(key(i, j)); if (!list) continue;
      for (const o of list) {
        if (seen.has(o) || o.off) continue; seen.add(o);
        let d;
        if (o.t === 0) d = Math.hypot(x - o.x, z - o.z) - o.r;
        else { const dx = x - o.x, dz = z - o.z, lx = dx * o.c + dz * o.s, lz = -dx * o.s + dz * o.c; d = Math.hypot(Math.max(0, Math.abs(lx) - o.hx), Math.max(0, Math.abs(lz) - o.hz)); }
        if (d < R) fn(o, d);
      }
    }
}

// Keep inside the island's invisible wall
export function clampWorld(p, r = 0) {
  const d = Math.hypot(p.x, p.z), m = WALK_R - r;
  if (d > m) { p.x *= m / d; p.z *= m / d; return true; }
  return false;
}

// The real top surface of the scanned rocks and cliffs (highest triangle per 0.5 m cell), for the camera and sight
// lines. Their movement circles are coarse (a cliff face 2 m thick gets a circle 7-11 m wide): the lens was pulled in
// against empty air next to them (critic round 2, defect 3, the east-coast point). Circles of kind 'rock' are skipped
// by pointBlocked in favour of this map; movement still uses the circles.
const RC = 0.5, RN = 600, RO = RN * RC / 2;
const rockTop = new Float32Array(RN * RN).fill(-1e9);
const _rv = [0, 0, 0, 0, 0, 0, 0, 0, 0];
export function addRockHeights(geometry, matrices) {
  const P = geometry.attributes.position, I = geometry.index, n = I ? I.count : P.count;
  for (const M of matrices) {
    const e = M.elements;
    for (let t = 0; t < n; t += 3) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, ymax = -Infinity;
      for (let k = 0; k < 3; k++) {
        const i = I ? I.getX(t + k) : t + k, px = P.getX(i), py = P.getY(i), pz = P.getZ(i);
        const wx = e[0] * px + e[4] * py + e[8] * pz + e[12], wy = e[1] * px + e[5] * py + e[9] * pz + e[13], wz = e[2] * px + e[6] * py + e[10] * pz + e[14];
        x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); z0 = Math.min(z0, wz); z1 = Math.max(z1, wz); ymax = Math.max(ymax, wy);
      }
      const i0 = Math.max(0, Math.floor((x0 + RO) / RC)), i1 = Math.min(RN - 1, Math.floor((x1 + RO) / RC));
      const j0 = Math.max(0, Math.floor((z0 + RO) / RC)), j1 = Math.min(RN - 1, Math.floor((z1 + RO) / RC));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const c = j * RN + i; if (rockTop[c] < ymax) rockTop[c] = ymax; }
    }
  }
}
export function rockHeight(x, z) {
  const i = Math.floor((x + RO) / RC), j = Math.floor((z + RO) / RC);
  if (i < 0 || j < 0 || i >= RN || j >= RN) return -1e9;
  return rockTop[j * RN + i];
}
// The same per-cell top height for the camp (tent canvas and poles, spear racks, palisade, cart), on a finer local grid
// (0.25 m): the follow camera went behind tent canvas and spear racks and lost the hero in the wave fights (critic round
// 3, defect 3). Kept apart from the rocks so a tent the giant flattens can be taken out again.
const PC = 0.25;
let PN = 0, POX = 0, POZ = 0, propTop = null;
const props = [];
export function initPropGrid(cx, cz, half) { PN = Math.ceil(2 * half / PC); POX = cx - half; POZ = cz - half; propTop = new Float32Array(PN * PN).fill(-1e9); }
export function propHeight(x, z) {
  if (!propTop) return -1e9;
  const i = Math.floor((x - POX) / PC), j = Math.floor((z - POZ) / PC);
  if (i < 0 || j < 0 || i >= PN || j >= PN) return -1e9;
  return propTop[j * PN + i];
}
// Each triangle is sampled on a barycentric grid finer than a cell and every sample raises its own cell to the height
// there (bounding boxes over-covered: a 4 m ridge pole on a tent turned 45 degrees roofed a 2.8 x 2.8 m square at the
// ridge height, the hero standing at the tent's end was "inside" it and no view of him counted as clear)
const _ta = [0, 0, 0], _tb = [0, 0, 0], _tc = [0, 0, 0];
function rasterize(geometry, e) {
  const P = geometry.attributes.position, I = geometry.index, n = I ? I.count : P.count;
  const W = (i, o) => { const px = P.getX(i), py = P.getY(i), pz = P.getZ(i); o[0] = e[0] * px + e[4] * py + e[8] * pz + e[12]; o[1] = e[1] * px + e[5] * py + e[9] * pz + e[13]; o[2] = e[2] * px + e[6] * py + e[10] * pz + e[14]; };
  for (let t = 0; t < n; t += 3) {
    W(I ? I.getX(t) : t, _ta); W(I ? I.getX(t + 1) : t + 1, _tb); W(I ? I.getX(t + 2) : t + 2, _tc);
    const L = Math.max(Math.hypot(_tb[0] - _ta[0], _tb[2] - _ta[2]), Math.hypot(_tc[0] - _ta[0], _tc[2] - _ta[2]), Math.hypot(_tc[0] - _tb[0], _tc[2] - _tb[2]));
    const m = Math.max(1, Math.ceil(L / (PC * 0.6)));
    for (let a = 0; a <= m; a++) for (let b = 0; a + b <= m; b++) {
      const u = a / m, v = b / m, w = 1 - u - v;
      const x = _ta[0] * w + _tb[0] * u + _tc[0] * v, y = _ta[1] * w + _tb[1] * u + _tc[1] * v, z = _ta[2] * w + _tb[2] * u + _tc[2] * v;
      const i = Math.floor((x - POX) / PC), j = Math.floor((z - POZ) / PC);
      if (i < 0 || j < 0 || i >= PN || j >= PN) continue;
      const c = j * PN + i; if (propTop[c] < y) propTop[c] = y;
    }
  }
}
export function addPropHeights(mesh, tag = null) {
  if (!propTop) return null;
  mesh.updateMatrixWorld(true);
  const e = { mesh, M: mesh.matrixWorld.clone(), tag, off: false };
  props.push(e); rasterize(mesh.geometry, e.M.elements);
  return e;
}
// take every prop with this tag out (or put all back: tag === null, on = true) and rebuild the map
export function setPropsOn(tag, on) {
  if (!propTop) return;
  let changed = false;
  for (const e of props) if ((tag === null || e.tag === tag) && e.off === on) { e.off = !on; changed = true; }
  if (!changed) return;
  propTop.fill(-1e9);
  for (const e of props) if (!e.off) rasterize(e.mesh.geometry, e.M.elements);
}

// Is a point inside a standing tree's canopy (2 m up to its top, within 2.6 m x its scale of the trunk)? The camera may
// not be lifted into one: it looked down through a cage of grey branches (fix round 3).
export function inCanopy(x, y, z) {
  const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!list) return false;
  for (const o of list) {
    if (o.off || o.kind !== 'tree' || !o.tree) continue;
    const t = o.tree, R = (t.kind === 'cypress_tree' ? 1.4 : 2.6) * (t.s || 1);
    const dx = x - o.x, dz = z - o.z; if (dx * dx + dz * dz > R * R) continue;
    const g = groundHeight(o.x, o.z); if (y > g + 1.8 && y < g + (t.height || 6)) return true;
  }
  return false;
}
// Does a point (x,y,z) sit inside any tall collider? (camera pull-in)
export function pointBlocked(x, y, z, pad = 0.25, withProps = true) {
  if (y < groundAt(x, z) + pad) return true;
  if (y < rockHeight(x, z) + pad) return true;
  if (withProps && y < propHeight(x, z) + pad) return true;
  const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!list) return false;
  for (const o of list) {
    if (o.off || o.kind === 'rock' || y > o.y0 + o.h || y < o.y0) continue;
    if (o.t === 0) { const dx = x - o.x, dz = z - o.z; if (dx * dx + dz * dz < (o.r + pad) * (o.r + pad)) return true; }
    else {
      const dx = x - o.x, dz = z - o.z;
      const lx = dx * o.c + dz * o.s, lz = -dx * o.s + dz * o.c;
      if (Math.abs(lx) < o.hx + pad && Math.abs(lz) < o.hz + pad) return true;
    }
  }
  return false;
}
