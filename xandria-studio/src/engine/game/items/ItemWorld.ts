/**
 * Item system core — world loot, physics-dropped items, chests, magnet/collect.
 *
 * Owns everything in `src/engine/game/items/`. The graphics crew may swap the
 * default mesh factory (BasicItemMeshes) for a deluxe ItemMeshFactory later;
 * the inventory/UI crews consume `onPickup` / `wireItems`'s InventoryLike.
 *
 * Determinism: every random draw comes from engine.rng (forked once at
 * construction). No Math.random / Date.now in sim paths.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Engine } from '../../Engine';
import { InteractionRegistry, type Interactable } from '../Interaction';
import { GROUP } from '../../core/Physics';
import { Rng } from '../../core/Rng';
import { applyBuoyancy } from '../../physics/Water';
import { sampleChecked, type PlacementTerrain } from '../../physics/TerrainAwarePlacement';
import type {
  ItemChestDef,
  ItemDef,
  ItemLootSpot,
  ItemRarity,
  ItemSkinDef,
} from '../../../spec/schema';

// ---------------------------------------------------------------------------
// Shared contracts (verbatim — other crews implement the same shapes)
// ---------------------------------------------------------------------------

/** Rarity → glow color (drives glow ring, particles, HUD tints). */
export const RARITY_GLOW: Record<ItemRarity, string> = {
  common: '#9a9a9a',
  uncommon: '#4dff6a',
  rare: '#4da6ff',
  epic: '#c97aff',
  legendary: '#ffb13d',
};

/** Procedural-or-deluxe mesh provider for item definitions. */
export interface ItemMeshFactory {
  meshFor(def: ItemDef): THREE.Object3D;
}

/** Minimal inventory surface ItemWorld needs. `add` returns the leftover
 *  count that did not fit (0 when everything fit). */
export interface InventoryLike {
  add(itemId: string, count?: number): number;
}

// ---------------------------------------------------------------------------
// Public world-state types
// ---------------------------------------------------------------------------

/** One item instance living in the world (loot spot or drop). */
export interface WorldItem {
  /** def id from custom.items.defs */
  id: string;
  def: ItemDef;
  count: number;
  mesh: THREE.Object3D;
  /** live cannon-es body while tumbling; null once settled (presentation mode) */
  body: CANNON.Body | null;
  mode: 'physics' | 'presentation';
  taken: boolean;
  /** presentation-mode hover anchor (or last settled y) */
  baseY: number;
  /** deterministic presentation phase (bob offset / spin offset) */
  phase: number;
  /** presentation spin rate (rad/s) */
  spin: number;
  /** shimmer countdown for rare+ items */
  shimmerT: number;
  /** seconds the body has been nearly still (fallback settle trigger) */
  stillT: number;
  /** grace timer: hovering just out of collect reach (e.g. resting on the player's head) */
  closeT: number;
}

/** A lootable container in the world. */
export interface Chest {
  /** stable id, e.g. 'chest-0' — also the Interactable id */
  id: string;
  def: ItemChestDef;
  group: THREE.Group;
  lid: THREE.Object3D;
  /** lid hinge target angle (animates toward it in update) */
  lidTarget: number;
  /** static heavy box body; removed when smashed */
  body: CANNON.Body | null;
  hp: number;
  opened: boolean;
  broken: boolean;
  locked: boolean;
  center: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const MAGNET_RADIUS = 3.0;
const COLLECT_RADIUS = 0.9;
const HOVER_BOB = 0.14;
const CHEST_HP = 3;
const CHEST_INTERACT_RADIUS = 3.0;

const RARITY_IDX: Record<ItemRarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

/** Physics shape by item type — weapons/armor are boxes, everything else spheres. */
function shapeFor(def: ItemDef): { kind: 'box' | 'sphere'; extents: [number, number, number]; radius: number } {
  switch (def.type) {
    case 'weapon': return { kind: 'box', extents: [0.95, 0.2, 0.2], radius: 0.48 };
    case 'armor': return { kind: 'box', extents: [0.52, 0.45, 0.42], radius: 0.3 };
    case 'consumable': return { kind: 'sphere', extents: [0.5, 0.5, 0.5], radius: 0.25 };
    case 'material': return { kind: 'sphere', extents: [0.62, 0.62, 0.62], radius: 0.31 };
    case 'key': return { kind: 'box', extents: [0.38, 0.12, 0.2], radius: 0.19 };
    default: return { kind: 'sphere', extents: [0.42, 0.42, 0.42], radius: 0.21 };
  }
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry?.dispose();
      // Materials are per-def cached/shared inside BasicItemMeshes — do NOT
      // dispose here (same convention as Pickups: geometry is per-spawn).
    }
  });
}

/** Stable string hash → deterministic per-def visual variants (no rng needed). */
function nameHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// BasicItemMeshes — decent procedural default ItemMeshFactory
// ---------------------------------------------------------------------------

/**
 * Procedural per-type item meshes: blade/guard/pommel for weapons, flask for
 * consumables, crystal/ingot for materials, key ring+stem for keys, gem for
 * trinkets, plate for armor. Simple standard materials (no role tags) plus a
 * rarity glow ring at the base. All geometry is deterministic; materials are
 * cached per def-type so disposeObject only frees per-spawn geometry.
 */
export class BasicItemMeshes implements ItemMeshFactory {
  private matCache = new Map<string, THREE.Material>();
  private glowTex: THREE.Texture | null = null;

  constructor(public skins: Record<string, ItemSkinDef> = {}) {}

  private mat(color: string, emissive = 0): THREE.MeshStandardMaterial {
    const key = `${color}:${emissive}`;
    let m = this.matCache.get(key) as THREE.MeshStandardMaterial | undefined;
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.45 });
      if (emissive > 0) { m.emissive = new THREE.Color(color); m.emissiveIntensity = emissive; }
      this.matCache.set(key, m);
    }
    return m;
  }

  /** Soft radial sprite texture for the rarity glow (best-effort: ring-only if canvas is stubbed). */
  private glowSprite(glow: string): THREE.Object3D | null {
    try {
      if (!this.glowTex) {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const ctx = c.getContext('2d') as CanvasRenderingContext2D;
        const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
        g.addColorStop(0, 'rgba(255,255,255,0.85)');
        g.addColorStop(0.45, 'rgba(255,255,255,0.28)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 64);
        this.glowTex = new THREE.CanvasTexture(c);
      }
      const sm = new THREE.SpriteMaterial({
        map: this.glowTex, color: glow, transparent: true, opacity: 0.55,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const s = new THREE.Sprite(sm);
      s.scale.setScalar(0.9);
      return s;
    } catch {
      return null;
    }
  }

  meshFor(def: ItemDef): THREE.Object3D {
    const g = new THREE.Group();
    const rarity = def.rarity ?? 'common';
    const glow = RARITY_GLOW[rarity];
    const variant = nameHash(def.name);
    // custom skin tint: palette.primary overrides the main material color
    const skin = def.skin ? this.skins[def.skin] : undefined;
    const tint = skin?.palette?.primary;

    const build = (mesh: THREE.Mesh, x = 0, y = 0, z = 0) => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };

    switch (def.type) {
      case 'weapon': {
        // blade / guard / pommel
        const bladeLen = 0.75 + (variant % 3) * 0.08;
        build(new THREE.Mesh(new THREE.BoxGeometry(bladeLen, 0.07, 0.16), this.mat(tint ?? '#c8ccd4', 0.25)), bladeLen / 2 + 0.1, 0, 0);
        build(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), this.mat('#5a3d22')), 0.06, 0, 0); // guard
        build(new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), this.mat(tint ?? '#8a8f99', 0.4)), -0.04, 0, 0); // pommel
        build(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 8), this.mat('#3a2a18')), 0, 0, 0).rotation.z = Math.PI / 2;
        g.rotation.z = Math.PI / 2; // present blades upright
        break;
      }
      case 'armor': {
        // breastplate: curved-ish plate + trim
        build(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.5, 0.14), this.mat(tint ?? '#7d8590', 0.15)), 0, 0, 0);
        build(new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.08, 0.18), this.mat(skin?.palette?.secondary ?? '#4a3d22')), 0, 0.22, 0);
        build(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.05), this.mat(glow, 1.2)), 0, 0.05, 0.09); // sigil
        break;
      }
      case 'consumable': {
        // flask: body + neck + stopper
        build(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.42, 12), this.mat(tint ?? '#3fa7ff', 0.55)), 0, -0.05, 0);
        build(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.2, 10), this.mat('#c8ccd4')), 0, 0.26, 0);
        build(new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), this.mat('#5a3d22')), 0, 0.4, 0);
        break;
      }
      case 'material': {
        if (variant % 2 === 0) {
          // crystal: stretched octahedron
          const c = build(new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), this.mat(tint ?? '#7af7ff', 0.9)), 0, 0, 0);
          c.scale.y = 1.6;
        } else {
          // ingot
          build(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.24), this.mat(tint ?? '#c9963c', 0.35)), 0, 0, 0);
          build(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.18), this.mat(tint ?? '#c9963c', 0.35)), 0, 0.13, 0);
        }
        break;
      }
      case 'key': {
        // ring + stem + teeth
        const ring = build(new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.045, 8, 16), this.mat(tint ?? '#c9963c', 0.5)), -0.22, 0.12, 0);
        void ring;
        const stem = build(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.07, 0.07), this.mat(tint ?? '#c9963c', 0.5)), 0.06, 0.12, 0);
        void stem;
        build(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.07), this.mat(tint ?? '#c9963c', 0.5)), 0.2, 0.06, 0);
        build(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.07), this.mat(tint ?? '#c9963c', 0.5)), 0.1, 0.08, 0);
        break;
      }
      default: {
        // trinket: small gem
        build(new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 0), this.mat(tint ?? glow, 1.1)), 0, 0, 0);
        break;
      }
    }

    // rarity glow ring at the base (always) + sprite puff for uncommon+
    const ringGeo = new THREE.TorusGeometry(0.34, 0.035, 8, 24);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.85 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.42;
    g.add(ring);
    if (RARITY_IDX[rarity] >= 1) {
      const sprite = this.glowSprite(glow);
      if (sprite) { sprite.position.y = 0.1; g.add(sprite); }
    }
    return g;
  }
}

// ---------------------------------------------------------------------------
// ItemWorld
// ---------------------------------------------------------------------------

export class ItemWorld {
  private items: WorldItem[] = [];
  private chests: Chest[] = [];
  /** Fired when a world item is collected: (itemId, count). */
  /**
   * Interaction surface (roadmap Priority 2, next wave builds the system).
   * Chests register as Interactables here; the shape is the contract, the
   * discovery/activation policy stays with the future InteractionSystem.
   */
  readonly interactions = new InteractionRegistry();
  private nextChestId = 0;

  onPickup: (itemId: string, count: number) => void = () => {};
  /**
   * Physics wave (breakables): additive hook fired from damageChest with
   * (chest, hpBefore). Breakables.wireChest sets this to layer the
   * intact→damaged→collapsed states + fragment FX over the existing smash.
   */
  onChestDamaged: ((chest: Chest, hpBefore: number) => void) | null = null;
  /** Last player position seen by update() — anchor for overflow re-drops. */
  readonly playerAnchor = new THREE.Vector3();

  private t = 0;
  private rng: Rng;
  private itemMat: CANNON.Material;

  constructor(
    private engine: Engine,
    private defs: Record<string, ItemDef>,
    private factory: ItemMeshFactory = new BasicItemMeshes(),
    private chestSkins: Record<string, ItemSkinDef> = {},
  ) {
    // Fork the run rng so item sim draws are deterministic yet independent of
    // whatever the engine/blueprint drew before us.
    this.rng = engine.rng.fork(0x17a1);
    this.itemMat = new CANNON.Material('item');
    engine.physics.world.addContactMaterial(new CANNON.ContactMaterial(
      this.itemMat, engine.physics.defaultMat, { friction: 0.45, restitution: 0.35 }));
  }

  // ---------------- spawning ----------------

  private requireDef(id: string): ItemDef {
    const def = this.defs[id];
    if (!def) throw new Error(`[ItemWorld] unknown item id "${id}" (not in custom.items.defs)`);
    return def;
  }

  private makeItem(id: string, def: ItemDef, pos: THREE.Vector3, count: number): WorldItem {
    const mesh = this.factory.meshFor(def);
    mesh.position.copy(pos);
    mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    this.engine.scene.add(mesh);
    return {
      id, def, count, mesh,
      body: null, mode: 'presentation', taken: false,
      baseY: pos.y,
      phase: this.rng.range(0, Math.PI * 2),
      spin: this.rng.range(1.2, 2.6),
      shimmerT: this.rng.range(0.2, 0.9),
      stillT: 0,
      closeT: 0,
    };
  }

  /** Fixed loot placement from custom.items.loot — presentation mode (bob+spin), no body. */
  spawnLoot(spot: ItemLootSpot): WorldItem {
    const def = this.requireDef(spot.item);
    const item = this.makeItem(spot.item, def, new THREE.Vector3(spot.pos[0], spot.pos[1], spot.pos[2]), spot.count ?? 1);
    this.items.push(item);
    return item;
  }

  /**
   * Physics wave (terrain-aware placement): loot placement through the
   * generator→physics contract — ground-clamped, constraint-checked
   * (no deep water / out of bounds), surface id reported on the item.
   * Returns null when the spot is rejected (caller picks another spot).
   * The plain spawnLoot path keeps its exact behavior.
   */
  spawnLootGrounded(spot: ItemLootSpot): WorldItem | null {
    const terr = this.engine.terrain as unknown as PlacementTerrain | undefined;
    if (!terr || typeof terr.heightAt !== 'function') return this.spawnLoot(spot);
    const r = sampleChecked(terr, spot.pos[0], spot.pos[2], { maxWaterDepth: 0.4 });
    if (!r.ok || !r.sample) return null;
    const s = r.sample;
    const item = this.spawnLoot({
      ...spot,
      pos: [s.x, s.groundY + 0.5, s.z],
    });
    (item as WorldItem & { surfaceId?: string }).surfaceId = s.surfaceId;
    return item;
  }

  /**
>>>>>>> origin/feature/inv-physics
   * Thrown/dropped item — a REAL cannon-es body (mass ~0.5, restitution ~0.35,
   * sleep enabled) that bounces, rolls and settles. When the body sleeps it
   * is swapped to presentation mode (bob+spin, no body).
   */
  drop(itemId: string, pos: THREE.Vector3, vel?: THREE.Vector3, count = 1): WorldItem {
    const def = this.requireDef(itemId);
    const item = this.makeItem(itemId, def, pos, count);
    const sc = shapeFor(def);
    const p = this.engine.physics;
    const opts = {
      mass: 0.5, group: GROUP.PICKUP,
      mask: GROUP.WORLD | GROUP.PLAYER | GROUP.PICKUP,
      material: this.itemMat,
    };
    const body = sc.kind === 'sphere'
      ? p.sphere(sc.radius, pos, opts)
      : p.box(new THREE.Vector3(sc.extents[0], sc.extents[1], sc.extents[2]), pos, opts);
    body.allowSleep = true;
    body.sleepSpeedLimit = 0.3;
    body.sleepTimeLimit = 0.5;
    body.linearDamping = 0.1;
    body.angularDamping = 0.5; // spheres stop rolling quickly
    if (vel) {
      body.velocity.set(vel.x, vel.y, vel.z);
    } else {
      // small deterministic pop so drops never land in a perfect stack
      body.velocity.set(this.rng.range(-1.2, 1.2), this.rng.range(1.0, 2.6), this.rng.range(-1.2, 1.2));
      body.angularVelocity.set(this.rng.range(-4, 4), this.rng.range(-4, 4), this.rng.range(-4, 4));
    }
    item.body = body;
    item.mode = 'physics';
    this.items.push(item);
    return item;
  }

  /** Static heavy-box chest + hinged lid at the def position. */
  spawnChest(def: ItemChestDef): Chest {
    for (const id of def.loot) this.requireDef(id);
    const pos = new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2]);
    const skin = def.skin ? this.chestSkins[def.skin] : undefined;
    const wood = skin?.palette?.primary ?? '#6b4a2a';
    const trim = skin?.palette?.secondary ?? '#3d2c18';
    const glowC = skin?.palette?.glow;

    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: wood, roughness: 0.8, metalness: 0.1 });
    const trimMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.6, metalness: 0.5 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.55, 0.8), bodyMat);
    base.position.y = 0.275;
    base.castShadow = true;
    group.add(base);
    for (const bx of [-0.4, 0.4]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.57, 0.82), trimMat);
      band.position.set(bx, 0.275, 0);
      group.add(band);
    }
    // lid pivots on the back edge
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0.55, -0.4);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.22, 0.8), bodyMat);
    lid.position.set(0, 0.11, 0.4);
    lid.castShadow = true;
    lidPivot.add(lid);
    group.add(lidPivot);
    // lock plate (glows when locked)
    const locked = def.locked ?? false;
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.26, 0.06),
      locked
        ? new THREE.MeshStandardMaterial({ color: '#ff5544', emissive: '#ff2200', emissiveIntensity: 1.4 })
        : new THREE.MeshStandardMaterial({ color: glowC ?? '#c9963c', roughness: 0.4, metalness: 0.7 }),
    );
    plate.position.set(0, 0.42, 0.42);
    group.add(plate);

    group.position.copy(pos);
    this.engine.scene.add(group);

    const body = this.engine.physics.box(
      new THREE.Vector3(1.15, 0.8, 0.8),
      new THREE.Vector3(pos.x, pos.y + 0.4, pos.z),
      { mass: 0, group: GROUP.WORLD },
    );

    const chest: Chest = {
      id: `chest-${this.nextChestId++}`,
      def, group, lid: lidPivot, lidTarget: 0, body,
      hp: CHEST_HP, opened: false, broken: false, locked,
      center: new THREE.Vector3(pos.x, pos.y + 0.45, pos.z),
    };
    this.chests.push(chest);
    this.interactions.register(this.chestInteractable(chest));
    return chest;
  }

  /**
   * Physics wave (terrain-aware placement): chest placement through the
   * generator→physics contract — ground-clamped, rejected on steep slopes /
   * deep water / out of bounds (returns null so the generator can re-roll).
   */
  spawnChestGrounded(def: ItemChestDef): Chest | null {
    const terr = this.engine.terrain as unknown as PlacementTerrain | undefined;
    if (!terr || typeof terr.heightAt !== 'function') return this.spawnChest(def);
    const r = sampleChecked(terr, def.pos[0], def.pos[2], { maxSlope: 0.5, maxWaterDepth: 0.25 });
    if (!r.ok || !r.sample) return null;
    const s = r.sample;
    return this.spawnChest({ ...def, pos: [s.x, s.groundY, s.z] });
  }

  // ---------------- interaction (roadmap Priority 2 contracts) ----------------

  /** This chest as an Interactable (id/type/position/radius/enabled/prompt). */
  chestInteractable(c: Chest): Interactable {
    return {
      id: c.id,
      type: 'chest',
      position: c.center.clone(),
      radius: CHEST_INTERACT_RADIUS,
      enabled: !c.opened && !c.broken && !c.locked,
      prompt: c.locked ? 'Locked chest' : 'Open chest',
      produces: [...c.def.loot],
    };
  }

  /** All currently registered interactables (chests today; doors/switches tomorrow). */
  interactables(): Interactable[] {
    return this.interactions.near(new THREE.Vector3(0, 0, 0), 1e9);
  }

  /**
   * Activate an interactable by id. Routes by type; returns produced ids
   * (loot) or null when unknown/disabled. The future InteractionSystem
   * calls this; today the blueprint key handler does.
   */
  activateInteractable(id: string): string[] | null {
    const c = this.chests.find((x) => x.id === id);
    if (!c || c.opened || c.broken || c.locked) return null;
    const loot = this.openChest(c);
    this.interactions.events.onActivate?.(this.chestInteractable(c));
    return loot;
  }

  /** Refresh a chest's registered Interactable after a state change. */
  private syncChestInteractable(c: Chest): void {
    this.interactions.register(this.chestInteractable(c));
  }

  /** Nearest unopened, unlocked chest within interact radius, or null. */
  tryInteract(playerPos: THREE.Vector3): Chest | null {
    let best: Chest | null = null;
    let bestD = CHEST_INTERACT_RADIUS;
    for (const c of this.chests) {
      if (c.opened || c.broken || c.locked) continue;
      const d = c.center.distanceTo(playerPos);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /**
   * Open a chest: marks it opened, swings the lid, bursts debris, and spills
   * its loot as physics drops. Returns the loot ids (for toasts/achievements —
   * the actual inventory add flows through onPickup when drops are collected).
   */
  openChest(chest: Chest): string[] {
    if (chest.opened || chest.broken || chest.locked) return [];
    chest.opened = true;
    chest.lidTarget = -1.85;
    this.syncChestInteractable(chest);
    this.engine.particles.burst(chest.center, {
      count: 26, color: '#9a7b4f', color2: '#5d4527', speed: 3.4, life: 0.9,
      size: 2.0, gravity: 3, up: 3, blending: 'normal', grow: 1.2,
    });
    this.engine.particles.magic(chest.center, '#ffd23f', 14);
    this.spillLoot(chest);
    return [...chest.def.loot];
  }

  /**
   * Smashable chests: melee/projectile wiring (another crew) calls this.
   * At 0 hp the chest breaks — debris burst, loot spills like openChest.
   */
  damageChest(chest: Chest, n: number) {
    if (chest.opened || chest.broken) return;
    const hpBefore = chest.hp;
    chest.hp -= n;
    // physics wave: breakables layer intact→damaged→collapsed FX on top
    this.onChestDamaged?.(chest, hpBefore);
    this.engine.particles.burst(chest.center, {
      count: 8, color: '#9a7b4f', color2: '#5d4527', speed: 2.4, life: 0.6,
      size: 1.6, gravity: 4, up: 2, blending: 'normal',
    });
    if (chest.hp > 0) return;
    chest.broken = true;
    chest.opened = true;
    this.syncChestInteractable(chest);
    if (chest.body) { this.engine.physics.remove(chest.body); chest.body = null; }
    // squash + tip the wreck
    chest.group.scale.y = 0.35;
    chest.group.rotation.z = 0.35;
    chest.group.rotation.x = -0.2;
    this.engine.particles.burst(chest.center, {
      count: 40, color: '#9a7b4f', color2: '#4a3520', speed: 5, life: 1.1,
      size: 2.4, gravity: 4, up: 3.5, blending: 'normal', grow: 1.3,
    });
    this.engine.particles.magic(chest.center, '#ffd23f', 18);
    this.spillLoot(chest);
  }

  private spillLoot(chest: Chest) {
    for (const id of chest.def.loot) {
      const dir = new THREE.Vector3(
        this.rng.range(-1, 1), 0, this.rng.range(-1, 1)).normalize();
      const vel = new THREE.Vector3(
        dir.x * this.rng.range(1.5, 3.5),
        this.rng.range(3.5, 5.5),
        dir.z * this.rng.range(1.5, 3.5),
      );
      this.drop(id, chest.center.clone().add(new THREE.Vector3(0, 0.3, 0)), vel);
    }
  }

  // ---------------- per-frame ----------------

  private collect(item: WorldItem) {
    if (item.taken) return;
    item.taken = true;
    const pos = item.mesh.position.clone();
    this.engine.particles.magic(pos, RARITY_GLOW[item.def.rarity ?? 'common'], 10);
    this.engine.scene.remove(item.mesh);
    disposeObject(item.mesh);
    if (item.body) { this.engine.physics.remove(item.body); item.body = null; }
    this.engine.hooks.emit('onPickup', { pickup: item as never });
    this.onPickup(item.id, item.count);
  }

  /** Magnet pull for a tumbling body: steer its velocity at the player. */
  private pullBody(item: WorldItem, playerPos: THREE.Vector3) {
    const b = item.body!;
    b.wakeUp();
    _v1.copy(playerPos); _v1.y += 0.7;
    _v1.x -= b.position.x; _v1.y -= b.position.y; _v1.z -= b.position.z;
    const dist = _v1.length();
    if (dist < 1e-3) return;
    _v1.multiplyScalar(1 / dist);
    const speed = Math.min(14, 6 + dist * 4);
    b.velocity.set(_v1.x * speed, _v1.y * speed, _v1.z * speed);
  }

  update(dt: number, playerPos: THREE.Vector3) {
    this.t += dt;
    this.playerAnchor.copy(playerPos);
    const quality = this.engine.effectiveQuality();
    const shimmerCap = quality === 'high' ? 8 : quality === 'standard' ? 4 : 0;
    let shimmers = 0;
    let collected = false;

    for (const item of this.items) {
      if (item.taken) continue;
      const d = item.mesh.position.distanceTo(playerPos);

      if (item.mode === 'physics' && item.body) {
        // anti-tunnel: small fast bodies can pierce the heightfield between
        // fixed steps — clamp back to the surface instead of falling forever.
        const terr = this.engine.terrain;
        if (terr) {
          const sc = shapeFor(item.def);
          const halfH = sc.kind === 'sphere' ? sc.radius : sc.extents[1] / 2;
          const gy = terr.heightAt(item.body.position.x, item.body.position.z) + halfH;
          if (item.body.position.y < gy - 0.25) {
            item.body.position.y = gy;
            if (item.body.velocity.y < 0) item.body.velocity.y = 0;
            item.body.angularVelocity.scale(0.5, item.body.angularVelocity);
          }
        }
        // physics wave: buoyancy — items bob/float instead of sinking.
        // applyBuoyancy returns true when the body touched water this step;
        // floating bodies never take the settle path below.
        let floating = false;
        const wlvl = terr?.waterLevelAt?.(item.body.position.x, item.body.position.z) ?? null;
        if (wlvl !== null) {
          const sc = shapeFor(item.def);
          floating = applyBuoyancy(
            item.body, wlvl, sc.radius, dt,
            this.engine.physics.world.gravity.y, item.phase, this.t,
          );
        }
        this.engine.physics.syncMeshInterpolated(item.mesh, item.body);
        if (d < MAGNET_RADIUS) this.pullBody(item, playerPos);
        // cannon sleep normally fires first; the stillT fallback guarantees
        // the transition even for long-rolling spheres on flat ground.
        const spd = item.body.velocity.length();
        const asp = item.body.angularVelocity.length();
        if (spd < 0.3 && asp < 0.6) item.stillT += dt; else item.stillT = 0;
        // physics wave: floating items keep bobbing in physics mode — the
        // settle→presentation path is for dry ground only.
        if (!floating && (item.body.sleepState === CANNON.Body.SLEEPING || item.stillT > 0.75)) {
          if (item.body.sleepState !== CANNON.Body.SLEEPING) item.body.sleep();
          // settled → presentation mode (bob+spin, no body)
          this.engine.physics.remove(item.body);
          item.body = null;
          item.mode = 'presentation';
          item.baseY = item.mesh.position.y;
          item.shimmerT = this.rng.range(0.2, 0.9);
        }
      } else {
        // presentation: bob + spin
        item.mesh.position.y = item.baseY + Math.sin(this.t * 2.4 + item.phase) * HOVER_BOB;
        item.mesh.rotation.y = this.t * item.spin + item.phase;
        if (d < MAGNET_RADIUS) {
          _v1.copy(playerPos); _v1.y += 0.7;
          item.mesh.position.lerp(_v1, 1 - Math.pow(0.002, dt));
          item.baseY = item.mesh.position.y;
        }
        // rarity glow + particle shimmer for rare+ (budgeted by quality tier)
        if (shimmers < shimmerCap && RARITY_IDX[item.def.rarity ?? 'common'] >= 2) {
          item.shimmerT -= dt;
          if (item.shimmerT <= 0) {
            item.shimmerT = quality === 'high' ? this.rng.range(0.35, 0.7) : this.rng.range(0.7, 1.2);
            this.engine.particles.magic(item.mesh.position, RARITY_GLOW[item.def.rarity ?? 'common'], quality === 'high' ? 4 : 2);
            shimmers++;
          }
        }
      }

      // grace collect: an item stuck hovering just out of reach (e.g. resting
      // on the player's capsule, held off by collision) is collected after
      // lingering in near range — it can never be picked up otherwise.
      if (d < COLLECT_RADIUS + 0.5) item.closeT += dt; else item.closeT = 0;
      if (d < COLLECT_RADIUS || item.closeT > 0.8) {
        this.collect(item);
        collected = true;
      }
    }
    if (collected) {
      const live = this.items.filter((i) => !i.taken);
      this.items.length = 0;
      this.items.push(...live);
    }

    // chest lid swing
    for (const c of this.chests) {
      if (c.broken) continue;
      const cur = c.lid.rotation.x;
      if (Math.abs(cur - c.lidTarget) > 0.005) {
        c.lid.rotation.x = cur + (c.lidTarget - cur) * Math.min(1, dt * 6);
      }
    }
  }

  // ---------------- teardown ----------------

  dispose() {
    for (const item of this.items) {
      if (item.body) { this.engine.physics.remove(item.body); item.body = null; }
      this.engine.scene.remove(item.mesh);
      disposeObject(item.mesh);
    }
    this.items.length = 0;
    for (const c of this.chests) {
      if (c.body) { this.engine.physics.remove(c.body); c.body = null; }
      this.engine.scene.remove(c.group);
      c.group.traverse((o) => { (o as THREE.Mesh).geometry?.dispose(); });
    }
    this.chests.length = 0;
  }

  /** Live items (test/debug). */
  get liveItems(): readonly WorldItem[] { return this.items; }
  /** Live chests (test/debug). */
  get liveChests(): readonly Chest[] { return this.chests; }
}

const _v1 = new THREE.Vector3();
