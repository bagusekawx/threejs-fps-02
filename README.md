# STARFALL — Hilltop Observatory Tactical FPS

A 5v5 round-based tactical first-person shooter that runs offline in a
desktop browser from static files. Built on three.js 0.187.0 (vendored),
no build step, no network, no audio files — all sound is synthesized live
with WebAudio.

**The match:** NIGHTWATCH defends a hilltop observatory at dusk;
DAYBREAK attacks it. First team to 7 rounds wins (max 12). Rounds end by
elimination, by the Uplink Charge detonating after a plant, by a defuse,
or on timeout (defenders win). You play as DAYBREAK with four bot
teammates against five bots.

**Gunplay:** hitscan with ray-vs-body tests and 4× headshot damage,
recoil and spread that punish firing on the move and reward stopping to
aim, ADS, crouch, acceleration + friction movement, AABB collision,
tracers, muzzle flash, hitmarkers and a damage-direction indicator.

**Tactics:** plant/defuse objective, round economy ($800 start, $300 per
kill, $3,250 round win) and a buy menu (B) with four weapons, frag and
smoke grenades (smoke blocks bot sight), armour and defuse kits. Bots
follow waypoint routes across three lanes, hold sites, react to sight
and to gunfire, push as a group, plant and defuse.

**Map:** an observatory complex — radio-dish plaza (Site A), telescope
dome (Site B), mid causeway, west ridge path, east service road — in a
deep-indigo dusk palette with amber lamps.

## Play

Serve `game/` with any static server and open `index.html`:

```
python3 -m http.server 8080 --directory game
```

## Screenshot staging

`?shot=start|combat|buy|end&seed=N` deterministically stages the game
for screenshots. See `shots.json`.

## Layout

- `game/index.html` — DOM, HUD styling, import map
- `game/src/state.js` — the single state object + tuning constants
- `game/src/sim.js` — fixed-step (60 Hz) simulation
- `game/src/map.js` — map data, collision, line of sight, scenery
- `game/src/bots.js` — bot AI (routes, sight, hearing, bursts)
- `game/src/weapons.js` — hitscan, spread, recoil, grenades
- `game/src/rounds.js` — rounds, economy, buy, plant/defuse
- `game/src/fx.js` — bot rigs, viewmodel, tracers, smoke
- `game/src/hud.js` — HUD, minimap, menus, name tags
- `game/src/audio.js` — synthesized WebAudio effects
- `game/src/input.js` — keyboard / mouse / pointer lock
- `game/src/rng.js` — seeded randomness
- `game/src/main.js` — bootstrap, frame loop, staging
- `main.ts` — entry program: copies the game and writes `dossier.json`

## License

MIT — see `LICENSE`. three.js is vendored under its own license in
`game/vendor/three/LICENSE`.
