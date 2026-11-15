// hud.js — one job: everything drawn in DOM. Score bar, minimap canvas,
// kill feed, health/ammo blocks, crosshair, banners, start / buy /
// scoreboard / end screens, in-world name tags and the plant/defuse
// prompt. It reads S and the event queue each frame; it never simulates.
import * as THREE from 'three';
import { S, TEAMS, WEAPONS, SHOP, SITES } from './state.js';
import { WALLS, BOUNDS, losBlocked } from './map.js';
import { currentWeaponOf, smokedBetween } from './weapons.js';
import { buyItem } from './rounds.js';

const $ = (id) => document.getElementById(id);
let els = {};
let mmCtx = null;
const _pv = new THREE.Vector3(); // reused projection scratch

export function bindHud(callbacks) {
  els = {
    start: $('start-screen'), playBtn: $('play-btn'),
    hud: $('hud'), scorebar: $('scorebar'),
    teamNW: $('team-nw'), teamDB: $('team-db'),
    pipsNW: $('pips-nw'), pipsDB: $('pips-db'),
    roundLabel: $('round-label'), timer: $('timer'), phaseLabel: $('phase-label'),
    minimap: $('minimap'), mmLabel: $('mm-label'),
    feed: $('killfeed'), health: $('health-num'), armor: $('armor-num'),
    money: $('money-num'), hpBar: $('hp-bar'), armorBar: $('armor-bar'),
    weaponName: $('weapon-name'), ammoMag: $('ammo-mag'), ammoRes: $('ammo-res'),
    slots: $('slots'), cross: $('crosshair'),
    banner: $('banner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
    prompt: $('prompt'), promptFill: $('prompt-fill'), promptText: $('prompt-text'),
    buy: $('buy-menu'), buyGrid: $('buy-grid'), buyMoney: $('buy-money'),
    scoreboard: $('scoreboard'), scoreRows: $('score-rows'),
    endScreen: $('end-screen'), endTitle: $('end-title'), endSub: $('end-sub'),
    vignette: $('vignette'), hitmarker: $('hitmarker'), dmgDir: $('dmg-dir'),
    tags: $('nametags'), chat: $('bot-chat'), mute: $('mute-label'),
  };
  mmCtx = els.minimap.getContext('2d');
  els.playBtn.addEventListener('click', callbacks.onPlay);
  $('restart-btn').addEventListener('click', callbacks.onRestart);
  $('buy-close').addEventListener('click', () => { S.buyOpen = false; });
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-buy]');
    if (!btn) return;
    const msg = buyItem(S.player, btn.dataset.buy);
    if (msg) flashBuyMsg(msg);
    renderBuy();
  });
  buildBuyMenu();
}

function buildBuyMenu() {
  els.buyGrid.innerHTML = '';
  for (const item of SHOP) {
    const d = document.createElement('div');
    d.className = 'buy-item';
    d.innerHTML = '<div class="buy-name">' + item.name + '</div>' +
      '<div class="buy-blurb">' + item.blurb + '</div>' +
      '<button data-buy="' + item.id + '">$' + item.price + '</button>';
    els.buyGrid.appendChild(d);
  }
}
function flashBuyMsg(msg) {
  els.buyMoney.textContent = msg;
  els.buyMoney.classList.add('err');
  setTimeout(() => els.buyMoney.classList.remove('err'), 900);
}
export function renderBuy() {
  if (!els.buyMoney) return;
  els.buyMoney.textContent = 'Funds: $' + S.player.money + ' — click to buy, B or Esc to close';
}

// ---- per-frame update ----------------------------------------------------
let _lastFeedLen = 0, _hitT = 0, _lastHp = 100;
export function updateHud(dt, camera) {
  const p = S.player;
  const inGame = S.phase !== 'menu';
  els.hud.style.display = inGame ? 'block' : 'none';
  els.start.style.display = S.phase === 'menu' ? 'flex' : 'none';
  els.endScreen.style.display = S.phase === 'matchEnd' ? 'flex' : 'none';
  if (S.phase === 'matchEnd') {
    els.endTitle.textContent = S.banner ? S.banner.title : '';
    els.endSub.textContent = S.banner ? S.banner.sub : '';
  }

  // Score bar: names, pips, round, timer.
  els.teamNW.textContent = TEAMS.NW.name;
  els.teamDB.textContent = TEAMS.DB.name;
  setPips(els.pipsNW, S.score.NW);
  setPips(els.pipsDB, S.score.DB);
  els.roundLabel.textContent = 'ROUND ' + S.round + ' / 12';
  const t = S.phase === 'buy' ? S.buyLeft : S.charge.state === 'planted' ? S.charge.timer : S.timeLeft;
  els.timer.textContent = fmtTime(Math.max(0, t));
  els.timer.classList.toggle('urgent', t < 15 && S.phase === 'live');
  els.phaseLabel.textContent = S.phase === 'buy' ? 'BUY PHASE — press B' :
    S.charge.state === 'planted' ? 'CHARGE ARMED AT SITE ' + S.charge.site : TEAMS[p.team].role;

  // Health / armour / money.
  els.health.textContent = Math.max(0, p.hp);
  els.armor.textContent = p.armor;
  els.money.textContent = '$' + p.money;
  els.hpBar.style.width = Math.max(0, p.hp) + '%';
  els.armorBar.style.width = p.armor + '%';
  els.hpBar.className = 'bar-fill ' + (p.hp > 50 ? 'ok' : p.hp > 25 ? 'warn' : 'crit');
  if (p.hp < _lastHp) {
    els.vignette.style.opacity = '0.85';
    setTimeout(() => { els.vignette.style.opacity = '0'; }, 260);
  }
  _lastHp = p.hp;

  // Weapon block + loadout slots.
  const w = currentWeaponOf(p);
  if (p.slot === 3) els.weaponName.textContent = 'Frag Grenade ×' + p.frag;
  else if (p.slot === 4) els.weaponName.textContent = 'Smoke Grenade ×' + p.smoke;
  else if (p.slot === 5) els.weaponName.textContent = 'Uplink Charge';
  else els.weaponName.textContent = w ? w.name : '—';
  if (w && p.slot <= 2) {
    const am = p.ammo[w.id];
    els.ammoMag.textContent = p.reloading > 0 ? 'RELOADING' : am.mag;
    els.ammoRes.textContent = '/ ' + am.reserve;
    els.ammoMag.classList.toggle('low', am.mag <= Math.ceil(w.mag * 0.25));
  } else {
    els.ammoMag.textContent = p.slot === 5 ? 'E TO PLANT' : 'CLICK TO THROW';
    els.ammoRes.textContent = '';
    els.ammoMag.classList.remove('low');
  }
  renderSlots(p);

  // Crosshair: gap grows with spread (move/fire), shrinks on ADS/crouch.
  const spreadPx = 5 + (p.bloom * 500) + (p.moving ? 7 : 0) + (p.ads ? -3 : 0);
  els.cross.style.setProperty('--gap', Math.max(3, spreadPx) + 'px');
  els.cross.classList.toggle('ads', p.ads);
  els.cross.style.display = p.alive && S.phase === 'live' ? 'block' : 'none';

  // Damage direction indicator.
  if (p.hurtT > 0) {
    const rel = p.hurtDir - (p.yaw + Math.PI);
    els.dmgDir.style.transform = 'rotate(' + rel + 'rad)';
    els.dmgDir.style.opacity = Math.min(1, p.hurtT);
  } else els.dmgDir.style.opacity = '0';

  // Hitmarker fade.
  _hitT = Math.max(0, _hitT - dt);
  els.hitmarker.style.opacity = _hitT > 0 ? '1' : '0';

  // Banner.
  if (S.banner && S.banner.t > 0) {
    els.banner.style.display = 'block';
    els.bannerTitle.textContent = S.banner.title;
    els.bannerSub.textContent = S.banner.sub;
    els.banner.className = 'show ' + S.banner.cls;
    S.banner.t -= dt;
  } else els.banner.style.display = 'none';

  // Buy menu + scoreboard visibility.
  els.buy.style.display = S.buyOpen && S.phase === 'buy' ? 'block' : 'none';
  if (S.buyOpen) renderBuy();
  els.scoreboard.style.display = S.scoreOpen ? 'block' : 'none';
  if (S.scoreOpen) renderScoreboard();

  // Kill feed: entries expire on SIM time (8 s), not wall-clock time, so a
  // slow first paint cannot clear the feed before a screenshot.
  while (_lastFeedLen < S.feed.length) {
    const f = S.feed[_lastFeedLen++];
    const d = document.createElement('div');
    d.className = 'feed-item ' + (f.cls || '');
    d.textContent = f.text;
    d.dataset.t = String(f.t);
    els.feed.prepend(d);
    while (els.feed.children.length > 5) els.feed.removeChild(els.feed.lastChild);
  }
  for (let i = els.feed.children.length - 1; i >= 0; i--) {
    const d = els.feed.children[i];
    if (S.time - parseFloat(d.dataset.t || '0') > 8) els.feed.removeChild(d);
  }

  els.mute.textContent = S.muted ? 'MUTED (M)' : 'M — mute';
  drawMinimap();
  updateTags(camera);
  updatePrompt();
}

function setPips(el, n) {
  let html = '';
  for (let i = 0; i < 7; i++) html += '<span class="pip' + (i < n ? ' on' : '') + '"></span>';
  if (el.dataset.n !== String(n)) { el.innerHTML = html; el.dataset.n = String(n); }
}

function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function renderSlots(p) {
  const primary = p.primary ? WEAPONS[p.primary].name.split(' ')[0] : '—';
  const defs = [
    [1, primary],
    [2, 'P9'],
    [3, 'Frag' + (p.frag ? ' ×' + p.frag : '')],
    [4, 'Smoke' + (p.smoke ? ' ×' + p.smoke : '')],
    [5, p.carrying ? 'CHARGE' : '—'],
  ];
  let html = '';
  for (const [n, label] of defs) {
    html += '<span class="slot' + (p.slot === n ? ' active' : '') + '">' + n + ' ' + label + '</span>';
  }
  if (els.slots.dataset.h !== html) { els.slots.innerHTML = html; els.slots.dataset.h = html; }
}

function renderScoreboard() {
  const rows = [...S.agents].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  let html = '<div class="sb-head"><span>Player</span><span>Team</span><span>K</span><span>D</span><span>$</span></div>';
  for (const a of rows) {
    html += '<div class="sb-row' + (a.isPlayer ? ' me' : '') + '"><span>' + a.name + (a.carrying ? ' ◉' : '') + '</span>' +
      '<span style="color:' + TEAMS[a.team].css + '">' + TEAMS[a.team].name + '</span>' +
      '<span>' + a.kills + '</span><span>' + a.deaths + '</span><span>$' + a.money + '</span></div>';
  }
  els.scoreRows.innerHTML = html;
}

function updatePrompt() {
  const p = S.player;
  let text = '', fill = 0, show = false;
  if (p.alive && S.phase === 'live') {
    if (p.carrying && S.charge.state === 'carried') {
      const site = inSiteOf(p);
      if (site) { show = true; text = 'HOLD E — PLANT THE CHARGE AT SITE ' + site; fill = p.plantT / 3.5; }
      else { show = true; text = 'You carry the Uplink Charge — reach Site A or B'; }
    } else if (S.charge.state === 'planted' && p.team === 'NW') {
      const d = Math.hypot(p.x - S.charge.x, p.z - S.charge.z);
      if (d < 2.5) { show = true; text = 'HOLD E — DEFUSE THE CHARGE'; fill = p.defuseT / (p.kit ? 3.5 : 5); }
    } else if (S.charge.state === 'dropped' && p.team === 'DB') {
      const d = Math.hypot(p.x - S.charge.x, p.z - S.charge.z);
      if (d < 1.6) { show = true; text = 'WALK OVER THE CHARGE TO PICK IT UP'; }
    }
  }
  els.prompt.style.display = show ? 'block' : 'none';
  if (show) {
    els.promptText.textContent = text;
    els.promptFill.style.width = Math.min(100, fill * 100) + '%';
  }
}

function inSiteOf(p) {
  for (const key of ['A', 'B']) {
    const s = SITES[key];
    if (Math.hypot(p.x - s.x, p.z - s.z) < s.r) return key;
  }
  return null;
}

// ---- minimap -------------------------------------------------------------
function drawMinimap() {
  const c = mmCtx, W = 190, H = 150;
  c.clearRect(0, 0, W, H);
  c.fillStyle = 'rgba(10,14,28,0.85)';
  c.fillRect(0, 0, W, H);
  const sx = (x) => ((x - BOUNDS.x0) / (BOUNDS.x1 - BOUNDS.x0)) * W;
  const sz = (z) => ((z - BOUNDS.z0) / (BOUNDS.z1 - BOUNDS.z0)) * H;
  c.fillStyle = '#3d4560';
  for (const w of WALLS) {
    if (w[4] < 1.5) continue;
    c.fillRect(sx(w[0]), sz(w[1]), Math.max(1, sx(w[2]) - sx(w[0])), Math.max(1, sz(w[3]) - sz(w[1])));
  }
  for (const key of ['A', 'B']) {
    const s = SITES[key];
    c.strokeStyle = S.charge.site === key && S.charge.state === 'planted' ? '#ff4444' : '#f59e0b';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(sx(s.x), sz(s.z), 8, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#fcd34d'; c.font = 'bold 11px sans-serif'; c.textAlign = 'center';
    c.fillText(key, sx(s.x), sz(s.z) + 4);
  }
  for (const a of S.agents) {
    if (!a.alive) continue;
    const x = sx(a.x), y = sz(a.z);
    if (a.isPlayer) {
      // player arrow, rotated by yaw
      c.save();
      c.translate(x, y); c.rotate(-a.yaw + Math.PI);
      c.fillStyle = '#ffffff';
      c.beginPath(); c.moveTo(0, -6); c.lineTo(4, 5); c.lineTo(-4, 5); c.closePath(); c.fill();
      c.restore();
    } else {
      c.fillStyle = TEAMS[a.team].css;
      c.beginPath(); c.arc(x, y, 3.2, 0, Math.PI * 2); c.fill();
      if (a.carrying) { c.strokeStyle = '#22d3ee'; c.lineWidth = 2; c.beginPath(); c.arc(x, y, 5.5, 0, Math.PI * 2); c.stroke(); }
    }
  }
  // Zone label under the minimap: where the player stands.
  const p = S.player;
  const site = inSiteOf(p);
  els.mmLabel.textContent = site ? 'SITE ' + site + (site === 'A' ? ' — DISH' : ' — DOME')
    : p.z > 18 ? 'DAYBREAK SPAWN' : p.z < -22 ? 'NIGHTWATCH HILL'
    : Math.abs(p.x) < 8 ? 'MID CAUSEWAY' : p.x < 0 ? 'WEST RIDGE' : 'EAST SERVICE ROAD';
}

// ---- name tags -----------------------------------------------------------
// One pooled div per bot, projected from 3D each frame; hidden when the bot
// is dead, behind the camera, or an enemy further than 40 m.
const tagPool = new Map();
export function updateTags(camera) {
  const W = window.innerWidth, H = window.innerHeight;
  for (const a of S.agents) {
    if (a.isPlayer) continue;
    let tag = tagPool.get(a.id);
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'nametag';
      els.tags.appendChild(tag);
      tagPool.set(a.id, tag);
    }
    if (!a.alive || S.phase === 'menu') { tag.style.display = 'none'; continue; }
    _pv.set(a.x, 2.05, a.z).project(camera);
    if (_pv.z > 1) { tag.style.display = 'none'; continue; }
    const dist = Math.hypot(a.x - S.player.x, a.z - S.player.z);
    if (a.team !== S.player.team) {
      // Enemy tags only when the bot is actually visible: in range, in
      // line of sight, and not behind smoke. Teammates always show.
      if (dist > 40) { tag.style.display = 'none'; continue; }
      if (losBlocked(S.player.x, S.player.z, a.x, a.z)) { tag.style.display = 'none'; continue; }
      if (smokedBetween(S.player.x, S.player.z, a.x, a.z)) { tag.style.display = 'none'; continue; }
    }
    const x = (_pv.x * 0.5 + 0.5) * W, y = (-_pv.y * 0.5 + 0.5) * H;
    tag.style.display = 'block';
    tag.style.transform = 'translate(-50%,-100%) translate(' + x.toFixed(0) + 'px,' + y.toFixed(0) + 'px)';
    tag.style.color = TEAMS[a.team].css;
    tag.textContent = a.name + (a.carrying ? ' ◉' : '');
  }
}

export function showHitmarker(head) {
  _hitT = 0.18;
  els.hitmarker.className = head ? 'show head' : 'show';
}

export function botSay(text) {
  const d = document.createElement('div');
  d.className = 'chat-line';
  d.textContent = text;
  els.chat.prepend(d);
  while (els.chat.children.length > 3) els.chat.removeChild(els.chat.lastChild);
  setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 5000);
}
