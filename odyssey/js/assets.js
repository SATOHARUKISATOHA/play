// Cached loaders with one progress bar (GLB, textures, JSON).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Assets {
  constructor(onProgress = () => {}) {
    this.manager = new THREE.LoadingManager();
    this.manager.onProgress = (url, loaded, total) => onProgress(loaded / Math.max(1, total), url);
    this.gl = new GLTFLoader(this.manager);
    this.tl = new THREE.TextureLoader(this.manager);
    this.cache = new Map();
  }
  gltf(url) { if (!this.cache.has(url)) this.cache.set(url, this.gl.loadAsync(url)); return this.cache.get(url); }
  tex(url, { srgb = false, repeat = true } = {}) {
    const k = url + (srgb ? '#s' : '');
    if (!this.cache.has(k)) this.cache.set(k, this.tl.loadAsync(url).then((t) => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8; return t;
    }));
    return this.cache.get(k);
  }
  json(url) { if (!this.cache.has(url)) this.cache.set(url, fetch(url).then((r) => r.json())); return this.cache.get(url); }
}
