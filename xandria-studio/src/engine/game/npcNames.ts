/**
 * NPC names + dialogue-stub greetings (gameplay wave: NPC core, workstream A).
 *
 * Deterministic syllable-table generator: the ONLY randomness source is the
 * `Rng` handed in, so the same seed always yields the same name/greeting.
 * No Math.random, no Date.now anywhere in this module.
 */
import { Rng } from '../core/Rng';

const FIRST = [
  'Al', 'Ba', 'Ca', 'De', 'El', 'Fa', 'Ga', 'Ha', 'Il', 'Ja',
  'Ka', 'La', 'Ma', 'Na', 'Or', 'Pa', 'Re', 'Sa', 'Ta', 'Va',
  'Wi', 'Ya', 'Ze', 'Tho',
] as const;

const MID = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'on', 'el', 'ar'] as const;

const LAST = [
  'bran', 'dor', 'fell', 'gar', 'holt', 'kin', 'las', 'mar', 'nor', 'ric',
  'son', 'tel', 'var', 'wen', 'wick', 'yard', 'zen', 'brook',
] as const;

const CLAN = [
  'Amberfell', 'Beaconrest', 'Cinderhollow', 'Duskwatch', 'Emberline',
  'Flintmoor', 'Giltshore', 'Hearthside', 'Irontorch', 'Lanterndeep',
  'Mothwick', 'Oathgate', 'Palefire', 'Ridgeglow', 'Sundervale', 'Tallowmere',
] as const;

/**
 * Deterministic villager name: `Firstmid last` + a chance of a clan suffix.
 * Consumes a fixed 4 draws from `rng` (first, mid, last, clan roll), then one
 * conditional draw only when the clan roll passes — order is fixed, so the
 * same seed always produces the same name.
 */
export function generateNpcName(rng: Rng): string {
  const first = rng.pick(FIRST) + rng.pick(MID);
  const last = rng.pick(LAST);
  const name = `${cap(first)} ${cap(last)}`;
  if (rng.chance(0.35)) return `${name} of ${rng.pick(CLAN)}`;
  return name;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Seeded one-line dialogue stubs for the interaction wave (one draw each). */
export const NPC_GREETINGS = [
  'The amber lights guided you here, friend.',
  'Mind the ridge past the east lantern — drones nest there.',
  'We trade in lamp oil and old stories. Which do you need?',
  'The portal brought you too, eh? It brings all kinds.',
  'Quiet night. The quiet ones keep us alive.',
  'You look like you have seen the far maps. Sit a while.',
  'My grandfather built the beacon on that hill. It still burns.',
  'Strange weather lately. The sky hums when the towers wake.',
  'Take care out there. The machines do not trade.',
  'Another wanderer! The village grows, one lost soul at a time.',
] as const;

/** Deterministic single-draw pick from the greeting table. */
export function generateNpcGreeting(rng: Rng): string {
  return rng.pick(NPC_GREETINGS);
}
