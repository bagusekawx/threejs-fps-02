// weapons.js — one job: gunplay math. Hitscan fire with analytic ray-vs-body
// tests (head sphere + torso cylinder), spread that grows with movement and
// fire and shrinks with ADS and crouch, recoil, damage falloff, reloads, and
// grenade ballistics. No rendering here — hits come back as plain data and
// the caller turns them into tracers, sounds and damage.
import { S, WEAPONS, KILL_MONEY } from './state.js';
import { rayWalls } from './map.js';
import { rnd, range } from './rng.js';

// Reused scratch — the hot fire path allocates nothing.
const _dir = { x: 0, y: 0, z: 0 };

export function spreadFor(a, w) {
  // Base spread, then multipliers: moving punishes, ADS + crouch + still reward.
  let s = w.spread + a.bloom;
  const speed = Math.hypot(a.vx, a.vz);
  s += w.moveSpread * Math.min(1, speed / 5);
  if (a.crouch) s *= 0.7;
  if (a.ads) s *= w.adsMul;
  if (!a.isPlayer) s *= 1.15; // bots are a touch looser than a still player
  return s;
}

export function canFire(a) {
  const w = currentWeaponOf(a);
  if (!w || !a.alive || a.reloading > 0) return false;
  const am = a.ammo[w.id];
  if (!am || am.mag <= 0) return false;
  return S.time >= a.nextShot;
}

export function currentWeaponOf(a) {
  if (a.slot === 1) return a.primary ? WEAPONS[a.primary] : null;
  if (a.slot === 2) return WEAPONS[a.sidearm];
  return null;
}

export function startReload(a) {
  const w = currentWeaponOf(a);
  if (!w || a.reloading > 0) return false;
  const am = a.ammo[w.id];
  if (!am || am.reserve <= 0 || am.mag >= w.mag) return false;
  a.reloading = w.reload;
  return true;
}

export function finishReload(a) {
  const w = currentWeaponOf(a);
  if (!w) return;
  const am = a.ammo[w.id];
  const need = w.mag - am.mag;
  const take = Math.min(need, am.reserve);
  am.mag += take; am.reserve -= take;
}

// Aim direction from yaw/pitch into _dir (yaw 0 faces -z, pitch up positive).
export function aimDir(a, out) {
  const cp = Math.cos(a.pitch);
  out.x = -Math.sin(a.yaw) * cp;
  out.y = Math.sin(a.pitch);
  out.z = -Math.cos(a.yaw) * cp;
  return out;
}

// Fire one hitscan shot from agent a. Returns a hit record (reused object)
// or null when the shot was not taken. The caller applies damage.
const _hit = { agent: null, head: false, dist: 0, x: 0, y: 0, z: 0, dmg: 0, wall: false };
export function fire(a) {
  const w = currentWeaponOf(a);
  if (!canFire(a)) return null;
  const am = a.ammo[w.id];
  am.mag--;
  a.nextShot = S.time + 60 / w.rpm;
  a.bloom = Math.min(0.05, a.bloom + w.recoil * 0.55);
  a.recoilPitch = Math.min(0.09, a.recoilPitch + w.recoil);
  a.flashT = 0.05;

  const eyeY = a.crouch ? 1.15 : 1.62;
  const spread = spreadFor(a, w);
  aimDir(a, _dir);
  // Cone jitter: two perpendicular offsets, gaussian-ish via summed uniforms.
  const jx = (rnd() + rnd() - 1) * spread, jy = (rnd() + rnd() - 1) * spread;
  const cx = -Math.cos(a.yaw), cz = Math.sin(a.yaw); // camera-right, planar
  _dir.x += cx * jx; _dir.z += cz * jx; _dir.y += jy;
  const dl = Math.hypot(_dir.x, _dir.y, _dir.z);
  _dir.x /= dl; _dir.y /= dl; _dir.z /= dl;

  // Nearest wall hit caps the shot.
  let bestT = rayWalls(a.x, eyeY, a.z, _dir.x, _dir.y, _dir.z);
  let victim = null, head = false;
  for (const b of S.agents) {
    if (b === a || !b.alive || b.team === a.team) continue;
    const t = rayAgent(a.x, eyeY, a.z, _dir.x, _dir.y, _dir.z, b);
    if (t >= 0 && t < bestT) {
      bestT = t; victim = b;
      head = rayHead(a.x, eyeY, a.z, _dir.x, _dir.y, _dir.z, b, t);
    }
  }
  _hit.agent = victim; _hit.head = head; _hit.dist = bestT;
  _hit.x = a.x + _dir.x * bestT; _hit.y = eyeY + _dir.y * bestT; _hit.z = a.z + _dir.z * bestT;
  _hit.wall = victim === null;
  if (victim) {
    const fall = bestT > w.range ? Math.max(0.45, 1 - (bestT - w.range) / w.range) : 1;
    _hit.dmg = Math.round(w.dmg * fall * (head ? w.headMul : 1));
  } else _hit.dmg = 0;
  return _hit;
}

// Ray vs agent body: torso cylinder (r 0.42, y 0..1.45) or head sphere.
// Returns distance, or -1 on a miss.
function rayAgent(ox, oy, oz, dx, dy, dz, b) {
  // Torso: 2D ray-circle in XZ, then check the y window at that t.
  const lx = b.x - ox, lz = b.z - oz;
  const proj = lx * dx + lz * dz;
  if (proj < 0) return -1;
  const cx = ox + dx * proj, cz = oz + dz * proj;
  const ddx = b.x - cx, ddz = b.z - cz;
  const r = 0.42, d2 = ddx * ddx + ddz * ddz;
  if (d2 > r * r) {
    // missed the torso — the head sphere may still catch it
    return raySphere(ox, oy, oz, dx, dy, dz, b.x, 1.58, b.z, 0.24);
  }
  const half = Math.sqrt(r * r - d2);
  const t = proj - half;
  if (t < 0) return -1;
  const y = oy + dy * t;
  if (y >= 0 && y <= 1.45) return t;
  return raySphere(ox, oy, oz, dx, dy, dz, b.x, 1.58, b.z, 0.24);
}
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const proj = lx * dx + ly * dy + lz * dz;
  if (proj < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - proj * proj;
  if (d2 > r * r) return -1;
  return proj - Math.sqrt(r * r - d2);
}
function rayHead(ox, oy, oz, dx, dy, dz, b, bodyT) {
  const ht = raySphere(ox, oy, oz, dx, dy, dz, b.x, 1.58, b.z, 0.24);
  return ht >= 0 && ht <= bodyT + 0.05;
}

// Apply damage with armour halving. Returns true if the victim died.
export function damage(victim, dmg, attacker, head) {
  if (!victim.alive) return false;
  let d = dmg;
  if (victim.armor > 0) {
    const absorbed = Math.min(victim.armor, Math.ceil(d * 0.5));
    victim.armor -= absorbed;
    d -= absorbed;
  }
  victim.hp -= d;
  if (attacker && victim.isPlayer) {
    victim.hurtDir = Math.atan2(attacker.x - victim.x, attacker.z - victim.z);
    victim.hurtT = 1.2;
  }
  if (victim.hp <= 0) {
    victim.hp = 0; victim.alive = false; victim.deaths++;
    victim.reloading = 0;
    if (attacker) {
      attacker.kills++;
      attacker.money += KILL_MONEY;
      if (attacker.isPlayer) S.roundKills++;
    }
    if (victim.carrying) dropCharge(victim);
    return true;
  }
  return false;
}

// Resolve a shot the caller just fired: tracer + impact data for the event
// queue, damage on the victim, hitmarker and kill notices. Both the player
// (sim.js) and bots (bots.js) resolve through this one function.
export function resolveShot(shooter, hit) {
  S.events.push({ type: 'shot', from: shooter, x: hit.x, y: hit.y, z: hit.z, wall: hit.wall });
  if (!hit.agent) return false;
  const died = damage(hit.agent, hit.dmg, shooter, hit.head);
  if (shooter.isPlayer) S.events.push({ type: 'hitmark', head: hit.head, died });
  if (died) {
    const w = currentWeaponOf(shooter);
    S.events.push({ type: 'kill', killer: shooter, victim: hit.agent, head: hit.head, weapon: w ? w.name : 'Frag' });
  }
  return died;
}

function dropCharge(a) {
  a.carrying = false;
  S.charge.state = 'dropped';
  S.charge.x = a.x; S.charge.z = a.z; S.charge.carrier = null;
  S.events.push({ type: 'chargeDropped', x: a.x, z: a.z });
}

// ---- grenades -----------------------------------------------------------
// A grenade is a small ballistic body: {kind, x,y,z, vx,vy,vz, fuse, owner}.
// Frag explodes on fuse (110 dmg in 6 m, falling off); smoke pops a cloud.
export function throwGrenade(a, kind) {
  if (kind === 'frag' && a.frag <= 0) return false;
  if (kind === 'smoke' && a.smoke <= 0) return false;
  if (kind === 'frag') a.frag--; else a.smoke--;
  aimDir(a, _dir);
  const eyeY = a.crouch ? 1.15 : 1.62;
  S.grenades.push({
    kind, owner: a,
    x: a.x + _dir.x * 0.6, y: eyeY, z: a.z + _dir.z * 0.6,
    vx: _dir.x * 13 + a.vx * 0.5, vy: _dir.y * 13 + 4.5, vz: _dir.z * 13 + a.vz * 0.5,
    fuse: kind === 'frag' ? 1.6 : 1.1,
  });
  S.events.push({ type: 'throw', agent: a, kind });
  return true;
}

export function stepGrenades(dt) {
  for (let i = S.grenades.length - 1; i >= 0; i--) {
    const g = S.grenades[i];
    g.vy -= 18 * dt;
    g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
    if (g.y < 0.15) { g.y = 0.15; g.vy = -g.vy * 0.35; g.vx *= 0.6; g.vz *= 0.6; }
    g.fuse -= dt;
    if (g.fuse <= 0) {
      S.grenades.splice(i, 1);
      if (g.kind === 'frag') explodeFrag(g);
      else {
        S.smokes.push({ x: g.x, z: g.z, t: 12 });
        S.events.push({ type: 'smoke', x: g.x, z: g.z });
      }
    }
  }
  for (let i = S.smokes.length - 1; i >= 0; i--) {
    S.smokes[i].t -= dt;
    if (S.smokes[i].t <= 0) S.smokes.splice(i, 1);
  }
}

function explodeFrag(g) {
  S.events.push({ type: 'explosion', x: g.x, z: g.z });
  for (const a of S.agents) {
    if (!a.alive) continue;
    const dx = a.x - g.x, dz = a.z - g.z;
    const d = Math.hypot(dx, dz);
    if (d < 6.5) {
      const dmg = Math.round(110 * (1 - d / 6.5) + 15);
      const died = damage(a, dmg, g.owner, false);
      if (died) S.events.push({ type: 'kill', killer: g.owner, victim: a, head: false, weapon: 'Frag' });
    }
  }
}

// Is the segment between two points smoked? Bots treat smoke as opaque.
export function smokedBetween(x0, z0, x1, z1) {
  for (const s of S.smokes) {
    // distance from smoke centre to the segment
    const dx = x1 - x0, dz = z1 - z0;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((s.x - x0) * dx + (s.z - z0) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = x0 + dx * t, pz = z0 + dz * t;
    if (Math.hypot(s.x - px, s.z - pz) < 3.2) return true;
  }
  return false;
}
