/**
 * builders.test.ts — SkinBuilder (character + item-skin variant) and
 * ItemBuilder produce spec-valid defs; validate() catches what
 * validateSpec catches, with meaningful `path: message` strings.
 */
import { describe, expect, it } from 'vitest';
import { SkinBuilder, ItemSkinBuilder } from '../src/engine/gfx/SkinBuilder';
import { ItemBuilder } from '../src/engine/game/items/ItemBuilder';
import { validateSpec, defaultSpec } from '@spec';

describe('SkinBuilder (character skins)', () => {
  it('builds a valid character skin that passes validateSpec', () => {
    const def = new SkinBuilder('ember')
      .displayName('Ember Warden')
      .palette({ skin: '#d9a066', shirt: '#5a1f1f', pants: '#241a1a', accent: '#ff7700' })
      .pattern('carbon')
      .emissive('#ff7700', 2)
      .roughness(0.4)
      .metalness(0.2)
      .build();
    expect(def.name).toBe('Ember Warden');
    expect(def.texture).toEqual({ pattern: 'carbon' });

    const b = new SkinBuilder('ember')
      .displayName('Ember Warden')
      .palette({ shirt: '#5a1f1f' })
      .emissive('#ff7700', 2)
      .roughness(0.4);
    expect(b.validate()).toEqual([]);

    // and the def really does pass validateSpec inside a synthetic spec
    const spec = defaultSpec(1);
    spec.custom = { characters: { skins: { ember: def } } };
    expect(validateSpec(spec).errors).toEqual([]);
  });

  it('validate() catches what validateSpec catches, with real path: message strings', () => {
    const b = new SkinBuilder('bad');
    b.displayName('Bad')
      .paletteRole('shirt', 'not-a-hex')
      .emissive('red', 99)
      .roughness(2);
    const errors = b.validate();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('.palette.shirt: must be #rrggbb'))).toBe(true);
    expect(errors.some((e) => e.includes('.emissive.color: must be #rrggbb'))).toBe(true);
    expect(errors.some((e) => e.includes('.emissive.intensity: must be 0..5'))).toBe(true);
    expect(errors.some((e) => e.includes('.roughness: must be 0..1'))).toBe(true);
  });

  it('flags a bad pattern and a bad texture url', () => {
    const badPattern = new SkinBuilder('x').displayName('X').textureUrl('https://a.example/t.png');
    expect(badPattern.validate()).toEqual([]); // valid url passes

    const url = new SkinBuilder('x').displayName('X').textureUrl('http://not-https.example/t.bmp');
    expect(url.validate().some((e) => e.includes('.texture.url: must be an https URL ending in .png/.jpg/.jpeg/.webp'))).toBe(true);

    // pattern not in the pattern enum — cast through unknown to simulate JSON input
    const def = { name: 'X', texture: { pattern: 'plaid' } };
    const spec = defaultSpec(1);
    spec.custom = { characters: { skins: { x: def as never } } };
    const errs = validateSpec(spec).errors;
    expect(errs.some((e) => e.includes('.texture.pattern: must be one of camo|stripes|digital|carbon|hazard|fade|runes'))).toBe(true);
  });

  it('flags an empty name', () => {
    const errors = new SkinBuilder('x').displayName('').validate();
    expect(errors.some((e) => e.includes('.name: must be a non-empty string'))).toBe(true);
  });
});

describe('SkinBuilder.forItem() (item skins)', () => {
  it('builds a valid item skin with primary|secondary|glow roles', () => {
    const def = new SkinBuilder('ember-blade')
      .displayName('Ember Blade')
      .forItem()
      .palette({ primary: '#8a1f1f', secondary: '#2a1414', glow: '#ff7700' })
      .emissive('#ff7700', 1.5)
      .pattern('runes')
      .build();
    expect(def.palette).toEqual({ primary: '#8a1f1f', secondary: '#2a1414', glow: '#ff7700' });

    const b = new ItemSkinBuilder('ember-blade').displayName('Ember Blade')
      .palette({ primary: '#8a1f1f' });
    expect(b.validate()).toEqual([]);

    const spec = defaultSpec(1);
    spec.custom = { items: { skins: { 'ember-blade': def } } };
    expect(validateSpec(spec).errors).toEqual([]);
  });

  it('catches a wrong-role palette key with the real validator string', () => {
    const def = { name: 'X', palette: { shirt: '#ff0000' } }; // shirt is a character role
    const spec = defaultSpec(1);
    spec.custom = { items: { skins: { x: def as never } } };
    const errs = validateSpec(spec).errors;
    expect(errs.some((e) => e.includes('.palette.shirt: unknown role (primary|secondary|glow)'))).toBe(true);
  });
});

describe('ItemBuilder', () => {
  it('builds a valid weapon def matching the task example', () => {
    const def = new ItemBuilder('ember_blade')
      .named('Ember Blade')
      .weapon('weapon')
      .stat('damage', 12)
      .rarity('rare')
      .skin('ember')
      .stackable(1)
      .build();
    expect(def).toEqual({
      name: 'Ember Blade',
      type: 'weapon',
      slot: 'weapon',
      stats: { damage: 12 },
      rarity: 'rare',
      skin: 'ember',
      stack: 1,
    });

    const b = new ItemBuilder('ember_blade')
      .named('Ember Blade')
      .weapon('weapon')
      .stat('damage', 12)
      .rarity('rare')
      .skin('ember')
      .stackable(1);
    expect(b.validate()).toEqual([]);

    const spec = defaultSpec(1);
    spec.custom = { items: { defs: { ember_blade: def } } };
    expect(validateSpec(spec).errors).toEqual([]);
  });

  it('requires a type choice and reports it in builder terms', () => {
    const errors = new ItemBuilder('x').named('X').validate();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('.type: builder never chose a type'))).toBe(true);
  });

  it('requires slot for weapon/armor', () => {
    const b = new ItemBuilder('x').named('X').type('weapon');
    expect(b.validate().some((e) => e.includes('.slot: required for weapon/armor items'))).toBe(true);
  });

  it('catches stat, stack, value, description and behavior violations with real strings', () => {
    const b = new ItemBuilder('x')
      .named('X')
      .consumable()
      .stat('damage', 99999)          // out of -1000..10000
      .stat('nope' as never, 1)       // unknown stat
      .behavior('zap' as never, -5)   // bad effect, bad amount
      .stackable(0)                   // not 1..999
      .value(-1)                      // negative
      .description('y'.repeat(300));  // > 280 chars
    const errors = b.validate();
    expect(errors.some((e) => e.includes('.stats.damage: must be a finite number -1000..10000'))).toBe(true);
    expect(errors.some((e) => e.includes('.stats.nope: unknown stat (damage|defense|speed|maxHealth|crit|attackSpeed|luck)'))).toBe(true);
    expect(errors.some((e) => e.includes('.behavior.effect: must be heal|restore|buff'))).toBe(true);
    expect(errors.some((e) => e.includes('.behavior.amount: must be a number 0..100000'))).toBe(true);
    expect(errors.some((e) => e.includes('.stack: must be an integer 1..999'))).toBe(true);
    expect(errors.some((e) => e.includes('.value: must be a number >= 0'))).toBe(true);
    expect(errors.some((e) => e.includes('.description: must be <= 280 chars'))).toBe(true);
  });

  it('flags a bad model url with the real string', () => {
    const b = new ItemBuilder('x').named('X').consumable().model('ftp://x.example/a.obj');
    expect(b.validate().some((e) => e.includes('.model: must be an https URL ending in .glb/.gltf'))).toBe(true);
  });

  it('flags empty name with the real string', () => {
    const b = new ItemBuilder('x').named('').consumable();
    expect(b.validate().some((e) => e.includes('.name: must be a non-empty string'))).toBe(true);
  });

  it('shorthands set the right type', () => {
    expect(new ItemBuilder('a').named('A').armor('torso').build().type).toBe('armor');
    expect(new ItemBuilder('m').named('M').material().build().type).toBe('material');
    expect(new ItemBuilder('k').named('K').key().build().type).toBe('key');
    expect(new ItemBuilder('t').named('T').trinket().build().type).toBe('trinket');
  });
});
