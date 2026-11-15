// state.js — the single source of truth. ALL mutable game state lives in the
// one exported object S. No other module keeps its own copy of match state;
// modules read S, and the fixed-step sim (sim.js) is the only writer of
// gameplay fields. Constants (weapons, teams, tuning) live here too so the
// whole game balances from one file.
import { reseed } from './rng.js';

export const ROUND_TIME = 100;    // seconds per round
export const BUY_TIME = 12;       // buy phase at the start of each round
export const PLANT_TIME = 3.5;    // seconds holding E to plant the charge
export const DEFUSE_TIME = 5;     // seconds holding E to defuse (3.5 with kit)
export const BOMB_TIME = 35;      // seconds from plant to detonation
export const WIN_SCORE = 7;       // first team to 7 round wins takes the match
export const MAX_ROUNDS = 12;
export const START_MONEY = 800;
export const KILL_MONEY = 300;
export const WIN_MONEY = 3250;
export const LOSS_MONEY = 1400;

export const TEAMS = {
  NW: { id: 'NW', name: 'NIGHTWATCH', role: 'DEFENDERS', color: 0x38bdf8, css: '#38bdf8', dark: '#0c4a6e' },
  DB: { id: 'DB', name: 'DAYBREAK', role: 'ATTACKERS', color: 0xfbbf24, css: '#fbbf24', dark: '#78350f' },
};

// Weapon table. dmg is body damage at close range; headshots multiply x4.
// spread is radians of cone half-angle at rest; moving/ADS scale it.
export const WEAPONS = {
  p9:      { id: 'p9', name: 'P9 Sidearm', slot: 2, price: 0,    dmg: 26, headMul: 4, rpm: 340, auto: false, mag: 12, reserve: 48,  reload: 1.3, spread: 0.011, moveSpread: 0.030, recoil: 0.011, range: 45,  adsMul: 0.45 },
  vk47:    { id: 'vk47', name: 'VK-47 Carbine', slot: 1, price: 2700, dmg: 30, headMul: 4, rpm: 600, auto: true,  mag: 25, reserve: 100, reload: 2.2, spread: 0.013, moveSpread: 0.042, recoil: 0.019, range: 70,  adsMul: 0.40 },
  kestrel: { id: 'kestrel', name: 'Kestrel SMG', slot: 1, price: 1200, dmg: 22, headMul: 4, rpm: 820, auto: true,  mag: 30, reserve: 120, reload: 1.9, spread: 0.020, moveSpread: 0.036, recoil: 0.013, range: 38,  adsMul: 0.50 },
  longbow: { id: 'longbow', name: 'Longbow DMR', slot: 1, price: 4500, dmg: 74, headMul: 4, rpm: 95,  auto: false, mag: 5,  reserve: 20,  reload: 2.8, spread: 0.003, moveSpread: 0.055, recoil: 0.052, range: 130, adsMul: 0.25 },
};
export const WEAPON_LIST = [WEAPONS.vk47, WEAPONS.kestrel, WEAPONS.p9, WEAPONS.longbow];

export const SHOP = [
  { id: 'vk47', kind: 'gun', name: 'VK-47 Carbine', price: 2700, blurb: 'Auto rifle. The workhorse.' },
  { id: 'kestrel', kind: 'gun', name: 'Kestrel SMG', price: 1200, blurb: 'Fast, close, hungry.' },
  { id: 'longbow', kind: 'gun', name: 'Longbow DMR', price: 4500, blurb: 'One shot, long lane.' },
  { id: 'frag', kind: 'grenade', name: 'Frag Grenade', price: 300, blurb: '110 damage in 6 m. Key 3.' },
  { id: 'smoke', kind: 'grenade', name: 'Smoke Grenade', price: 250, blurb: 'Blocks sight for 12 s. Key 4.' },
  { id: 'armor', kind: 'gear', name: 'Plate + Helm', price: 650, blurb: 'Halves damage taken.' },
  { id: 'kit', kind: 'gear', name: 'Defuse Kit', price: 400, blurb: 'Defenders: defuse in 3.5 s.' },
];

export const BOT_NAMES = {
  NW: ['Vega', 'Onyx', 'Sable', 'Rook', 'Mira'],
  DB: ['Juno', 'Ash', 'Koda', 'Pip'],
};

export const SITES = {
  A: { id: 'A', name: 'DISH A', x: -24, z: -14, r: 6.5 },
  B: { id: 'B', name: 'DOME B', x: 24, z: -14, r: 6.5 },
};

// One agent = one fighter. The player is an agent with isPlayer set; bots
// differ only by having an ai brain object instead of input.
export function makeAgent(id, name, team, isPlayer) {
  return {
    id, name, team, isPlayer,
    x: 0, z: 0, y: 0, vy: 0, yaw: 0, pitch: 0, // position + jump state + view angles
    vx: 0, vz: 0,                            // planar velocity (m/s)
    hp: 100, armor: 0, alive: true,
    crouch: false, moving: false, ads: false,
    money: START_MONEY, kills: 0, deaths: 0, assists: 0,
    primary: null, sidearm: 'p9',            // owned weapon ids
    frag: 0, smoke: 0, kit: false,
    slot: 2,                                 // active loadout slot 1..5
    ammo: {},                                // weaponId -> { mag, reserve }
    reloading: 0,                            // seconds left, 0 = not reloading
    nextShot: 0,                             // sim-time gate for fire rate
    bloom: 0,                                // accumulated spread from firing
    recoilPitch: 0,                          // visual kick, recovers over time
    carrying: false,                         // holds the Uplink Charge
    plantT: 0, defuseT: 0,                   // hold-E progress seconds
    flashT: 0,                               // muzzle-flash timer (render)
    hurtDir: -1, hurtT: 0,                   // damage indicator (render)
    ai: isPlayer ? null : {
      state: 'route', wp: 0, route: [], holdT: 0, target: null,
      lastSeen: 0, seenX: 0, seenZ: 0, reactT: 0, burst: 0,
      site: 'A', strafeDir: 1, strafeT: 0, alertX: 0, alertZ: 0, alertT: 0,
    },
  };
}

export function giveWeapon(a, wid) {
  const w = WEAPONS[wid];
  a.ammo[wid] = { mag: w.mag, reserve: w.reserve };
  if (w.slot === 1) a.primary = wid; else a.sidearm = wid;
}

export function currentWeapon(a) {
  if (a.slot === 1) return a.primary ? WEAPONS[a.primary] : null;
  if (a.slot === 2) return WEAPONS[a.sidearm];
  return null; // slots 3/4 grenades, 5 charge — no firearm
}

// The state. resetMatch() rebuilds it in place for a fresh match.
export const S = {
  seed: 1, time: 0,                        // sim clock (seconds, fixed-step)
  phase: 'menu',                           // menu | buy | live | roundEnd | matchEnd
  round: 1, score: { NW: 0, DB: 0 },
  timeLeft: ROUND_TIME, buyLeft: BUY_TIME, endT: 0,
  lossStreak: { NW: 0, DB: 0 },
  agents: [], player: null,
  charge: { state: 'carried', site: null, x: 0, z: 0, timer: 0, carrier: null },
  grenades: [], smokes: [],                // live projectiles / smoke clouds
  feed: [],                                // kill feed entries {text, cls, t}
  events: [],                              // one-frame notices for HUD/audio
  banner: null,                            // {title, sub, cls, t}
  buyOpen: false, scoreOpen: false, muted: false,
  shot: null,                              // ?shot= staging mode or null
  roundKills: 0,
};

export function resetMatch(seed) {
  reseed(seed);
  S.seed = seed; S.time = 0; S.phase = 'buy'; S.round = 1;
  S.score.NW = 0; S.score.DB = 0;
  S.timeLeft = ROUND_TIME; S.buyLeft = BUY_TIME; S.endT = 0;
  S.lossStreak.NW = 0; S.lossStreak.DB = 0;
  S.agents.length = 0; S.grenades.length = 0; S.smokes.length = 0;
  S.feed.length = 0; S.events.length = 0;
  S.banner = null; S.buyOpen = false; S.scoreOpen = false; S.roundKills = 0;
  S.charge.state = 'carried'; S.charge.site = null; S.charge.timer = 0;
  const p = makeAgent('p0', 'You', 'DB', true);
  S.player = p; S.agents.push(p);
  for (const n of BOT_NAMES.DB) S.agents.push(makeAgent('db' + n, n, 'DB', false));
  for (const n of BOT_NAMES.NW) S.agents.push(makeAgent('nw' + n, n, 'NW', false));
  for (const a of S.agents) {
    giveWeapon(a, 'p9');
    a.money = START_MONEY; a.kills = 0; a.deaths = 0;
  }
  p.carrying = true; S.charge.carrier = p; // player carries the charge, round 1
}
