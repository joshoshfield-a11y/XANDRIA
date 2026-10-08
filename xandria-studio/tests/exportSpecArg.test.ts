/**
 * R3-N3 — CLI export.ts --spec with an unfixable spec must fail with a
 * friendly message and a clean exit, not a raw stack trace. The parsing
 * lives in scripts/specArg.ts so the error paths are unit-testable
 * (importing export.ts would run the CLI); export.ts prints the thrown
 * message and exits 1.
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, validateSpec } from '../src/spec/schema';
import { resolveSpecArg } from '../scripts/specArg';

describe('resolveSpecArg', () => {
  it('passes a valid spec through', () => {
    const json = JSON.stringify(defaultSpec(1234));
    const spec = resolveSpecArg(json);
    expect(spec.meta.name).toBe(defaultSpec(1234).meta.name);
    expect(validateSpec(spec).ok).toBe(true);
  });

  it('repairs a fixable spec via normalizeSpec (fills defaults)', () => {
    const spec = resolveSpecArg('{}');
    expect(validateSpec(spec).ok).toBe(true);
    expect(spec.meta.genre).toBe(defaultSpec(1).meta.genre);
  });

  it('throws a readable error for an unfixable spec (custom enemy kind)', () => {
    const bad = defaultSpec(7);
    (bad.enemies[0] as { kind: string }).kind = 'stalker';
    let err: Error | null = null;
    try {
      resolveSpecArg(JSON.stringify(bad));
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    const msg = err!.message;
    // names the offending path and the allowed values…
    expect(msg).toContain('enemies[0].kind');
    expect(msg).toContain('must be one of');
    // …as real line breaks, not the literal backslash-n normalizeSpec emits…
    expect(msg).not.toContain('\\n');
    // …and carries no stack-trace frames (the CLI prints message only).
    expect(msg).not.toMatch(/^\s*at\s/m);
  });

  it('throws a readable error for malformed JSON', () => {
    let err: Error | null = null;
    try {
      resolveSpecArg('{"meta": not json');
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('not valid JSON');
    expect(err!.message).not.toMatch(/^\s*at\s/m);
  });

  it('repairs non-object JSON to defaults (existing normalizeSpec leniency)', () => {
    const spec = resolveSpecArg('[1,2,3]');
    expect(validateSpec(spec).ok).toBe(true);
  });
});
