// Keyboard + mouse (pointer lock when available, drag-look fallback). Scriptable for tests.
export class Input {
  constructor(canvas) {
    this.keys = new Set(); this.pressed = new Set();
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, middlePressed: false };
    this.onFirst = null; this.any = false;
    this.canvas = canvas; this.locked = false; this.enabled = false;
    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.code;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
      if (!this.any) { this.any = true; if (this.onFirst) this.onFirst(); }
      if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;   // on-screen buttons (mute, credits) are not sword strokes
      if (!this.any) { this.any = true; if (this.onFirst) this.onFirst(); }
      if (!this.locked) { this.requestLock(); if (e.button === 0 && !this.clicked) { this.clicked = true; return; } }   // the first click only grabs the mouse
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 1) { this.mouse.middlePressed = true; e.preventDefault(); }
      if (e.button === 2) this.mouse.right = true;
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.left = false; if (e.button === 2) this.mouse.right = false; });
    addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
      else if (this.freeLook) { this.mouse.dx += e.movementX * 0.6; this.mouse.dy += e.movementY * 0.6; }
      else if (e.buttons & 4 || e.buttons & 2 && e.shiftKey) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
    });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === canvas; });
    this.clicked = false; this.freeLook = false;
  }
  requestLock() {
    try {
      const r = this.canvas.requestPointerLock && this.canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => {});
    } catch (e) { /* headless or denied: fall back to keys + drag */ }
  }
  down(k) { return this.keys.has(k); }
  was(k) { return this.pressed.has(k); }
  endFrame() { this.pressed.clear(); this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.leftPressed = false; this.mouse.middlePressed = false; }
  // test hooks
  simKey(code, ms = 120) { this.keys.add(code); this.pressed.add(code); setTimeout(() => this.keys.delete(code), ms); }
  simClick() { this.mouse.leftPressed = true; }
}
