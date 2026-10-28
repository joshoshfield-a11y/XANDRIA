/**
 * Open World — Portals, workstream B: edge trigger volumes + the
 * loading-screen transition flow between 8km maps.
 *
 * Owns:
 * - 4 edge trigger volumes (PortalTrigger — the band sits slightly inside
 *   the map edge), with sustained-crossing debounce + cooldown + a
 *   transition lock (no double-transition when the player straddles the
 *   edge; jumping near the edge can't false-trip);
 * - the loading-screen flow (PortalTransitionOverlay): fade out → brief
 *   loader → rebuild the target map spawn-first → place the player at the
 *   OPPOSITE edge, facing inward, momentum preserved → fade in;
 * - the workstream-D seam: onBeforeTransition / onAfterTransition hooks and
 *   a snapshotPlayer/restorePlayer pair, documented below.
 *
 * Attach is a no-op (returns null) unless the spec enables portals —
 * arena genres and portal-off specs are completely unaffected: no hooks,
 * no overlay, no per-frame work.
 *
 * Workstream-D seam (player state persistence is D's job):
 *   manager.hooks.onBeforeTransition(ctx)  — async, runs BEFORE the world
 *     rebuild. D: snapshot player state here (or supply snapshotPlayer).
 *   manager.hooks.snapshotPlayer()         — returns an opaque snapshot;
 *     B stores it on the context and hands it back after the rebuild.
 *   manager.hooks.onAfterTransition(ctx)   — async, runs AFTER the player is
 *     placed on the new map. D: respawn map-local entities, restore state.
 *   manager.hooks.restorePlayer(snapshot, ctx) — sync restore after placement.
 * B itself never tears down the blueprint or the avatar: the same
 * PlayerAvatar instance persists across the transition (health/ammo/etc.
 * ride along naturally); only the terrain seed + chunks are rebuilt, and the
 * avatar's `spawn` is re-pointed at the arrival point so respawns stay on
 * the new map.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import { portalsEnabled } from '@spec';
import { deriveMapSeed, neighborOf, oppositeEdge, type MapCoord, type MapEdge } from './MapGraph';
import { PortalTrigger, type PortalEdge } from './PortalTrigger';
import { PortalTransitionOverlay } from '../ui/PortalTransitionOverlay';
import { PortalTransition, capturePlayerState, applyPlayerState, type PortalParts, type PlayerStateSnapshot } from './PortalState';
import { FastTravelRegistry, fastTravelArrivalEdge, labelFor } from './FastTravel';
import { resolveBiomeDef } from './Biomes';

/** Everything workstream D needs to persist/regenerate across a transition. */
export interface PortalTransitionContext {
  from: MapCoord;
  to: MapCoord;
  /** edge crossed on the old map (e.g. 'N' when walking north off (mx,my)) */
  crossedEdge: PortalEdge;
  /** edge the player arrives at on the new map (always the opposite) */
  arrivedEdge: PortalEdge;
  /** the run's seed — portals derive map seeds from this, never chained */
  worldSeed: number;
  /** deriveMapSeed(worldSeed, to.mx, to.my) */
  mapSeed: number;
  /** final placed position on the new map (y = ground + 2m) */
  arrivalPos: THREE.Vector3;
  /** camYaw the player was given (facing inward) */
  arrivalYaw: number;
  /** the player's velocity at the moment of crossing */
  prevVelocity: THREE.Vector3;
  /** opaque player-state snapshot, if hooks.snapshotPlayer was supplied */
  snapshot?: unknown;
}

/** Workstream-D hook surface. Every field optional; B works with none. */
export interface PortalSeamHooks {
  onBeforeTransition?: (ctx: PortalTransitionContext) => void | Promise<void>;
  onAfterTransition?: (ctx: PortalTransitionContext) => void | Promise<void>;
  snapshotPlayer?: () => unknown;
  restorePlayer?: (snapshot: unknown, ctx: PortalTransitionContext) => void;
}

/** Minimal player surface PortalManager needs — bound from the avatar. */
export interface PortalPlayerAdapter {
  position(): THREE.Vector3;
  velocity(): THREE.Vector3;
  place(pos: THREE.Vector3, yaw: number, vel: THREE.Vector3): void;
}

/** Inset (m) of the arrival point inside the opposite edge of the new map. */
export const PORTAL_ARRIVAL_INSET = 120;
/** Horizontal speed clamp (m/s) for preserved arrival momentum. */
export const PORTAL_MAX_ARRIVAL_SPEED = 25;

function bindPlayerAdapter(engine: Engine): PortalPlayerAdapter | null {
  const av = engine.portalsPlayerAvatar;
  if (!av) return null;
  return {
    position: () => av.ctrl.position,
    velocity: () => av.ctrl.velocity,
    place: (pos, yaw, vel) => {
      av.ctrl.teleport(pos);
      av.ctrl.camYaw = yaw;
      av.ctrl.body.velocity.set(vel.x, vel.y, vel.z);
      engine.physics.snapInterp(av.ctrl.body);
      // respawns must stay on the NEW map, not the old one
      av.spawn.copy(pos);
    },
  };
}

/** camYaw whose "forward" (W) walks the given inward unit direction. */
function yawForDirection(dx: number, dz: number): number {
  // forward dir at camYaw: (−sin yaw, −cos yaw) — see CharacterController.
  return Math.atan2(-dx, -dz);
}

export class PortalManager {
  /** workstream-D hook surface — D assigns fields; B calls them. */
  readonly hooks: PortalSeamHooks = {};
  readonly trigger: PortalTrigger;
  /** current map coordinate; starts at (0,0). */
  coord: MapCoord = { mx: 0, my: 0 };
  transitions = 0;
  transitioning = false;
  /**
   * FAST-TRAVEL (upgrade loop): the discovered-portal registry. The origin
   * map is recorded at construction (every run starts there — the Engine
   * stamps the origin portalMap before attach); every completed transition
   * records its destination. Persisted per world seed, so a reload on the
   * same run restores the list. Labels only — travel itself always runs
   * the full portal pipeline, so arrival state is identical to a walked
   * arrival by construction.
   */
  readonly discovered: FastTravelRegistry;
  /** last completed arrival (e2e / debug introspection). */
  lastArrival: { coord: MapCoord; pos: THREE.Vector3; edge: PortalEdge } | null = null;

  private engine: Engine;
  private overlay: PortalTransitionOverlay | null;
  private player: PortalPlayerAdapter | null = null;
  private worldSeed: number;
  /**
   * Side-quests wave: the run's world seed (spec.custom.portalMap.worldSeed
   * at boot, else spec.meta.seed) for cross-map derivation such as
   * deriveMapBiome in quest explore objectives. Read-only.
   */
  get worldSeedValue(): number {
    return this.worldSeed;
  }
  private seq = 0;
  private detachHook: (() => void) | null = null;
  private warnedNoAvatar = false;
  /**
   * Arrival streaming pin: while set, engine.streamFocus is pinned to the
   * arrival point so the ChunkStream teleport path keeps ground under the
   * player while the blueprint camera rig converges. Released (back to the
   * camera-follow default) once the camera is within 200m of the player.
   */
  private focusPin: THREE.Vector3 | null = null;

  private constructor(engine: Engine) {
    this.engine = engine;
    // PORTALS (merge): the world seed is the RUN's seed — carried on
    // spec.custom.portalMap by the Engine's origin stamp (boot) / re-stamp
    // (startRun/toTitle/startDailyRun). spec.meta.seed is the current MAP's
    // build seed and must NOT be used for derivation. Falls back to
    // meta.seed only for pre-stamp specs (tests).
    this.worldSeed = engine.spec.custom?.portalMap?.worldSeed ?? engine.spec.meta.seed;
    this.discovered = new FastTravelRegistry(this.worldSeed);
    // Origin discovery: the run starts on (0,0) with the origin portalMap
    // already stamped (Engine constructor stamps before attach), so the
    // origin label is exact here — biome from the live spec (a Studio
    // override wins), tier from the pure derivation (origin is always 1).
    this.recordDiscovery({ mx: 0, my: 0 });
    this.trigger = new PortalTrigger({ half: engine.spec.world.terrain.size / 2 });
    this.overlay =
      typeof document !== 'undefined' ? new PortalTransitionOverlay(engine.container) : null;
    // PORTALS (merge): wire D's player-state layer into B's hook seam.
    // snapshotPlayer/restorePlayer are D's pure capture/apply; the live
    // transition flow (below) drives them through PortalTransition at the
    // correct order (apply BEFORE arrival placement, so arrival yaw/momentum
    // win). The avatar object itself persists across transitions (no
    // blueprint teardown), so inventory/progression ride on the live
    // objects; the snapshot covers the avatar's scalar state.
    this.hooks.snapshotPlayer = () => capturePlayerState(this.engine, this.portalParts());
    this.hooks.restorePlayer = (snapshot) => applyPlayerState(this.engine, this.portalParts(), snapshot as PlayerStateSnapshot);
    this.detachHook = engine.onUpdatePersistent(() => this.update());
  }

  /** D's PortalParts for this engine: avatar live, the rest unattached (see above). */
  private portalParts(): PortalParts {
    return {
      avatar: this.engine.portalsPlayerAvatar,
      inventory: null,
      progression: null,
      // quest wave: the blueprint's player-scoped quest manager (null when
      // quests are disabled) — snapshot/restore keeps quest progress across
      // transitions even if a future flow ever rebuilds the blueprint.
      quests: this.engine.questManager,
      // dialogue-branching wave: the blueprint's player-scoped dialogue
      // state (null when dialogue is disabled) — snapshot/restore keeps
      // visited nodes, choices and flags across blueprint rebuilds.
      dialogue: this.engine.dialogueState,
      skills: null,
      // vendor-economy wave: the blueprint's player-scoped currency wallet
      // (null = economy off) — snapshot/restore keeps the balance across
      // blueprint rebuilds; live transitions never touch the object.
      wallet: this.engine.wallet ?? null,
      getBuff: () => null,
      setBuff: () => {},
    };
  }

  /**
   * Attach portal travel to the engine. Returns null (no hooks, no overlay,
   * no per-frame work) when the spec doesn't enable portals or the world has
   * no terrain.
   */
  static attach(engine: Engine): PortalManager | null {
    if (!portalsEnabled(engine.spec)) return null;
    if (!engine.terrain) return null;
    return new PortalManager(engine);
  }

  /** The run's world seed (workstream-D / debug). */
  getWorldSeed(): number { return this.worldSeed; }

  /**
   * Re-point the world seed (called by Engine when a daily-challenge run
   * overrides spec.meta.seed after construction — the run's seed is the
   * world seed portal derivation must use).
   */
  resetWorldSeed(seed: number): void {
    this.worldSeed = seed;
    // FAST-TRAVEL: a reseed starts a new world — re-key the registry to
    // that seed's persisted list, then record the origin the restarted run
    // boots on (the spec is freshly origin-stamped by the caller first).
    this.discovered.rekey(seed);
    this.recordDiscovery({ mx: 0, my: 0 });
  }

  /**
   * FAST-TRAVEL: record a map as discovered, with the labels the UI shows.
   * Biome comes from the live spec (post-swap, so it is the arrival map's
   * biome, Studio override included); tier comes from the engine's live
   * world tier (applied pre-spawn by swapTerrainForPortal). Falls back to
   * the pure derivation when the live values are unavailable (construction,
   * before the first terrain build applies a tier).
   */
  private recordDiscovery(coord: MapCoord): void {
    let biome: ReturnType<typeof resolveBiomeDef>['id'];
    let tier: number;
    try {
      biome = resolveBiomeDef(this.engine.spec).id;
    } catch {
      biome = labelFor(this.worldSeed, coord).biome;
    }
    tier = Number.isFinite(this.engine.worldTier) && this.engine.worldTier >= 1
      ? this.engine.worldTier
      : labelFor(this.worldSeed, coord).tier;
    // The origin's tier is definitionally 1 even before any terrain build
    // applies it; the derivation agrees, but pin it explicitly so a stale
    // deep-map tier can never label the origin map.
    if (coord.mx === 0 && coord.my === 0) tier = 1;
    this.discovered.record(coord, biome, tier);
  }

  dispose(): void {
    this.detachHook?.();
    this.detachHook = null;
    if (this.focusPin && this.engine.streamFocus === this.focusPin) this.engine.streamFocus = null;
    this.focusPin = null;
    this.overlay?.dispose();
    this.overlay = null;
    this.player = null;
  }

  private update(): void {
    if (this.transitioning) return;
    // release the arrival streaming pin once the camera has caught up
    if (this.focusPin && this.player) {
      if (this.engine.camera.position.distanceTo(this.player.position()) < 200) {
        if (this.engine.streamFocus === this.focusPin) this.engine.streamFocus = null;
        this.focusPin = null;
      }
    }
    if (!this.player) {
      this.player = bindPlayerAdapter(this.engine);
      if (!this.player) {
        // Portal-backlog wave (racing-adapter evaluation, kept inactive BY
        // DESIGN): closed-loop genres (racing's vehicle) intentionally have
        // no player adapter. Portal travel is only coherent for open-world
        // avatar genres — arrival places the player at the opposite edge of
        // a new map, but racing's laps/checkpoints/gates are track-scoped,
        // so an arrival would strand the car off-track with no coherent
        // gameplay. The generator never enables portals for racing (even
        // 8000m rally); if the Studio toggle is flipped on anyway, warn once
        // and stay inert rather than strand the player.
        if (!this.warnedNoAvatar) {
          this.warnedNoAvatar = true;
          console.warn('[portals] no player adapter for this genre — portal travel inert (closed-loop genres intentionally unsupported)');
        }
        return;
      }
    }
    const p = this.player.position();
    const edge = this.trigger.sample(p.x, p.z, performance.now());
    if (edge) void this.beginTransition(edge);
  }

  /**
   * Arrival X/Z on the new map for an arrival at `arrivedEdge` (y resolved
   * post-build). Walked arrivals pass oppositeEdge(crossedEdge); fast
   * travel passes the edge computed from the direction of travel — both
   * land on the same geometry: the arrival edge, facing inward, with the
   * crossing coordinate clamped inside the map (fast travel has no
   * crossing point, so it passes 0,0 and lands edge-center).
   */
  private arrivalXZ(arrivedEdge: PortalEdge, crossX: number, crossZ: number): { x: number; z: number; yaw: number } {
    const half = this.engine.spec.world.terrain.size / 2;
    const m = PORTAL_ARRIVAL_INSET;
    const cx = Math.max(-half + m, Math.min(half - m, crossX));
    const cz = Math.max(-half + m, Math.min(half - m, crossZ));
    switch (arrivedEdge) {
      case 'S': return { x: cx, z: -half + m, yaw: yawForDirection(0, 1) };   // arrive at S edge, face north
      case 'N': return { x: cx, z: half - m, yaw: yawForDirection(0, -1) };   // arrive at N edge, face south
      case 'W': return { x: -half + m, z: cz, yaw: yawForDirection(1, 0) };   // arrive at W edge, face east
      case 'E': return { x: half - m, z: cz, yaw: yawForDirection(-1, 0) };   // arrive at E edge, face west
    }
  }

  /**
   * FAST-TRAVEL: travel to a discovered portal without walking there.
   * Runs the exact same transition pipeline as a walked arrival (overlay,
   * PortalTransition begin/finish, arrival placement, map-entity spawn),
   * so landmarks, tier, and enemy bands on the destination are identical
   * to a walked arrival. Cost-free: no currency or any other gate is read.
   * Returns false (no state changed) when a transition is already running,
   * the target is the current map, or the target was never discovered —
   * undiscovered portals stay unreachable through this path.
   */
  async fastTravelTo(to: MapCoord): Promise<boolean> {
    if (this.transitioning) return false;
    if (to.mx === this.coord.mx && to.my === this.coord.my) return false;
    if (!this.discovered.has(to)) return false;
    const arrivedEdge = fastTravelArrivalEdge(this.coord, to);
    if (!arrivedEdge) return false;
    if (!this.player) {
      this.player = bindPlayerAdapter(this.engine);
      if (!this.player) return false;
    }
    const from = { ...this.coord };
    await this.runTransition(from, to, oppositeEdge(arrivedEdge) as PortalEdge, arrivedEdge, 0, 0, 'Fast traveling');
    return this.coord.mx === to.mx && this.coord.my === to.my;
  }

  private nextFrame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }

  /**
   * Walked-arrival entry: crossing `edge` of the current map. Delegates to
   * runTransition with the neighbor map and the opposite arrival edge;
   * fast travel calls runTransition directly with its own target/edge.
   * Interrupt-safe (see runTransition): the trigger is locked for the whole
   * flow and a post-transition cooldown + the 120m arrival inset make a
   * straddled edge unable to double-fire. Stale async completions (id
   * check) can never place the player twice.
   */
  private async beginTransition(edge: PortalEdge): Promise<void> {
    const from = { ...this.coord };
    const to = neighborOf(from, edge as MapEdge);
    const cross = this.player?.position();
    await this.runTransition(
      from, to, edge, oppositeEdge(edge as MapEdge) as PortalEdge,
      cross?.x ?? 0, cross?.z ?? 0, 'Entering new territory',
    );
  }

  /**
   * The full transition, shared by walked and fast-travel arrivals — the
   * ONLY path that moves the player between maps, so both arrival kinds
   * get the identical pipeline (overlay → PortalTransition swap → arrival
   * placement → map-entity spawn) and therefore identical arrival state.
   */
  private async runTransition(
    from: MapCoord, to: MapCoord, crossedEdge: PortalEdge, arrivedEdge: PortalEdge,
    crossX: number, crossZ: number, overlayTitle: string,
  ): Promise<void> {
    if (this.transitioning || !this.player) return;
    const id = ++this.seq;
    this.transitioning = true;
    this.trigger.lock();
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const mark = (m: string) => {
      if (typeof performance !== 'undefined') {
        console.debug(`[portals] transition ${m} +${(performance.now() - t0).toFixed(0)}ms`);
      }
    };
    try {
      const player = this.player;
      const mapSeed = deriveMapSeed(this.worldSeed, to.mx, to.my);
      const prevVel = player.velocity().clone();
      const axz = this.arrivalXZ(arrivedEdge, crossX, crossZ);

      const ctx: PortalTransitionContext = {
        from: { ...from },
        to: { ...to },
        crossedEdge,
        arrivedEdge,
        worldSeed: this.worldSeed,
        mapSeed,
        arrivalPos: new THREE.Vector3(axz.x, 0, axz.z), // y resolved after the rebuild
        arrivalYaw: axz.yaw,
        prevVelocity: prevVel,
      };
      await this.hooks.onBeforeTransition?.(ctx);

      console.debug('[portals] transition: cover');
      mark('cover-start');
      await this.overlay?.cover(overlayTitle, `Map (${to.mx}, ${to.my})`);
      mark('covered');
      // let the loader paint before the (blocking) world swap
      await this.nextFrame();
      await this.nextFrame();
      mark('painted');
      if (id !== this.seq) return;

      // PORTALS (merge): LRU-backed map swap (workstream D's PortalTransition).
      // begin() captures player state + parks the live map's payloads (no
      // dispose — cached chunk geometry survives) + despawns map entities;
      // finish() acquires the target from the visited-map LRU (or builds it),
      // swaps it live, unparks at the arrival focus (spawn-first teleport
      // semantics: the arrival neighborhood sync-builds, the rest streams
      // in), restores player state, and spawns the new map's entities.
      // D's apply runs BEFORE B's arrival placement below, so the arrival
      // yaw/inward momentum win over the snapshot's yaw/velocity.
      console.debug('[portals] transition: swap seed', mapSeed);
      mark('swap-start');
      const transition = new PortalTransition(this.engine);
      const parts = this.portalParts();
      const snap = transition.begin(parts);
      const arrivalFocus = new THREE.Vector3(axz.x, 0, axz.z);
      const { hit } = transition.finish(parts, snap, to, mapSeed, arrivalFocus,
        (c, ms) => this.engine.buildTerrainForPortal(c, ms, arrivalFocus));
      if (id !== this.seq) return;
      mark(hit ? 'cache-hit' : 'rebuilt');
      console.debug(`[portals] transition: ${hit ? 'cache hit' : 'rebuilt'}`);
      ctx.snapshot = snap;

      const groundY = this.engine.terrain.heightAt(axz.x, axz.z);
      const arrival = new THREE.Vector3(axz.x, groundY + 2, axz.z);
      ctx.arrivalPos = arrival.clone();

      // arrival momentum: keep the crossing direction, clamp speed sane
      const hv = new THREE.Vector3(prevVel.x, 0, prevVel.z);
      if (hv.length() > PORTAL_MAX_ARRIVAL_SPEED) hv.setLength(PORTAL_MAX_ARRIVAL_SPEED);
      player.place(arrival, axz.yaw, new THREE.Vector3(hv.x, 0, hv.z));

      // pin streaming to the arrival point until the camera rig converges
      // (released in update()); without this the stale camera position would
      // teleport the ChunkStream back and unload the ground under the player
      this.focusPin = arrival.clone();
      this.engine.streamFocus = this.focusPin;

      this.coord = { ...to };
      this.transitions++;
      this.lastArrival = { coord: { ...to }, pos: arrival.clone(), edge: ctx.arrivedEdge };
      // FAST-TRAVEL: first arrival on a map discovers its portal — walked
      // and fast-travel arrivals record identically (same call site).
      this.recordDiscovery(to);

      await this.hooks.onAfterTransition?.(ctx);
      console.debug('[portals] transition: reveal');
      mark('reveal-start');
      await this.overlay?.reveal();
      mark('done');
      console.debug('[portals] transition: done');
    } finally {
      if (id === this.seq) {
        this.transitioning = false;
        this.trigger.unlock(typeof performance !== 'undefined' ? performance.now() : 0);
      }
    }
  }
}
