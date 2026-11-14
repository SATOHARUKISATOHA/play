// Loads and prepares every character type once: the hero (original multi-material model + bone-attached gear,
// for close-up quality), Cicones heavy / light soldiers (body + gear merged into one atlas draw call, plus a
// vertex-clustered far LOD), the clip tables (in-place clips + root-motion curves + measured strides and foot
// contacts) and Polyphemus.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { buildMergedCharacter, clusterLOD } from './skinned.js';
import { buildClipTable } from './character.js';

const CH = './assets/characters/';

// ---- clip tables (times in seconds of clip time; hit windows refer to the weapon sweep)
export const HERO_CLIPS = {
  idle: { clip: 'Sword_Idle', loop: true, full: true },
  walk: { clip: 'Walk_Loop', loop: true },
  run: { clip: 'Jog_Fwd_Loop', loop: true },
  sprint: { clip: 'Sprint_Loop', loop: true },
  // hit windows (clip seconds) re-measured on the re-baked clips (fix round 1) from the blade tip's real path:
  // atk1 rising slash 0.20-0.28 (reaches 0.9-1.2 m ahead), atk2 flat slash 0.21-0.31 (1.3 m), atk3 rising cut
  // 0.06-0.24 + overhead cut 0.59-0.72, heavy: dash 3.8 m then a flat cut 0.29-0.36. The old atk3 second window
  // (1.78-1.99) and heavy window (0.66-0.92) sat on a still blade (artefacts of the broken bake).
  // reach = distance (root to target centre) at which the strike passes through the body; the hero lunges to it.
  atk1: { clip: 'Sword_Regular_A', meta: { hits: [[0.18, 0.30]], queueFrom: 0.08, next: 0.30, cancel: 0.31, dmg: 24, stop: 0.055, push: 3.2, kind: 'slash', reach: 1.55 } },
  atk2: { clip: 'Sword_Regular_B', meta: { hits: [[0.20, 0.33]], queueFrom: 0.1, next: 0.36, cancel: 0.36, dmg: 26, stop: 0.06, push: 3.6, kind: 'slash', reach: 1.05 } },
  atk3: { clip: 'Sword_Regular_C', rate: 1.2, meta: { hits: [[0.06, 0.26], [0.58, 0.75]], queueFrom: 99, next: 99, cancel: 0.85, end: 1.35, dmg: 34, dmg2: 46, stop: 0.09, push: 6.5, heavyLast: true, kind: 'sweep', reach: 1.2 } },
  heavy: { clip: 'Sword_Dash_RM', rate: 1.05, meta: { hits: [[0.27, 0.40]], queueFrom: 99, next: 99, cancel: 0.75, end: 1.0, dmg: 62, stop: 0.12, push: 8.5, heavy: true, kind: 'heavy', reach: 3.6 } },
  block: { clip: 'Sword_Block', full: true, meta: { holdAt: 0.42 } },
  roll: { clip: 'Roll_RM', full: true, rate: 1.35, rmScale: 0.74, meta: { iframes: [0.05, 0.62] } },
  hit: { clip: 'Hit_Chest', rate: 0.9 },
  hit2: { clip: 'Hit_Head', rate: 0.9 },
  knock: { clip: 'Hit_Knockback_RM', full: true, rmScale: 0.55 },
  getup: { clip: 'LayToIdle', full: true, rate: 1.15 },
  guardBreak: { clip: 'Idle_Shield_Break', full: true },
  death: { clip: 'Death01', full: true },
};
export const SOLDIER_CLIPS = {
  idle: { clip: 'Idle_Loop', loop: true },
  walk: { clip: 'Walk_Loop', loop: true },
  run: { clip: 'Jog_Fwd_Loop', loop: true },
  sprint: { clip: 'Sprint_Loop', loop: true },
  guard: { clip: 'Idle_Shield_Loop', loop: true, full: true },
  thrust: { clip: 'Spear_Thrust_Overhand', rmScale: 0.8, meta: { hits: [[0.27, 0.40]], dmg: 9 } },
  throw: { clip: 'OverhandThrow', full: true, meta: { release: 0.383 } },
  hit: { clip: 'Hit_Chest' },
  hit2: { clip: 'Hit_Head' },
  knock: { clip: 'Hit_Knockback_RM', full: true, rmScale: 0.75 },
  getup: { clip: 'LayToIdle', full: true },
  jump: { clip: 'Jump_Loop', loop: true, full: true },
  land: { clip: 'Jump_Land', full: true },
  blockHit: { clip: 'Idle_Shield_Break', full: true, rate: 1.4 },
  death: { clip: 'Death01', full: true },
};
export const CYCLOPS_CLIPS = {
  idle: { clip: 'cIdle', loop: true },
  walk: { clip: 'cWalk', loop: true },
  run: { clip: 'cRun', loop: true },
  look: { clip: 'cIdleBreak' },
  sweep: { clip: 'cSweep' }, slam: { clip: 'cSlam' }, stomp: { clip: 'cStomp' }, throw: { clip: 'cThrow' },
  roar: { clip: 'cRoar' }, hit: { clip: 'cHit' }, fall: { clip: 'cFall' }, stagger: { clip: 'cStagger', loop: true },
  recover: { clip: 'cRecover' }, death: { clip: 'cDeath' }, sleep: { clip: 'cSleep', loop: true }, wake: { clip: 'cWake' },
};

export async function loadCharacters(A) {
  const [hop, kik, gearG, am, attachJ, poly, polyMeta] = await Promise.all([
    A.gltf(CH + 'hoplite.glb'), A.gltf(CH + 'kikones.glb'), A.gltf(CH + 'gear.glb'), A.gltf(CH + 'anim/anim_male.glb'),
    A.json(CH + 'gear-attach.json'), A.gltf('./assets/creatures/polyphemus/polyphemus.glb'), A.json('./assets/creatures/polyphemus/polyphemus.meta.json'),
  ]);
  const attach = attachJ.attach;
  const gear = {}; for (const c of [...gearG.scene.children]) gear[c.name] = c;
  for (const g of Object.values(gear)) g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // weapon lengths (grip at origin, tip along -Z)
  const weaponLen = {};
  for (const w of ['xiphos', 'dory', 'javelin', 'kopis']) {
    const g = gear[w].clone(true); g.position.set(0, 0, 0); g.quaternion.identity(); g.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g); weaponLen[w] = Math.max(-bb.min.z, 0.3);
  }
  const raw = Object.fromEntries(am.animations.map((c) => [c.name, c]));
  const probe = SkeletonUtils.clone(hop.scene);
  const heroTable = buildClipTable(raw, HERO_CLIPS, probe);
  const soldierTable = buildClipTable(raw, SOLDIER_CLIPS, probe, { rig: kik.scene });
  const guardClip = heroTable.walk ? raw.Idle_Shield_Loop : null;

  // merged soldiers
  const heavy = buildMergedCharacter(kik.scene, { gear: ['helmet_thracian', 'aspis_black', 'dory'], gearSrc: gear, attach, name: 'heavy' });
  const light = buildMergedCharacter(kik.scene, { hide: /^(Corslet|Pteruges|Pteruges2)$/, gear: ['helmet_pilos', 'pelta'], gearSrc: gear, attach, tints: [{ re: /linen_ochre/, rgb: [0.62, 0.5, 0.42] }], name: 'light' });
  // a second heavy: felt cap instead of the Thracian helmet, a madder-red tunic, weathered skin and a greying beard, so
  // a crowd is not one man copied (critic round 2, defect 16: every soldier had the same face, body and shield)
  const heavy2 = buildMergedCharacter(kik.scene, { gear: ['helmet_pilos', 'aspis_black', 'dory'], gearSrc: gear, attach, name: 'heavy2',
    tints: [{ re: /linen_white/, rgb: [0.72, 0.36, 0.26] }, { re: /linen_corslet/, rgb: [0.82, 0.74, 0.62] }, { re: /Superhero/, rgb: [0.86, 0.76, 0.68] }, { re: /MI_Hair/, rgb: [1.25, 1.2, 1.15] }] });
  // near: fine clustering (looks identical from 2 m), mid: 5 cm cells, far: 11 cm cells across UV seams
  for (const T of [heavy, light, heavy2]) { T.lod0 = clusterLOD(T.geometry, 0.02); T.lod = clusterLOD(T.geometry, 0.05); T.lod2 = clusterLOD(T.geometry, 0.12, { uvSeams: false }); }

  // Polyphemus: in-place clips (walk / run measured on its own feet)
  const polyRaw = Object.fromEntries(poly.animations.map((c) => [c.name, c]));
  const pProbe = SkeletonUtils.clone(poly.scene);
  const cyTable = buildClipTable(polyRaw, CYCLOPS_CLIPS, pProbe, { sides: [['foot_L'], ['foot_R']], ref: 'cIdle', noRootMotion: true, rootName: '_rootJoint' });
  for (const [k, e] of Object.entries(cyTable)) {
    if (!e || !e.src) continue;
    const m = polyMeta.clips[e.src];
    if (m && m.events) Object.assign(e, { ev: m.events });
  }
  return { hop, gear, attach, weaponLen, raw, heroTable, soldierTable, guardClip, heavy, heavy2, light, poly, polyMeta, cyTable };
}

// the hero: original materials, gear on bones, cloak bones driven by a spring
export function makeHeroRoot(C) {
  const root = SkeletonUtils.clone(C.hop.scene);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  return root;
}
