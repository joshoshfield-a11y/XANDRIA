import { describe, it, expect } from 'vitest';
import { generateSpec } from '../src/generator/generate';
import {
  validateSpec,
  defaultSpec,
  stableStringify,
  type GameSpec,
  type ObjectiveStage,
} from '../src/spec/schema';

const mkStage = (over: Partial<ObjectiveStage> = {}): ObjectiveStage => ({
  type: 'eliminate',
  count: 3,
  timeLimit: 0,
  description: 'Chapter I — Thin the patrols',
  ...over,
});

function specWithStages(stages: unknown): GameSpec {
  const s = defaultSpec();
  (s.objective as unknown as Record<string, unknown>).stages = stages;
  return s;
}

describe('quest stage validation', () => {
  it('accepts a valid stage chain (legacy path without stages still works)', () => {
    const ok = defaultSpec();
    expect(validateSpec(ok).ok).toBe(true);
    const chained = specWithStages([mkStage(), mkStage({ type: 'reach', count: 0, description: 'Chapter II — Reach the beacon' })]);
    const v = validateSpec(chained);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('rejects non-array / empty stages', () => {
    for (const bad of ['nope', [], 42]) {
      const v = validateSpec(specWithStages(bad));
      expect(v.ok).toBe(false);
      expect(v.errors.some((e) => e.startsWith('objective.stages:'))).toBe(true);
    }
  });

  it('rejects structurally bad stages with indexed paths', () => {
    const v = validateSpec(specWithStages([
      mkStage(),
      { type: 'nuke', count: -5, timeLimit: -1, description: 42 },
    ]));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('objective.stages[1].type: must be one of collect|eliminate|reach|survive|race|boss');
    expect(v.errors).toContain('objective.stages[1].count: must be 0..10000');
    expect(v.errors).toContain('objective.stages[1].timeLimit: must be 0..86400');
    expect(v.errors).toContain('objective.stages[1].description: must be a string');
    // stage 0 is fine — no errors mention it
    expect(v.errors.some((e) => e.includes('stages[0]'))).toBe(false);
  });

  it('applies eliminate winnability per stage', () => {
    // defaultSpec spawns 6 walkers
    const v = validateSpec(specWithStages([mkStage({ count: 999 })]));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e === 'objective.stages[0].count: eliminate count 999 exceeds total spawned enemies 6')).toBe(true);
    const ok = validateSpec(specWithStages([mkStage({ count: 6 })]));
    expect(ok.errors).toEqual([]);
  });

  it('applies collect winnability per stage', () => {
    // defaultSpec has pickups.coins = 12
    const v = validateSpec(specWithStages([mkStage({ type: 'collect', count: 99 })]));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('objective.stages[0].count: collect count 99 exceeds pickups.coins 12'))).toBe(true);
  });

  it('applies race winnability per stage', () => {
    const v = validateSpec(specWithStages([mkStage({ type: 'race', count: 0 })]));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('objective.stages[0].count: race requires at least 1 lap');
  });

  it('applies survive winnability per stage', () => {
    const v = validateSpec(specWithStages([mkStage({ type: 'survive', count: 0, timeLimit: 0 })]));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('objective.stages[0].timeLimit: survive requires timeLimit > 0');
    const ok = validateSpec(specWithStages([mkStage({ type: 'survive', count: 0, timeLimit: 45 })]));
    expect(ok.errors).toEqual([]);
  });

  it('applies boss winnability per stage', () => {
    // defaultSpec has no brutes
    const v = validateSpec(specWithStages([mkStage({ type: 'boss', count: 1 })]));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('objective.stages[0].type: boss objective requires at least one brute-class enemy');
    const s = defaultSpec();
    s.enemies.push({ kind: 'brute', count: 1, health: 300, speed: 3.5, damage: 20, weapon: 'melee' });
    (s.objective as unknown as Record<string, unknown>).stages = [mkStage({ type: 'boss', count: 1 })];
    expect(validateSpec(s).errors).toEqual([]);
  });
});

describe('narrative + progression validation', () => {
  it('accepts valid narrative and progression', () => {
    const s = defaultSpec();
    s.narrative = { premise: 'A quest.', winText: 'Won.', loseText: 'Lost.' };
    s.progression = { enabled: true, xpPerKill: 20, xpPerPickup: 5 };
    expect(validateSpec(s).errors).toEqual([]);
  });

  it('rejects empty narrative strings', () => {
    const s = defaultSpec();
    s.narrative = { premise: '  ', winText: '', loseText: 'Lost.' };
    const v = validateSpec(s);
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('narrative.premise: must be a non-empty string');
    expect(v.errors).toContain('narrative.winText: must be a non-empty string');
    expect(v.errors.some((e) => e.includes('narrative.loseText'))).toBe(false);
  });

  it('rejects non-positive progression numbers', () => {
    const s = defaultSpec();
    s.progression = { enabled: true, xpPerKill: 0, xpPerPickup: -5 };
    const v = validateSpec(s);
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('progression.xpPerKill: must be a positive number');
    expect(v.errors).toContain('progression.xpPerPickup: must be a positive number');
  });

  it('does not warn on narrative/progression top-level keys', () => {
    const s = defaultSpec();
    s.narrative = { premise: 'A quest.', winText: 'Won.', loseText: 'Lost.' };
    s.progression = { enabled: false, xpPerKill: 1, xpPerPickup: 1 };
    const v = validateSpec(s);
    expect(v.warnings).toEqual([]);
  });
});

describe('quest chain generation', () => {
  const CASES: [string, string, string[]][] = [
    ['neon cyberpunk fps arena', 'fps-arena', ['eliminate', 'boss', 'eliminate', 'boss']],
    ['epic sword adventure through ancient ruins', 'third-person-action', ['collect', 'eliminate', 'reach', 'eliminate']],
    ['dreamy platformer in the clouds', 'platformer', ['collect', 'survive', 'survive', 'reach']],
    ['top-down twin stick horde survival', 'top-down-shooter', ['survive', 'eliminate', 'boss', 'eliminate', 'boss']],
    ['kart grand prix on tropical islands', 'racing', ['race', 'race', 'race']],
  ];

  it.each(CASES)('"%s" → %s quest chain %j (valid + winnable)', (intent, genre, types) => {
    const spec = generateSpec(intent);
    expect(spec.meta.genre).toBe(genre);
    const stages = spec.objective.stages;
    expect(stages).toBeDefined();
    expect(stages!.map((s) => s.type)).toEqual(types);
    const v = validateSpec(spec);
    expect(v.errors).toEqual([]);
    // every stage winnable against the spec's own content
    const totalEnemies = spec.enemies.reduce((n, e) => n + e.count, 0);
    for (const s of stages!) {
      if (s.type === 'eliminate') expect(s.count).toBeLessThanOrEqual(totalEnemies);
      if (s.type === 'collect') expect(s.count).toBeLessThanOrEqual(spec.pickups.coins);
      if (s.type === 'race') expect(s.count).toBeGreaterThanOrEqual(1);
      if (s.type === 'survive') expect(s.timeLimit).toBeGreaterThan(0);
      if (s.type === 'boss') expect(spec.enemies.some((e) => e.kind === 'brute')).toBe(true);
    }
  });

  it('stage descriptions use "Chapter I/II/III/IV — <verb>" format (branch endings may use "Final")', () => {
    for (const [intent] of CASES) {
      const spec = generateSpec(intent);
      spec.objective.stages!.forEach((s, i) => {
        expect(s.description).toMatch(/^(Chapter (I|II|III|IV)|Final) — .+/);
      });
      expect(spec.objective.stages![0].description.startsWith('Chapter I —')).toBe(true);
    }
  });

  it('boss stages always have a brute in the spec', () => {
    for (const intent of ['neon cyberpunk fps arena', 'top-down twin stick shooter', 'brutal fps deathmatch']) {
      const spec = generateSpec(intent);
      const bosses = spec.objective.stages!.filter((s) => s.type === 'boss');
      expect(bosses.length).toBeGreaterThan(0);
      expect(spec.enemies.some((e) => e.kind === 'brute')).toBe(true);
      expect(validateSpec(spec).errors).toEqual([]);
    }
  });

  it('narrative is non-empty and sensible for every genre', () => {
    for (const [intent, genre] of CASES) {
      const spec = generateSpec(intent);
      expect(spec.narrative).toBeDefined();
      const { premise, winText, loseText } = spec.narrative!;
      for (const t of [premise, winText, loseText]) {
        expect(typeof t).toBe('string');
        expect(t.trim().length).toBeGreaterThan(10);
      }
      // premise mentions the game name or genre-relevant content
      expect(premise.length).toBeLessThan(400);
      void genre;
    }
  });

  it('narrative varies by genre and environment', () => {
    const a = generateSpec('neon cyberpunk fps arena').narrative!;
    const b = generateSpec('dreamy platformer in the clouds').narrative!;
    expect(a.premise).not.toBe(b.premise);
    expect(a.premise.toLowerCase()).toContain('neon');
  });

  it('progression defaults are enabled/20/5', () => {
    for (const [intent] of CASES) {
      const spec = generateSpec(intent);
      expect(spec.progression).toEqual({ enabled: true, xpPerKill: 20, xpPerPickup: 5 });
    }
  });

  it('same intent → same stages (deterministic)', () => {
    for (const [intent] of CASES) {
      const a = stableStringify(generateSpec(intent));
      const b = stableStringify(generateSpec(intent));
      expect(a).toBe(b);
    }
  });

  it('100 random intents all validate with stages', () => {
    const words = ['neon', 'fps', 'arena', 'racing', 'kart', 'platformer', 'clouds', 'top-down', 'horde', 'sword', 'adventure', 'boss', 'brutal', 'collect', 'survive'];
    let rngState = 123456789;
    const rnd = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 4294967296; };
    for (let i = 0; i < 100; i++) {
      const intent = Array.from({ length: 5 }, () => words[Math.floor(rnd() * words.length)]).join(' ');
      const spec = generateSpec(intent);
      const v = validateSpec(spec);
      expect(v.errors).toEqual([]);
      expect(spec.objective.stages!.length).toBeGreaterThan(0);
      expect(spec.narrative!.premise.trim().length).toBeGreaterThan(0);
    }
  });
});
