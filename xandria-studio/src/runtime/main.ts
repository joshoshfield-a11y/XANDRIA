/**
 * Player runtime bootstrap. Spec sources, in priority order:
 *   1. window.__XANDRIA_SPEC__ (injected into standalone exports)
 *   2. ?spec=<base64url JSON>
 *   3. ?intent=<text>  (runs through the deterministic generator)
 *   4. built-in demo spec
 * Exposes window.__XANDRIA__ for automation/playtests.
 */
import { normalizeSpec, validateSpec, type GameSpec } from '@spec';
import type { Group } from 'three';
import { Engine } from '../engine/Engine';
import { BLUEPRINTS } from '../blueprints/index';
import { generateSpec } from '../generator/generate';
import {
  registerPreBootEnemyKind,
  preBootEnemyKindIds,
  type CustomEnemyKindDef,
} from '../engine/game/Modding';
import { applyLoadout, loadProfile, saveProfile, getGearLoadouts, setGearLoadout, renameGearLoadout, clearGearLoadout } from '../engine/game/Profile';
import {
  MAX_LOADOUTS,
  validateGearLoadouts,
  defaultGearLoadouts,
  captureLoadout,
  applyGearLoadout,
  loadoutPieceCount,
} from '../engine/game/loadouts';
import { Progression } from '../engine/game/Progression';
import {
  PROGRESSION_TABLE,
  LEVEL_CAP,
  levelRow,
} from '../engine/game/progressionCurve';
import {
  grantKillXp,
  grantPickupXp,
  grantCraftXp,
} from '../blueprints/campaign';
import type { PlayerAvatar } from '../blueprints/common';
import { resolveSplash, showSplash } from './splash';
import { spawnNpcsForMap } from '../engine/game/Npc';
import {
  NpcInteractionSession,
  registerNpcInteractables,
  unregisterNpcInteractables,
} from '../engine/game/npcInteraction';
import { resolveNpcCount } from '../engine/game/npcTuning';
import { NpcInstancer } from '../engine/game/npcInstancing';
import type { Npc } from '../engine/game/Npc';
import { EnemyManager, ENEMY_SALT, type Enemy } from '../engine/game/EnemyAI';
import { resolveEnemyDensity } from '../engine/game/enemyTuning';
import {
  SCALING_SALT,
  ENEMY_LEVEL_BANDS,
  SCALING_BAND_WIDTH,
  effectiveSpawnLevel,
  bandIndexForLevel,
  mapDistanceFromSpec,
  applyEnemyScaling,
} from '../engine/game/enemyScaling';
/**
 * UPGRADE LOOP (elite-affixes): pure affix functions for the e2e
 * replication assertions (same shipped code the spawn path uses).
 */
import {
  ELITE_SALT,
  ELITE_AFFIX_DEFS,
  ELITE_DOUBLE_CHANCE,
  VOLATILE_RADIUS,
  VOLATILE_DAMAGE_FRAC,
  resolveEliteChance,
  rollEliteAffixes,
  eliteModsFor,
  applyEliteAffixes,
  eliteLabel,
} from '../engine/game/eliteAffixes';
/**
 * UPGRADE LOOP (difficulty-modes): pure difficulty functions for the e2e
 * table assertions (same shipped code the spawn path uses).
 */
import {
  DIFFICULTY_TABLE,
  DIFFICULTY_IDS,
  difficultyById,
  isDifficultyId,
  applyDifficultyScaling,
} from '../engine/game/difficulty';
/**
 * UPGRADE LOOP (stealth-system): pure stealth functions for the e2e
 * replication assertions (same shipped code the spawn/perception path
 * uses).
 */
import {
  STEALTH_TABLE,
  DETECTION_JITTER_SALT,
  AwarenessTracker,
  applySneakBonus,
  baseDetectionRadiusFor,
  detectionJitterFor,
  detectionRadiusFor,
  noiseRadiusFor,
  targetWeightFor,
} from '../engine/game/stealth';
import { CRIT_TABLE, critMultiplierFor } from '../engine/game/crit';
/**
 * UPGRADE LOOP (new-game-plus): pure NG+ table + apply fn for the e2e
 * per-table stat assertions (same shipped code the spawn path uses).
 */
import {
  NG_PLUS_TABLE,
  MAX_NG_PLUS_CYCLE,
  ngPlusByCycle,
  applyNgPlusScaling,
} from '../engine/game/newGamePlus';
import {
  GatheringManager,
  GatheringInteractionSession,
  GATHER_SALT,
  MATERIAL_IDS,
  NODE_DEFS,
} from '../engine/game/gathering';
import {
  StationManager,
  CraftingInteractionSession,
  STATION_SALT,
  STATION_IDS,
} from '../engine/game/stations';
import {
  buildRecipePool,
  checkCraft,
  craft,
  resolveCraftingEnabled,
  ensureCraftingItemDefs,
  craftedItemDefs,
  materialItemDefs,
} from '../engine/game/crafting';
import {
  MASTER_CATALOG_RECIPES,
  masterTier3OutputDefs,
  MASTER_TIER3_OUTPUT_IDS,
} from '../engine/game/mastercraft';
import {
  LOOT_SALT,
  LOOT_MATERIAL_IDS,
  LOOT_GEAR_IDS,
  LOOT_TIER2_OUTPUT_IDS,
  LOOT_CATALOG_RECIPES,
  buildLootRng,
  rollLoot,
  ensureLootItemDefs,
  lootItemDefs,
} from '../engine/game/loot';
import {
  DEPLOY_SALT,
  DEPLOYABLE_DEFS,
  DEPLOY_CATALOG_RECIPES,
  DeployablesManager,
  Deployable,
  deployableDefOf,
  deployableItemDefs,
  rollDeployTickMagnitude,
} from '../engine/game/deployables';
import {
  COMPANION_SALT,
  COMPANION_WOUND_BONUS,
  COMPANION_DEFS,
  CompanionsManager,
  Companion,
  companionDefOf,
  rollCompanionDamage,
  rollCompanionHeal,
  rollFollowOffset,
  pickCompanionTarget,
} from '../engine/game/companions';
import {
  COMPANION_TARGET_WEIGHTS,
  COMPANION_STANCES,
  COMPANION_REVIVE_COST,
  GUARD_DAMAGE_FRACTION,
  pickEnemyTarget,
  applyGuardReduction,
  enemyAggroRange,
} from '../engine/game/companionCombat';
import {
  CAMP_SALT,
  CAMP_STRUCTURE_DEFS,
  CAMP_STRUCTURE_TIERS,
  CampManager,
  CampProp,
  campAnchorCoords,
  campSitePosition,
  campStructureDefOf,
  campStructureMaxTier,
  campStructureTierOf,
  campTierVisualParts,
  WORKBENCH_DAMAGE_MULT,
  WORKBENCH_BUFF_DURATION_S,
} from '../engine/game/camp';
import {
  MOUNT_DEFS,
  MountState,
  MountManager,
  mountDefOf,
  buildMountVisual,
} from '../engine/game/mounts';
import {
  VENDOR_SALT,
  CURRENCY_SALT,
  CURRENCY_NAME,
  DEFAULT_BUY_MULT,
  DEFAULT_SELL_MULT,
  VENDOR_CATALOG,
  Wallet,
  resolveVendorDefs,
  buildVendorNpcSpecs,
  buildVendorStock,
  unitSellPrice,
  isSellable,
  hashStr32,
  buildCurrencyRng,
  rollCurrencyDrops,
} from '../engine/game/economy';
import {
  GEAR_SETS,
  SET_PIECE_IDS,
  SET_DROP_ADDONS,
  SET_CATALOG_RECIPES,
  setGearDefs,
  computeSetBonuses,
  buildSetUiReport,
  ensureSetItemDefs,
} from '../engine/game/setBonuses';
import {
  ENCHANT_DEFS,
  ENCHANT_MATERIAL_IDS,
  ENCHANT_DROP_ADDONS,
  enchantDef,
  enchantMaterialDefs,
  computeEnchantStats,
  ensureEnchantItemDefs,
} from '../engine/game/enchantments';
import {
  DAMAGE_TYPES,
  ELEMENTAL_TABLE,
  ENEMY_RESISTANCES,
  elementalDef,
  isDamageType,
  normalizeDamageType,
  resistanceFor,
  elementalMultiplierFor,
  applyElemental,
  resistanceLines,
  outgoingDamageType,
  outgoingDamageTypeDetail,
} from '../engine/game/elemental';
import {
  SALVAGE_SALT,
  SALVAGE_TABLE,
  SET_PIECE_SALVAGE_BONUS,
  salvageRowFor,
  isSetPiece,
  salvageSeedFor,
  buildSalvageRng,
  rollSalvageYields,
  clearSalvagedFromLoadouts,
} from '../engine/game/salvage';
import {
  QuestManager,
  buildQuestPool,
  resolveQuestsEnabled,
  validateQuestDef,
  QUEST_SALT,
} from '../engine/game/quests';
import { SIDE_QUEST_SALT, buildSideQuestPool } from '../engine/game/sidequests';
import {
  DIALOGUE_TREES,
  DialogueEngine,
  DialogueState,
  FIRST_QUEST_REF,
  localStorageDialogueAdapter,
  validateDialogueTree,
  validateDialogueTrees,
} from '../engine/game/dialogue';
import { biomeMusicPattern, AUDIO_SALT } from '../engine/game/biomeMusic';
import {
  RADIANT_SALT,
  RADIANT_TEMPLATES,
  buildRadiantOffers,
  radiantOfferAt,
  radiantTierForLevel,
  resolveRadiantCount,
  eligibleRadiantTemplates,
  RadiantBoard,
} from '../engine/game/radiantQuests';
import {
  TIMED_QUEST_SALT,
  TIMED_TEMPLATES,
  buildTimedOffers,
  timedOfferAt,
  resolveTimedCount,
  eligibleTimedTemplates,
  TimedBoard,
} from '../engine/game/timedQuests';
import {
  CURATED_STORY_REWARDS,
  CURATED_SIDE_REWARDS,
  QUEST_REWARD_SLUGS,
  QUEST_REWARD_BONUS_SALT,
  questBonusItem,
  curatedQuestReward,
  allCuratedItemIds,
} from '../engine/game/questRewards';
import { QuestTalkSession } from '../engine/game/questTalk';
import {
  resolveQuestWaypoint,
  trackedObjective,
  WAYPOINT_SCAN_INTERVAL_S,
} from '../engine/game/questWaypoints';
import {
  BOSS_SALT,
  BOSS_DEFS,
  BOSS_ATTACKS,
  DEFAULT_BOSS_ID,
  planBossArena,
  phaseIndexFor,
  pickNextAttack,
  rollCooldown,
  attackHitsPlayer,
  bossEnabled,
  resolveBossDef,
  resolveArenaRadius,
  BossEncounter,
} from '../engine/game/bosses';
import type { BossBar } from '../engine/ui/BossBar';
import {
  WORLDBOSS_SALT,
  WORLDBOSS_BASE_HEALTH,
  planWorldBoss,
  resolveWorldBossEnabled,
  resolveWorldBossDef,
  WorldBossEvent,
} from '../engine/game/worldBoss';
import {
  SkillSystem,
  SKILL_DEFS,
  SKILL_IDS,
  SYNERGY_DEFS,
  evaluateSynergies,
  resolveSkillsEnabled,
  resolveSkillsXpMultiplier,
} from '../engine/game/skills';
import { SkillsPanel } from '../engine/ui/SkillsPanel';
import { FastTravelPanel } from '../engine/ui/FastTravelPanel';
import { WorldAtlasPanel } from '../engine/ui/WorldAtlasPanel';
import { buildAtlasModel, unchartedNeighborCount, fogPercentOf } from '../engine/world/WorldAtlas';
import { FastTravelRegistry, fastTravelArrivalEdge, FAST_TRAVEL_STORAGE_KEY } from '../engine/world/FastTravel';
import {
  ABILITY_DEFS,
  ABILITY_IDS,
  ABILITY_SALT,
  MAX_ENERGY,
  ENERGY_REGEN_PER_S,
  AbilityManager,
  AbilityBar,
  resolveAbilitiesEnabled,
} from '../engine/game/combatAbilities';
import * as THREE from 'three';
import {
  deriveWorldTier,
  MAX_WORLD_TIER,
  TIER_SALT,
  clampTier,
} from '../engine/world/worldTiers';
import { deriveMapSeed, type MapCoord } from '../engine/world/MapGraph';
import { PortalTransition } from '../engine/world/PortalState';
import {
  EVENT_DEFS,
  EVENT_SALT,
  planDynamicEvents,
  buildMerchantStock,
  resolveEventsEnabled,
  rollEventCurrency,
  DynamicEventManager,
  EventInteractionSession,
} from '../engine/game/dynamicEvents';
import { TradePanel } from '../engine/ui/TradePanel';
import {
  FACTION_CATALOG,
  FACTION_IDS,
  STANDING_TIERS,
  STANDING_MIN,
  STANDING_MAX,
  ENEMY_KIND_FACTION,
  VENDOR_FACTION,
  KILL_STANDING_DELTA,
  BOSS_KILL_STANDING_DELTA,
  TRADE_BUY_STANDING_DELTA,
  TRADE_SELL_STANDING_DELTA,
  QUEST_DEFAULT_STANDING_DELTA,
  QUEST_DEFAULT_FACTION,
  tierForStanding,
  clampStanding,
  standingBuyFactor,
  standingSellFactor,
  effectiveBuyPrice,
  effectiveSellPrice,
  factionOfEnemyKind,
  factionOfVendor,
  FactionStandings,
  localStorageFactionsAdapter,
  type FactionStandingsSnapshot,
} from '../engine/game/factions';
import {
  WEATHER_SALT,
  WEATHER_TUNING,
  planWeatherCycle,
  segmentAt,
  resolveWeatherCyclesEnabled,
  resolveForcedWeather,
  WeatherCycleManager,
} from '../engine/game/weatherCycles';
import {
  HAZARD_SALT,
  HAZARD_DEFS,
  planHazardZones,
  resolveHazardsEnabled,
  resolveHazardCount,
  HazardZoneManager,
} from '../engine/game/hazardZones';

declare global {
  interface Window {
    __XANDRIA_SPEC__?: GameSpec;
    /**
     * Splash credit flag. Baked into standalone exports by the studio
     * (free tier → true, paid tiers → the user's toggle, default false);
     * also settable via ?splash=0|1. Defaults to true (shown).
     */
    __XANDRIA_SPLASH__?: boolean;
    __XANDRIA__?: {
      /** Set at boot(); absent on the pre-boot object below. */
      engine?: Engine;
      /** Set at boot(); absent on the pre-boot object below. */
      spec?: GameSpec;
      /** Set at boot(); absent on the pre-boot object below. */
      blueprint?: unknown;
      errors: string[];
      /**
       * Pre-boot modding API (R2-M4, real-page wiring R3-M1). In a real
       * browser page this exists from parse time: the inline classic
       * <script> in player.html (ahead of this deferred bundle module)
       * installs a queue-only stub, so a modder's own classic <script> can
       * register custom enemy kinds BEFORE the bundle evaluates — and
       * therefore before boot() validates `window.__XANDRIA_SPEC__`:
       *   <script>__XANDRIA__.registerEnemyKind('stalker', { base: 'walker', name: 'Stalker' });</script>
       *   <script>window.__XANDRIA_SPEC__ = specUsingStalkerKind;</script>
       * At module load the bundle drains the queue into the module-level
       * registry (see registerPreBootEnemyKind in Modding.ts) and replaces
       * the stub with the registry-backed function. In-process callers get
       * the registry-backed function directly.
       */
      registerEnemyKind?: (id: string, def: CustomEnemyKindDef) => void;
    };
    __XANDRIA_ERRORS: string[];
  }
}

window.__XANDRIA_ERRORS = [];
// R3-M1: the inline classic <script> in player.html runs at parse time,
// before this deferred module, and queues pre-boot enemy-kind registrations
// on window.__XANDRIA__._preBootKinds. Drain the queue into the module-level
// registry (strictly separate from per-engine instance registration, per
// round-2's isolation rule) BEFORE boot() validates any injected spec — this
// queue is the only interleaving point a real page script can use.
const preBootState = (window.__XANDRIA__ ?? {}) as {
  errors?: unknown;
  _preBootKinds?: unknown;
};
window.__XANDRIA_ERRORS = Array.isArray(preBootState.errors) ? (preBootState.errors as string[]) : [];
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  window.__XANDRIA_ERRORS.push(args.map(String).join(' '));
  origError(...args);
};
addEventListener('error', (e) => window.__XANDRIA_ERRORS.push(String(e.message)));
addEventListener('unhandledrejection', (e) => window.__XANDRIA_ERRORS.push(String(e.reason)));
const preBootQueue = Array.isArray(preBootState._preBootKinds) ? preBootState._preBootKinds : [];
for (const entry of preBootQueue) {
  const [id, def] = entry as [string, CustomEnemyKindDef];
  try {
    registerPreBootEnemyKind(id, def);
  } catch (e) {
    // Loud (lands in __XANDRIA_ERRORS via the capture above), and the drain
    // continues: the bad kind simply won't validate, and the R3-N1 banner
    // tells the player the injected spec didn't load.
    console.error(`pre-boot registerEnemyKind failed for "${String(id)}":`, e);
  }
}
// Publish the real registry-backed API, replacing the queue-only inline stub.
window.__XANDRIA__ = {
  errors: window.__XANDRIA_ERRORS,
  registerEnemyKind: registerPreBootEnemyKind,
};

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}

/**
 * R3-N1: an invalid injected spec used to fall back to the default game with
 * only a console.warn — the player saw the wrong game with no indication.
 * Show a loud, dismissible on-screen banner as well. Called from
 * resolveSpec() during boot(); the normal boot path never reaches it.
 */
function showSpecFallbackBanner(errors: string[]): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('xandria-spec-fallback')) return;
  const detail =
    errors.slice(0, 3).join('; ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : '');
  const banner = document.createElement('div');
  banner.id = 'xandria-spec-fallback';
  banner.setAttribute('role', 'alert');
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
    'background:#4a0f16', 'color:#ffe3e6', 'border-bottom:2px solid #ff5d6c',
    'font:13px/1.5 system-ui,-apple-system,sans-serif', 'padding:10px 48px 10px 14px',
    'text-align:center',
  ].join(';');
  const msg = document.createElement('span');
  // textContent: validator errors are untrusted strings, never HTML.
  msg.textContent =
    `XANDRIA: the injected game spec was invalid (${detail}) — loaded the default game instead.`;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Dismiss this notice');
  dismiss.style.cssText = [
    'position:absolute', 'top:6px', 'right:10px', 'background:transparent',
    'border:1px solid #ff8b95', 'border-radius:4px', 'color:#ffe3e6',
    'font-size:14px', 'line-height:1', 'padding:4px 8px', 'cursor:pointer',
  ].join(';');
  dismiss.addEventListener('click', () => banner.remove());
  banner.append(msg, dismiss);
  document.body.appendChild(banner);
}

function resolveSpec(): GameSpec {
  const params = new URLSearchParams(location.search);
  if (window.__XANDRIA_SPEC__) {
    // R2-M4: validate against pre-boot-registered custom enemy kinds
    // (registered via __XANDRIA__.registerEnemyKind before injection) so a
    // modder's spec isn't silently swapped for the default game.
    const v = validateSpec(window.__XANDRIA_SPEC__, { customEnemyKinds: preBootEnemyKindIds() });
    if (v.ok) return window.__XANDRIA_SPEC__;
    console.warn('invalid injected spec, falling back', v.errors);
    showSpecFallbackBanner(v.errors);
  }
  const specParam = params.get('spec');
  if (specParam) {
    try {
      const raw = JSON.parse(b64urlDecode(specParam));
      return normalizeSpec(raw);
    } catch (e) {
      console.warn('bad ?spec= param:', e);
    }
  }
  const intent = params.get('intent');
  if (intent) return generateSpec(intent);
  return generateSpec('a heroic knight adventure through ancient forest ruins at dusk');
}

function boot() {
  const spec = resolveSpec();
  document.title = `${spec.meta.name} — XANDRIA`;
  // "Made with XANDRIA" splash credit: unskippable ~3s overlay, forced on for
  // the free tier, removable for paid tiers. Non-blocking — the engine boots
  // underneath while the overlay covers the screen.
  if (resolveSplash(location.search, window.__XANDRIA_SPLASH__)) {
    showSplash();
  }
  const container = document.getElementById('app')!;
  const engine = new Engine(container, spec);
  const build = BLUEPRINTS[spec.meta.genre];
  // R4-M2: the equipped modifier loadout must be on the spec BEFORE the
  // first blueprint build. PlayerAvatar value-copies spec.player.health /
  // spec.rules.lives at construction, so a loadout applied later (in
  // beginPlay) left vitality/secondwind inert on run 1. resetRun() already
  // upholds this for rebuilds; this upholds it for the first build.
  // applyLoadout is idempotent (restores pristine base values first).
  applyLoadout(spec, loadProfile());
  // UPGRADE LOOP (weather-cycles): the static authored weather is the
  // particle default — set BEFORE the blueprint builds, so a blueprint with
  // a weather-cycle manager (tpAction) overrides it with the cycle's opening
  // segment on spawnForMap instead of being stomped by this line.
  engine.particles.setWeather(spec.theme.weather, spec.meta.seed, engine.effectiveQuality(), spec.meta.genre);
  const blueprint = build(engine, spec);
  // Preserve the pre-boot modding API when publishing the booted state.
  window.__XANDRIA__ = { ...window.__XANDRIA__, engine, spec, blueprint, errors: window.__XANDRIA_ERRORS };
  // FAST-TRAVEL (upgrade loop): the world-map panel, built once per boot
  // (not per blueprint rebuild — the PortalManager persists across
  // restarts, so the panel's live reads stay valid). Only when portals are
  // enabled: portal-off specs get no chip, no key handler, no per-frame
  // work. isModalOpen reads the blueprint's own panels defensively —
  // other blueprints may not build every panel.
  let fastTravelPanel: FastTravelPanel | null = null;
  if (engine.portalManager) {
    const pm = engine.portalManager;
    const bp = blueprint as unknown as Record<string, { isOpen?: boolean } | null | undefined>;
    fastTravelPanel = new FastTravelPanel({
      container: engine.container,
      discovered: () => pm.discovered.list(),
      // camp-upgrades: camp anchors derived live from the discovered
      // list + the save-slot campBuilt record (no new storage; a camp
      // anchors exactly the maps it was built on, per map seed).
      campAnchors: () => {
        try {
          return campAnchorCoords(pm.discovered.list(), loadProfile().campBuilt ?? {}, pm.worldSeedValue);
        } catch {
          return [];
        }
      },
      current: () => ({ ...pm.coord }),
      onTravel: (c) => pm.fastTravelTo(c),
      isModalOpen: () => !!(bp.skillsPanel?.isOpen || bp.bestiaryPanel?.isOpen
        || bp.achievementsPanel?.isOpen || bp.shopPanel?.isOpen),
    });
  }
  // WORLD-ATLAS (upgrade loop): the discovered-maps overview panel,
  // built once per boot beside the world-map panel (not per blueprint
  // rebuild — the PortalManager persists across restarts). It observes
  // only: the registry for the map list, the minimap for session fog
  // percentages, and the save profile for built camp structures
  // (keyed by deriveMapSeed — the same seed CampManager's spawnForMap
  // receives). No key shortcut: every panel letter is taken; the chip
  // below the MAP chip is the entry point, on the title screen too.
  let worldAtlasPanel: WorldAtlasPanel | null = null;
  if (engine.portalManager) {
    const pm = engine.portalManager;
    const bp = blueprint as unknown as Record<string, { isOpen?: boolean } | null | undefined>;
    worldAtlasPanel = new WorldAtlasPanel({
      container: engine.container,
      discovered: () => pm.discovered.list(),
      current: () => ({ ...pm.coord }),
      fogCoverage: (c) => engine.minimap.coverageFor(c.mx, c.my),
      campStructures: (c) => {
        try {
          const seed = deriveMapSeed(pm.getWorldSeed(), c.mx, c.my);
          const built = loadProfile().campBuilt?.[String(seed)];
          return Array.isArray(built) ? [...built] : [];
        } catch {
          return [];
        }
      },
      onTravel: (c) => pm.fastTravelTo(c),
      isModalOpen: () => !!(bp.skillsPanel?.isOpen || bp.bestiaryPanel?.isOpen
        || bp.achievementsPanel?.isOpen || bp.shopPanel?.isOpen || fastTravelPanel?.isOpen),
    });
  }
  // NPCs wave (workstream C): test-mode seam. The e2e and perf harnesses
  // spawn NPCs against A's API directly (spawnNpcsForMap) and register the
  // interactables manually — workstream B's manager is not on this path.
  if (engine.testMode) {
    // FAST-TRAVEL (upgrade loop): test-mode seam for the fast-travel e2e.
    (window.__XANDRIA__ as Record<string, unknown>).fastTravelTest = {
      FastTravelRegistry,
      fastTravelArrivalEdge,
      FAST_TRAVEL_STORAGE_KEY,
      /** Test seam: the live world-map panel (null when portals disabled). */
      livePanel: (): FastTravelPanel | null => fastTravelPanel,
      /** Test seam: the live discovered-portal registry (null when portals disabled). */
      liveRegistry: (): FastTravelRegistry | null => engine.portalManager?.discovered ?? null,
    };
    // PHOTO-MODE (upgrade loop): test-mode seam for the photo-mode e2e.
    // All reads/writes are synchronous within one evaluate() call, so
    // the camera-restore assertion is exact (no rendered frame in between).
    (window.__XANDRIA__ as Record<string, unknown>).photoTest = {
      enter: (): boolean => engine.photoMode.enter(),
      exit: (): boolean => engine.photoMode.exit(),
      active: (): boolean => engine.photoMode.active,
      orbit: () => engine.photoMode.orbit,
      setOrbit: (o: { yaw?: number; pitch?: number; distance?: number }) => engine.photoMode.setOrbit(o),
      savedCamera: () => engine.photoMode.savedCamera,
      requestCapture: (): boolean => engine.photoMode.requestCapture(),
      capturePending: (): boolean => engine.photoMode.capturePending,
      lastScreenshot: (): string | null => engine.photoMode.lastScreenshot,
      cameraState: () => ({
        position: engine.camera.position.toArray(),
        quaternion: engine.camera.quaternion.toArray(),
        fov: engine.camera.fov,
      }),
    };
    // WORLD-ATLAS (upgrade loop): test-mode seam for the atlas e2e.
    (window.__XANDRIA__ as Record<string, unknown>).atlasTest = {
      WorldAtlasPanel,
      buildAtlasModel,
      unchartedNeighborCount,
      fogPercentOf,
      /** Test seam: the live atlas panel (null when portals disabled). */
      livePanel: (): WorldAtlasPanel | null => worldAtlasPanel,
      /** Test seam: the live discovered-portal registry (null when portals disabled). */
      liveRegistry: (): FastTravelRegistry | null => engine.portalManager?.discovered ?? null,
    };
    (window.__XANDRIA__ as Record<string, unknown>).npcTest = {      spawnNpcsForMap,
      registerNpcInteractables,
      unregisterNpcInteractables,
      NpcInteractionSession,
      resolveNpcCount,
      // Instancing pass: submit static (never-ticked) NPCs to the
      // per-engine instancer once — instances persist, no per-frame work.
      submitStaticNpcs: (npcs: Npc[]) => {
        const inst = NpcInstancer.for(engine);
        inst.beginFrame();
        for (const n of npcs) {
          inst.register(n);
          inst.submit(n);
        }
        inst.endFrame();
      },
      /** Test seam: drop all buckets (restores direct rendering). */
      resetInstancer: () => NpcInstancer.for(engine).reset(),
      /** Test seam: bucket/instance diagnostics. */
      instancerStats: () => NpcInstancer.for(engine).stats(),
    };
    // Enemies wave (workstream C): test-mode seam for the enemy e2e +
    // perf harnesses — the manager + instancing + density resolution.
    (window.__XANDRIA__ as Record<string, unknown>).enemyTest = {
      EnemyManager,
      ENEMY_SALT,
      resolveEnemyDensity,
      // UPGRADE LOOP (enemy-scaling): pure scaling functions for the e2e
      // band assertions (same shipped code the spawn path uses).
      enemyScaling: {
        SCALING_SALT,
        ENEMY_LEVEL_BANDS,
        SCALING_BAND_WIDTH,
        effectiveSpawnLevel,
        bandIndexForLevel,
        mapDistanceFromSpec,
        applyEnemyScaling,
      },
      // UPGRADE LOOP (difficulty-modes): pure difficulty table + apply fn
      // for the e2e per-table stat assertions (same shipped code the spawn
      // path uses). Live engine.getDifficultyMode()/setDifficultyMode()
      // are methods on X.engine.
      difficulty: {
        DIFFICULTY_TABLE,
        DIFFICULTY_IDS,
        difficultyById,
        isDifficultyId,
        applyDifficultyScaling,
      },
      // UPGRADE LOOP (new-game-plus): pure NG+ table + apply fn for the
      // e2e per-table stat assertions (same shipped code the spawn path
      // uses). Live engine.getNgPlusCycle()/enterNgPlus() are methods on
      // X.engine.
      ngPlus: {
        NG_PLUS_TABLE,
        MAX_NG_PLUS_CYCLE,
        ngPlusByCycle,
        applyNgPlusScaling,
      },
      // UPGRADE LOOP (elite-affixes): pure affix table + roll + apply fn
      // for the e2e per-affix combat assertions (same shipped code the
      // spawn path uses). Live managers read eliteChance from the spec.
      eliteAffixes: {
        ELITE_SALT,
        ELITE_AFFIX_DEFS,
        ELITE_DOUBLE_CHANCE,
        VOLATILE_RADIUS,
        VOLATILE_DAMAGE_FRAC,
        resolveEliteChance,
        rollEliteAffixes,
        eliteModsFor,
        applyEliteAffixes,
        eliteLabel,
      },
      /** Test seam: submit never-ticked enemies once (instances persist). */
      submitStaticEnemies: (enemies: Enemy[]) => {
        const inst = NpcInstancer.for(engine);
        inst.beginFrame();
        for (const e of enemies) {
          inst.registerEnemy(e);
          inst.submit(e);
        }
        inst.endFrame();
      },
      /** Test seam: drop all buckets (restores direct rendering). */
      resetEnemyInstancer: () => NpcInstancer.for(engine).reset(),
      /**
       * Test seam: drop THESE enemies from the buckets and re-show their
       * source meshes (direct rendering), leaving other registrants (NPCs)
       * instanced. For a clean instanced-vs-direct A/B on the enemy roster
       * alone — reset() would also drop the villagers and confound the delta.
       */
      setEnemiesDirect: (enemies: Enemy[]) => {
        const inst = NpcInstancer.for(engine);
        for (const e of enemies) {
          inst.unregister(e);
          e.renderRoot?.traverse((o) => {
            if ((o as { isMesh?: boolean }).isMesh) (o as { visible: boolean }).visible = true;
          });
        }
      },
      /** Test seam: bucket/instance diagnostics. */
      enemyInstancerStats: () => NpcInstancer.for(engine).stats(),
    };
    // STEALTH-SYSTEM: test-mode seam for the stealth e2e — the tuning
    // table, pure detection/noise/weight functions, and the crit table
    // the sneak bonus reuses (same shipped code the game uses).
    (window.__XANDRIA__ as Record<string, unknown>).stealthTest = {
      STEALTH_TABLE,
      DETECTION_JITTER_SALT,
      AwarenessTracker,
      applySneakBonus,
      baseDetectionRadiusFor,
      detectionJitterFor,
      detectionRadiusFor,
      noiseRadiusFor,
      targetWeightFor,
      CRIT_TABLE,
      critMultiplierFor,
    };
    // Crafting wave (workstream B): test-mode seam for the gathering e2e +
    // perf harnesses — the manager, salts, material ids, session.
    (window.__XANDRIA__ as Record<string, unknown>).gatheringTest = {
      GatheringManager,
      GatheringInteractionSession,
      GATHER_SALT,
      MATERIAL_IDS,
      NODE_DEFS,
      /** Test seam: the live gathering manager from the blueprint build (null when absent). */
      liveManager: (): GatheringManager | null =>
        (blueprint as { gathering?: GatheringManager }).gathering ?? null,
      /** Test seam: the live gathering interaction session (null when UI disabled). */
      liveSession: (): GatheringInteractionSession | null =>
        (blueprint as { gatheringSession?: GatheringInteractionSession }).gatheringSession ?? null,
    };
    // Crafting wave (workstream C): test-mode seam for the stations + panel
    // e2e and perf harnesses — the manager, session, salts, station ids,
    // recipe/craft engine and the live blueprint handles.
    (window.__XANDRIA__ as Record<string, unknown>).craftingTest = {
      StationManager,
      CraftingInteractionSession,
      STATION_SALT,
      STATION_IDS,
      buildRecipePool,
      checkCraft,
      craft,
      resolveCraftingEnabled,
      ensureCraftingItemDefs,
      craftedItemDefs,
      materialItemDefs,
      /** Master-crafting wave: tier-3 recipe catalog + output defs. */
      MASTER_CATALOG_RECIPES,
      masterTier3OutputDefs,
      MASTER_TIER3_OUTPUT_IDS,
      /** Test seam: the live station manager from the blueprint build (null when absent). */
      liveStations: (): StationManager | null =>
        (blueprint as { stations?: StationManager }).stations ?? null,
      /** Test seam: the live station session from the blueprint build (null when crafting disabled). */
      liveSession: (): CraftingInteractionSession | null =>
        (blueprint as { stationSession?: CraftingInteractionSession | null }).stationSession ?? null,
      /**
       * Test seam: submit never-ticked stations + nodes once (instances
       * persist) — the perf harness's static layer needs no per-frame work.
       * Must run while the engine is PAUSED: the running frame loop would
       * otherwise zero the one-shot submits.
       */
      submitStaticLayer: (ents: Array<{ renderRoot: Group | null }>) => {
        const inst = NpcInstancer.for(engine);
        inst.beginFrame();
        for (const e of ents) {
          if (!inst.isRegistered(e)) inst.registerEnemy(e);
          inst.submit(e);
        }
        inst.endFrame();
      },
      /** Test seam: bucket/instance diagnostics. */
      craftingInstancerStats: () => NpcInstancer.for(engine).stats(),
    };
    // Items-expansion wave: test-mode seam for the loot e2e + unit
    // harnesses — salts, ids, the seeded roll functions, and the live
    // blueprint handles (manager owns the loot stream, item world
    // receives the drops, inventory collects them).
    (window.__XANDRIA__ as Record<string, unknown>).lootTest = {
      LOOT_SALT,
      LOOT_MATERIAL_IDS,
      LOOT_GEAR_IDS,
      LOOT_TIER2_OUTPUT_IDS,
      LOOT_CATALOG_RECIPES,
      buildLootRng,
      rollLoot,
      ensureLootItemDefs,
      lootItemDefs,
      /** Test seam: the live enemy manager from the blueprint build (owns the loot stream). */
      liveManager: (): EnemyManager | null =>
        (blueprint as { enemies?: EnemyManager }).enemies ?? null,
      /** Test seam: the live item world (receives the drops). */
      liveItemWorld: (): { liveItems: readonly { id: string; count: number }[] } | null =>
        (blueprint as { itemWorld?: { liveItems: readonly { id: string; count: number }[] } | null }).itemWorld ?? null,
      /** Test seam: the live player inventory. */
      liveInventory: (): {
        count: (id: string) => number;
        add: (id: string, count?: number) => number;
        equip: (id: string) => unknown;
        unequip: (slot: string) => boolean;
        getEquipped: (slot: string) => string | null;
        equippedStats: () => Record<string, number>;
        setBonusStats: () => Record<string, number>;
        enchantStats: () => Record<string, number>;
        effectiveStats: () => Record<string, number>;
        getEnchant: (id: string) => string | null;
        enchant: (id: string, enchantId: string) => { ok: boolean; reason?: string };
        removeEnchant: (id: string) => { itemId: string; count: number }[];
        isSalvageable: (id: string) => { ok: boolean; reason?: string };
        salvagePreview: (id: string) => { itemId: string; count: number }[] | null;
        salvage: (id: string, opts?: { onClearLoadout?: (itemId: string) => void }) => {
          ok: boolean; reason?: string;
          yields?: { itemId: string; count: number }[];
          enchantCleared?: string | null; setPiece?: boolean;
        };
        salvageAllJunk: (opts?: { onClearLoadout?: (itemId: string) => void }) => {
          salvaged: Array<{ itemId: string; units: number; yields: { itemId: string; count: number }[] }>;
          skipped: Array<{ itemId: string; reason: string }>;
          yields: { itemId: string; count: number }[];
        };
        previewSalvageAllJunk: () => {
          plan: Array<{ itemId: string; units: number; yields: { itemId: string; count: number }[] }>;
          skipped: Array<{ itemId: string; reason: string }>;
        };
        salvageCount: () => number;
        serialize: () => string;
        restore: (serialized: string) => void;
        setJunk: (id: string, flag: boolean) => void;
        isJunk: (id: string) => boolean;
      } | null =>
        (blueprint as { itemKit?: { inventory?: {
          count: (id: string) => number;
          add: (id: string, count?: number) => number;
          equip: (id: string) => unknown;
          unequip: (slot: string) => boolean;
          getEquipped: (slot: string) => string | null;
          equippedStats: () => Record<string, number>;
          setBonusStats: () => Record<string, number>;
          enchantStats: () => Record<string, number>;
          effectiveStats: () => Record<string, number>;
          getEnchant: (id: string) => string | null;
          enchant: (id: string, enchantId: string) => { ok: boolean; reason?: string };
          removeEnchant: (id: string) => { itemId: string; count: number }[];
          isSalvageable: (id: string) => { ok: boolean; reason?: string };
          salvagePreview: (id: string) => { itemId: string; count: number }[] | null;
          salvage: (id: string, opts?: { onClearLoadout?: (itemId: string) => void }) => {
            ok: boolean; reason?: string;
            yields?: { itemId: string; count: number }[];
            enchantCleared?: string | null; setPiece?: boolean;
          };
          salvageAllJunk: (opts?: { onClearLoadout?: (itemId: string) => void }) => {
            salvaged: Array<{ itemId: string; units: number; yields: { itemId: string; count: number }[] }>;
            skipped: Array<{ itemId: string; reason: string }>;
            yields: { itemId: string; count: number }[];
          };
          previewSalvageAllJunk: () => {
            plan: Array<{ itemId: string; units: number; yields: { itemId: string; count: number }[] }>;
            skipped: Array<{ itemId: string; reason: string }>;
          };
          salvageCount: () => number;
          serialize: () => string;
          restore: (serialized: string) => void;
          setJunk: (id: string, flag: boolean) => void;
          isJunk: (id: string) => boolean;
        } } | null }).itemKit?.inventory ?? null,
      /** Test seam: the live inventory HUD (inventory-qol wave). */
      liveInventoryHud: (): {
        open: () => void;
        close: () => void;
        isOpen: () => boolean;
      } | null =>
        (blueprint as { itemKit?: { hud?: {
          open: () => void;
          close: () => void;
          isOpen: () => boolean;
        } } | null }).itemKit?.hud ?? null,
    };
    // UPGRADE LOOP (deployables): test-mode seam for the deployables e2e
    // + perf harnesses — the defs table, salts, recipes, the seeded tick
    // roll, and the live blueprint manager.
    (window.__XANDRIA__ as Record<string, unknown>).deployTest = {
      DEPLOY_SALT,
      DEPLOYABLE_DEFS,
      DEPLOY_CATALOG_RECIPES,
      DeployablesManager,
      Deployable,
      deployableDefOf,
      deployableItemDefs,
      rollDeployTickMagnitude,
      /** Test seam: the live deployables manager from the blueprint build. */
      liveManager: (): DeployablesManager | null =>
        (blueprint as { deployables?: DeployablesManager }).deployables ?? null,
      /** Test seam: the live enemy manager (damage-tick + lure assertions). */
      liveEnemies: (): { enemies: Array<{ alive: boolean; health: number; position: unknown; lureTarget: unknown; damage(n: number, from?: unknown): void }> } | null =>
        (blueprint as { enemies?: { enemies: Array<{ alive: boolean; health: number; position: unknown; lureTarget: unknown; damage(n: number, from?: unknown): void }> } }).enemies ?? null,
    };
    // UPGRADE LOOP (companion-system): test-mode seam for the companion
    // e2e + perf harnesses — the defs table, salts, pure rolls/pick,
    // and the live blueprint manager + panel.
    (window.__XANDRIA__ as Record<string, unknown>).companionTest = {
      COMPANION_SALT,
      COMPANION_WOUND_BONUS,
      COMPANION_DEFS,
      CompanionsManager,
      Companion,
      companionDefOf,
      rollCompanionDamage,
      rollCompanionHeal,
      rollFollowOffset,
      pickCompanionTarget,
      // UPGRADE LOOP (companion-combat-depth): weight table, stance
      // math, guard reduction and revive cost for the e2e harness.
      COMPANION_TARGET_WEIGHTS,
      COMPANION_STANCES,
      COMPANION_REVIVE_COST,
      GUARD_DAMAGE_FRACTION,
      pickEnemyTarget,
      applyGuardReduction,
      enemyAggroRange,
      /** Test seam: the live companions manager from the blueprint build. */
      liveManager: (): CompanionsManager | null =>
        (blueprint as { companions?: CompanionsManager }).companions ?? null,
      /** Test seam: the live companion panel from the blueprint build. */
      livePanel: (): { isOpen: boolean; show(): void; hide(): void; toggle(): void; refresh(): void } | null =>
        (blueprint as { companionPanel?: { isOpen: boolean; show(): void; hide(): void; toggle(): void; refresh(): void } }).companionPanel ?? null,    };
    // UPGRADE LOOP (player-camp): test-mode seam for the camp e2e + perf
    // harnesses — the defs table, salt, pure site computation, and the
    // live blueprint manager + session.
    (window.__XANDRIA__ as Record<string, unknown>).campTest = {
      CAMP_SALT,
      CAMP_STRUCTURE_DEFS,
      CAMP_STRUCTURE_TIERS,
      CampManager,
      CampProp,
      campAnchorCoords,
      campSitePosition,
      campStructureDefOf,
      campStructureMaxTier,
      campStructureTierOf,
      campTierVisualParts,
      WORKBENCH_DAMAGE_MULT,
      WORKBENCH_BUFF_DURATION_S,
      /** Test seam: the live camp manager from the blueprint build. */
      liveManager: (): CampManager | null =>
        (blueprint as { camp?: CampManager }).camp ?? null,
      /** Test seam: the live camp session from the blueprint build. */
      liveSession: (): { isPanelOpen: boolean; open: () => boolean; promptedCamp: boolean } | null =>
        (blueprint as { campSession?: { isPanelOpen: boolean; open: () => boolean; promptedCamp: boolean } }).campSession ?? null,    };
    // UPGRADE LOOP (mounts): test-mode seam for the mounts e2e + perf
    // harnesses — the defs table, pure state class, visual builder, and
    // the live blueprint manager + panel.
    (window.__XANDRIA__ as Record<string, unknown>).mountsTest = {
      MOUNT_DEFS,
      MountState,
      MountManager,
      mountDefOf,
      buildMountVisual,
      /** Test seam: the live mounts manager from the blueprint build. */
      liveManager: (): MountManager | null =>
        (blueprint as { mounts?: MountManager }).mounts ?? null,
      /** Test seam: the live mounts panel from the blueprint build. */
      livePanel: (): { isOpen: boolean; show: () => void; hide: () => void } | null =>
        (blueprint as { mountsPanel?: { isOpen: boolean; show: () => void; hide: () => void } }).mountsPanel ?? null,
      /** Test seam: shared-instancer diagnostics for the perf leg. */
      instancerStats: (): { buckets: number; instances: number } => {
        const s = NpcInstancer.for(engine).stats();
        return { buckets: s.buckets, instances: s.instances };
      },
    };
    // Vendor-economy wave: test-mode seam for the economy e2e harness —
    // salts, catalog, pure builders, the Wallet class, and the live
    // blueprint handles (wallet, NPC manager, shop panel).
    (window.__XANDRIA__ as Record<string, unknown>).economyTest = {
      VENDOR_SALT,
      CURRENCY_SALT,
      CURRENCY_NAME,
      DEFAULT_BUY_MULT,
      DEFAULT_SELL_MULT,
      VENDOR_CATALOG,
      Wallet,
      resolveVendorDefs,
      buildVendorNpcSpecs,
      buildVendorStock,
      unitSellPrice,
      isSellable,
      hashStr32,
      buildCurrencyRng,
      rollCurrencyDrops,
      /** Test seam: the live player wallet from the blueprint build. */
      liveWallet: (): Wallet | null =>
        (blueprint as { wallet?: Wallet }).wallet ?? null,
      /** Test seam: the live vendor manager (owns the merchant roster). */
      liveNpcManager: (): { npcs: readonly { vendorId?: string; spawnSeed: number; name: string; interactable: { id: string } }[] } | null =>
        (blueprint as { vendors?: { npcs: readonly { vendorId?: string; spawnSeed: number; name: string; interactable: { id: string } }[] } }).vendors ?? null,
      /** Test seam: the live shop panel. */
      liveShopPanel: (): {
        isOpen: boolean;
        openForVendor: (v: { vendorId: string; spawnSeed: number; keeperName: string }) => boolean;
        stockFor: (vendorId: string, spawnSeed: number) => { itemId: string; price: number; stock: number }[];
        buy: (line: { itemId: string; price: number; stock: number }) => void;
        sell: (itemId: string, unitPrice: number) => void;
        hide: () => void;
      } | null =>
        (blueprint as { shopPanel?: {
          isOpen: boolean;
          openForVendor: (v: { vendorId: string; spawnSeed: number; keeperName: string }) => boolean;
          stockFor: (vendorId: string, spawnSeed: number) => { itemId: string; price: number; stock: number }[];
          buy: (line: { itemId: string; price: number; stock: number }) => void;
          sell: (itemId: string, unitPrice: number) => void;
          hide: () => void;
        } }).shopPanel ?? null,
    };
    // Gear sets wave: test-mode seam for the set-bonus e2e + unit
    // harnesses — the tuning table, def builders, the pure compute
    // function, the additive drop tables, and the UI report builder.
    (window.__XANDRIA__ as Record<string, unknown>).setTest = {
      GEAR_SETS,
      SET_PIECE_IDS,
      SET_DROP_ADDONS,
      SET_CATALOG_RECIPES,
      setGearDefs,
      computeSetBonuses,
      buildSetUiReport,
      ensureSetItemDefs,
    };
    // Loadout-presets wave: test-mode seam for the loadout e2e + unit
    // harnesses — the pure loadout functions plus live handles: the
    // active slot's rack, and save/apply through the real profile +
    // equip paths (apply is combat-guarded via Engine.inCombat).
    (window.__XANDRIA__ as Record<string, unknown>).loadoutTest = {
      MAX_LOADOUTS,
      validateGearLoadouts,
      defaultGearLoadouts,
      captureLoadout,
      applyGearLoadout,
      loadoutPieceCount,
      liveLoadouts: (): unknown => getGearLoadouts(loadProfile()),
      liveInventory: (): unknown =>
        (blueprint as { itemKit?: { inventory?: unknown } | null }).itemKit?.inventory ?? null,
      liveDefs: (): Record<string, unknown> =>
        (spec.custom?.items?.defs ?? {}) as Record<string, unknown>,
      saveLive: (index: number, name?: string): boolean => {
        const inv = (blueprint as { itemKit?: { inventory?: { getAllEquipped: () => Record<string, string> } } | null }).itemKit?.inventory;
        if (!inv) return false;
        const rack = getGearLoadouts(loadProfile());
        const snap = captureLoadout(name ?? rack[index]?.name ?? `Loadout ${index + 1}`, inv.getAllEquipped(), spec.custom?.items?.defs ?? {});
        const p = loadProfile();
        const ok = setGearLoadout(p, index, snap);
        if (ok) saveProfile(p);
        return ok;
      },
      applyLive: (index: number): unknown => {
        const inv = (blueprint as { itemKit?: { inventory?: unknown } | null }).itemKit?.inventory;
        const loadout = getGearLoadouts(loadProfile())[index];
        if (!inv || !loadout) return { ok: false, reason: 'no-inventory' };
        return applyGearLoadout(
          inv as Parameters<typeof applyGearLoadout>[0],
          loadout,
          spec.custom?.items?.defs ?? {},
          () => engine.inCombat(),
        );
      },
      renameLive: (index: number, name: string): boolean => {
        const p = loadProfile();
        const ok = renameGearLoadout(p, index, name);
        if (ok) saveProfile(p);
        return ok;
      },
      clearLive: (index: number): boolean => {
        const p = loadProfile();
        const ok = clearGearLoadout(p, index);
        if (ok) saveProfile(p);
        return ok;
      },
      inCombat: (): boolean => engine.inCombat(),
    };
    // Tutorial wave: test-mode seam for the tutorial e2e harness — the
    // live TutorialManager (observe-only) plus the defs table so the spec
    // can assert step order, prompts, and skip rules without touching
    // gameplay.
    (window.__XANDRIA__ as Record<string, unknown>).tutorialTest = {
      /** Test seam: the live tutorial manager from the engine build. */
      live: () => engine.tutorial ?? null,
    };
    // Enchantments wave: test-mode seam for the enchant e2e + unit
    // harnesses — the tuning table, material defs, the pure compute
    // function, the additive drop tables, and the spec merge.
    (window.__XANDRIA__ as Record<string, unknown>).enchantTest = {
      ENCHANT_DEFS,
      ENCHANT_MATERIAL_IDS,
      ENCHANT_DROP_ADDONS,
      enchantDef,
      enchantMaterialDefs,
      computeEnchantStats,
      ensureEnchantItemDefs,
    };
    // Elemental-damage-types wave: test-mode seam for the elemental e2e
    // + unit harnesses — the damage-type table, the resistance table,
    // the pure helpers, and the live inventory's outgoing-type resolver.
    (window.__XANDRIA__ as Record<string, unknown>).elementalTest = {
      DAMAGE_TYPES,
      ELEMENTAL_TABLE,
      ENEMY_RESISTANCES,
      elementalDef,
      isDamageType,
      normalizeDamageType,
      resistanceFor,
      elementalMultiplierFor,
      applyElemental,
      resistanceLines,
      outgoingDamageType,
      outgoingDamageTypeDetail,
      /** Test seam: the live player inventory's outgoing damage type. */
      liveOutgoingDamageType: (): string =>
        (blueprint as { itemKit?: { inventory?: { outgoingDamageType: () => string } } | null }).itemKit?.inventory?.outgoingDamageType() ?? 'physical',
    };
    // Gear-salvage wave: test-mode seam for the salvage e2e + unit
    // harnesses — the tuning table, the seeded roll, the loadout
    // snapshot helper, and the live inventory via lootTest.
    (window.__XANDRIA__ as Record<string, unknown>).salvageTest = {
      SALVAGE_SALT,
      SALVAGE_TABLE,
      SET_PIECE_SALVAGE_BONUS,
      salvageRowFor,
      isSetPiece,
      salvageSeedFor,
      buildSalvageRng,
      rollSalvageYields,
      clearSalvagedFromLoadouts,    };
    // Quest wave: test-mode seam for the quest e2e harness — the pool
    // builder, salts, manager class and the live blueprint handles.
    // Side-quests wave: SIDE_QUEST_SALT + buildSideQuestPool ride the same
    // seam for the side-quest e2e harness.
    // PROGRESSION-CURVE: test-mode seam for the progression e2e harness —
    // the live Progression instance, the frozen curve table, and the grant
    // helpers so kill→XP→level-up→stat growth is asserted exactly.
    (window.__XANDRIA__ as Record<string, unknown>).progressionTest = {
      PROGRESSION_TABLE,
      LEVEL_CAP,
      levelRow,
      grantKillXp,
      grantPickupXp,
      grantCraftXp,
      /** Test seam: the live Progression from the blueprint build. */
      liveProgression: (): Progression | null =>
        (blueprint as { prog?: Progression }).prog ?? null,
      /** Test seam: the live player avatar (maxHealth assertions). */
      liveAvatar: (): PlayerAvatar | null =>
        (blueprint as { avatar?: PlayerAvatar }).avatar ?? null,
    };
    (window.__XANDRIA__ as Record<string, unknown>).questTest = {
      QuestManager,
      QuestTalkSession,
      QUEST_SALT,
      SIDE_QUEST_SALT,
      buildQuestPool,
      buildSideQuestPool,
      resolveQuestsEnabled,
      validateQuestDef,
      // Curated-quest-rewards wave: the tables, the slug list, the bonus
      // seed fn and its salt, so e2e can replicate the bonus line
      // independently of the defs and assert curated content.
      CURATED_STORY_REWARDS,
      CURATED_SIDE_REWARDS,
      QUEST_REWARD_SLUGS,
      QUEST_REWARD_BONUS_SALT,
      questBonusItem,
      curatedQuestReward,
      allCuratedItemIds,
      /** Test seam: the live quest manager from the blueprint build (null when disabled). */
      liveManager: (): QuestManager | null =>
        (blueprint as { quests?: QuestManager | null }).quests ?? null,
      // Radiant-quests wave: the salt, the template table, the pure
      // offer generators (batch + single-slot replication), the tier
      // function, and the live board/panel handles for the radiant e2e.
      RADIANT_SALT,
      RADIANT_TEMPLATES,
      buildRadiantOffers,
      radiantOfferAt,
      radiantTierForLevel,
      resolveRadiantCount,
      eligibleRadiantTemplates,
      RadiantBoard,
      /** Test seam: the live radiant board from the blueprint build (null when disabled). */
      liveRadiantBoard: (): RadiantBoard | null =>
        (blueprint as { radiantBoard?: RadiantBoard | null }).radiantBoard ?? null,
      /** Test seam: open the radiant board panel (the real UI path, not a manager call). */
      openRadiantBoard: (): void =>
        (blueprint as { radiantBoardPanel?: { show: () => void } | null }).radiantBoardPanel?.show(),
      // Timed-quests wave: the salt, the template table, the pure
      // offer generators (batch + single-slot replication), the count
      // resolver, and the live board/panel handles for the timed e2e.
      TIMED_QUEST_SALT,
      TIMED_TEMPLATES,
      buildTimedOffers,
      timedOfferAt,
      resolveTimedCount,
      eligibleTimedTemplates,
      TimedBoard,
      /** Test seam: the live timed board from the blueprint build (null when disabled). */
      liveTimedBoard: (): TimedBoard | null =>
        (blueprint as { timedBoard?: TimedBoard | null }).timedBoard ?? null,
      /** Test seam: open the timed board panel (the real UI path, not a manager call). */
      openTimedBoard: (): void =>
        (blueprint as { timedBoardPanel?: { show: () => void } | null }).timedBoardPanel?.show(),
      /** Test seam: the live talk session from the blueprint build (null when absent). */
      liveTalkSession: (): QuestTalkSession | null =>
        (blueprint as { talkSession?: QuestTalkSession | null }).talkSession ?? null,
    };
    // Quest-waypoints wave: test-mode seam for the waypoint e2e — the
    // pure resolver, the tracked-objective selector, and the live
    // engine-owned waypoint presenter (beacon/minimap/compass).
    (window.__XANDRIA__ as Record<string, unknown>).waypointTest = {
      resolveQuestWaypoint,
      trackedObjective,
      WAYPOINT_SCAN_INTERVAL_S,
      /** Test seam: the live QuestWaypoints from the engine build. */
      live: () => engine.waypoints,
    };
    // Boss-fights wave: test-mode seam for the boss e2e + unit harnesses —
    // the salt, the data-driven defs, the pure placement/phase/pick
    // functions, and the live blueprint handles (encounter + bar).
    (window.__XANDRIA__ as Record<string, unknown>).bossTest = {
      BOSS_SALT,
      BOSS_DEFS,
      BOSS_ATTACKS,
      DEFAULT_BOSS_ID,
      planBossArena,
      phaseIndexFor,
      pickNextAttack,
      rollCooldown,
      attackHitsPlayer,
      bossEnabled,
      resolveBossDef,
      resolveArenaRadius,
      BossEncounter,
      /** Test seam: the live boss encounter from the blueprint build (null when absent). */
      liveEncounter: (): BossEncounter | null =>
        (blueprint as { bosses?: BossEncounter }).bosses ?? null,
      /** Test seam: the live boss bar from the blueprint build (null when absent). */
      liveBar: (): BossBar | null =>
        (blueprint as { bossBar?: BossBar }).bossBar ?? null,
    };
    // Wandering world-boss wave: test-mode seam for the world-boss e2e +
    // unit harnesses — the salt, the pure plan/resolvers, and the live
    // blueprint handles (event + its owned open-field encounter).
    (window.__XANDRIA__ as Record<string, unknown>).worldBossTest = {
      WORLDBOSS_SALT,
      WORLDBOSS_BASE_HEALTH,
      planWorldBoss,
      resolveWorldBossEnabled,
      resolveWorldBossDef,
      WorldBossEvent,
      /** Test seam: the live WorldBossEvent from the blueprint build (null when absent). */
      liveWorldBoss: (): WorldBossEvent | null =>
        (blueprint as { worldBoss?: WorldBossEvent }).worldBoss ?? null,
      /** Test seam: the live open-field BossEncounter owned by the event. */
      liveEncounter: (): BossEncounter | null =>
        (blueprint as { worldBoss?: WorldBossEvent }).worldBoss?.liveEncounter ?? null,
    };
    // UPGRADE LOOP (audio-system): test-mode seam for the audio e2e —
    // the pure per-biome pattern fn (so e2e can replicate the loop
    // independently) and the live engine's biome setter for determinism
    // assertions. Production audio never touches this seam.
    (window.__XANDRIA__ as Record<string, unknown>).audioTest = {
      biomeMusicPattern,
      AUDIO_SALT,
      setBiome: (biomeId: string, mapSeed: number) =>
        engine.audio.setBiome(biomeMusicPattern(biomeId, mapSeed)),
      currentBiomePattern: () => engine.audio.currentBiomePattern(),
    };
    // Skills wave: test-mode seam for the skills e2e harness — the system,
    // defs, resolvers, and the live blueprint handles.
    (window.__XANDRIA__ as Record<string, unknown>).skillsTest = {
      SkillSystem,
      SKILL_DEFS,
      SKILL_IDS,
      SYNERGY_DEFS,
      evaluateSynergies,
      SkillsPanel,
      resolveSkillsEnabled,
      resolveSkillsXpMultiplier,
      /** Test seam: the live SkillSystem from the blueprint build (null when absent). */
      liveSkills: (): SkillSystem | null =>
        (blueprint as { skills?: SkillSystem }).skills ?? null,
      /** Test seam: the live skills panel (null when skills disabled or UI absent). */
      livePanel: (): SkillsPanel | null =>
        (blueprint as { skillsPanel?: SkillsPanel | null }).skillsPanel ?? null,
    };
    // WORLD-TIERS (upgrade loop): test-mode seam for the tier e2e — the
    // pure derivation, the shipped constants, and a production-path
    // arrival driver. arriveViaTransition runs the REAL PortalTransition
    // (begin -> finish) the portal flow uses, minus the overlay/player
    // placement half of beginTransition, which is tier-irrelevant.
    (window.__XANDRIA__ as Record<string, unknown>).worldTierTest = {
      deriveWorldTier,
      MAX_WORLD_TIER,
      TIER_SALT,
      clampTier,
      deriveMapSeed,
      tierForCoord: (worldSeed: number, mx: number, my: number): number =>
        deriveWorldTier(deriveMapSeed(worldSeed, mx, my), Math.abs(mx) + Math.abs(my)),
      /** Test seam: run the full PortalTransition.begin/finish for a coordinate. */
      arriveViaTransition: (mx: number, my: number): { tier: number; mapSeed: number } => {
        const pm = engine.portalManager;
        if (!pm) throw new Error('[worldTierTest] portals not enabled for this spec');
        const worldSeed = pm.getWorldSeed();
        const mapSeed = deriveMapSeed(worldSeed, mx, my);
        const transition = new PortalTransition(engine);
        const parts = {
          avatar: engine.portalsPlayerAvatar,
          inventory: null, progression: null, quests: null, skills: null,
          getBuff: () => null, setBuff: () => {},
        };
        const snap = transition.begin(parts as never);
        const coord: MapCoord = { mx, my };
        transition.finish(parts as never, snap, coord, mapSeed, new THREE.Vector3(0, 0, 0),
          (c, ms) => engine.buildTerrainForPortal(c, ms, new THREE.Vector3(0, 0, 0)));
        return { tier: engine.worldTier, mapSeed };
      },
    };
    // Dynamic-events wave: test-mode seam for the events e2e harness —
    // the defs table, scheduler, stock builder, and the live blueprint
    // handles (manager, session, trade panel).
    (window.__XANDRIA__ as Record<string, unknown>).eventsTest = {
      EVENT_DEFS,
      EVENT_SALT,
      planDynamicEvents,
      buildMerchantStock,
      resolveEventsEnabled,
      rollEventCurrency,
      DynamicEventManager,
      EventInteractionSession,
      /** Test seam: the live DynamicEventManager from the blueprint build (null when absent). */
      liveManager: (): DynamicEventManager | null =>
        (blueprint as { events?: DynamicEventManager }).events ?? null,
      /** Test seam: the live event interaction session (null when UI absent). */
      liveSession: (): EventInteractionSession | null =>
        (blueprint as { eventSession?: EventInteractionSession }).eventSession ?? null,
      /** Test seam: the live trade panel. */
      liveTradePanel: (): TradePanel | null =>
        (blueprint as { tradePanel?: TradePanel }).tradePanel ?? null,
    };
    // UPGRADE LOOP (factions-reputation): test-mode seam for the
    // factions e2e harness — the catalog, tier table, deltas, pure
    // price helpers, mappings, the store class, and the live handles.
    (window.__XANDRIA__ as Record<string, unknown>).factionsTest = {
      FACTION_CATALOG,
      FACTION_IDS,
      STANDING_TIERS,
      STANDING_MIN,
      STANDING_MAX,
      ENEMY_KIND_FACTION,
      VENDOR_FACTION,
      KILL_STANDING_DELTA,
      BOSS_KILL_STANDING_DELTA,
      TRADE_BUY_STANDING_DELTA,
      TRADE_SELL_STANDING_DELTA,
      QUEST_DEFAULT_STANDING_DELTA,
      QUEST_DEFAULT_FACTION,
      tierForStanding,
      clampStanding,
      standingBuyFactor,
      standingSellFactor,
      effectiveBuyPrice,
      effectiveSellPrice,
      factionOfEnemyKind,
      factionOfVendor,
      FactionStandings,
      localStorageFactionsAdapter,
      /** Test seam: the live standings store from the blueprint build. */
      liveStandings: (): FactionStandings | null =>
        (blueprint as { standings?: FactionStandings }).standings ?? null,
      /** Test seam: the live standings panel (null when absent). */
      livePanel: (): { render: (rows: unknown[]) => void } | null =>
        (blueprint as { standingsPanel?: { render: (rows: unknown[]) => void } }).standingsPanel ?? null,
    };
    // UPGRADE LOOP (dialogue-branching): test-mode seam for the dialogue
    // e2e harness — the tuning table, engine/state classes, validators,
    // the storage adapter, and the live blueprint handles. Production
    // dialogue never touches this seam.
    (window.__XANDRIA__ as Record<string, unknown>).dialogueTest = {
      DIALOGUE_TREES,
      DialogueEngine,
      DialogueState,
      FIRST_QUEST_REF,
      localStorageDialogueAdapter,
      validateDialogueTree,
      validateDialogueTrees,
      /** Test seam: the live dialogue engine from the blueprint build. */
      liveEngine: (): DialogueEngine | null =>
        (blueprint as { dialogueEngine?: DialogueEngine }).dialogueEngine ?? null,
      /** Test seam: the live dialogue state from the blueprint build. */
      liveState: (): DialogueState | null =>
        (blueprint as { dialogueState?: DialogueState }).dialogueState ?? null,
      /** Test seam: the live dialogue state on the engine (null when absent). */
      liveEngineState: (): DialogueState | null => engine.dialogueState ?? null,
    };
    // UPGRADE LOOP (weather-cycles): test-mode seam for the weather e2e
    // harness — the salt, the tuning table, the pure scheduler, the
    // resolvers, and the live blueprint handle.
    (window.__XANDRIA__ as Record<string, unknown>).weatherTest = {
      WEATHER_SALT,
      WEATHER_TUNING,
      planWeatherCycle,
      segmentAt,
      resolveWeatherCyclesEnabled,
      resolveForcedWeather,
      WeatherCycleManager,
      /** Test seam: the live WeatherCycleManager from the blueprint build (null when absent). */
      liveWeather: (): WeatherCycleManager | null =>
        (blueprint as { weather?: WeatherCycleManager | null }).weather ?? null,
    };
    // UPGRADE LOOP (hazard-zones): test-mode seam for the hazard e2e
    // harness — the salt, the defs table, the pure scheduler, the
    // resolvers, and the live blueprint handle.
    (window.__XANDRIA__ as Record<string, unknown>).hazardTest = {
      HAZARD_SALT,
      HAZARD_DEFS,
      planHazardZones,
      resolveHazardsEnabled,
      resolveHazardCount,
      HazardZoneManager,
      /** Test seam: the live HazardZoneManager from the blueprint build (null when absent). */
      liveHazards: (): HazardZoneManager | null =>
        (blueprint as { hazards?: HazardZoneManager | null }).hazards ?? null,
    };
    // COMBAT-ABILITIES (upgrade loop): test-mode seam for the abilities
    // e2e harness — the tuning table, the manager, and the live handles.
    (window.__XANDRIA__ as Record<string, unknown>).abilitiesTest = {
      ABILITY_DEFS,
      ABILITY_IDS,
      ABILITY_SALT,
      MAX_ENERGY,
      ENERGY_REGEN_PER_S,
      AbilityManager,
      AbilityBar,
      resolveAbilitiesEnabled,
      /** Test seam: the live AbilityManager from the blueprint build (null when absent). */
      liveManager: (): AbilityManager | null =>
        (blueprint as { abilities?: AbilityManager }).abilities ?? null,
      /** Test seam: the live ability bar (null when abilities disabled). */
      liveBar: (): AbilityBar | null =>
        (blueprint as { abilityBar?: AbilityBar | null }).abilityBar ?? null,
      /** Test seam: the live player avatar. */
      liveAvatar: (): PlayerAvatar | null =>
        (blueprint as { avatar?: PlayerAvatar }).avatar ?? null,
      /** Test seam: the live enemy manager. */
      liveEnemies: (): EnemyManager | null =>
        (blueprint as { enemies?: EnemyManager }).enemies ?? null,
    };
  }
  document.body.dataset.genre = spec.meta.genre;
  document.body.dataset.state = engine.state;
  engine.onUpdatePersistent(() => { document.body.dataset.state = engine.state; });
  // title card — the blueprint already set the HUD objective line to the
  // staged first-stage description via makeCampaignObjectives (R2-M2: never
  // overwrite it here with the legacy objective text).
  engine.hud.toast(spec.meta.name.toUpperCase(), 3);
  engine.onUpdatePersistent(() => engine.particles.updateWeather(engine.camera.position, 1 / 60));
  // register the blueprint builder: enables in-place restart()
  engine.setRunBuilder((e) => build(e, spec));
  engine.start();
}

boot();
