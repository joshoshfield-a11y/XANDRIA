/**
 * wireItems — blueprint integration seam for the item system.
 *
 * Reads `spec.custom.items` and builds an ItemWorld: fixed loot placements,
 * chests, and starting-inventory feed. Returns null when the spec has no
 * item tables, so blueprints can skip the whole system with one call.
 */
import * as THREE from 'three';
import type { Engine } from '../../Engine';
import type { GameSpec } from '../../../spec/schema';
import { BasicItemMeshes, ItemWorld, type InventoryLike, type ItemMeshFactory } from './ItemWorld';

// Re-export the shared contracts so every crew imports them from one place.
export { RARITY_GLOW } from './ItemWorld';
export type { ItemMeshFactory, InventoryLike, WorldItem, Chest } from './ItemWorld';

/**
 * Build the item world for a spec.
 *
 * - null when `spec.custom.items` is absent (system disabled)
 * - spawns every `loot` spot and `chests` entry
 * - feeds `starting` into the inventory (ids must exist in defs)
 * - wires `onPickup` → inventory.add; overflow that doesn't fit is re-dropped
 *   at the player's last known position so nothing is silently lost
 */
export function wireItems(engine: Engine, spec: GameSpec, inventory: InventoryLike, meshFactory?: ItemMeshFactory): ItemWorld | null {
  const items = spec.custom?.items;
  if (!items) return null;

  const defs = items.defs ?? {};
  const world = new ItemWorld(engine, defs, meshFactory ?? new BasicItemMeshes(items.skins ?? {}), items.skins ?? {});

  for (const spot of items.loot ?? []) world.spawnLoot(spot);
  for (const cdef of items.chests ?? []) world.spawnChest(cdef);

  for (const id of items.starting ?? []) {
    if (!defs[id]) throw new Error(`[wireItems] starting item "${id}" is not in custom.items.defs`);
    const left = inventory.add(id, 1);
    if (left > 0) world.drop(id, world.playerAnchor.clone().add(new THREE.Vector3(0, 1, 0)), undefined, left);
  }

  world.onPickup = (itemId, count) => {
    const left = inventory.add(itemId, count);
    if (left > 0) {
      // inventory full — re-drop the overflow at the player's feet
      world.drop(itemId, world.playerAnchor.clone().add(new THREE.Vector3(0, 1, 0)), undefined, left);
    }
  };

  return world;
}
