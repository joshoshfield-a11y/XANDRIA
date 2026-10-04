/**
 * Branching quest graphs: schema validation, Objectives sequencer behavior,
 * and generator branch emission. DOM is stubbed (no jsdom here).
 */
import { describe, it, expect, vi } from 'vitest';
import { Objectives } from '../src/engine/game/Objectives';
import type { Engine } from '../src/engine/Engine';
import { generateSpec } from '../src/generator/generate';
import {
  validateSpec,
  normalizeSpec,
  stableStringify,
  defaultSpec,
  type GameSpec,
  type ObjectiveStage,
  type ObjectiveSpec,
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

/* ---------------- schema: quest graph validation ---------------- */

describe('quest graph schema', () => {
  it('accepts linear stages without ids (backward compatible)', () => {
    const v = validateSpec(specWithStages([mkStage(), mkStage({ type: 'reach', count: 0 })]));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('normalizeSpec assigns deterministic ids to id-less stages', () => {
    const s = normalizeSpec(specWithStages([mkStage(), mkStage()]));
    expect(s.objective.stages!.map((x) => x.id)).toEqual(['stage-0', 'stage-1']);
    // idempotent
    const s2 = normalizeSpec(s);
    expect(s2.objective.stages!.map((x) => x.id)).toEqual(['stage-0', 'stage-1']);
  });

  it('rejects a next ref to an unknown stage id', () => {
    const v = validateSpec(specWithStages([
      mkStage({ id: 'a', next: ['b'] }),
      mkStage({ id: 'nope' }),
    ]));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('objective.stages[0].next: unknown stage id "b"');
  });

  it('rejects a choice target pointing at an unknown stage id', () => {
    const v = validateSpec(specWithStages([
      mkStage({ id: 'a', choices: [{ label: 'Go', next: 'ghost' }] }),
      mkStage({ id: 'b' }),
    ]));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('objective.stages[0].choices[0].next: unknown stage id "ghost"');
  });

  it('rejects duplicate stage ids', () => {
    const v = validateSpec(specWithStages([mkStage({ id: 'a' }), mkStage({ id: 'a' })]));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('objective.stages[1].id: duplicate stage id "a"');
  });

  it('rejects a cycle with no reachable ending', () => {
    const v = validateSpec(specWithStages([
      mkStage({ id: 'a', next: ['b'] }),
      mkStage({ id: 'b', next: ['a'] }),
    ]));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('cannot reach any ending'))).toBe(true);
  });

  it('accepts a self-loop that still has an exit choice', () => {
    const v = validateSpec(specWithStages([
      mkStage({
        id: 'a',
        choices: [
          { label: 'Try again', next: 'a' },
          { label: 'Move on', next: 'b' },
        ],
      }),
      mkStage({ id: 'b' }),
    ]));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('accepts a rejoin diamond', () => {
    const v = validateSpec(specWithStages([
      mkStage({ id: 'start', choices: [{ label: 'Left', next: 'left' }, { label: 'Right', next: 'right' }] }),
      mkStage({ id: 'left', next: ['end'] }),
      mkStage({ id: 'right', next: ['end'] }),
      mkStage({ id: 'end' }),
    ]));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('rejects empty choices and bad choice shapes', () => {
    const v = validateSpec(specWithStages([mkStage({ id: 'a', choices: [] })]));
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('objective.stages[0].choices: must be a non-empty array when present');
    const v2 = validateSpec(specWithStages([
      mkStage({ id: 'a', choices: [{ label: '', next: 'a' }] }),
      mkStage({ id: 'b' }),
    ]));
    expect(v2.errors).toContain('objective.stages[0].choices[0].label: must be a non-empty string');
  });

  it('warns (not errors) on multiple next ids without choices', () => {
    const v = validateSpec(specWithStages([
      mkStage({ id: 'a', next: ['b', 'c'] }),
      mkStage({ id: 'b' }),
      mkStage({ id: 'c' }),
    ]));
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes('objective.stages[0].next'))).toBe(true);
  });
});

/* ---------------- sequencer ---------------- */

function fakeEngine() {
  let choiceResolve: ((i: number) => void) | null = null;
  const eng = {
    state: 'playing' as const,
    elapsed: 0,
    score: 0,
    win: vi.fn(),
    lose: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    hud: {
      setProgress: vi.fn(),
      setTimer: vi.fn(),
      setObjective: vi.fn(),
      showCard: vi.fn(),
      showChoice: vi.fn(
        (_t: string, _b: string, _o: string[]) =>
          new Promise<number>((res) => {
            choiceResolve = res;
          }),
      ),
    },
    hooks: { emit: vi.fn(), tap: vi.fn(), tapCount: () => 0 },
    audio: { play: vi.fn(), setIntensity: vi.fn() },
    __resolveChoice: (i: number) => choiceResolve?.(i),
  };
  return eng;
}

const objSpec = (stages: ObjectiveStage[]): ObjectiveSpec =>
  ({ type: 'eliminate', count: 0, timeLimit: 0, description: 'x', stages }) as ObjectiveSpec;

const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

describe('Objectives — linear passthrough (no graph fields)', () => {
  it('walks id-less stages in order and wins at the end', () => {
    const eng = fakeEngine();
    const seen: string[] = [];
    const o = new Objectives(
      eng as unknown as Engine,
      objSpec([mkStage({ description: 'one' }), mkStage({ description: 'two' })]),
      (_i, s, n) => seen.push(`${s.description}->${n?.description ?? 'END'}`),
    );
    o.addProgress(3);
    expect(o.currentStageIndex).toBe(1);
    expect(seen).toEqual(['one->two']);
    o.addProgress(3);
    expect(eng.win).toHaveBeenCalledTimes(1);
    // the terminal win does not fire onStageComplete (unchanged legacy behavior)
    expect(seen).toEqual(['one->two']);
    // default win text path: second arg undefined
    expect(eng.win.mock.calls[0][1]).toBeUndefined();
  });
});

describe('Objectives — branching', () => {
  const branched = (): ObjectiveStage[] => [
    mkStage({ id: 'a', description: 'start', choices: [{ label: 'Left', next: 'b' }, { label: 'Right', next: 'c' }] }),
    mkStage({ id: 'b', description: 'left path', winText: 'Left ending', next: [] }),
    mkStage({ id: 'c', description: 'right path', winText: 'Right ending', next: [] }),
  ];

  it('pauses for a choice and follows the chosen branch', async () => {
    const eng = fakeEngine();
    const seen: string[] = [];
    const o = new Objectives(eng as unknown as Engine, objSpec(branched()), (_i, s, n) =>
      seen.push(`${s.id}->${n?.id ?? 'END'}`),
    );
    o.addProgress(3); // completes 'a'
    expect(eng.hud.showChoice).toHaveBeenCalledTimes(1);
    const [title, , labels] = eng.hud.showChoice.mock.calls[0];
    expect(title).toBe('CHOOSE YOUR PATH');
    expect(labels).toEqual(['Left', 'Right']);
    expect(o.currentStageIndex).toBe(0); // hasn't moved yet
    eng.__resolveChoice(1); // pick "Right" -> c
    await flush();
    expect(o.currentStageIndex).toBe(2);
    expect(o.currentStageId).toBe('c');
    expect(seen).toEqual(['a->c']);
  });

  it('uses the chosen branch winText on victory', async () => {
    const eng = fakeEngine();
    const o = new Objectives(eng as unknown as Engine, objSpec(branched()));
    o.addProgress(3);
    eng.__resolveChoice(0); // Left -> b
    await flush();
    o.addProgress(3); // completes 'b' (terminal)
    expect(eng.win).toHaveBeenCalledTimes(1);
    expect(eng.win.mock.calls[0][1]).toBe('Left ending');
  });

  it('follows explicit next refs and rejoins', () => {
    const eng = fakeEngine();
    const seen: string[] = [];
    const o = new Objectives(
      eng as unknown as Engine,
      objSpec([
        mkStage({ id: 'start', choices: [{ label: 'L', next: 'l' }, { label: 'R', next: 'r' }] }),
        mkStage({ id: 'l', next: ['end'] }),
        mkStage({ id: 'r', next: ['end'] }),
        mkStage({ id: 'end', winText: 'Rejoined!' }),
      ]),
      (_i, s, n) => seen.push(`${s.id}->${n?.id ?? 'END'}`),
    );
    o.addProgress(3);
    eng.__resolveChoice(0);
    return flush().then(() => {
      expect(o.currentStageId).toBe('l');
      o.addProgress(3); // l -> end via next ref
      expect(o.currentStageId).toBe('end');
      expect(seen).toEqual(['start->l', 'l->end']);
      o.addProgress(3); // end is terminal
      expect(eng.win).toHaveBeenCalledTimes(1);
      expect(eng.win.mock.calls[0][1]).toBe('Rejoined!');
      // chapters cleared counts the actual path (start, l, end)
      expect(eng.win.mock.calls[0][0].stagesCleared).toBe(3);
    });
  });

  it('a mid-chain survive stage advances instead of short-circuiting the run', () => {
    const eng = fakeEngine();
    const seen: string[] = [];
    const o = new Objectives(
      eng as unknown as Engine,
      objSpec([
        mkStage({ id: 's', type: 'survive', count: 0, timeLimit: 1, description: 'hold' }),
        mkStage({ id: 'e', description: 'fight', next: [] }),
      ]),
      (_i, s, n) => seen.push(`${s.id}->${n?.id ?? 'END'}`),
    );
    o.update(1.5); // survive timer expires
    expect(eng.win).not.toHaveBeenCalled();
    expect(o.currentStageId).toBe('e');
    expect(seen).toEqual(['s->e']);
    o.addProgress(3);
    expect(eng.win).toHaveBeenCalledTimes(1);
  });

  it('a dangling next ref ends the run instead of stalling (validator rejects these)', () => {
    const eng = fakeEngine();
    const o = new Objectives(
      eng as unknown as Engine,
      objSpec([mkStage({ id: 'a', next: ['ghost'] })]),
    );
    o.addProgress(3);
    expect(eng.win).toHaveBeenCalledTimes(1);
  });

  it('explicit empty next ends the campaign mid-chain', () => {
    const eng = fakeEngine();
    const o = new Objectives(
      eng as unknown as Engine,
      objSpec([
        mkStage({ id: 'a', next: [] }),
        mkStage({ id: 'b' }),
      ]),
    );
    o.addProgress(3);
    expect(eng.win).toHaveBeenCalledTimes(1);
    expect(o.currentStageIndex).toBe(0); // never reached b
  });
});

/* ---------------- generator ---------------- */

describe('generator emits branched campaigns', () => {
  const genres = [
    'fps-arena',
    'third-person-action',
    'platformer',
    'top-down-shooter',
    'racing',
  ] as const;
  for (const genre of genres) {
    it(`${genre}: valid spec with at least one branch point`, () => {
      const spec = generateSpec(`test ${genre} campaign`, { genre, seed: 1234 });
      const v = validateSpec(spec);
      expect(v.errors).toEqual([]);
      expect(v.ok).toBe(true);
      const stages = spec.objective.stages!;
      expect(stages.length).toBeGreaterThan(1);
      const ids = stages.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length); // unique
      const branchy = stages.filter((s) => (s.choices?.length ?? 0) > 0);
      expect(branchy.length).toBeGreaterThanOrEqual(1);
      // every choice target resolves
      for (const s of branchy)
        for (const c of s.choices!) expect(ids).toContain(c.next);
    });
  }

  it('is deterministic: same seed, same graph', () => {
    const a = generateSpec('neon fps arena', { genre: 'fps-arena', seed: 77 });
    const b = generateSpec('neon fps arena', { genre: 'fps-arena', seed: 77 });
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});
