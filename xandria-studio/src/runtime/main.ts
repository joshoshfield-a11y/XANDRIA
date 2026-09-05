/**
 * Player runtime bootstrap. Spec sources, in priority order:
 *   1. window.__XANDRIA_SPEC__ (injected into standalone exports)
 *   2. ?spec=<base64url JSON>
 *   3. ?intent=<text>  (runs through the deterministic generator)
 *   4. built-in demo spec
 * Exposes window.__XANDRIA__ for automation/playtests.
 */
import { normalizeSpec, validateSpec, type GameSpec } from '@spec';
import { Engine } from '../engine/Engine';
import { BLUEPRINTS } from '../blueprints/index';
import { generateSpec } from '../generator/generate';

declare global {
  interface Window {
    __XANDRIA_SPEC__?: GameSpec;
    __XANDRIA__?: {
      engine: Engine;
      spec: GameSpec;
      blueprint: unknown;
      errors: string[];
    };
    __XANDRIA_ERRORS: string[];
  }
}

window.__XANDRIA_ERRORS = [];
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  window.__XANDRIA_ERRORS.push(args.map(String).join(' '));
  origError(...args);
};
addEventListener('error', (e) => window.__XANDRIA_ERRORS.push(String(e.message)));
addEventListener('unhandledrejection', (e) => window.__XANDRIA_ERRORS.push(String(e.reason)));

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}

function resolveSpec(): GameSpec {
  const params = new URLSearchParams(location.search);
  if (window.__XANDRIA_SPEC__) {
    const v = validateSpec(window.__XANDRIA_SPEC__);
    if (v.ok) return window.__XANDRIA_SPEC__;
    console.warn('invalid injected spec, falling back', v.errors);
  }
  const specParam = params.get('spec');
  if (specParam) {
    try {
      const raw = JSON.parse(b64urlDecode(specParam));
      return normalizeSpec(raw);
    } catch (e) {
      console.warn('bad ?spec= param:', e);
    }
  }
  const intent = params.get('intent');
  if (intent) return generateSpec(intent);
  return generateSpec('a heroic knight adventure through ancient forest ruins at dusk');
}

function boot() {
  const spec = resolveSpec();
  document.title = `${spec.meta.name} — XANDRIA`;
  const container = document.getElementById('app')!;
  const engine = new Engine(container, spec);
  const build = BLUEPRINTS[spec.meta.genre];
  const blueprint = build(engine, spec);
  window.__XANDRIA__ = { engine, spec, blueprint, errors: window.__XANDRIA_ERRORS };
  document.body.dataset.genre = spec.meta.genre;
  document.body.dataset.state = engine.state;
  engine.onUpdate(() => { document.body.dataset.state = engine.state; });
  // title card
  engine.hud.toast(spec.meta.name.toUpperCase(), 3);
  engine.hud.setObjective(spec.meta.name.toUpperCase(), spec.objective.description);
  engine.particles.setWeather(spec.theme.weather, spec.meta.seed);
  engine.onUpdate(() => engine.particles.updateWeather(engine.camera.position, 1 / 60));
  engine.start();
}

boot();
