// rounds.js — one job: the match flow. Round setup (spawns, bot plans,
// starting gear), the buy phase, plant/defuse completion, win detection
// (elimination / detonation / defuse / timeout), money payouts, and the
// match end. It never draws anything — it pushes events and banners that
// the HUD reads.
import { S, TEAMS, WEAPONS, giveWeapon, WIN_MONEY, LOSS_MONEY, ROUND_TIME, BUY_TIME, PLANT_TIME, DEFUSE_TIME, BOMB_TIME, WIN_SCORE, MAX_ROUNDS, SITES, SHOP } from './state.js';
import { SPAWNS } from './map.js';
import { planRound, assignBot } from './bots.js';
import { pick, chance } from './rng.js';
import { sfx } from './audio.js';

export function startRound() {
  const p = S.player;
  S.phase = 'buy';
  S.timeLeft = ROUND_TIME; S.buyLeft = BUY_TIME;
  S.grenades.length = 0; S.smokes.length = 0;
  S.charge.state = 'carried'; S.charge.site = null; S.charge.timer = 0;
  S.roundKills = 0;
  // Pick the attackers' target site; the carrier is the player on odd
  // rounds, a random teammate on even ones, so both paths get exercised.
  const site = pick(['A', 'B']);
  planRound(site);
  let dbIdx = 0, nwIdx = 0;
  for (const a of S.agents) {
    a.hp = 100; a.alive = true; a.reloading = 0; a.bloom = 0;
    a.plantT = 0; a.defuseT = 0; a.carrying = false;
    a.vx = 0; a.vz = 0; a.crouch = false; a.ads = false;
    a.slot = a.primary ? 1 : 2;
    const sp = a.team === 'DB' ? SPAWNS.DB[dbIdx++] : SPAWNS.NW[nwIdx++];
    a.x = sp[0]; a.z = sp[1];
    a.yaw = a.team === 'DB' ? 0 : Math.PI; // attackers face north, defenders south
    a.pitch = 0;
    // Bots buy for themselves: rifle if rich, SMG if middling, else pistol.
    if (!a.isPlayer) {
      if (a.money >= 2700 && chance(0.7)) buyFor(a, 'vk47');
      else if (a.money >= 1200 && chance(0.5)) buyFor(a, 'kestrel');
      if (a.money >= 650 && chance(0.4)) buyFor(a, 'armor');
      if (a.team === 'NW' && a.money >= 400 && chance(0.5)) buyFor(a, 'kit');
      if (a.money >= 250 && chance(0.3)) buyFor(a, 'smoke');
      assignBot(a, a.team === 'DB' ? dbIdx - 1 : nwIdx - 1);
    }
  }
  const attackers = S.agents.filter((a) => a.team === 'DB');
  const carrier = S.round % 2 === 1 ? p : pick(attackers.slice(1));
  carrier.carrying = true;
  S.charge.carrier = carrier;
  S.banner = { title: 'ROUND ' + S.round, sub: 'Target: ' + (site === 'A' ? 'DISH A' : 'DOME B') + ' — ' + carrier.name + ' carries the Uplink Charge', cls: 'info', t: 3 };
  S.events.push({ type: 'roundStart', round: S.round, site });
}

function buyFor(a, id) {
  const item = SHOP.find((s) => s.id === id);
  if (!item || a.money < item.price) return false;
  a.money -= item.price;
  applyPurchase(a, id);
  return true;
}

export function applyPurchase(a, id) {
  if (id === 'frag') { if (a.frag < 2) a.frag++; else return false; }
  else if (id === 'smoke') { if (a.smoke < 2) a.smoke++; else return false; }
  else if (id === 'armor') a.armor = 100;
  else if (id === 'kit') a.kit = true;
  else {
    giveWeapon(a, id);
    a.slot = WEAPONS[id].slot;
  }
  return true;
}

// Player-facing buy: validates funds and buy-phase, returns a status string.
export function buyItem(a, id) {
  if (S.phase !== 'buy') return 'Buy phase is over';
  const item = SHOP.find((s) => s.id === id);
  if (!item) return 'Unknown item';
  if (id === 'kit' && a.team !== 'NW') return 'Defuse kits are for defenders';
  if (a.money < item.price) { sfx.denied(); return 'Not enough money'; }
  if ((id === 'frag' && a.frag >= 2) || (id === 'smoke' && a.smoke >= 2)) return 'Carrying max grenades';
  a.money -= item.price;
  applyPurchase(a, id);
  sfx.buy();
  return null;
}

export function stepRounds(dt) {
  if (S.phase === 'buy') {
    S.buyLeft -= dt;
    if (S.buyLeft <= 0) {
      S.phase = 'live';
      S.buyOpen = false;
      S.events.push({ type: 'live' });
    }
    return;
  }
  if (S.phase !== 'live') {
    if (S.phase === 'roundEnd') {
      S.endT -= dt;
      if (S.endT <= 0) {
        if (S.score.NW >= WIN_SCORE || S.score.DB >= WIN_SCORE || S.round >= MAX_ROUNDS) endMatch();
        else { S.round++; startRound(); }
      }
    }
    return;
  }

  // Round clock.
  S.timeLeft -= dt;
  if (S.timeLeft <= 0 && S.charge.state !== 'planted') {
    endRound('NW', 'TIME EXPIRED — NIGHTWATCH HOLDS');
    return;
  }

  // Plant / defuse completion.
  for (const a of S.agents) {
    if (!a.alive) continue;
    if (a.plantT >= PLANT_TIME && a.carrying && S.charge.state === 'carried') {
      completePlant(a);
    }
    const need = a.kit ? 3.5 : DEFUSE_TIME;
    if (a.defuseT >= need && S.charge.state === 'planted') {
      completeDefuse(a);
      return;
    }
  }

  // Planted charge countdown.
  if (S.charge.state === 'planted') {
    S.charge.timer -= dt;
    if (Math.ceil(S.charge.timer) !== Math.ceil(S.charge.timer + dt)) {
      S.events.push({ type: 'beep', urgent: S.charge.timer < 10 });
    }
    if (S.charge.timer <= 0) {
      S.charge.state = 'detonated';
      S.events.push({ type: 'explosion', x: S.charge.x, z: S.charge.z, big: true });
      endRound('DB', 'CHARGE DETONATED — DAYBREAK TAKES THE SITE');
      return;
    }
  }

  // Elimination check.
  const dbAlive = S.agents.some((a) => a.team === 'DB' && a.alive);
  const nwAlive = S.agents.some((a) => a.team === 'NW' && a.alive);
  if (!dbAlive && S.charge.state !== 'planted') endRound('NW', 'DAYBREAK ELIMINATED');
  else if (!nwAlive && S.charge.state !== 'planted') endRound('DB', 'NIGHTWATCH ELIMINATED');
  else if (!nwAlive && S.charge.state === 'planted') {
    // No defenders left to defuse: the charge will go off.
    endRound('DB', 'NO DEFENDERS LEFT — CHARGE WILL DETONATE');
  }
}

function completePlant(a) {
  const site = inSite(a);
  if (!site) { a.plantT = 0; return; }
  S.charge.state = 'planted';
  S.charge.site = site;
  S.charge.x = a.x; S.charge.z = a.z;
  S.charge.timer = BOMB_TIME;
  a.carrying = false; a.plantT = 0;
  S.timeLeft = Math.max(S.timeLeft, BOMB_TIME + 2);
  S.events.push({ type: 'planted', agent: a, site });
  sfx.plantBeep(true);
}

function completeDefuse(a) {
  S.charge.state = 'defused';
  a.defuseT = 0;
  S.events.push({ type: 'defused', agent: a });
  endRound('NW', 'CHARGE DEFUSED — NIGHTWATCH HOLDS');
}

export function inSite(a) {
  for (const key of ['A', 'B']) {
    const s = SITES[key];
    if (Math.hypot(a.x - s.x, a.z - s.z) < s.r) return key;
  }
  return null;
}

function endRound(winner, reason) {
  S.phase = 'roundEnd';
  S.endT = 4;
  S.score[winner]++;
  const loser = winner === 'NW' ? 'DB' : 'NW';
  S.lossStreak[winner] = 0;
  S.lossStreak[loser]++;
  const lossBonus = Math.min(3400, LOSS_MONEY + 500 * (S.lossStreak[loser] - 1));
  for (const a of S.agents) {
    a.money += a.team === winner ? WIN_MONEY : lossBonus;
    a.money = Math.min(a.money, 16000);
  }
  const playerWon = winner === S.player.team;
  S.banner = {
    title: playerWon ? 'ROUND WON' : 'ROUND LOST',
    sub: reason + ' — ' + TEAMS.NW.name + ' ' + S.score.NW + ' : ' + S.score.DB + ' ' + TEAMS.DB.name,
    cls: playerWon ? 'win' : 'lose', t: 4,
  };
  S.events.push({ type: 'roundEnd', winner, reason });
  if (playerWon) sfx.roundWin(); else sfx.roundLose();
}

function endMatch() {
  S.phase = 'matchEnd';
  const winner = S.score.DB > S.score.NW ? 'DB' : S.score.NW > S.score.DB ? 'NW' : null;
  S.banner = {
    title: winner === null ? 'MATCH DRAW' : winner === S.player.team ? 'VICTORY — DAYBREAK WINS' : 'DEFEAT — NIGHTWATCH WINS',
    sub: 'Final score ' + TEAMS.NW.name + ' ' + S.score.NW + ' : ' + S.score.DB + ' ' + TEAMS.DB.name,
    cls: winner === S.player.team ? 'win' : winner === null ? 'info' : 'lose', t: 999,
  };
  S.events.push({ type: 'matchEnd', winner });
}
