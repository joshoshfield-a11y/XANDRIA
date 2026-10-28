/**
 * REFERENCE BLUEPRINT — third-person action adventure.
 * Humanoid + melee/ranged, enemies roaming a themed world, pickups, eliminate/collect/reach/boss objectives.
 */
import * as THREE from 'three';
import type { GameSpec } from '@spec';
import type { Engine } from '../engine/Engine';
import { makeCameraRig } from '../engine/game/Cameras';
import { EnemyManager } from '../engine/game/EnemyAI';
import { STEALTH_TABLE, noiseRadiusFor } from '../engine/game/stealth';
import { resolveEnemyDensity } from '../engine/game/enemyTuning';
import { resolveEliteChance } from '../engine/game/eliteAffixes';
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
import { snapshotLoadoutBase, loadProfile, saveProfile } from '../engine/game/Profile';
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
import { RadiantBoard } from '../engine/game/radiantQuests';
import { RadiantBoardPanel } from '../engine/ui/RadiantBoardPanel';
import { TimedBoard } from '../engine/game/timedQuests';
import { TimedBoardPanel } from '../engine/ui/TimedBoardPanel';
import { GatheringManager, GatheringInteractionSession } from '../engine/game/gathering';
import { resolveCraftingEnabled, ensureCraftingItemDefs, buildRecipePool } from '../engine/game/crafting';
import { ensureLootItemDefs } from '../engine/game/loot';
import { ensureSetItemDefs } from '../engine/game/setBonuses';
import { ensureEnchantItemDefs } from '../engine/game/enchantments';
import { StationManager, CraftingInteractionSession } from '../engine/game/stations';
import { DeployablesManager } from '../engine/game/deployables';
import { CompanionsManager } from '../engine/game/companions';
import { COMPANION_REVIVE_COST } from '../engine/game/companionCombat';
import { CompanionPanel } from '../engine/ui/CompanionPanel';
import { CampManager, CampInteractionSession } from '../engine/game/camp';
import { MountManager } from '../engine/game/mounts';
import { MountPanel } from '../engine/ui/MountPanel';
import { SkillSystem, resolveSkillsEnabled } from '../engine/game/skills';
import { CRIT_PROJECTILE_SALT, CritRoller, applyCrit, synergyCritCtx } from '../engine/game/crit';
import { displayedDamage } from '../engine/game/elemental';
import { wireCombatAbilities } from '../engine/game/combatAbilities';
import { BestiaryManager, BESTIARY_TIER_NAMES } from '../engine/game/bestiary';
import { SkillsPanel } from '../engine/ui/SkillsPanel';
import {
  Wallet,
  CURRENCY_NAME,
  DEFAULT_SELL_MULT,
  VENDOR_SALT,
  resolveVendorDefs,
  buildVendorNpcSpecs,
} from '../engine/game/economy';
import { ShopPanel } from '../engine/ui/ShopPanel';
import { FactionStandings, localStorageFactionsAdapter, factionOfVendor } from '../engine/game/factions';
import { DialogueEngine, DialogueState, FIRST_QUEST_REF, localStorageDialogueAdapter } from '../engine/game/dialogue';
import { StandingsPanel } from '../engine/ui/StandingsPanel';
import { DynamicEventManager, EventInteractionSession, EVENT_DEFS, EVENT_SALT, planDynamicEvents, buildMerchantStock, resolveEventsEnabled } from '../engine/game/dynamicEvents';
import { TradePanel } from '../engine/ui/TradePanel';
import { AchievementsPanel } from '../engine/ui/AchievementsPanel';
import { AchievementManager } from '../engine/game/achievements';
import { BestiaryPanel } from '../engine/ui/BestiaryPanel';
import { WeatherCycleManager } from '../engine/game/weatherCycles';
import { HazardZoneManager } from '../engine/game/hazardZones';
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
import { WorldBossEvent } from '../engine/game/worldBoss';

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
  // vendor-economy wave: the player-scoped currency wallet (survives
  // portals by construction — never in portalEntities; the PortalState
  // snapshot carries the balance for rebuild paths). engine.wallet exposes
  // it to PortalManager.portalParts().
  const wallet = new Wallet();
  engine.wallet = wallet;
  wallet.onChange = () => engine.hud.setCurrency(wallet.balance);
  // factions-reputation wave: player-scoped standings (never in
  // portalEntities, so portal travel leaves them untouched by
  // construction). Restored from guarded localStorage keyed by spec
  // seed, so a full page reload keeps the standings for this spec.
  // Constructed before enemies/quests/shop so every hook below can
  // close over it; onChange is assigned after the panel exists.
  const standings = new FactionStandings(localStorageFactionsAdapter(spec.meta.seed));
  // Dialogue-branching wave: player-scoped dialogue state (never in
  // portalEntities, so portal travel leaves it untouched by
  // construction). Restored from guarded localStorage keyed by spec
  // seed, so a full page reload keeps visited nodes / choices / flags
  // for this spec. Constructed before quests/talk so every hook below
  // can close over it; engine.dialogueState exposes it to
  // PortalManager.portalParts for snapshot/restore.
  const dialogueState = new DialogueState(localStorageDialogueAdapter(spec.meta.seed));
  engine.dialogueState = dialogueState;
  const dialogueEngine = new DialogueEngine();
  // vendor-economy wave: merchant NPCs get their OWN map-local roster
  // (id 'vendors', VENDOR_SALT stream) — one NpcManager each, so the
  // villager roster's seeded spawns stay byte-identical to before this
  // wave. Vendors register in engine.npcInteractions like any
  // interactable; the QuestTalkSession dispatches their [E] activation
  // to the shop panel instead of the quest dialogue.
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
  // UPGRADE LOOP (weather-cycles): the manager is constructed later (it
  // needs the avatar + camera rig), but the enemy onPlayerHit closure below
  // reads it lazily — hoisted so night damage can apply additively.
  let weather: WeatherCycleManager | null = null;

  // FIX 5: combat music intensity — pulsed up by combat events, decays to baseline
  let combatT = 0;
  const combatPulse = () => { combatT = 1; };
  // STEALTH-SYSTEM: last HUD sneak-chip state (setSneaking called on change only).
  let lastSneakChip = false;

  const enemies = new EnemyManager(engine, projectiles, {
    // UPGRADE LOOP (weather-cycles): night makes the heavy kinds hit
    // harder — additive multiplier read lazily off the weather manager.
    onPlayerHit: (dmg, from, kind) => { avatar.damage(dmg * (weather?.enemyDamageMult(kind) ?? 1), from); camRig.shake(0.55); combatPulse(); },
    // UPGRADE LOOP (companion-combat-depth): melee hits against a
    // companion-targeted enemy land on the companion (guard reduction
    // + fall handling live in CompanionsManager.takeEnemyHit) — never
    // on the player. Night damage applies identically (same lazy
    // weather read as onPlayerHit). Ranged projectiles never route
    // here (player-body collision channel — see companionCombat).
    onCompanionHit: (dmg, from, kind) => { companions?.takeEnemyHit(dmg * (weather?.enemyDamageMult(kind) ?? 1)); combatPulse(); },
    onDeath: (e) => {
      variants.onEnemyDeath(e); // splitter minis + visual cleanup first
      engine.score += Math.round(100 * fx.scoreMult());
      hud.setScore(engine.score);
      // N6: grant XP before recording the kill — addProgress may end the run
      // (engine.win), and the level-up modal must never open over the end screen
      grantKillXp(prog, notifyLevelUp, e.xpMult);
      objectives.addProgress(1, 'kill'); // M5: kills only count toward kill stages
      quests?.onKill(e.spec.kind); // quest wave: kills feed kill objectives
      // factions-reputation wave: observe-only kill hook (no enemy
      // contract change) — faction mobs drop standing, bosses more.
      standings.onKill(e.spec.kind, !!e.isBoss);
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
  // enemy variants: shielded bruisers + ranged casters over the base kinds
  const variants = new VariantDirector(engine, enemies, projectiles);

  // --- player
  const spawnY = terrain.heightAt(0, 0);
  avatar = new PlayerAvatar(engine, spec, new THREE.Vector3(0, spawnY + 2, 0), enemies, projectiles);
  // COMBAT-ABILITIES: data-driven active abilities (dash-strike /
  // shockwave-slam / mend) on the player-scoped manager. Blueprint-owned
  // like SkillSystem, so cooldowns/energy survive portal travel. Aim uses
  // the melee convention (ctrl.yaw + PI), matching avatar.melee().
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
  // STEALTH-SYSTEM: every attack (melee, gun, ability — all emit
  // onAttack) is a one-shot noise event: enemies within the attack
  // noise radius become suspicious, never directly alerted. The
  // avatar is read lazily (assigned above); the hook only fires in
  // play, never during construction.
  engine.hooks.tap('onAttack', () => {
    enemies.emitNoise(avatar.ctrl.position, STEALTH_TABLE.attackNoiseRadius);
  });
  // UPGRADE LOOP (mounts): player-scoped mount manager — rides the live
  // object across portal transitions (NOT a portal entity; the avatar
  // persists across transitions) and persists active mount + stamina to
  // the save-slot profile (ProfileData.mounts) so save/reload restores
  // the ride. The panel is built below (after skillsPanel) so its modal
  // guard can reference the other panels; the hoisted binding lets the
  // earlier update loop reference it too.
  let mountsPanel: MountPanel | null = null;
  const mounts = new MountManager({
    engine,
    playerPos: () => avatar.ctrl.position,
    playerYaw: () => avatar.ctrl.yaw,
    loadPersist: () => loadProfile().mounts,
    savePersist: (p) => { const prof = loadProfile(); prof.mounts = p; saveProfile(prof); },
    toast: (m) => engine.hud.toast(m),
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
  // Enchantments wave: enchant-material item defs (additive, idempotent).
  ensureEnchantItemDefs(spec);
  const itemKit: BlueprintItemKit | null = buildItemKit(engine, spec, avatar, {
    // inventory-qol wave: sell-junk hooks ride the vendor-economy wallet
    // (DEFAULT_SELL_MULT — the same rate the shop panel pays). The wallet
    // is player-scoped, so sell credits land in the same balance the shop
    // and kill-drops use.
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
      // vendor-economy wave: seeded scrap payouts ride the separate
      // currency stream (EnemyAI); the wallet is player-scoped, so kills
      // bank scrap that survives portal travel.
      onCurrency: (amount, _pos) => {
        wallet.add(amount);
        engine.hud.toast(`+${amount} ${CURRENCY_NAME}`);
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
        // factions-reputation wave: standing gate + turn-in reward.
        // standingOf reads the live standings; onQuestTurnedIn feeds
        // the def's reward (or the +20 freeholds default) back into it.
        standingOf: (factionId) => standings.standingOf(factionId),
        onQuestTurnedIn: (def) => standings.onQuestComplete(def),
        // quest wave: an open quest dialogue live-refreshes when its quest
        // completes underneath it (talk objective fired on open). The thunk
        // is lazy — talkSession is constructed just below.
        onQuestsChanged: () => { talkSession?.refreshOpenDialogue(); radiantBoard?.sync(); radiantBoardPanel?.render(); timedBoard?.sync(); timedBoardPanel?.render(); },
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
  // UPGRADE LOOP (deployables): player-crafted field items (campfire /
  // spike trap / lure totem), map-local lifecycle. Registers with
  // engine.portalEntities ({ id: 'deployables' }) — portal departure
  // despawns them, arrival does NOT regenerate them (player-placed and
  // time-limited; the consumed kits are already gone from the inventory).
  // The deployable item defs + recipes ride ensureCraftingItemDefs above
  // (craftedItemDefs), so this manager only exists when crafting is on.
  // UPGRADE LOOP (companion-system): the companion manager is built
  // BEFORE the deployables manager so the campfire heal callback can
  // also heal the following companion (the heal-at-campfire hook).
  // The manager itself is constructed after deployables (it reads the
  // live campfire roster); the heal callback below closes over the
  // `companions` binding, which is assigned before any tick runs.
  let companions: CompanionsManager | null = null;
  const deployables = new DeployablesManager(engine, {
    getPlayerPos: () => avatar.ctrl.position,
    getEnemies: () => enemies.enemies,
    healPlayer: (n) => { avatar.heal(n); companions?.healActive(n); },
    toast: (m) => engine.hud.toast(m),
    inventory: () => itemKit?.inventory ?? null,
    enabled: craftingEnabled,
    mapSeed: spec.meta.seed,
  });
  engine.portalEntities.register(deployables);
  // UPGRADE LOOP (companion-system): data-driven companion followers.
  // Roster is player-scoped (profile, active save slot) and survives
  // portal travel + save/reload; only the rendered follower is
  // map-local (portalEntities id 'companions'). Initial spawn runs
  // here for the first map; PortalTransition calls spawnForMap on
  // later arrivals.
  let restoredCompanions: import('../engine/game/companions').CompanionSave | null = null;
  try { restoredCompanions = loadProfile().companions; } catch { restoredCompanions = null; }
  companions = new CompanionsManager(engine, {
    getPlayerPos: () => avatar.ctrl.position,
    getEnemies: () => enemies.enemies,
    healPlayer: (n) => avatar.heal(n),
    toast: (m) => engine.hud.toast(m),
    campfireLive: () => deployables.deployables.some((d) => d.def.id === 'campfire' && !d.retiring),
    onChange: (save) => {
      try { const p = loadProfile(); p.companions = save; saveProfile(p); } catch { /* never break play */ }
    },
    initial: restoredCompanions,
    mapSeed: spec.meta.seed,
  });
  engine.portalEntities.register(companions);
  companions.spawnForMap(spec.meta.seed);
  // UPGRADE LOOP (player-camp): one camp site per map (seeded position,
  // discovered on arrival), data-driven structures paid from materials,
  // player-scoped storage chest in the save-slot profile, rest point,
  // workbench buff. Map-local lifecycle via engine.portalEntities
  // (id 'camp') — departure despawns the props, arrival rebuilds the
  // identical site + persisted structures; the chest contents never
  // despawn (profile). The session is built below (after talkSession)
  // so its modal chain can reference it; the hoisted binding lets the
  // earlier sessions' chains reference it too.
  let campSession: CampInteractionSession | null = null;
  const camp = new CampManager(engine, {
    inventory: () => itemKit?.inventory ?? null,
    restoreHealth: () => avatar.heal(avatar.maxHealth),
    toast: (m) => engine.hud.toast(m),
  });
  engine.portalEntities.register(camp);
  camp.spawnForMap(spec.meta.seed);
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
        // quest wave: the quest dialogue owns E while open so the panel
        // can't open behind it
        // player-camp wave: the camp panel likewise owns input
        isModalOpen: () => (talkSession?.isDialogueOpen ?? false) || (campSession?.isPanelOpen ?? false),
      })
    : null;
  // vendor-economy wave: the shop panel (buy/sell tabs, seeded per-map
  // stock). Vendors are NPCs in the villager roster — the QuestTalkSession
  // dispatches their [E] activation here instead of the quest dialogue
  // (see the openVendor opt below). The panel never opens while the
  // crafting panel or a dialogue owns input, and vice versa (isModalOpen
  // chains on both sides).
  const shopPanel = new ShopPanel({
    container: engine.container,
    inventory: () => itemKit?.inventory ?? null,
    wallet: () => wallet,
    defs: () => spec.custom?.items?.defs ?? {},
    vendorDefs: () => vendorDefs,
    toast: (m) => engine.hud.toast(m),
    isModalOpen: () => (stationSession?.isPanelOpen ?? false) || (talkSession?.isDialogueOpen ?? false) || (campSession?.isPanelOpen ?? false),
    // factions-reputation wave: vendor -> faction mapping for the
    // standing price factor, and the trade hook for standing gains.
    standingOf: (vendorId) => {
      const f = factionOfVendor(vendorId);
      return f ? standings.standingOf(f) : 0;
    },
    onTrade: (vendorId, kind) => standings.onTrade(vendorId, kind),
  });
  // factions-reputation wave: the standings panel (event-driven) + the
  // standings onChange fan-out: persist, re-render the panel, unlock
  // newly-eligible gated quests, and re-price an open shop.
  const standingsPanel = new StandingsPanel(engine.container);
  standingsPanel.render(standings.rows());
  standings.onChange = () => {
    standings.save();
    standingsPanel.render(standings.rows());
    quests?.refreshStandingGates();
    shopPanel.refresh();
  };
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
  // quest wave: the [E] Talk prompt + quest dialogue for villagers. The
  // session is manager-based (per-frame refresh), so portal respawns need
  // no special handling; it stamps requires/produces onto the NPC
  // interactables (see engine/game/questTalk.ts). Assigned (not declared)
  // here — the binding was hoisted above the QuestManager construction.
  // vendor-economy wave: openVendor routes vendor NPCs ([E] "Trade with")
  // to the shop panel; villagers keep the quest dialogue. The session
  // covers both rosters (villagers + vendors) with one prompt pill.
  talkSession = questsEnabled && quests
    ? new QuestTalkSession(engine, [npcManager, vendorManager], quests, {
        openVendor: (npc) => shopPanel.openForVendor({
          vendorId: npc.vendorId!,
          spawnSeed: npc.spawnSeed,
          keeperName: npc.name,
        }),
        // Dialogue-branching wave: the tree engine + player-scoped
        // state + live context. Effects ride existing seams only:
        // quest accept/turn-in via the manager (turn-in emits the same
        // onQuestTurnIn hook the quest buttons emit), standing via the
        // factions store (its onChange fan-out persists + re-prices the
        // shop through the untouched pricing math), items read-only.
        dialogue: {
          engine: dialogueEngine,
          state: dialogueState,
          context: () => ({
            standingOf: (factionId) => standings.standingOf(factionId),
            adjustStanding: (factionId, amount) => { standings.adjust(factionId, amount); },
            questStatusOf: (ref) => {
              const first = quests.defs[0];
              if (ref === FIRST_QUEST_REF) return first ? quests.statusOf(first.id) : 'unknown';
              return quests.statusOf(ref);
            },
            questAccept: (ref) => {
              const id = ref === 'first-available'
                ? quests.actionsForNpc('villager').accept[0]?.id ?? null
                : ref;
              return id ? quests.accept(id) : false;
            },
            questTurnIn: (ref) => {
              const id = ref === 'first-complete'
                ? quests.actionsForNpc('villager').turnIn[0]?.id ?? null
                : ref;
              if (!id) return false;
              if (quests.turnIn(id)) {
                engine.hooks.emit('onQuestTurnIn', { questId: id });
                return true;
              }
              return false;
            },
            itemCount: (itemId) => itemKit?.inventory.count(itemId) ?? 0,
          }),
        },
      })
    : null;
  // UPGRADE LOOP (player-camp): the [E] Visit camp prompt + camp panel.
  // Built after talkSession (its chain references the dialogue) and
  // before the gathering/event sessions (their chains reference it).
  campSession = new CampInteractionSession(engine, camp, {
    inventory: () => itemKit?.inventory ?? null,
    backpackItems: () => [...new Set((itemKit?.inventory?.getBackpack() ?? []).filter((s) => s).map((s) => s!.itemId))],
    defName: (id) => spec.custom?.items?.defs?.[id]?.name ?? id,
    isModalOpen: () => (stationSession?.isPanelOpen ?? false) || (talkSession?.isDialogueOpen ?? false) || shopPanel.isOpen,
  });
  const gatheringSession = new GatheringInteractionSession(engine, gathering, {
    isModalOpen: () => (stationSession?.isPanelOpen ?? false) || (talkSession?.isDialogueOpen ?? false) || shopPanel.isOpen || (campSession?.isPanelOpen ?? false),
  });
  // dynamic-events wave: seeded world events (ambushes, wandering
  // merchants, supply caches, elite patrols), map-local lifecycle via
  // engine.portalEntities ({ id: 'events' }) so portal transitions
  // despawn/respawn the event roster deterministically per map seed —
  // the same contract as the gathering nodes.
  const tradePanel = new TradePanel(engine.container);
  const events = new DynamicEventManager(engine, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
    enemyManager: enemies,
    lootHooks: enemies.lootHooks,
    inventory: itemKit?.inventory ?? null,
    defs: () => spec.custom?.items?.defs ?? {},
    toast: (m) => engine.hud.toast(m),
    getPlayerPos: () => avatar.ctrl.position,
  });
  engine.portalEntities.register(events);
  events.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
  const eventSession = new EventInteractionSession(engine, events, {
    isModalOpen: () => (stationSession?.isPanelOpen ?? false)
      || (talkSession?.isDialogueOpen ?? false) || tradePanel.isOpen || (campSession?.isPanelOpen ?? false),
    openTrade: (defId, index) => {
      const ev = events.events.find((e) => e.plan.defId === defId && e.plan.index === index);
      if (!ev?.merchant || !ev.def.merchant || !itemKit?.inventory) return;
      const inv = itemKit.inventory;
      const defs = spec.custom?.items?.defs ?? {};
      const good = defs[ev.def.merchant.tradeGoodId];
      tradePanel.show(
        ev.merchant.name, defId, index, ev.stock,
        ev.def.merchant.tradeGoodId, good?.name ?? ev.def.merchant.tradeGoodId,
        defs,
        {
          count: (id) => inv.count(id),
          listItems: () => [...new Set(inv.getBackpack().filter((s) => s).map((s) => s!.itemId))],
        },
        {
          onBuy: (itemId) => events.merchantBuy(defId, index, itemId),
          onSell: (itemId) => events.merchantSell(defId, index, itemId),
        },
      );
    },
  });
  // wandering world-boss wave: the roaming boss event (seeded plan, beacon
  // + toast, telegraphed attacks via the open-field boss encounter, boss
  // loot path on kill, timer retreat). Explicit opt-in only
  // (spec.custom.worldBoss.enabled); registers AFTER the enemy manager so
  // portal arrivals spawn the roster first and the event's brute is never
  // swept by the roster's own spawnForMap. Map-local lifecycle via
  // engine.portalEntities ({ id: 'worldboss' }).
  const worldBoss = new WorldBossEvent(engine, {
    manager: enemies,
    terrain,
    onPlayerHit: (dmg, from) => { avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); },
    bar: bossBar,
    toast: (m) => engine.hud.toast(m),
  });
  engine.portalEntities.register(worldBoss);
  worldBoss.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
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
  // UPGRADE LOOP (companion-system): the companion panel (N key /
  // COMPANIONS chip). Never opens while the crafting panel owns input.
  const companionPanel = new CompanionPanel({
    container: engine.container,
    manager: () => companions,
    isModalOpen: () => stationSession?.isPanelOpen ?? false,
    // UPGRADE LOOP (companion-combat-depth): fallen companions revive
    // for scrap through the existing Wallet — the panel revives ONLY
    // when Wallet.spend returns true, so a failed payment never revives.
    reviveCost: () => COMPANION_REVIVE_COST,
    spendForRevive: (cost) => wallet.spend(cost),
  });
  // achievements wave: the achievement codex panel (J key / trophy chip).
  // Never opens while the crafting panel (or quest dialogue, where one
  // exists) owns input.
  const achievementsPanel = new AchievementsPanel({
    container: engine.container,
    achievements: () => achievements,
    isModalOpen: () => (stationSession?.isPanelOpen ?? false) || (talkSession?.isDialogueOpen ?? false),
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
  // UPGRADE LOOP (mounts): the mounts panel (N key / MOUNTS chip toggle).
  // Never opens while another modal owns input; the manager above owns
  // the state, this panel is only the view.
  mountsPanel = new MountPanel({
    container: engine.container,
    mounts: () => mounts,
    isModalOpen: () => (stationSession?.isPanelOpen ?? false)
      || (talkSession?.isDialogueOpen ?? false) || shopPanel.isOpen
      || (skillsPanel?.isOpen ?? false) || (bestiaryPanel?.isOpen ?? false),
  });
  assets.register('player.body', { kind: 'player', roots: [avatar.ctrl.rig.group] });
  notifyLevelUp = makeLevelUpFlow(engine, spec, prog, avatar);
  wrapShieldDamage(engine, avatar, fx); // aegis shield pickup absorbs damage

  // FIX 1: wire projectile impacts to damage (guns dealt zero damage — onHit was never assigned).
  // Campaign: projectile damage scales with the damage upgrade multiplier.
  // CRIT-SYSTEM: friendly projectiles roll crits on their own seeded stream.
  const projCrit = new CritRoller(((spec.meta.seed ?? 0) ^ CRIT_PROJECTILE_SALT) >>> 0);
  projectiles.onHit = (p, hitBody, point) => {
    if (p.friendly) {
      const target = enemies.enemies.find((e) => e.alive && e.body === hitBody);
      if (target) { const raw = p.damage * prog.damageMult(); const roll = projCrit.roll(synergyCritCtx(itemKit?.equippedWeaponRarity() ?? null, skills.rankOf('smithing'), skills.synergyCritBonuses())); const dmg = applyCrit(raw, roll); const type = itemKit?.outgoingDamageType() ?? 'physical'; const returned = target.damage(dmg, point, type); const dealt = displayedDamage(dmg, (target as { damageKind?: string }).damageKind, type, returned); combatPulse(); engine.juice.spawnText(engine.camera, point, roll.crit ? 'crit' : 'playerDamage', dealt); }
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
  // UPGRADE LOOP (deployables): the G deploy hotkey is part of the desktop hints.
  hud.setHint(isTouchDevice()
    ? 'Left stick move · ATK attack · JUMP jump · DASH dash · DEPLOY field item'
    : 'WASD move · mouse look · LMB attack · Space jump · Shift dash/sprint · G deploy · Esc pause');
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

  // UPGRADE LOOP (weather-cycles): seeded day/night + weather cycles with
  // additive gameplay hooks (night damage, rain fog, storm lightning).
  // Map-local lifecycle like the other ambient systems: despawned on portal
  // departure (sky baseline restored), rebuilt from the derived map seed on
  // arrival. Constructed here (after avatar + camRig) — the enemies'
  // onPlayerHit closure above reads it lazily.
  weather = new WeatherCycleManager(engine, spec, {
    playerPos: () => avatar.ctrl.position,
    damagePlayer: (dmg, from) => { avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); },
    toast: (m) => engine.hud.toast(m),
  });
  engine.portalEntities.register(weather);
  weather.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed

  // UPGRADE LOOP (hazard-zones): seeded environmental hazard zones on the
  // weather-cycles + dynamic-events systems (telegraphed ground hazards
  // with additive damage through the avatar.damage path). Map-local
  // lifecycle like the other ambient systems: despawned on portal
  // departure, rebuilt from the derived map seed on arrival. Constructed
  // here (after avatar + camRig) — the damage sink shakes the camera like
  // the storm-strike sink above.
  const hazards = new HazardZoneManager(engine, spec, {
    pois: landmarks.placed.map((p) => ({ x: p.pos.x, z: p.pos.z, r: p.radius })),
    playerPos: () => avatar.ctrl.position,
    damagePlayer: (dmg, from) => { avatar.damage(dmg, from); camRig.shake(0.55); combatPulse(); },
  });
  engine.portalEntities.register(hazards);
  hazards.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed

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
    // UPGRADE LOOP (mounts): stamina tick + speed scalar. Moving = any
    // movement-axis input; the scalar is the mount's only movement
    // effect (stacks with sprint/boost in the controller).
    {
      const ax = engine.input.axes;
      const moving = Math.hypot(ax.x, ax.y) > 0.1;
      mounts.update(dt, moving);
      avatar.ctrl.speedScalar = mounts.speedMultiplier();
    }
    // COMBAT-ABILITIES: tick after the controller's velocity write so the
    // dash-strike velocity override survives the frame; poll hotkeys/touch.
    abilities.update(dt);
    abilities.poll(() => {
      const y = avatar.ctrl.yaw + Math.PI;
      return new THREE.Vector3(Math.sin(y), 0, Math.cos(y));
    });
    itemKit?.update(dt);
    gatheringSession.update(dt); // crafting wave (B): [E] Harvest prompt + registration refresh
    eventSession.update(); // dynamic-events wave: [E] Open cache / Trade prompt
    stationSession?.update(dt); // crafting wave (C): [E] Use prompt + crafting panel
    talkSession?.update(dt); // quest wave: [E] Talk prompt + quest dialogue + requires/produces refresh
    campSession?.update(); // player-camp wave: [E] Visit camp prompt + camp panel
    quests?.update(dt); // quest wave: explore objectives read the portal transition counter
    // vendor-economy wave: shop stock is map-local (seeded per map), so a
    // portal arrival ALWAYS closes the shop — unconditional (not
    // order-dependent on the vendor roster respawn), mirroring the
    // QuestTalkSession dialogue-close rule for departed NPCs.
    if (shopPanel.isOpen) {
      shopPanel.hide();
    }

    // attack input (melee damage scales with the damage upgrade multiplier;
    // player-camp wave: the workbench buff adds +10% while active, 1.0
    // otherwise — byte-identical behavior with no buff)
    if (engine.input.justPressed('attack') && engine.state === 'playing') {
      if (spec.player.weapon === 'sword' || spec.player.weapon === 'none') {
        avatar.melee(avatar.ctrl.yaw, 2.6, 1.3, 25 * prog.damageMult() * (itemKit?.damageMult() ?? 1) * camp.workbenchDamageMult() * camp.restedDamageMult(), synergyCritCtx(itemKit?.equippedWeaponRarity() ?? null, skills.rankOf('smithing'), skills.synergyCritBonuses()), itemKit?.outgoingDamageType() ?? 'physical');
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

    // UPGRADE LOOP (deployables): G / Digit3 / DEPLOY touch button —
    // deploy the next owned field item (round-robin). Never while a
    // modal owns input (crafting panel, quest dialogue, shop).
    if (engine.input.justPressed('deploy') && engine.state === 'playing'
      && !(stationSession?.isPanelOpen ?? false)
      && !(talkSession?.isDialogueOpen ?? false)
      && !(campSession?.isPanelOpen ?? false)
      && !(mountsPanel?.isOpen ?? false)
      && !shopPanel.isOpen) {
      deployables.tryDeploy();
    }

    // Enemies wave C: one shared instancer frame for the enemy + NPC
    // managers. Both submit into the same per-engine buckets; a single
    // begin/end per update keeps their instance counts accumulating
    // instead of the second manager's beginFrame zeroing the first's.
    const inst = NpcInstancer.for(engine);
    inst.beginFrame(dt);
    // UPGRADE LOOP (deployables): FIRST in the frame — the manager ticks
    // auras and assigns lure targets before EnemyManager.update reads
    // them, and submits deployable instances into the same buckets.
    deployables.update(dt);
    // UPGRADE LOOP (companion-system): companion follow/attack/heal ticks
    // run before EnemyManager.update so companion kills land through the
    // existing onDeath path before the enemy roster sweep.
    companions?.update(dt);
    // STEALTH-SYSTEM: per-frame enemy perception — sneak state + the
    // continuous movement-noise radius. Sneaking is silent (radius 0)
    // and shrinks detection; sprinting is the loudest movement.
    const pv = avatar.ctrl.velocity;
    const moving = Math.hypot(pv.x, pv.z) > 0.5;
    enemies.update(dt, avatar.ctrl.position, t, {
      sneaking: avatar.ctrl.sneaking,
      noiseRadius: noiseRadiusFor({
        moving,
        sneaking: avatar.ctrl.sneaking,
        sprinting: engine.input.pressed('sprint'),
        dashing: avatar.ctrl.dashing,
      }),
    });
    if (avatar.ctrl.sneaking !== lastSneakChip) {
      lastSneakChip = avatar.ctrl.sneaking;
      engine.hud.setSneaking(lastSneakChip);
    }
    npcManager.update(dt); // gameplay wave (B): ambient villagers tick
    vendorManager.update(dt); // vendor-economy wave: merchants tick (same instancer frame)
    gathering.update(dt); // crafting wave (B): static node submits into the shared instancer frame
    stations.update(dt); // crafting wave (C): static station submits into the shared instancer frame
    events.update(dt); // dynamic-events wave: merchant/cache submits into the shared instancer frame
    camp.update(); // player-camp wave: site + built-structure submits into the shared instancer frame
    mounts.submitFrame(); // mounts wave: the ridden mount submits into the shared instancer frame
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
    // wandering world-boss wave: patrol steering + telegraphs + despawn
    // timer (the event no-ops when its opt-in flag is off)
    worldBoss.update(dt, avatar.ctrl.position);
    // UPGRADE LOOP (weather-cycles): advance the cycle clock (lights, fog,
    // particles, lightning). Owns the sky blend while active.
    weather?.update(dt);
    // UPGRADE LOOP (hazard-zones): advance the hazard tick clocks
    // (telegraphs, then additive damage ticks through avatar.damage).
    hazards.update(dt);

    // camera
    camRig.update(dt, avatar.ctrl.position, avatar.ctrl.velocity, avatar.ctrl.yaw);
  });

  return { avatar, enemies, skills, skillsPanel, bestiary, bestiaryPanel, achievements, achievementsPanel, npcs: npcManager, vendors: vendorManager, gathering, stations, stationSession, gatheringSession, talkSession, quests, questTracker, pickups, objectives, assets, itemKit, itemWorld: itemKit?.itemWorld ?? null, bosses, bossBar, worldBoss, prog, wallet, shopPanel, vendorDefs, events, eventSession, tradePanel, weather, hazards, deployables, companions, companionPanel, camp, campSession, mounts, mountsPanel, standings, standingsPanel, dialogueEngine, dialogueState, abilities: abilities.manager, abilityBar: abilities.bar, radiantBoard, radiantBoardPanel, timedBoard, timedBoardPanel };}
