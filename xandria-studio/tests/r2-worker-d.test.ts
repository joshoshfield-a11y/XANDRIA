/**
 * Round-2 QA regression tests — worker D.
 *   R2-M4: validateSpec consults the enemy-kind registry for registered custom kinds
 *   R2-N7: registerEnemyKind rejects invalid bases (incl. 'racer', which has no EnemyAI build branch)
 *   R2-N8: registerUpgrade rejects a missing/non-function apply()
 *   R2-N4: applyOverrides reuses one clone per entry (no orphaned clones per wave),
 *           disposes superseded registry-owned clones, never disposes shared originals
 * Pure THREE objects + real Modding/validateSpec — no renderer needed.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { AssetRegistry } from '../src/engine/game/Assets';
import { Modding, CUSTOM_ENEMY_BASES } from '../src/engine/game/Modding';
import { validateSpec, defaultSpec } from '../src/spec/schema';
import type { Engine } from '../src/engine/Engine';
import type { EnemyKind } from '../src/spec/schema';

function specWithAssets(assets: unknown): any {
  return { custom: { assets } };
}

function stdMat(hex: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8 });
}

describe('R2-M4 — validateSpec consults the enemy-kind registry', () => {
  it('a registered custom kind passes validation when the registry is provided', () => {
    const hooks = new Modding({} as Engine);
    hooks.registerEnemyKind('stalker', { base: 'walker', name: 'Stalker' });
    const spec: any = defaultSpec(42);
    spec.enemies[0].kind = 'stalker';
    const v = validateSpec(spec, { customEnemyKinds: hooks.enemyKinds.keys() });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('a custom kind still fails without the registry — validation is not weakened by default', () => {
    const spec: any = defaultSpec(42);
    spec.enemies[0].kind = 'stalker';
    const v = validateSpec(spec);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('enemies[0].kind'))).toBe(true);
    expect(v.errors.some((e) => e.includes('must be one of walker|drone|turret|brute|flyer|racer'))).toBe(true);
  });

  it('an unregistered bogus kind still fails even when custom kinds are provided', () => {
    const hooks = new Modding({} as Engine);
    hooks.registerEnemyKind('stalker', { base: 'walker', name: 'Stalker' });
    const spec: any = defaultSpec(42);
    spec.enemies[0].kind = 'notarealkind';
    const v = validateSpec(spec, { customEnemyKinds: hooks.enemyKinds.keys() });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('enemies[0].kind'))).toBe(true);
  });

  it('built-in kinds still validate with no custom kinds provided', () => {
    expect(validateSpec(defaultSpec(42)).ok).toBe(true);
  });
});

describe('R2-N7 — registerEnemyKind rejects invalid bases', () => {
  it('throws on an unknown base and does not register', () => {
    const hooks = new Modding({} as Engine);
    expect(() =>
      hooks.registerEnemyKind('bad', { base: 'notakind' as EnemyKind, name: 'Bad' }),
    ).toThrow(/unknown base "notakind"/);
    expect(hooks.enemyKinds.has('bad')).toBe(false);
  });

  it("throws on base 'racer' — in ENEMY_KINDS but with no EnemyAI build branch", () => {
    const hooks = new Modding({} as Engine);
    expect(() =>
      hooks.registerEnemyKind('speedy', { base: 'racer' as EnemyKind, name: 'Speedy' }),
    ).toThrow(/racer/);
    expect(hooks.enemyKinds.has('speedy')).toBe(false);
  });

  it('accepts every base with a real EnemyAI build branch', () => {
    const hooks = new Modding({} as Engine);
    for (const base of CUSTOM_ENEMY_BASES) {
      hooks.registerEnemyKind(`kind-${base}`, { base, name: base });
    }
    expect(hooks.enemyKinds.size).toBe(CUSTOM_ENEMY_BASES.length);
  });

  it('throws on a non-object def', () => {
    const hooks = new Modding({} as Engine);
    expect(() => hooks.registerEnemyKind('nulldef', null as any)).toThrow(/must be an object/);
    expect(hooks.enemyKinds.has('nulldef')).toBe(false);
  });
});

describe('R2-N8 — registerUpgrade rejects a missing/non-function apply()', () => {
  it('throws when apply is missing and does not register', () => {
    const hooks = new Modding({} as Engine);
    expect(() =>
      hooks.registerUpgrade({ id: 'noapply', name: 'X', desc: 'd' } as any),
    ).toThrow(/apply must be a function/);
    expect(hooks.upgrades.has('noapply')).toBe(false);
  });

  it('throws when apply is not a function', () => {
    const hooks = new Modding({} as Engine);
    expect(() =>
      hooks.registerUpgrade({ id: 'str', name: 'X', desc: 'd', apply: 'nope' } as any),
    ).toThrow(/apply must be a function/);
    expect(hooks.upgrades.has('str')).toBe(false);
  });

  it('still registers a valid upgrade', () => {
    const hooks = new Modding({} as Engine);
    hooks.registerUpgrade({ id: 'ok', name: 'X', desc: 'd', apply: () => {} });
    expect(hooks.upgrades.has('ok')).toBe(true);
  });
});

describe('R2-N4 — applyOverrides reuses one clone per entry', () => {
  it('repeated applies reuse the same clone — no orphaned clone per wave', () => {
    const reg = new AssetRegistry();
    const mat = stdMat('#112233');
    reg.register('weapon.projectile', { kind: 'weapon', materials: [mat] });

    reg.applyOverrides(specWithAssets({ 'weapon.projectile': { color: '#ff0000' } }));
    const first = reg.currentMaterial('weapon.projectile') as THREE.MeshStandardMaterial;
    expect(first).not.toBe(mat);
    expect('#' + first.color.getHexString()).toBe('#ff0000');
    const disposeSpy = vi.spyOn(first, 'dispose');

    // per-wave re-applies (as spawn-wave blueprints do)
    for (let i = 0; i < 5; i++) {
      reg.applyOverrides(specWithAssets({ 'weapon.projectile': { color: '#ff0000' } }));
    }
    expect(reg.currentMaterial('weapon.projectile')).toBe(first);
    expect(disposeSpy).not.toHaveBeenCalled(); // nothing orphaned, nothing re-cloned
  });

  it('re-applying changed override values updates the same clone', () => {
    const reg = new AssetRegistry();
    reg.register('weapon.projectile', { kind: 'weapon', materials: [stdMat('#112233')] });
    reg.applyOverrides(specWithAssets({ 'weapon.projectile': { color: '#ff0000' } }));
    const first = reg.currentMaterial('weapon.projectile') as THREE.MeshStandardMaterial;
    reg.applyOverrides(
      specWithAssets({ 'weapon.projectile': { color: '#00ff00', emissiveIntensity: 2 } }),
    );
    expect(reg.currentMaterial('weapon.projectile')).toBe(first);
    expect('#' + first.color.getHexString()).toBe('#00ff00');
    expect(first.emissiveIntensity).toBe(2);
  });

  it('the originally registered material is never mutated and never disposed', () => {
    const reg = new AssetRegistry();
    const mat = stdMat('#112233');
    const origDispose = vi.spyOn(mat, 'dispose');
    reg.register('weapon.projectile', { kind: 'weapon', materials: [mat] });
    reg.applyOverrides(specWithAssets({ 'weapon.projectile': { color: '#ff0000' } }));
    reg.applyOverrides(specWithAssets({ 'weapon.projectile': { color: '#ff0000' } }));
    expect('#' + mat.color.getHexString()).toBe('#112233'); // shared entry untouched (M6 holds)
    expect(origDispose).not.toHaveBeenCalled();
  });

  it('re-registering an entry disposes its superseded registry-owned clones', () => {
    const reg = new AssetRegistry();
    const mat = stdMat('#112233');
    const origDispose = vi.spyOn(mat, 'dispose');
    reg.register('pickup.coin', { kind: 'pickup', materials: [mat] });
    reg.applyOverrides(specWithAssets({ 'pickup.coin': { color: '#ff0000' } }));
    const clone = reg.currentMaterial('pickup.coin')!;
    const cloneDispose = vi.spyOn(clone, 'dispose');
    // per-wave re-registration (registerPickupAssets) supersedes the old entry
    reg.register('pickup.coin', { kind: 'pickup', materials: [mat] });
    expect(cloneDispose).toHaveBeenCalled();
    expect(origDispose).not.toHaveBeenCalled(); // the shared original is never disposed
  });
});
