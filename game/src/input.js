// input.js — one job: raw input state. It tracks keys, mouse buttons and
// pointer-lock look deltas, and exposes them as plain fields the sim reads
// each fixed step. It never touches gameplay state directly; the sim
// consumes deltas and clears them.
export const input = {
  keys: Object.create(null),   // code -> true while held
  mouseDX: 0, mouseDY: 0,      // accumulated look deltas since last step
  mouseDown: false,            // left button held (fire)
  mouseClicked: false,         // left button pressed this frame (semi-auto)
  rightDown: false,            // right button held (ADS)
  locked: false,               // pointer lock active
  wheel: 0,                    // wheel steps since last step
};

const SENS = 0.0023;

export function bindInput(canvas, onLockChange) {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') e.preventDefault();
    // While locked, Space must not re-trigger a focused button (e.g. PLAY).
    if (e.code === 'Space' && input.locked) e.preventDefault();
    input.keys[e.code] = true;
  });
  window.addEventListener('keyup', (e) => { input.keys[e.code] = false; });
  window.addEventListener('blur', () => {
    for (const k in input.keys) input.keys[k] = false;
    input.mouseDown = false; input.rightDown = false;
  });
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    if (onLockChange) onLockChange(input.locked);
  });
  document.addEventListener('mousemove', (e) => {
    if (!input.locked) return;
    input.mouseDX += e.movementX * SENS;
    input.mouseDY += e.movementY * SENS;
  });
  document.addEventListener('mousedown', (e) => {
    if (!input.locked) return;
    if (e.button === 0) { input.mouseDown = true; input.mouseClicked = true; }
    if (e.button === 2) input.rightDown = true;
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) input.mouseDown = false;
    if (e.button === 2) input.rightDown = false;
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('wheel', (e) => {
    if (input.locked) input.wheel += Math.sign(e.deltaY);
  }, { passive: true });
}

export function requestLock(canvas) {
  if (!input.locked) canvas.requestPointerLock();
}

export function consumeLook() {
  const dx = input.mouseDX, dy = input.mouseDY;
  input.mouseDX = 0; input.mouseDY = 0;
  return { dx, dy };
}

// Edge-triggered keys: true once per press, consumed by the caller.
const _pressed = new Set();
export function pressed(code) {
  if (input.keys[code] && !_pressed.has(code)) { _pressed.add(code); return true; }
  if (!input.keys[code]) _pressed.delete(code);
  return false;
}
export function keyDown(code) { return !!input.keys[code]; }
