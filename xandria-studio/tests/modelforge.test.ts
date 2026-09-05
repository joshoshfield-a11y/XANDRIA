import { describe, it, expect } from 'vitest';
import { forgeHumanoidPlan, forgeVehiclePlan, forgeDronePlan } from '../src/engine/gfx/ModelForge';
import { speciesFor } from '../src/engine/world/Vegetation';

describe('ModelForge determinism', () => {
  it('same seed forges identical humanoid plans', () => {
    const a = forgeHumanoidPlan(42);
    const b = forgeHumanoidPlan(42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds produce visibly different plans', () => {
    const plans = new Set();
    for (let s = 1; s <= 40; s++) plans.add(JSON.stringify(forgeHumanoidPlan(s)));
    expect(plans.size).toBeGreaterThan(30); // near-unique casts
  });

  it('vehicle and drone plans are deterministic', () => {
    expect(JSON.stringify(forgeVehiclePlan(7))).toBe(JSON.stringify(forgeVehiclePlan(7)));
    expect(JSON.stringify(forgeDronePlan(9))).toBe(JSON.stringify(forgeDronePlan(9)));
    expect(JSON.stringify(forgeVehiclePlan(1))).not.toBe(JSON.stringify(forgeVehiclePlan(2)));
  });

  it('respects base colors when provided', () => {
    const p = forgeHumanoidPlan(5, { shirt: '#ff0000' });
    expect(p.colors.shirt).toBe('#ff0000');
  });

  it('plans stay within sane proportions', () => {
    for (let s = 0; s < 100; s++) {
      const p = forgeHumanoidPlan(s);
      expect(p.height).toBeGreaterThanOrEqual(0.9);
      expect(p.height).toBeLessThanOrEqual(1.25);
      expect(p.bulk).toBeGreaterThanOrEqual(0.7);
      expect(p.bulk).toBeLessThanOrEqual(1.9);
    }
  });
});

describe('Vegetation species mapping', () => {
  it('every environment maps to known species', () => {
    const envs = ['forest', 'jungle', 'desert', 'wasteland', 'arctic', 'volcanic', 'city', 'neon-city', 'space-station', 'ruins', 'dreamscape', 'islands', 'arena'];
    for (const e of envs) {
      const sp = speciesFor(e);
      expect(sp.length).toBeGreaterThan(0);
      for (const s of sp) expect(typeof s).toBe('string');
    }
  });

  it('desert has cacti, dreamscape has mushrooms', () => {
    expect(speciesFor('desert')).toContain('cactus');
    expect(speciesFor('dreamscape')).toContain('mushroom');
  });
});
