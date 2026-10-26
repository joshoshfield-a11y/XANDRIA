/**
 * UPGRADE LOOP (audio-system): per-biome ambient music patterns.
 *
 * Pure function — no DOM, no AudioContext, no wall clock. The same
 * (biomeId, mapSeed) always yields the identical pattern, so a portal
 * round-trip replays the same loop and a unit test can replicate it
 * independently (mulberry32 + the draw order below).
 *
 * DRAW ORDER (do not reorder — the e2e/unit replication depends on it):
 *   rng = Rng((mapSeed ^ AUDIO_SALT ^ hashString(biomeId)) >>> 0)
 *   1. mode  = rng.pick(BIOME_MODES[biome])   (first entry = biome default)
 *   2. key   = rng.int(0, 11)
 *   3. tempo = rng.int(70, 140)               (BPM)
 *   4. chordProg = rng.pick(CHORD_PROGS)
 *   5. motif: 32 steps, each (rng.chance(0.7) ? rng.int(0, scaleLen*2-1) : -1)
 *   6. bassPat: 16 steps, i%4==0 ? 0 : (rng.chance(0.35) ? rng.int(0, 2) : -1)
 *
 * Scale lengths mirror the SCALES table in engine/core/Audio.ts (the
 * scheduler's degree math); keep the two in sync when adding modes.
 * Unknown biome ids fall back to 'plains' — never throws.
 */
import type { BiomeId } from '@spec';
import { BIOME_IDS } from '@spec';
import { Rng, hashString } from '../core/Rng';

/** Salt decorrelating music rolls from terrain/enemy rolls on the same seed. */
export const AUDIO_SALT = 0xa0d10;

/** Scale degree counts per mode (must match Audio.ts SCALES). */
export const SCALE_LENGTHS: Record<string, number> = {
  major: 7, minor: 7, dorian: 7, phrygian: 7, pentatonic: 5,
};

/** Per-biome mode palettes: first entry is the biome's default voice. */
export const BIOME_MODES: Record<BiomeId, string[]> = {
  plains: ['major', 'pentatonic'],
  'desert-canyon': ['phrygian', 'minor'],
  forest: ['dorian', 'pentatonic'],
  snow: ['minor', 'dorian'],
  volcanic: ['phrygian', 'minor'],
  coastline: ['major', 'dorian'],
  caves: ['minor', 'phrygian'],
};

/** Chord-degree progressions (bars), shared across biomes. */
export const CHORD_PROGS: readonly (readonly number[])[] = [
  [0, 5, 3, 6],
  [0, 3, 4, 5],
  [0, 5, 3, 4],
  [0, 4, 5, 3],
];

export interface BiomeMusicPattern {
  biomeId: BiomeId;
  mapSeed: number;
  mode: string;
  /** semitone root 0..11 */
  key: number;
  /** BPM */
  tempo: number;
  chordProg: number[];
  /** 32-step melody: -1 = rest, else scale-degree index */
  motif: number[];
  /** 16-step bass: -1 = rest, else chord-degree offset */
  bassPat: number[];
}

export function resolveBiomeMusicId(biomeId: string): BiomeId {
  return (BIOME_IDS as readonly string[]).includes(biomeId)
    ? (biomeId as BiomeId)
    : 'plains';
}

/**
 * Deterministic per-biome loop pattern. Same inputs → byte-identical
 * pattern (Rng is mulberry32; see draw order in the header comment).
 */
export function biomeMusicPattern(biomeId: string, mapSeed: number): BiomeMusicPattern {
  const id = resolveBiomeMusicId(biomeId);
  const rng = new Rng((mapSeed ^ AUDIO_SALT ^ hashString(id)) >>> 0);
  const mode = rng.pick(BIOME_MODES[id]);
  const key = rng.int(0, 11);
  const tempo = rng.int(70, 140);
  const chordProg = [...rng.pick(CHORD_PROGS)];
  const scaleLen = SCALE_LENGTHS[mode] ?? 7;
  const motif = Array.from({ length: 32 }, () =>
    rng.chance(0.7) ? rng.int(0, scaleLen * 2 - 1) : -1);
  const bassPat = Array.from({ length: 16 }, (_, i) =>
    i % 4 === 0 ? 0 : rng.chance(0.35) ? rng.int(0, 2) : -1);
  return { biomeId: id, mapSeed: mapSeed >>> 0, mode, key, tempo, chordProg, motif, bassPat };
}
