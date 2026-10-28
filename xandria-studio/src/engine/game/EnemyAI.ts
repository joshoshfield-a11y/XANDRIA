/**
 * Enemy AI — kind-based behaviors:
 *  walker: capsule, patrol → chase → melee lunge
 *  brute:  bigger, slower, heavier walker
 *  drone/flyer: hover, strafe, shoot projectiles
 *  turret: static, tracks and fires bursts
 * All take damage, flash, die with particles, and may drop pickups.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../Engine';
import { GROUP, toV3 } from '../core/Physics';
import { makeHumanoid, makeDrone, makeTurret, disposeOwned, disposeOwnedMaterials, type CharacterRig } from '../gfx/Characters';
import { NpcInstancer } from './npcInstancing';
import { NpcRigCache, type NpcAdopted } from './npcRigSharing';
import { resolveSkinDef, applySkin, skinOptionsForSpec } from '../gfx/Skins';
// ENEMIES WAVE B: hostile visual read — ember visor slits + spiked dark
// armor over the kind tints below. Silhouette families (walker/brute =
// makeHumanoid, drone/flyer = makeDrone, turret = makeTurret), behavior,
// stats, aggro, and boss mechanics are untouched.
import { applyEnemyArmor } from '../gfx/VoxelArmor';
import { loadRigFromURL, type BoneMapping } from '../gfx/RigAdapter';
import type { EnemySpec, EnemyKind } from '@spec';
import type { Projectiles } from './Projectiles';
import type { MapLocalEntitySystem } from '../world/MapEntities';
import { Rng, hashString } from '../core/Rng';
import { buildLootRng, rollLoot, type LootDrop } from './loot';
/**
 * STATUS-EFFECTS (upgrade loop): data-driven DoT/slow/stun statuses.
 * The tracker is per-enemy run state (map-local — it dies with the
 * enemy on despawn). Application funnels through applyStatus() (the
 * single funnel the elemental wave's hook will tap); ticks are driven
 * by game time in update(). No damage() signature change, no behavior
 * contract change beyond the additive status math.
 */
import {
  StatusTracker,
  statusDefOf,
  type ApplyOutcome,
  type StatusId,
} from './statusEffects';
import { buildCurrencyRng, rollCurrencyDrops } from './economy';
import { LOOT_SALT } from './loot';
/**
 * UPGRADE LOOP (enemy-scaling): world difficulty scaling — enemies spawn
 * with stat bands derived from max(player Progression level, map depth),
 * all tuning in enemyScaling.ts. Additive: the authored spec is never
 * mutated; spawnOne derives a scaled copy per enemy.
 */
import {
  applyEnemyScaling,
  mapDistanceFromSpec,
} from './enemyScaling';
/**
 * UPGRADE LOOP (difficulty-modes): player-selectable difficulty modes
 * (story / normal / hard). Additive on top of enemyScaling's level bands —
 * spawnOne applies the band first, then the difficulty multiplier from
 * difficulty.ts's DIFFICULTY_TABLE.
 */
import {
  applyDifficultyScaling,
  difficultyById,
  type DifficultyId,
} from './difficulty';
/**
 * UPGRADE LOOP (new-game-plus): prestige run cycles (NG+1, NG+2, ...).
 * Additive on top of difficulty — spawnOne applies the band, then the
 * difficulty multiplier, then the NG+ multiplier from newGamePlus.ts's
 * NG_PLUS_TABLE. Cycle 0 is the identity row (byte-identical spawns).
 */
import {
  applyNgPlusScaling,
  ngPlusByCycle,
} from './newGamePlus';
/**
 * UPGRADE LOOP (daily-mutators): daily challenge mutators — the last
 * additive layer on spawnOne (band -> difficulty -> NG+ -> affixes ->
 * mutators), all tuning in dailyMutators.ts's MUTATOR_TABLE.
 */
import {
  combineMutatorEffects,
} from './dailyMutators';
/**
 * UPGRADE LOOP (elite-affixes): seeded elite enemy affixes — the affix
 * table, the seeded roll and the additive stat application all live in
 * eliteAffixes.ts. EnemyAI only owns the runtime mechanics (shield pool,
 * damage-taken multiplier, lifesteal-on-attack, volatile detonation) and
 * the gold marker tint through the existing applyGlow path.
 */
import {
  ELITE_MARKER_COLOR,
  VOLATILE_RADIUS,
  VOLATILE_DAMAGE_FRAC,
  eliteLabel,
  rollEliteAffixes,
  applyEliteAffixes,
  type EliteAffixId,
} from './eliteAffixes';
/**
 * ELEMENTAL-DAMAGE-TYPES: the elemental step (stat-math order step 5)
 * lives in damage() — the single funnel every damage-to-enemy path
 * already uses. See elemental.ts for the disclosed order.
 */
import {
  applyElemental,
  normalizeDamageType,
  resistanceFor,
  type DamageType,
} from './elemental';
/**
 * UPGRADE LOOP (stealth-system): sneak detection — the ONE authorized
 * behavior-contract change (awareness gates chase/attack; see
 * stealth.ts for the full disclosed model). Additive: lure precedence,
 * ranges, speeds, cadences, and damage are untouched; when perception
 * is absent the enemy behaves exactly as before (standing player,
 * silent), except awareness now escalates through 'suspicious' for
 * 0.4s before alerting.
 */
import {
  AwarenessTracker,
  DEFAULT_PERCEPTION,
  detectionJitterFor,
  detectionRadiusFor,
  targetWeightFor,
  type AwarenessState,
  type StealthPerception,
} from './stealth';

/**
 * Salt for the enemy roster stream — keeps it off the NPC stream and the
 * engine.rng stream. Same mapSeed -> identical roster. ('ENEM')
 */
export const ENEMY_SALT = 0x454e454d;

export interface EnemyEvents {
  /**
   * UPGRADE LOOP (weather-cycles): the enemy's kind now rides along as an
   * optional third argument so blueprints can apply additive per-kind
   * modifiers (night damage). Existing handlers (dmg, from) are unaffected.
   */
  onPlayerHit?: (damage: number, from: THREE.Vector3, kind?: EnemyKind) => void;
  /**
   * UPGRADE LOOP (companion-combat-depth): melee hits against a
   * companion-targeted enemy route here instead of onPlayerHit (same
   * signature: damage, attacker position, kind). Ranged projectiles
   * still use the player-body collision channel (see companionCombat
   * header) and do NOT route here. Optional: when unset, a
   * companion-targeted melee hit deals no damage (the companion is
   * never silently charged to the player).
   */
  onCompanionHit?: (damage: number, from: THREE.Vector3, kind?: EnemyKind) => void;
  onDeath?: (e: Enemy) => void;

  /** boss phase transitions (1 at ≤66% HP, 2 at ≤33% HP) */
  onPhase?: (e: Enemy, phase: number) => void;
}

/**
 * ENEMIES WAVE B: kind tints are dark under-suits now — the hostile read
 * comes from the ember visor + spiked enemy armor applied below, not from
 * shirt colors (the old red/purple tints read villager-ish next to the
 * forged rig). Accent doubles as the forged headgear's glow accent.
 */
const ENEMY_COLORS: Record<string, { shirt: string; pants: string; accent: string }> = {
  walker: { shirt: '#2a1210', pants: '#1a1310', accent: '#ff2a00' },
  brute: { shirt: '#1c1c20', pants: '#141214', accent: '#ff1a00' },
};

export class Enemy {
  body: CANNON.Body | null = null;
  rig: CharacterRig | null = null;
  turret: { group: THREE.Group; head: THREE.Group; muzzle: THREE.Object3D } | null = null;
  health: number;
  maxHealth: number;
  alive = true;
  home: THREE.Vector3;
  private state: 'idle' | 'chase' | 'attack' = 'idle';
  /**
   * UPGRADE LOOP (difficulty-modes): true when this enemy is actively
   * hostile (chasing or attacking). EnemyManager.anyHostile() aggregates
   * this for the difficulty selector's no-changes-in-combat rule.
   */
  get hostile(): boolean {
    return this.state !== 'idle';
  }
  /**
   * UPGRADE LOOP (deployables): additive lure hook. When non-null, the
   * enemy targets this world point instead of the player — chase/attack
   * ranges, facing and ranged aim all read it. Melee attacks against the
   * lure never damage the player (the onPlayerHit call is gated on
   * !lureTarget: the enemy mauls the totem, not the player). Null
   * (default) = byte-identical pre-deployables behavior. Assigned and
   * cleared per-frame by DeployablesManager; never by EnemyManager.
   */
  lureTarget: THREE.Vector3 | null = null;
  /**
   * UPGRADE LOOP (companion-combat-depth): additive companion-target
   * hook, mirroring lureTarget. When non-null, the enemy targets this
   * world point (the live companion's root position) instead of the
   * player — chase/attack ranges, facing and ranged aim all read it.
   * Precedence: lureTarget wins over companionTargetPos (a deployed
   * lure still beats a companion, preserving deployables behavior
   * exactly); otherwise companionTargetPos wins over the player.
   * Melee hits against a companion target route to onCompanionHit,
   * never to onPlayerHit. Null (default) = byte-identical
   * pre-companion-combat behavior. Assigned and cleared per-frame by
   * CompanionsManager; never by EnemyManager.
   */
  companionTargetPos: THREE.Vector3 | null = null;
  /**
   * UPGRADE LOOP (companion-combat-depth): which target the last
   * update() actually used ('lure' | 'companion' | 'player').
   * Observability seam for the e2e (ranged aim proof) — drives nothing.
   */
  lastTarget: 'lure' | 'companion' | 'player' = 'player';
  /**
   * UPGRADE LOOP (stealth-system): current awareness — 'unaware' |
   * 'suspicious' | 'alerted'. Public read-only seam (melee sneak-bonus
   * checks it; e2e asserts it). Mutated only via the tracker in
   * update()/damage()/hearNoise(). A lure target forces 'alerted'.
   */
  awareness: AwarenessState = 'unaware';
  private awarenessTracker = new AwarenessTracker();
  /**
   * UPGRADE LOOP (stealth-system): per-enemy detection jitter, one
   * seeded draw at spawn, fixed for life (see stealth.ts). Public so
   * e2e can compute the exact effective radius for this enemy.
   */
  readonly detectionJitter: number;
  private attackCd = 0;
  private wanderTarget: THREE.Vector3 | null = null;
  private hoverPhase: number;
  private rng: Rng;
  private speedMult = 1;
  private aggroMult = 1;
  private tmpV = new THREE.Vector3();
  /**
   * Boss flag — set when this enemy is a brute in a boss objective
   * (objective.type === 'boss', or any quest stage with type 'boss').
   * Blueprints may also set it explicitly. Drives phase transitions.
   */
  isBoss: boolean;
  /** boss phase: 0 = full, 1 = enraged (≤66%), 2 = desperate (≤33%) */
  private phase = 0;
  /** custom kind def when spec.kind was registered via engine.hooks.registerEnemyKind */
  private customDef: import('./Modding').CustomEnemyKindDef | null = null;
  /** effective build kind: the registered base for custom kinds, else spec.kind */
  private readonly kind: EnemyKind;
  /**
   * ELEMENTAL-DAMAGE-TYPES: the build kind damage() bills against
   * (the registered base for custom kinds). Callers use it to compute
   * the displayed (floating-text) value caller-side, so the number
   * never depends on caller-side wrappers such as the shielded-variant
   * front-arc reduction, which stays HP-only as on main.
   */
  get damageKind(): EnemyKind {
    return this.kind;
  }
  /** group scale applied to the procedural rig (re-applied after an import-model swap) */
  private rigScale = 1;
  /**
   * ENEMIES WAVE C: geometry sharing. Adopted content-hash geometry
   * signatures from the per-engine rig cache (geometries ONLY — materials
   * stay per-instance so rig.flash() on the direct-render path can never
   * cross-flash another enemy). Released in dispose()/swapToModel.
   */
  private adopted: NpcAdopted | null = null;
  /**
   * ENEMIES WAVE C: set by EnemyManager.spawnOne to the manager's
   * per-engine instancer. damage() routes the hit-flash pulse through it
   * (per-instance tint, never a shared-material mutation); null on the
   * direct-render path (standalone enemies, blueprint initial builds).
   */
  instancer: NpcInstancer | null = null;
  /**
   * UPGRADE LOOP (enemy-scaling): XP multiplier for this enemy's kill
   * (the band's xpMult; 1 when scaling is inactive). Set by
   * EnemyManager.spawnOne; blueprints pass it to grantKillXp.
   */
  xpMult = 1;
  /**
   * UPGRADE LOOP (enemy-scaling): level-band index this enemy spawned in
   * (0 = identity band). Informational — drives nothing by itself.
   */
  scalingBand = 0;
  /**
   * UPGRADE LOOP (elite-affixes): affix ids this enemy spawned with
   * ('' = ordinary enemy; the default, byte-identical to pre-affix
   * spawns). Set by EnemyManager.spawnOne only — never by blueprints.
   */
  eliteAffixes: EliteAffixId[] = [];
  /** True when this enemy carries at least one affix. */
  get isElite(): boolean {
    return this.eliteAffixes.length > 0;
  }
  /** Display label ("⚡ Swift · 🩸 Vampiric"), '' for ordinary enemies. */
  get eliteNameplate(): string {
    return eliteLabel(this.eliteAffixes);
  }
  /**
   * UPGRADE LOOP (elite-affixes): damage-taken multiplier from affixes
   * (armored = 0.6, else 1). Applied in damage(), after shield absorb.
   */
  damageTakenMult = 1;
  /**
   * UPGRADE LOOP (elite-affixes): shield pool (shielded affix = 50% of
   * maxHealth). Absorbs damage before health in damage(); maxShield is
   * the spawn-time pool (informational — the pool never refills).
   */
  shield = 0;
  maxShield = 0;
  /**
   * UPGRADE LOOP (elite-affixes): lifesteal fraction (vampiric = 0.2).
   * Healed on every successful attack execution in update().
   */
  lifestealFrac = 0;
  /** UPGRADE LOOP (elite-affixes): volatile affix flag (detonates in die()). */
  volatile = false;
  /** UPGRADE LOOP (elite-affixes): attacker position of the last hit taken. */
  private lastDamageFrom: THREE.Vector3 | null = null;
  /**
   * STATUS-EFFECTS: per-enemy status instances (one per status id,
   * refresh-not-stack). Ticked by game time in update(); dies with the
   * enemy on despawn (map-local run state, never persisted).
   */
  readonly statuses = new StatusTracker();

  /**
   * ENEMIES WAVE C: the instancible render root — rig group for
   * walker/brute/drone/flyer, the turret assembly for turrets.
   */
  get renderRoot(): THREE.Group | null {
    return this.rig?.group ?? this.turret?.group ?? null;
  }

  constructor(
    private engine: Engine,
    public spec: EnemySpec,
    spawn: THREE.Vector3,
    private projectiles: Projectiles | null,
    private events: EnemyEvents,
    seed: number,
  ) {
    const mods = engine.spec.custom?.enemyMods;
    this.speedMult = mods?.speed ?? 1;
    this.aggroMult = mods?.aggression ?? 1;
    // custom kind: body/rig/behavior are built from the registered base kind
    this.customDef = engine.hooks.enemyKinds.get(spec.kind as string) ?? null;
    const buildKind = this.customDef?.base ?? spec.kind;
    this.kind = buildKind;
    const tint = this.customDef?.tint;
    const sz = (mods?.size ?? 1) * (this.customDef?.scale ?? 1);
    this.health = this.maxHealth = spec.health;
    this.home = spawn.clone();
    this.detectionJitter = detectionJitterFor(seed);
    this.rng = new Rng(seed);
    this.hoverPhase = this.rng.range(0, Math.PI * 2);
    this.isBoss = buildKind === 'brute' && Enemy.isBossObjective(engine);

    if (buildKind === 'walker' || buildKind === 'brute') {
      const bulk = (buildKind === 'brute' ? 1.7 : 1) * sz;
      this.body = engine.physics.capsule(0.42 * bulk, 1.7 * bulk, [spawn.x, spawn.y + 1.4 * bulk, spawn.z], {
        mass: 70 * bulk,
        group: GROUP.ENEMY,
        mask: GROUP.WORLD | GROUP.PLAYER | GROUP.ENEMY | GROUP.PROJECTILE | GROUP.NPC,
      });
      // Enemies wave C: geometry look quantization (mirrors Npc.ts
      // workstream B). The armor-set pick stays per-enemy-seeded so the
      // roster keeps both sets, but the RIG seed derives ONLY from (kind,
      // armor set) — one canonical body geometry per look for the whole
      // roster — so NpcRigCache shares it and the instancer collapses
      // per-enemy draws into the NPC-like range. Per-enemy identity rides
      // on palette tints (per-instance) and behavior (this.rng, still the
      // per-enemy seed); the constructor rng draw order is untouched.
      const armorRng = new Rng((seed ^ 0xe9b1) >>> 0);
      const armorSet = buildKind === 'brute' ? 'brutehide'
        : armorRng.pick(['marauder', 'bloodreaver'] as const);
      const rigSeed = hashString(`enemy:${buildKind}:${armorSet}`);
      this.rig = makeHumanoid(engine.mats, { ...(tint ?? ENEMY_COLORS[buildKind]), skin: '#8f8a80', bulk }, rigSeed, engine.spec.custom?.forge);
      if (sz !== 1) this.rig.group.scale.setScalar(sz);
      this.rigScale = sz !== 1 ? sz : 1;
      // ENEMIES WAVE B: hostile visual read — ember visor slits, spiked dark
      // armor over the under-suit tints above. An explicit spec skin applied
      // below still wins (applySkin strips skin-origin armor for skins
      // without armor).
      applyEnemyArmor(this.rig, armorSet, { origin: 'skin' });
      // DE — character customization: explicit spec skin wins over kind colors;
      // an import-model URL swaps the rig async (procedural fallback always).
      const slot = engine.spec.custom?.characters?.enemies?.[spec.kind]
        ?? engine.spec.custom?.characters?.enemies?.[buildKind];
      const skinDef = resolveSkinDef(engine.spec, slot?.skin);
      if (skinDef) applySkin(this.rig, skinDef, skinOptionsForSpec(engine.spec));
      engine.scene.add(this.rig.group);
      if (slot?.model) void this.swapToModel(slot.model, slot.boneMap, slot.skin);
    } else if (buildKind === 'drone' || buildKind === 'flyer') {
      this.body = engine.physics.sphere(0.5 * sz, [spawn.x, spawn.y + 2.5, spawn.z], {
        mass: 8,
        group: GROUP.ENEMY,
        mask: GROUP.WORLD | GROUP.PLAYER | GROUP.PROJECTILE | GROUP.NPC,
        material: engine.physics.slipperyMat,
      });
      this.body.linearDamping = 0.85;
      // ENEMIES WAVE B: dark rust hull + ember-red eye (the drone/flyer
      // ember-glow treatment — silhouettes unchanged).
      // ENEMIES WAVE C: same look quantization as walkers — one canonical
      // drone/flyer geometry per kind (forgeDronePlan is seeded).
      this.rig = makeDrone(engine.mats, buildKind === 'flyer' ? '#4a2e1c' : '#402020', mods?.glow ?? '#ff2a00', hashString(`enemy:${buildKind}`));
      if (sz !== 1) this.rig.group.scale.setScalar(sz);
      engine.scene.add(this.rig.group);
    } else if (buildKind === 'turret') {
      this.body = engine.physics.cylinder(0.65, 0.8, 1.4, [spawn.x, spawn.y + 0.7, spawn.z], {
        group: GROUP.ENEMY,
        mask: GROUP.WORLD | GROUP.PLAYER | GROUP.PROJECTILE | GROUP.NPC,
      });
      this.turret = makeTurret(engine.mats, '#232326', '#ff2200'); // ENEMIES WAVE B: charcoal hull + ember eye
      if (sz !== 1) this.turret.group.scale.setScalar(sz);
      this.turret.group.position.set(spawn.x, spawn.y, spawn.z);
      engine.scene.add(this.turret.group);
    }
    const glowRoot = this.rig?.group ?? this.turret?.group;
    if (mods?.glow && glowRoot) this.applyGlow(mods.glow, glowRoot);
    // ENEMIES WAVE C: content-hash geometry sharing across the roster
    // (geometries only — see the `adopted` field doc). Must run after the
    // rig is fully built (armor applied above); the instancer buckets key
    // off shared geometry identity, which is what collapses per-enemy
    // draw calls into the instanced range.
    const shareRoot = this.rig?.group ?? this.turret?.group;
    if (shareRoot) this.adopted = NpcRigCache.for(engine).share(shareRoot, { geometriesOnly: true });
  }

  /**
   * Async import-model swap (workstream E phase 1) for walker/brute rigs.
   * The procedural rig stays live while the GLB loads and stays permanently
   * on any failure. The size scale (`custom.enemyMods.size`) is re-applied;
   * the skin (if any) is re-applied — a no-op on imported rigs.
   */
  private async swapToModel(url: string, boneMap: BoneMapping | undefined, skinId: string | undefined) {
    const rig = await loadRigFromURL(url, boneMap);
    if (!rig || !this.alive) return; // procedural fallback stands (or died mid-load)
    const skinDef = resolveSkinDef(this.engine.spec, skinId);
    if (skinDef) applySkin(rig, skinDef, skinOptionsForSpec(this.engine.spec));
    if (this.rigScale !== 1) rig.group.scale.setScalar(this.rigScale);
    const old = this.rig;
    // ENEMIES WAVE C: the old rig's geometries may be cache-shared — release
    // adopted signatures instead of CharacterRig.dispose() (disposeOwned
    // would kill canonicals other enemies still use). Re-register with the
    // instancer when this enemy was on the instanced path.
    const wasInstanced = this.instancer?.unregister(this) ?? false;
    this.engine.scene.remove(old!.group);
    this.releaseRigResources(old!.group);
    this.rig = rig;
    if (wasInstanced) this.instancer!.registerEnemy(this);
    this.engine.scene.add(rig.group);
  }

  /** True when the objective (or any quest stage) is a boss fight. */
  private static isBossObjective(engine: Engine): boolean {    const obj = engine.spec.objective;
    if (obj.type === 'boss') return true;
    return !!obj.stages?.some((s) => s.type === 'boss');
  }

  private applyGlow(color: string, root: THREE.Object3D) {
    // FIX: never mutate shared MaterialLibrary-cached materials — clone per-instance
    // first so the glow tints only this enemy.
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const cur = m.material as THREE.Material | THREE.Material[];
      const list = (Array.isArray(cur) ? cur : [cur]).map((mm) => {
        const mat = mm as THREE.MeshStandardMaterial;
        if (mat && 'emissive' in mat && !mat.userData.owned) {
          const c = mat.clone() as THREE.MeshStandardMaterial;
          c.userData.owned = true;
          return c;
        }
        return mat;
      });
      m.material = (Array.isArray(cur) ? list : list[0]) as THREE.Material | THREE.Material[];
      for (const mm of list) {
        mm.emissive = new THREE.Color(color);
        mm.emissiveIntensity = 0.55;
      }
    });
  }

  get position(): THREE.Vector3 {
    if (this.body) return toV3(this.body.position);
    if (this.turret) return this.turret.group.position.clone();
    // post-mortem: body/turret are disposed — report the death site, not the spawn
    return this.deathPos ? this.deathPos.clone() : this.home.clone();
  }
  private deathPos: THREE.Vector3 | null = null;
  /** ragdoll-lite corpse timer (polish wave): the rig keeps animating its death
   *  tumble for ~1.5s after the sim body is gone; EnemyManager sweeps it when done */
  private corpseT = 0;
  corpseDone = false;
  private deathVel = new THREE.Vector3();

  /**
   * UPGRADE LOOP (elite-affixes): gold marker tint through the existing
   * applyGlow emissive path (no new render path). Called by
   * EnemyManager.spawnOne for elites only; ordinary enemies never get
   * it. On the instanced portal path the gold emissive becomes one extra
   * canonical bucket per geometry (emissive is part of the bucket key),
   * never one per enemy.
   */
  applyEliteMarker(): void {
    const root = this.rig?.group ?? this.turret?.group;
    if (root) this.applyGlow(ELITE_MARKER_COLOR, root);
  }

  /** UPGRADE LOOP (elite-affixes): heal, capped at maxHealth (lifesteal). */
  private heal(amount: number): void {
    if (!this.alive || amount <= 0) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /**
   * ELEMENTAL-DAMAGE-TYPES: `type` defaults to 'physical' (multiplier
   * 1.0 for every kind, so untyped callers are bit-identical to before
   * this phase). The elemental multiplier applies FIRST — to the
   * crit-applied amount the caller computed — before the shield pool
   * absorbs and the elite damageTakenMult scales what gets through.
   * Returns the typed amount that entered damage() (after the
   * elemental step, before shield/armor). Callers compute the
   * displayed number caller-side via displayedDamage() (same step,
   * same table) so caller-side wrappers such as the shielded-variant
   * front-arc reduction stay HP-only as on main; the return is the
   * fallback for callers whose target has no build kind. Callers
   * that ignore the return value see identical health math. Returns
   * 0 when dead.
   */
  /**
   * UPGRADE LOOP (stealth-system): a noise event reached this enemy —
   * suspicious, never directly alerted (unless already alerted).
   * Dead enemies hear nothing.
   */
  hearNoise(from: THREE.Vector3, radius: number): void {
    if (!this.alive || radius <= 0) return;
    if (this.position.distanceTo(from) > radius) return;
    this.awarenessTracker.hearNoise();
    this.awareness = this.awarenessTracker.state;
  }

  /** UPGRADE LOOP (stealth-system): effective detection radius right now. */
  effectiveDetectionRadius(sneaking: boolean): number {
    return detectionRadiusFor(this.kind, sneaking, this.detectionJitter, this.aggroMult);
  }

  damage(amount: number, from?: THREE.Vector3, type?: DamageType): number {
    if (!this.alive) return 0;
    // UPGRADE LOOP (stealth-system): taking damage alerts immediately —
    // this is what makes the sneak bonus first-strike-only.
    this.awarenessTracker.alert();
    this.awareness = 'alerted';
    // UPGRADE LOOP (elite-affixes): remember the attacker for the
    // volatile detonation check in die(); shield absorbs first, then
    // the damage-taken multiplier (armored) applies to what gets through.
    if (from) this.lastDamageFrom = from.clone();
    const damageType = normalizeDamageType(type);
    const multiplier = resistanceFor(this.kind, damageType, this.isBoss);
    const typedAmount = applyElemental(amount, this.kind, damageType, this.isBoss);
    // Status-hook seam: observe-only, zero taps = no-op. A future
    // status wave taps onElementalHit to apply the type's statusHook
    // (burn/chill/stun); no status effect is applied in this phase.
    this.engine.hooks.emit('onElementalHit', { enemy: this, type: damageType, amount: typedAmount, multiplier });
    let remaining = typedAmount;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, remaining);
      this.shield -= absorbed;
      remaining -= absorbed;
    }
    if (remaining <= 0) {
      // Fully absorbed: feedback still reads, health untouched, no death.
      this.rig?.flash();
      this.instancer?.flash(this);
      this.engine.juice.combatHit(this.position, 0.9);
      return typedAmount;
    }
    this.health -= remaining * this.damageTakenMult;
    this.rig?.flash();
    // ENEMIES WAVE C: the instanced hit pulse. rig.flash() mutates the
    // enemy's OWN owned materials on the hidden source meshes (invisible
    // but harmless on the instanced path; the visible feedback on the
    // direct-render path). The visible feedback on the instanced path is
    // the per-instance tint pulse below — shared canonical materials are
    // never mutated. Null on the direct-render path (no-op).
    this.instancer?.flash(this);
    // polish wave: every combat hit reads — sparks + smoke + small shake
    this.engine.juice.combatHit(this.position, 0.9);
    if (this.turret) {
      const m = (this.turret.head.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      m.emissive.setHex(0xff2222); m.emissiveIntensity = 0.8;
      setTimeout(() => { m.emissive.setHex(0); }, 90);
    }
    // knockback (on the damage that actually landed, post-shield/armor)
    if (this.body && from) {
      const landed = remaining * this.damageTakenMult;
      const dir = this.position.sub(from).setY(0).normalize();
      this.body.applyImpulse(new CANNON.Vec3(dir.x * landed * 0.6, landed * 0.25, dir.z * landed * 0.6));
    }
    if (this.health <= 0) { this.die(); return typedAmount; }
    this.checkBossPhase();
    return typedAmount;
  }

  /**
   * STATUS-EFFECTS: the single application funnel. Callers roll the
   * chance on their own dedicated seeded stream and pass the draw;
   * a missed roll never applies or refreshes. Fresh application fires
   * one pooled particle burst in the status color + the onStatusApplied
   * hook (observe-only); refresh extends the duration silently (no
   * burst, no toast — the instance was already visible). Dead enemies
   * take no statuses. Never throws (a status must never break a hit).
   */
  applyStatus(id: StatusId, opts: { roll: number; now: number }): ApplyOutcome {
    if (!this.alive) return { applied: false, refreshed: false };
    let outcome: ApplyOutcome;
    try {
      outcome = this.statuses.apply(id, opts.now, { roll: opts.roll });
    } catch {
      return { applied: false, refreshed: false };
    }
    if (!outcome.applied) return outcome;
    try {
      this.engine.hooks.emit('onStatusApplied', { enemy: this, id, refreshed: outcome.refreshed });
    } catch { /* observe-only taps must never break a hit */ }
    if (!outcome.refreshed) {
      const def = statusDefOf(id);
      try {
        this.engine.particles?.burst(this.position, {
          count: 10, color: def?.color ?? '#ffffff', color2: '#ffffff',
          speed: 3, life: 0.5, size: 1.4, gravity: 0,
        });
      } catch { /* VFX must never break a hit */ }
    }
    return outcome;
  }

  /** STATUS-EFFECTS: speed multiplier from active statuses (1 = unslowed). */
  statusSpeedMult(): number {
    return this.statuses.speedMult();
  }

  /** STATUS-EFFECTS: true while a stunning status (shock) is active. */
  isStunned(): boolean {
    return this.statuses.stunned();
  }

  /** STATUS-EFFECTS: ids of currently active statuses (table order). */
  activeStatuses(): StatusId[] {
    return this.statuses.activeIds();
  }

  /**
   * STATUS-EFFECTS: tick damage — flat table damage, bypassing the
   * shield pool and knockback (a burn does not shove), respecting the
   * elite damage-taken multiplier, with the existing hit-flash pulse
   * as the only feedback. Death goes through the normal die() path.
   */
  tickDamage(amount: number): void {
    if (!this.alive || !(amount > 0)) return;
    this.health -= amount * this.damageTakenMult;
    this.rig?.flash();
    this.instancer?.flash(this);
    if (this.health <= 0) this.die();
  }

  /**
   * Boss phase transitions at ≤66% (phase 1, enraged) and ≤33% HP
   * (phase 2, desperate). Each phase multiplies speed and aggression and
   * fires onPhase so the blueprint can show a banner ("The Warden enrages!").
   * No-op for non-boss enemies. Deterministic — no RNG involved.
   */
  private checkBossPhase() {
    if (!this.isBoss || !this.alive) return;
    const frac = this.health / this.maxHealth;
    const want = frac <= 1 / 3 ? 2 : frac <= 2 / 3 ? 1 : 0;
    if (want > this.phase) {
      this.phase = want;
      this.speedMult *= 1.25;
      this.aggroMult *= 1.3;
      this.events.onPhase?.(this, this.phase);
      this.engine.hooks.emit('onPhase', { enemy: this, phase: this.phase });
      // engine-owned juice: shake + roar + music slams to full intensity
      this.engine.juice.shake(0.5);
      this.engine.audio.play('roar');
      this.engine.audio.setIntensity(1);
    }
  }

  /** current boss phase (0 = full strength) */
  get bossPhase(): number {
    return this.phase;
  }

  private die() {
    this.alive = false;
    const p = this.position;
    this.deathPos = p.clone();
    // UPGRADE LOOP (elite-affixes): volatile detonation. Only when the
    // killing blow was struck from within VOLATILE_RADIUS of the death
    // site — the attacker was close enough to be caught in the blast.
    // Damage rides the existing onPlayerHit channel (same channel every
    // melee/ranged hit uses); distant kills never detonate on the player.
    if (this.volatile && this.lastDamageFrom
      && this.lastDamageFrom.distanceTo(p) <= VOLATILE_RADIUS) {
      this.events.onPlayerHit?.(this.spec.damage * VOLATILE_DAMAGE_FRAC, p, this.kind);
    }
    // polish wave: death reads — explosion + smoke column + shake + hit-stop
    this.engine.juice.deathFX(p, this.kind === 'brute' ? 1.8 : 1);
    this.engine.audio.play('explosion', { vol: 0.7 });
    if (this.body && this.rig && (this.kind === 'walker' || this.kind === 'brute')) {
      // ANIMATION wave: ragdoll-lite corpse — the body's momentum is captured,
      // the sim body is pulled out of physics, and the rig stays in the scene
      // while its procedural tumble carries it to rest. Sim bodies and the
      // timestep are untouched; the tumble is visual-only.
      this.deathVel.copy(toV3(this.body.velocity));
      this.engine.physics.remove(this.body);
      this.body = null;
      this.corpseT = 1.5;
      this.rig.setDead(true);
    } else {
      this.dispose();
    }
    this.events.onDeath?.(this);
  }

  /**
   * Post-mortem update: drive the rig's momentum tumble until it settles,
   * then fully dispose (scene + GPU). Called from update() while the corpse
   * is still in the EnemyManager roster.
   */
  private updateCorpse(dt: number, t: number) {
    if (!this.rig) { this.corpseDone = true; return; } // disposed externally — sweep the roster entry
    if (this.corpseT <= 0) return;
    this.corpseT -= dt;
    this.rig.animate(t, 0, { dead: true, deadVelocity: this.deathVel });
    if (this.corpseT <= 0) {
      this.dispose();
      this.corpseDone = true;
    }
  }

  /**
   * FIX: full lifecycle — remove the body from physics, detach the rig from the
   * scene, and dispose per-instance GPU resources. Geometries adopted from the
   * rig cache are released (ref-counted; zero-ref entries self-dispose) and
   * per-instance owned materials are disposed — shared MaterialLibrary-cached
   * materials are never disposed. Idempotent.
   */
  dispose() {
    if (this.body) {
      this.engine.physics.remove(this.body);
      this.body = null;
    }
    const root = this.rig?.group ?? this.turret?.group;
    if (root) {
      this.engine.scene.remove(root);
      this.releaseRigResources(root);
    }
    this.rig = null;
    this.turret = null;
  }

  /**
   * ENEMIES WAVE C: release one rig group's GPU resources. When geometries
   * were cache-shared (the normal path), adopted signatures are released
   * (the cache owns the canonicals) and only per-instance owned materials
   * are disposed — disposeOwned would kill canonical geometries other
   * enemies still render. Falls back to disposeOwned when share() failed.
   * Idempotent.
   */
  private releaseRigResources(root: THREE.Group) {
    if (this.adopted) {
      NpcRigCache.for(this.engine).release(this.adopted);
      this.adopted = null;
      disposeOwnedMaterials(root);
    } else {
      disposeOwned(root);
    }
  }

  update(dt: number, playerPos: THREE.Vector3, t: number, perception: StealthPerception = DEFAULT_PERCEPTION) {
    if (!this.alive) { this.updateCorpse(dt, t); return; }
    const pos = this.position;
    // render-interpolated position for visual placements only — AI logic keeps raw `pos`
    const vpos = this.body ? this.engine.physics.interpolatedPosition(this.body, this.tmpV) : pos;
    // UPGRADE LOOP (deployables): the lure hook — a lured enemy measures
    // ranges and aims at the totem instead of the player.
    // UPGRADE LOOP (companion-combat-depth): a companion-targeted enemy
    // measures ranges and aims at the companion instead (lure wins on
    // ties; null companionTargetPos = pre-phase behavior exactly).
    const tgt = this.lureTarget ?? this.companionTargetPos ?? playerPos;
    this.lastTarget = this.lureTarget ? 'lure' : this.companionTargetPos ? 'companion' : 'player';
    const dist = pos.distanceTo(tgt);
    // STATUS-EFFECTS: game-time tick drive (t is engine.time). Tick
    // damage can kill: a tick-killed enemy runs its corpse path and
    // never reaches the movement machine below. Tick feedback reuses
    // the pooled floating numbers (playerDamage kind) + the flash
    // pulse inside tickDamage() — no new allocations, no shake.
    this.statuses.update(t, (_id, amount) => {
      this.tickDamage(amount);
      try {
        this.engine.juice?.spawnText(this.engine.camera, this.position, 'playerDamage', amount);
      } catch { /* VFX must never break the frame */ }
    });
    if (!this.alive) { this.updateCorpse(dt, t); return; }
    // STATUS-EFFECTS: stun (shock) freezes movement AND the attack
    // cooldown — the attackCd decrement below is skipped, so the stun
    // does not eat into the enemy's next attack window.
    if (this.statuses.stunned()) {
      if (this.body) { this.body.velocity.x = 0; this.body.velocity.z = 0; }
      this.rig?.animate(t, 0, {});
      return;
    }
    this.attackCd -= dt;

    // UPGRADE LOOP (stealth-system): the effective detection radius is
    // the old aggroR with sneak + jitter folded in (base 30/42 x sneak
    // 0.45 x jitter 0.9–1.1 x aggroMult). The ONLY behavior-contract
    // change: chase/ranged-attack require targeting weight 100
    // (alerted). Suspicious/unaware enemies wander (idle) — they never
    // pursue. Melee contact (below) and lures bypass awareness: a
    // lured enemy is alerted, and a melee enemy already touching its
    // target attacks exactly as before stealth existed.
    const aggroR = this.effectiveDetectionRadius(perception.sneaking && !this.lureTarget);
    const isMelee = this.kind === 'walker' || this.kind === 'brute';
    const attackR = isMelee ? 2.2 : 26;
    // Contact: a melee enemy whose target is already inside its strike
    // range has physically bumped into the target — instant detection.
    // This preserves the pre-stealth contract (a fresh enemy with the
    // player on top of it attacks on the first update; see the
    // deployables control test). Ranged kinds get no bypass: firing a
    // weapon is a targeting act, gated by awareness like the chase.
    const contact = !this.lureTarget && isMelee && dist < attackR;
    if (this.lureTarget) {
      this.awarenessTracker.alert();
      this.awareness = 'alerted';
    } else if (contact) {
      this.awarenessTracker.alert();
      this.awareness = 'alerted';
    } else {
      const noiseHeard = perception.noiseRadius > 0 && dist <= perception.noiseRadius;
      this.awareness = this.awarenessTracker.update(dt, {
        inDetectionRange: dist < aggroR,
        beyondHysteresis: dist > aggroR * 1.3,
        noiseHeard,
      });
    }

    if (contact || targetWeightFor(this.awareness) > 0) {
      if (dist < attackR && this.attackCd <= 0) this.state = 'attack';
      else if (dist < aggroR) this.state = 'chase';
      else if (this.state !== 'idle' && dist > aggroR * 1.3) this.state = 'idle';
    } else {
      this.state = 'idle';
    }

    switch (this.kind) {
      case 'walker': case 'brute': {
        const b = this.body!;
        if (this.state === 'chase' || this.state === 'attack') {
          const dir = tgt.clone().sub(pos).setY(0).normalize();
          // STATUS-EFFECTS: frost-slow multiplies movement speed (min
          // over active statuses; shock stuns outright above).
          const sp = this.spec.speed * this.speedMult * this.statuses.speedMult() * (this.state === 'attack' ? 0.4 : 1);
          b.velocity.x = dir.x * sp;
          b.velocity.z = dir.z * sp;
          this.rig!.group.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI;
          if (this.state === 'attack' && this.attackCd <= 0) {
            this.attackCd = 1.2;
            this.rig!.swing?.();
            // UPGRADE LOOP (deployables): a lured enemy mauls the totem —
            // never the player.
            // UPGRADE LOOP (companion-combat-depth): a companion-targeted
            // enemy hits the companion (onCompanionHit) — never the
            // player. Vampiric lifesteal still applies: the hit landed,
            // so life was drained (from the companion).
            if (dist < 2.6 && !this.lureTarget) {
              if (this.companionTargetPos) {
                this.events.onCompanionHit?.(this.spec.damage, pos, this.kind);
                this.heal(this.spec.damage * this.lifestealFrac);
              } else {
                this.events.onPlayerHit?.(this.spec.damage, pos, this.kind);
                // UPGRADE LOOP (elite-affixes): vampiric lifesteal on a
                // landed melee hit (lured mauling heals nothing — no player
                // was hit, so no life was drained).
                this.heal(this.spec.damage * this.lifestealFrac);
              }
            }
          }
        } else {
          // wander
          if (!this.wanderTarget || pos.distanceTo(this.wanderTarget) < 1.5) {
            this.wanderTarget = this.home.clone().add(new THREE.Vector3(this.rng.range(-8, 8), 0, this.rng.range(-8, 8)));
          }
          const dir = this.wanderTarget.clone().sub(pos).setY(0).normalize();
          b.velocity.x = dir.x * this.spec.speed * this.speedMult * this.statuses.speedMult() * 0.3;
          b.velocity.z = dir.z * this.spec.speed * this.speedMult * this.statuses.speedMult() * 0.3;
        }
        this.rig!.group.position.set(vpos.x, vpos.y - 0.85 * (this.kind === 'brute' ? 1.7 : 1), vpos.z);
        const planar = Math.hypot(b.velocity.x, b.velocity.z);
        this.rig!.animate(t, planar, {});
        break;
      }
      case 'drone': case 'flyer': {
        const b = this.body!;
        const hoverY = (this.engine.terrain ? this.engine.terrain.heightAt(pos.x, pos.z) : 0) + (this.kind === 'flyer' ? 4 : 3) + Math.sin(t * 2 + this.hoverPhase) * 0.4;
        const target = this.state === 'idle' ? this.home : tgt;
        const dir = target.clone().sub(pos);
        dir.y = 0;
        const d = dir.length();
        if (d > 1) dir.normalize();
        // strafe orbit when in range
        if (this.state !== 'idle' && d < 14) {
          const orbit = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(Math.sin(t * 0.7 + this.hoverPhase) > 0 ? 1 : -1);
          dir.multiplyScalar(d > 10 ? 1 : -0.3).add(orbit.multiplyScalar(0.8)).normalize();
        }
        const sp = this.spec.speed * this.speedMult * this.statuses.speedMult();
        b.velocity.x = dir.x * sp;
        b.velocity.z = dir.z * sp;
        b.velocity.y = (hoverY - pos.y) * 2.2;
        this.rig!.group.position.copy(vpos);
        this.rig!.group.rotation.y = Math.atan2(tgt.x - pos.x, tgt.z - pos.z);
        this.rig!.animate(t, sp, {});
        if (this.state === 'attack' && this.attackCd <= 0 && this.projectiles) {
          this.attackCd = this.kind === 'flyer' ? 1.6 : 2.2;
          const aim = tgt.clone().add(new THREE.Vector3(0, 0.9, 0)).sub(pos).normalize();
          this.projectiles.fire(pos.clone().add(aim.clone().multiplyScalar(0.8)), aim, { speed: 26, damage: this.spec.damage, friendly: false });
          // UPGRADE LOOP (elite-affixes): vampiric lifesteal on firing —
          // the projectile carries the drain (documented approximation:
          // the heal lands on launch, not on projectile impact).
          this.heal(this.spec.damage * this.lifestealFrac);
          this.engine.audio.play('laser', { pitch: 0.8, vol: 0.5 });
        }
        break;
      }
      case 'turret': {
        if (!this.turret) break;
        if (this.state !== 'idle') {
          const head = this.turret.head;
          const want = Math.atan2(tgt.x - pos.x, tgt.z - pos.z);
          let d = want - head.rotation.y;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          head.rotation.y += d * Math.min(1, dt * 3);
          if (this.attackCd <= 0 && Math.abs(d) < 0.25 && this.projectiles) {
            this.attackCd = 0.55;
            const muzzle = new THREE.Vector3();
            this.turret.muzzle.getWorldPosition(muzzle);
            const aim = tgt.clone().add(new THREE.Vector3(0, 1, 0)).sub(muzzle).normalize();
            this.projectiles.fire(muzzle, aim, { speed: 40, damage: this.spec.damage, friendly: false });
            // UPGRADE LOOP (elite-affixes): vampiric lifesteal on firing
            // (same launch-time approximation as drones/flyers).
            this.heal(this.spec.damage * this.lifestealFrac);
            this.engine.audio.play('shoot', { pitch: 1.3, vol: 0.4 });
          }
        }
        break;
      }
    }
    // custom kind behavior overlay (registered via engine.hooks.registerEnemyKind)
    this.customDef?.update?.(this, { dt, t, playerPos });
  }
}

/** Point of interest: landmark/structure anchor for enemy placement. */
export interface EnemyPoi {
  x: number;
  z: number;
  /** footprint radius to stay outside of (default 0) */
  r?: number;
}

/**
 * ITEMS-EXPANSION: enemy loot-drop grant hooks. Blueprints set
 * `manager.lootHooks` after the item world exists; null (default) means
 * no drops and the die() path is byte-identical to before this wave.
 */
export interface EnemyLootHooks {
  /** fired once per rolled drop on the die() path, with the death position */
  onLoot: (drop: LootDrop, pos: THREE.Vector3) => void;
  /**
   * VENDOR-ECONOMY: fired once per kill with the seeded scrap payout (may
   * be 0 — most kills pay nothing). Optional: when undefined the death
   * path is byte-identical to before this wave.
   */
  onCurrency?: (amount: number, pos: THREE.Vector3) => void;
}

export interface EnemyManagerOpts {
  /**
   * ITEMS-EXPANSION: map seed for the loot stream (Rng(mapSeed ^
   * LOOT_SALT)). Defaults to engine.spec.meta.seed — the portals
   * contract says meta.seed IS the initial map's build seed. Every
   * spawnForMap (portal arrival) re-seeds the stream with the new map's
   * seed, so each map's kill sequence rolls identically.
   */
  lootSeed?: number;
  /** POIs to ring the roster around (blueprint passes landmarks.placed) */
  pois?: Array<THREE.Vector3 | EnemyPoi>;
  /** roster specs, cycled (default: engine.spec.enemies) */
  specs?: EnemySpec[];
  /** 0..1+ scales the spec counts (default 1) */
  density?: number;
  /**
   * Replay hook fired per enemy spawned via spawnForMap, in spawn order.
   * Blueprints use it to re-apply per-enemy decoration (e.g. variant
   * registration) so portal arrivals get the same treatment as the
   * initial build.
   */
  onSpawned?: (e: Enemy, index: number) => void;
  /**
   * UPGRADE LOOP (enemy-scaling): live player Progression level, read at
   * spawn time. Default () => 1 (band 0 = identity band, byte-identical
   * spawns). Blueprints wire () => prog.level.
   */
  playerLevel?: () => number;
  /**
   * UPGRADE LOOP (difficulty-modes): player-selected difficulty mode, read
   * at spawn time. Default () => 'normal' (identity mode, byte-identical
   * spawns). Blueprints wire () => engine.getDifficultyMode().
   */
  difficulty?: () => DifficultyId;
  /**
   * UPGRADE LOOP (new-game-plus): the player's prestige cycle, read at
   * spawn time. Default () => 0 (identity row, byte-identical spawns).
   * Blueprints wire () => engine.getNgPlusCycle().
   */
  ngPlus?: () => number;
  /**
   * UPGRADE LOOP (elite-affixes): elite chance for this roster, read at
   * spawn time. Default () => 0 (identity: no elites, byte-identical
   * spawns — the roll short-circuits before any draw). Blueprints wire
   * () => resolveEliteChance(engine.spec). The roll itself is a pure
   * function of (spawnSeed, chance) in eliteAffixes.ts.
   */
  eliteChance?: () => number;
  /**
   * UPGRADE LOOP (daily-mutators): the live daily run's mutator ids,
   * read at spawn/kill time. Default () => [] (identity: every multiplier
   * 1, byte-identical spawns). Blueprints wire
   * () => engine.getDailyMutators(). Applied LAST on the scaled copy
   * (band -> difficulty -> NG+ -> affixes -> mutators); see dailyMutators.ts
   * for the field semantics and the spawnAll scoping note.
   */
  mutators?: () => readonly string[];
}

/** Spawns and manages the full enemy roster from spec. */
export class EnemyManager implements MapLocalEntitySystem {
  /** MapLocalEntitySystem id — the blueprint registers this with engine.portalEntities. */
  readonly id = 'enemies';
  enemies: Enemy[] = [];
  killed = 0;
  private readonly opts: EnemyManagerOpts;
  /**
   * ENEMIES WAVE C: the manager owns the per-engine instancer (same
   * singleton NpcManager uses — buckets are shared across NPCs and
   * enemies). registerEnemy on spawnForMap, beginFrame/submit/endFrame in
   * update, reset first in despawnAll, unregister on the corpse sweep.
   */
  private readonly instancer: NpcInstancer;
  /**
   * ITEMS-EXPANSION: loot-drop grant hooks (blueprint-set, after the item
   * world exists). Null = no drops; the death path is unchanged.
   */
  lootHooks: EnemyLootHooks | null = null;
  /**
   * ITEMS-EXPANSION: the per-map loot stream, Rng(mapSeed ^ LOOT_SALT).
   * Re-seeded on every spawnForMap; lazily primed from opts.lootSeed /
   * spec.meta.seed on the initial-build spawnAll path. Never engine.rng.
   */
  /**
   * ITEMS-EXPANSION: the per-map loot stream, Rng(mapSeed ^ LOOT_SALT).
   * (see the items-expansion doc above)
   */
  private lootRng: Rng | null = null;
  /**
   * VENDOR-ECONOMY: the per-map currency stream, Rng(mapSeed ^ LOOT_SALT ^
   * CURRENCY_SALT) — a SEPARATE stream from the item loot so the
   * items-expansion drop sequence (and its e2e replication) is untouched.
   * Re-seeded on every spawnForMap; lazily primed like lootRng.
   */
  private currencyRng: Rng | null = null;

  constructor(
    private engine: Engine,
    private projectiles: Projectiles | null,
    private events: EnemyEvents & { onDeath?: (e: Enemy) => void },
    opts: EnemyManagerOpts = {},
  ) {
    this.opts = opts;
    this.instancer = NpcInstancer.for(engine);
  }

  /**
   * Single-enemy spawn shared by spawnAll (blueprint initial build / waves)
   * and spawnForMap (portal arrivals). Wiring is identical on both paths.
   */
  spawnOne(spec: EnemySpec, pos: THREE.Vector3, seed: number): Enemy {
    // UPGRADE LOOP (enemy-scaling): additive difficulty scaling. The band
    // derives from max(player Progression level, map depth) at spawn time;
    // the authored spec object is never mutated — the Enemy gets a scaled
    // copy. Band 0 (levels 1-5) is the identity band (mults 1.0, variance 0),
    // so fresh-player spawns are byte-identical to pre-scaling builds.
    // WORLD-TIERS: engine.worldTier (pure function of (mapSeed, map depth),
    // 1 on the origin map / single-map games) raises the level floor via
    // effectiveSpawnLevel's tier term — tier 1 is the identity.
    const scaled = applyEnemyScaling(
      spec,
      seed,
      this.opts.playerLevel?.() ?? 1,
      mapDistanceFromSpec(this.engine.spec),
      this.engine.worldTier ?? 1,
    );
    // UPGRADE LOOP (difficulty-modes): additive difficulty multiplier on
    // top of the band scaling (normal = identity, byte-identical spawns).
    // The authored spec object is never mutated — the Enemy gets a scaled
    // copy. Deterministic: same (mapSeed, playerLevel, difficulty) ->
    // identical encounters.
    const diff = difficultyById(this.opts.difficulty?.() ?? 'normal');
    const dScaled = applyDifficultyScaling(scaled.spec.health, scaled.spec.damage, scaled.xpMult, diff);
    // UPGRADE LOOP (new-game-plus): additive NG+ multiplier on top of the
    // band + difficulty scaling (cycle 0 = identity, byte-identical
    // spawns). The authored spec object is never mutated — the Enemy gets
    // a scaled copy. Deterministic: same (mapSeed, playerLevel, difficulty,
    // cycle) -> identical encounters; NG+ draws no RNG.
    const ng = ngPlusByCycle(this.opts.ngPlus?.() ?? 0);
    const nScaled = applyNgPlusScaling(dScaled.health, dScaled.damage, dScaled.xpMult, diff.lootChanceMult, ng);
    // UPGRADE LOOP (elite-affixes): seeded elite roll, applied LAST on
    // the scaled copy (band -> difficulty -> NG+ -> affixes). The roll
    // draws from its own ELITE_SALT stream, so non-elite spawns and the
    // scaling-variance draws are untouched; eliteChance 0 short-circuits
    // to no affixes with zero draws. The authored spec is never mutated.
    const eliteRoll = rollEliteAffixes(seed, this.opts.eliteChance?.() ?? 0);
    const affixed = applyEliteAffixes(
      nScaled.health, nScaled.damage, scaled.spec.speed, nScaled.xpMult, eliteRoll.affixes);
    // UPGRADE LOOP (daily-mutators): additive mutator layer, applied LAST
    // on the scaled copy (band -> difficulty -> NG+ -> affixes -> mutators).
    // Player-taken damage folds into the enemy damage stat (the difficulty
    // pattern, so every damage path is covered); player-dealt damage and
    // enemy armor compose on Enemy.damageTakenMult (see dailyMutators.ts
    // for why one field carries both). No mutators = identity, spawns
    // byte-identical to pre-mutator builds.
    const mut = this.mutatorEffect();
    const finalSpec = {
      ...scaled.spec,
      health: affixed.health, damage: affixed.damage * mut.playerDamageTakenMult, speed: affixed.speed,
    };
    const e = new Enemy(this.engine, finalSpec, pos, this.projectiles, {
      onPlayerHit: this.events.onPlayerHit,
      // UPGRADE LOOP (companion-combat-depth): forward the companion-hit
      // channel too — without this, companion-targeted melee hits would
      // silently deal no damage (the per-enemy events object is built
      // here, not passed through wholesale).
      onCompanionHit: this.events.onCompanionHit,
      // ANIMATION wave: the kill is counted at death; the roster entry is
      // swept once the ragdoll-lite corpse finishes (EnemyManager.update),
      // so waves can't accumulate corpses forever
      onDeath: (en) => {
        this.killed++; this.engine.hooks.emit('onKill', { enemy: en }); this.events.onDeath?.(en);
        // ITEMS-EXPANSION: seeded loot drops off the die() path. The
        // stream is Rng(mapSeed ^ LOOT_SALT) — reset on every spawnForMap
        // so each map's kill sequence rolls identically. A grant failure
        // must never break the death path (variants, score, XP run above).
        // WORLD-TIERS: the map's tier shifts gear rarity weighting
        // (tier 1 = authored tables, byte-identical).
        if (this.lootHooks) {
          if (!this.lootRng) {
            this.lootRng = buildLootRng(this.opts.lootSeed ?? this.engine.spec.meta.seed);
          }
          for (const drop of rollLoot(this.lootRng, en.spec.kind, en.isBoss, this.engine.worldTier ?? 1, this.difficultyDef().lootChanceMult * this.ngPlusDef().lootChanceMult * this.mutatorEffect().lootChanceMult)) {
            try { this.lootHooks.onLoot(drop, en.position); } catch { /* loot is cosmetic */ }
          }
          // VENDOR-ECONOMY: seeded scrap payout off the separate currency
          // stream (never the item stream). Optional hook — undefined keeps
          // the death path byte-identical. A grant failure must never break
          // the death path.
          if (this.lootHooks.onCurrency) {
            if (!this.currencyRng) {
              this.currencyRng = buildCurrencyRng(this.opts.lootSeed ?? this.engine.spec.meta.seed, LOOT_SALT);
            }
            const coins = rollCurrencyDrops(this.currencyRng, en.spec.kind, en.isBoss);
            if (coins > 0) {
              try { this.lootHooks.onCurrency(coins, en.position); } catch { /* currency is cosmetic */ }
            }
          }
        }
      },
    }, seed);
    // ENEMIES WAVE C: every manager-spawned enemy can route its hit-flash
    // through the instancer; flash() no-ops for unregistered enemies, so
    // the direct-render initial-build path is unaffected.
    e.instancer = this.instancer;
    // UPGRADE LOOP (enemy-scaling): per-enemy band metadata (see fields).
    // UPGRADE LOOP (difficulty-modes): the kill XP multiplier is the band
    // xpMult times the difficulty enemyXpMult.
    // UPGRADE LOOP (new-game-plus): times the NG+ enemyXpMult on top.
    // UPGRADE LOOP (elite-affixes): times the affix xpMult on top of all
    // three, and the affix mechanics ride the enemy (shield pool from
    // the affixed maxHealth, damage-taken mult, lifesteal, volatile flag).
    // Elites get the gold marker tint (existing applyGlow path).
    e.xpMult = affixed.xpMult;
    e.scalingBand = scaled.bandIndex;
    e.eliteAffixes = eliteRoll.affixes;
    e.damageTakenMult = affixed.mods.damageTakenMult * mut.enemyDamageTakenMult * mut.playerDamageDealtMult;
    e.lifestealFrac = affixed.mods.lifestealFrac;
    e.volatile = affixed.mods.volatile;
    e.maxShield = e.shield = e.maxHealth * affixed.mods.shieldFrac;
    if (eliteRoll.isElite) e.applyEliteMarker();
    this.enemies.push(e);
    return e;
  }

  /**
   * UPGRADE LOOP (difficulty-modes): the live difficulty def for this
   * manager's roster. Read per spawn/kill so a difficulty change applies
   * to enemies spawned after the change (already-spawned enemies keep
   * their spawn-time stats — deterministic per (seed, level, difficulty)).
   */
  private difficultyDef() {
    return difficultyById(this.opts.difficulty?.() ?? 'normal');
  }

  /**
   * UPGRADE LOOP (new-game-plus): the live NG+ def for this manager's
   * roster. Read per spawn/kill so a cycle change applies to enemies
   * spawned after the change (already-spawned enemies keep their
   * spawn-time stats — deterministic per (seed, level, difficulty, cycle)).
   */
  private ngPlusDef() {
    return ngPlusByCycle(this.opts.ngPlus?.() ?? 0);
  }

  /**
   * UPGRADE LOOP (daily-mutators): the combined mutator effect for this
   * manager's roster. Read per spawn/kill so a daily run's set applies to
   * enemies spawned after the run starts (already-spawned enemies keep
   * their spawn-time stats). Identity when the opts callback is absent.
   */
  private mutatorEffect() {
    return combineMutatorEffects(this.opts.mutators?.() ?? []);
  }

  /**
   * UPGRADE LOOP (difficulty-modes): true when any live enemy is hostile
   * (chasing or attacking the player). The difficulty selector uses this
   * to refuse changes mid-combat.
   */
  anyHostile(): boolean {
    return this.enemies.some((e) => e.alive && e.hostile);
  }

  spawnAll(specs: EnemySpec[], spawnFor: (kind: string, i: number, n: number) => THREE.Vector3) {
    for (const spec of specs) {
      for (let i = 0; i < spec.count; i++) {
        this.spawnOne(spec, spawnFor(spec.kind, i, spec.count),
          this.engine.spec.meta.seed ^ (this.enemies.length * 7919));
      }
    }
  }

  /**
   * MapLocalEntitySystem arrival path: spawn this map's deterministic roster
   * from mapSeed ALONE — `new Rng(mapSeed ^ ENEMY_SALT)` only; never
   * engine.rng (it advances across transitions), never Math.random/Date.now.
   * Same mapSeed -> identical roster (kinds + positions).
   * Idempotent: despawns any live roster first (an aborted transition can
   * never double-spawn).
   *
   * UPGRADE LOOP (enemy-scaling): enemy STATS additionally depend on
   * (playerLevel, mapDist) via enemyScaling.ts — same (mapSeed,
   * playerLevel, map) -> identical encounters. Positions/kinds remain
   * mapSeed-ALONE; variance streams use SCALING_SALT so the spawn-order
   * stream above is untouched.
   * UPGRADE LOOP (new-game-plus): STATS additionally depend on the
   * player's NG+ cycle via newGamePlus.ts (band -> difficulty -> NG+,
   * each on a scaled copy) — same (mapSeed, playerLevel, difficulty,
   * cycle) -> identical encounters; NG+ draws no RNG.
   */
  spawnForMap(mapSeed: number): void {
    this.despawnAll();
    // ITEMS-EXPANSION: fresh map, fresh loot stream — the arrival kill
    // sequence rolls identically for the same mapSeed.
    this.lootRng = buildLootRng(mapSeed);
    const rng = new Rng((mapSeed ^ ENEMY_SALT) >>> 0);
    const specs = this.opts.specs ?? this.engine.spec.enemies ?? [];
    // UPGRADE LOOP (daily-mutators): swarm multiplies the roster density
    // here (the opts.density scale). spawnAll is deliberately untouched:
    // its counts are authored per-encounter (waves, scripted bosses).
    const density = (this.opts.density ?? 1) * this.mutatorEffect().spawnDensityMult;
    const raw = this.opts.pois?.length ? this.opts.pois : [{ x: 0, z: 0, r: 0 }];
    const pois = raw.map((p) => p instanceof THREE.Vector3
      ? { x: p.x, z: p.z, r: 0 }
      : { x: p.x, z: p.z, r: p.r ?? 0 });
    let index = 0;
    for (const spec of specs) {
      const count = Math.max(0, Math.round((spec.count ?? 1) * density));
      for (let i = 0; i < count; i++) {
        // NPC-wave pattern: ring each enemy around a POI anchor, outside the
        // landmark footprint, grounded via terrain.heightAt.
        const poi = rng.pick(pois);
        const a = rng.range(0, Math.PI * 2);
        const d = poi.r + 6 + rng.range(0, 10);
        const x = poi.x + Math.cos(a) * d;
        const z = poi.z + Math.sin(a) * d;
        const y = (this.engine.terrain ? (this.engine.terrain.heightAt(x, z) ?? 0) : 0) + 1;
        const seed = (mapSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
        const e = this.spawnOne(spec, new THREE.Vector3(x, y, z), seed);
        // ENEMIES WAVE C: portal-path enemies render instanced — one
        // InstancedMesh per (geometry, material-role) bucket across the
        // whole roster (shared with NPC buckets where roles match).
        this.instancer.registerEnemy(e);
        this.opts.onSpawned?.(e, index);
        index++;
      }
    }
  }

  /**
   * MapLocalEntitySystem departure path: dispose EVERY live enemy — live
   * combatants AND mid-tumble corpses (their sim bodies are already gone;
   * dispose() frees the rig group + GPU resources). Idempotent: calling it
   * twice in a row is a no-op, never an error.
   *
   * ENEMIES WAVE C: unregister per-entity from the shared instancer (NOT
   * reset() — the NPC manager shares this per-engine singleton, and
   * spawnForMap self-cleans via despawnAll; a global reset here would
   * drop the villagers' instancing on every enemy spawn).
   */
  despawnAll(): void {
    for (const e of this.enemies) {
      try { this.instancer.unregister(e); } catch { /* portal departures must never strand the rest */ }
      try { e.dispose(); } catch { /* portal departures must never strand the rest */ }
    }
    this.enemies = [];
  }

  /** Remove a dead enemy from the roster (scene/physics/GPU already freed — at die() for
   *  instant deaths, at corpse-tumble end for walker/brute deaths). */
  private removeEnemy(e: Enemy) {
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.enemies.splice(i, 1);
  }

  aliveCount() { return this.enemies.filter((e) => e.alive).length; }

  /** nearest living enemy within r of p */
  nearest(p: THREE.Vector3, r = Infinity): Enemy | null {
    let best: Enemy | null = null, bd = r;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = e.position.distanceTo(p);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /**
   * UPGRADE LOOP (stealth-system): one-shot noise event (an attack).
   * Every living enemy within `radius` of `pos` becomes suspicious
   * (never directly alerted). Enemies outside the radius hear nothing.
   */
  emitNoise(pos: THREE.Vector3, radius: number): void {
    for (const e of this.enemies) e.hearNoise(pos, radius);
  }

  update(dt: number, playerPos: THREE.Vector3, t: number, perception: StealthPerception = DEFAULT_PERCEPTION) {
    // ENEMIES WAVE C: the blueprint drives the shared instancer frame
    // (beginFrame/endFrame) around the manager updates — NpcManager and
    // EnemyManager submit into the same per-engine buckets, so a single
    // begin/end per update keeps both rosters' counts accumulating
    // instead of the second beginFrame zeroing the first manager's
    // submits. This only submits each enemy's posed rig here.
    // Unregistered enemies (blueprint initial-build path) submit as no-ops.
    // iterate a copy: the roster can change mid-loop (custom kinds, death)
    for (const e of [...this.enemies]) {
      e.update(dt, playerPos, t, perception);
      this.instancer.submit(e);
    }
    // sweep finished corpses: their death tumble ran, scene + GPU freed.
    // Unregister first so no stale parts linger in the buckets.
    for (const e of this.enemies.filter((en) => en.corpseDone)) {
      this.instancer.unregister(e);
      this.removeEnemy(e);
    }
  }
}
