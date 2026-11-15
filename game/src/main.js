// main.js — one job: bootstrap and the frame loop. It builds the renderer,
// scene and camera, wires input + HUD + sim together, runs the fixed-step
// accumulator (60 Hz sim, render decoupled), drives the camera from state,
// and stages deterministic screenshot scenes for ?shot= URLs.
import * as THREE from 'three';
import { S, TEAMS, resetMatch, giveWeapon, WEAPONS } from './state.js';
import { buildWorld } from './map.js';
import { bindInput, requestLock } from './input.js';
import { step } from './sim.js';
import { startRound, buyItem } from './rounds.js';
import { bindHud, updateHud } from './hud.js';
import { buildRig, syncRig, buildViewmodel, updateViewmodel, initPools, stepFx, syncWorldFx, rigs } from './fx.js';
import { unlockAudio } from './audio.js';
import { reseed } from './rng.js';

const STEP = 1 / 60; // fixed simulation step
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot');
const SEED = parseInt(params.get('seed') || '7', 10) || 7;

let renderer, scene, camera, world, clock;
let acc = 0, menuAngle = 0;

init();

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);
  scene.add(camera);
  world = buildWorld(scene);
  initPools(scene);
  buildViewmodel(camera);

  bindInput(renderer.domElement, (locked) => {
    // Losing pointer lock mid-round pauses nothing, but closes the buy menu.
    if (!locked && S.phase === 'live') S.buyOpen = false;
  });
  bindHud({
    onPlay: () => {
      unlockAudio();
      if (document.activeElement) document.activeElement.blur();
      if (S.phase === 'menu') {
        resetMatch((Date.now() % 100000) | 0);
        startRound();
      }
      requestLock(renderer.domElement);
    },
    onRestart: () => {
      if (document.activeElement) document.activeElement.blur();
      resetMatch((Date.now() % 100000) | 0);
      startRound();
      requestLock(renderer.domElement);
    },
  });
  renderer.domElement.addEventListener('click', () => {
    if (S.phase !== 'menu' && S.phase !== 'matchEnd' && !S.buyOpen) requestLock(renderer.domElement);
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  resetMatch(SEED);
  S.shot = SHOT;
  if (SHOT) stageShot(SHOT);
  else S.phase = 'menu';

  // Debug hook for the screenshot harness and headless tests:
  // window.__starfall exposes live state plus the sim step and buy call
  // so an automated check can drive whole rounds without rendering.
  window.__starfall = { S, TEAMS, WEAPONS, step, buyItem, startRound };
  clock = new THREE.Clock();
  renderer.setAnimationLoop(frame);
}

// ---- deterministic screenshot staging ------------------------------------
// Each ?shot= mode puts the game in a fixed, readable state with seeded bot
// placement. Bots in staged scenes hold position so the frame is stable.
function stageShot(shot) {
  reseed(SEED);
  resetMatch(SEED);
  const p = S.player;
  if (shot === 'start') {
    S.phase = 'menu';
    return;
  }
  startRound();
  S.buyLeft = 60; // staged buy phase stays open long enough to capture
  if (shot === 'buy') {
    p.money = 5400;
    S.buyOpen = true;
    return;
  }
  if (shot === 'combat') {
    giveWeapon(p, 'vk47');
    p.slot = 1; p.money = 2350;
    S.phase = 'live';
    S.banner = null; // no round banner in the combat frame
    S.round = 6; S.score.NW = 2; S.score.DB = 3;
    S.timeLeft = 62;
    // Player past the mid gate on the open causeway, two defenders ahead
    // at the dish plaza and teammates in support behind.
    p.x = 0; p.z = -2; p.yaw = 0.08; p.pitch = 0.02; p.hp = 76; p.armor = 100;
    const foes = S.agents.filter((a) => a.team === 'NW');
    const pals = S.agents.filter((a) => a.team === 'DB' && !a.isPlayer);
    const foeSpots = [[3, -10], [-3.5, -13], [-24, -14], [24, -14], [8, -19]];
    foes.forEach((b, i) => {
      b.x = foeSpots[i][0]; b.z = foeSpots[i][1];
      b.yaw = Math.PI; b.ai.state = 'hold'; b.ai.holdT = 999;
      if (i < 2) { giveWeapon(b, 'vk47'); }
    });
    const palSpots = [[-3, 2], [3, 1], [-6, 5], [6, 4]];
    pals.forEach((b, i) => {
      b.x = palSpots[i][0]; b.z = palSpots[i][1];
      b.yaw = 0; b.ai.state = 'hold'; b.ai.holdT = 999;
    });
    S.feed.push(
      { text: 'You  VK-47 Carbine HS  Vega', cls: 'me', t: 0 },
      { text: 'Juno  Kestrel SMG  Rook', cls: '', t: 0 },
      { text: 'Mira  P9 Sidearm  Ash', cls: '', t: 0 },
    );
    return;
  }
  if (shot === 'end') {
    S.phase = 'roundEnd';
    S.endT = 999; // frozen for the screenshot
    S.timeLeft = 0;
    S.round = 11; S.score.NW = 4; S.score.DB = 6;
    p.x = -20; p.z = -10; p.yaw = -0.7; p.pitch = 0.02; p.hp = 34; p.armor = 40;
    giveWeapon(p, 'vk47'); p.slot = 1;
    p.kills = 11; p.deaths = 6; p.money = 6100;
    S.banner = { title: 'ROUND WON', sub: 'CHARGE DETONATED AT SITE A — NIGHTWATCH 4 : 6 DAYBREAK', cls: 'win', t: 999 };
    S.feed.push(
      { text: 'You  VK-47 Carbine  Mira', cls: 'me', t: 0 },
      { text: 'You planted the charge at SITE A', cls: 'obj', t: 0 },
      { text: 'Koda  Frag  Sable', cls: '', t: 0 },
    );
    const foes = S.agents.filter((a) => a.team === 'NW');
    foes.forEach((b, i) => { b.alive = i >= 3; b.hp = b.alive ? 100 : 0; });
    return;
  }
  S.phase = 'menu';
}

function ensureRigs() {
  for (const a of S.agents) {
    if (a.isPlayer || rigs.has(a.id)) continue;
    const rig = buildRig(a);
    scene.add(rig.group);
  }
}

function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  // Fixed-step accumulator: the sim always advances in 1/60 s slices,
  // however fast or slow the display refreshes.
  if (S.phase !== 'menu' && S.phase !== 'matchEnd') {
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 5) { step(STEP); acc -= STEP; n++; }
    if (n === 5) acc = 0; // drop backlog rather than spiral
  }
  ensureRigs();
  for (const a of S.agents) if (!a.isPlayer) syncRig(a, dt);
  syncWorldFx(scene);
  stepFx(dt);
  updateCamera(dt);
  updateViewmodel(S.player, S.time, dt);
  // Mast tip lights blink.
  const blink = Math.sin(S.time * 2.4) > 0;
  for (const tip of world.masts) tip.visible = blink;
  updateHud(dt, camera);
  renderer.render(scene, camera);
}

function updateCamera(dt) {
  const p = S.player;
  if (S.phase === 'menu') {
    // Slow orbit over the observatory for the start screen.
    menuAngle += dt * 0.05;
    const r = 46;
    camera.position.set(Math.sin(menuAngle) * r, 24, Math.cos(menuAngle) * r - 6);
    camera.lookAt(0, 1, -10);
    camera.fov = 60;
    camera.updateProjectionMatrix();
    return;
  }
  const eyeY = (p.crouch ? 1.15 : 1.62) + (p.y || 0) - (p.alive ? 0 : 0.9);
  camera.position.set(p.x, eyeY, p.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = p.yaw;
  camera.rotation.x = p.pitch + p.recoilPitch * 0.9;
  camera.rotation.z = 0;
  // ADS narrows the field of view; the lerp keeps it smooth.
  const targetFov = p.ads ? 52 : 75;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10);
  camera.updateProjectionMatrix();
}
