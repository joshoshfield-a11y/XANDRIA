/**
 * prompt-fidelity wave: structured intent extraction, unmapped-intent diff,
 * fulfillment scoring, and graceful degradation.
 *
 * Behavior contract: extraction feeds generateSpec (verified byte-identical
 * by prompt-corpus-parity.test.ts); validateSpec ok/errors are untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  extractIntent, diffIntentVsSpec, scoreSpecFulfillment, scoreIntentVsSpec,
} from '../src/generator/intent';
import { generateSpec } from '../src/generator/generate';
import { validateSpec } from '../src/spec/schema';
import { hashString } from '../src/engine/core/Rng';

describe('extractIntent', () => {
  it('extracts genre cues with scores', () => {
    const i = extractIntent('neon cyberpunk fps arena deathmatch');
    expect(i.genre).toBe('fps-arena');
    expect(i.genreScores[0].key).toBe('fps-arena');
    expect(i.genreScores[0].hits).toBeGreaterThan(0);
    expect(i.genreScores[0].matched).toContain('fps');
  });

  it('extracts biome cues with scores', () => {
    const i = extractIntent('frozen arctic expedition');
    expect(i.environment).toBe('arctic');
    expect(i.environmentScores[0].matched).toContain('arctic');
  });

  it('extracts mechanic keywords', () => {
    const i = extractIntent('epic boss battle with dragons and crafting');
    const ids = i.mechanicCues.map((c) => c.def.id);
    expect(ids).toContain('boss');
    expect(ids).toContain('dragon');
    expect(ids).toContain('crafting');
    expect(i.mechanicCues.find((c) => c.def.id === 'dragon')!.def.supported).toBe(false);
    expect(i.mechanicCues.find((c) => c.def.id === 'boss')!.def.supported).toBe(true);
  });

  it('extracts entity counts', () => {
    const i = extractIntent('tower defense, 6 waves, then race 10 laps');
    expect(i.entityCounts).toContainEqual({ kind: 'waves', n: 6 });
    expect(i.entityCounts).toContainEqual({ kind: 'laps', n: 10 });
    expect(i.towerWavesAsk).toBe(6);
  });

  it('extracts atmosphere cues', () => {
    const i = extractIntent('chill adventure at night in the rain');
    expect(i.moodCue).toBe('chill');
    expect(i.timeOfDayCue).toBe('night');
    expect(i.weatherCue).toBe('rain');
    expect(i.difficulty).toBe('normal');
  });

  it('marks empty / non-text prompts as degraded', () => {
    expect(extractIntent('').degraded).toBe(true);
    expect(extractIntent('   ').degraded).toBe(true);
    expect(extractIntent('🎮🐉🔥💀').degraded).toBe(true);
    expect(extractIntent('!!! ???').degraded).toBe(true);
    expect(extractIntent('asdfghjkl').degraded).toBe(false);
    expect(extractIntent('a game').degraded).toBe(false);
  });

  it('is deterministic', () => {
    const a = JSON.stringify(extractIntent('snowy volcanic racing with a boss battle'));
    const b = JSON.stringify(extractIntent('snowy volcanic racing with a boss battle'));
    expect(a).toBe(b);
  });

  it('never throws on hostile input', () => {
    for (const p of ['', '🎮'.repeat(500), 'a'.repeat(100000), '\\b\\d+[regex]', 'null\x00byte', 'OP-99 ((((']) {
      expect(() => extractIntent(p)).not.toThrow();
    }
  });
});

describe('diffIntentVsSpec', () => {
  const diff = (p: string) => diffIntentVsSpec(extractIntent(p), generateSpec(p));

  it('clean prompt → nothing unmapped', () => {
    expect(diff('neon cyberpunk fps arena deathmatch')).toEqual([]);
  });

  it('reports unsupported mechanics honestly', () => {
    const d = diff('cozy farming sim with dragons');
    const asks = d.map((u) => u.ask);
    expect(asks).toContain('dragons');
    expect(asks).toContain('farming');
    expect(d.find((u) => u.ask === 'dragons')!.supported).toBe(false);
    expect(d.find((u) => u.ask === 'dragons')!.detail).toMatch(/not supported/);
  });

  it('reports supported-but-absent mechanics', () => {
    const d = diff('boss battle racing');
    const boss = d.find((u) => u.ask === 'boss fight');
    expect(boss).toBeDefined();
    expect(boss!.supported).toBe(true);
  });

  it('reports clamped entity counts', () => {
    const d = diff('tower defense, 20 waves, defend the base');
    const waves = d.find((u) => u.ask === '20 waves');
    expect(waves).toBeDefined();
    expect(waves!.detail).toMatch(/8 waves/);
  });

  it('honored entity counts are not reported', () => {
    expect(diff('tower defense, 6 waves, defend the base')).toEqual([]);
  });

  it('reports entity counts that do not apply to the genre', () => {
    const d = diff('snowy volcanic racing with a boss battle and 6 waves');
    expect(d.map((u) => u.ask)).toContain('6 waves');
  });

  it('reports biome cues that lost the vote', () => {
    const d = diff('snowy volcanic racing');
    const arctic = d.find((u) => u.kind === 'biome-cue' && u.ask === 'arctic');
    expect(arctic).toBeDefined();
    expect(arctic!.detail).toMatch(/lost the vote to volcanic/);
  });

  it('reports atmosphere cues overridden by the biome', () => {
    const d = diff('chill volcanic adventure');
    const mood = d.find((u) => u.kind === 'atmosphere-cue');
    expect(mood).toBeDefined();
    expect(mood!.detail).toMatch(/aggressive/);
  });

  it('glide is supported by the engine but never granted', () => {
    const d = diff('adventure with gliding');
    const glide = d.find((u) => u.ask === 'gliding');
    expect(glide).toBeDefined();
    expect(glide!.supported).toBe(true);
  });

  it('degraded prompts diff to nothing (Studio reports the fallback separately)', () => {
    expect(diff('')).toEqual([]);
    expect(diff('🎮🐉')).toEqual([]);
  });
});

describe('fulfillment scoring', () => {
  it('perfect prompt scores 100', () => {
    const f = scoreSpecFulfillment(generateSpec('neon cyberpunk fps arena deathmatch'))!;
    expect(f.score).toBe(100);
    expect(f.unmapped).toEqual([]);
  });

  it('partial prompt scores below 100 with reasons', () => {
    const f = scoreSpecFulfillment(generateSpec('cozy farming sim with dragons'))!;
    expect(f.score).toBeLessThan(100);
    expect(f.total).toBeGreaterThan(0);
    expect(f.mapped + f.unmapped.length).toBe(f.total);
    expect(f.unmapped.map((u) => u.ask)).toContain('dragons');
  });

  it('empty description → undefined (nothing to score)', () => {
    expect(scoreSpecFulfillment({} as any)).toBeUndefined();
    expect(scoreSpecFulfillment({ meta: {} } as any)).toBeUndefined();
    expect(scoreSpecFulfillment(generateSpec(''))).toBeUndefined();
  });

  it('scoreIntentVsSpec is deterministic', () => {
    const s = generateSpec('boss battle racing');
    expect(JSON.stringify(scoreIntentVsSpec(extractIntent('boss battle racing'), s)))
      .toBe(JSON.stringify(scoreIntentVsSpec(extractIntent('boss battle racing'), s)));
  });
});

describe('validateSpec fulfillment (GameValidator report)', () => {
  it('surfaces fulfillment without touching ok/errors/warnings', () => {
    const spec = generateSpec('neon cyberpunk fps arena deathmatch');
    const v = validateSpec(spec);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.fulfillment).toBeDefined();
    expect(v.fulfillment!.score).toBe(100);
  });

  it('low-fidelity prompt still validates (score is advisory)', () => {
    const v = validateSpec(generateSpec('cozy farming sim with dragons'));
    expect(v.ok).toBe(true);
    expect(v.fulfillment!.score).toBeLessThan(100);
  });

  it('hand-built specs without a prompt get no score', () => {
    const spec: any = JSON.parse(JSON.stringify(generateSpec('forest adventure')));
    delete spec.meta.description;
    const v = validateSpec(spec);
    expect(v.ok).toBe(true);
    expect(v.fulfillment).toBeUndefined();
  });
});

describe('graceful degradation', () => {
  const ADVERSARIAL = ['', '   ', 'asdfghjkl qwerty zxcvbnm', '🎮🐉🔥💀👾🛸', 'a'.repeat(5000), 'game', '!!!'];

  it.each(ADVERSARIAL)('"%s" → deterministic valid spec, never an error', (p) => {
    const a = generateSpec(p);
    const b = generateSpec(p);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const v = validateSpec(a);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('empty prompt uses the documented fallback seed', () => {
    expect(generateSpec('').meta.seed).toBe(hashString('xandria'));
  });

  it('nonsense prompts get the default genre + environment', () => {
    for (const p of ['asdfghjkl', '🎮🐉']) {
      const s = generateSpec(p);
      expect(s.meta.genre).toBe('third-person-action');
      expect(s.theme.environment).toBe('forest');
    }
  });
});
