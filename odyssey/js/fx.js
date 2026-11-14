// Effects: CPU particle pools (Points), shockwave rings, crater decals, target markers, weapon trail and blob
// shadows. Unlit colours are scaled by FX_BOOST (1 / tone-mapping exposure) so they sit in the HDR scene.
import * as THREE from 'three';
import { groundAt } from './collide.js';
import { groundNormal } from './terrain.js';
import { rand, clamp } from './util.js';

export const FX_BOOST = { value: 1 };

// ------------------------------------------------------------ particles
class Pool {
  constructor(scene, max, additive) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.a0 = new Float32Array(max); this.a1 = new Float32Array(max);
    this.rgb = new Float32Array(max * 3); this.rgb1 = new Float32Array(max * 3); this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.ground = new Uint8Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aCol', this.aCol); g.setAttribute('aSize', this.aSize);
    g.setDrawRange(0, 0);
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 600 } }]);
    uniforms.uBoost = FX_BOOST;
    this.mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        #include <fog_pars_vertex>
        uniform float uScale; attribute vec4 aCol; attribute float aSize; varying vec4 vCol;
        void main(){ vCol = aCol; vec4 mvPosition = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = clamp(aSize * uScale / max(-mvPosition.z, 0.1), 1.0, 480.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <fog_pars_fragment>
        uniform float uBoost;
        varying vec4 vCol;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d);
          float a = (1.0 - smoothstep(${additive ? '0.05, 0.5' : '0.18, 0.5'}, r)) * vCol.a;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vCol.rgb * uBoost, a);
          #include <fog_fragment>
        }`,
      transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, gg, b, a0, a1, grav = 0, drag = 0, r1, g1, b1, ground = 1) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = 0; this.maxLife[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0; this.a1[i] = a1;
    this.rgb[i * 3] = r; this.rgb[i * 3 + 1] = gg; this.rgb[i * 3 + 2] = b;
    this.rgb1[i * 3] = r1 ?? r; this.rgb1[i * 3 + 1] = g1 ?? gg; this.rgb1[i * 3 + 2] = b1 ?? b;
    this.grav[i] = grav; this.drag[i] = drag; this.ground[i] = ground;
  }
  kill(i) {
    const j = --this.n;
    if (i === j) return;
    const c3 = (arr) => { arr[i * 3] = arr[j * 3]; arr[i * 3 + 1] = arr[j * 3 + 1]; arr[i * 3 + 2] = arr[j * 3 + 2]; };
    c3(this.pos); c3(this.vel); c3(this.rgb); c3(this.rgb1);
    for (const arr of [this.life, this.maxLife, this.s0, this.s1, this.a0, this.a1, this.grav, this.drag, this.ground]) arr[i] = arr[j];
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) { this.kill(i); i--; continue; }
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt; this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.ground[i] && this.vel[i * 3 + 1] < 0) {
        const gy = groundAt(this.pos[i * 3], this.pos[i * 3 + 2]);
        if (this.pos[i * 3 + 1] < gy + 0.02) { this.pos[i * 3 + 1] = gy + 0.02; this.vel[i * 3 + 1] *= -0.2; this.vel[i * 3] *= 0.5; this.vel[i * 3 + 2] *= 0.5; }
      }
    }
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.maxLife[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const a = this.a0[i] + (this.a1[i] - this.a0[i]) * t;
      this.col[i * 4] = this.rgb[i * 3] + (this.rgb1[i * 3] - this.rgb[i * 3]) * t;
      this.col[i * 4 + 1] = this.rgb[i * 3 + 1] + (this.rgb1[i * 3 + 1] - this.rgb[i * 3 + 1]) * t;
      this.col[i * 4 + 2] = this.rgb[i * 3 + 2] + (this.rgb1[i * 3 + 2] - this.rgb[i * 3 + 2]) * t;
      this.col[i * 4 + 3] = a * Math.min(1, t * 8);
    }
    this.points.geometry.setDrawRange(0, this.n);
    this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true;
  }
}

function radialTexture(draw, size = 128) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  draw(cv.getContext('2d'), size);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class FX {
  constructor(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.add = new Pool(scene, 2200, true);
    this.alpha = new Pool(scene, 2600, false);
    this.rings = []; this.decals = []; this.markers = [];
    // shockwave ring material
    this.ringGeo = new THREE.RingGeometry(0.82, 1.0, 72, 1);
    this.ringGeo.rotateX(-Math.PI / 2);
    // crater texture
    this.craterTex = radialTexture((g, S) => {
      const c = S / 2;
      const gr = g.createRadialGradient(c, c, 4, c, c, c);
      gr.addColorStop(0, 'rgba(45,34,24,0.62)'); gr.addColorStop(0.45, 'rgba(60,46,32,0.42)'); gr.addColorStop(0.75, 'rgba(85,68,48,0.2)'); gr.addColorStop(1, 'rgba(90,70,50,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      g.strokeStyle = 'rgba(25,18,12,0.6)'; g.lineWidth = 2;
      for (let i = 0; i < 11; i++) {
        let a = Math.random() * Math.PI * 2, r = 8, x = c, y = c;
        g.beginPath(); g.moveTo(x, y);
        while (r < c * 0.95) { a += (Math.random() - 0.5) * 0.6; r += 6 + Math.random() * 6; x = c + Math.cos(a) * r; y = c + Math.sin(a) * r; g.lineTo(x, y); }
        g.stroke();
      }
    });
    this.blobTex = radialTexture((g, S) => {
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }, 64);
    // blob shadows (instanced)
    const bg = new THREE.PlaneGeometry(1, 1); bg.rotateX(-Math.PI / 2);
    this.blobs = new THREE.InstancedMesh(bg, new THREE.MeshBasicMaterial({ map: this.blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: true }), 64);
    this.blobs.count = 0; this.blobs.frustumCulled = false; this.blobs.renderOrder = 2;
    scene.add(this.blobs);
    this.blobList = [];
    // weapon trail ribbon
    this.trailN = 14;
    const tg = new THREE.BufferGeometry();
    this.trailPos = new Float32Array(this.trailN * 2 * 3);
    this.trailA = new Float32Array(this.trailN * 2);
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('aA', new THREE.BufferAttribute(this.trailA, 1).setUsage(THREE.DynamicDrawUsage));
    const ti = [];
    for (let i = 0; i < this.trailN - 1; i++) { const a = i * 2; ti.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    tg.setIndex(ti);
    this.trail = new THREE.Mesh(tg, new THREE.ShaderMaterial({
      vertexShader: 'attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      uniforms: { uBoost: FX_BOOST },
      fragmentShader: 'uniform float uBoost; varying float vA; void main(){ gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * uBoost, vA*0.32); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.trail.frustumCulled = false; this.trail.visible = false; this.trail.renderOrder = 7;
    scene.add(this.trail);
    this.trailPts = [];
  }
  setScale(h, fov) { const s = h / (2 * Math.tan((fov * Math.PI) / 360)); this.add.mat.uniforms.uScale.value = s; this.alpha.mat.uniforms.uScale.value = s; }

  // ---- emitters
  sparks(p, n = 14, dir = null) {
    for (let i = 0; i < n; i++) {
      const vx = rand(-3, 3) + (dir ? dir.x * 3 : 0), vy = rand(0.5, 4.5), vz = rand(-3, 3) + (dir ? dir.z * 3 : 0);
      this.add.spawn(p.x, p.y, p.z, vx, vy, vz, rand(0.15, 0.4), 0.06, 0.01, 1.0, 0.75, 0.4, 1, 0, 9.8, 1.5, 1.0, 0.4, 0.1);
    }
    this.add.spawn(p.x, p.y, p.z, 0, 0, 0, 0.09, 0.9, 1.4, 1.0, 0.8, 0.55, 0.9, 0, 0, 0);
  }
  blood(p, dir, n = 8) {
    for (let i = 0; i < n; i++) {
      this.alpha.spawn(p.x, p.y, p.z, dir.x * rand(0.8, 2.6) + rand(-0.6, 0.6), rand(0.3, 2.0), dir.z * rand(0.8, 2.6) + rand(-0.6, 0.6),
        rand(0.25, 0.5), rand(0.035, 0.06), 0.02, 0.22, 0.02, 0.015, 0.9, 0.7, 9.8, 0.5);
    }
  }
  dust(p, n = 8, spread = 0.6, size = 0.6, color = [0.62, 0.53, 0.4], up = 0.8, life = 1.2) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * spread;
      this.alpha.spawn(p.x + Math.cos(a) * r, p.y + 0.1, p.z + Math.sin(a) * r, Math.cos(a) * rand(0.3, 1.5), rand(0.2, up), Math.sin(a) * rand(0.3, 1.5),
        rand(life * 0.6, life), size * 0.5, size * rand(1.4, 2.2), color[0], color[1], color[2], 0.42, 0, -0.15, 1.8);
    }
  }
  splash(p, n = 16, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.alpha.spawn(p.x, p.y + 0.05, p.z, Math.cos(a) * rand(0.4, 1.6) * power, rand(1.5, 4.5) * power, Math.sin(a) * rand(0.4, 1.6) * power,
        rand(0.4, 0.8), 0.12, 0.05, 0.85, 0.9, 0.92, 0.8, 0, 9.8, 0.3, 0.75, 0.82, 0.85, 0);
    }
  }
  fire(p, k = 1) {
    // flame tongues + embers + smoke
    if (Math.random() < 0.9 * k) this.add.spawn(p.x + rand(-0.25, 0.25), p.y + 0.15, p.z + rand(-0.25, 0.25), rand(-0.1, 0.1), rand(0.9, 1.7), rand(-0.1, 0.1),
      rand(0.35, 0.7), rand(0.45, 0.7), 0.08, 1.0, 0.52, 0.16, 0.9, 0, -0.6, 0.8, 0.7, 0.14, 0.03, 0);
    if (Math.random() < 0.18 * k) this.add.spawn(p.x + rand(-0.2, 0.2), p.y + 0.3, p.z + rand(-0.2, 0.2), rand(-0.4, 0.4), rand(1.2, 2.6), rand(-0.4, 0.4),
      rand(1.0, 2.2), 0.04, 0.02, 1.0, 0.65, 0.25, 1, 0, -0.2, 0.6, 1.0, 0.3, 0.05, 0);
    if (Math.random() < 0.22 * k) this.alpha.spawn(p.x + rand(-0.2, 0.2), p.y + 1.1, p.z + rand(-0.2, 0.2), rand(-0.15, 0.15) + 0.25, rand(0.6, 1.0), rand(-0.15, 0.15),
      rand(2.5, 4.5), 0.5, 2.6, 0.32, 0.3, 0.28, 0.22, 0, -0.05, 0.25, 0.45, 0.42, 0.4, 0);
  }
  debris(p, n = 18, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(2, 7) * power;
      this.alpha.spawn(p.x, p.y + 0.3, p.z, Math.cos(a) * s * 0.6, rand(3, 9) * power, Math.sin(a) * s * 0.6, rand(0.8, 1.6), rand(0.08, 0.2), 0.06, 0.33, 0.28, 0.22, 1, 0.8, 14, 0.2);
    }
  }
  // ---- shockwave ring (stomp): returns ring state so gameplay can test the front
  shockwave(p, maxR = 14, dur = 0.9) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uA: { value: 1 }, uBoost: FX_BOOST },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform float uA; uniform float uBoost; varying vec2 vUv; void main(){ float e = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y)); gl_FragColor = vec4(vec3(0.95, 0.82, 0.6) * uBoost, uA*0.45*(0.4 + e)); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.position.set(p.x, groundAt(p.x, p.z) + 0.25, p.z);
    m.renderOrder = 4;
    this.scene.add(m);
    const ring = { m, t: 0, dur, maxR, x: p.x, z: p.z, r: 0, hitDone: false };
    this.rings.push(ring);
    return ring;
  }
  crater(p, r = 3.2) {
    const g = new THREE.PlaneGeometry(r * 2, r * 2); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: this.craterTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6, fog: true }));
    const y = groundAt(p.x, p.z);
    m.position.set(p.x, y + 0.04, p.z);
    const n = groundNormal(p.x, p.z, new THREE.Vector3());
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    m.rotateY(Math.random() * 6.28);
    m.renderOrder = 3;
    this.scene.add(m);
    this.decals.push({ m, t: 0 });
    if (this.decals.length > 8) { const d = this.decals.shift(); this.scene.remove(d.m); d.m.geometry.dispose(); d.m.material.dispose(); }
  }
  marker(p, r = 4) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uBoost: FX_BOOST },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform float uT; uniform float uBoost; varying vec2 vUv; void main(){ float d = length(vUv-0.5)*2.0; float ring = smoothstep(0.86,0.93,d)*(1.0-smoothstep(0.95,1.0,d)); float fill = (1.0-smoothstep(0.0,1.0,d))*0.16*(0.6+0.4*sin(uT*14.0)); gl_FragColor = vec4(vec3(0.85,0.25,0.12) * uBoost, (ring*0.8 + fill)); }',
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    });
    const g = new THREE.PlaneGeometry(r * 2, r * 2); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(p.x, groundAt(p.x, p.z) + 0.08, p.z);
    m.renderOrder = 3;
    this.scene.add(m);
    const mk = { m, t: 0, alive: true };
    this.markers.push(mk);
    return mk;
  }
  removeMarker(mk) { mk.alive = false; }
  // ---- trail
  trailPush(a, b, active) {
    if (active) { this.trailPts.unshift([a.clone(), b.clone()]); if (this.trailPts.length > this.trailN) this.trailPts.pop(); }
    else if (this.trailPts.length) this.trailPts.pop();
    const n = this.trailPts.length;
    this.trail.visible = n > 1;
    if (n < 2) return;
    for (let i = 0; i < this.trailN; i++) {
      const p = this.trailPts[Math.min(i, n - 1)];
      const A = p[0].clone().lerp(p[1], 0.45);
      this.trailPos.set([A.x, A.y, A.z, p[1].x, p[1].y, p[1].z], i * 6);
      const f = i < n ? 1 - i / (n - 1 || 1) : 0;
      this.trailA[i * 2] = f * 0.2; this.trailA[i * 2 + 1] = f;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.attributes.aA.needsUpdate = true;
  }
  // ---- blob shadows: call setBlobs([{x,y,z,r}]) each frame
  setBlobs(list) {
    const dummy = this._d || (this._d = new THREE.Object3D());
    const n = Math.min(list.length, 64);
    for (let i = 0; i < n; i++) {
      const b = list[i];
      dummy.position.set(b.x, b.y + 0.03, b.z);
      dummy.quaternion.identity();
      dummy.scale.set(b.r * 2, 1, b.r * 2);
      dummy.updateMatrix();
      this.blobs.setMatrixAt(i, dummy.matrix);
    }
    this.blobs.count = n;
    this.blobs.instanceMatrix.needsUpdate = true;
  }
  update(dt) {
    this.add.update(dt); this.alpha.update(dt);
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = Math.min(1, r.t / r.dur);
      r.r = r.maxR * (1 - Math.pow(1 - k, 2));
      r.m.scale.set(r.r, 1, r.r);
      r.m.material.uniforms.uA.value = 1 - k;
      if (Math.random() < 0.9) {
        const a = Math.random() * Math.PI * 2;
        this.dust({ x: r.x + Math.cos(a) * r.r, y: groundAt(r.x + Math.cos(a) * r.r, r.z + Math.sin(a) * r.r), z: r.z + Math.sin(a) * r.r }, 2, 0.3, 1.1, [0.66, 0.57, 0.44], 1.2, 1.3);
      }
      if (k >= 1) { this.scene.remove(r.m); r.m.material.dispose(); this.rings.splice(i, 1); }
    }
    for (const d of this.decals) {
      d.t += dt;
      if (d.t > 24) d.m.material.opacity = Math.max(0, 1 - (d.t - 24) / 6);
    }
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const mk = this.markers[i];
      mk.t += dt; mk.m.material.uniforms.uT.value = mk.t;
      if (!mk.alive) { this.scene.remove(mk.m); mk.m.geometry.dispose(); mk.m.material.dispose(); this.markers.splice(i, 1); }
    }
  }
}
