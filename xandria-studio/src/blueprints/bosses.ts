/**
 * Boss-fights wave: blueprint wiring helper shared by the combat
 * blueprints (tpAction, fpsArena, topdown).
 *
 * Registers the BossEncounter as a map-local entity system (id 'boss'),
 * spawns it for the boot map (portals contract: meta.seed IS this map's
 * build seed), and owns the BossBar DOM component. The blueprint ticks
 * `encounter.update(dt, playerPos)` after its enemies/variants update and
 * returns the encounter so the test seam can reach it.
 */
import * as THREE from 'three';
import type { Engine } from '../engine/Engine';
import type { GameSpec } from '@spec';
import type { EnemyManager } from '../engine/game/EnemyAI';
import { BossEncounter } from '../engine/game/bosses';
import { BossBar } from '../engine/ui/BossBar';

export interface BossWiring {
  encounter: BossEncounter;
  bar: BossBar;
}

export interface BossWiringOpts {
  manager: EnemyManager;
  terrain: { heightAt(x: number, z: number): number };
  onPlayerHit: (damage: number, from: THREE.Vector3) => void;
}

export function wireBossFights(engine: Engine, spec: GameSpec, opts: BossWiringOpts): BossWiring {
  const bar = new BossBar(engine.container);
  const encounter = new BossEncounter(engine, {
    manager: opts.manager,
    terrain: opts.terrain,
    onPlayerHit: opts.onPlayerHit,
    bar,
  });
  engine.portalEntities.register(encounter);
  encounter.spawnForMap(spec.meta.seed); // portals contract: meta.seed IS this map's build seed
  return { encounter, bar };
}
