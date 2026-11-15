// bots.js — one job: bot brains. Each bot is a small state machine over the
// waypoint graph (route / hold / engage / plant / defuse / seek) with
// sight (line-of-sight + smoke + range + field of view), hearing (gunfire
// alerts nearby bots) and burst fire with a human-like reaction delay.
// Movement, shooting and damage reuse the same code the player uses.
import { S, SITES } from './state.js';
import { WP, nearestWP, findRoute, losBlocked, collideInto, SITE_WP, DEFEND_WP } from './map.js';
import { fire, resolveShot, throwGrenade, smokedBetween } from './weapons.js';
import { rnd, range, chance } from './rng.js';

const THINK_EVERY = 0.15;      // perception tick, staggered per bot
const BOT_SPEED = 3.6;
const SIGHT_RANGE = 55;
const _routeBuf = new Int16Array(64);

// Team plan, picked fresh each round by rounds.js through planRound().
let teamSite = 'A';
export function planRound(site) { teamSite = site; }

export function assignBot(a, idx) {
  const ai = a.ai;
  ai.state = 'route'; ai.wp = 0; ai.route.length = 0; ai.holdT = 0;
  ai.target = null; ai.lastSeen = 0; ai.reactT = 0; ai.burst = 0;
  ai.alertT = 0; ai.strafeT = 0;
  ai.site = teamSite;
  const start = nearestWP(a.x, a.z);
  if (a.team === 'DB') {
    // Attackers push the team's site as a group, spread across lanes.
    const lane = idx % 3; // 0 mid, 1 west, 2 east
    const dest = SITE_WP[teamSite];
    const via = lane === 0 ? 4 : lane === 1 ? 10 : 16;
    const n1 = findRoute(start, via, _routeBuf);
    for (let i = 0; i < n1; i++) ai.route.push(_routeBuf[i]);
    const n2 = findRoute(via, dest, _routeBuf);
    for (let i = 1; i < n2; i++) ai.route.push(_routeBuf[i]);
  } else {
    // Defenders: two hold each site, one roams mid.
    const spots = idx < 2 ? DEFEND_WP.A : idx < 4 ? DEFEND_WP.B : [4, 5];
    const dest = spots[idx % spots.length];
    const n = findRoute(start, dest, _routeBuf);
    for (let i = 0; i < n; i++) ai.route.push(_routeBuf[i]);
    ai.site = idx < 2 ? 'A' : idx < 4 ? 'B' : 'A';
  }
}

// Gunfire / explosions alert enemy bots within earshot: they turn toward it.
export function hear(x, z, radius, team) {
  for (const b of S.agents) {
    if (b.isPlayer || !b.alive || b.team === team) continue;
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < radius) {
      b.ai.alertX = x; b.ai.alertZ = z; b.ai.alertT = 3;
    }
  }
}

export function stepBot(a, dt) {
  const ai = a.ai;
  if (!a.alive) return;
  ai.thinkT = (ai.thinkT || 0) - dt;
  if (ai.thinkT <= 0) { ai.thinkT = THINK_EVERY; think(a); }
  ai.alertT = Math.max(0, ai.alertT - dt);

  // Charge planted: defenders converge, attackers guard the site.
  if (S.charge.state === 'planted') {
    if (a.team === 'NW' && ai.state !== 'defuse' && ai.state !== 'engage') {
      const dest = SITE_WP[S.charge.site];
      reroute(a, dest);
      ai.state = 'route';
    } else if (a.team === 'DB' && ai.state === 'route') {
      ai.state = 'hold'; ai.holdT = 999;
    }
  }

  switch (ai.state) {
    case 'route': {
      if (ai.wp >= ai.route.length) {
        ai.state = 'hold'; ai.holdT = a.team === 'DB' ? 1.5 : 999;
        break;
      }
      const node = WP[ai.route[ai.wp]];
      if (moveToward(a, node[0], node[1], dt)) ai.wp++;
      // Carrier plants the moment it reaches its site.
      if (a.carrying && a.team === 'DB') {
        const s = SITES[teamSite];
        if (Math.hypot(a.x - s.x, a.z - s.z) < s.r && !ai.target) ai.state = 'plant';
      }
      break;
    }
    case 'hold': {
      ai.holdT -= dt;
      // Defenders peek: slow strafe scan; attackers wait for the push.
      if (ai.target) { face(a, ai.target.x, ai.target.z, dt, 6); }
      else if (a.team === 'NW') {
        ai.strafeT -= dt;
        if (ai.strafeT <= 0) { ai.strafeT = range(1.5, 3); ai.strafeDir = chance(0.5) ? 1 : -1; }
        a.yaw += ai.strafeDir * 0.25 * dt;
      }
      if (a.team === 'DB' && ai.holdT <= 0 && S.charge.state !== 'planted') {
        // Regroup: re-route to the site (covers carrier death / detours).
        reroute(a, SITE_WP[teamSite]); ai.state = 'route';
      }
      break;
    }
    case 'plant': {
      a.vx = 0; a.vz = 0;
      const s = SITES[teamSite];
      if (Math.hypot(a.x - s.x, a.z - s.z) >= s.r) { ai.state = 'route'; break; }
      if (ai.target) { ai.state = 'engage'; break; } // fight first, plant later
      a.plantT += dt;
      break;
    }
    case 'defuse': {
      a.vx = 0; a.vz = 0;
      const c = S.charge;
      if (Math.hypot(a.x - c.x, a.z - c.z) > 2.2) { ai.state = 'route'; break; }
      a.defuseT += dt;
      break;
    }
    case 'engage': {
      if (!ai.target || !ai.target.alive) { ai.state = ai.route.length ? 'route' : 'hold'; break; }
      face(a, ai.target.x, ai.target.z, dt, 8);
      // Strafe while fighting; close distance if the target is far.
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) { ai.strafeT = range(0.5, 1.1); ai.strafeDir = chance(0.5) ? 1 : -1; }
      const d = Math.hypot(ai.target.x - a.x, ai.target.z - a.z);
      const fwd = d > 18 ? 1 : 0;
      const mx = -Math.sin(a.yaw) * fwd + -Math.cos(a.yaw) * ai.strafeDir * 0.7;
      const mz = -Math.cos(a.yaw) * fwd + Math.sin(a.yaw) * ai.strafeDir * 0.7;
      moveVel(a, mx, mz, dt, BOT_SPEED * 0.55);
      shootAt(a, ai.target, dt);
      break;
    }
    case 'seek': {
      if (moveToward(a, ai.alertX, ai.alertZ, dt)) { ai.state = 'hold'; ai.holdT = 2; }
      break;
    }
  }
  // Arrived at the planted charge: defuse.
  if (a.team === 'NW' && S.charge.state === 'planted' && ai.state === 'route' && ai.wp >= ai.route.length) {
    const c = S.charge;
    if (Math.hypot(a.x - c.x, a.z - c.z) < 2.2) ai.state = 'defuse';
  }
  // Idle bots investigate heard gunfire.
  if (ai.alertT > 0 && !ai.target && (ai.state === 'hold')) {
    ai.state = 'seek';
  }
  a.moving = Math.hypot(a.vx, a.vz) > 0.5;
  // Bloom recovery, same as the player.
  a.bloom = Math.max(0, a.bloom - dt * 0.09);
  a.recoilPitch = Math.max(0, a.recoilPitch - dt * 0.25);
}

function reroute(a, dest) {
  const ai = a.ai;
  const n = findRoute(nearestWP(a.x, a.z), dest, _routeBuf);
  ai.route.length = 0;
  for (let i = 0; i < n; i++) ai.route.push(_routeBuf[i]);
  ai.wp = 0;
}

function moveToward(a, tx, tz, dt) {
  const dx = tx - a.x, dz = tz - a.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.6) { a.vx = 0; a.vz = 0; return true; }
  moveVel(a, dx / d, dz / d, dt, BOT_SPEED);
  face(a, tx, tz, dt, 5);
  return false;
}

const _mv = [0, 0];
function moveVel(a, mx, mz, dt, speed) {
  const l = Math.hypot(mx, mz) || 1;
  a.vx = (mx / l) * speed; a.vz = (mz / l) * speed;
  collideInto(a.x + a.vx * dt, a.z + a.vz * dt, 0.4, _mv);
  a.x = _mv[0]; a.z = _mv[1];
}

function face(a, tx, tz, dt, rate) {
  const want = Math.atan2(-(tx - a.x), -(tz - a.z));
  let diff = want - a.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  a.yaw += Math.max(-rate * dt, Math.min(rate * dt, diff));
  // Pitch toward the target's chest.
  a.pitch = Math.max(-0.5, Math.min(0.5, a.pitch + ((0 - a.pitch) * Math.min(1, dt * 4))));
}

function think(a) {
  const ai = a.ai;
  // Perception: nearest visible enemy in range and roughly ahead.
  let best = null, bestD = Infinity;
  for (const e of S.agents) {
    if (e.team === a.team || !e.alive) continue;
    const dx = e.x - a.x, dz = e.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d > SIGHT_RANGE || d >= bestD) continue;
    const ang = Math.atan2(-dx, -dz);
    let diff = ang - a.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) > 1.9 && d > 6) continue; // ~109° field of view
    if (losBlocked(a.x, a.z, e.x, e.z)) continue;
    if (smokedBetween(a.x, a.z, e.x, e.z)) continue;
    best = e; bestD = d;
  }
  if (best) {
    if (ai.target !== best) {
      ai.target = best;
      ai.reactT = range(0.28, 0.55); // reaction delay before first shot
      ai.burst = 0;
      ai.seenX = best.x; ai.seenZ = best.z; ai.lastSeen = S.time;
    } else {
      ai.seenX = best.x; ai.seenZ = best.z; ai.lastSeen = S.time;
    }
    if (ai.state !== 'engage' && ai.state !== 'defuse') ai.state = 'engage';
    // Occasionally toss a smoke at a far fight to reposition.
    if (bestD > 25 && a.smoke > 0 && chance(0.02)) throwGrenade(a, 'smoke');
  } else if (ai.target) {
    // Lost sight: keep engaging briefly, then fall back to last known spot.
    if (S.time - ai.lastSeen > 1.2) {
      ai.alertX = ai.seenX; ai.alertZ = ai.seenZ; ai.alertT = 2;
      ai.target = null;
      ai.state = 'seek';
    }
  }
}

function shootAt(a, target, dt) {
  const ai = a.ai;
  if (ai.reactT > 0) { ai.reactT -= dt; return; }
  const w = a.primary ? a.primary : a.sidearm;
  a.slot = a.primary ? 1 : 2;
  const am = a.ammo[w];
  if (am && am.mag === 0) {
    if (a.reloading <= 0 && am.reserve > 0) a.reloading = 2;
    return;
  }
  // Burst discipline: 3–5 shots, then a short pause.
  if (ai.burst <= 0) {
    ai.burst = Math.floor(range(3, 6));
    ai.pauseT = range(0.25, 0.5);
  }
  if (ai.pauseT > 0) { ai.pauseT -= dt; return; }
  // Aim error grows with distance and target speed; bots miss sometimes.
  const d = Math.hypot(target.x - a.x, target.z - a.z);
  const err = 0.012 + d * 0.0009 + (target.moving ? 0.02 : 0);
  a.pitch = (rnd() - 0.5) * err * 2;
  const savedYaw = a.yaw;
  a.yaw += (rnd() - 0.5) * err * 2;
  const hit = fire(a);
  a.yaw = savedYaw;
  if (hit) {
    ai.burst--;
    resolveShot(a, hit);
    hear(a.x, a.z, 22, a.team);
  }
}
