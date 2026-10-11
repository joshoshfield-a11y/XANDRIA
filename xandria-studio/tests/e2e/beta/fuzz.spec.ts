/**
 * Beta workstream B — fuzzing + robustness.
 *
 * Part 1: intent fuzzer — 20 HARDCODED intents (deterministic, no randomness),
 *   each booted via /player.html?test=1&intent=<encoded>.
 * Part 2: input monkey — per genre, 60s of random injected input at ~300ms
 *   cadence from mulberry32(fixed seed per genre), then nanScan + error drain.
 * Part 3: NaN sweep — lib.nanScan() after every monkey run.
 *
 * PASS criteria (part 1): no pageerror, no console error, no engine errors,
 *   AND state reaches 'playing' with a spec genre in the 5 known genres.
 *   The generator never "fails" by design: unmatched intents fall back to
 *   'third-person-action' (generate.ts: `genre ??= 'third-person-action'`),
 *   and an empty intent param is falsy so the default demo spec is used.
 *   So "fails gracefully" here = boots playing with a valid fallback genre
 *   and zero errors. A pageerror/throw or a never-playing state = FAIL.
 *
 * Writes JSON summaries to tests/e2e/beta/results/ for workstream E.
 */
import { test } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GENRES, boot, attachErrorCapture, drainEngineErrors, readWorld, nanScan, mulberry32,
} from './lib';

const RESULTS_DIR = join('tests', 'e2e', 'beta', 'results');
const KNOWN_GENRES = ['third-person-action', 'fps-arena', 'racing', 'platformer', 'top-down-shooter'];

function ensureResultsDir(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
}

function writeJson(name: string, data: unknown): void {
  ensureResultsDir();
  writeFileSync(join(RESULTS_DIR, name), JSON.stringify(data, null, 2) + '\n');
}

const GRACEFUL_NOTE =
  'Generator keyword-matches intent against GENRE_KEYS with word-boundary regex; ' +
  'unmatched intents fall back to third-person-action (generate.ts: `genre ??= \'third-person-action\'`); ' +
  'an empty intent param is falsy so resolveSpec() uses the built-in demo spec. ' +
  '"Fails gracefully" = reaches state \'playing\' with a valid spec genre and zero errors.';

// ---------------------------------------------------------------------------
// Part 1: intent fuzzer
// ---------------------------------------------------------------------------

const INTENTS: string[] = [
  'blorpt zzz',                                        // nonsense words
  'word '.repeat(100),                                 // exactly 500 chars
  '🏎️💥 赛车',                                          // emoji + CJK
  'racing shooter platformer cooking sim',             // contradictory genres
  "'; DROP TABLE",                                     // SQL-ish
  '<script>alert(1)</script>',                         // HTML/JS injection
  '   ',                                               // whitespace-only
  '',                                                  // empty string
  '12345',                                             // digits only
  'first person doom quake deathmatch arena shooter race grand prix f1 kart drift twin stick horde top down overhead sidescroll mario jumping samurai ninja rpg quest explore sword', // all keywords (racing wins by key order)
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',     // repeated char, no word boundaries
  'racing\n\tdrift\t\ncar',                           // control characters
  'undefined',                                         // JS-literal-ish
  'null',
  '{"json": true, not valid json}',                    // malformed JSON-ish
  '../../etc/passwd',                                  // path-traversal-ish
  'cooking sim bake a cake',                           // unmappable -> fallback genre
  'https://example.com/game?mode=race&laps=3',         // URL with reserved chars
  'sword adventure in ancient ruins',                  // valid control intent
  '<img src=x onerror=alert(1)>',                      // HTML event-handler injection
];

interface IntentResult {
  intent: string;
  outcome: 'pass' | 'fail';
  genre?: string;
  note: string;
  errors: string[];
}

const intentResults: IntentResult[] = [];

/**
 * Persist one intent result incrementally (read-modify-write, idempotent).
 * Survives worker restarts: module-level state may be lost, the file is not.
 */
function recordIntent(r: IntentResult): void {
  ensureResultsDir();
  const p = join(RESULTS_DIR, 'fuzz-intents.json');
  let cur: any = null;
  try { cur = JSON.parse(readFileSync(p, 'utf8')); } catch { cur = null; }
  const intents: any[] = Array.isArray(cur?.intents) ? cur.intents : [];
  const entry = {
    intent: r.intent,
    outcome: r.outcome,
    ...(r.genre ? { genre: r.genre } : {}),
    note: r.note,
    errors: r.errors.slice(0, 5),
  };
  const i = intents.findIndex((x: any) => x?.intent === r.intent);
  if (i >= 0) intents[i] = entry; else intents.push(entry);
  const passed = intents.filter((x: any) => x.outcome === 'pass').length;
  writeFileSync(p, JSON.stringify({
    suite: 'fuzz',
    name: 'intent-fuzzer',
    passed: intents.length === INTENTS.length && passed === INTENTS.length,
    durationMs: 0, // per-intent durations are in each entry's note
    metrics: { total: INTENTS.length, passed, failed: intents.length - passed },
    errors: [...new Set(intents.flatMap((x: any) => x.errors ?? []))].slice(0, 20) as string[],
    notes: GRACEFUL_NOTE,
    intents: intents.map(({ errors: _e, ...rest }: any) => rest),
  }, null, 2) + '\n');
}

test.describe('B1 intent fuzzer', () => {
  test.describe.configure({ timeout: 120_000 });
  for (const intent of INTENTS) {
    const label = JSON.stringify(intent.length > 40 ? intent.slice(0, 37) + '…' : intent);
    test(`intent ${label}`, async ({ page }) => {
      test.setTimeout(120_000);
      const { errors } = attachErrorCapture(page);
      const t0 = Date.now();
      await page.goto(`/player.html?test=1&intent=${encodeURIComponent(intent)}`, { waitUntil: 'load' });

      let outcome: 'pass' | 'fail' = 'pass';
      let genre: string | undefined;
      let note = '';
      try {
        await page.waitForFunction(
          () => (window as any).__XANDRIA__?.engine?.state === 'playing',
          null, { timeout: 30000 },
        );
      } catch {
        outcome = 'fail';
        note = 'never reached state=playing within 30s';
      }

      const engineErrs: string[] = await page.evaluate(
        () => (window as any).__XANDRIA_ERRORS ?? [],
      ).catch(() => ['<could not read __XANDRIA_ERRORS>']);
      const allErrors = [...errors, ...engineErrs.map((e) => '[engine] ' + e)];

      if (outcome === 'pass') {
        genre = await page.evaluate(() => (window as any).__XANDRIA__.spec?.meta?.genre)
          .catch(() => undefined);
        if (!KNOWN_GENRES.includes(genre ?? '')) {
          outcome = 'fail';
          note = `invalid/unknown spec genre: ${JSON.stringify(genre)}`;
        } else if (allErrors.length > 0) {
          outcome = 'fail';
          note = 'errors during boot: ' + allErrors.slice(0, 3).join(' | ').slice(0, 300);
        } else {
          note = `reached playing; spec genre=${genre}`;
        }
      }

      const result: IntentResult = {
        intent,
        outcome,
        genre,
        note: note + ` (${Date.now() - t0}ms)`,
        errors: allErrors.slice(0, 5),
      };
      intentResults.push(result);
      recordIntent(result); // incremental: survives worker restarts
    });
  }

  test.afterAll(async () => {
    // Merge module-level results over whatever is on disk (a worker restart
    // may have run only a subset of tests in this process).
    ensureResultsDir();
    const p = join(RESULTS_DIR, 'fuzz-intents.json');
    let cur: any = null;
    try { cur = JSON.parse(readFileSync(p, 'utf8')); } catch { cur = null; }
    const merged: any[] = Array.isArray(cur?.intents) ? cur.intents : [];
    for (const r of intentResults) {
      const entry = {
        intent: r.intent, outcome: r.outcome,
        ...(r.genre ? { genre: r.genre } : {}), note: r.note,
      };
      const i = merged.findIndex((x: any) => x?.intent === r.intent);
      if (i >= 0) merged[i] = entry; else merged.push(entry);
    }
    const passed = merged.filter((x: any) => x.outcome === 'pass').length;
    writeJson('fuzz-intents.json', {
      suite: 'fuzz',
      name: 'intent-fuzzer',
      passed: merged.length === INTENTS.length && passed === INTENTS.length,
      durationMs: 0, // per-intent durations are in each entry's note
      metrics: { total: INTENTS.length, passed, failed: merged.length - passed },
      errors: [...new Set(intentResults.flatMap((r) => r.errors))].slice(0, 20) as string[],
      notes: GRACEFUL_NOTE,
      intents: merged,
    });
  });
});

// ---------------------------------------------------------------------------
// Part 2+3: input monkey + NaN sweep, per genre
// ---------------------------------------------------------------------------

// 'pause' toggles the pause menu (engine stalls -> sim-advancing check becomes
// meaningless) and 'reset' rebuilds the run (frame counter resets). Both are
// valid actions but excluded from the monkey pool for that reason; the invalid
// action probe below covers unexpected-input behavior separately.
const MONKEY_POOL = [
  'forward', 'back', 'left', 'right', 'jump', 'sprint', 'dash',
  'attack', 'attack2', 'interact', 'boost', 'brake', 'confirm',
  'weapon1', 'weapon2',
];

const MONKEY_MS = 60_000;
const CADENCE_MS = 300;

test.describe('B2 input monkey + NaN sweep', () => {
  // 240s covers fixture (browser context) setup too: under load, context
  // creation alone can exceed the 90s default (saw this kill the platformer
  // monkey once when a parallel workstream saturated the 2 vCPUs).
  test.describe.configure({ timeout: 240_000 });
  GENRES.forEach((g, gi) => {
    test(`monkey ${g.name}`, async ({ page }) => {
      test.setTimeout(240_000);
      const t0 = Date.now();
      const { errors } = attachErrorCapture(page);
      await boot(page, g.intent, g.genre);

      const rng = mulberry32(1000 + gi); // fixed seed per genre -> reproducible
      const frame0 = (await readWorld(page)).frame;
      let injections = 0;
      const deadline = Date.now() + MONKEY_MS;
      while (Date.now() < deadline) {
        const n = Math.floor(rng() * 4); // 0-3 actions
        const combo: string[] = [];
        for (let i = 0; i < n; i++) combo.push(MONKEY_POOL[Math.floor(rng() * MONKEY_POOL.length)]);
        const uniq = [...new Set(combo)];
        const axes = { lx: rng() * 2 - 1, ly: rng() * 2 - 1 };
        await page.evaluate(
          ([a, ax]) => (window as any).__XANDRIA__.engine.input.inject(a, ax),
          [uniq, axes],
        );
        injections++;
        await page.waitForTimeout(CADENCE_MS);
      }

      // settle with input released, then check the sim is still advancing
      await page.evaluate(() => (window as any).__XANDRIA__.engine.input.inject([], null));
      const frameEnd = (await readWorld(page)).frame;
      const nanFindings = await nanScan(page);
      await drainEngineErrors(page, errors);
      const advancing = frameEnd > frame0;
      const passed = errors.length === 0 && nanFindings.length === 0 && advancing;
      if (!passed) {
        console.error(
          `[monkey ${g.name}] FAIL errors=${errors.length} nan=${nanFindings.length} advancing=${advancing}`,
          JSON.stringify({ errors: errors.slice(0, 5), nanFindings }),
        );
      }

      writeJson(`fuzz-monkey-${g.name}.json`, {
        suite: 'fuzz',
        name: 'input-monkey',
        genre: g.name,
        passed,
        durationMs: Date.now() - t0,
        metrics: { injections, nanFindings: nanFindings.length },
        errors: errors.slice(0, 20),
        notes:
          `mulberry32 seed=${1000 + gi}; ~${CADENCE_MS}ms cadence for ${MONKEY_MS / 1000}s; ` +
          `'pause'/'reset' excluded from the action pool (pause stalls the sim, reset rebuilds the run); ` +
          `frame ${frame0} -> ${frameEnd} (advancing=${advancing}); ` +
          `nanScan paths: ${nanFindings.length ? JSON.stringify(nanFindings) : 'none'}.`,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Invalid action probe (report-only, no assertions)
// ---------------------------------------------------------------------------

test.describe('B2b invalid action probe', () => {
  test.describe.configure({ timeout: 120_000 });
  test('injecting unknown action fly_away', async ({ page }) => {
    const t0 = Date.now();
    const { errors } = attachErrorCapture(page);
    await boot(page, GENRES[2].intent, GENRES[2].genre); // racing
    const probe = await page.evaluate(async () => {
      const X = (window as any).__XANDRIA__;
      const input = X.engine.input;
      const errsBefore = ((window as any).__XANDRIA_ERRORS as string[]).length;
      let threw: string | null = null;
      try {
        input.inject(['fly_away'], { lx: 0.5, ly: -0.5 });
      } catch (e) {
        threw = String((e as Error)?.message ?? e);
      }
      await new Promise((r) => setTimeout(r, 2000));
      const stillThere = (() => {
        try { return !!(input as any).injected?.has?.('fly_away'); } catch { return 'unknown'; }
      })();
      let pressedThrows: string | null = null;
      let pressedVal: unknown = 'unknown';
      try { pressedVal = input.pressed('fly_away'); } catch (e) { pressedThrows = String((e as Error)?.message ?? e); }
      input.inject([], null);
      return {
        threw,
        stillInjectedAfter2s: stillThere,
        pressedResult: pressedVal,
        pressedThrows,
        errorsDelta: ((window as any).__XANDRIA_ERRORS as string[]).length - errsBefore,
        state: X.engine.state,
      };
    });
    await drainEngineErrors(page, errors);
    console.log('[invalid-action-probe] ' + JSON.stringify(probe));
    console.log('[invalid-action-probe] capturedErrors=' + JSON.stringify(errors.slice(0, 5)));
    writeJson('fuzz-invalid-action-probe.json', {
      suite: 'fuzz',
      name: 'invalid-action-probe',
      genre: 'racing',
      passed: true, // report-only: no assertions by design
      durationMs: Date.now() - t0,
      metrics: { injections: 1, nanFindings: 0 },
      errors: errors.slice(0, 20),
      notes:
        'Injected unknown action "fly_away" via engine.input.inject(). ' +
        'Input.inject() does no validation: the name lands in the injected set ' +
        'and input.pressed("fly_away") would return true, but no blueprint ' +
        'queries it, so it is silently ignored. Report-only, no assertions.',
      probe,
    });
  });
});
