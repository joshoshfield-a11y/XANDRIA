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
import {
  registerPreBootEnemyKind,
  preBootEnemyKindIds,
  type CustomEnemyKindDef,
} from '../engine/game/Modding';
import { applyLoadout, loadProfile } from '../engine/game/Profile';

declare global {
  interface Window {
    __XANDRIA_SPEC__?: GameSpec;
    __XANDRIA__?: {
      /** Set at boot(); absent on the pre-boot object below. */
      engine?: Engine;
      /** Set at boot(); absent on the pre-boot object below. */
      spec?: GameSpec;
      /** Set at boot(); absent on the pre-boot object below. */
      blueprint?: unknown;
      errors: string[];
      /**
       * Pre-boot modding API (R2-M4, real-page wiring R3-M1). In a real
       * browser page this exists from parse time: the inline classic
       * <script> in player.html (ahead of this deferred bundle module)
       * installs a queue-only stub, so a modder's own classic <script> can
       * register custom enemy kinds BEFORE the bundle evaluates — and
       * therefore before boot() validates `window.__XANDRIA_SPEC__`:
       *   <script>__XANDRIA__.registerEnemyKind('stalker', { base: 'walker', name: 'Stalker' });</script>
       *   <script>window.__XANDRIA_SPEC__ = specUsingStalkerKind;</script>
       * At module load the bundle drains the queue into the module-level
       * registry (see registerPreBootEnemyKind in Modding.ts) and replaces
       * the stub with the registry-backed function. In-process callers get
       * the registry-backed function directly.
       */
      registerEnemyKind?: (id: string, def: CustomEnemyKindDef) => void;
    };
    __XANDRIA_ERRORS: string[];
  }
}

window.__XANDRIA_ERRORS = [];
// R3-M1: the inline classic <script> in player.html runs at parse time,
// before this deferred module, and queues pre-boot enemy-kind registrations
// on window.__XANDRIA__._preBootKinds. Drain the queue into the module-level
// registry (strictly separate from per-engine instance registration, per
// round-2's isolation rule) BEFORE boot() validates any injected spec — this
// queue is the only interleaving point a real page script can use.
const preBootState = (window.__XANDRIA__ ?? {}) as {
  errors?: unknown;
  _preBootKinds?: unknown;
};
window.__XANDRIA_ERRORS = Array.isArray(preBootState.errors) ? (preBootState.errors as string[]) : [];
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  window.__XANDRIA_ERRORS.push(args.map(String).join(' '));
  origError(...args);
};
addEventListener('error', (e) => window.__XANDRIA_ERRORS.push(String(e.message)));
addEventListener('unhandledrejection', (e) => window.__XANDRIA_ERRORS.push(String(e.reason)));
const preBootQueue = Array.isArray(preBootState._preBootKinds) ? preBootState._preBootKinds : [];
for (const entry of preBootQueue) {
  const [id, def] = entry as [string, CustomEnemyKindDef];
  try {
    registerPreBootEnemyKind(id, def);
  } catch (e) {
    // Loud (lands in __XANDRIA_ERRORS via the capture above), and the drain
    // continues: the bad kind simply won't validate, and the R3-N1 banner
    // tells the player the injected spec didn't load.
    console.error(`pre-boot registerEnemyKind failed for "${String(id)}":`, e);
  }
}
// Publish the real registry-backed API, replacing the queue-only inline stub.
window.__XANDRIA__ = {
  errors: window.__XANDRIA_ERRORS,
  registerEnemyKind: registerPreBootEnemyKind,
};

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b64)));
}

/**
 * R3-N1: an invalid injected spec used to fall back to the default game with
 * only a console.warn — the player saw the wrong game with no indication.
 * Show a loud, dismissible on-screen banner as well. Called from
 * resolveSpec() during boot(); the normal boot path never reaches it.
 */
function showSpecFallbackBanner(errors: string[]): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById('xandria-spec-fallback')) return;
  const detail =
    errors.slice(0, 3).join('; ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : '');
  const banner = document.createElement('div');
  banner.id = 'xandria-spec-fallback';
  banner.setAttribute('role', 'alert');
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
    'background:#4a0f16', 'color:#ffe3e6', 'border-bottom:2px solid #ff5d6c',
    'font:13px/1.5 system-ui,-apple-system,sans-serif', 'padding:10px 48px 10px 14px',
    'text-align:center',
  ].join(';');
  const msg = document.createElement('span');
  // textContent: validator errors are untrusted strings, never HTML.
  msg.textContent =
    `XANDRIA: the injected game spec was invalid (${detail}) — loaded the default game instead.`;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Dismiss this notice');
  dismiss.style.cssText = [
    'position:absolute', 'top:6px', 'right:10px', 'background:transparent',
    'border:1px solid #ff8b95', 'border-radius:4px', 'color:#ffe3e6',
    'font-size:14px', 'line-height:1', 'padding:4px 8px', 'cursor:pointer',
  ].join(';');
  dismiss.addEventListener('click', () => banner.remove());
  banner.append(msg, dismiss);
  document.body.appendChild(banner);
}

function resolveSpec(): GameSpec {
  const params = new URLSearchParams(location.search);
  if (window.__XANDRIA_SPEC__) {
    // R2-M4: validate against pre-boot-registered custom enemy kinds
    // (registered via __XANDRIA__.registerEnemyKind before injection) so a
    // modder's spec isn't silently swapped for the default game.
    const v = validateSpec(window.__XANDRIA_SPEC__, { customEnemyKinds: preBootEnemyKindIds() });
    if (v.ok) return window.__XANDRIA_SPEC__;
    console.warn('invalid injected spec, falling back', v.errors);
    showSpecFallbackBanner(v.errors);
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
  // R4-M2: the equipped modifier loadout must be on the spec BEFORE the
  // first blueprint build. PlayerAvatar value-copies spec.player.health /
  // spec.rules.lives at construction, so a loadout applied later (in
  // beginPlay) left vitality/secondwind inert on run 1. resetRun() already
  // upholds this for rebuilds; this upholds it for the first build.
  // applyLoadout is idempotent (restores pristine base values first).
  applyLoadout(spec, loadProfile());
  const blueprint = build(engine, spec);
  // Preserve the pre-boot modding API when publishing the booted state.
  window.__XANDRIA__ = { ...window.__XANDRIA__, engine, spec, blueprint, errors: window.__XANDRIA_ERRORS };
  document.body.dataset.genre = spec.meta.genre;
  document.body.dataset.state = engine.state;
  engine.onUpdatePersistent(() => { document.body.dataset.state = engine.state; });
  // title card — the blueprint already set the HUD objective line to the
  // staged first-stage description via makeCampaignObjectives (R2-M2: never
  // overwrite it here with the legacy objective text).
  engine.hud.toast(spec.meta.name.toUpperCase(), 3);
  engine.particles.setWeather(spec.theme.weather, spec.meta.seed);
  engine.onUpdatePersistent(() => engine.particles.updateWeather(engine.camera.position, 1 / 60));
  // register the blueprint builder: enables in-place restart()
  engine.setRunBuilder((e) => build(e, spec));
  engine.start();
}

boot();
