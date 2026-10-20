import { describe, it, expect } from 'vitest';
import { generateSpec, floorPalette } from '../src/generator/generate';
import { validateSpec } from '../src/spec/schema';

const CASES: [string, string][] = [
  ['epic sword adventure through ancient ruins at dusk', 'third-person-action'],
  ['neon cyberpunk fps arena deathmatch', 'fps-arena'],
  ['racing through a volcanic canyon', 'racing'],
  ['dreamy platformer in the clouds', 'platformer'],
  ['top-down twin stick horde survival', 'top-down-shooter'],
  ['a quiet walk in the forest', 'third-person-action'],
  ['kart grand prix on tropical islands', 'racing'],
];

describe('generator', () => {
  it.each(CASES)('"%s" → %s (valid spec)', (intent, genre) => {
    const spec = generateSpec(intent);
    expect(spec.meta.genre).toBe(genre);
    const v = validateSpec(spec);
    expect(v.errors).toEqual([]);
  });

  it('is deterministic per intent', () => {
    const a = generateSpec('neon cyberpunk fps arena deathmatch');
    const b = generateSpec('neon cyberpunk fps arena deathmatch');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different intents → different seeds', () => {
    const a = generateSpec('forest adventure');
    const b = generateSpec('desert adventure');
    expect(a.meta.seed).not.toBe(b.meta.seed);
  });

  it('environment detection works', () => {
    expect(generateSpec('frozen arctic expedition').theme.environment).toBe('arctic');
    expect(generateSpec('cyberpunk neon city nights').theme.environment).toBe('neon-city');
    expect(generateSpec('volcanic lava fields').theme.environment).toBe('volcanic');
    expect(generateSpec('tropical island racing').theme.environment).toBe('islands');
  });

  it('racing specs always have vehicle + chase camera + laps', () => {
    const s = generateSpec('race me across the desert');
    expect(s.player.type).toBe('vehicle');
    expect(s.player.camera).toBe('chase');
    expect(s.objective.type).toBe('race');
    expect(s.objective.count).toBeGreaterThanOrEqual(3);
  });

  it('platformer grants doubleJump and side camera', () => {
    const s = generateSpec('a hard platformer over lava');
    expect(s.player.abilities).toContain('doubleJump');
    expect(s.player.camera).toBe('side');
  });

  it('genre override beats keywords', () => {
    const s = generateSpec('racing cars', { genre: 'platformer' });
    expect(s.meta.genre).toBe('platformer');
  });

  it('100 random intents all validate', () => {
    const words = ['dark', 'forest', 'racing', 'neon', 'zombie', 'platformer', 'boss', 'night', 'snow', 'city', 'quest', 'arena', 'lava', 'sky', 'ruins', 'mech', 'drone', 'sword', 'magic', 'storm'];
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 100; i++) {
      const intent = Array.from({ length: 3 + Math.floor(rnd() * 4) }, () => words[Math.floor(rnd() * words.length)]).join(' ');
      const v = validateSpec(generateSpec(intent));
      if (!v.ok) throw new Error(`intent "${intent}" failed: ${v.errors.join('; ')}`);
    }
  });

  it('eliminate objective never exceeds spawned enemies (P0 winnability)', () => {
    for (const intent of ['neon cyberpunk fps arena', 'brutal fps deathmatch']) {
      const s = generateSpec(intent);
      expect(s.objective.type).toBe('eliminate');
      const total = s.enemies.reduce((n, e) => n + e.count, 0);
      expect(s.objective.count).toBeLessThanOrEqual(total);
    }
  });

  it('racing terrain is flat and smooth (no hill clipping)', () => {
    const s = generateSpec('kart grand prix');
    expect(s.meta.genre).toBe('racing');
    expect(s.world.terrain.type).toBe('flat');
    expect(s.world.terrain.roughness).toBe(0);
    expect(s.world.terrain.maxHeight).toBeLessThanOrEqual(2);
  });

  it('palette floor: dark ground colors are lifted to stay visible at night', () => {
    // neon-city is the darkest palette and defaults to night — the exact combo
    // that rendered an effectively black framebuffer before the floor.
    const s = generateSpec('top-down twin stick shooter in a neon city at night');
    expect(s.theme.timeOfDay).toBe('night');
    const lightness = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    };
    for (const k of ['ground', 'groundAlt', 'rock'] as const) {
      expect(lightness(s.theme.palette[k])).toBeGreaterThanOrEqual(0.20);
    }
  });

  it('floorPalette keeps hue, lifts only dark colors', () => {
    const p = floorPalette({
      primary: '#2a2f45', secondary: '#3d2a5e', accent: '#ff3fd8',
      sky: '#1a1a2e', horizon: '#3a2a5e',
      ground: '#232838', groundAlt: '#c9a869', rock: '#3a4050',
      fog: '#2a2545', water: '#3fd8ff',
    });
    expect(p.ground).not.toBe('#232838'); // lifted
    expect(p.groundAlt).toBe('#c9a869');  // bright already — untouched
    expect(p.sky).toBe('#1a1a2e');        // sky never floored
  });
});

describe('generator variety wave', () => {
  it.each([
    ['vampire survivors bullet heaven swarm', 'survivor'],
    ['auto-shooter bullet heaven run', 'survivor'],
    ['tower defense: defend the base from the waves', 'tower-defense'],
    ['turret defense of the core', 'tower-defense'],
    ['endless runner temple run gauntlet', 'endless-runner'],
    ['subway surfers style lane runner', 'endless-runner'],
  ])('"%s" → %s (valid spec)', (intent, genre) => {
    const spec = generateSpec(intent);
    expect(spec.meta.genre).toBe(genre);
    expect(validateSpec(spec).errors).toEqual([]);
  });

  it('legacy genre mappings are unchanged (new genres only win on better score)', () => {
    // 'horde survival' must NOT become survivor — survivor needs its own keywords
    expect(generateSpec('top-down twin stick horde survival').meta.genre).toBe('top-down-shooter');
    expect(generateSpec('neon cyberpunk fps arena deathmatch').meta.genre).toBe('fps-arena');
    expect(generateSpec('racing through a volcanic canyon').meta.genre).toBe('racing');
  });

  it('score-based matching picks the best-supported interpretation', () => {
    // volcanic has 2 hits (volcanic) vs arctic 1 (snowy); racing 1 — genre wins, env is volcanic
    const s = generateSpec('snowy volcanic racing');
    expect(s.meta.genre).toBe('racing');
    expect(s.theme.environment).toBe('volcanic');
    // tie → list order: neon-city beats desert on a 1–1 tie
    expect(generateSpec('neon desert fps').theme.environment).toBe('neon-city');
  });

  it('survivor spec: top-down, survive chapters + alpha boss, brute guaranteed', () => {
    const s = generateSpec('vampire survivors bullet heaven');
    expect(s.player.camera).toBe('top-down');
    expect(s.player.weapon).toBe('blaster');
    const types = s.objective.stages!.map((st) => st.type);
    expect(types).toEqual(['survive', 'survive', 'boss']);
    expect(s.objective.stages!.every((st) => st.timeLimit === undefined || st.timeLimit >= 0)).toBe(true);
    expect(s.enemies.some((e) => e.kind === 'brute')).toBe(true);
    expect(validateSpec(s).errors).toEqual([]);
  });

  it('tower-defense spec: N waves from the prompt, quotas winnable by construction', () => {
    const s = generateSpec('tower defense, 6 waves, defend the base');
    expect(s.meta.genre).toBe('tower-defense');
    expect(s.objective.stages!.length).toBe(6);
    const stageTotal = s.objective.stages!.reduce((n, st) => n + (st.count ?? 0), 0);
    const rosterTotal = s.enemies.reduce((n, e) => n + e.count, 0);
    expect(s.objective.count).toBe(rosterTotal);
    expect(stageTotal).toBe(rosterTotal);
    expect(s.objective.stages!.every((st) => st.type === 'eliminate')).toBe(true);
    expect((s.custom as any)?.towerDefense?.waves).toBe(6);
    expect(validateSpec(s).errors).toEqual([]);
  });

  it('tower-defense defaults to 4 waves without a count in the prompt', () => {
    const s = generateSpec('tower defense base defense');
    expect(s.objective.stages!.length).toBe(4);
  });

  it('endless-runner spec: chase cam, reach objective, empty roster, target in custom', () => {
    const s = generateSpec('endless runner temple run');
    expect(s.player.camera).toBe('chase');
    expect(s.player.type).toBe('humanoid');
    expect(s.objective.type).toBe('reach');
    expect(s.enemies).toEqual([]);
    expect((s.custom as any)?.runner?.targetDistance).toBe(200);
    expect(s.world.terrain.size).toBeGreaterThan(400); // fits the 200m gauntlet
    expect(validateSpec(s).errors).toEqual([]);
  });

  it('new genres are deterministic per intent', () => {
    for (const intent of ['vampire survivors run', 'tower defense 5 waves', 'endless runner sprint']) {
      expect(JSON.stringify(generateSpec(intent))).toBe(JSON.stringify(generateSpec(intent)));
    }
  });

  it('weapon synonym net: pistol → rifle, laser → blaster, grenade → shotgun, bow → sword', () => {
    expect(generateSpec('pistol duel at dawn').player.weapon).toBe('rifle');
    expect(generateSpec('laser battle in space').player.weapon).toBe('blaster');
    expect(generateSpec('grenade assault on the fortress').player.weapon).toBe('shotgun');
    expect(generateSpec('bow hunter in the woods').player.weapon).toBe('sword');
  });

  it('environment synonym net: castle → ruins, lagoon → islands, blizzard → arctic snow', () => {
    expect(generateSpec('adventure in a haunted castle').theme.environment).toBe('ruins');
    expect(generateSpec('racing across the lagoon').theme.environment).toBe('islands');
    const s = generateSpec('survive the blizzard');
    expect(s.theme.environment).toBe('arctic');
    expect(s.theme.weather).toBe('snow');
  });
});
