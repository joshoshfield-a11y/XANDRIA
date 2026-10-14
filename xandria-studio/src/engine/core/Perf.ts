/**
 * PerfMonitor — thin per-frame performance instrumentation for the engine.
 *
 * Audit W0 banned adaptation-before-instrumentation: this monitor only
 * *records* (frame time + rolling variance, renderer.info counters, physics
 * step cost). It never changes quality on its own. The future
 * PerformanceManager (W3.3) consumes these numbers via engine.perf.
 *
 * Hot loop is allocation-free: one preallocated Float64Array ring buffer +
 * scalar counters. Sampling can be killed entirely with enabled=false (then
 * the engine takes a single branch per frame and every counter reads 0).
 *
 * frameMs is wall-clock time spent inside Engine.step() (sim + render), NOT
 * the RAF-to-RAF interval — it excludes browser idle between frames, so it
 * is the number a future budget compares against. Wall-clock is deliberate:
 * perf is instrumentation of real cost, never sim state (determinism of the
 * sim itself is untouched — testMode still steps fixed 1/60 dt).
 */
export interface RendererInfoLike {
  render: { calls: number; triangles: number };
  memory: { geometries: number; textures: number };
  /** three r182: programCache.programs (array) after a render, null before the first one */
  programs: { length: number } | null;
}

/** Plain-object copy of the counters — safe to JSON/structured-clone for console automation. */
export interface PerfSnapshot {
  /** rolling mean of Engine.step() wall time, ms (120-frame window) */
  frameMs: number;
  /** population variance of the frame-time window, ms^2 (sqrt = stddev) */
  frameMsVariance: number;
  /** 1000 / frameMs */
  fps: number;
  /** renderer.info.render.calls for the last frame (all composer passes) */
  drawCalls: number;
  /** renderer.info.render.triangles for the last frame */
  triangles: number;
  /** renderer.info.memory.geometries (allocated GL geometries) */
  geometries: number;
  /** renderer.info.memory.textures (allocated GL textures) */
  textures: number;
  /** renderer.info.programs.length (compiled programs) */
  programs: number;
  /** wall time spent inside physics.step() this frame, ms (summed over substeps) */
  physicsMs: number;
  /** sampled frames since construction / last reset() */
  frames: number;
  /** stage-1 B: terrain chunk physics bodies currently paged in */
  chunksLoaded: number;
  /** stage-1 B: EMA of per-chunk build time, ms (instrumentation only) */
  chunkBuildMs: number;
  /** stage-1 B: chunk builds queued by the streaming budget */
  streamQueue: number;
}

/** Rolling window for frameMs / frameMsVariance. */
const WINDOW = 120;

export class PerfMonitor {
  /** Kill switch. false => sample() is a no-op and the engine skips all timing. */
  enabled = true;

  frameMs = 0;
  frameMsVariance = 0;
  fps = 0;
  drawCalls = 0;
  triangles = 0;
  geometries = 0;
  textures = 0;
  programs = 0;
  physicsMs = 0;
  frames = 0;
  /** stage-1 B: terrain chunk physics bodies currently paged in */
  chunksLoaded = 0;
  /** stage-1 B: EMA of per-chunk build time, ms (instrumentation only) */
  chunkBuildMs = 0;
  /** stage-1 B: chunk builds queued by the streaming budget */
  streamQueue = 0;

  /** Ring buffer of per-frame step() durations (ms). Preallocated once. */
  private readonly samples = new Float64Array(WINDOW);
  private head = 0;
  private count = 0;

  /**
   * Record one rendered frame. Called once per Engine.step() when enabled.
   * Allocation-free: no objects, no closures, no array growth.
   */
  sample(frameWorkMs: number, physicsMs: number, info?: RendererInfoLike | null): void {
    if (!this.enabled) return;
    this.samples[this.head] = frameWorkMs;
    this.head = (this.head + 1) % WINDOW;
    if (this.count < WINDOW) this.count++;
    // Rolling mean + population variance, two passes over the window
    // (<=120 iterations — sub-microsecond, no Welford state to keep honest
    // across resets).
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.samples[i];
    const mean = sum / this.count;
    let v = 0;
    for (let i = 0; i < this.count; i++) {
      const d = this.samples[i] - mean;
      v += d * d;
    }
    this.frameMs = mean;
    this.frameMsVariance = v / this.count;
    this.fps = mean > 0 ? 1000 / mean : 0;
    this.physicsMs = physicsMs;
    if (info) {
      this.drawCalls = info.render.calls;
      this.triangles = info.render.triangles;
      this.geometries = info.memory.geometries;
      this.textures = info.memory.textures;
      this.programs = info.programs ? info.programs.length : 0;
    }
    this.frames++;
  }

  /** Clear every counter and the rolling window (in-place restart starts a fresh measurement). */
  reset(): void {
    this.frameMs = 0;
    this.frameMsVariance = 0;
    this.fps = 0;
    this.drawCalls = 0;
    this.triangles = 0;
    this.geometries = 0;
    this.textures = 0;
    this.programs = 0;
    this.physicsMs = 0;
    this.frames = 0;
    this.chunksLoaded = 0;
    this.chunkBuildMs = 0;
    this.streamQueue = 0;
    this.samples.fill(0);
    this.head = 0;
    this.count = 0;
  }

  /**
   * Stage-1 B: record one frame's streaming counters. Called by Engine.step
   * after terrain.update(); read-only instrumentation (no adaptation).
   */
  sampleStream(chunksLoaded: number, chunkBuildMs: number, streamQueue: number): void {
    if (!this.enabled) return;
    this.chunksLoaded = chunksLoaded;
    this.chunkBuildMs = chunkBuildMs;
    this.streamQueue = streamQueue;
  }

  /** Plain-object copy of the counters for console/JSON consumers (allocates — not for the hot loop). */
  snapshot(): PerfSnapshot {
    return {
      frameMs: this.frameMs,
      frameMsVariance: this.frameMsVariance,
      fps: this.fps,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      geometries: this.geometries,
      textures: this.textures,
      programs: this.programs,
      physicsMs: this.physicsMs,
      frames: this.frames,
      chunksLoaded: this.chunksLoaded,
      chunkBuildMs: this.chunkBuildMs,
      streamQueue: this.streamQueue,
    };
  }
}
