// Island heightfield. One analytic height function is baked into a grid; every
// gameplay query (feet, camera, particles) interpolates the SAME triangles the
// GPU draws, so nothing floats or sinks.
import * as THREE from 'three';
import { clamp, lerp, smoothstep, fbm, vnoise, distPointSeg2 } from './util.js';

export const HALF = 160;          // grid covers [-160,160]
export const N = 256;             // cells per side
export const CELL = (HALF * 2) / N;
export const WALK_R = 140;        // invisible wall radius (player)

// Points of interest (x, z). North is -Z.
export const POI = {
  start: { x: 4, z: 86 },
  heroShip: { x: 8, z: 104, yaw: Math.PI + 0.12 },
  camp: { x: -46, z: 70 },          // v2: the Cicones' camp sits at the back of the beach
  temple: { x: 50, z: -46 },
  cave: { x: -30, z: -63 },
  // 3.2 m inside the mouth (was 8 m): further in, the vault is 11.5 m and his rearing roar put his skull into the rock
  // (head bone 0.0 m under the ceiling, 11/14 round-1 re-test); here the arch leaves 1.1 m over the head bone
  cyclopsSleep: { x: -30, z: -63.2 },
  pen: { x: -62, z: -44 },
};

// Dirt paths (polylines) linking beach, temple, camp and cave.
const PATHS = [
  [[4, 96], [2, 70], [8, 40], [14, 18], [30, -12], [42, -30], [56, -40]],
  [[2, 70], [-20, 70], [-38, 70]],
  [[14, 18], [-4, -12], [-20, -38], [-28, -55]],
  [[-20, -38], [-44, -42], [-56, -44]],
];

function coastRadius(x, z) {
  const ang = Math.atan2(z, x);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return 117 + 6 * Math.sin(ang * 3 + 0.7) + 4 * Math.sin(ang * 5 - 1.1) + 7 * fbm(ca * 1.6 + 3.1, sa * 1.6 - 2.3, 3);
}

export function shoreDist(x, z) { return coastRadius(x, z) - Math.hypot(x, z); }

export function pathWeight(x, z) {
  let d = 1e9;
  for (const p of PATHS) for (let i = 0; i < p.length - 1; i++) {
    d = Math.min(d, distPointSeg2(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]));
  }
  const wob = 0.6 * vnoise(x * 0.31, z * 0.31);
  return smoothstep(2.6 + wob, 0.9, d);
}

// Analytic height (before baking)
function rawHeight(x, z) {
  const r = Math.hypot(x, z);
  const s = coastRadius(x, z) - r;                       // + inland, - sea
  const north = smoothstep(-15, -75, z);
  const beachW = lerp(36, 7, north);

  // inland rolling ground
  let inland = 2.7 + 2.3 * fbm(x / 55, z / 55, 3) + 0.55 * fbm(x / 13, z / 13, 2);

  // north plateau with an escarpment facing south (cave face); gentle ramp on the west
  const wid = 5 + 26 * smoothstep(-58, -92, x);
  const edgeZ = -62 + 4 * fbm(x / 22, 7.7, 2);
  const plateau = smoothstep(edgeZ, edgeZ - wid, z);
  inland += plateau * (10.5 + 1.5 * fbm(x / 30, z / 30, 2));

  // temple hill: flat top radius ~17 m at +19 m
  const dt = Math.hypot(x - POI.temple.x, z - POI.temple.z);
  const hill = smoothstep(54, 17, dt);
  inland += hill * 18.5 + (1 - hill) * hill * 6 * fbm(x / 9, z / 9, 2);

  // sheep pen flattened
  const dp = Math.hypot(x - POI.pen.x, z - POI.pen.z);
  inland = lerp(inland, inland * 0.6 + 2.2, smoothstep(16, 9, dp));

  // beach / sea-floor profile
  const shore = s >= 0 ? s * 0.085 : Math.max(s * 0.062, -4.6);
  let h = lerp(shore, inland, smoothstep(beachW * 0.25, beachW, s));
  // sea cliff in the north: rocky noise on the face
  if (north > 0.3 && s > 0 && s < 10) h += 0.8 * vnoise(x * 0.4, z * 0.4) * north;

  // slight path trench
  if (s > 4) h -= 0.14 * pathWeight(x, z);
  // beach camp: a level sandy terrace
  const dc = Math.hypot(x - POI.camp.x, z - POI.camp.z);
  h = lerp(h, 2.2 + 0.08 * vnoise(x * 0.2, z * 0.2), smoothstep(20, 12, dc));
  return h;
}

// Carve a flat floor into the heightfield (cave mouth): heights, render geometry and normals.
export function carveTerrain(geo, cx, cz, halfW, depth, floorY) {
  const pos = geo.attributes.position;
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const k = j * V + i, x = -HALF + i * CELL, z = -HALF + j * CELL;
    const dx = Math.abs(x - cx), dz = cz - z;            // dz > 0 = into the hill (north, -Z)
    if (dx > halfW + 2 || dz < -1 || dz > depth + 2) continue;
    const e = Math.min(1, Math.max(0, (halfW + 2 - dx) / 2)) * Math.min(1, Math.max(0, (depth + 2 - dz) / 2)) * Math.min(1, Math.max(0, (dz + 1) / 1));
    const h = heights[k];
    const nh = h + (Math.min(h, floorY) - h) * e;
    heights[k] = nh; pos.setY(k, nh);
  }
  pos.needsUpdate = true; geo.computeVertexNormals();
  // keep the sea shader's height texture in step
  if (heightTexture) { for (let k = 0; k < V * V; k++) heightTexture.image.data[k] = THREE.DataUtils.toHalfFloat(heights[k]); heightTexture.needsUpdate = true; }
}

// ---------- baked grid ----------
const V = N + 1;
export const heights = new Float32Array(V * V);
const biomeW = new Float32Array(V * V * 3); // sand, grass, stone

function idx(i, j) { return j * V + i; }

export function groundHeight(x, z) {
  let gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
  if (gx < 0 || gz < 0 || gx >= N || gz >= N) {
    // outside the grid: continue the sea floor
    return -4.6;
  }
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const ha = heights[idx(ix, iz)], hb = heights[idx(ix + 1, iz)];
  const hc = heights[idx(ix, iz + 1)], hd = heights[idx(ix + 1, iz + 1)];
  if (fx + fz <= 1) return ha + (hb - ha) * fx + (hc - ha) * fz;
  return hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
}

const _n = new THREE.Vector3();
export function groundNormal(x, z, out = _n) {
  const e = 0.7;
  const hl = groundHeight(x - e, z), hr = groundHeight(x + e, z);
  const hd = groundHeight(x, z - e), hu = groundHeight(x, z + e);
  return out.set(hl - hr, 2 * e, hd - hu).normalize();
}

export function waterDepth(x, z) { return Math.max(0, -groundHeight(x, z)); }

// Extra stone footprints (temple floor) registered by the world builder.
const stoneRects = [];
export function addStoneRect(cx, cz, hx, hz, top) { stoneRects.push({ cx, cz, hx, hz, top }); }

export function surfaceAt(x, z, y) {
  for (const r of stoneRects) {
    if (Math.abs(x - r.cx) < r.hx && Math.abs(z - r.cz) < r.hz && (y === undefined || y > r.top - 0.6)) return 'stone';
  }
  const g = groundHeight(x, z);
  if (g < -0.12) return 'water';
  let gx = clamp(Math.round((x + HALF) / CELL), 0, N), gz = clamp(Math.round((z + HALF) / CELL), 0, N);
  const k = idx(gx, gz) * 3;
  const s = biomeW[k], gr = biomeW[k + 1], st = biomeW[k + 2];
  if (st > s && st > gr) return 'stone';
  if (s > gr) return 'sand';
  return 'grass';
}

export let heightTexture = null;

export function buildTerrain() {
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    heights[idx(i, j)] = rawHeight(-HALF + i * CELL, -HALF + j * CELL);
  }
  const pos = new Float32Array(V * V * 3);
  const nor = new Float32Array(V * V * 3);
  const bio = new Float32Array(V * V * 4);
  const tmp = new THREE.Vector3();
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const k = idx(i, j);
    const x = -HALF + i * CELL, z = -HALF + j * CELL, h = heights[k];
    pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
    const hl = heights[idx(Math.max(i - 1, 0), j)], hr = heights[idx(Math.min(i + 1, N), j)];
    const hd = heights[idx(i, Math.max(j - 1, 0))], hu = heights[idx(i, Math.min(j + 1, N))];
    tmp.set(hl - hr, 2 * CELL, hd - hu).normalize();
    nor[k * 3] = tmp.x; nor[k * 3 + 1] = tmp.y; nor[k * 3 + 2] = tmp.z;
    const slope = 1 - tmp.y; // 0 flat .. 1 vertical

    // biome weights
    const n1 = fbm(x / 9, z / 9, 2), n2 = vnoise(x * 0.37, z * 0.37);
    // beach sand only along the shore (a strip of ~30-45 m, ragged) and on the camp terrace: the low ground inland
    // is dry grass and scrub like the rest of the island (critic round 1, defect 11: the interior read as empty sand)
    const sc = coastRadius(x, z) - Math.hypot(x, z), n3 = fbm(x / 23 + 4.1, z / 23 - 2.7, 2);
    const b0 = lerp(37, 20, smoothstep(-15, -75, z)) + 9 * n3;    // the wide landing beach in the south, narrow in the north
    const beach = 1 - smoothstep(b0, b0 + 11, sc);
    let sand = (1 - smoothstep(1.5, 3.3, h + 0.9 * n1)) * beach;
    sand = Math.max(sand, smoothstep(21, 15, Math.hypot(x - POI.camp.x, z - POI.camp.z)) * (0.85 + 0.15 * n2));
    let stone = smoothstep(0.16, 0.34, slope + 0.05 * n2);
    const north = smoothstep(-55, -80, z);
    stone = Math.max(stone, north * smoothstep(0.1, 0.5, n1 + 0.15));            // rocky plateau
    const dt = Math.hypot(x - POI.temple.x, z - POI.temple.z);
    stone = Math.max(stone, smoothstep(20, 14, dt) * smoothstep(-0.2, 0.35, n2)); // worn stone around temple
    const pw = pathWeight(x, z);
    sand = Math.max(sand, pw * 0.85);
    let grass = Math.max(0, 1 - sand - stone);
    const tot = sand + grass + stone + 1e-5;
    sand /= tot; grass /= tot; stone /= tot;
    biomeW[k * 3] = sand; biomeW[k * 3 + 1] = grass; biomeW[k * 3 + 2] = stone;
    bio[k * 4] = sand; bio[k * 4 + 1] = grass; bio[k * 4 + 2] = stone; bio[k * 4 + 3] = pw;
  }
  const index = new Uint32Array(N * N * 6);
  let o = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = idx(i, j), b = idx(i + 1, j), c = idx(i, j + 1), d = idx(i + 1, j + 1);
    index[o++] = a; index[o++] = c; index[o++] = b;
    index[o++] = b; index[o++] = c; index[o++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aBiome', new THREE.BufferAttribute(bio, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();

  // height texture for the sea shader (half float, linear filtered)
  const hdata = new Uint16Array(V * V);
  for (let k = 0; k < V * V; k++) hdata[k] = THREE.DataUtils.toHalfFloat(heights[k]);
  heightTexture = new THREE.DataTexture(hdata, V, V, THREE.RedFormat, THREE.HalfFloatType);
  heightTexture.magFilter = THREE.LinearFilter;
  heightTexture.minFilter = THREE.LinearFilter;
  heightTexture.wrapS = heightTexture.wrapT = THREE.ClampToEdgeWrapping;
  heightTexture.needsUpdate = true;
  return geo;
}
