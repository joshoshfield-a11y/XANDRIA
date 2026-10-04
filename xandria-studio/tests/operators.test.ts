import { describe, it, expect } from 'vitest';
import { generateSpec } from '../src/generator/generate';
import { validateSpec } from '../src/spec/schema';
import {
  LEGACY_OPERATORS,
  LEGACY_OPERATOR_IDS,
  applyOperators,
  legacyOperatorById,
} from '../src/generator/operators';

describe('legacy operator vocabulary (frozen)', () => {
  it('contains exactly the 72 canonical operators in order', () => {
    expect(LEGACY_OPERATORS).toHaveLength(72);
    expect(LEGACY_OPERATOR_IDS).toEqual(
      Array.from({ length: 72 }, (_, i) => i + 1)
    );
    expect(LEGACY_OPERATORS[0]).toEqual({ id: 1, name: 'Void' });
    expect(LEGACY_OPERATORS[71]).toEqual({ id: 72, name: 'Seal' });
  });

  it('matches OP-N references', () => {
    expect(applyOperators('use OP-17 and OP-72')).toEqual([17, 72]);
    expect(applyOperators('op-4 seed the world')).toContain(4);
  });

  it('matches operator names by word boundary, case-insensitive', () => {
    expect(applyOperators('a Bloom of light in the Void')).toEqual([1, 8]);
    // 'blooming' must not match 'Bloom'
    expect(applyOperators('blooming flowers')).not.toContain(8);
  });

  it('dedupes and sorts hits', () => {
    expect(applyOperators('Seal the Vault, OP-72, seal it')).toEqual([60, 72]);
  });

  it('ignores out-of-range OP refs', () => {
    expect(applyOperators('OP-0 OP-73 OP-999')).toEqual([]);
  });

  it('returns [] for plain intents with no operator vocabulary', () => {
    expect(applyOperators('a neon racing game')).toEqual([]);
  });

  it('looks up operators by id', () => {
    expect(legacyOperatorById(3)).toEqual({ id: 3, name: 'Intent' });
    expect(legacyOperatorById(0)).toBeUndefined();
    expect(legacyOperatorById(73)).toBeUndefined();
  });
});

describe('operator bridge in the generator', () => {
  it('attaches matched operator ids to spec.custom.legacyOperators', () => {
    const spec = generateSpec('OP-17 pattern weaver fps arena');
    expect(spec.custom?.legacyOperators).toEqual([17]);
    expect(validateSpec(spec).errors).toEqual([]);
  });

  it('leaves custom.legacyOperators unset for plain intents', () => {
    const spec = generateSpec('a neon racing game');
    expect(spec.custom?.legacyOperators).toBeUndefined();
    expect(validateSpec(spec).errors).toEqual([]);
  });
});
