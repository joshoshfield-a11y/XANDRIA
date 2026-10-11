/**
 * Beta workstream C — performance regression baselines.
 *
 * For each of the 5 genres x 3 quality tiers (15 combos): boot with the tier
 * forced via pre-boot localStorage seed (see notes below), let the idle scene
 * settle 5s, run a 20s warmup, then measure per-frame rAF delta times for a
 * 150s collection window (up to 120 frames). Median frame time per combo is
 * recorded. A combo is valid only if >= MIN_FRAMES frames were captured.
 *
 * Baseline: tests/e2e/perf-baseline.json. If absent, this run ESTABLISHES it
 * and passes (only when all 15 combos completed). If present, a combo FAILS
 * when its median regresses >25% vs the baseline ((new-old)/old > 0.25).
 * Improvements never fail.
 *
 * Results for the workstream-E harness: tests/e2e/beta/results/perf.json.
 *
 * QUALITY-FORCING MECHANISM (verified by code inspection):
 * Engine reads effective quality at CONSTRUCTION from
 *   engine.settings.data.quality   ('auto' -> falls back to spec.custom.quality hint)
 * Settings reads localStorage key 'xandria.settings.v1' in its constructor.
 * The player bundle is a deferred ES module, so page.addInitScript() (runs
 * before any page script) can seed localStorage and the Engine picks the tier
 * up at construction time: renderer creation, setPixelRatio, sky, shadow map
 * resolution, and effectiveQuality() all see it. The spec asserts
 * effectiveQuality() === tier after boot.
 * Caveat: the WebGLRenderer's `antialias` flag is decided from the SPEC hint
 * (spec.custom.quality), not the settings override, so AA stays whatever the
 * genre's spec hint says even when the tier is forced. Documented as a known
 * measurement blind spot.
 *
 * SWIFT-SHADER / CONTENTION CAVEATS: headless SwiftShader renders at ~3fps
 * on a quiet 2-vCPU box, so absolute ms numbers are meaningless — only
 * relative deltas vs baseline count. In ?test=1 the sim dt is fixed at 1/60
 * with 10 substeps/frame, so sim cost is constant and the rAF delta mainly
 * tracks render cost + compositor scheduling jitter. This run shared the box
 * with sibling beta workstreams (bots/fuzz/soak), so collection is TIME-boxed
 * (90s) instead of frame-count-boxed: frame counts vary with machine load.
 * Recorded load average is stored in the baseline notes for comparison runs.
 */
import { test, expect } from '@playwright/test';
import { GENRES } from './lib';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadavg } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

const TIERS = ['high', 'standard', 'retro'] as const;
const EXPECTED = GENRES.length * TIERS.length; // 15
const SETTLE_MS = 5000;
const WARMUP_MS = 20_000;
const COLLECT_MS = 150_000; // long window: usable frame counts even under box contention
const FRAME_CAP = 120;
const MIN_FRAMES = 30;
const REGRESSION_THRESHOLD = 0.25;
const SETTINGS_KEY = 'xandria.settings.v1';

const BASELINE_PATH = resolve(HERE, '..', 'perf-baseline.json');
const RESULTS_DIR = resolve(HERE, 'results');
const RESULTS_PATH = resolve(RESULTS_DIR, 'perf.json');
// Append-only per-combo log: each completed combo writes one JSON line here
// immediately, so an interrupted run (killed worker, VM restart) keeps its
// progress. Re-runs skip combos already logged. Merge/dedupe in afterAll.
const COMBO_LOG = resolve(RESULTS_DIR, 'perf-combos.jsonl');

test.setTimeout(600_000);

interface ComboResult {
  medianMs: number;
  frames: number;
  effectiveQuality: string;
  baselineMs: number | null;
  deltaPct: number | null;
  pass: boolean;
  error: string | null;
}

const results: Record<string, ComboResult> = {};
const suiteErrors: string[] = [];
const notes: string[] = [];
const suiteStart = Date.now();
let baselineExistedAtStart = false;
let loadAvg: number[] = [];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function loadBaseline(): Record<string, { medianMs: number; frames: number }> {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).combos ?? {};
}

function readComboLog(): Record<string, ComboResult> {
  const out: Record<string, ComboResult> = {};
  if (!existsSync(COMBO_LOG)) return out;
  for (const line of readFileSync(COMBO_LOG, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as ComboResult & { key: string };
      out[r.key] = r; // last write wins
    } catch { /* ignore corrupt lines */ }
  }
  return out;
}

test.beforeAll(async () => {
  baselineExistedAtStart = existsSync(BASELINE_PATH);
  loadAvg = loadavg();
  mkdirSync(RESULTS_DIR, { recursive: true });
});

for (const g of GENRES) {
  for (const tier of TIERS) {
    const key = `${g.name}/${tier}`;
    test(`perf ${key}`, async ({ page }) => {
      // Resume: skip combos already captured in a previous (interrupted) run.
      if (readComboLog()[key]?.frames >= MIN_FRAMES) {
        test.skip(true, `already measured in ${COMBO_LOG}`);
      }
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

      // Force the quality tier BEFORE boot: Settings reads this localStorage
      // key at Engine construction time.
      await page.addInitScript(
        ({ k, q }: { k: string; q: string }) => {
          localStorage.setItem(k, JSON.stringify({ volume: 0.8, muted: true, quality: q }));
        },
        { k: SETTINGS_KEY, q: tier },
      );

      await page.goto(`/player.html?test=1&intent=${encodeURIComponent(g.intent)}`, { waitUntil: 'load' });
      await page.waitForFunction(
        () => (window as any).__XANDRIA__?.engine?.state === 'playing', null, { timeout: 120_000 });
      const genre = await page.evaluate(() => (window as any).__XANDRIA__.spec.meta.genre);
      expect(genre).toBe(g.genre);
      const effectiveQuality: string = await page.evaluate(
        () => (window as any).__XANDRIA__.engine.effectiveQuality());
      expect(effectiveQuality, `effectiveQuality should be forced to ${tier}`).toBe(tier);

      // Settle: shader compile / first frames land before measuring.
      await page.waitForTimeout(SETTLE_MS);

      // rAF delta hook: time between consecutive rAF callbacks ≈ one rendered frame.
      await page.evaluate(() => {
        (window as any).__PERF = { deltas: [] as number[], warm: false };
        let last = performance.now();
        const hook = () => {
          const now = performance.now();
          (window as any).__PERF.deltas.push(now - last);
          last = now;
          requestAnimationFrame(hook);
        };
        requestAnimationFrame(hook);
      });

      // Warmup (discarded): wall-clock based so collection can't stall.
      await page.waitForTimeout(WARMUP_MS);
      await page.evaluate(() => { (window as any).__PERF.deltas = []; });

      // Collection window: time-boxed, cap frames.
      await page.waitForTimeout(COLLECT_MS);
      const deltas: number[] = await page.evaluate(
        (cap: number) => (window as any).__PERF.deltas.slice(0, cap), FRAME_CAP);

      const frames = deltas.length;
      const med = frames > 0 ? median(deltas) : NaN;
      const baseline = loadBaseline();
      const base = baseline[key];
      let baselineMs: number | null = null;
      let deltaPct: number | null = null;
      let pass = true;
      let error: string | null = errors.length ? errors.join(' | ') : null;
      if (frames < MIN_FRAMES) {
        pass = false;
        error = (error ? error + ' | ' : '') + `only ${frames} frames captured (< ${MIN_FRAMES})`;
      } else if (base && Number.isFinite(med)) {
        baselineMs = base.medianMs;
        deltaPct = (med - base.medianMs) / base.medianMs;
        if (deltaPct > REGRESSION_THRESHOLD) pass = false;
      }
      const rec: ComboResult = {
        medianMs: Number.isFinite(med) ? Math.round(med * 100) / 100 : NaN,
        frames,
        effectiveQuality,
        baselineMs,
        deltaPct: deltaPct === null ? null : Math.round(deltaPct * 10000) / 10000,
        pass,
        error,
      };
      results[key] = rec;
      appendFileSync(COMBO_LOG, JSON.stringify({ key, ...rec }) + '\n');
      if (error) suiteErrors.push(`${key}: ${error}`);
      expect(frames, `${key}: only ${frames} frames in ${COLLECT_MS / 1000}s window`).toBeGreaterThanOrEqual(MIN_FRAMES);
      if (base && Number.isFinite(med) && deltaPct !== null) {
        expect(deltaPct, `${key} median regressed >25% vs baseline (${med.toFixed(1)}ms vs ${base.medianMs.toFixed(1)}ms)`).toBeLessThanOrEqual(REGRESSION_THRESHOLD);
      }
    });
  }
}

test.afterAll(async () => {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const durationMs = Date.now() - suiteStart;
  // Merge this run's in-memory results with the append-only log from any
  // earlier (interrupted) runs. Log wins on conflict — it holds completed combos.
  const merged: Record<string, ComboResult> = { ...results, ...readComboLog() };
  const keys = Object.keys(merged);
  const complete = keys.length === EXPECTED && keys.every((k) => merged[k]?.frames >= MIN_FRAMES);
  const passed = complete && Object.values(merged).every((r) => r.pass && r.error === null);

  let baselineNote = 'compared against existing baseline';
  if (!baselineExistedAtStart) {
    if (complete) {
      const combos: Record<string, { medianMs: number; frames: number }> = {};
      for (const [k, r] of Object.entries(merged)) combos[k] = { medianMs: r.medianMs, frames: r.frames };
      let commit = 'unknown';
      try {
        commit = execSync('git rev-parse --short HEAD', { cwd: resolve(HERE, '..', '..', '..', '..') }).toString().trim();
      } catch { /* ignore */ }
      writeFileSync(BASELINE_PATH, JSON.stringify({
        generatedAt: new Date().toISOString(),
        commit,
        loadAvg1m: Math.round(loadAvg[0] * 100) / 100,
        combos,
      }, null, 2) + '\n');
      baselineNote = 'baseline established';
    } else {
      baselineNote = `baseline NOT established (only ${keys.length}/${EXPECTED} combos completed)`;
    }
  }
  notes.push(baselineNote);
  notes.push(`measurement: rAF delta hook; 20s warmup discarded; 150s collection window, up to ${FRAME_CAP} frames, median reported; valid combo needs >= ${MIN_FRAMES} frames`);
  notes.push('SwiftShader headless: absolute ms are meaningless; only relative deltas vs baseline count');
  notes.push(`machine load at suite start (1/5/15m): ${loadAvg.map((v) => v.toFixed(2)).join('/')} — sibling beta workstreams shared this box; compare future runs at similar load`);
  notes.push('quality forced pre-boot via localStorage seed (xandria.settings.v1); renderer AA flag still follows the spec hint (known blind spot)');
  notes.push('idle scene, same intent per genre, no input during measurement; ?test=1 fixed 1/60 sim dt; generator deterministic per intent');

  writeFileSync(RESULTS_PATH, JSON.stringify({
    suite: 'perf',
    name: 'perf-regression',
    passed,
    durationMs,
    metrics: {
      combos: Object.fromEntries(Object.entries(merged).map(([k, r]) => [k, {
        medianMs: r.medianMs,
        baselineMs: r.baselineMs,
        deltaPct: r.deltaPct,
        pass: r.pass,
      }])),
    },
    errors: suiteErrors,
    notes,
  }, null, 2) + '\n');
});
