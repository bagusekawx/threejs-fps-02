// map.js — one job: the STARFALL observatory. It owns the map data (wall
// colliders, waypoint graph, sites, spawns), the collision + line-of-sight
// queries the sim uses, and the three.js scenery built from that same data,
// so what you see is exactly what you collide with.
import * as THREE from 'three';
import { SITES } from './state.js';

// ---- layout data -------------------------------------------------------
// A collider is an axis-aligned box: [x0, z0, x1, z1, height]. Walls are
// full height (3.2); crates are low cover (1.1–1.4) you can shoot over.
// Map bounds: x -42..42, z -32..32. North (-z) is the defenders' hill;
// south (+z) is the attackers' approach. Dish A sits west, Dome B east.
export const BOUNDS = { x0: -42, x1: 42, z0: -32, z1: 32 };
export const WALLS = [
  // perimeter
  [-42, -32, 42, -30.5, 4.5], [-42, 30.5, 42, 32, 4.5],
  [-42, -32, -40.5, 32, 4.5], [40.5, -32, 42, 32, 4.5],
  // mid causeway gate + pillars
  [-4.5, -2, -2.5, 6, 3.2], [2.5, -2, 4.5, 6, 3.2],
  [-1.2, -8, 1.2, -6, 1.2],
  // central dish plaza ring (low wall around the dish mount)
  [-10, -20, -8, -10, 1.2], [8, -20, 10, -10, 1.2],
  [-10, -21, 10, -19.5, 1.2],
  // west ridge path: rock + hut walls
  [-34, -6, -30, 2, 3.2], [-28, 8, -26, 16, 1.3], [-36, -20, -32, -14, 3.2],
  [-20, 12, -14, 14, 1.3], [-18, -4, -16, 4, 1.1],
  // east service road: containers + shed
  [30, -6, 34, 2, 3.2], [26, 8, 28, 16, 1.3], [32, -20, 36, -14, 3.2],
  [14, 12, 20, 14, 1.3], [16, -4, 18, 4, 1.1],
  // site A (dish) cover
  [-30, -18, -28, -10, 1.3], [-20, -20, -18, -12, 1.3], [-26, -8, -22, -6, 1.1],
  // site B (dome) cover
  [28, -18, 30, -10, 1.3], [18, -20, 20, -12, 1.3], [22, -8, 26, -6, 1.1],
  // spawn screens
  [-8, 24, -6, 28, 3.2], [6, 24, 8, 28, 3.2],
  [-8, -28, -6, -24, 3.2], [6, -28, 8, -24, 3.2],
  // mid crates
  [-6, 16, -3, 18.5, 1.1], [3, 16, 6, 18.5, 1.1],
  [-12, 2, -9, 5, 1.1], [9, 2, 12, 5, 1.1],
];
export const CRATES = [
  // free-standing crates (also colliders, listed separately for mesh style)
  [-26, 20, 1.2], [24, 22, 1.2], [-12, -12, 1.1], [12, -12, 1.1],
  [-2, 24, 1.1], [0, -24, 1.2], [-32, 8, 1.1], [32, 10, 1.1],
];
for (const [x, z, s] of CRATES) WALLS.push([x - s / 2, z - s / 2, x + s / 2, z + s / 2, s]);

export const SPAWNS = {
  DB: [[-6, 28], [-2, 28.5], [2, 28.5], [6, 28], [0, 26]],
  NW: [[-24, -27], [-18, -26], [0, -27], [18, -26], [24, -27]],
};

// Waypoint graph: nodes on the three lanes, edges by index. Bots route with
// BFS over this graph (bots.js). Coordinates are (x, z).
export const WP = [
  [0, 27], [-4, 20], [4, 20], [0, 12], [0, 4], [0, -4], [0, -12], [0, -20], // 0-7 mid
  [-12, 18], [-18, 10], [-24, 2], [-28, -8], [-24, -14], [-16, -18],          // 8-13 west
  [12, 18], [18, 10], [24, 2], [28, -8], [24, -14], [16, -18],               // 14-19 east
  [-8, -14], [8, -14], [-12, -24], [12, -24], [0, -27],                      // 20-24 north link
];
export const WP_EDGES = [
  [1, 2], [0, 3, 8], [0, 3, 14], [1, 2, 4, 8, 14], [3, 5, 10, 16], [4, 6, 10, 16],
  [5, 7, 20, 21], [6, 22, 23], [1, 3, 9], [8, 10], [4, 5, 9, 11, 20], [10, 12],
  [11, 13, 20], [12, 22], [2, 3, 15], [14, 16], [4, 5, 15, 17, 21], [16, 18],
  [17, 19, 21], [18, 23], [6, 10, 12, 22], [6, 16, 18, 23], [7, 13, 20, 24],
  [7, 19, 21, 24], [22, 23],
];
export const SITE_WP = { A: 12, B: 18 };
export const DEFEND_WP = { A: [12, 11, 13, 20], B: [18, 17, 19, 21] };

// ---- queries (no allocation: all math on scalars) -----------------------
export function collide(x, z, r) {
  // Circle-vs-AABB resolve: returns corrected [x, z] into the out array.
  return collideInto(x, z, r, _cOut);
}
const _cOut = [0, 0];
export function collideInto(x, z, r, out) {
  if (x < BOUNDS.x0 + r) x = BOUNDS.x0 + r;
  if (x > BOUNDS.x1 - r) x = BOUNDS.x1 - r;
  if (z < BOUNDS.z0 + r) z = BOUNDS.z0 + r;
  if (z > BOUNDS.z1 - r) z = BOUNDS.z1 - r;
  for (let i = 0; i < WALLS.length; i++) {
    const w = WALLS[i];
    const cx = Math.max(w[0], Math.min(x, w[2]));
    const cz = Math.max(w[1], Math.min(z, w[3]));
    const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        x = cx + (dx / d) * r; z = cz + (dz / d) * r;
      } else {
        // centre inside the box: push out along the smallest penetration
        const pl = x - w[0], pr = w[2] - x, pt = z - w[1], pb = w[3] - z;
        const m = Math.min(pl, pr, pt, pb);
        if (m === pl) x = w[0] - r; else if (m === pr) x = w[2] + r;
        else if (m === pt) z = w[1] - r; else z = w[3] + r;
      }
    }
  }
  out[0] = x; out[1] = z;
  return out;
}

// 2D segment vs wall test at eye height: only walls taller than 1.5 block sight.
export function losBlocked(x0, z0, x1, z1) {
  for (let i = 0; i < WALLS.length; i++) {
    const w = WALLS[i];
    if (w[4] < 1.5) continue;
    if (segHitsBox(x0, z0, x1, z1, w[0], w[1], w[2], w[3])) return true;
  }
  return false;
}
function segHitsBox(x0, z0, x1, z1, bx0, bz0, bx1, bz1) {
  const dx = x1 - x0, dz = z1 - z0;
  let t0 = 0, t1 = 1;
  if (Math.abs(dx) < 1e-9) { if (x0 < bx0 || x0 > bx1) return false; }
  else {
    let a = (bx0 - x0) / dx, b = (bx1 - x0) / dx;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  if (Math.abs(dz) < 1e-9) { if (z0 < bz0 || z0 > bz1) return false; }
  else {
    let a = (bz0 - z0) / dz, b = (bz1 - z0) / dz;
    if (a > b) { const t = a; a = b; b = t; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}

// Ray vs walls in 3D: returns distance to the nearest wall hit, or Infinity.
// ox,oy,oz origin; dx,dy,dz unit direction.
export function rayWalls(ox, oy, oz, dx, dy, dz) {
  let best = Infinity;
  for (let i = 0; i < WALLS.length; i++) {
    const w = WALLS[i];
    const t = rayBox(ox, oy, oz, dx, dy, dz, w[0], 0, w[1], w[2], w[4], w[3]);
    if (t < best) best = t;
  }
  // ground plane
  if (dy < -1e-6) { const t = -oy / dy; if (t < best) best = t; }
  return best;
}
function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let t0 = 0, t1 = Infinity;
  const o = _rbO, d = _rbD, mn = _rbMn, mx = _rbMx;
  o[0] = ox; o[1] = oy; o[2] = oz; d[0] = dx; d[1] = dy; d[2] = dz;
  mn[0] = x0; mn[1] = y0; mn[2] = z0; mx[0] = x1; mx[1] = y1; mx[2] = z1;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < mn[a] || o[a] > mx[a]) return Infinity; }
    else {
      let ta = (mn[a] - o[a]) / d[a], tb = (mx[a] - o[a]) / d[a];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return Infinity;
    }
  }
  return t0;
}
const _rbO = [0, 0, 0], _rbD = [0, 0, 0], _rbMn = [0, 0, 0], _rbMx = [0, 0, 0];

export function nearestWP(x, z) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < WP.length; i++) {
    const dx = WP[i][0] - x, dz = WP[i][1] - z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

// BFS route over the waypoint graph. Writes node indices into out, returns count.
const _prev = new Int16Array(64), _queue = new Int16Array(64), _seen = new Uint8Array(64);
export function findRoute(from, to, out) {
  _seen.fill(0);
  let qh = 0, qt = 0;
  _queue[qt++] = from; _seen[from] = 1; _prev[from] = -1;
  while (qh < qt) {
    const n = _queue[qh++];
    if (n === to) break;
    const e = WP_EDGES[n];
    for (let i = 0; i < e.length; i++) {
      if (!_seen[e[i]]) { _seen[e[i]] = 1; _prev[e[i]] = n; _queue[qt++] = e[i]; }
    }
  }
  if (!_seen[to]) { out[0] = to; return 1; }
  let n = to, len = 0;
  const rev = _revBuf; let rl = 0;
  while (n !== -1) { rev[rl++] = n; n = _prev[n]; }
  for (let i = rl - 1; i >= 0; i--) out[len++] = rev[i];
  return len;
}
const _revBuf = new Int16Array(64);

// ---- scenery ------------------------------------------------------------
// Palette: deep indigo dusk, amber horizon, dark blue-grey concrete,
// warm amber lamps, teal accents. All geometry is procedural boxes,
// cylinders and spheres — no textures, no external assets.
const MAT = {};
function mat(color, rough = 0.9, metal = 0.0, emissive = 0) {
  const key = color + '|' + rough + '|' + metal + '|' + emissive;
  if (!MAT[key]) MAT[key] = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive });
  return MAT[key];
}
const _boxGeo = new THREE.BoxGeometry(1, 1, 1);
const _cylGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
const _sphGeo = new THREE.SphereGeometry(1, 18, 12);

function box(scene, x, y, z, sx, sy, sz, material, ry = 0) {
  const m = new THREE.Mesh(_boxGeo, material);
  m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.rotation.y = ry;
  m.castShadow = sy > 1.4; m.receiveShadow = true;
  scene.add(m);
  return m;
}

export function buildWorld(scene) {
  // Sky: big gradient dome (vertex-coloured sphere, BackSide).
  const skyGeo = new THREE.SphereGeometry(220, 24, 12);
  const pos = skyGeo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x0b1035), mid = new THREE.Color(0x2c2a5e), low = new THREE.Color(0xe8862e);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 220; // -1..1
    if (h > 0.25) c.copy(mid).lerp(top, Math.min(1, (h - 0.25) * 2));
    else c.copy(low).lerp(mid, Math.max(0, (h + 0.08) / 0.33));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }));
  scene.add(sky);

  // Stars: a few hundred points high in the dome.
  const starGeo = new THREE.BufferGeometry();
  const sp = new Float32Array(300 * 3);
  for (let i = 0; i < 300; i++) {
    const a = Math.random() * Math.PI * 2, e = 0.35 + Math.random() * 1.1, r = 200;
    sp[i * 3] = Math.cos(a) * Math.cos(e) * r;
    sp[i * 3 + 1] = Math.sin(e) * r;
    sp[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcdd6ff, size: 1.1, fog: false })));

  // Lighting: low amber sun + cool ambient + hemisphere dusk.
  scene.add(new THREE.HemisphereLight(0x8a7fd6, 0x1a1626, 1.15));
  const sun = new THREE.DirectionalLight(0xffb36b, 1.8);
  sun.position.set(-60, 38, 55); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -50; sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50; sun.shadow.camera.bottom = -50;
  sun.shadow.camera.far = 220;
  scene.add(sun);
  const moon = new THREE.DirectionalLight(0x7aa2ff, 0.55);
  moon.position.set(40, 60, -50);
  scene.add(moon);
  scene.fog = new THREE.Fog(0x1b1a3a, 70, 190);

  // Ground: concrete slabs with a darker service-road strip + plaza ring.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 200), mat(0x3a4152, 0.95));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  scene.add(ground);
  const plaza = new THREE.Mesh(new THREE.CircleGeometry(16, 40), mat(0x2e3444, 0.9));
  plaza.rotation.x = -Math.PI / 2; plaza.position.set(0, 0.02, -16);
  plaza.receiveShadow = true;
  scene.add(plaza);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(7, 64), mat(0x272d3a, 0.95));
  road.rotation.x = -Math.PI / 2; road.position.set(0, 0.015, 0);
  road.receiveShadow = true;
  scene.add(road);
  // Site pads: glowing rings + letters painted by emissive strips.
  for (const key of ['A', 'B']) {
    const s = SITES[key];
    const ring = new THREE.Mesh(new THREE.RingGeometry(s.r - 0.35, s.r, 40), mat(0xf59e0b, 0.6, 0, 0x7a4a00));
    ring.rotation.x = -Math.PI / 2; ring.position.set(s.x, 0.03, s.z);
    scene.add(ring);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(s.r - 0.4, 40), mat(0x333a4d, 0.9));
    pad.rotation.x = -Math.PI / 2; pad.position.set(s.x, 0.025, s.z);
    pad.receiveShadow = true;
    scene.add(pad);
  }

  // Walls + crates from the collider data (visuals match collision exactly).
  const wallMat = mat(0x4a5268, 0.85), lowMat = mat(0x5b6478, 0.9), crateMat = mat(0x8a6a3b, 0.85);
  for (const w of WALLS) {
    const sx = w[2] - w[0], sz = w[3] - w[1], h = w[4];
    const cx = (w[0] + w[2]) / 2, cz = (w[1] + w[3]) / 2;
    const tall = h > 1.5;
    box(scene, cx, h / 2, cz, sx, h, sz, tall ? wallMat : lowMat);
    if (tall && sx > 2 && sz > 0.8) {
      // amber hazard cap on long walls
      box(scene, cx, h + 0.06, cz, sx, 0.12, sz, mat(0xf59e0b, 0.5, 0, 0x54380a));
    } else if (!tall) {
      box(scene, cx, h + 0.03, cz, Math.min(sx, 1.4), 0.06, Math.min(sz, 1.4), crateMat);
    }
  }
  // Extra crate dressing (visual only, on top of colliders).
  for (const [x, z, s] of CRATES) {
    box(scene, x, s + s * 0.35, z, s * 0.7, s * 0.7, s * 0.7, crateMat, 0.4);
  }

  // The radio dish (Site A): tilted parabolic dish on a mount.
  const dishGroup = new THREE.Group();
  dishGroup.position.set(-24, 0, -14);
  const mount = new THREE.Mesh(_cylGeo, mat(0x6b7280, 0.6, 0.6));
  mount.scale.set(0.7, 5.5, 0.7); mount.position.y = 2.75; mount.castShadow = true;
  dishGroup.add(mount);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(5.5, 24, 10, 0, Math.PI * 2, 0, 0.62), mat(0xd7dce8, 0.45, 0.55));
  dish.position.y = 6.4; dish.rotation.x = Math.PI - 0.85; dish.scale.z = 0.45;
  dish.castShadow = true;
  dishGroup.add(dish);
  const feed = new THREE.Mesh(_cylGeo, mat(0x374151, 0.5, 0.7));
  feed.scale.set(0.12, 3.4, 0.12); feed.position.set(0, 7.6, 1.9); feed.rotation.x = 0.85;
  dishGroup.add(feed);
  scene.add(dishGroup);

  // The dome (Site B): white observatory dome with a slit.
  const domeGroup = new THREE.Group();
  domeGroup.position.set(24, 0, -14);
  const base = new THREE.Mesh(_cylGeo, mat(0x9aa3b2, 0.8));
  base.scale.set(4.6, 3.4, 4.6); base.position.y = 1.7; base.castShadow = true;
  domeGroup.add(base);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4.6, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xe8ecf4, 0.5, 0.2));
  dome.position.y = 3.4; dome.castShadow = true;
  domeGroup.add(dome);
  const slit = new THREE.Mesh(_boxGeo, mat(0x111827, 0.4));
  slit.scale.set(1.1, 3.4, 0.6); slit.position.set(0, 5.2, 3.9); slit.rotation.x = 0.35;
  domeGroup.add(slit);
  scene.add(domeGroup);

  // Antenna masts with blinking tip lights (blink driven in render loop).
  const masts = [];
  for (const [x, z, h] of [[-38, -28, 16], [38, -28, 16], [-38, 28, 12], [38, 28, 12]]) {
    const mast = new THREE.Mesh(_cylGeo, mat(0x4b5563, 0.5, 0.8));
    mast.scale.set(0.18, h, 0.18); mast.position.set(x, h / 2, z);
    scene.add(mast);
    const tip = new THREE.Mesh(_sphGeo, new THREE.MeshBasicMaterial({ color: 0xff4444 }));
    tip.scale.setScalar(0.28); tip.position.set(x, h + 0.3, z);
    scene.add(tip);
    masts.push(tip);
    // crossbars
    for (let i = 1; i <= 3; i++) {
      const bar = new THREE.Mesh(_boxGeo, mat(0x4b5563, 0.5, 0.8));
      bar.scale.set(1.6 - i * 0.3, 0.08, 0.08);
      bar.position.set(x, h * (0.55 + i * 0.12), z);
      scene.add(bar);
    }
  }

  // Lamp posts: warm pools of light along the lanes.
  const lampMat = mat(0x2f3542, 0.6, 0.5);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffc46b });
  for (const [x, z] of [[-6, 14], [6, 14], [-14, -2], [14, -2], [-6, -20], [6, -20], [-24, 6], [24, 6]]) {
    const pole = new THREE.Mesh(_cylGeo, lampMat);
    pole.scale.set(0.12, 4.4, 0.12); pole.position.set(x, 2.2, z);
    scene.add(pole);
    const head = new THREE.Mesh(_sphGeo, glowMat);
    head.scale.setScalar(0.32); head.position.set(x, 4.5, z);
    scene.add(head);
    const pl = new THREE.PointLight(0xffb35c, 12, 14, 1.8);
    pl.position.set(x, 4.4, z);
    scene.add(pl);
  }

  // Distant ridge silhouettes + a second small dish for depth.
  for (let i = 0; i < 9; i++) {
    const a = -0.6 + i * 0.28;
    const ridge = new THREE.Mesh(new THREE.ConeGeometry(26 + (i % 3) * 10, 14 + (i % 4) * 5, 5), mat(0x141428, 1));
    ridge.position.set(Math.sin(a) * 150, 0, -Math.cos(a) * 150 - 20);
    scene.add(ridge);
  }
  return { masts };
}
