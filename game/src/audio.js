// audio.js — one job: synthesized sound. Every effect is built from WebAudio
// oscillators and filtered noise at runtime — no audio files ship with the
// game. One shared AudioContext, lazily created on the first user gesture.
import { S } from './state.js';

let ctx = null, master = null;
function ensure() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    return true;
  } catch { return false; }
}
export function unlockAudio() { ensure(); }
export function setMuted(m) { if (master) master.gain.value = m ? 0 : 0.5; }

function tone(freq, dur, type, vol, slideTo, when = 0) {
  if (!ctx || S.muted) return;
  const t0 = ctx.currentTime + when;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

let _noiseBuf = null;
function noise(dur, vol, freq, q = 1, when = 0) {
  if (!ctx || S.muted) return;
  if (!_noiseBuf) {
    _noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = _noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = ctx.currentTime + when;
  const src = ctx.createBufferSource();
  src.buffer = _noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.02);
}

export const sfx = {
  shoot(weaponId) {
    if (!ensure()) return;
    if (weaponId === 'longbow') { noise(0.28, 0.9, 500, 0.7); tone(120, 0.22, 'sine', 0.7, 40); }
    else if (weaponId === 'kestrel') { noise(0.09, 0.55, 1800, 0.8); tone(220, 0.06, 'square', 0.25, 90); }
    else { noise(0.14, 0.7, 900, 0.8); tone(160, 0.1, 'sawtooth', 0.35, 60); }
  },
  enemyShoot(dist) {
    if (!ensure()) return;
    const v = Math.max(0.06, 0.5 - dist * 0.012);
    noise(0.1, v, 700, 0.8);
  },
  dryFire() { if (ensure()) tone(1400, 0.04, 'square', 0.15); },
  reload() { if (!ensure()) return; tone(500, 0.05, 'square', 0.2, 300); tone(700, 0.05, 'square', 0.2, 400, 0.18); },
  hit(head) {
    if (!ensure()) return;
    if (head) { tone(1560, 0.12, 'sine', 0.5); tone(2090, 0.16, 'sine', 0.4, null, 0.05); }
    else tone(950, 0.06, 'sine', 0.4);
  },
  kill() { if (ensure()) { tone(660, 0.09, 'sine', 0.4); tone(990, 0.14, 'sine', 0.4, null, 0.08); } },
  hurt() { if (ensure()) tone(110, 0.15, 'sawtooth', 0.4, 70); },
  step() { if (ensure()) noise(0.05, 0.08, 400, 1); },
  plantBeep(final) {
    if (!ensure()) return;
    tone(final ? 1760 : 1180, final ? 0.3 : 0.09, 'sine', 0.45);
  },
  beepTick() { if (ensure()) tone(1320, 0.05, 'sine', 0.3); },
  explosion() { if (!ensure()) return; noise(0.7, 1, 160, 0.5); tone(70, 0.6, 'sine', 0.9, 30); },
  throwPin() { if (ensure()) tone(900, 0.05, 'square', 0.2, 600); },
  buy() { if (ensure()) { tone(880, 0.07, 'sine', 0.35); tone(1174, 0.1, 'sine', 0.35, null, 0.07); } },
  denied() { if (ensure()) tone(220, 0.12, 'square', 0.25, 160); },
  roundWin() {
    if (!ensure()) return;
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.4, null, i * 0.11));
  },
  roundLose() {
    if (!ensure()) return;
    [392, 330, 262, 196].forEach((f, i) => tone(f, 0.26, 'triangle', 0.35, null, i * 0.12));
  },
};
