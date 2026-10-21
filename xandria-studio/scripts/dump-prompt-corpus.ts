/**
 * prompt-fidelity wave: freeze the pre-refactor generateSpec outputs for a
 * fixed prompt corpus into tests/fixtures/prompt-corpus-baseline.json.
 *
 * The refactor (generate.ts consuming extractIntent) must reproduce these
 * byte-for-byte; tests/prompt-corpus-parity.test.ts enforces it.
 *
 * Run: npx tsx scripts/dump-prompt-corpus.ts
 * This script is a one-shot fixture generator — it is NOT part of the gates.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSpec, type GenerateOptions } from '../src/generator/generate';

const HERE = dirname(fileURLToPath(import.meta.url));

const PROMPTS: string[] = [
  // every hardcoded prompt in the test suite (pre-refactor)
  'OP-17 pattern weaver fps arena',
  'a hard platformer over lava',
  'a heroic knight adventure',
  'a heroic knight adventure through ancient forest ruins',
  'a heroic knight adventure through hills at dusk',
  'a huge open world platformer adventure',
  'a huge sprawling fantasy world to explore',
  'a neon racing game',
  'a sword adventure',
  'a test world',
  'a vast open world adventure',
  'a vast open world sword adventure',
  'adventure in a haunted castle',
  'an epic desert rally raid',
  'an open world adventure',
  'bow hunter in the woods',
  'cyberpunk neon city nights',
  'desert adventure',
  'desert racing grand prix',
  'dreamy platformer',
  'dreamy platformer in the clouds',
  'endless runner temple run',
  'forest adventure',
  'forest lake',
  'fps arena shooter in a neon city',
  'frozen arctic expedition',
  'grenade assault on the fortress',
  'kart grand prix',
  'laser battle in space',
  'neon cyberpunk fps arena',
  'neon cyberpunk fps arena deathmatch',
  'neon desert fps',
  'neon fps arena',
  'neon fps arena at night',
  'neon street race',
  'pistol duel at dawn',
  'race cars on a desert track',
  'race me across the desert',
  'racing across the lagoon',
  'racing cars',
  'racing through a volcanic canyon',
  'snowy volcanic racing',
  'survive the blizzard',
  'sword adventure',
  'sword adventure in ancient ruins',
  'test',
  'test game in the forest',
  'top-down twin stick horde survival',
  'top-down twin stick shooter in a neon city',
  'top-down twin stick shooter in a neon city at night',
  'top-down twin stick shooter on a misty lake',
  'tower defense base defense',
  'tower defense, 6 waves, defend the base',
  'tropical island racing',
  'vampire survivors bullet heaven',
  'volcanic lava fields',
  'epic sword adventure through ancient ruins at dusk',
  'a quiet walk in the forest',
  'a heroic adventure in the forest',
  'kart grand prix on tropical islands',
  'brutal fps deathmatch',
  'collect treasure coins',
  'survive the endless horde',
  'boss battle colossus',
  // the 8+ e2e archetype prompts for this wave
  'race across the volcanic canyon in a desert rally',
  'cozy farming sim with dragons',
  'multiplayer battle royale with jetpacks',
  '',
  'asdfghjkl qwerty zxcvbnm',
  'game',
  '🎮🐉🔥💀👾🛸',
  'snowy volcanic racing with a boss battle and 6 waves',
  'chill forest exploration at dawn with NPC villagers and side quests',
  // whitespace / case / punctuation stress
  '   NEON   CYBERPUNK   FPS   ',
  'Racing!!! Through... the desert???',
  'a'.repeat(2000),
];

const OPTS: { label: string; opts: GenerateOptions }[] = [
  { label: 'default', opts: {} },
  { label: 'seed7', opts: { seed: 7 } },
  { label: 'seed4242', opts: { seed: 4242 } },
  { label: 'genre-override', opts: { genre: 'platformer', seed: 123 } },
  { label: 'env-override', opts: { environment: 'arctic', seed: 456 } },
  { label: 'difficulty-hard', opts: { difficulty: 'hard', seed: 789 } },
];

const rows: { prompt: string; optsLabel: string; spec: string }[] = [];
for (const prompt of PROMPTS) {
  for (const { label, opts } of OPTS) {
    rows.push({ prompt, optsLabel: label, spec: JSON.stringify(generateSpec(prompt, opts)) });
  }
}

const out = resolve(HERE, '../tests/fixtures/prompt-corpus-baseline.json');
writeFileSync(out, JSON.stringify({ generated: 'pre-refactor', rows }, null, 0));
console.log(`wrote ${rows.length} rows to ${out}`);
