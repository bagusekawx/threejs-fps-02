// rng.js — one job: deterministic randomness. Every roll in the game flows
// through the single shared instance so a seed reproduces a match exactly
// (used by the ?shot= staging paths and by bot decisions alike).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shared instance. reset() is called once per match (and once per staged shot).
let _next = mulberry32(1);
export function reseed(seed) { _next = mulberry32(seed); }
export function rnd() { return _next(); }
export function range(a, b) { return a + (b - a) * _next(); }
export function rangeInt(a, b) { return Math.floor(range(a, b + 1)); }
export function pick(arr) { return arr[Math.floor(_next() * arr.length)]; }
export function chance(p) { return _next() < p; }
