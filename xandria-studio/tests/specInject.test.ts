/**
 * QA X3 — spec injection must work when <head> carries attributes and must
 * fail loudly (not silently ship the default spec) when no <head> exists.
 */
import { describe, it, expect } from 'vitest';
import { injectSpecScript } from '../scripts/specInject';

const TAG = `<script>window.__XANDRIA_SPEC__={"meta":{"name":"t"}};</script>`;

describe('injectSpecScript', () => {
  it('injects right after a plain <head>', () => {
    const out = injectSpecScript('<html><head></head><body></body></html>', TAG);
    expect(out).toBe(`<html><head>${TAG}</head><body></body></html>`);
  });

  it('matches <head> with attributes and preserves them', () => {
    const html = '<!doctype html><html><head lang="en" data-x="1"><title>t</title></head></html>';
    const out = injectSpecScript(html, TAG);
    expect(out).toBe(`<!doctype html><html><head lang="en" data-x="1">${TAG}<title>t</title></head></html>`);
  });

  it('matches uppercase <HEAD>', () => {
    const out = injectSpecScript('<HTML><HEAD></HEAD></HTML>', TAG);
    expect(out).toBe(`<HTML><HEAD>${TAG}</HEAD></HTML>`);
  });

  it('throws when there is no <head> tag', () => {
    expect(() => injectSpecScript('<html><body>no head here</body></html>', TAG))
      .toThrow(/no <head> tag/);
  });

  it('does not mistake <header> for <head>', () => {
    expect(() => injectSpecScript('<html><header>x</header></html>', TAG))
      .toThrow(/no <head> tag/);
  });

  it('injects exactly once, after the first <head>', () => {
    const out = injectSpecScript('<head>a</head><head>b</head>', TAG);
    expect(out).toBe(`<head>${TAG}a</head><head>b</head>`);
  });
});
