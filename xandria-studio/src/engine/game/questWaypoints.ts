/**
 * XANDRIA upgrade loop (quest-waypoints): quest objective waypoints + compass.
 *
 * Observe-only: this system never writes gameplay state. It reads the
 * player-scoped QuestManager (the quest system + minimap-fog layer) and
 * presents the tracked objective's world position three ways:
 *   1. an in-world beacon (two 1-instance InstancedMeshes on the shared
 *      voxel geometry cache — see below for why it is NOT an
 *      NpcInstancer bucket),
 *   2. a minimap marker (wired into Minimap.redraw, fog rules respected),
 *   3. an off-screen edge compass indicator (DOM, bucketed updates).
 *
 * Tracked objective: the FIRST 'active' quest in roster order (the story
 * line comes before side quests in the pool, so the story quest is the
 * tracked one while it is active) and its FIRST incomplete objective.
 * A quest in 'complete' status has NO waypoint (brief: the waypoint
 * clears on quest completion — the turn-in target is the dialogue, not
 * a marker). When the tracked quest changes (accept / turn-in / abandon
 * of a radiant quest), the waypoint switches on the next scan tick.
 *
 * Position resolution (resolveQuestWaypoint, pure given a world view):
 *   kill    — nearest ALIVE enemy whose spec.kind === target
 *   gather  — nearest live (not depleted/retired) gathering node whose
 *             material matches target ('any' = nearest node of any kind)
 *   craft   — nearest station matching the recipe's stationId (any
 *             station when the recipe is station-free / unknown)
 *   talk    — nearest live NPC whose role matches target ('any' = nearest)
 *   explore — nearest portal exit (map mid-edge); 'maps'/'biomes' targets
 *             resolve the same way — leaving the map is how they advance
 * Nearest = XZ distance, roster order breaks ties (deterministic).
 * No candidate on the current map = NO waypoint (honest absence, never
 * a marker at a stale or invented position). Portal travel re-resolves
 * from the new map's live roster, so the tracked waypoint survives the
 * trip with the quest (quest state is player-scoped; the position is
 * re-derived, never carried across maps).
 *
 * Why the beacon is its own InstancedMesh pair, not an NpcInstancer
 * bucket: the instancer's frame is driven by the blueprints
 * (beginFrame/submit/endFrame around the manager updates, one frame per
 * blueprint). A frame-independent observer submitting from an onTick tap
 * would land outside that window and never publish (beginFrame zeroes
 * counts, endFrame publishes). Joining the frame in all four main
 * blueprints + variants for ONE marker would be invasive for zero
 * gameplay gain. Instead the beacon is two InstancedMeshes of capacity
 * 1 sharing the gathering/station voxel geometry cache (identical dims
 * = identical geometry object) and the existing amber glow role
 * (#ffb545) — 2 draw calls, matrix rewritten only on scan ticks when
 * the resolved position actually moved. No per-frame work.
 *
 * Perf contract: re-resolution runs at most every SCAN_INTERVAL_S of
 * game time; the compass DOM is rewritten only when its angle/distance/
 * visibility bucket changes; the beacon matrix is rewritten only when
 * the resolved position moved >1m or the waypoint identity changed.
 * When idle (no waypoint, or player + camera still) a tick is a few
 * property reads and returns.
 *
 * Determinism: seeded RNG only — and in fact NO RNG at all here.
 * Positions derive from existing seeded quest/objective data and live
 * roster state. The beacon's slow spin is visual only (engine time),
 * never feeds gameplay.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { QuestDef, QuestManager, QuestObjectiveDef, QuestStatus } from './quests';
import { buildRecipePool } from './crafting';
import { MATERIAL_IDS } from './gathering';
import { voxelBoxCacheFor } from './voxelGeo';
import { amberGlowMaterial, AMBER } from '../gfx/AmberGlow';

/** Throttle for re-resolution (seconds of game time, minimap-scan parity). */
export const WAYPOINT_SCAN_INTERVAL_S = 0.5;
/** Beacon matrix rewrite deadband (m) — wandering targets don't churn it. */
export const WAYPOINT_MOVE_EPS_M = 1;
/** Compass angle bucket (deg) / distance bucket (m) — DOM writes only on change. */
export const COMPASS_ANGLE_BUCKET_DEG = 4;
export const COMPASS_DISTANCE_BUCKET_M = 5;

export interface QuestWaypoint {
  questId: string;
  questName: string;
  objective: QuestObjectiveDef;
  /** world position of the objective target (ground/body position) */
  position: { x: number; y: number; z: number };
}

/** Minimal structural view of a QuestManager (unit tests use fakes). */
export interface QuestManagerLike {
  defs: QuestDef[];
  statusOf(id: string): QuestStatus | 'unknown';
  progressOf(id: string): number[];
}

export interface WaypointWorldEntity {
  position: { x: number; y: number; z: number };
}

export interface WaypointWorld {
  playerPos: { x: number; y: number; z: number };
  enemies: Array<WaypointWorldEntity & { kind: string; alive: boolean }>;
  npcs: Array<WaypointWorldEntity & { role: string; alive: boolean }>;
  nodes: Array<WaypointWorldEntity & { materialId: string; depleted: boolean }>;
  stations: Array<WaypointWorldEntity & { stationId: string }>;
  portalExits: Array<{ x: number; y: number; z: number }>;
  /** station id a recipe requires, or undefined when station-free/unknown */
  recipeStation: (recipeId: string) => string | undefined;
}

/**
 * The tracked objective: first 'active' quest in roster order, first
 * objective whose progress is below its count. Null when no quest is
 * active or every objective of the active quest is done (the quest is
 * then 'complete' — waypoint clears per the brief).
 */
export function trackedObjective(
  manager: QuestManagerLike,
): { def: QuestDef; objective: QuestObjectiveDef; index: number } | null {
  for (const def of manager.defs) {
    if (manager.statusOf(def.id) !== 'active') continue;
    const progress = manager.progressOf(def.id);
    for (let i = 0; i < def.objectives.length; i++) {
      const p = progress[i] ?? 0;
      if (p < def.objectives[i].count) return { def, objective: def.objectives[i], index: i };
    }
    // Active but fully progressed: the manager flips it to 'complete'
    // on the next event; until then there is nothing left to point at.
    return null;
  }
  return null;
}

function nearestXZ<T extends WaypointWorldEntity>(
  px: number,
  pz: number,
  cands: readonly T[],
): T | null {
  let best: T | null = null;
  let bd = Infinity;
  for (const c of cands) {
    const dx = c.position.x - px;
    const dz = c.position.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) {
      bd = d2;
      best = c;
    }
  }
  return best;
}

/**
 * Resolve the tracked objective to a world position. Pure given the
 * world view: same (manager state, world) -> same waypoint. Null =
 * tracked objective exists but has no live target on this map, or no
 * tracked objective at all.
 */
export function resolveQuestWaypoint(
  manager: QuestManagerLike,
  world: WaypointWorld,
): QuestWaypoint | null {
  const tracked = trackedObjective(manager);
  if (!tracked) return null;
  const { def, objective } = tracked;
  const { playerPos } = world;
  let target: WaypointWorldEntity | null = null;
  switch (objective.kind) {
    case 'kill':
      target = nearestXZ(playerPos.x, playerPos.z,
        world.enemies.filter((e) => e.alive && e.kind === objective.target));
      break;
    case 'gather': {
      const nodes = world.nodes.filter((n) => !n.depleted
        && (objective.target === 'any' || n.materialId === objective.target));
      target = nearestXZ(playerPos.x, playerPos.z, nodes);
      break;
    }
    case 'craft': {
      const want = objective.target === 'any' ? undefined : world.recipeStation(objective.target);
      const stations = want
        ? world.stations.filter((s) => s.stationId === want)
        : world.stations;
      target = nearestXZ(playerPos.x, playerPos.z,
        stations.length > 0 ? stations : world.stations);
      break;
    }
    case 'talk': {
      const npcs = world.npcs.filter((n) => n.alive
        && (objective.target === 'any' || n.role === objective.target));
      target = nearestXZ(playerPos.x, playerPos.z, npcs);
      break;
    }
    case 'explore':
      target = nearestXZ(playerPos.x, playerPos.z,
        world.portalExits.map((p) => ({ position: p })));
      break;
    default:
      return null;
  }
  if (!target) return null;
  return {
    questId: def.id,
    questName: def.name,
    objective,
    position: { x: target.position.x, y: target.position.y, z: target.position.z },
  };
}

const COMPASS_CSS = `
#xandria-compass { position:absolute; z-index:9300; pointer-events:none; display:none;
  font-family:system-ui,-apple-system,sans-serif; user-select:none; }
#xandria-compass .cwrap { display:flex; flex-direction:column; align-items:center; gap:1px;
  filter:drop-shadow(0 1px 3px rgba(0,0,0,.7)); }
#xandria-compass .carrow { font-size:22px; line-height:1; color:${AMBER}; }
#xandria-compass .cdist { font-size:11px; font-weight:700; letter-spacing:.08em; color:#ffe9bd;
  background:rgba(8,10,16,.72); border:1px solid ${AMBER}59; border-radius:6px; padding:1px 6px; white-space:nowrap; }
`;

export class QuestWaypoints {
  private readonly engine: Engine;
  private readonly dom: boolean;
  private root: HTMLDivElement | null = null;
  private arrowEl: HTMLSpanElement | null = null;
  private distEl: HTMLSpanElement | null = null;
  private untap: (() => void) | null = null;
  private disposed = false;
  private scanT = 0;
  private currentWaypoint: QuestWaypoint | null = null;
  private recipeStations: Map<string, string> | null = null;
  /** beacon InstancedMeshes (capacity 1 each): amber gem + faint pillar */
  private gem: THREE.InstancedMesh | null = null;
  private pillar: THREE.InstancedMesh | null = null;
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpEuler = new THREE.Euler();
  private readonly proj = new THREE.Vector3();
  private beaconOn = false;
  /** compass bucket state — DOM writes only on bucket change */
  private compassVisible = false;
  private lastCompassKey = '';
  /** last camera forward (horizontal, unit) — the rig owns view yaw, not
   *  ctrl.camYaw (a stale setup snapshot), so orbit input must be read
   *  off the camera itself or the compass never refreshes on orbit. */
  private lastCamDirX = Number.NaN;
  private lastCamDirZ = Number.NaN;
  private readonly camDir = new THREE.Vector3();
  private lastPlayerX = Number.NaN;
  private lastPlayerZ = Number.NaN;

  constructor(container: HTMLElement, engine: Engine) {
    this.engine = engine;
    this.dom = typeof document !== 'undefined' && typeof document.createElement === 'function';
    if (this.dom) this.buildDom(container);
    this.buildBeacon();
    this.untap = engine.hooks.tap('onTick', ({ dt }) => this.tick(dt));
  }

  /** Current resolved waypoint (null = none). Read by Minimap for its marker. */
  get current(): QuestWaypoint | null {
    return this.currentWaypoint;
  }

  /** Minimap marker position (fog rules are applied by Minimap itself). */
  minimapMarker(): { x: number; z: number } | null {
    const w = this.currentWaypoint;
    return w ? { x: w.position.x, z: w.position.z } : null;
  }

  /** Test/introspection seam: is the in-world beacon currently drawn? */
  get beaconVisible(): boolean {
    return this.beaconOn;
  }

  /** Test/introspection seam: compass DOM state (null when never laid out). */
  compassState(): { visible: boolean; left: number; top: number; distanceM: number; angleDeg: number } | null {
    if (!this.root) return null;
    return {
      visible: this.compassVisible,
      left: parseFloat(this.root.style.left || '0'),
      top: parseFloat(this.root.style.top || '0'),
      distanceM: this.lastCompassDistance,
      angleDeg: this.lastCompassAngle,
    };
  }

  private lastCompassDistance = 0;
  private lastCompassAngle = 0;

  private buildDom(container: HTMLElement): void {
    const doc = document;
    if (typeof doc.getElementById === 'function' && !doc.getElementById('xandria-compass-css')) {
      const style = doc.createElement('style');
      (style as HTMLStyleElement).id = 'xandria-compass-css';
      style.textContent = COMPASS_CSS;
      doc.head.appendChild(style);
    }
    const root = doc.createElement('div');
    root.id = 'xandria-compass';
    const wrap = doc.createElement('div');
    wrap.className = 'cwrap';
    const arrow = doc.createElement('span');
    arrow.className = 'carrow';
    arrow.textContent = '▲';
    const dist = doc.createElement('span');
    dist.className = 'cdist';
    dist.textContent = '';
    wrap.append(arrow, dist);
    root.append(wrap);
    container.appendChild(root);
    this.root = root;
    this.arrowEl = arrow;
    this.distEl = dist;
  }

  /**
   * Beacon meshes: shared voxel geometry (gathering/station cache) +
   * the existing amber glow role. InstancedMesh capacity 1 — the
   * beacon is ONE marker, never a roster. Shared geometry/material
   * are cache-owned and are never disposed here.
   */
  private buildBeacon(): void {
    try {
      const geo = voxelBoxCacheFor(this.engine);
      const gemGeo = geo.box(0.55, 0.55, 0.55);
      const gemMat = amberGlowMaterial(this.engine.mats, 2.2);
      this.gem = new THREE.InstancedMesh(gemGeo, gemMat, 1);
      this.gem.frustumCulled = false;
      this.gem.castShadow = false;
      this.gem.count = 0;
      const pillarGeo = geo.box(0.18, 6.5, 0.18);
      const pillarMat = new THREE.MeshBasicMaterial({
        color: AMBER, transparent: true, opacity: 0.28,
        side: THREE.DoubleSide, depthWrite: false,
      });
      this.pillar = new THREE.InstancedMesh(pillarGeo, pillarMat, 1);
      this.pillar.frustumCulled = false;
      this.pillar.castShadow = false;
      this.pillar.count = 0;
      this.engine.scene.add(this.gem, this.pillar);
    } catch {
      // A beacon that fails to build must never take the game down:
      // minimap + compass still work, the beacon simply stays absent.
      this.gem = null;
      this.pillar = null;
    }
  }

  /** Force a re-resolution now (tests + any future event hook). */
  resolveNow(): QuestWaypoint | null {
    this.scanT = 0;
    this.refresh();
    return this.currentWaypoint;
  }

  private get manager(): QuestManager | null {
    return this.engine.questManager;
  }

  private recipeStationFor(recipeId: string): string | undefined {
    if (!this.recipeStations) {
      this.recipeStations = new Map();
      try {
        for (const r of buildRecipePool(this.engine.spec)) {
          if (r.stationId) this.recipeStations.set(r.id, r.stationId);
        }
      } catch {
        // A broken recipe pool must not break waypoints: fall back to
        // nearest-station resolution for every craft objective.
      }
    }
    return this.recipeStations.get(recipeId);
  }

  /** Build the live world view from the engine's map-local systems. */
  private worldView(): WaypointWorld | null {
    const avatar = this.engine.portalsPlayerAvatar;
    if (!avatar) return null;
    const bp = avatar.ctrl.body.position;
    const byId = (id: string): unknown => {
      try {
        return this.engine.portalEntities.byId(id);
      } catch {
        return undefined;
      }
    };
    const enemiesSys = byId('enemies') as { enemies?: Array<{ spec?: { kind?: string }; alive?: boolean; position?: { x: number; y: number; z: number } }> } | undefined;
    const npcsSys = byId('npcs') as { npcs?: Array<{ role?: string; alive?: boolean; position?: { x: number; y: number; z: number } }> } | undefined;
    const gatheringSys = byId('gathering') as { nodes?: Array<{ kind?: string; isDepleted?: boolean; retired?: boolean; interactable?: { position?: { x: number; y: number; z: number } } }> } | undefined;
    const stationsSys = byId('stations') as { stations?: Array<{ stationId?: string; interactable?: { position?: { x: number; y: number; z: number } } }> } | undefined;
    const terrain = this.engine.terrain as unknown as { size?: number; heightAt?: (x: number, z: number) => number | null } | undefined;
    const portalExits: Array<{ x: number; y: number; z: number }> = [];
    if (this.engine.portalManager && typeof terrain?.size === 'number' && terrain.size > 0) {
      const half = terrain.size / 2;
      for (const [ex, ez] of [[0, -half], [0, half], [half, 0], [-half, 0]] as const) {
        let y = 0;
        try {
          y = terrain.heightAt?.(ex, ez) ?? 0;
        } catch {
          y = 0;
        }
        portalExits.push({ x: ex, y: Number.isFinite(y) ? y : 0, z: ez });
      }
    }
    return {
      playerPos: { x: bp.x, y: bp.y, z: bp.z },
      enemies: (enemiesSys?.enemies ?? []).map((e) => ({
        kind: e.spec?.kind ?? '',
        alive: e.alive !== false,
        position: { x: e.position?.x ?? 0, y: e.position?.y ?? 0, z: e.position?.z ?? 0 },
      })),
      npcs: (npcsSys?.npcs ?? []).map((n) => ({
        role: n.role ?? '',
        alive: n.alive !== false,
        position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0, z: n.position?.z ?? 0 },
      })),
      nodes: (gatheringSys?.nodes ?? []).map((n) => ({
        materialId: (MATERIAL_IDS as Record<string, string>)[n.kind ?? ''] ?? '',
        depleted: n.isDepleted === true || n.retired === true,
        position: {
          x: n.interactable?.position?.x ?? 0,
          y: n.interactable?.position?.y ?? 0,
          z: n.interactable?.position?.z ?? 0,
        },
      })),
      stations: (stationsSys?.stations ?? []).map((s) => ({
        stationId: s.stationId ?? '',
        position: {
          x: s.interactable?.position?.x ?? 0,
          y: s.interactable?.position?.y ?? 0,
          z: s.interactable?.position?.z ?? 0,
        },
      })),
      portalExits,
      recipeStation: (id) => this.recipeStationFor(id),
    };
  }

  private tick(dt: number): void {
    if (this.disposed) return;
    const playing = this.engine.state === 'playing' || this.engine.state === 'paused';
    if (!playing) {
      if (this.currentWaypoint || this.compassVisible || this.beaconOn) this.clear();
      return;
    }
    this.scanT += dt;
    if (this.scanT < WAYPOINT_SCAN_INTERVAL_S) {
      // Idle fast path: no re-resolution, no DOM writes. The compass
      // only needs a refresh when the player/camera moved enough to
      // change its bucket — checked cheaply below.
      this.maybeRefreshCompass();
      return;
    }
    this.scanT = 0;
    this.refresh();
  }

  /** Re-resolve + update beacon/compass. Called on scan ticks and by resolveNow(). */
  private refresh(): void {
    const mgr = this.manager;
    const world = mgr ? this.worldView() : null;
    const next = mgr && world ? resolveQuestWaypoint(mgr, world) : null;
    const prev = this.currentWaypoint;
    const changed = (prev?.questId !== next?.questId)
      || (prev?.objective.id !== next?.objective.id)
      || !next
      || !prev
      || Math.hypot(next.position.x - prev.position.x, next.position.z - prev.position.z) > WAYPOINT_MOVE_EPS_M;
    this.currentWaypoint = next;
    if (!next) {
      if (prev || this.compassVisible || this.beaconOn) this.clear();
      return;
    }
    if (changed) this.updateBeacon(next);
    this.updateCompass(next, true);
  }

  private clear(): void {
    this.currentWaypoint = null;
    this.setBeaconOn(false);
    this.setCompassVisible(false);
    this.lastCompassKey = '';
  }

  private setBeaconOn(on: boolean): void {
    if (this.beaconOn === on) return;
    this.beaconOn = on;
    if (this.gem) this.gem.count = on ? 1 : 0;
    if (this.pillar) this.pillar.count = on ? 1 : 0;
    if (this.gem) this.gem.instanceMatrix.needsUpdate = true;
    if (this.pillar) this.pillar.instanceMatrix.needsUpdate = true;
  }

  private updateBeacon(w: QuestWaypoint): void {
    if (!this.gem || !this.pillar) return;
    // Gem floats above the target; the pillar roots at the ground point.
    const gy = w.position.y + 3.8;
    this.tmpEuler.set(0, this.engine.time * 0.9, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpPos.set(w.position.x, gy, w.position.z);
    this.tmpScale.setScalar(1);
    this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
    this.gem.setMatrixAt(0, this.tmpMatrix);
    this.gem.instanceMatrix.needsUpdate = true;
    this.tmpEuler.set(0, 0, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpPos.set(w.position.x, w.position.y + 3.1, w.position.z);
    this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
    this.pillar.setMatrixAt(0, this.tmpMatrix);
    this.pillar.instanceMatrix.needsUpdate = true;
    this.setBeaconOn(true);
  }

  /**
   * Compass refresh when idle: recompute only if the player moved >2m
   * or the camera yaw changed >3° since the last layout (cheap reads,
   * no DOM writes unless a bucket changed).
   */
  private maybeRefreshCompass(): void {
    const w = this.currentWaypoint;
    if (!w) return;
    const avatar = this.engine.portalsPlayerAvatar;
    if (!avatar) return;
    const bp = avatar.ctrl.body.position;
    const cam = this.engine.camera.getWorldDirection(this.camDir);
    const clen = Math.hypot(cam.x, cam.z) || 1;
    const dx = cam.x / clen, dz = cam.z / clen;
    const moved = Math.hypot(bp.x - this.lastPlayerX, bp.z - this.lastPlayerZ) > 2;
    const turned = Number.isNaN(this.lastCamDirX)
      || (dx * this.lastCamDirX + dz * this.lastCamDirZ) < 0.99863; // >3 deg
    if (!moved && !turned && this.compassVisible) return;
    this.updateCompass(w, false);
  }

  private updateCompass(w: QuestWaypoint, _scan: boolean): void {
    if (!this.root || !this.arrowEl || !this.distEl) {
      // Headless/unit-test engines have no DOM: keep beacon-only state.
      this.compassVisible = false;
      return;
    }
    const avatar = this.engine.portalsPlayerAvatar;
    if (!avatar) {
      this.setCompassVisible(false);
      return;
    }
    const bp = avatar.ctrl.body.position;
    this.lastPlayerX = bp.x;
    this.lastPlayerZ = bp.z;
    const cam = this.engine.camera.getWorldDirection(this.camDir);
    const clen = Math.hypot(cam.x, cam.z) || 1;
    this.lastCamDirX = cam.x / clen;
    this.lastCamDirZ = cam.z / clen;
    const wpx = this.engine.container.clientWidth || window.innerWidth;
    const hpx = this.engine.container.clientHeight || window.innerHeight;
    this.proj.set(w.position.x, w.position.y + 3.8, w.position.z).project(this.engine.camera);
    const dist = Math.hypot(w.position.x - bp.x, w.position.z - bp.z);
    this.lastCompassDistance = dist;
    const onScreen = this.proj.z < 1 && Math.abs(this.proj.x) < 0.82 && Math.abs(this.proj.y) < 0.82;
    if (onScreen) {
      this.setCompassVisible(false);
      this.lastCompassKey = '';
      return;
    }
    // Direction from screen center toward the projected point; a point
    // behind the camera projects mirrored, so flip it.
    let nx = this.proj.x;
    let ny = -this.proj.y;
    if (this.proj.z > 1) {
      nx = -nx;
      ny = -ny;
    }
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const angleDeg = (Math.atan2(ny, nx) * 180) / Math.PI + 90;
    this.lastCompassAngle = angleDeg;
    // Clamp to an inset rect, then slide out of the HUD exclusion zones
    // (quest tracker top-right, ability buttons + minimap bottom-right).
    const inset = 30;
    let cx = wpx / 2 + nx * (wpx / 2 - inset);
    let cy = hpx / 2 + ny * (hpx / 2 - inset);
    cx = Math.max(inset, Math.min(wpx - inset, cx));
    cy = Math.max(inset, Math.min(hpx - inset, cy));
    if (cx > wpx - 280 && cy < 210) cx = wpx - 280; // tracker zone
    if (cx > wpx - 240 && cy > hpx - 300) cy = hpx - 300; // buttons/minimap zone
    cx = Math.max(inset, Math.min(wpx - inset, cx));
    cy = Math.max(inset, Math.min(hpx - inset, cy));
    const distBucket = Math.round(dist / COMPASS_DISTANCE_BUCKET_M);
    const angleBucket = Math.round(angleDeg / COMPASS_ANGLE_BUCKET_DEG);
    const key = `${angleBucket}|${distBucket}|${Math.round(cx)}|${Math.round(cy)}`;
    if (key === this.lastCompassKey && this.compassVisible) return;
    this.lastCompassKey = key;
    this.root.style.left = `${cx}px`;
    this.root.style.top = `${cy}px`;
    this.root.style.transform = 'translate(-50%,-50%)';
    this.arrowEl.style.transform = `rotate(${angleDeg}deg)`;
    this.arrowEl.style.display = 'block';
    this.distEl.textContent = `${Math.round(dist)}m`;
    this.setCompassVisible(true);
  }

  private setCompassVisible(v: boolean): void {
    if (this.compassVisible === v) {
      // Still re-assert the inline display: the stylesheet default is
      // display:none, so '' would hide the compass even when visible.
      if (this.root) this.root.style.display = v ? 'block' : 'none';
      return;
    }
    this.compassVisible = v;
    if (this.root) this.root.style.display = v ? 'block' : 'none';
  }

  /** Deterministic restart: drop the resolved waypoint (re-resolves on scan). */
  resetRun(): void {
    this.currentWaypoint = null;
    this.scanT = 0;
    this.lastCompassKey = '';
    this.lastCamDirX = Number.NaN;
    this.lastCamDirZ = Number.NaN;
    this.lastPlayerX = Number.NaN;
    this.lastPlayerZ = Number.NaN;
    this.setBeaconOn(false);
    this.setCompassVisible(false);
  }

  dispose(): void {
    this.disposed = true;
    this.untap?.();
    this.untap = null;
    if (this.gem) {
      this.engine.scene.remove(this.gem);
      this.gem.dispose();
      this.gem = null;
    }
    if (this.pillar) {
      this.engine.scene.remove(this.pillar);
      // The pillar material is ours (not cache-shared) — dispose it.
      (this.pillar.material as THREE.Material).dispose();
      this.pillar.dispose();
      this.pillar = null;
    }
    this.root?.remove();
    this.root = null;
    this.arrowEl = null;
    this.distEl = null;
  }
}
