/**
 * FPS ARENA — pointer-lock first-person shooter in a walled arena. Waves of drones/walkers,
 * cover crates, ammo/health economy, survive N waves.
 */
import * as THREE from 'three';
import type { GameSpec, EnemySpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { GatheringManager, GatheringInteractionSession } from '../engine/game/gathering';
import { resolveCraftingEnabled, ensureCraftingItemDefs, buildRecipePool } from '../engine/game/crafting';
import { ensureLootItemDefs } from '../engine/game/loot';
import { ensureSetItemDefs } from '../engine/game/setBonuses';
import { ensureEnchantItemDefs } from '../engine/game/enchantments';
import { StationManager, CraftingInteractionSession } from '../engine/game/stations';
import { SkillSystem, resolveSkillsEnabled } from '../engine/game/skills';
import { CRIT_PROJECTILE_SALT, CritRoller, applyCrit, synergyCritCtx } from '../engine/game/crit';
import { displayedDamage } from '../engine/game/elemental';
import { wireCombatAbilities } from '../engine/game/combatAbilities';
import { BestiaryManager, BESTIARY_TIER_NAMES } from '../engine/game/bestiary';
import { SkillsPanel } from '../engine/ui/SkillsPanel';
import { AchievementsPanel } from '../engine/ui/AchievementsPanel';
import { AchievementManager } from '../engine/game/achievements';
import { BestiaryPanel } from '../engine/ui/BestiaryPanel';
import { resolveGatheringDensity } from '../engine/game/crafting';
import { QuestManager, buildQuestPool, resolveQuestsEnabled } from '../engine/game/quests';
import { NpcManager } from '../engine/game/NpcManager';
import { QuestTalkSession } from '../engine/game/questTalk';
import {
  Wallet,
  CURRENCY_NAME,
  DEFAULT_SELL_MULT,
  VENDOR_SALT,
  resolveVendorDefs,
  buildVendorNpcSpecs,
} from '../engine/game/economy';
import { ShopPanel } from '../engine/ui/ShopPanel';
import { buildSideQuestPool } from '../engine/game/sidequests';
import { QuestTracker } from '../engine/ui/QuestTracker';
import { RadiantBoard } from '../engine/game/radiantQuests';
import { RadiantBoardPanel } from '../engine/ui/RadiantBoardPanel';
import { TimedBoard } from '../engine/game/timedQuests';
import { TimedBoardPanel } from '../engine/ui/TimedBoardPanel';
import { resolveEnemyDensity } from '../engine/game/enemyTuning';
import { resolveEliteChance } from '../engine/game/eliteAffixes';
import { NpcInstancer } from '../engine/game/npcInstancing';
import { Projectiles } from '../engine/game/Projectiles';
import { Pickups } from '../engine/game/Pickups';
import { Objectives } from '../engine/game/Objectives';
import { Progression } from '../engine/game/Progression';
import type { LevelGain } from '../engine/game/progressionCurve';
import { AssetRegistry } from '../engine/game/Assets';
import {
  makeCampaignObjectives,
  makeLevelUpFlow,
  grantKillXp,
  grantPickupXp,
  grantCraftXp,
  bossPhaseBanner,
  bossQuotaDeficit,
  registerWorldAssets,
  registerPickupAssets,
  registerEnemyAssets,
} from './campaign';
import { snapshotLoadoutBase } from '../engine/game/Profile';
import { isTouchDevice } from '../engine/game/TouchControls';
import {
  VariantDirector,
  planSpawns,
  isBossStageActive,
  ARENA_VARIANTS,
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
import { Structures } from '../engine/world/Structures';
import { LandmarkSystem } from '../engine/world/LandmarkSystem';
import { Scatter } from '../engine/world/Scatter';
import { attachLightShafts } from '../engine/gfx/LightShafts';
import { scatterAmberGlow } from '../engine/gfx/AmberGlow';
import { PlayerAvatar } from './common';
import { buildItemKit, type BlueprintItemKit } from './itemKit';
import { wireBossFights } from './bosses';

export function buildFpsArena(engine: Engine, spec: GameSpec) {
  const { scene, terrain, hud, input } = engine;
  const rng = engine.rng.fork(202);
  const arenaR = Math.min(46, terrain.size / 2 - 12);

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
    // SKILL-SYNERGIES: persist ranks per seed (the save/reload leg);
    // synergies derive from ranks, so they persist with them.
    persist: true,
    onRankUp: (def, rank) => {
      engine.hud.toast(`${def.name} rank ${rank}!`);
    },
  });
  // bestiary wave: enemy codex kill tracker. Blueprint-owned like skills —
  // rides the live object across portal transitions (NOT a portal entity).
  // Taps the existing onKill hook (observe-only); no enemy contract change.
  // Panel is assigned below (after skillsPanel) so unlock toasts refresh it.
  let bestiaryPanel: BestiaryPanel | null = null;
  const bestiary = new BestiaryManager(engine, {
    onUnlocked: (def, tier, kills) => {
      engine.hud.toast(
        `\u{1F4D6} Bestiary: ${def.name} \u2014 ${BESTIARY_TIER_NAMES[tier]} (${kills} kill${kills === 1 ? '' : 's'})`,
      );
      bestiaryPanel?.refresh();
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

  // arena: perimeter + cover
  const structures = new Structures(engine.physics, engine.mats);
  structures.arenaWalls(new THREE.Vector3(0, terrain.heightAt(0, 0), 0), arenaR, 5);
  structures.arenaCover(spec, terrain, spec.rules.difficulty === 'hard' ? 26 : 20, arenaR - 6, spec.meta.seed);
  scene.add(structures.group);

  // visual wall ring glow (neon arenas)
  if (spec.theme.environment === 'neon-city' || spec.theme.environment === 'space-station') {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(arenaR, 0.18, 6, 64),
      engine.mats.glow(spec.theme.palette.accent, 2),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = terrain.heightAt(0, 0) + 5.2;
    scene.add(ring);
    // polish (LOOK crew): living light — the neon ring breathes
    engine.sky.lightLife.pulse(engine.mats.glow(spec.theme.palette.accent, 2), 0.12, 1.5);
  }

  // beauty wave: per-genre hero props (pylons + cover crates); the arena
  // dressing above stays untouched, this only adds scatter
  // env-art pass: blocky landmarks + amber glow accents, sun-aligned water glint.
  // Landmarks come before scatter so hero specimen plants can ring them (wave 2B).
  // Portal-backlog wave: landmarks (+ structure sets) are a map-local entity
  // system (id 'landmarks') — despawned on portal departure, rebuilt from
  // the derived map seed on arrival.
  const landmarks = new LandmarkSystem(engine, { exclusion: [{ x: 0, z: 0, r: 10 }] });
  engine.portalEntities.register(landmarks);
  landmarks.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
  const scatter = new Scatter(spec, terrain, engine.mats, engine.physics, scene, {
    heroesOnly: true,
    exclusion: [{ x: 0, z: 0, r: 10 }],
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
    exclusion: [{ x: 0, z: 0, r: 10 }],
    quality: engine.effectiveQuality(),
  });
  terrain.setWaterSun(
    engine.sky.sun.position.clone().sub(engine.sky.sun.target.position).normalize(),
    spec.theme.timeOfDay === 'dusk' || spec.theme.timeOfDay === 'dawn' ? '#ffb46b' : '#cfe8ff',
  );
  // polish (LOOK crew): living light — neon pylons hum
  engine.sky.lightLife.pulse(engine.mats.glow(spec.theme.palette.accent, 2.2), 0.16, 2.1);
  // polish wave: cheap god-ray-ish light shafts (quality-scaled, day/dusk only)
  attachLightShafts(engine);

  const projectiles = new Projectiles(engine, spec.theme.palette.accent);
  let avatar: PlayerAvatar;

  // FIX 5: combat music intensity — pulsed up by combat events, decays to baseline
  let combatT = 0;
  const combatPulse = () => { combatT = 1; };

  const enemies = new EnemyManager(engine, projectiles, {
    // STATUS-EFFECTS: a landed melee hit may status the player (kind-gated).
    onPlayerHit: (dmg, from, kind) => { const landed = avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); if (landed) avatar.tryStatusFromEnemyHit(kind, engine.time); },
    onDeath: (e) => {
      variants.onEnemyDeath(e); // splitter minis + visual cleanup first
      engine.score += Math.round(100 * fx.scoreMult());
      hud.setScore(engine.score);
      // N6: grant XP before recording the kill — addProgress may end the run
      // (engine.win), and the level-up modal must never open over the end screen
      grantKillXp(prog, notifyLevelUp, e.xpMult);
      objectives.addProgress(1, 'kill');
      quests?.onKill(e.spec.kind); // quest wave: kills feed kill objectives
      combatPulse();
      const d = e.position.distanceTo(avatar.ctrl.position);
      if (d < 14) camRig.shake(0.6 * (1 - d / 14));
      if (rng.chance(0.25)) pickups.spawn(rng.chance(0.5) ? 'ammo' : 'health', e.position.clone().add(new THREE.Vector3(0, 0.5, 0)));
      else if (rng.chance(0.12)) {
        // rare effect drop: shield / rapid / score×2 / magnet
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
    // UPGRADE LOOP (difficulty-modes): player difficulty mode feeds spawn stat scaling.
    difficulty: () => engine.getDifficultyMode(),
    // UPGRADE LOOP (daily-mutators): live daily run's mutator set feeds spawn stat scaling.
    mutators: () => engine.getDailyMutators(),
    ngPlus: () => engine.getNgPlusCycle(),
    // UPGRADE LOOP (elite-affixes): spec elite chance (default 0 = no elites).
    eliteChance: () => resolveEliteChance(spec),

    density: resolveEnemyDensity(spec, engine.tiers.tier),
  });
  engine.portalEntities.register(enemies);
  // enemy variants: chargers, snipers, splitters layered over the base kinds
  const variants = new VariantDirector(engine, enemies, projectiles);

  avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, terrain.heightAt(0, 0) + 2, 0), enemies, projectiles);
  // COMBAT-ABILITIES: same wiring as tpAction; aim is the camera forward
  // (the FPS shoot convention) projected to the ground plane.
  const abilities = wireCombatAbilities(engine, spec, avatar, enemies, {
    damageMult: () => prog.damageMult() * (itemKit?.damageMult() ?? 1),
    // CRIT-SYSTEM: ability crits scale with equipped weapon tier + smithing rank.
    critCtx: () => {
      // SKILL-SYNERGIES: synergy crit bonuses ride the crit context so
      // melee/projectile/ability rolls use the same math as the HUD.
      const cb = skills.synergyCritBonuses();
      return {
        tier: itemKit?.equippedWeaponRarity() ?? null,
        skillRank: skills.rankOf('smithing'),
        synergyChanceBonus: cb.chanceBonus,
        synergyMultiplierBonus: cb.multiplierBonus,
      };
    },
  });
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
  // Gear sets wave: set-piece item defs (additive, idempotent).
  ensureSetItemDefs(spec);
  // UPGRADE LOOP (blueprint-rollout): vendor-economy parity with tpAction.
  // The player-scoped currency wallet (survives portals by construction --
  // never in portalEntities; the PortalState snapshot carries the balance
  // for rebuild paths). engine.wallet exposes it to PortalManager.portalParts().
  const wallet = new Wallet();
  engine.wallet = wallet;
  wallet.onChange = () => engine.hud.setCurrency(wallet.balance);
  // Merchant NPCs get their OWN map-local roster (id 'vendors', VENDOR_SALT
  // stream) -- one NpcManager, so seeded spawn streams stay isolated from
  // every other system. The QuestTalkSession below dispatches their [E]
  // activation to the shop panel instead of the quest dialogue.
  const vendorDefs = resolveVendorDefs(spec);
  const vendorManager = new NpcManager(engine, {
    id: 'vendors',
    salt: VENDOR_SALT,
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
    specs: buildVendorNpcSpecs(vendorDefs),
    count: vendorDefs.length,
  });
  engine.portalEntities.register(vendorManager);
  vendorManager.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
  // inventory-qol parity: sell-junk hooks ride the vendor-economy wallet
  // (DEFAULT_SELL_MULT -- the same rate the shop panel pays). The wallet
  // is player-scoped, so sell credits land in the same balance the shop
  // and kill-drops use.
  // Enchantments wave: enchant-material item defs (additive, idempotent).
  ensureEnchantItemDefs(spec);
  const itemKit: BlueprintItemKit | null = buildItemKit(engine, spec, avatar, {
    sell: { addScrap: (n) => wallet.add(n), sellMult: DEFAULT_SELL_MULT },
    // CRIT-SYSTEM: inventory panel's CRIT STATS section reads smithing rank here.
    smithingRank: () => skills.rankOf('smithing'),
    // SKILL-SYNERGIES: the inventory HUD's CRIT STATS section reads the
    // same synergy bonuses the damage rolls use.
    synergyCrit: () => skills.synergyCritBonuses(),
  });
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
      // UPGRADE LOOP (blueprint-rollout): seeded scrap payouts ride the
      // separate currency stream (EnemyAI); the wallet is player-scoped,
      // so kills bank scrap that survives portal travel.
      onCurrency: (amount, _pos) => {
        wallet.add(amount);
        engine.hud.toast(`+${amount} ${CURRENCY_NAME}`);
      },
    };
  }
  // quest wave: the main-story quest line (player-scoped, never in
  // portalEntities — survives portal travel by construction). No villagers
  // in this genre, so the line auto-accepts and auto-turns-in.
  // UPGRADE LOOP (blueprint-rollout): hoisted for the shop panel's
  // isModalOpen chain (assigned below, after the panel is constructed).
  let talkSession: QuestTalkSession | null = null;
  // radiant-quests wave: hoisted so the manager's onQuestsChanged thunk
  // (which syncs the board) can reference them before construction.
  let radiantBoard: RadiantBoard | null = null;
  let radiantBoardPanel: RadiantBoardPanel | null = null;
  let timedBoard: TimedBoard | null = null;
  let timedBoardPanel: TimedBoardPanel | null = null;
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
        onLevelUp: (gain) => notifyLevelUp(gain),
        onQuestsChanged: () => { radiantBoard?.sync(); radiantBoardPanel?.render(); timedBoard?.sync(); timedBoardPanel?.render(); },
      })
    : null;
  engine.questManager = quests;
  // radiant-quests wave: the endless board over the same manager. Offers
  // generate from the live player level + portal world seed (not the spec
  // seed alone), register as available radiant defs, and re-roll
  // deterministically when a slot is abandoned or turned in. Accept /
  // abandon / turn-in all ride the manager's existing methods, so the
  // story/side lifecycle is untouched.
  radiantBoard = questsEnabled && quests
    ? new RadiantBoard({
        manager: quests,
        spec,
        getPlayerLevel: () => prog.level,
        getMapSeed: () => engine.portalManager?.worldSeedValue ?? spec.meta.seed,
        onChanged: () => radiantBoardPanel?.render(),
      })
    : null;
  // timed-quests wave: the clock board over the same manager. Offers
  // generate from the live portal world seed, register as available
  // timed defs, and re-roll deterministically when a slot is
  // abandoned or turned in; failed slots stay for Try again.
  // Construction precedes the radiant panel on purpose:
  // registering the timed defs fires onQuestsChanged, and no
  // panel may render while a board is still being constructed.
  timedBoard = questsEnabled && quests
    ? new TimedBoard({
        manager: quests,
        spec,
        getMapSeed: () => engine.portalManager?.worldSeedValue ?? spec.meta.seed,
        onChanged: () => timedBoardPanel?.render(),
      })
    : null;
  radiantBoardPanel = questsEnabled && radiantBoard
    ? new RadiantBoardPanel({
        container: engine.container,
        board: () => radiantBoard,
        isModalOpen: () => talkSession?.isDialogueOpen ?? false,
      })
    : null;

  timedBoardPanel = questsEnabled && timedBoard
    ? new TimedBoardPanel({
        container: engine.container,
        board: () => timedBoard,
        isModalOpen: () => talkSession?.isDialogueOpen ?? false,
      })
    : null;

  // achievements wave: player-scoped achievement manager (observe-only).
  // Built here so the station session's onCrafted chain below can feed it
  // crafts; the codex panel is constructed after the modal sessions.
  const achievements = new AchievementManager({
    hooks: engine.hooks,
    toast: (m, s) => engine.hud.toast(m, s),
    progression: () => prog,
    quests: () => quests,
    portalHooks: () => engine.portalManager?.hooks ?? null,
    avatarPos: () => engine.portalsPlayerAvatar?.ctrl.position ?? null,
    addScore: (n) => {
      engine.score += n;
      engine.hud.setScore(engine.score);
    },
    // progression-curve: reward XP that levels the player opens the
    // level-up flow, like every other XP source (lazy — notifyLevelUp is
    // assigned below, same as QuestManager's onLevelUp).
    onLevelUp: (gain) => notifyLevelUp(gain),
  });
  engine.achievementManager = achievements;
  // run-journal wave: publish Progression so the engine's run journal
  // can read the run's total XP at run end (observe-only).
  engine.progression = prog;
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
  // boss-fights wave: data-driven boss encounters (seeded arena, telegraphed
  // attacks, boss bar). Map-local lifecycle via engine.portalEntities
  // (id 'boss'); the arena + scheduler run only when the spec's boss flag
  // is enabled (default: any boss objective stage).
  const { encounter: bosses, bar: bossBar } = wireBossFights(engine, spec, {
    manager: enemies,
    terrain,
    // STATUS-EFFECTS: boss hits are brute-kind (burn) on the player-status table.
    onPlayerHit: (dmg, from) => { const landed = avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); if (landed) avatar.tryStatusFromEnemyHit('brute', engine.time); },
  });
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
          // achievements wave: crafts feed craft achievements (observe-only)
          achievements.onCraft(recipe);
        },
        toast: (m) => engine.hud.toast(m),
      })
    : null;
  // UPGRADE LOOP (blueprint-rollout): vendor-economy parity -- the shop
  // panel (buy/sell tabs, seeded per-map stock). The QuestTalkSession covers
  // the vendor roster only (no villagers in this genre) and dispatches vendor
  // [E] activation to the shop panel instead of the quest dialogue. Modal
  // arbitration mirrors tpAction.
  const shopPanel = new ShopPanel({
    container: engine.container,
    inventory: () => itemKit?.inventory ?? null,
    wallet: () => wallet,
    defs: () => spec.custom?.items?.defs ?? {},
    vendorDefs: () => vendorDefs,
    toast: (m) => engine.hud.toast(m),
    isModalOpen: () => (stationSession?.isPanelOpen ?? false) || (talkSession?.isDialogueOpen ?? false),
  });
  // keep an open shop live-synced with wallet/inventory changes
  wallet.onChange = () => {
    engine.hud.setCurrency(wallet.balance);
    shopPanel.refresh();
  };
  const invForShop = itemKit?.inventory ?? null;
  if (invForShop) {
    const prevOnChange = invForShop.onChange;
    invForShop.onChange = () => { prevOnChange?.(); shopPanel.refresh(); };
  }
  talkSession = questsEnabled && quests
    ? new QuestTalkSession(engine, [vendorManager], quests, {
        openVendor: (npc) => shopPanel.openForVendor({
          vendorId: npc.vendorId!,
          spawnSeed: npc.spawnSeed,
          keeperName: npc.name,
        }),
      })
    : null;
  const gatheringSession = new GatheringInteractionSession(engine, gathering, {
    isModalOpen: () => (stationSession?.isPanelOpen ?? false) || (talkSession?.isDialogueOpen ?? false) || shopPanel.isOpen,
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
  // achievements wave: the achievement codex panel (J key / trophy chip).
  // Never opens while the crafting panel (or quest dialogue, where one
  // exists) owns input.
  const achievementsPanel = new AchievementsPanel({
    container: engine.container,
    achievements: () => achievements,
    isModalOpen: () => stationSession?.isPanelOpen ?? false,
  });
  // bestiary wave: the codex panel (B key / BESTIARY chip toggle). Never
  // opens while the crafting panel or the skills panel owns input.
  bestiaryPanel = new BestiaryPanel({
    container: engine.container,
    bestiary: () => bestiary,
    defs: () => spec.custom?.items?.defs ?? {},
    isModalOpen: () => stationSession?.isPanelOpen ?? false,
    otherOpen: () => skillsPanel?.isOpen ?? false,
  });
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);
  wrapShieldDamage(engine, avatar, fx); // aegis shield pickup absorbs damage

  // FIX 1: wire projectile impacts to damage (guns dealt zero damage — onHit was never assigned).
  // Player projectiles damage the enemy owning the hit body; enemy projectiles damage the player.
  // Campaign: projectile damage scales with the damage upgrade multiplier.
  // CRIT-SYSTEM: friendly projectiles roll crits on their own seeded stream.
  const projCrit = new CritRoller(((spec.meta.seed ?? 0) ^ CRIT_PROJECTILE_SALT) >>> 0);
  projectiles.onHit = (p, hitBody, point) => {
    if (p.friendly) {
      const target = enemies.enemies.find((e) => e.alive && e.body === hitBody);
      if (target) { const raw = p.damage * prog.damageMult() * (itemKit?.damageMult() ?? 1); const roll = projCrit.roll(synergyCritCtx(itemKit?.equippedWeaponRarity() ?? null, skills.rankOf('smithing'), skills.synergyCritBonuses())); const dmg = applyCrit(raw, roll); const type = itemKit?.outgoingDamageType() ?? 'physical'; const returned = target.damage(dmg, point, type); const dealt = displayedDamage(dmg, (target as { damageKind?: string }).damageKind, type, returned); combatPulse(); engine.juice.spawnText(engine.camera, point, roll.crit ? 'crit' : 'playerDamage', dealt); }
    } else if (hitBody === avatar.ctrl.body) {
      avatar.damage(p.damage, point);
    }
  };

  const pickups = new Pickups(engine);
  pickups.onCollect = (p) => {
    const eff = effectOf(p);
    if (eff) {
      applyPickupEffect(engine, fx, avatar, spec, eff);
    } else {
      if (p.kind === 'health') { avatar.heal(30); engine.audio.play('pickup'); }
      if (p.kind === 'ammo') { avatar.addAmmo(30); engine.audio.play('pickup'); }
      if (p.kind === 'coin') { engine.score += Math.round(50 * fx.scoreMult()); engine.audio.play('coin'); objectives.addProgress(1, 'collect'); }
      if (p.kind === 'powerup') { avatar.ctrl.speedBoostT = 5; engine.audio.play('powerup'); }
    }
    grantPickupXp(prog, notifyLevelUp);
    hud.setScore(engine.score);
  };
  pickups.scatterTerrain(
    { coin: 0, health: spec.pickups.health, ammo: Math.max(4, spec.pickups.ammo), powerup: spec.pickups.powerups },
    (x, z) => terrain.heightAt(x, z), arenaR - 4, spec.meta.seed,
  );
  // timed effect pickups: shield / rapid-fire / score×2 / magnet
  scatterEffects(pickups, engine, rng.fork(911), (x, z) => terrain.heightAt(x, z), arenaR - 4,
    ['shield', 'rapid', 'mult', 'magnet'], [{ x: 0, z: 0, r: 6 }]);

  const objectives = makeCampaignObjectives(engine, spec, undefined, () => prog.level);
  hud.setCrosshair(true);
  // N1: touch-aware hint bar (drag-to-look replaces pointer lock on touch)
  hud.setHint(isTouchDevice()
    ? 'Left stick move · drag right side to look · FIRE shoot · JUMP jump'
    : 'WASD move · mouse aim · LMB fire · Space jump · Esc pause');

  // pointer lock on click — registered once per canvas (M7: the blueprint body
  // re-runs on every in-place restart; engine.input is stable across restarts)
  const canvas = engine.renderer.domElement as unknown as {
    __xandriaLockHandler?: () => void;
    addEventListener(t: string, fn: () => void): void;
  };
  if (!canvas.__xandriaLockHandler) {
    canvas.__xandriaLockHandler = () => input.requestPointerLock();
    canvas.addEventListener('click', canvas.__xandriaLockHandler);
  }

  const camRig = makeCameraRig('first-person', engine.camera, input, (x, z) => terrain.heightAt(x, z));

  // waves: when all dead and objective wants more, respawn a wave (survive/eliminate > initial count)
  const totalNeeded = spec.objective.type === 'eliminate' ? spec.objective.count : spec.enemies.reduce((n, e) => n + e.count, 0);
  const initialCount = spec.enemies.reduce((n, e) => n + e.count, 0);
  let spawned = initialCount;
  // M4: brutes spawned during the CURRENT stage. Boss stages need their quota
  // spawned in-stage — a brute spent on an earlier stage doesn't count.
  let brutesSpawnedForStage = 0;

  const spawnOne = (kindSpec: EnemySpec, stage: number) => {
    const planned = planSpawns([{ ...kindSpec, count: 1 }], rng, stage, ARENA_VARIANTS)[0];
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(arenaR * 0.5, arenaR - 4);
    const pos = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    pos.y = terrain.heightAt(pos.x, pos.z) + 1.5;
    const before = enemies.enemies.length;
    enemies.spawnAll([planned.spec], () => pos);
    const e = enemies.enemies[before];
    if (e) { variants.register(e, planned.variant); variants.decorate(e, planned.variant); }
    spawned++;
    if (planned.spec.kind === 'brute') brutesSpawnedForStage++;
  };

  const spawnWave = () => {
    const remaining = totalNeeded - spawned;
    if (remaining <= 0) return;
    hud.toast('NEW WAVE INBOUND');
    engine.audio.play('alarm');
    // difficulty ramp: later chapters field more hostiles, scaled + variant-rich
    const stage = objectives.currentStageIndex;
    let left = Math.min(remaining, 6 + stage);
    const kinds = spec.enemies.length ? spec.enemies : [{ kind: 'walker' as const, count: 1, health: 30, speed: 4, damage: 10, weapon: 'melee' as const }];
    let i = 0;
    while (left > 0) {
      spawnOne(kinds[i % kinds.length], stage);
      left--;
      i++;
    }
    assets.applyOverrides(spec); // reskin the new wave
  };

  /**
   * M4: guarantee the current boss stage's brute quota. The initial spawn's
   * brute is typically spent on an earlier stage (e.g. 'warden'), and when the
   * spawn cap already covered every enemy the generic waves never fire —
   * leaving 'ruin'-style stages with zero brutes and no way to complete.
   * Waves top up the unmet requirement; counts are never changed.
   */
  const topUpBossQuota = () => {
    const stage = spec.objective.stages?.[objectives.currentStageIndex];
    if (!stage || stage.type !== 'boss' || stage.count <= objectives.progress) return;
    const aliveBrutes = enemies.enemies.filter((e) => e.alive && e.spec.kind === 'brute').length;
    const need = bossQuotaDeficit(stage, objectives.progress, brutesSpawnedForStage, aliveBrutes);
    if (need <= 0) return;
    const bruteSpec = spec.enemies.find((e) => e.kind === 'brute')
      ?? { kind: 'brute' as const, count: 1, health: 300, speed: 3.5, damage: 22, weapon: 'melee' as const };
    hud.toast('THE WARDEN STIRS');
    engine.audio.play('alarm');
    // sanity cap per check; the alive-brute gate paces the rest
    for (let k = 0; k < Math.min(need, 4); k++) spawnOne(bruteSpec, objectives.currentStageIndex);
    assets.applyOverrides(spec); // reskin the new wave
  };

  // initial spawn (capped at 8 alive at once), with chapter-0 variants
  const spawnInitial = () => {
    const capped = spec.enemies.map((e) => ({ ...e, count: Math.min(e.count, Math.ceil(8 / spec.enemies.length)) }));
    const planned = planSpawns(capped, rng, 0, ARENA_VARIANTS);
    spawned = planned.length;
    brutesSpawnedForStage = 0;
    planned.forEach((p, idx) => {
      const before = enemies.enemies.length;
      enemies.spawnAll([p.spec], () => {
        const a = (idx / planned.length) * Math.PI * 2 + rng.range(-0.3, 0.3);
        const r = p.spec.kind === 'turret' ? arenaR * 0.7 : rng.range(arenaR * 0.4, arenaR * 0.8);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        return new THREE.Vector3(x, terrain.heightAt(x, z) + 1.5, z);
      });
      const e = enemies.enemies[before];
      if (e) { variants.register(e, p.variant); variants.decorate(e, p.variant); }
      if (p.spec.kind === 'brute') brutesSpawnedForStage++;
    });
  };
  spawnInitial();

  // asset registration: enemies (dynamic roots), pickups, projectiles, arena
  registerEnemyAssets(assets, enemies, ['walker', 'drone', 'brute', 'turret'], variants);
  registerPickupAssets(assets, pickups);
  assets.register('weapon.projectile', { kind: 'weapon', materials: [engine.mats.glow(spec.theme.palette.accent, 2.5)] });
  assets.register('world.arena', { kind: 'world', roots: [structures.group] });
  assets.applyOverrides(spec);
  // M6: wire the (cloned, never the shared cache entry) tracer material into
  // the projectile pool so the override actually reaches pixels
  const tracerMat = assets.currentMaterial('weapon.projectile');
  if (tracerMat) projectiles.setTracerMaterial(tracerMat);

  // chapter-0 arena dressing
  dresser.dress(spec, 0, rng.fork(5000), { cx: 0, cz: 0, half: arenaR - 4, yAt: (x, z) => terrain.heightAt(x, z) });
  let lastStage = 0;

  engine.onUpdate((dt) => {
    const t = engine.time;
    avatar.ctrl.camYaw = camRig.yaw;
    avatar.update(dt, t);
    // COMBAT-ABILITIES: tick after the controller's velocity write (see tpAction).
    abilities.update(dt);
    abilities.poll(() => {
      const dir = new THREE.Vector3();
      engine.camera.getWorldDirection(dir);
      dir.y = 0;
      return dir.lengthSq() > 1e-6 ? dir.normalize() : new THREE.Vector3(0, 0, 1);
    });
    itemKit?.update(dt);
    gatheringSession.update(dt); // crafting wave (B): [E] Harvest prompt + registration refresh
    quests?.update(dt); // quest wave: explore objectives read the portal transition counter
    stationSession?.update(dt); // crafting wave (C): [E] Use prompt + crafting panel
    talkSession?.update(dt); // UPGRADE LOOP (blueprint-rollout): vendor [E] Trade prompt + shop dispatch
    // vendor-economy parity: shop stock is map-local (seeded per map), so a
    // portal arrival ALWAYS closes the shop -- unconditional (mirrors tpAction).
    if (shopPanel.isOpen) {
      shopPanel.hide();
    }

    if ((input.pressed('attack') || input.justPressed('attack')) && engine.state === 'playing') {
      const dir = new THREE.Vector3();
      engine.camera.getWorldDirection(dir);
      avatar.shoot(dir);
    }

    // Enemies wave C: the blueprint drives the shared instancer frame
    // (single begin/end per update — see tpAction).
    const inst = NpcInstancer.for(engine);
    inst.beginFrame(dt);
    enemies.update(dt, avatar.ctrl.position, t);
    vendorManager.update(dt); // UPGRADE LOOP (blueprint-rollout): merchants tick in the shared instancer frame
    gathering.update(dt); // crafting wave (B): static node submits into the shared instancer frame
    stations.update(dt); // crafting wave (C): static station submits into the shared instancer frame
    inst.endFrame();
    variants.update(dt, avatar.ctrl.position, t);
    bosses.update(dt, avatar.ctrl.position); // boss-fights wave: arena tether + telegraphed attacks + boss bar
    projectiles.update(dt);
    pickups.update(dt, avatar.ctrl.position, 2.6 * prog.magnetMult() * fx.magnetMult());
    objectives.update(dt);
    fx.tick(dt, spec);
    fxHud.update(fx, t);

    // chapter transitions: fresh dressing, difficulty ramp, boss intro
    const stageIdx = objectives.currentStageIndex;
    if (stageIdx !== lastStage) {
      lastStage = stageIdx;
      brutesSpawnedForStage = 0; // M4: boss quota is per-stage
      dresser.dress(spec, stageIdx, rng.fork(5000 + stageIdx), { cx: 0, cz: 0, half: arenaR - 4, yAt: (x, z) => terrain.heightAt(x, z) });
      // R4-N1: difficulty keys off chapters cleared (branch-aware), not the quest-graph array index.
      variants.applyStageScaling(objectives.stagesCleared);
      variants.notifyStage(stageIdx, isBossStageActive(spec, objectives));
    }

    if (enemies.aliveCount() === 0 && spawned < totalNeeded) spawnWave();
    topUpBossQuota(); // M4: guarantee the boss stage's brute quota

    if (avatar.ctrl.position.y < -40) { avatar.damage(1000); camRig.shake(0.8); }

    // FIX 5: combat intensity decays to baseline
    combatT = Math.max(0, combatT - dt * 0.25);
    engine.audio.setIntensity(0.35 + combatT * 0.6);

    camRig.update(dt, avatar.ctrl.position, avatar.ctrl.velocity, avatar.ctrl.yaw);
    // keep HUD objective fresh for wave counter (N6: no literal-zero prefix)
    if (spec.objective.type === 'survive') hud.setProgress(`${enemies.aliveCount()} hostiles`);
  });

  return { avatar, enemies, skills, skillsPanel, bestiary, bestiaryPanel, achievements, achievementsPanel, gathering, stations, stationSession, gatheringSession, quests, questTracker, pickups, objectives, assets, itemKit, itemWorld: itemKit?.itemWorld ?? null, bosses, bossBar, prog, wallet, vendors: vendorManager, shopPanel, vendorDefs, talkSession , abilities: abilities.manager, abilityBar: abilities.bar, radiantBoard, radiantBoardPanel, timedBoard, timedBoardPanel };
}
