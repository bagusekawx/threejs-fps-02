// fx.js — one job: everything seen that is not the map. Bot body meshes and
// their per-frame sync from state, the first-person viewmodel gun, tracers,
// muzzle flash, hit sparks, smoke clouds and the planted charge. All pools
// are preallocated: the render path creates no objects per frame.
import * as THREE from 'three';
import { S } from './state.js';

const bodyGeo = new THREE.BoxGeometry(0.62, 0.78, 0.34);
const headGeo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
const legGeo = new THREE.BoxGeometry(0.24, 0.62, 0.26);
const armGeo = new THREE.BoxGeometry(0.18, 0.6, 0.18);
const gunGeo = new THREE.BoxGeometry(0.1, 0.14, 0.85);
const _mats = {};

function teamMat(team, part) {
  const key = team + part;
  if (_mats[key]) return _mats[key];
  const c = team === 'NW' ? { body: 0x2563eb, head: 0x93c5fd, leg: 0x1e293b } : { body: 0xb45309, head: 0xfcd34d, leg: 0x292524 };
  _mats[key] = new THREE.MeshStandardMaterial({ color: c[part], roughness: 0.8 });
  return _mats[key];
}

// One rig per bot: group with torso, head, legs, arms, gun + a visor strip.
export const rigs = new Map(); // agentId -> { group, legL, legR, armR }
export function buildRig(a) {
  const g = new THREE.Group();
  const torso = new THREE.Mesh(bodyGeo, teamMat(a.team, 'body'));
  torso.position.y = 1.06; torso.castShadow = true;
  g.add(torso);
  const head = new THREE.Mesh(headGeo, teamMat(a.team, 'head'));
  head.position.y = 1.62; head.castShadow = true;
  g.add(head);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.05),
    new THREE.MeshBasicMaterial({ color: a.team === 'NW' ? 0x67e8f9 : 0xfde68a }));
  visor.position.set(0, 1.64, -0.18);
  g.add(visor);
  const legL = new THREE.Mesh(legGeo, teamMat(a.team, 'leg'));
  legL.position.set(-0.16, 0.36, 0); g.add(legL);
  const legR = new THREE.Mesh(legGeo, teamMat(a.team, 'leg'));
  legR.position.set(0.16, 0.36, 0); g.add(legR);
  const armR = new THREE.Mesh(armGeo, teamMat(a.team, 'body'));
  armR.position.set(0.38, 1.15, -0.2); armR.rotation.x = -1.1; g.add(armR);
  const armL = new THREE.Mesh(armGeo, teamMat(a.team, 'body'));
  armL.position.set(-0.38, 1.15, -0.15); armL.rotation.x = -0.9; g.add(armL);
  const gun = new THREE.Mesh(gunGeo, new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.5, metalness: 0.6 }));
  gun.position.set(0.22, 1.18, -0.55); g.add(gun);
  const rig = { group: g, legL, legR, armR, walk: 0 };
  rigs.set(a.id, rig);
  return rig;
}

const _v = new THREE.Vector3();
export function syncRig(a, dt) {
  const rig = rigs.get(a.id);
  if (!rig) return;
  const g = rig.group;
  g.visible = a.alive;
  if (!a.alive) return;
  g.position.set(a.x, 0, a.z);
  g.rotation.y = a.yaw;
  if (a.moving) {
    rig.walk += dt * 11;
    const s = Math.sin(rig.walk) * 0.55;
    rig.legL.rotation.x = s; rig.legR.rotation.x = -s;
  } else {
    rig.legL.rotation.x *= 0.8; rig.legR.rotation.x *= 0.8;
  }
  // Carriers show the charge on their back.
  if (a.carrying && !rig.charge) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x0e7490, roughness: 0.4 }));
    c.position.set(0, 1.25, 0.28);
    g.add(c); rig.charge = c;
  }
  if (rig.charge) rig.charge.visible = a.carrying;
}

// ---- viewmodel gun ------------------------------------------------------
// Built from boxes in the camera's local space: receiver, barrel, grip,
// mag, sight and a muzzle-flash quad that shows for one frame burst.
let viewGun = null, flash = null, flashLight = null;
export function buildViewmodel(camera) {
  viewGun = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.45, metalness: 0.7 });
  const mid = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.5, metalness: 0.6 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.5, metalness: 0.4 });
  const add = (geo, m, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z); mesh.scale.set(sx, sy, sz);
    viewGun.add(mesh);
    return mesh;
  };
  const B = new THREE.BoxGeometry(1, 1, 1);
  add(B, dark, 0, 0, 0, 0.09, 0.13, 0.62);          // receiver
  add(B, mid, 0, 0.01, -0.48, 0.05, 0.05, 0.42);    // barrel
  add(B, dark, 0, -0.13, 0.08, 0.08, 0.16, 0.1);    // grip
  add(B, mid, 0, -0.14, -0.08, 0.07, 0.18, 0.12);   // magazine
  add(B, dark, 0, 0.085, -0.02, 0.03, 0.045, 0.12); // rear sight
  add(B, accent, 0, 0.11, -0.02, 0.012, 0.012, 0.05); // amber sight dot
  add(B, mid, 0, 0.02, -0.72, 0.07, 0.07, 0.08);    // muzzle brake
  flash = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
  flash.position.set(0, 0.01, -0.78);
  flash.visible = false;
  viewGun.add(flash);
  flashLight = new THREE.PointLight(0xffb35c, 0, 9, 1.8);
  flashLight.position.set(0, 0.1, -0.7);
  viewGun.add(flashLight);
  // A dim warm light on the gun itself so the viewmodel never goes black.
  const gunLight = new THREE.PointLight(0xffd9a0, 2.5, 2.5, 1.5);
  gunLight.position.set(0.1, 0.25, 0.1);
  viewGun.add(gunLight);
  viewGun.position.set(0.24, -0.21, -0.48);
  camera.add(viewGun);
  return viewGun;
}

// ADS slides the gun to centre; recoil kicks it; bob sways it while moving.
const _adsPos = new THREE.Vector3(0, -0.155, -0.45);
const _hipPos = new THREE.Vector3(0.24, -0.21, -0.48);
export function updateViewmodel(a, t, dt) {
  if (!viewGun) return;
  const target = a.ads ? _adsPos : _hipPos;
  viewGun.position.lerp(target, Math.min(1, dt * 12));
  const bob = a.moving ? Math.sin(t * 9) * 0.006 : 0;
  viewGun.position.y += bob;
  viewGun.rotation.x = a.recoilPitch * 1.6;
  viewGun.rotation.z = bob * 0.6;
  const show = a.flashT > 0;
  flash.visible = show;
  if (show) {
    flash.rotation.z = Math.random() * Math.PI;
    flashLight.intensity = 14;
  } else flashLight.intensity = 0;
}

// ---- tracers + sparks (pooled) ------------------------------------------
const TRACER_N = 24;
let tracerPool = [], tracerIdx = 0, sparkPool = [], sparkIdx = 0;
export function initPools(scene) {
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  for (let i = 0; i < TRACER_N; i++) {
    const line = new THREE.Line(tg.clone(), new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 }));
    line.visible = false; line.frustumCulled = false;
    scene.add(line);
    tracerPool.push({ line, t: 0 });
  }
  const sg = new THREE.SphereGeometry(0.07, 6, 5);
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    m.visible = false;
    scene.add(m);
    sparkPool.push({ m, t: 0, vx: 0, vy: 0, vz: 0 });
  }
}
export function spawnTracer(x0, y0, z0, x1, y1, z1) {
  const tr = tracerPool[tracerIdx++ % TRACER_N];
  const pos = tr.line.geometry.attributes.position;
  pos.setXYZ(0, x0, y0, z0);
  pos.setXYZ(1, x1, y1, z1);
  pos.needsUpdate = true;
  tr.line.visible = true;
  tr.t = 0.07;
}
export function spawnSparks(x, y, z, n = 4) {
  for (let i = 0; i < n; i++) {
    const s = sparkPool[sparkIdx++ % sparkPool.length];
    s.m.position.set(x, y, z);
    s.vx = (Math.random() - 0.5) * 4; s.vy = Math.random() * 3 + 1; s.vz = (Math.random() - 0.5) * 4;
    s.m.visible = true; s.t = 0.35;
  }
}
export function stepFx(dt) {
  for (const tr of tracerPool) {
    if (!tr.line.visible) continue;
    tr.t -= dt;
    if (tr.t <= 0) tr.line.visible = false;
  }
  for (const s of sparkPool) {
    if (!s.m.visible) continue;
    s.t -= dt;
    if (s.t <= 0) { s.m.visible = false; continue; }
    s.vy -= 12 * dt;
    s.m.position.x += s.vx * dt; s.m.position.y += s.vy * dt; s.m.position.z += s.vz * dt;
  }
}

// ---- smoke clouds + planted charge --------------------------------------
const smokeMeshes = new Map(); // smoke object -> mesh
const smokeGeo = new THREE.SphereGeometry(3.1, 12, 9);
const smokeMat = new THREE.MeshStandardMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.82, roughness: 1, depthWrite: false });
let chargeMesh = null, chargeLight = null;
export function syncWorldFx(scene) {
  for (const s of S.smokes) {
    if (!smokeMeshes.has(s)) {
      const m = new THREE.Mesh(smokeGeo, smokeMat);
      m.position.set(s.x, 1.6, s.z);
      scene.add(m);
      smokeMeshes.set(s, m);
    }
    const m = smokeMeshes.get(s);
    m.scale.setScalar(1 + Math.sin(S.time * 0.8 + s.x) * 0.05);
  }
  for (const [s, m] of smokeMeshes) {
    if (!S.smokes.includes(s)) { scene.remove(m); smokeMeshes.delete(s); }
  }
  // Dropped charge: small blinking case on the ground.
  if ((S.charge.state === 'dropped' || S.charge.state === 'planted') && !chargeMesh) {
    chargeMesh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.4, metalness: 0.6 }));
    chargeMesh.add(body);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4444 }));
    lamp.position.set(0, 0.2, 0);
    chargeMesh.add(lamp);
    chargeMesh.userData.lamp = lamp;
    chargeLight = new THREE.PointLight(0xff4444, 6, 8, 1.8);
    chargeLight.position.y = 0.5;
    chargeMesh.add(chargeLight);
    scene.add(chargeMesh);
  }
  if (chargeMesh) {
    const show = S.charge.state === 'dropped' || S.charge.state === 'planted';
    chargeMesh.visible = show;
    if (show) {
      chargeMesh.position.set(S.charge.x, 0.16, S.charge.z);
      const blink = S.charge.state === 'planted' ? (Math.sin(S.time * (S.charge.timer < 10 ? 14 : 6)) > 0) : true;
      chargeMesh.userData.lamp.visible = blink;
      chargeLight.intensity = blink ? 6 : 0;
    }
  }
}

// Damage vignette flash is DOM-side (hud.js); this keeps the camera shake.
export function shakeOffset(t, amp) {
  _v.set((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp, 0);
  return _v;
}
