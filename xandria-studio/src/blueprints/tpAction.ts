/**
 * REFERENCE BLUEPRINT — third-person action adventure.
 * Humanoid + melee/ranged, enemies roaming a themed world, pickups, eliminate/collect/reach/boss objectives.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { resolveEnemyDensity } from '../engine/game/enemyTuning';
import { NpcInstancer } from '../engine/game/npcInstancing';
import { Projectiles } from '../engine/game/Projectiles';
import { Pickups } from '../engine/game/Pickups';
import { Objectives } from '../engine/game/Objectives';
import { Progression } from '../engine/game/Progression';
import type { LevelGain } from '../engine/game/progressionCurve';
import {
  makeCampaignObjectives,
  makeLevelUpFlow,
  grantKillXp,
  grantPickupXp,
  grantCraftXp,
  bossPhaseBanner,
  needsReachGoal,
  registerWorldAssets,
  registerPickupAssets,
  registerEnemyAssets,
} from './campaign';
import { AssetRegistry } from '../engine/game/Assets';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import {
  VariantDirector,
  planSpawns,
  isBossStageActive,
  ACTION_VARIANTS,
} from './enemies';
import {
  EffectState,
  EffectHud,
  scatterEffects,
  spawnEffectPickup,
  applyPickupEffect,
  effectOf,
  wrapShieldDamage,
} from './fx';
import { ChapterDresser } from './dressing';
import { NpcManager } from '../engine/game/NpcManager';
import { QuestManager, buildQuestPool, resolveQuestsEnabled } from '../engine/game/quests';
import { buildSideQuestPool } from '../engine/game/sidequests';
import { QuestTalkSession } from '../engine/game/questTalk';
import { QuestTracker } from '../engine/ui/QuestTracker';
import { GatheringManager, GatheringInteractionSession } from '../engine/game/gathering';
import { resolveCraftingEnabled, ensureCraftingItemDefs, buildRecipePool } from '../engine/game/crafting';
import { ensureLootItemDefs } from '../engine/game/loot';
import { StationManager, CraftingInteractionSession } from '../engine/game/stations';
import { SkillSystem, resolveSkillsEnabled } from '../engine/game/skills';
import { SkillsPanel } from '../engine/ui/SkillsPanel';
import { resolveGatheringDensity } from '../engine/game/crafting';
import { Scatter } from '../engine/world/Scatter';
import { attachLightShafts } from '../engine/gfx/LightShafts';
import { scatterAmberGlow } from '../engine/gfx/AmberGlow';
import { Structures } from '../engine/world/Structures';
import { LandmarkSystem } from '../engine/world/LandmarkSystem';
import { makeGoalFlag } from '../engine/gfx/Characters';
import { PlayerAvatar } from './common';
import { buildItemKit, type BlueprintItemKit } from './itemKit';
import { wireBossFights } from './bosses';

export function buildThirdPersonAction(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud } = engine;
  const rng = engine.rng.fork(101);

  // M2: snapshot the pristine run config before any run-time mutation, so
  // restarts restore the true base (not a mutated one).
  snapshotLoadoutBase(spec);
  // M7: in-place restarts tear down the scene but never cleared the asset
  // bridge's roots — drop the stale refs (no-op at boot).
  engine.assetBridge.dispose();

  // campaign layer: XP progression (the intro card is shown by Engine.beginPlay)
  const prog = new Progression(engine);
  // skills wave: data-driven skill system (foraging / smithing / alchemy)
  // with per-skill XP and ranks. Blueprint-owned like prog — rides the
  // live object across portal transitions. Rank-ups toast; the levelup
  // audio cue fires inside SkillSystem.addXp.
  const skills = new SkillSystem(engine, {
    onRankUp: (def, rank) => {
      engine.hud.toast(`${def.name} rank ${rank}!`);
    },
  });
  let notifyLevelUp: (gain?: LevelGain) => void = () => {};
  // content depth: enemy variants, timed pickup effects, chapter dressing
  const fx = new EffectState();
  const fxHud = new EffectHud();
  const dresser = new ChapterDresser(engine);

  // asset registry (reskin layer): world assets first, the rest after spawns
  const assets = new AssetRegistry();
  registerWorldAssets(assets, engine);

  // --- world dressing
  const structures = new Structures(engine.physics, engine.mats);
  if (spec.world.scatter.buildings > 0) structures.city(spec, terrain, spec.world.scatter.buildings, spec.meta.seed);
  scene.add(structures.group);
  // env-art pass: blocky landmarks + amber glow accents, sun-aligned water glint.
  // Landmarks come before scatter so hero specimen plants can ring them (wave 2B).
  // Portal-backlog wave: landmarks (+ structure sets) are a map-local entity
  // system (id 'landmarks') — despawned on portal departure, rebuilt from
  // the derived map seed on arrival.
  const landmarks = new LandmarkSystem(engine, { exclusion: [{ x: 0, z: 0, r: 12 }] });
  engine.portalEntities.register(landmarks);
  landmarks.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
  const scatter = new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    exclusion: [{ x: 0, z: 0, r: 12 }],
    engine,
    quality: engine.effectiveQuality(),
    densityMul: engine.tiers.flags.densityMul, // graphics wave 2 (E): tier scatter density
    windMul: engine.tiers.flags.windMul, // graphics wave 2 (E): tier wind-sway intensity
    heroSpots: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })), // wave 2B: hero plants
  });

  // gameplay wave (workstream B): ambient NPC villagers settled near
  // landmarks/structures, map-local lifecycle. The manager registers itself
  // with engine.portalEntities ({ id: 'npcs' }) so portal transitions
  // despawn/respawn the roster deterministically per map seed.
  const npcManager = new NpcManager(engine, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
    specs: spec.npcs,
  });
  engine.portalEntities.register(npcManager);
  npcManager.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed

  scatterAmberGlow(scene, rng.fork(0xe9a1), {
    mats: engine.mats,
    groundY: (x, z) => terrain.heightAt(x, z),
    half: terrain.size / 2 - 10,
    exclusion: [{ x: 0, z: 0, r: 12 }],
    quality: engine.effectiveQuality(),
  });
  terrain.setWaterSun(
    engine.sky.sun.position.clone().sub(engine.sky.sun.target.position).normalize(),
    spec.theme.timeOfDay === 'dusk' || spec.theme.timeOfDay === 'dawn' ? '#ffb46b' : '#cfe8ff',
  );
  // polish wave: cheap god-ray-ish light shafts (quality-scaled, day/dusk only)
  attachLightShafts(engine);

  // --- combat systems
  const projectiles = new Projectiles(engine, spec.theme.palette.accent);
  let avatar: PlayerAvatar;

  // FIX 5: combat music intensity — pulsed up by combat events, decays to baseline
  let combatT = 0;
  const combatPulse = () => { combatT = 1; };

  const enemies = new EnemyManager(engine, projectiles, {
    onPlayerHit: (dmg, from) => { avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); },
    onDeath: (e) => {
      variants.onEnemyDeath(e); // splitter minis + visual cleanup first
      engine.score += Math.round(100 * fx.scoreMult());
      hud.setScore(engine.score);
      // N6: grant XP before recording the kill — addProgress may end the run
      // (engine.win), and the level-up modal must never open over the end screen
      grantKillXp(prog, notifyLevelUp, e.xpMult);
      objectives.addProgress(1, 'kill'); // M5: kills only count toward kill stages
      quests?.onKill(e.spec.kind); // quest wave: kills feed kill objectives
      combatPulse();
      const d = e.position.distanceTo(avatar.ctrl.position);
      if (d < 14) camRig.shake(0.6 * (1 - d / 14));
      if (rng.chance(0.3)) pickups.spawn(rng.chance(0.6) ? 'health' : 'coin', e.position.clone().add(new THREE.Vector3(0, 0.6, 0)));
      else if (rng.chance(0.12)) {
        const kinds = ['shield', 'rapid', 'mult', 'magnet'] as const;
        spawnEffectPickup(pickups, engine, kinds[rng.int(0, 3)], e.position.clone().add(new THREE.Vector3(0, 0.8, 0)));
      }
    },
    onPhase: (e, phase) => { bossPhaseBanner(engine, phase); combatPulse(); },
  }, {
    // enemies wave (A): map-local lifecycle — the roster rings landmarks so
    // portal arrivals respawn deterministically per map seed; portal
    // departures despawn live enemies AND mid-tumble corpses.
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
    // enemies wave (C): Studio ENEMY DENSITY slider (spec.custom.enemies)
    // scales every spec count on the portal-arrival path.
    // UPGRADE LOOP (enemy-scaling): live player level feeds the spawn stat band.
    playerLevel: () => prog.level,
    density: resolveEnemyDensity(spec, engine.tiers.tier),
  });
  engine.portalEntities.register(enemies);
  // enemy variants: shielded bruisers + ranged casters over the base kinds
  const variants = new VariantDirector(engine, enemies, projectiles);

  // --- player
  const spawnY = terrain.heightAt(0, 0);
  avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, spawnY + 2, 0), enemies, projectiles);
  // inventory wave: items/inventory/HUD/equip-rendering (null when spec has no custom.items)
  // crafting wave (workstream C): register the crafting item defs (materials
  // + recipe outputs) before wireItems, when the spec has crafting enabled
  // (default true). Idempotent; Studio-authored defs win (no-overwrite).
  const craftingEnabled = resolveCraftingEnabled(spec);
  if (craftingEnabled) ensureCraftingItemDefs(spec);
  // items-expansion wave: enemy loot-drop defs (materials + gear + tier-2
  // outputs). Merges only when custom.items exists — never activates the
  // item system on its own (preserves wireItems' null contract).
  ensureLootItemDefs(spec);
  const itemKit: BlueprintItemKit | null = buildItemKit(engine, spec, avatar);
  // items-expansion wave: enemy loot drops — seeded per-map drop tables
  // off the EnemyManager die() path, granted as world pickups the player
  // walks over to collect. Independent of the CRAFTING toggle (loot is an
  // items-wave feature, not a crafting feature).
  if (itemKit) {
    const kit = itemKit;
    enemies.lootHooks = {
      onLoot: (drop, pos) => {
        kit.itemWorld.drop(drop.itemId, pos.clone().add(new THREE.Vector3(0, 0.8, 0)), undefined, drop.count);
        const def = spec.custom?.items?.defs?.[drop.itemId];
        engine.hud.toast(`Loot: ${drop.count > 1 ? `${drop.count}\u00d7 ` : ''}${def?.name ?? drop.itemId}`);
      },
    };
  }
  // boss-fights wave: data-driven boss encounters (seeded arena, telegraphed
  // attacks, boss bar). Map-local lifecycle via engine.portalEntities
  // (id 'boss'); the arena + scheduler run only when the spec's boss flag
  // is enabled (default: any boss objective stage).
  const { encounter: bosses, bar: bossBar } = wireBossFights(engine, spec, {
    manager: enemies,
    terrain,
    onPlayerHit: (dmg, from) => { avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); },
  });
  // crafting wave (workstream B): harvestable gathering nodes (ore veins,
  // fiber plants, salvage caches), map-local lifecycle. The manager
  // registers itself with engine.portalEntities ({ id: 'gathering' }) so
  // portal transitions despawn/respawn the node roster deterministically
  // per map seed. Depleted state is NOT persisted across portals (design —
  // arrival regenerates the identical roster, like NPCs/enemies).
  // quest wave: the main-story quest line. The QuestManager is PLAYER-SCOPED,
  // not map-local — it is never registered in engine.portalEntities, so
  // portal departure/arrival leaves quest progress untouched (same standing
  // as Progression/Inventory; see engine/game/quests.ts). engine.questManager
  // exposes it to PortalState's snapshot/restore.
  // quest wave: declared early — the QuestManager's onQuestsChanged thunk
  // references it, and the manager notifies during its own construction
  // (refreshTracker in the constructor), so the binding must exist first.
  let talkSession: QuestTalkSession | null = null;
  const questsEnabled = resolveQuestsEnabled(spec);
  const questTracker = questsEnabled ? new QuestTracker(engine.container) : null;
  // HUD-polish: keep the touch pause button clear of the tracker when quests re-render.
  if (questTracker) questTracker.onRender = () => engine.touch.repositionPauseButton();
  const quests = questsEnabled
    ? new QuestManager({
        defs: [...buildQuestPool(spec, { includeTalk: true }),
          // side-quests wave: independent side quests ride the same
          // manager (available from the start, no chaining).
          ...buildSideQuestPool(spec, { includeTalk: true })],
        inventory: () => itemKit?.inventory ?? null,
        defsTable: () => spec.custom?.items?.defs ?? {},
        progression: prog,
        tracker: questTracker,
        toast: (m) => engine.hud.toast(m),
        getTransitions: () => engine.portalManager?.transitions ?? 0,
        // side-quests wave: explore objectives with target 'maps' /
        // 'biomes' sample the portal manager's map coordinate; the world
        // seed (NOT spec.meta.seed, the map build seed) feeds deriveMapBiome.
        getCurrentMap: () => engine.portalManager?.coord ?? null,
        worldSeed: engine.portalManager?.worldSeedValue ?? spec.meta.seed,
        onLevelUp: (gain) => notifyLevelUp(gain),
        // quest wave: an open quest dialogue live-refreshes when its quest
        // completes underneath it (talk objective fired on open). The thunk
        // is lazy — talkSession is constructed just below.
        onQuestsChanged: () => talkSession?.refreshOpenDialogue(),
      })
    : null;
  engine.questManager = quests;
  const gathering = new GatheringManager(engine, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
    inventory: itemKit?.inventory ?? null,
    // crafting wave (A): Studio GATHERING DENSITY slider (spec.custom.crafting)
    // scales the roster on the portal-arrival path — same as the enemy density.
    density: resolveGatheringDensity(spec),
    // skills wave: foraging rank adds a flat deterministic yield bonus;
    // every harvest grants foraging XP. quest wave: harvests also feed
    // gather objectives, counted with the final granted counts.
    yieldBonus: () => skills.harvestYieldBonus(),
    onHarvested: (grant) => {
      skills.onHarvest();
      quests?.onHarvest(grant.materialId, grant.count);
    },
  });
  engine.portalEntities.register(gathering);
  // crafting wave (C): the gathering roster only spawns when crafting is
  // enabled (schema: enabled=false skips node spawn, station placement and
  // the recipe UI; the manager stays registered so the seam is uniform).
  if (craftingEnabled) gathering.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
  // crafting wave (workstream C): world-placeable crafting stations
  // (workbench/anvil/forge/alchemy), map-local lifecycle. Registers with
  // engine.portalEntities ({ id: 'stations' }) so portal transitions
  // despawn/respawn the roster deterministically per map seed — the same
  // contract as the gathering nodes. The station session owns the [E] Use
  // prompt + the crafting panel; the gathering session defers to the open
  // panel so [E] cannot harvest behind it.
  const stations = new StationManager(engine, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
  });
  engine.portalEntities.register(stations);
  if (craftingEnabled) stations.spawnForMap(spec.meta.seed);
  const stationSession = craftingEnabled
    ? new CraftingInteractionSession(engine, stations, {
        recipes: () => buildRecipePool(spec),
        defs: () => spec.custom?.items?.defs ?? {},
        inventory: () => itemKit?.inventory ?? null,
        playerLevel: () => prog.level,
        // skills wave: skillId-gated recipes, craft-speed bonus, craft XP.
        skills: () => skills,
        craftTimeMult: (stationId) => skills.craftTimeMult(stationId ?? undefined),
        onCrafted: (recipe) => {
          skills.onCraft(recipe.stationId);
          // progression-curve: crafts grant player-level XP on the one additive path
          grantCraftXp(prog, notifyLevelUp);
          // quest wave: crafts feed craft objectives
          quests?.onCraft(recipe.id);
        },
        toast: (m) => engine.hud.toast(m),
        // quest wave: the quest dialogue owns E while open so the panel
        // can't open behind it
        isModalOpen: () => talkSession?.isDialogueOpen ?? false,
      })
    : null;
  // quest wave: the [E] Talk prompt + quest dialogue for villagers. The
  // session is manager-based (per-frame refresh), so portal respawns need
  // no special handling; it stamps requires/produces onto the NPC
  // interactables (see engine/game/questTalk.ts). Assigned (not declared)
  // here — the binding was hoisted above the QuestManager construction.
  talkSession = questsEnabled && quests
    ? new QuestTalkSession(engine, npcManager, quests)
    : null;
  const gatheringSession = new GatheringInteractionSession(engine, gathering, {
    isModalOpen: () => (stationSession?.isPanelOpen ?? false) || (talkSession?.isDialogueOpen ?? false),
  });
  // skills wave: the skills panel (K key / SKILLS chip toggle). Never
  // opens while the crafting panel owns input. Not built when skills
  // are disabled in the spec.
  const skillsPanel = resolveSkillsEnabled(spec)
    ? new SkillsPanel({
        container: engine.container,
        skills: () => skills,
        recipes: () => buildRecipePool(spec),
        defs: () => spec.custom?.items?.defs ?? {},
        inventory: () => itemKit?.inventory ?? null,
        stationIds: () => new Set(stations.stationIds()),
        playerLevel: () => prog.level,
        isModalOpen: () => stationSession?.isPanelOpen ?? false,
      })
    : null;
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);
  wrapShieldDamage(engine, avatar, fx); // aegis shield pickup absorbs damage

  // FIX 1: wire projectile impacts to damage (guns dealt zero damage — onHit was never assigned).
  // Campaign: projectile damage scales with the damage upgrade multiplier.
  projectiles.onHit = (p, hitBody, point) => {
    if (p.friendly) {
      const target = enemies.enemies.find((e) => e.alive && e.body === hitBody);
      if (target) { target.damage(p.damage * prog.damageMult(), point); combatPulse(); }
    } else if (hitBody === avatar.ctrl.body) {
      avatar.damage(p.damage, point);
    }
  };

  // --- enemies spawn ringed around spawn
  const spawnFor = (kind: string, i: number, n: number): THREE.Vector3 => {
    for (let tries = 0; tries < 12; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const r = kind === 'turret' ? rng.range(18, 40) : rng.range(12, terrain.size / 2 - 20);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!terrain.inBounds(x, z)) continue;
      return new THREE.Vector3(x, terrain.heightAt(x, z) + 1, z);
    }
    return new THREE.Vector3(rng.range(-20, 20), spawnY + 2, rng.range(-20, 20));
  };
  // --- enemies spawn ringed around spawn, with chapter-0 variants
  const planned = planSpawns(spec.enemies, rng, 0, ACTION_VARIANTS);
  {
    const before = enemies.enemies.length;
    enemies.spawnAll(spec.enemies, spawnFor);
    enemies.enemies.slice(before).forEach((e, idx) => {
      const p = planned[idx];
      variants.register(e, p ? p.variant : null);
      if (p) variants.decorate(e, p.variant);
    });
  }

  // --- pickups
  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    const eff = effectOf(p);
    if (eff) {
      applyPickupEffect(engine, fx, avatar, spec, eff);
    } else {
      if (p.kind === 'coin') { engine.score += Math.round(50 * fx.scoreMult()); engine.audio.play('coin'); objectives.addProgress(1, 'collect'); }
      if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
      if (p.kind === 'ammo') { avatar.addAmmo(24); engine.audio.play('pickup'); }
      if (p.kind === 'powerup') { avatar.ctrl.speedBoostT = 6; engine.audio.play('powerup'); hud.toast('SPEED SURGE'); }
    }
    grantPickupXp(prog, notifyLevelUp);
    hud.setScore(engine.score);
  };
  const half = terrain.size / 2 - 12;
  pickups.scatterTerrain(
    { coin: spec.pickups.coins, health: spec.pickups.health, ammo: spec.pickups.ammo, powerup: spec.pickups.powerups },
    (x, z) => terrain.heightAt(x, z), half, spec.meta.seed,
    [{ x: 0, z: 0, r: 6 }],
  );
  // timed effect pickups: shield / rapid-fire / score×2 / magnet
  scatterEffects(pickups, engine, rng.fork(913), (x, z) => terrain.heightAt(x, z), half,
    ['shield', 'rapid', 'mult', 'magnet'], [{ x: 0, z: 0, r: 8 }]);

  // --- reach objective marker (B2): legacy 'reach' OR any 'reach' stage in a
  // quest chain — staged beacon stages had goalPos === null and could never complete
  let goal: THREE.Group | null = null;
  let goalPos: THREE.Vector3 | null = null;
  if (needsReachGoal(spec)) {
    const gx = rng.range(-half * 0.7, half * 0.7), gz = rng.range(-half * 0.7, half * 0.7);
    goalPos = new THREE.Vector3(gx, terrain.heightAt(gx, gz), gz);
    goal = makeGoalFlag(engine.mats, spec.theme.palette.accent);
    goal.position.copy(goalPos);
    scene.add(goal);
  }

  const objectives = makeCampaignObjectives(engine, spec, undefined, () => prog.level);

  // asset registration: enemies (dynamic roots), pickups, projectiles, city
  registerEnemyAssets(assets, enemies, ['walker', 'drone', 'brute', 'turret'], variants);
  registerPickupAssets(assets, pickups);
  assets.register('weapon.projectile', { kind: 'weapon', materials: [engine.mats.glow(spec.theme.palette.accent, 2.5)] });
  assets.register('world.arena', { kind: 'world', roots: [structures.group] });
  assets.applyOverrides(spec);
  // M6: wire the (cloned, never the shared cache entry) tracer material into
  // the projectile pool so the override actually reaches pixels
  const tracerMat = assets.currentMaterial('weapon.projectile');
  if (tracerMat) projectiles.setTracerMaterial(tracerMat);
  // N1: touch-aware hint bar (title screen already detects touch)
  hud.setHint(isTouchDevice()
    ? 'Left stick move · ATK attack · JUMP jump · DASH dash'
    : 'WASD move · mouse look · LMB attack · Space jump · Shift dash/sprint · Esc pause');
  // N7: crosshair belongs to guns, not melee
  hud.setCrosshair(spec.player.weapon !== 'none');

  // chapter-0 world dressing
  dresser.dress(spec, 0, rng.fork(5000), { cx: 0, cz: 0, half, yAt: (x, z) => terrain.heightAt(x, z) });
  let lastStage = 0;

  // difficulty ramp: each new chapter drops scaled reinforcements (not during boss stages)
  const spawnReinforcements = (stage: number) => {
    if (isBossStageActive(spec, objectives)) return;
    const n = 2 + stage;
    const kinds = spec.enemies.length ? spec.enemies : [{ kind: 'walker' as const, count: 1, health: 30, speed: 4, damage: 10, weapon: 'melee' as const }];
    for (let k = 0; k < n; k++) {
      const plannedR = planSpawns([{ ...kinds[rng.int(0, kinds.length - 1)], count: 1 }], rng, stage, ACTION_VARIANTS)[0];
      const before = enemies.enemies.length;
      enemies.spawnAll([plannedR.spec], () => spawnFor(plannedR.spec.kind, k, n));
      const e = enemies.enemies[before];
      if (e) { variants.register(e, plannedR.variant); variants.decorate(e, plannedR.variant); }
    }
    hud.toast('HOSTILE REINFORCEMENTS');
    engine.audio.play('alarm');
    assets.applyOverrides(spec); // reskin the reinforcements
  };

  // --- camera
  const camRig = makeCameraRig(spec.player.camera, engine.camera, engine.input, (x, z) => engine.terrain.heightAt(x, z),
    { physics: engine.physics, skipBody: avatar.ctrl.body });

  // --- boss aura
  const bossAura = spec.objective.type === 'boss'
    ? new THREE.PointLight(new THREE.Color(spec.theme.palette.accent), 2, 30)
    : null;
  if (bossAura) scene.add(bossAura);
  // polish (LOOK crew): living light — boss aura breathes
  if (bossAura) engine.sky.lightLife.flicker(bossAura, 0.22, 1.8);

  engine.onUpdate((dt) => {
    const t = engine.time;
    // controller's "forward" is (-sin,-cos) but the third-person rig looks along
    // (+sin,+cos): offset by PI so W walks away from the camera
    avatar.ctrl.camYaw = camRig.yaw + Math.PI;
    avatar.update(dt, t);
    itemKit?.update(dt);
    gatheringSession.update(dt); // crafting wave (B): [E] Harvest prompt + registration refresh
    stationSession?.update(dt); // crafting wave (C): [E] Use prompt + crafting panel
    talkSession?.update(dt); // quest wave: [E] Talk prompt + quest dialogue + requires/produces refresh
    quests?.update(dt); // quest wave: explore objectives read the portal transition counter

    // attack input (melee damage scales with the damage upgrade multiplier)
    if (engine.input.justPressed('attack') && engine.state === 'playing') {
      if (spec.player.weapon === 'sword' || spec.player.weapon === 'none') {
        avatar.melee(avatar.ctrl.yaw, 2.6, 1.3, 25 * prog.damageMult() * (itemKit?.damageMult() ?? 1));
      } else {
        // shoot toward camera forward
        const dir = new THREE.Vector3();
        engine.camera.getWorldDirection(dir);
        avatar.shoot(dir);
      }
    }
    if (engine.input.pressed('attack') && spec.player.weapon === 'rifle') {
      const dir = new THREE.Vector3();
      engine.camera.getWorldDirection(dir);
      avatar.shoot(dir);
    }

    // Enemies wave C: one shared instancer frame for the enemy + NPC
    // managers. Both submit into the same per-engine buckets; a single
    // begin/end per update keeps their instance counts accumulating
    // instead of the second manager's beginFrame zeroing the first's.
    const inst = NpcInstancer.for(engine);
    inst.beginFrame(dt);
    enemies.update(dt, avatar.ctrl.position, t);
    npcManager.update(dt); // gameplay wave (B): ambient villagers tick
    gathering.update(dt); // crafting wave (B): static node submits into the shared instancer frame
    stations.update(dt); // crafting wave (C): static station submits into the shared instancer frame
    inst.endFrame();
    variants.update(dt, avatar.ctrl.position, t);
    projectiles.update(dt);
    pickups.update(dt, avatar.ctrl.position, 2.6 * prog.magnetMult() * fx.magnetMult());
    objectives.update(dt);
    fx.tick(dt, spec);
    fxHud.update(fx, t);

    // chapter transitions: fresh dressing, difficulty ramp, boss intro
    const stageIdx = objectives.currentStageIndex;
    if (stageIdx !== lastStage) {
      lastStage = stageIdx;
      dresser.dress(spec, stageIdx, rng.fork(5000 + stageIdx), { cx: 0, cz: 0, half, yAt: (x, z) => terrain.heightAt(x, z) });
      // R4-N1: difficulty keys off chapters cleared (branch-aware), not the
      // quest-graph array index — branch B stages must not be systematically
      // harder than branch A stages on the same chapter.
      const chapter = objectives.stagesCleared;
      variants.applyStageScaling(chapter);
      variants.notifyStage(stageIdx, isBossStageActive(spec, objectives));
      spawnReinforcements(chapter);
    }

    // scatter soft collision for player
    const pp = avatar.ctrl.position;
    scatter.resolve(pp, 0.5);
    avatar.ctrl.body.position.x = pp.x; avatar.ctrl.body.position.z = pp.z;

    // fell out of world
    if (pp.y < -40) { avatar.damage(1000); camRig.shake(0.8); }

    // reach goal check
    if (goalPos && pp.distanceTo(goalPos) < 3.5) objectives.reachedGoal();

    // boss aura follows last living enemy
    if (bossAura) {
      const b = enemies.enemies.find((e) => e.alive);
      if (b) bossAura.position.copy(b.position).add(new THREE.Vector3(0, 3, 0));
    }

    // FIX 5: combat intensity decays to baseline
    combatT = Math.max(0, combatT - dt * 0.25);
    engine.audio.setIntensity(0.35 + combatT * 0.6);
    // boss-fights wave: arena tether + telegraphed attacks + boss bar
    // (the encounter no-ops when the spec's boss flag is off)
    bosses.update(dt, avatar.ctrl.position);

    // camera
    camRig.update(dt, avatar.ctrl.position, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, skills, skillsPanel, npcs: npcManager, gathering, stations, stationSession, gatheringSession, talkSession, quests, questTracker, pickups, objectives, assets, itemKit, itemWorld: itemKit?.itemWorld ?? null, bosses, bossBar, prog };
}
