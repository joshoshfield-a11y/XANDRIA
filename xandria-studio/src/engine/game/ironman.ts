/**
 * UPGRADE LOOP (hardcore-ironman): the ironman score-bonus tuning table.
 *
 * A winning ironman run records its score multiplied by the row for the
 * live NG+ cycle (cycle 0 = base game). The multiplier is a pure table
 * lookup — it draws no RNG, so same (seed, mode, cycle) -> identical
 * encounters and identical recorded scores. A lost ironman run records
 * its raw score (the run is a tombstone, not a bonus) and the slot is
 * marked dead by the run-completion path instead.
 *
 * Design note: the bonus rewards surviving, not dying — a dead slot's
 * bestScore never benefits from the multiplier, so there is no incentive
 * to farm deaths.
 */
export interface IronmanTableRow {
  /** NG+ cycle this row applies to (0 = base game). */
  cycle: number;
  /** Score multiplier for a WON ironman run at this cycle. */
  scoreMult: number;
}

export const MAX_IRONMAN_CYCLE = 8;

export const IRONMAN_TABLE: IronmanTableRow[] = [
  { cycle: 0, scoreMult: 2.0 },
  { cycle: 1, scoreMult: 2.25 },
  { cycle: 2, scoreMult: 2.5 },
  { cycle: 3, scoreMult: 2.75 },
  { cycle: 4, scoreMult: 3.0 },
  { cycle: 5, scoreMult: 3.25 },
  { cycle: 6, scoreMult: 3.5 },
  { cycle: 7, scoreMult: 3.75 },
  { cycle: 8, scoreMult: 4.0 },
];

/**
 * Row for a cycle: unknown / negative / NaN -> the cycle-0 row (never
 * throws); above the table -> clamps to the cycle-8 row. Mirrors the
 * ngPlusByCycle guard shape so both tables fail the same safe way.
 */
export function ironmanRowByCycle(cycle: number): IronmanTableRow {
  const c = Number.isFinite(cycle) ? Math.floor(cycle) : 0;
  if (c <= 0) return IRONMAN_TABLE[0];
  if (c >= MAX_IRONMAN_CYCLE) return IRONMAN_TABLE[IRONMAN_TABLE.length - 1];
  return IRONMAN_TABLE[c];
}

/** Score multiplier for a won ironman run at the given NG+ cycle. */
export function ironmanScoreMult(cycle: number): number {
  return ironmanRowByCycle(cycle).scoreMult;
}

/** End-screen recap text for the multiplier, e.g. `IRONMAN ×2.0`. */
export function ironmanBonusText(mult: number): string {
  const m = Number.isFinite(mult) ? mult : 2.0;
  return `IRONMAN ×${m.toFixed(m % 1 === 0 ? 1 : 2)}`;
}
