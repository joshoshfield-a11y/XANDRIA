# XANDRIA Engine API Reference

For developers building on top of XANDRIA-generated games — whether you exported
a source project (`npm run export:source`) or are writing a new genre blueprint
inside the studio. All paths are relative to `src/` (vendored as-is in exports).

Core rule: **use `engine.rng` for every gameplay-affecting random decision.**
`Math.random` in sim code breaks the deterministic seed contract (same seed must
produce the same run — the in-game RESTART button depends on it). Cosmetic-only
code (particles, juice) may use `Math.random`.

---

## 1. Engine — `engine/Engine.ts`

The runtime kernel. Owns renderer, scene, physics, audio, input, HUD, and all
subsystems below.

```ts
const engine = new Engine(container: HTMLElement, spec: GameSpec, opts?: EngineOptions);
```

| Member | What it is |
|---|---|
| `spec: GameSpec` | the validated game spec (read-only at runtime) |
| `rng: Rng` | seeded RNG — `next()`, `range(a,b)`, `pick(arr)`, `reseed(seed)` |
| `scene, camera, renderer` | three.js objects |
| `physics: Physics` | cannon-es wrapper (`capsule/sphere/box/cylinder/body`, `step`) |
| `hud: HUD` | §2 |
| `audio: AudioEngine` | §8 |
| `juice: Juice` | §7 |
| `hooks: Modding` | §9 — taps + registries |
| `input: Input` | `axis()`, `justPressed('confirm'|'pause'|...)` |
| `particles: Particles` | `explosion(pos, scale)`, `magic(pos, color, n)` |
| `mats: MaterialLibrary` | shared materials — never mutate; clone per-instance |
| `settings: Settings` | persisted volume/mute/quality |
| `state` | `'title' \| 'playing' \| 'paused' \| 'won' \| 'lost'` |
| `elapsed, score` | run clock / score |

| Method | Notes |
|---|---|
| `start()` | boots the loop; shows the title screen |
| `startRun()` | leaves title, begins gameplay |
| `onUpdate(fn)` | per-frame hook, **torn down by `restart()`** |
| `onUpdatePersistent(fn)` | per-frame hook that **survives** `restart()` (runtime bootstrap only) |
| `setRunBuilder(fn)` | registers the blueprint builder → enables in-place `restart()` |
| `restart()` | deterministic in-place rebuild from same spec+seed (no page reload) |
| `pause('menu'\|'modal')` / `resume()` / `togglePause()` | `'modal'` pauses can't be Esc-dismissed (level-up screens) |
| `win(stats?)` / `lose(reason?, stats?)` | ends the run; fires `onWin`/`onLose` hooks; shows the end card |
| `toTitle()` | back to the title screen |
| `applySettings()` | push volume/mute/quality to audio + renderer |
| `step(dt)` | advance one tick (used by tests) |

---

## 2. HUD — `engine/game/HUD.ts`

DOM overlay: objective tracker, health/score/timer, cards, menus.

- `setObjective(title, desc)` / `setProgress(text)` / `setTimer(sec)` / `setScore(v)`
- `setHealth(frac)` / `setBoost(frac)` / `setLives(n)` / `setCrosshair(bool)` / `setHint(text)`
- `setBoss(name | null, frac)` — boss health bar
- `toast(text, seconds?)` — small transient banner
- `showCard(title, body, buttonText?): Promise<void>` — **blocking** story card (resolves on click)
- `showLevelUp(choices: UpgradeDef[]): Promise<string>` — pauses with `'modal'`, resolves the chosen upgrade id
- `showEnd(won, stats: RunStats)` — narrative win/lose card with RESTART/TITLE buttons
- `showTitle({ name, premise, controls, onStart })` / `showPause()` / `hidePause()`
- `damageFlash()` — red flash + screenshake (route all player damage through this)
- `setLowHp(bool)` — heartbeat vignette
- `clearOverlays()` / `resetRun()`

All narrative text is set via `textContent` (XSS-safe by construction).

## 3. Objectives — `engine/game/Objectives.ts`

Win/lose logic. Blueprints report events; Objectives decides.

```ts
const objectives = new Objectives(engine, spec.objective,
  (index, stage) => { /* onStageComplete — chapter banner */ },
  () => prog.level,                    // optional level provider for win stats
);
objectives.addProgress(n);   // kills / pickups / generic progress
objectives.addKill();        // eliminate accounting (also bumps kills stat)
```

- Stage mode (quest chains): walks `spec.objective.stages` in order, per-stage
  progress + `timeLimit`; final stage calls `engine.win({ kills, stagesCleared, level })`.
- Legacy mode (no `stages`): single objective, original behavior preserved.
- Fires the `onStageComplete` **hook** (§9) on every chapter transition.

## 4. Progression — `engine/game/Progression.ts`

XP / levels / upgrade choices. No-ops cleanly when `spec.progression.enabled` is false.

```ts
const prog = new Progression(engine);          // reads spec.progression
if (prog.onKill()) {                           // true => leveled up
  const id = await engine.hud.showLevelUp(prog.getUpgradeChoices());
  prog.applyUpgrade(id, avatar);
  engine.resume();
}
```

- `xpForNext(level) = Math.round(100 * level^1.5)`; `addXp(n)` carries remainder across multi-level jumps.
- `getUpgradeChoices()` — 3 distinct defs, drawn via `engine.rng` from built-ins **plus** registered customs (§9).
- `applyUpgrade(id, avatar)` — built-ins: `damage/maxhp/speed/firerate/magnet/dash`; custom ids dispatch to the registered def.
- Multiplier accessors for blueprint wiring: `damageMult()` (1.25ⁿ), `speedMult()` (1.12ⁿ), `magnetMult()` (1.5ⁿ), `dashCdMult()` (0.75ⁿ).
- Fires the `onLevelUp` hook.

## 5. EnemyAI — `engine/game/EnemyAI.ts`

```ts
const mgr = new EnemyManager(engine, projectiles, {
  onPlayerHit: (dmg, from) => avatar.damage(dmg, from),
  onDeath: (e) => { objectives.addKill(); notifyLevelUp(prog.onKill()); },
});
mgr.spawnAll(spec.enemies, (kind, i, n) => spawnPosFor(kind, i, n));
// per frame: mgr.update(dt, playerPos, t);
```

Base kinds: `walker` (patrol→chase→melee), `brute` (big walker; boss when the
objective has a `boss` stage), `drone`/`flyer` (hover, strafe, shoot),
`turret` (static, aimed bursts).

- `Enemy` — `damage(amount, from?)`, `position`, `alive`, `isBoss`, `bossPhase` (0/1/2).
- Boss phases at ≤66% / ≤33% HP: speed ×1.25, aggression ×1.3, screenshake + roar + music slam; fires `onPhase`.
- `EnemyManager` — `enemies`, `killed`, `aliveCount()`, `nearest(p, r)`; dead enemies are spliced out of the roster (no corpse accumulation).
- Custom kinds via `engine.hooks.registerEnemyKind` (§9): built from a base kind, re-tinted, with a per-tick `update` overlay.
- Determinism: per-enemy `Rng` forked from `spec.meta.seed`; no `Math.random` in AI.

## 6. Assets — `engine/game/Assets.ts`

Asset-override registry for user-swappable content (models/materials/colors).

- `ASSET_IDS` — stable ids: `player.body`, `player.vehicle`, `enemy.walker`, `enemy.drone`, `enemy.brute`, `enemy.flyer`, `enemy.turret`, pickup ids, world prop ids…
- `AssetRegistry.register(id, opts)` / `has(id)` / `applyOverrides(spec)` / `getWarnings()`
- `AssetOverride` — `{ color?, emissive?, emissiveIntensity?, scale?, visible? }`
- `rigsOfKind(manager, kind)` — the live rigs for an enemy kind (for re-skinning at runtime)

## 7. Juice — `engine/game/Juice.ts`

Game feel, cosmetic-only (may use `Math.random`):

- `shake(amount)` — decaying trauma; `shakeOffset(out)` applied around render only
- `hitStop(ms = 75)` / `hitStopActive()` — freeze frames on kills
- `burst(pos, color?, n?)` / `sparkle(pos, color?)` — pooled particles
- `damageNumber(camera, worldPos, text, color?)` — pooled floating text (cap 20)
- `update(dt, camera)` / `reset()`

## 8. Audio — `engine/core/Audio.ts`

100% synthesized WebAudio — zero audio assets.

- `unlock()` — call on first user gesture (title click does this)
- `play(name: Sfx, { pitch?, vol? }?)` — SFX: `shoot hit kill explosion laser pickup levelup chapter roar win lose die`
- `setVolume(v)` / `setMuted(m)` / `setIntensity(v)` — adaptive music intensity 0..1
- `setEngine(rpm, on)` — racing engine hum; `dispose()`

---

## 9. Modding — `engine/game/Modding.ts`

The formal extension surface: `engine.hooks`.

```ts
// subscribe — returns an untap function
const untap = engine.hooks.tap('onKill', ({ enemy }) => { ... });

// custom content
engine.hooks.registerEnemyKind('stalker', { base: 'walker', name: 'Stalker',
  tint: { shirt:'#0a3', pants:'#021', accent:'#0fc' }, scale: 1.2,
  update: (enemy, { dt, t, playerPos }) => { /* after base AI */ } });
engine.hooks.registerUpgrade({ id: 'vampire', name: 'Vampire Rounds',
  desc: 'Heal 5 HP on every kill',
  apply: (prog, avatar) => { engine.hooks.tap('onKill', () => avatar.heal(5)); } });
```

| Hook | Payload | Call site |
|---|---|---|
| `onKill` | `{ enemy }` | `EnemyManager` death pipeline |
| `onPickup` | `{ pickup }` | `Pickups` collect |
| `onStageComplete` | `{ index, stage }` | `Objectives` chapter transition |
| `onPhase` | `{ enemy, phase }` | `Enemy` boss-phase crossing |
| `onLevelUp` | `{ level, progression }` | `Progression.addXp` |
| `onWin` | `{ stats }` | `Engine.win` |
| `onLose` | `{ reason, stats }` | `Engine.lose` |
| `onTick` | `{ dt, t }` | `Engine.step` while playing |

Custom enemy kinds spawn through the normal pipeline — cast the id into the
spec: `{ kind: 'stalker' as EnemyKind, count: 3, health: 60, speed: 6, damage: 12, weapon: 'melee' }`.
Custom upgrades join the 3-choice level-up pool immediately and apply through
`Progression.applyUpgrade(id, avatar)` like built-ins. Duplicate registration throws.

### Pre-boot registration in a real browser page (R3-M1)

The per-engine API above runs after boot. A spec *injected* via
`window.__XANDRIA_SPEC__` is validated before any engine exists, so its
custom kinds must be registered even earlier. The player bundle is a deferred
ES module — no page script can run between the bundle's evaluation and
`boot()`. Instead, `player.html` carries a tiny inline classic `<script>`
(ahead of the bundle) that installs `window.__XANDRIA__.registerEnemyKind`
as a queue; the bundle drains the queue into the module-level registry at
module load, before validation. A modder's own classic `<script>` placed
anywhere in the page automatically runs in between:

```html
<script>
  window.__XANDRIA__.registerEnemyKind('stalker', {
    base: 'walker', name: 'Stalker',
    tint: { shirt: '#1a0a2e', pants: '#0a0a12', accent: '#c97aff' },
  });
</script>
<script>
  window.__XANDRIA_SPEC__ = /* GameSpec using { kind: 'stalker' } */;
</script>
```

Exported standalone games (`xandria-game.html`, via `scripts/export.ts` or the
Studio Export button) carry the inline script automatically — open the file,
add the two scripts above, and the custom kind validates and spawns. A bad
queued def fails loudly (into `window.__XANDRIA_ERRORS`, never silent). If an
injected spec is still invalid, boot falls back to the default game and now
shows a dismissible on-screen banner in addition to the console warning
(R3-N1).

---

## 10. GameSpec schema — `spec/schema.ts`

Top-level sections: `meta` (name, genre, seed, version), `player` (speed, health…),
`enemies: EnemySpec[]`, `pickups`, `objective` (+ optional `stages: ObjectiveStage[]`
quest chain), `narrative` (premise/winText/loseText), `progression`
(enabled, xpPerKill, xpPerPickup), `world` (size, gravity, sky…), `theme`
(palette, weather, retroFilter…), `custom` (escape hatch: `enemyMods`,
`weaponMods`, `quality`…).

Validate/normalize: `validateSpec(raw)` / `normalizeSpec(raw)` from `@spec`
(the `@spec` path alias → `src/spec/index.ts`). Per-stage winnability is
enforced — unknown top-level keys produce warnings, not errors.

## 11. Blueprint authoring guide

A blueprint is `(engine: Engine, spec: GameSpec) => unknown`. Minimal skeleton:

```ts
import type { Engine } from './engine/Engine';
import type { GameSpec } from '@spec';
import { EnemyManager } from './engine/game/EnemyAI';
import { Objectives } from './engine/game/Objectives';
import { Progression } from './engine/game/Progression';
import { Pickups } from './engine/game/Pickups';

export function buildMyGenre(engine: Engine, spec: GameSpec) {
  // 1. world: engine.scene, engine.physics, engine.mats
  // 2. player: engine/game/CharacterController or VehicleController
  // 3. systems: EnemyManager / Projectiles / Pickups / Objectives / Progression
  // 4. wire kills+pickups -> prog.onKill()/onPickup() -> level-up modal flow
  // 5. return a handle (used for debugging; engine.setRunBuilder separately)
}
```

Study `src/blueprints/fpsArena.ts` (combat), `racing.ts` (vehicle, no kills),
`platformer.ts` (no projectiles) for the three structural patterns. Shared
helpers live in `src/blueprints/`: `campaign.ts` (intro/chapter cards, level-up
flow, XP grants), `enemies.ts` (variant director, stage scaling), `fx.ts`
(timed pickup effects), `dressing.ts` (per-chapter arena dressing).

Checklist for a new blueprint: all spawns from `engine.rng`; kills and pickups
feed Progression; `Objectives` gets an `onStageComplete` chapter banner;
`engine.setRunBuilder((e) => buildMyGenre(e, spec))` so RESTART works;
`?test=1`/`?autostart=1` must skip the title screen (e2e compatibility).

---

## Cookbook

**Custom enemy — a blinking stalker that teleports behind the player:**
```ts
engine.hooks.registerEnemyKind('stalker', {
  base: 'walker', name: 'Stalker',
  tint: { shirt: '#1a0a2e', pants: '#0a0a12', accent: '#c97aff' },
  update: (enemy, { t, playerPos }) => {
    if (t % 7 < 0.05) { // every ~7s — deterministic on the run clock
      const behind = playerPos.clone().add(new THREE.Vector3(0, 0, -4));
      enemy.body?.position.set(behind.x, behind.y + 1, behind.z);
      engine.juice.burst(behind, '#c97aff');
    }
  },
});
```

**Custom upgrade — lifesteal:**
```ts
engine.hooks.registerUpgrade({
  id: 'vampire', name: 'Vampire Rounds', desc: 'Heal 6 HP on every kill',
  apply: (_prog, avatar) => {
    engine.hooks.tap('onKill', () => avatar.heal(6));
  },
});
```

**Win-screen mod — custom victory tally:**
```ts
engine.hooks.tap('onWin', ({ stats }) => {
  console.log(`Victory! Kills: ${stats.kills}, level ${stats.level}, chapters ${stats.stagesCleared}`);
  // e.g. POST to your leaderboard here
});
```
