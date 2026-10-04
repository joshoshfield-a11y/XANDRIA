import { describe, it, expect } from 'vitest';
import { defaultSpec, validateSpec, type GameSpec } from '../src/spec/schema';
import {
  cloneSpec, getAtPath, setAtPath, validateEditable,
  getStages, inStageMode, addStage, removeStage, moveStage, setStageField,
  enemyKindEnabled, setEnemyKindEnabled, applyEnemyMultipliers, snapshotEnemies,
  PICKUP_KEYS, setPickupEnabled, ensureProgression,
  PALETTE_SWATCHES, applyPaletteSwatch,
  fogSliderToWeather, weatherToFogSlider, fogTierLabel,
  ASSET_GROUPS, applyAssetControl, parsePacks, packsToText,
  ASSET_IDS, reskinNamespaces, customAssetsShape, reskinOverridesPresent,
  getReskinOverride, setReskinOverride, clearCustomAssets, isDefaultReskin,
  checkReskinContract,
  projectToJson, projectFromJson,
} from '../src/studio/editor/specOps';

const spec = (): GameSpec => defaultSpec(1234);

describe('specOps paths', () => {
  it('cloneSpec deep-copies (no aliasing)', () => {
    const s = spec();
    const c = cloneSpec(s);
    c.meta.name = 'changed';
    c.enemies[0].count = 999;
    expect(s.meta.name).not.toBe('changed');
    expect(s.enemies[0].count).not.toBe(999);
  });

  it('getAtPath reads nested values, undefined when missing', () => {
    const s = spec();
    expect(getAtPath(s, ['meta', 'name'])).toBe(s.meta.name);
    expect(getAtPath(s, ['custom', 'forge', 'bulk'])).toBeUndefined();
    expect(getAtPath(s, ['enemies', 0, 'count'])).toBe(s.enemies[0].count);
  });

  it('setAtPath writes nested values, creating intermediates', () => {
    const s = spec() as unknown as Record<string, unknown>;
    setAtPath(s, ['custom', 'forge', 'bulk'], 1.4);
    expect((s.custom as any).forge.bulk).toBe(1.4);
    setAtPath(s, ['custom', 'enemyMods', 'glow'], '#ff0000');
    expect((s.custom as any).enemyMods.glow).toBe('#ff0000');
  });

  it('validateEditable mirrors the real validator', () => {
    expect(validateEditable(spec()).ok).toBe(true);
    const bad = spec();
    bad.meta.name = '';
    const v = validateEditable(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith('meta.name'))).toBe(true);
  });
});

describe('specOps stages', () => {
  it('addStage converts a legacy objective into a 1-chapter chain, then appends', () => {
    const s = spec();
    expect(inStageMode(s)).toBe(false);
    const first = addStage(s);
    expect(inStageMode(s)).toBe(true);
    expect(getStages(s)).toHaveLength(2); // converted legacy + new
    expect(getStages(s)[0].type).toBe(s.objective.type);
    expect(first.description.length).toBeGreaterThan(0);
    expect(validateEditable(s).ok).toBe(true);
  });

  it('removeStage deletes and drops back to legacy mode when empty', () => {
    const s = spec();
    addStage(s); addStage(s);
    expect(getStages(s)).toHaveLength(3);
    removeStage(s, 1);
    expect(getStages(s)).toHaveLength(2);
    removeStage(s, 0); removeStage(s, 0);
    expect(inStageMode(s)).toBe(false);
    expect(s.objective.stages).toBeUndefined();
  });

  it('moveStage reorders chapters', () => {
    const s = spec();
    addStage(s);
    setStageField(s, 0, 'description', 'first');
    setStageField(s, 1, 'description', 'second');
    moveStage(s, 0, 1);
    expect(getStages(s)[0].description).toBe('second');
    expect(getStages(s)[1].description).toBe('first');
    moveStage(s, 0, -1); // no-op at boundary
    expect(getStages(s)[0].description).toBe('second');
  });

  it('setStageField clamps counts and validates types', () => {
    const s = spec();
    addStage(s);
    setStageField(s, 0, 'count', -5);
    expect(getStages(s)[0].count).toBe(0);
    setStageField(s, 0, 'count', 7.8);
    expect(getStages(s)[0].count).toBe(8);
    setStageField(s, 0, 'type', 'boss');
    expect(getStages(s)[0].type).toBe('boss');
    setStageField(s, 0, 'type', 'nonsense');
    expect(getStages(s)[0].type).toBe('boss'); // unchanged
  });

  it('winnability errors surface per stage index', () => {
    const s = spec();
    addStage(s);
    // eliminate more than spawned enemies -> error names the stage
    const total = s.enemies.reduce((a, e) => a + e.count, 0);
    setStageField(s, 0, 'type', 'eliminate');
    setStageField(s, 0, 'count', total + 50);
    const v = validateEditable(s);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith('objective.stages[0].count'))).toBe(true);
  });
});

describe('specOps enemies', () => {
  it('setEnemyKindEnabled adds with defaults and removes cleanly', () => {
    const s = spec();
    const kind = s.enemies[0].kind;
    setEnemyKindEnabled(s, kind, false);
    expect(enemyKindEnabled(s, kind)).toBe(false);
    // removing the only enemy kind breaks the eliminate objective: the editor
    // surfaces this as an inline validation error (never a silent bad spec)
    const v = validateEditable(s);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith('objective.count'))).toBe(true);
    // re-enabling restores validity
    setEnemyKindEnabled(s, kind, true);
    expect(validateEditable(s).ok).toBe(true);
    setEnemyKindEnabled(s, 'brute', true);
    expect(enemyKindEnabled(s, 'brute')).toBe(true);
    const brute = s.enemies.find((e) => e.kind === 'brute')!;
    expect(brute.health).toBeGreaterThan(0);
    expect(brute.count).toBeGreaterThan(0);
    expect(validateEditable(s).ok).toBe(true);
  });

  it('applyEnemyMultipliers scales against the base snapshot without compounding', () => {
    const s = spec();
    const base = snapshotEnemies(s);
    const origCount = base[0].count;
    applyEnemyMultipliers(s, base, { count: 2, hp: 0.5, speed: 1.5 });
    applyEnemyMultipliers(s, base, { count: 2, hp: 0.5, speed: 1.5 }); // repeat: same result
    expect(s.enemies[0].count).toBe(origCount * 2);
    expect(s.enemies[0].health).toBe(Math.round(base[0].health * 0.5));
  });
});

describe('specOps pickups + progression', () => {
  it('setPickupEnabled toggles between 0 and default', () => {
    const s = spec();
    for (const k of PICKUP_KEYS) {
      setPickupEnabled(s, k, false);
      expect(s.pickups[k]).toBe(0);
      setPickupEnabled(s, k, true);
      expect(s.pickups[k]).toBeGreaterThan(0);
    }
    expect(validateEditable(s).ok).toBe(true);
  });

  it('ensureProgression creates defaults when absent', () => {
    const s = spec();
    s.progression = undefined;
    const p = ensureProgression(s);
    expect(p.enabled).toBe(true);
    expect(p.xpPerKill).toBeGreaterThan(0);
    p.xpPerKill = 50;
    expect(ensureProgression(s).xpPerKill).toBe(50); // idempotent
  });
});

describe('specOps world', () => {
  it('PALETTE_SWATCHES covers every environment and validates', () => {
    const s = spec();
    for (const [env, pal] of Object.entries(PALETTE_SWATCHES)) {
      s.theme.palette = { ...pal };
      const v = validateSpec(s);
      expect(v.errors.filter((e) => e.startsWith('theme.palette'))).toEqual([]);
      expect(env.length).toBeGreaterThan(0);
    }
  });

  it('applyPaletteSwatch replaces the palette wholesale', () => {
    const s = spec();
    applyPaletteSwatch(s, 'volcanic');
    expect(s.theme.palette).toEqual(PALETTE_SWATCHES['volcanic']);
    expect(s.theme.palette).not.toBe(PALETTE_SWATCHES['volcanic']); // copied
  });

  it('fog slider maps onto the engine\'s real weather tiers', () => {
    expect(fogSliderToWeather(0)).toBe('clear');
    expect(fogSliderToWeather(50)).toBe('storm');
    expect(fogSliderToWeather(100)).toBe('fog');
    expect(weatherToFogSlider('fog')).toBe(100);
    expect(weatherToFogSlider('clear')).toBeLessThan(33);
    expect(fogTierLabel('fog')).toBe('heavy');
  });
});

describe('specOps asset registry', () => {
  it('every control path roots at a real top-level spec key', () => {
    const topKeys = ['meta', 'theme', 'world', 'player', 'enemies', 'objective', 'pickups', 'rules', 'audio', 'narrative', 'progression', 'custom'];
    for (const g of ASSET_GROUPS) {
      expect(g.namespace.length).toBeGreaterThan(0);
      for (const a of g.assets) {
        expect(a.controls.length).toBeGreaterThan(0);
        for (const c of a.controls) expect(topKeys).toContain(c.path[0]);
      }
    }
  });

  it('applyAssetControl writes values the validator accepts', () => {
    const s = spec();
    for (const g of ASSET_GROUPS) {
      for (const a of g.assets) {
        for (const c of a.controls) {
          const sample = c.kind === 'color' ? '#123456'
            : c.kind === 'toggle' ? true
            : c.kind === 'select' ? c.options![0]
            : (c.min ?? 0) + (c.step ?? 0.1);
          applyAssetControl(s, c, sample);
        }
      }
    }
    const v = validateEditable(s);
    expect(v.errors.filter((e) => e.startsWith('custom.'))).toEqual([]);
  });

  it('parsePacks / packsToText round-trip; bad lines reported', () => {
    const { packs, bad } = parsePacks('trees=https://example.com/trees.glb\nnot-a-line\nrocks=https://example.com/rocks.gltf\n');
    expect(packs).toEqual({ trees: 'https://example.com/trees.glb', rocks: 'https://example.com/rocks.gltf' });
    expect(bad).toEqual(['not-a-line']);
    expect(packsToText(packs)).toContain('trees=https://example.com/trees.glb');
  });
});

describe('specOps project save/load', () => {
  it('projectToJson / projectFromJson round-trip', () => {
    const s = spec();
    s.meta.name = 'My Game';
    const json = projectToJson(s);
    expect(json).toContain('xandria-studio');
    expect(json).toContain('"version": 1');
    const back = projectFromJson(json);
    expect(back.meta.name).toBe('My Game');
    expect(back.meta.seed).toBe(s.meta.seed);
  });

  it('projectFromJson tolerates a bare spec', () => {
    const back = projectFromJson(JSON.stringify(spec()));
    expect(back.meta.seed).toBe(1234);
  });

  it('projectFromJson throws on bad JSON and invalid specs', () => {
    expect(() => projectFromJson('{nope')).toThrow();
    const bad = spec();
    bad.meta.name = '';
    expect(() => projectFromJson(projectToJson(bad))).toThrow(/invalid spec/);
  });
});

describe('specOps reskins (engine asset registry)', () => {
  it('reskinNamespaces groups ASSET_IDS by namespace', () => {
    const ns = reskinNamespaces();
    const byNs = Object.fromEntries(ns.map((n) => [n.namespace, n.ids]));
    expect(byNs.player).toContain('player.body');
    expect(byNs.enemy).toContain('enemy.walker');
    expect(byNs.pickup).toContain('pickup.coin');
    expect(byNs.world).toContain('world.sky');
    const total = ns.reduce((a, n) => a + n.ids.length, 0);
    expect(total).toBe(ASSET_IDS.length);
  });

  it('customAssetsShape distinguishes absent / reskin / packs', () => {
    const s = spec();
    expect(customAssetsShape(s)).toBe('absent');
    setReskinOverride(s, 'enemy.walker', { color: '#ff0000' });
    expect(customAssetsShape(s)).toBe('reskin');
    expect(reskinOverridesPresent(s)).toBe(true);
    clearCustomAssets(s);
    expect(customAssetsShape(s)).toBe('absent');
    s.custom = { assets: { enabled: true, packs: { trees: 'https://example.com/t.glb' } } };
    expect(customAssetsShape(s)).toBe('packs');
  });

  it('set/get/clear reskin overrides; last removal cleans up', () => {
    const s = spec();
    setReskinOverride(s, 'enemy.walker', { color: '#ff0000', scale: 1.5, visible: false });
    expect(getReskinOverride(s, 'enemy.walker')).toEqual({ color: '#ff0000', scale: 1.5, visible: false });
    expect(getReskinOverride(s, 'enemy.drone')).toBeUndefined();
    setReskinOverride(s, 'enemy.walker', undefined);
    expect(getReskinOverride(s, 'enemy.walker')).toBeUndefined();
    expect(customAssetsShape(s)).toBe('absent'); // cleaned up, spec stays valid
    expect(validateEditable(s).ok).toBe(true);
  });

  it('setReskinOverride never clobbers the packs shape', () => {
    const s = spec();
    s.custom = { assets: { enabled: true, packs: {} } };
    setReskinOverride(s, 'enemy.walker', { color: '#ff0000' });
    expect(customAssetsShape(s)).toBe('packs');
    expect(getReskinOverride(s, 'enemy.walker')).toBeUndefined();
  });

  it('isDefaultReskin identifies clean defaults', () => {
    expect(isDefaultReskin({})).toBe(true);
    expect(isDefaultReskin({ scale: 1, visible: true })).toBe(true);
    expect(isDefaultReskin({ color: '#ff0000' })).toBe(false);
    expect(isDefaultReskin({ visible: false })).toBe(false);
  });

  it('checkReskinContract mirrors the engine acceptance rules', () => {
    const s = spec();
    setReskinOverride(s, 'enemy.walker', { color: '#ff0000', scale: 2, visible: true });
    expect(checkReskinContract(s)).toEqual([]);
    // unknown id
    (s.custom as any).assets['nope.nope'] = { color: '#ff0000' };
    expect(checkReskinContract(s).some((p) => p.includes('unknown asset id'))).toBe(true);
    delete (s.custom as any).assets['nope.nope'];
    // bad channels
    (s.custom as any).assets['enemy.walker'] = { color: 'red', scale: 99, visible: 'yes' };
    const problems = checkReskinContract(s);
    expect(problems.length).toBe(3);
  });

  it('reskin projects save and reload (contract-checked, schema-lag tolerated)', () => {
    const s = spec();
    s.meta.name = 'Reskin Game';
    setReskinOverride(s, 'player.body', { color: '#00ff00', scale: 1.2 });
    const back = projectFromJson(projectToJson(s));
    expect(back.meta.name).toBe('Reskin Game');
    expect(getReskinOverride(back, 'player.body')).toEqual({ color: '#00ff00', scale: 1.2 });
  });

  it('projectFromJson rejects bad reskin overrides', () => {
    const s = spec();
    setReskinOverride(s, 'enemy.walker', { color: 'not-a-color' });
    expect(() => projectFromJson(projectToJson(s))).toThrow(/invalid reskin/);
  });

  it('the schema accepts reskin override records', () => {
    // Integration fixed: validateSpec now accepts the override-record shape
    // (no `enabled` key) alongside the legacy AssetPacks shape.
    const s = spec();
    setReskinOverride(s, 'enemy.walker', { color: '#ff0000' });
    const v = validateEditable(s);
    expect(v.ok).toBe(true);
  });

  it('the schema still accepts the legacy AssetPacks shape', () => {
    const s = spec();
    (s as any).custom = { assets: { enabled: true, packs: {} } };
    expect(validateEditable(s).ok).toBe(true);
  });

  it('the schema rejects malformed override values', () => {
    const s = spec();
    setReskinOverride(s, 'enemy.walker', { color: '#ff0000', scale: 'big' as any });
    const v = validateEditable(s);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('custom.assets.enemy.walker.scale'))).toBe(true);
  });
});
