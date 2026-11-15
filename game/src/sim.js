// sim.js — one job: the fixed-step simulation. One step(dt) advances the
// whole match by exactly dt seconds: player movement (acceleration +
// friction) and actions, every bot brain, grenades, the round state machine,
// and the event queue that sound, feed and effects consume. Rendering never
// writes gameplay state; this module is the only writer.
import { S } from './state.js';
import { collideInto } from './map.js';
import { input, consumeLook, pressed, keyDown } from './input.js';
import { fire, resolveShot, startReload, finishReload, throwGrenade, stepGrenades, currentWeaponOf } from './weapons.js';
import { stepBot, hear } from './bots.js';
import { stepRounds, inSite } from './rounds.js';
import { sfx, setMuted } from './audio.js';
import { showHitmarker, botSay } from './hud.js';
import { spawnTracer, spawnSparks } from './fx.js';
import { chance, pick } from './rng.js';

const WALK = 5.4, CROUCH_SPEED = 2.7, ADS_SPEED = 3.3, ACCEL = 42, FRICTION = 10;
const _mv = [0, 0];
let stepAcc = 0; // footstep timer

export function step(dt) {
  S.time += dt;
  const p = S.player;
  if (S.phase === 'live' || S.phase === 'buy') {
    stepPlayer(p, dt);
    for (const a of S.agents) if (!a.isPlayer) stepBot(a, dt);
    stepGrenades(dt);
    // Reload timers.
    for (const a of S.agents) {
      if (a.reloading > 0) {
        a.reloading -= dt;
        if (a.reloading <= 0) finishReload(a);
      }
      a.bloom = Math.max(0, a.bloom - dt * 0.09);
      a.recoilPitch = Math.max(0, a.recoilPitch - dt * 0.22);
      a.flashT = Math.max(0, a.flashT - dt);
      a.hurtT = Math.max(0, a.hurtT - dt);
    }
  }
  stepRounds(dt);
  drainEvents();
}

function stepPlayer(p, dt) {
  // Look.
  const { dx, dy } = consumeLook();
  if (p.alive && input.locked) {
    p.yaw -= dx;
    p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch - dy));
  }
  // Global keys (work even while dead).
  if (pressed('KeyM')) { S.muted = !S.muted; setMuted(S.muted); }
  S.scoreOpen = keyDown('Tab');
  if (pressed('KeyB') && S.phase === 'buy') {
    S.buyOpen = !S.buyOpen;
    if (S.buyOpen) document.exitPointerLock?.();
  }
  if (S.buyOpen && pressed('Escape')) S.buyOpen = false;
  if (!p.alive || S.phase !== 'live' && S.phase !== 'buy') return;
  if (S.phase === 'buy') {
    // Buy phase: can move slowly around spawn, cannot fire.
    stepMove(p, dt, WALK * 0.6);
    return;
  }

  // Slots 1–5 + wheel cycles primary/sidearm.
  for (let n = 1; n <= 5; n++) {
    if (pressed('Digit' + n)) setSlot(p, n);
  }
  if (input.wheel !== 0) {
    setSlot(p, p.slot === 1 ? 2 : 1);
    input.wheel = 0;
  }
  p.crouch = keyDown('ControlLeft') || keyDown('KeyC');
  p.ads = input.rightDown && p.slot <= 2;

  stepMove(p, dt, p.crouch ? CROUCH_SPEED : p.ads ? ADS_SPEED : WALK);

  // Jump.
  if (pressed('Space') && p.y <= 0.01) p.vy = 5.2;
  if (p.y > 0 || p.vy > 0) {
    p.vy -= 16 * dt;
    p.y = Math.max(0, p.y + p.vy * dt);
    if (p.y === 0) p.vy = 0;
  }

  // Fire / throw.
  const w = currentWeaponOf(p);
  if (p.slot <= 2 && w) {
    const wantFire = w.auto ? input.mouseDown : input.mouseClicked;
    if (wantFire) {
      const am = p.ammo[w.id];
      if (am.mag === 0) {
        if (input.mouseClicked) sfx.dryFire();
        if (am.reserve > 0) startReload(p);
      } else {
        const hit = fire(p);
        if (hit) {
          sfx.shoot(w.id);
          hear(p.x, p.z, 26, p.team);
          resolveShot(p, hit);
        }
      }
    }
    if (pressed('KeyR') && startReload(p)) sfx.reload();
  } else if (p.slot === 3 || p.slot === 4) {
    if (input.mouseClicked) {
      const kind = p.slot === 3 ? 'frag' : 'smoke';
      if (throwGrenade(p, kind)) { sfx.throwPin(); setSlot(p, p.primary ? 1 : 2); }
      else sfx.denied();
    }
  }
  input.mouseClicked = false;

  // Plant / defuse (hold E).
  const holdingE = keyDown('KeyE');
  if (holdingE && p.carrying && S.charge.state === 'carried' && inSite(p)) {
    p.plantT += dt;
    if (Math.floor(p.plantT * 2) !== Math.floor((p.plantT - dt) * 2)) sfx.beepTick();
  } else if (holdingE && S.charge.state === 'planted' && p.team === 'NW' &&
    Math.hypot(p.x - S.charge.x, p.z - S.charge.z) < 2.5) {
    p.defuseT += dt;
    if (Math.floor(p.defuseT * 2) !== Math.floor((p.defuseT - dt) * 2)) sfx.beepTick();
  } else {
    // Progress decays when the key is released — no free partial plants.
    p.plantT = Math.max(0, p.plantT - dt * 2);
    p.defuseT = Math.max(0, p.defuseT - dt * 2);
  }

  // Pick up a dropped charge by walking over it.
  if (S.charge.state === 'dropped' && p.team === 'DB' &&
    Math.hypot(p.x - S.charge.x, p.z - S.charge.z) < 1.6) {
    p.carrying = true;
    S.charge.state = 'carried'; S.charge.carrier = p;
    S.events.push({ type: 'pickup', agent: p });
  }
}

function setSlot(p, n) {
  if (n === 1 && !p.primary) return;
  if (n === 3 && p.frag <= 0) return;
  if (n === 4 && p.smoke <= 0) return;
  if (n === 5 && !p.carrying) return;
  if (p.slot !== n) { p.slot = n; p.reloading = 0; }
}

function stepMove(p, dt, maxSpeed) {
  // Wish direction from keys: forward is (-sin yaw, -cos yaw), right is
  // (cos yaw, -sin yaw). W pushes forward, D pushes right.
  let ix = 0, iz = 0;
  if (keyDown('KeyW')) iz -= 1;
  if (keyDown('KeyS')) iz += 1;
  if (keyDown('KeyA')) ix -= 1;
  if (keyDown('KeyD')) ix += 1;
  const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
  const fwd = -iz, strafe = ix;
  const wx = -sy * fwd + cy * strafe;
  const wz = -cy * fwd - sy * strafe;
  const wl = Math.hypot(wx, wz);
  if (wl > 0) {
    p.vx += (wx / wl) * ACCEL * dt;
    p.vz += (wz / wl) * ACCEL * dt;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > maxSpeed) { p.vx *= maxSpeed / sp; p.vz *= maxSpeed / sp; }
  } else {
    // Friction: exponential decay toward still.
    const f = Math.max(0, 1 - FRICTION * dt);
    p.vx *= f; p.vz *= f;
    if (Math.hypot(p.vx, p.vz) < 0.05) { p.vx = 0; p.vz = 0; }
  }
  collideInto(p.x + p.vx * dt, p.z + p.vz * dt, 0.4, _mv);
  p.x = _mv[0]; p.z = _mv[1];
  p.moving = Math.hypot(p.vx, p.vz) > 0.5;
  if (p.moving && p.y === 0) {
    stepAcc += dt * Math.hypot(p.vx, p.vz);
    if (stepAcc > 2.6) { stepAcc = 0; sfx.step(); }
  }
}

// ---- event drain: sim -> sound / feed / effects --------------------------
function drainEvents() {
  const p = S.player;
  for (const e of S.events) {
    switch (e.type) {
      case 'shot': {
        const eyeY = e.from.crouch ? 1.15 : 1.62;
        spawnTracer(e.from.x, eyeY, e.from.z, e.x, e.y, e.z);
        if (e.wall) spawnSparks(e.x, e.y, e.z, 3);
        if (!e.from.isPlayer) {
          const d = Math.hypot(e.from.x - p.x, e.from.z - p.z);
          if (d < 60) sfx.enemyShoot(d);
        }
        break;
      }
      case 'hitmark':
        showHitmarker(e.head);
        sfx.hit(e.head);
        if (e.died) sfx.kill();
        break;
      case 'kill': {
        const wname = e.weapon || 'rifle';
        S.feed.push({
          text: e.killer.name + '  ' + wname + (e.head ? ' HS' : '') + '  ' + e.victim.name,
          cls: e.killer.isPlayer ? 'me' : e.victim.isPlayer ? 'dead' : '',
          t: S.time,
        });
        if (e.victim.isPlayer) sfx.hurt();
        if (e.killer.isPlayer && chance(0.4)) botSay(pickCallout(e.killer));
        break;
      }
      case 'explosion':
        spawnSparks(e.x, 0.5, e.z, e.big ? 14 : 8);
        sfx.explosion();
        break;
      case 'smoke':
        break; // visuals are synced from S.smokes by fx.js
      case 'throw':
        break;
      case 'planted':
        S.feed.push({ text: e.agent.name + ' planted the charge at SITE ' + e.site, cls: 'obj', t: S.time });
        botSay(e.agent.name + ': charge planted at ' + e.site + ', hold it');
        break;
      case 'defused':
        S.feed.push({ text: e.agent.name + ' defused the charge', cls: 'obj', t: S.time });
        break;
      case 'pickup':
        S.feed.push({ text: e.agent.name + ' picked up the charge', cls: 'obj', t: S.time });
        break;
      case 'chargeDropped':
        S.feed.push({ text: 'The charge was dropped', cls: 'obj', t: S.time });
        break;
      case 'beep':
        sfx.plantBeep(e.urgent);
        break;
      case 'roundStart':
        if (S.round === 1) botSay('Juno: push mid, I smoke the gate');
        else if (chance(0.5)) botSay(pickCallout());
        break;
      case 'roundEnd':
        break;
      case 'live':
        break;
      case 'matchEnd':
        break;
    }
  }
  S.events.length = 0;
}

const CALLOUTS = [
  'Juno: two at the dish crates',
  'Ash: holding mid, come to me',
  'Koda: smoke on the gate, go go',
  'Pip: contact, east road',
  'Juno: nice shot, keep pushing',
  'Ash: one left, play it safe',
];
function pickCallout() {
  return pick(CALLOUTS);
}
