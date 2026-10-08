/**
 * Round-2 QA regression tests — R2-M4 end-to-end wiring (coordinator).
 * The pre-boot enemy-kind registry lets a modder register a custom kind
 * BEFORE injecting window.__XANDRIA_SPEC__, so resolveSpec's validateSpec
 * call accepts it instead of silently falling back to the default game.
 * Pure logic — no renderer needed.
 */
import { describe, it, expect } from 'vitest';
import {
  Modding,
  registerPreBootEnemyKind,
  preBootEnemyKindIds,
} from '../src/engine/game/Modding';
import { validateSpec, defaultSpec } from '../src/spec/schema';
import type { Engine } from '../src/engine/Engine';

function stalkerSpec(): any {
  const spec: any = defaultSpec(42);
  spec.enemies[0].kind = 'stalker-pb';
  return spec;
}

describe('R2-M4 — pre-boot enemy-kind registry (resolveSpec path)', () => {
  it('a pre-boot-registered kind validates via the resolveSpec call shape', () => {
    registerPreBootEnemyKind('stalker-pb', { base: 'walker', name: 'Stalker' });
    expect([...preBootEnemyKindIds()]).toContain('stalker-pb');
    // resolveSpec now calls validateSpec exactly like this:
    const v = validateSpec(stalkerSpec(), { customEnemyKinds: preBootEnemyKindIds() });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('the same kind still fails with no registry — default validation unchanged', () => {
    const v = validateSpec(stalkerSpec());
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('enemies[0].kind'))).toBe(true);
  });

  it('registerPreBootEnemyKind validates defs like the instance method', () => {
    expect(() =>
      registerPreBootEnemyKind('ghost-pb', { base: 'racer', name: 'Ghost' } as any),
    ).toThrow(/unknown base/);
    expect(() =>
      registerPreBootEnemyKind('stalker-pb', { base: 'walker', name: 'Dupe' }),
    ).toThrow(/already registered/);
  });

  it('instance registerEnemyKind stays per-engine (no pre-boot leak)', () => {
    const hooks = new Modding({} as Engine);
    hooks.registerEnemyKind('wisp-pb', { base: 'drone', name: 'Wisp' });
    expect([...preBootEnemyKindIds()]).not.toContain('wisp-pb');
    // ...so a fresh engine after restart can register the same id again.
    const hooks2 = new Modding({} as Engine);
    expect(() =>
      hooks2.registerEnemyKind('wisp-pb', { base: 'drone', name: 'Wisp' }),
    ).not.toThrow();
  });

  it('new Modding instances merge pre-boot-registered kinds (EnemyAI lookup works)', () => {
    registerPreBootEnemyKind('brute-pb', { base: 'brute', name: 'Bruteling' });
    const hooks = new Modding({} as Engine);
    expect(hooks.enemyKinds.get('brute-pb')).toMatchObject({ base: 'brute' });
  });
});
