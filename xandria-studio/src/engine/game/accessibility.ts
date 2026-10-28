/**
 * Accessibility pass (UPGRADE LOOP): remappable keybinds, colorblind
 * palettes, reduced motion, HUD text scale. UI and settings only — zero
 * gameplay or behavior-contract changes.
 *
 * PALETTE APPROACH (disclosed, read this before "fixing" it):
 * Colors are remapped by SEMANTIC ROLE, not by simulating color-vision
 * deficiency on arbitrary pixels. One theme table maps each role
 * (accent / good / danger / info / lives / coin / warn) to a hex per
 * palette; HUD chips read it through CSS variables, boss telegraphs and
 * event beacons resolve it at spawn time. Consequences, stated plainly:
 *  - per-attack hue variety in boss telegraphs collapses to the danger /
 *    dangerBright roles under a non-none palette (distinguishability over
 *    variety — deliberate);
 *  - voxel/terrain/biome colors are NOT remapped (world art is out of
 *    scope; only UI + signal colors change);
 *  - the tables are hand-picked role swaps, not per-user calibrated
 *    simulations. A player whose vision differs from the three named
 *    types gets the closest table, not a custom one.
 * There is deliberately no minimap entry: this codebase has no minimap
 * (grep finds zero matches), so there is nothing to theme there.
 *
 * KEYBIND MODEL (disclosed):
 * Each keyboard action has exactly one PRIMARY code (defaults below);
 * arrows / KeyF / ShiftRight / KeyP are fixed SECONDARY bindings that
 * survive remaps (so remapping move off WASD leaves arrows working, and
 * remapping interact off KeyE leaves KeyF working). A remap is rejected
 * when the target code is already bound to any other action — primary or
 * secondary — so one key never silently drives two actions. Mouse attack
 * and gamepad are not remappable; boost is not separately remappable
 * (it shares Space with jump/confirm in the defaults and stays there).
 *
 * REDUCED MOTION (disclosed): gates cosmetic motion only — Juice shake,
 * camera-rig shake + speed FOV kick, and ALL pooled particle emission
 * (Particles.burst is the single funnel). Hit-stop, damage numbers and
 * vignette flashes are untouched (not shake/particles/zoom), and no
 * simulation value ever reads these flags, so gameplay outcomes are
 * identical with the toggle on or off.
 *
 * PERSISTENCE: all four settings live in the Profile (ProfileData.
 * accessibility) — same localStorage key as the rest of the profile, so
 * they survive reload and portal travel (portal travel never rebuilds
 * Engine-level state, and a fresh boot re-applies from storage).
 */

/** Color-vision-deficiency palette id. 'none' = shipped colors. */
export type ColorblindPalette = 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';

export const COLORBLIND_PALETTES: readonly ColorblindPalette[] = [
  'none', 'protanopia', 'deuteranopia', 'tritanopia',
];

export function isColorblindPalette(v: unknown): v is ColorblindPalette {
  return v === 'none' || v === 'protanopia' || v === 'deuteranopia' || v === 'tritanopia';
}

/** Semantic color roles themed by the palette table. */
export type ThemeRole =
  | 'accent' | 'good' | 'danger' | 'dangerBright' | 'info' | 'lives' | 'coin' | 'warn';

/**
 * The one theme table. 'none' rows are the exact shipped hexes (HUD chips,
 * boss telegraphs, event beacons) so the default game is pixel-identical.
 * Protan/deutan rows swap the red↔green axis for blue↔amber (the axis
 * those viewers still separate); tritan rows swap the blue↔yellow axis
 * for red↔magenta while keeping red/green intact.
 */
export const THEME_TABLE: Record<ColorblindPalette, Record<ThemeRole, string>> = {
  none: {
    accent: '#ffd23f', good: '#8fe3a8', danger: '#ff4d5e', dangerBright: '#ff8a5c',
    info: '#7dd3fc', lives: '#ff8a9a', coin: '#8fe3a8', warn: '#ffb300',
  },
  protanopia: {
    accent: '#ffe066', good: '#ffb020', danger: '#2f6bff', dangerBright: '#7aa8ff',
    info: '#00bfae', lives: '#ff7ab8', coin: '#ffb020', warn: '#ff8a00',
  },
  deuteranopia: {
    accent: '#ffe066', good: '#ff9d0a', danger: '#2f6bff', dangerBright: '#7aa8ff',
    info: '#00bfae', lives: '#ff7ab8', coin: '#ff9d0a', warn: '#ff8a00',
  },
  tritanopia: {
    accent: '#ff8a3d', good: '#3ddc84', danger: '#ff4d5e', dangerBright: '#ff8a5c',
    info: '#e85dff', lives: '#ff6a7a', coin: '#3ddc84', warn: '#ff6a00',
  },
};

/** Module-level current palette: set by Engine.applyAccessibility, read by HUD/bosses/beacons. */
let currentPalette: ColorblindPalette = 'none';

export function setCurrentPalette(p: ColorblindPalette): void {
  currentPalette = p;
}

export function getCurrentPalette(): ColorblindPalette {
  return currentPalette;
}

/** Resolve a role through the palette table (defaults to the live palette). */
export function themeColor(role: ThemeRole, palette: ColorblindPalette = currentPalette): string {
  return THEME_TABLE[palette][role];
}

/** CSS variable name for a role (HUD chips read these; see HUD.applyAccessibility). */
export function themeVar(role: ThemeRole): string {
  return `--a11y-${role}`;
}

// ---------------------------------------------------------------------------
// keybinds
// ---------------------------------------------------------------------------

/** Keyboard actions with a primary code. 'attack' (mouse) is intentionally absent. */
export type RemappableAction =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'dash'
  | 'attack2' | 'interact' | 'pause' | 'boost' | 'brake' | 'reset' | 'confirm'
  | 'weapon1' | 'weapon2';

export const REMAPPABLE_ACTIONS: readonly RemappableAction[] = [
  'forward', 'back', 'left', 'right', 'jump', 'sprint', 'dash',
  'attack2', 'interact', 'pause', 'boost', 'brake', 'reset', 'confirm',
  'weapon1', 'weapon2',
];

/** Actions the settings UI offers for remapping (boost stays on Space — see header). */
export const UI_REMAPPABLE_ACTIONS: readonly RemappableAction[] = [
  'forward', 'back', 'left', 'right', 'jump', 'sprint', 'dash',
  'attack2', 'interact', 'pause', 'brake', 'reset', 'confirm',
  'weapon1', 'weapon2',
];

/**
 * Primary code per action — the shipped map, exactly matching the old
 * hardcoded KEYMAP's keyboard rows (mouse attack untouched, gamepad untouched).
 */
export const DEFAULT_ACTION_CODES: Record<RemappableAction, string> = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sprint: 'ShiftLeft', dash: 'ShiftLeft',
  attack2: 'KeyQ', interact: 'KeyE', pause: 'Escape', boost: 'Space',
  brake: 'ControlLeft', reset: 'KeyR', confirm: 'Enter',
  weapon1: 'Digit1', weapon2: 'Digit2',
};

/** Fixed secondary bindings: never remappable, never removed by a remap. */
export const SECONDARY_CODES: Record<string, readonly string[]> = {
  ArrowUp: ['forward'], ArrowDown: ['back'], ArrowLeft: ['left'], ArrowRight: ['right'],
  KeyF: ['interact'], ShiftRight: ['sprint', 'dash'], KeyP: ['pause'],
  KeyX: ['brake'],
  // MERGE (wave-4): deployables + combat-abilities landed after this
  // table's base — their bindings ride here as fixed secondaries (never
  // remappable, never removed by a remap), so the refactor doesn't silently
  // unbind KeyG/Digit3 deploy and KeyZ/C/V abilities.
  KeyG: ['deploy'], Digit3: ['deploy'],
  KeyZ: ['ability1'], KeyC: ['ability2'], KeyV: ['ability3'],
  // STEALTH-SYSTEM: hold-to-sneak (Ctrl, either side) — a fixed
  // secondary like deploy/abilities (never remappable, never removed
  // by a remap). ControlLeft's primary is 'brake' (racing only); in
  // third-person-action blueprints brake is unread, so Ctrl = sneak
  // there with no conflict. Gamepad has no free button: no gamepad
  // sneak binding (touch + keyboard covered).
  ControlLeft: ['sneak'], ControlRight: ['sneak'],
  // Old KEYMAP bound confirm to BOTH Space and Enter; confirm's primary
  // is Enter, Space survives as a secondary so Space-to-confirm keeps working.
  Space: ['confirm'],
};

export type KeybindOverrides = Partial<Record<RemappableAction, string>>;

/** Effective primary code per action: defaults with overrides applied. */
export function effectiveActionCodes(overrides: KeybindOverrides): Record<RemappableAction, string> {
  return { ...DEFAULT_ACTION_CODES, ...overrides };
}

/**
 * Effective code → actions map: primary bindings first, then secondaries
 * appended (deduped). This is what Input listens on.
 */
export function buildKeymap(overrides: KeybindOverrides): Record<string, string[]> {
  const primaries = effectiveActionCodes(overrides);
  const map: Record<string, string[]> = {};
  for (const action of REMAPPABLE_ACTIONS) {
    const code = primaries[action];
    (map[code] ?? (map[code] = [])).push(action);
  }
  for (const [code, actions] of Object.entries(SECONDARY_CODES)) {
    const list = map[code] ?? (map[code] = []);
    for (const a of actions) if (!list.includes(a)) list.push(a);
  }
  return map;
}

export type RemapResult =
  | { ok: true; overrides: KeybindOverrides }
  | { ok: false; reason: string };

/**
 * Attempt a remap. Rejects when the target code is already bound to any
 * other action (primary or secondary), when it is the action's own current
 * code, or when the code/action is malformed. Never mutates the input.
 */
export function tryRemap(
  current: KeybindOverrides,
  action: RemappableAction,
  code: string,
): RemapResult {
  if (!REMAPPABLE_ACTIONS.includes(action)) return { ok: false, reason: 'unknown action' };
  if (typeof code !== 'string' || code.length === 0) return { ok: false, reason: 'empty key' };
  const primaries = effectiveActionCodes(current);
  if (primaries[action] === code) return { ok: false, reason: 'already bound to this action' };
  const map = buildKeymap(current);
  // The action's own secondary bindings don't count: remapping interact
  // onto KeyF (already a secondary interact key) is a harmless no-op-ish
  // move, not a conflict — only OTHER actions clash.
  const clash = (map[code] ?? []).filter((a) => a !== action);
  if (clash.length > 0) {
    return { ok: false, reason: `already bound to ${clash.join(' + ')}` };
  }
  return { ok: true, overrides: { ...current, [action]: code } };
}

/**
 * Validate a stored overrides record: unknown actions and non-string codes
 * are dropped; conflicting entries lose to the earlier action in
 * REMAPPABLE_ACTIONS order (deterministic first-wins).
 */
export function validateKeybinds(raw: unknown): KeybindOverrides {
  const out: KeybindOverrides = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  for (const action of REMAPPABLE_ACTIONS) {
    const code = rec[action];
    if (typeof code !== 'string' || code.length === 0) continue;
    const res = tryRemap(out, action, code);
    if (res.ok) out[action] = code;
  }
  return out;
}

/** Human label for a KeyboardEvent.code ('KeyW' → 'W', 'Space' → 'SPACE'). */
export function keyDisplayName(code: string): string {
  const special: Record<string, string> = {
    Space: 'SPACE', ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL',
    ControlRight: 'CTRL', Escape: 'ESC', Enter: 'ENTER', ArrowUp: '↑',
    ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: 'TAB', Backquote: '`',
  };
  if (special[code]) return special[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  return code;
}

// ---------------------------------------------------------------------------
// settings bundle
// ---------------------------------------------------------------------------

export interface AccessibilitySettings {
  keybinds: KeybindOverrides;
  colorblind: ColorblindPalette;
  reducedMotion: boolean;
  /** HUD text scale multiplier, 0.85..1.5. */
  hudTextScale: number;
}

export function defaultAccessibilitySettings(): AccessibilitySettings {
  return { keybinds: {}, colorblind: 'none', reducedMotion: false, hudTextScale: 1 };
}

export function clampTextScale(v: unknown): number {
  const n = typeof v === 'number' && isFinite(v) ? v : 1;
  return Math.round(Math.max(0.85, Math.min(1.5, n)) * 100) / 100;
}

/** Validate a stored settings blob; corrupt fields fall back to defaults, never throw. */
export function validateAccessibilitySettings(raw: unknown): AccessibilitySettings {
  const base = defaultAccessibilitySettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  return {
    keybinds: validateKeybinds(r.keybinds),
    colorblind: isColorblindPalette(r.colorblind) ? r.colorblind : 'none',
    reducedMotion: r.reducedMotion === true,
    hudTextScale: clampTextScale(r.hudTextScale),
  };
}

// ---------------------------------------------------------------------------
// event-beacon roles
// ---------------------------------------------------------------------------

export type DynamicEventTypeId = 'ambush' | 'merchant' | 'cache' | 'patrol';

/** Beacon role per event type (used for non-none palettes). */
export const BEACON_ROLES: Record<DynamicEventTypeId, ThemeRole> = {
  ambush: 'danger', merchant: 'accent', cache: 'info', patrol: 'warn',
};

/** Exact shipped beacon hexes — the 'none' palette returns these verbatim. */
export const BEACON_SHIPPED: Record<DynamicEventTypeId, string> = {
  ambush: '#ff4d3d', merchant: '#ffcf7a', cache: '#7ae2ff', patrol: '#c77aff',
};

/**
 * Beacon color for an event type under a palette (defaults to the live
 * palette). 'none' returns the exact shipped hex, so the default game is
 * pixel-identical; other palettes resolve through the role table.
 */
export function beaconColorForType(
  type: DynamicEventTypeId,
  palette: ColorblindPalette = currentPalette,
): string {
  if (palette === 'none') return BEACON_SHIPPED[type];
  return themeColor(BEACON_ROLES[type], palette);
}
