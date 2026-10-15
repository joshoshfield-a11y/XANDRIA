/**
 * Portals workstream B: unit tests for the pure edge-trigger / debounce
 * logic (PortalTrigger) and the map-graph contract stub (MapGraph).
 * No renderer, no physics, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { PortalTrigger } from '../src/engine/world/PortalTrigger';
import { portalsEnabled } from '../src/spec/schema';
import {
  deriveMapSeed,
  neighborOf,
  oppositeEdge,
  type MapCoord,
} from '../src/engine/world/MapGraph';

const HALF = 4000;

function walk(trigger: PortalTrigger, path: Array<[number, number]>, t0 = 1000, stepMs = 16): ReturnType<PortalTrigger['sample']> {
  let out = null;
  let t = t0;
  for (const [x, z] of path) {
    out = trigger.sample(x, z, t) ?? out;
    t += stepMs;
  }
  return out;
}

describe('portalsEnabled (canonical, workstream C)', () => {
  const spec = (portals?: { enabled: boolean }) =>
    ({
      world: {
        terrain: { size: 8000 },
        boundary: 'walls',
        ...(portals === undefined ? {} : { portals }),
      },
    }) as unknown as Parameters<typeof portalsEnabled>[0];

  it('world.portals.enabled === true is on', () => {
    expect(portalsEnabled(spec({ enabled: true }))).toBe(true);
  });

  it('explicit false and absent are off — no size/boundary fallback', () => {
    expect(portalsEnabled(spec({ enabled: false }))).toBe(false);
    expect(portalsEnabled(spec())).toBe(false);
  });

  it('the 8km default lives in the generator, not the runtime check', () => {
    // an 8km walls map WITHOUT the flag keeps legacy walls (arena-safe)
    expect(portalsEnabled(spec())).toBe(false);
  });
});

describe('PortalTrigger', () => {
  it('fires on a sustained inward→outward crossing of the north edge', () => {
    const tr = new PortalTrigger({ half: HALF });
    // walk north from mid-map to the edge plane over ~1s of samples
    const path: Array<[number, number]> = [];
    for (let i = 0; i <= 70; i++) path.push([100, 3900 + i * 1.6]);
    let fired: string | null = null;
    let t = 1000;
    for (const [x, z] of path) {
      const e = tr.sample(x, z, t);
      if (e) fired = e;
      t += 16;
    }
    expect(fired).toBe('N');
  });

  it('does not fire for a walk parallel to the edge inside the band', () => {
    const tr = new PortalTrigger({ half: HALF });
    const path: Array<[number, number]> = [];
    for (let i = 0; i <= 60; i++) path.push([-500 + i * 10, 3995]); // d=5, inside band, parallel
    let fired: string | null = null;
    let t = 1000;
    for (const [x, z] of path) {
      const e = tr.sample(x, z, t);
      if (e) fired = e;
      t += 16;
    }
    expect(fired).toBeNull();
  });

  it('disarms when the player drifts back inward — no trip', () => {
    const tr = new PortalTrigger({ half: HALF });
    const path: Array<[number, number]> = [];
    for (let i = 0; i < 30; i++) path.push([0, 3992 + i * 0.2]); // into the band…
    for (let i = 0; i < 30; i++) path.push([0, 3998 - i * 5]); // …then back inward
    let fired: string | null = null;
    let t = 1000;
    for (const [x, z] of path) {
      const e = tr.sample(x, z, t);
      if (e) fired = e;
      t += 16;
    }
    expect(fired).toBeNull();
    expect(tr.armed).toBeNull();
  });

  it('jumping near the edge never false-trips (vertical motion is invisible)', () => {
    const tr = new PortalTrigger({ half: HALF });
    // 5 seconds of samples at the same X/Z inside the band — jumping changes
    // only Y, which the trigger never reads
    let fired: string | null = null;
    for (let i = 0; i < 300; i++) {
      const e = tr.sample(200, 3994, 1000 + i * 16);
      if (e) fired = e;
    }
    expect(fired).toBeNull();
  });

  it('a dash across the edge in a single frame still fires (no tunneling past the sustain check)', () => {
    const tr = new PortalTrigger({ half: HALF, armMs: 0 });
    expect(tr.sample(0, 3900, 1000)).toBeNull(); // outside
    expect(tr.sample(0, 3995, 1016)).toBeNull(); // in band, armed
    expect(tr.sample(0, 4001, 1032)).toBe('N'); // past the plane
  });

  it('ignores samples while locked (transition in flight)', () => {
    const tr = new PortalTrigger({ half: HALF, armMs: 0 });
    tr.lock();
    expect(tr.sample(0, 3995, 1000)).toBeNull();
    expect(tr.sample(0, 4001, 1016)).toBeNull();
  });

  it('enforces the cooldown after unlock — no immediate re-fire at the edge', () => {
    const tr = new PortalTrigger({ half: HALF, armMs: 0, cooldownMs: 2500 });
    tr.lock();
    tr.unlock(5000);
    expect(tr.sample(0, 3995, 6000)).toBeNull(); // inside cooldown
    expect(tr.sample(0, 4001, 6000)).toBeNull();
    // after the cooldown the edge is live again
    expect(tr.sample(0, 3900, 8000)).toBeNull(); // outside → stays disarmed
    expect(tr.sample(0, 3995, 8016)).toBeNull(); // armed
    expect(tr.sample(0, 4001, 8032)).toBe('N');
  });

  it('fires for each of the four edges', () => {
    for (const [edge, x0, z0, dx, dz] of [
      ['N', 0, 3900, 0, 2],
      ['S', 0, -3900, 0, -2],
      ['E', 3900, 0, 2, 0],
      ['W', -3900, 0, -2, 0],
    ] as Array<[string, number, number, number, number]>) {
      const tr = new PortalTrigger({ half: HALF, armMs: 0 });
      let fired: string | null = null;
      for (let i = 0; i <= 60; i++) {
        const e = tr.sample(x0 + dx * i, z0 + dz * i, 1000 + i * 16);
        if (e) fired = e;
      }
      expect(fired).toBe(edge);
    }
  });

  it('mid-map samples never arm or fire', () => {
    const tr = new PortalTrigger({ half: HALF });
    for (let i = 0; i < 100; i++) {
      expect(tr.sample(i * 3 - 100, i * 2 - 50, 1000 + i * 16)).toBeNull();
    }
    expect(tr.armed).toBeNull();
  });
});

describe('MapGraph contract (workstream C stub)', () => {
  const c: MapCoord = { mx: 2, my: -3 };

  it('neighborOf follows the brief: N of (mx,my) is (mx,my+1)', () => {
    expect(neighborOf(c, 'N')).toEqual({ mx: 2, my: -2 });
    expect(neighborOf(c, 'S')).toEqual({ mx: 2, my: -4 });
    expect(neighborOf(c, 'E')).toEqual({ mx: 3, my: -3 });
    expect(neighborOf(c, 'W')).toEqual({ mx: 1, my: -3 });
  });

  it('oppositeEdge is an involution', () => {
    for (const e of ['N', 'S', 'E', 'W'] as const) {
      expect(oppositeEdge(oppositeEdge(e))).toBe(e);
    }
    expect(oppositeEdge('N')).toBe('S');
    expect(oppositeEdge('E')).toBe('W');
  });

  it('deriveMapSeed is deterministic and coordinate-sensitive', () => {
    const a = deriveMapSeed(12345, 0, 0);
    // canonical (workstream C): the origin map is hashed like every other
    // map — no (0,0) special case
    expect(a).toBe(3166736457);
    expect(deriveMapSeed(12345, 0, 0)).toBe(a);
    expect(deriveMapSeed(12345, 0, 1)).not.toBe(a);
    expect(deriveMapSeed(12345, 1, 0)).not.toBe(a);
    expect(deriveMapSeed(12346, 0, 0)).not.toBe(a);
    expect(deriveMapSeed(12345, -1, -1)).not.toBe(a);
    expect(Number.isInteger(a) && a >= 0 && a <= 0xffffffff).toBe(true);
  });

  it('round trip (0,0)→(0,1)→(0,0) is the identity on coords and seeds', () => {
    const start: MapCoord = { mx: 0, my: 0 };
    const there = neighborOf(start, 'N');
    expect(there).toEqual({ mx: 0, my: 1 });
    const back = neighborOf(there, 'S');
    expect(back).toEqual(start);
    expect(deriveMapSeed(777, there.mx, there.my)).toBe(deriveMapSeed(777, 0, 1));
    expect(deriveMapSeed(777, back.mx, back.my)).toBe(deriveMapSeed(777, 0, 0));
  });
});
