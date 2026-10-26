/**
 * Floating combat text — the ONE theme table for damage numbers.
 *
 * DAMAGE-NUMBERS (upgrade loop): every floating number in the game styles
 * itself from this table, never from a caller-passed hex. Colors resolve
 * through the accessibility-pass theme table (accessibility.ts
 * themeColor(role)) at SPAWN time, so switching the colorblind palette in
 * settings re-themes subsequently spawned numbers with no code change
 * here. When the accessibility-pass branch merges, this file is the merge
 * point: FLOATING_TEXT_THEME's roles already live in THEME_TABLE, so the
 * merge is a move, not a rewrite — nothing here duplicates a palette.
 *
 * Color is never the only channel: every kind also differs by prefix,
 * suffix, and/or size scale, so the five kinds stay distinguishable in
 * grayscale and under every palette:
 *   playerDamage  plain number, base size
 *   enemyDamage   '−' prefix (damage TO the player, not BY the player)
 *   heal          '+' prefix
 *   crit          '!' suffix + 1.5x size
 *   xp            '+' prefix + ' XP' suffix, slightly smaller
 *
 * Display only: formatting never feeds the simulation. Crit styling is a
 * display-only highlight (see CRIT_VARIANCE_CUTOFF in combatAbilities.ts):
 * the game has no crit mechanic, so no damage value is ever altered to
 * produce a crit — the style only marks a top-decile seeded variance roll.
 */
import { themeColor, type ThemeRole } from './accessibility';

export type FloatingTextKind =
  | 'playerDamage'
  | 'enemyDamage'
  | 'heal'
  | 'crit'
  | 'xp';

export interface FloatingTextStyle {
  /** Semantic role resolved through the accessibility theme table. */
  role: ThemeRole;
  /** Font-size multiplier over the 18px pool base. */
  scale: number;
  prefix: string;
  suffix: string;
}

export const FLOATING_TEXT_THEME: Record<FloatingTextKind, FloatingTextStyle> = {
  playerDamage: { role: 'accent', scale: 1, prefix: '', suffix: '' },
  enemyDamage: { role: 'danger', scale: 1, prefix: '−', suffix: '' },
  heal: { role: 'good', scale: 1, prefix: '+', suffix: '' },
  crit: { role: 'dangerBright', scale: 1.5, prefix: '', suffix: '!' },
  xp: { role: 'info', scale: 0.9, prefix: '+', suffix: ' XP' },
};

export interface FormattedFloatingText {
  text: string;
  /** Resolved through the LIVE palette at call time. */
  color: string;
  scale: number;
}

/** Pure: format one floating number. Amounts round to whole numbers. */
export function formatFloatingText(
  kind: FloatingTextKind,
  amount: number,
): FormattedFloatingText {
  const style = FLOATING_TEXT_THEME[kind];
  return {
    text: `${style.prefix}${Math.round(amount)}${style.suffix}`,
    color: themeColor(style.role),
    scale: style.scale,
  };
}
