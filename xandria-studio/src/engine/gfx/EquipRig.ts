/**
 * EquipRig (inventory wave) — attach procedural item meshes to a CharacterRig.
 *
 * Slot → pivot mapping (the shared contract):
 *  - weapon    → rig.limbs.weaponMount (armR shoulder)
 *  - head      → rig.limbs.head
 *  - torso     → rig.limbs.torso
 *  - legs      → rig.group (feet origin; greaves are built feet-relative)
 *  - accessory → rig.limbs.torso, rear (-Z, the back)
 *
 * Mount offsets are authored for the standard archetype (~1.8 m, bulk 1):
 * weaponMount is the shoulder pivot, so the weapon hangs at the fist:
 *   position (0, -0.60, 0.06), rotation.x = π/2 − 0.35 (blade forward, tipped up).
 * Attachments inherit rig.group.scale (the height multiplier), so tall/short
 * rigs scale their gear automatically. Bulk is NOT reflected in group scale,
 * so on brute archetypes (bulk ×1.32) head/torso gear sits ~10–30% inset —
 * documented approximation, visually acceptable at PS2 poly counts.
 *
 * Re-equip replaces cleanly: the old mesh is removed and disposed
 * (disposeOwned — geometries + owned materials; shared library materials are
 * never touched). All three entry points never throw.
 */
import * as THREE from 'three';
import type { EquipSlot, ItemDef } from '@spec';
import { disposeOwned, type CharacterRig } from './Characters';
import { meshFor } from './ItemModels';

const equipped = new WeakMap<CharacterRig, Map<EquipSlot, THREE.Object3D>>();

function equippedMap(rig: CharacterRig): Map<EquipSlot, THREE.Object3D> {
  let m = equipped.get(rig);
  if (!m) {
    m = new Map();
    equipped.set(rig, m);
  }
  return m;
}

/** The mesh currently equipped in a slot, if any. */
export function equippedMesh(rig: CharacterRig, slot: EquipSlot): THREE.Object3D | undefined {
  return equipped.get(rig)?.get(slot);
}

/** Where a slot's item mesh mounts, plus its local offset (see header for the approximations). */
function mountFor(rig: CharacterRig, slot: EquipSlot, itemKind: string): { parent: THREE.Object3D; pos: THREE.Vector3; rot?: THREE.Euler; scale?: number } | null {
  const L = rig.limbs;
  switch (slot) {
    case 'weapon': {
      const parent = L.weaponMount ?? L.armR;
      if (!parent) return null;
      return { parent, pos: new THREE.Vector3(0, -0.60, 0.06), rot: new THREE.Euler(Math.PI / 2 - 0.35, 0, 0) };
    }
    case 'head': {
      if (!L.head) return null;
      return { parent: L.head, pos: new THREE.Vector3(0, 0.02, 0) };
    }
    case 'torso': {
      if (!L.torso) return null;
      return { parent: L.torso, pos: new THREE.Vector3(0, 0, 0) };
    }
    case 'legs': {
      // greaves are authored feet-relative; they mount on the rig root (feet at origin)
      return { parent: rig.group, pos: new THREE.Vector3(0, 0, 0) };
    }
    case 'accessory': {
      if (!L.torso) return null;
      // shields are authored at the torso rear already; small trinkets ride on the back
      return itemKind === 'shield'
        ? { parent: L.torso, pos: new THREE.Vector3(0, 0, 0) }
        : { parent: L.torso, pos: new THREE.Vector3(0, 0.05, -0.32), scale: 0.55 };
    }
  }
}

/**
 * Equip an item into a slot. Re-equip replaces the old mesh cleanly
 * (removed + disposed). Returns the mounted mesh, or null when the rig
 * lacks the pivot (imported GLB rigs without a matching node). Never throws.
 */
export function equip(rig: CharacterRig, slot: EquipSlot, def: ItemDef): THREE.Object3D | null {
  try {
    if (!rig || !slot || !def) return null;
    unequip(rig, slot); // replace cleanly
    const mesh = meshFor(def);
    const mount = mountFor(rig, slot, String(mesh.userData.itemKind ?? ''));
    if (!mount) return null;
    mesh.position.copy(mount.pos);
    if (mount.rot) mesh.rotation.copy(mount.rot);
    if (mount.scale !== undefined) mesh.scale.setScalar(mount.scale);
    mount.parent.add(mesh);
    equippedMap(rig).set(slot, mesh);
    return mesh;
  } catch {
    return null;
  }
}

/** Unequip a slot: remove the mesh and dispose its GPU resources. Never throws. */
export function unequip(rig: CharacterRig, slot: EquipSlot): void {
  try {
    const map = equipped.get(rig);
    const mesh = map?.get(slot);
    if (!mesh) return;
    mesh.parent?.remove(mesh);
    disposeOwned(mesh);
    map!.delete(slot);
  } catch { /* unequip is a no-op on failure */ }
}

/** Unequip every slot. Never throws. */
export function clear(rig: CharacterRig): void {
  try {
    const map = equipped.get(rig);
    if (!map) return;
    for (const slot of [...map.keys()]) unequip(rig, slot);
  } catch { /* clear is a no-op on failure */ }
}
