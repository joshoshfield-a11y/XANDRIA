/**
 * PLATFORMER — side-scroll 3D: floating platform course over a hazard floor, coins on arcs,
 * patrolling walkers, double-jump/dash moveset, goal flag at the summit.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { GatheringManager, GatheringInteractionSession } from '../engine/game/gathering';
import { resolveCraftingEnabled, ensureCraftingItemDefs, buildRecipePool } from '../engine/game/crafting';
import { ensureLootItemDefs } from '../engine/game/loot';
import { StationManager, CraftingInteractionSession } from '../engine/game/stations';
import { SkillSystem, resolveSkillsEnabled } from '../engine/game/skills';
import { SkillsPanel } from '../engine/ui/SkillsPanel';
import { resolveGatheringDensity } from '../engine/game/crafting';
import { QuestManager, buildQuestPool, resolveQuestsEnabled } from '../engine/game/quests';
import { buildSideQuestPool } from '../engine/game/sidequests';
import { QuestTracker } from '../engine/ui/QuestTracker';
import { resolveEnemyDensity } from '../engine/game/enemyTuning';
import { NpcInstancer } from '../engine/game/npcInstancing';
import { Pickups } from '../engine/game/Pickups';
import { Objectives } from '../engine/game/Objectives';
import { Progression } from '../engine/game/Progression';
import {
  makeCampaignObjectives,
  makeLevelUpFlow,
  grantKillXp,
  grantPickupXp,
  registerWorldAssets,
  registerPickupAssets,
  registerEnemyAssets,
} from './campaign';
import { AssetRegistry } from '../engine/game/Assets';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import { VariantDirector } from './enemies';
import {
  EffectState,
  EffectHud,
  spawnEffectPickup,
  applyPickupEffect,
  effectOf,
  wrapShieldDamage,
} from './fx';
import { ChapterDresser, ParallaxLayers } from './dressing';
import { Structures } from '../engine/world/Structures';
import { LandmarkSystem } from '../engine/world/LandmarkSystem';
import { Scatter } from '../engine/world/Scatter';
import { attachLightShafts } from '../engine/gfx/LightShafts';
import { scatterAmberGlow } from '../engine/gfx/AmberGlow';
import { makeGoalFlag } from '../engine/gfx/Characters';
import { PlayerAvatar } from './common';
import { buildItemKit, type BlueprintItemKit } from './itemKit';
import { Rng } from '../engine/core/Rng';

export function buildPlatformer(engine: Engine, spec: GameSpec) {
  const { scene, hud, terrain } = engine;
  const rng = new Rng(spec.meta.seed ^ 0x4a7f);

  // M2: snapshot the pristine run config before any run-time mutation.
  snapshotLoadoutBase(spec);
  // M7: drop stale asset-bridge roots left by the previous run (no-op at boot).
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
  let notifyLevelUp: () => void = () => {};
  // content depth: enemy variants, timed pickup effects, chapter dressing
  const fx = new EffectState();
  const fxHud = new EffectHud();
  const dresser = new ChapterDresser(engine);

  // asset registry (reskin layer): world assets first, the rest after spawns
  const assets = new AssetRegistry();
  registerWorldAssets(assets, engine);

  // world = mostly visual; course floats above a hazard
  const startY = Math.max(3, terrain.heightAt(-terrain.size / 2 + 14, 0) + 3);
  const start = new THREE.Vector3(-terrain.size / 2 + 14, startY, 0);
  const dir = new THREE.Vector3(1, 0, 0.08);

  // background parallax layers (distant ridges drifting with the camera)
  const parallax = new ParallaxLayers(engine, rng.fork(4242), spec, startY);

  const structures = new Structures(engine.physics, engine.mats);
  const difficulty = spec.rules.difficulty;
  const gapBoost = difficulty === 'hard' ? 1.2 : difficulty === 'easy' ? 0.8 : 1;
  const platforms = structures.platforms(spec.meta.seed, 26, start, dir, {
    gapMin: 3.2 * gapBoost,
    gapMax: 5.2 * gapBoost,
    sizeMin: difficulty === 'hard' ? 2.2 : 2.8,
    sizeMax: 4.6,
    riseMax: difficulty === 'easy' ? 1.1 : 1.7,
  });
  scene.add(structures.group);

  // hazard floor: lava/void plane far below
  const hazardY = startY - 22;
  const hazard = new THREE.Mesh(
    new THREE.PlaneGeometry(terrain.size * 2, terrain.size * 2),
    engine.mats.standard('lava', spec.theme.environment === 'volcanic' ? '#ff4a1f' : '#1a0f2e', {
      emissive: spec.theme.environment === 'volcanic' ? '#ff3300' : '#6a3fd8',
      emissiveIntensity: 0.9,
    }),
  );
  hazard.rotation.x = -Math.PI / 2;
  hazard.position.y = hazardY;
  scene.add(hazard);
  const hazardLight = new THREE.PointLight(spec.theme.environment === 'volcanic' ? '#ff5a2f' : '#7a4fe8', 1.4, 90);
  hazardLight.position.set(start.x + 40, hazardY + 8, 0);
  scene.add(hazardLight);
  // polish (LOOK crew): living light — flickering hazard glow, pulsing lava
  engine.sky.lightLife.flicker(hazardLight, 0.3, 2.6);
  engine.sky.lightLife.pulse(hazard.material as THREE.MeshStandardMaterial, 0.18, 1.4);
  engine.sky.lightLife.pulse(engine.mats.glow(spec.theme.palette.accent, 1.8), 0.14, 1.6); // crystal shards
  engine.sky.lightLife.pulse(engine.mats.glow('#ffffff', 1.2), 0.2, 2.2); // wisps

  // beauty wave: per-genre hero props (floating shards + wisps along the course)
  // env-art pass: blocky landmarks + amber glow accents, sun-aligned water glint.
  // Landmarks come before scatter so hero specimen plants can ring them (wave 2B).
  // Portal-backlog wave: landmarks (+ structure sets) are a map-local entity
  // system (id 'landmarks') — despawned on portal departure, rebuilt from
  // the derived map seed on arrival.
  const landmarks = new LandmarkSystem(engine, {
    exclusion: [],
    exclusionSets: [{ x: 0, z: 0, r: 12 }], // platformer's original split: no exclusion on landmarks, r=12 on sets
  });
  engine.portalEntities.register(landmarks);
  landmarks.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
  const scatter = new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    heroesOnly: true,
    quality: engine.effectiveQuality(),
    densityMul: engine.tiers.flags.densityMul, // graphics wave 2 (E): tier scatter density
    windMul: engine.tiers.flags.windMul, // graphics wave 2 (E): tier wind-sway intensity
    heroSpots: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })), // wave 2B: hero plants
  });
  // (graphics wave 2 structure sets now inside LandmarkSystem — portal-safe)

  scatterAmberGlow(scene, rng.fork(0xe9a1), {
    mats: engine.mats,
    groundY: (x, z) => terrain.heightAt(x, z),
    half: terrain.size / 2 - 10,
    quality: engine.effectiveQuality(),
  });
  terrain.setWaterSun(
    engine.sky.sun.position.clone().sub(engine.sky.sun.target.position).normalize(),
    spec.theme.timeOfDay === 'dusk' || spec.theme.timeOfDay === 'dawn' ? '#ffb46b' : '#cfe8ff',
  );
  // polish wave: cheap god-ray-ish light shafts (quality-scaled, day/dusk only)
  attachLightShafts(engine);

  // goal at final platform
  const last = platforms[platforms.length - 1];
  const goal = makeGoalFlag(engine.mats, spec.theme.palette.accent);
  goal.position.copy(last.pos);
  scene.add(goal);

  // player
  const projectiles = null;
  let avatar: PlayerAvatar;
  const enemies = new EnemyManager(engine, null, {
    onPlayerHit: (dmg, from) => avatar.damage(dmg, from),
    // platformer has no player weapons; walkers are stompable hazards —
    // if one dies (stomp/hazard/fall), it still feeds the XP economy, and
    // kills now count toward kill stages too (B1: onDeath never reported)
    onDeath: (e) => {
      variants.onEnemyDeath(e);
      engine.score += Math.round(100 * fx.scoreMult());
      hud.setScore(engine.score);
      // N6: grant XP before recording the kill — addProgress may end the run
      // (engine.win), and the level-up modal must never open over the end screen
      grantKillXp(prog, notifyLevelUp, e.xpMult);
      objectives.addProgress(1, 'kill');
      quests?.onKill(e.spec.kind); // quest wave: kills feed kill objectives
    },
  }, {
    // enemies wave (A): map-local lifecycle — portal departures despawn live
    // enemies AND mid-tumble corpses; arrivals respawn the deterministic
    // landmark-ringed roster per map seed.
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
    // enemies wave (C): Studio ENEMY DENSITY slider (spec.custom.enemies)
    // scales every spec count on the portal-arrival path.
    // UPGRADE LOOP (enemy-scaling): live player level feeds the spawn stat band.
    playerLevel: () => prog.level,
    density: resolveEnemyDensity(spec, engine.tiers.tier),
  });
  engine.portalEntities.register(enemies);
  // enemy variants: spikeballs (never stomp) + skyrays (sine patrol)
  const variants = new VariantDirector(engine, enemies, null, 31337);
  avatar = new PlayerAvatar(engine, spec, start.clone().add(new THREE.Vector3(0, 2, 0)), enemies, projectiles);
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
  // quest wave: the main-story quest line (player-scoped, never in
  // portalEntities — survives portal travel by construction). No villagers
  // in this genre, so the line auto-accepts and auto-turns-in.
  const questsEnabled = resolveQuestsEnabled(spec);
  const questTracker = questsEnabled ? new QuestTracker(engine.container) : null;
  // HUD-polish: keep the touch pause button clear of the tracker when quests re-render.
  if (questTracker) questTracker.onRender = () => engine.touch.repositionPauseButton();
  const quests = questsEnabled
    ? new QuestManager({
        defs: [...buildQuestPool(spec, { includeTalk: false }),
          // side-quests wave: independent side quests ride the same
          // manager (available from the start, no chaining).
          ...buildSideQuestPool(spec, { includeTalk: false })],
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
        autoAccept: true,
        onLevelUp: () => notifyLevelUp(),
      })
    : null;
  engine.questManager = quests;
  // crafting wave (workstream B): harvestable gathering nodes (ore veins,
  // fiber plants, salvage caches), map-local lifecycle. The manager
  // registers itself with engine.portalEntities ({ id: 'gathering' }) so
  // portal transitions despawn/respawn the node roster deterministically
  // per map seed. Depleted state is NOT persisted across portals (design).
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
          // quest wave: crafts feed craft objectives
          quests?.onCraft(recipe.id);
        },
        toast: (m) => engine.hud.toast(m),
      })
    : null;
  const gatheringSession = new GatheringInteractionSession(engine, gathering, {
    isModalOpen: () => stationSession?.isPanelOpen ?? false,
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

  // walkers patrol the bigger platforms — some are spikeballs (stomping hurts!)
  const patrolPlatforms = platforms.filter((p, i) => i > 2 && i < platforms.length - 2 && p.size.x > 3.4);
  const walkers = spec.enemies.filter((e) => e.kind === 'walker');
  const nEnemies = Math.min(patrolPlatforms.length, walkers.reduce((n, e) => n + e.count, 0) || 4);
  for (let i = 0; i < nEnemies; i++) {
    const p = patrolPlatforms[Math.floor((i / nEnemies) * patrolPlatforms.length)];
    const variant = rng.chance(0.35) ? 'spikeball' : null;
    const before = enemies.enemies.length;
    enemies.spawnAll([{ kind: 'walker', count: 1, health: 25, speed: 2.5, damage: 10, weapon: 'melee' }], () => p.pos.clone().add(new THREE.Vector3(0, 1, 0)));
    const e = enemies.enemies[before];
    if (e) { variants.register(e, variant); variants.decorate(e, variant); }
  }

  // skyrays: sine-patrolling flyers over the later platforms
  const rayPlatforms = platforms.filter((p, i) => i > Math.floor(platforms.length * 0.4) && i < platforms.length - 1);
  const nRays = Math.min(3, Math.max(1, Math.floor(rayPlatforms.length / 4)));
  for (let i = 0; i < nRays; i++) {
    const p = rayPlatforms[Math.floor(((i + 0.5) / nRays) * rayPlatforms.length)];
    const before = enemies.enemies.length;
    enemies.spawnAll([{ kind: 'flyer', count: 1, health: 30, speed: 4, damage: 8, weapon: 'blaster' }], () => p.pos.clone().add(new THREE.Vector3(0, 0.1, 0)));
    const e = enemies.enemies[before];
    if (e) { variants.register(e, 'skyray'); variants.decorate(e, 'skyray'); }
  }

  // coins along jump arcs between platforms
  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    const eff = effectOf(p);
    if (eff) {
      applyPickupEffect(engine, fx, avatar, spec, eff);
    } else {
      if (p.kind === 'coin') {
        engine.score += Math.round(50 * fx.scoreMult());
        engine.audio.play('coin');
        hud.setScore(engine.score);
        // B1: route by current stage type, not the legacy objective type
        objectives.addProgress(1, 'collect');
      }
      if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
    }
    grantPickupXp(prog, notifyLevelUp);
  };
  for (let i = 0; i < platforms.length - 1; i++) {
    const a = platforms[i].pos, b = platforms[i + 1].pos;
    const n = Math.max(2, Math.floor(a.distanceTo(b) / 1.6));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const p = a.clone().lerp(b, t);
      p.y += Math.sin(t * Math.PI) * 1.6 + 0.8; // arc
      pickups.spawn('coin', p);
    }
  }
  // health mid-course
  const mid = platforms[Math.floor(platforms.length / 2)];
  pickups.spawn('health', mid.pos.clone().add(new THREE.Vector3(0, 1.2, 0)));
  // timed effect pickups on later platforms: magnet + shield
  const q1 = platforms[Math.floor(platforms.length * 0.3)];
  const q3 = platforms[Math.floor(platforms.length * 0.7)];
  spawnEffectPickup(pickups, engine, 'magnet', q1.pos.clone().add(new THREE.Vector3(0, 1.2, 0)));
  spawnEffectPickup(pickups, engine, 'shield', q3.pos.clone().add(new THREE.Vector3(0, 1.2, 0)));

  // asset registration: enemies (dynamic roots), pickups, platforms, hazard
  registerEnemyAssets(assets, enemies, ['walker', 'flyer'], variants);
  registerPickupAssets(assets, pickups);
  assets.register('world.platform', { kind: 'world', roots: [structures.group, hazard] });
  assets.applyOverrides(spec);

  // clamp collect targets (legacy or staged) to coins actually placed on the course
  const clampCollect = (count: number) => Math.min(count || 20, pickups.remaining('coin'));
  const objSpec = spec.objective.stages
    ? { ...spec.objective, stages: spec.objective.stages.map((s) => s.type === 'collect' ? { ...s, count: clampCollect(s.count) } : s) }
    : spec.objective.type === 'collect'
      ? { ...spec.objective, count: clampCollect(spec.objective.count) }
      : spec.objective;
  const objectives = makeCampaignObjectives(engine, { ...spec, objective: objSpec }, undefined, () => prog.level);
  // N1: touch-aware hint bar
  hud.setHint(isTouchDevice()
    ? 'D-pad move · JUMP jump (x2) · reach the flag · stomp foes (not the spiky ones!)'
    : 'A/D move · Space jump (x2) · Shift dash · reach the flag · stomp foes (not the spiky ones!)');

  // chapter-0 floating dressing (crystals drift near the course)
  const courseCx = start.x + 60;
  dresser.dress(spec, 0, rng.fork(5000), {
    cx: courseCx, cz: 0, half: 70,
    yAt: () => startY,
  }, { floating: true });
  let lastStage = 0;

  const camRig = makeCameraRig('side', engine.camera, engine.input, undefined,
    { physics: engine.physics, skipBody: avatar.ctrl.body });

  engine.onUpdate((dt) => {
    const t = engine.time;
    // side camera sits at +z looking -z, so screen-right is world +x:
    // camYaw = 0 maps D to +x (the old -PI/2 sent D into the screen)
    avatar.ctrl.camYaw = 0;
    avatar.update(dt, t);
    itemKit?.update(dt);
    gatheringSession.update(dt); // crafting wave (B): [E] Harvest prompt + registration refresh
    quests?.update(dt); // quest wave: explore objectives read the portal transition counter
    stationSession?.update(dt); // crafting wave (C): [E] Use prompt + crafting panel
    // Enemies wave C: the blueprint drives the shared instancer frame
    // (single begin/end per update — see tpAction).
    const inst = NpcInstancer.for(engine);
    inst.beginFrame(dt);
    enemies.update(dt, avatar.ctrl.position, t);
    gathering.update(dt); // crafting wave (B): static node submits into the shared instancer frame
    stations.update(dt); // crafting wave (C): static station submits into the shared instancer frame
    inst.endFrame();
    variants.update(dt, avatar.ctrl.position, t);
    pickups.update(dt, avatar.ctrl.position, 2.6 * prog.magnetMult() * fx.magnetMult());
    objectives.update(dt);
    fx.tick(dt, spec);
    fxHud.update(fx, t);
    parallax.update(engine.camera.position.x);

    // chapter transitions: fresh dressing + difficulty ramp
    const stageIdx = objectives.currentStageIndex;
    if (stageIdx !== lastStage) {
      lastStage = stageIdx;
      dresser.dress(spec, stageIdx, rng.fork(5000 + stageIdx), {
        cx: courseCx, cz: 0, half: 70,
        yAt: () => startY,
      }, { floating: true });
      // R4-N1: difficulty keys off chapters cleared (branch-aware), not the quest-graph array index.
      variants.applyStageScaling(objectives.stagesCleared);
    }

    const pp = avatar.ctrl.position;

    // stomp: falling onto a foe kills it — unless it's a spikeball, which hurts
    if (avatar.ctrl.velocity.y < -3 && engine.state === 'playing') {
      for (const e of enemies.enemies) {
        if (!e.alive) continue;
        const ep = e.position;
        if (Math.hypot(pp.x - ep.x, pp.z - ep.z) < 1.3 && pp.y > ep.y + 0.9 && pp.y < ep.y + 2.8) {
          if (variants.getVariant(e) === 'spikeball') {
            avatar.damage(18, ep);
            engine.audio.play('hurt');
          } else {
            e.damage(9999, pp);
            engine.audio.play('hit');
          }
          avatar.ctrl.body.velocity.y = 9; // bounce
          break;
        }
      }
    }
    if (pp.y < hazardY + 2) {
      avatar.damage(34);
      // bounce back to last platform
      let best = platforms[0].pos, bd = Infinity;
      for (const p of platforms) {
        if (p.pos.y > pp.y) continue;
        const d = Math.abs(p.pos.x - pp.x);
        if (d < bd) { bd = d; best = p.pos; }
      }
      avatar.ctrl.teleport(best.clone().add(new THREE.Vector3(0, 2, 0)));
      engine.audio.play('hurt');
    }
    if (pp.distanceTo(goal.position) < 3) objectives.reachedGoal();

    camRig.update(dt, pp, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, skills, skillsPanel, gathering, stations, stationSession, gatheringSession, quests, questTracker, pickups, objectives, assets, itemKit, itemWorld: itemKit?.itemWorld ?? null };
}
