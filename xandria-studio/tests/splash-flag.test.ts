/**
 * Unit tests for the splash flag resolution (src/runtime/splash.ts).
 * resolveSplash is pure; showSplash is DOM + timing and is covered by
 * inspection, not unit tests.
 */
import { describe, expect, it } from 'vitest';
import { resolveSplash, SPLASH_DURATION_MS } from '../src/runtime/splash';

describe('resolveSplash', () => {
  it('?splash=0 disables the splash', () => {
    expect(resolveSplash('?splash=0', undefined)).toBe(false);
    expect(resolveSplash('?splash=0', true)).toBe(false); // query wins over window flag
  });
  it('?splash=1 enables the splash', () => {
    expect(resolveSplash('?splash=1', undefined)).toBe(true);
    expect(resolveSplash('?splash=1', false)).toBe(true);
  });
  it('accepts word forms', () => {
    expect(resolveSplash('?splash=false', undefined)).toBe(false);
    expect(resolveSplash('?splash=off', undefined)).toBe(false);
    expect(resolveSplash('?splash=true', undefined)).toBe(true);
    expect(resolveSplash('?splash=on', undefined)).toBe(true);
  });
  it('falls back to window.__XANDRIA_SPLASH__ when no query param', () => {
    expect(resolveSplash('', true)).toBe(true);
    expect(resolveSplash('', false)).toBe(false);
    expect(resolveSplash('?spec=abc', false)).toBe(false);
  });
  it('defaults ON when neither source is set (free tier / unknown provenance)', () => {
    expect(resolveSplash('', undefined)).toBe(true);
    expect(resolveSplash('?spec=abc', undefined)).toBe(true);
    expect(resolveSplash('', 'garbage')).toBe(true); // non-boolean window flag ignored
  });
  it('ignores unrecognized splash values, falls through to the window flag', () => {
    expect(resolveSplash('?splash=maybe', false)).toBe(false);
    expect(resolveSplash('?splash=maybe', true)).toBe(true);
  });
  it('duration is ~3s', () => {
    expect(SPLASH_DURATION_MS).toBe(3000);
  });
});
