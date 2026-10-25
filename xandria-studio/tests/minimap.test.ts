/**
 * minimap-fog: unit tests for the pure fog-of-war grid and the world→canvas
 * mapping helpers. The DOM/canvas composite path is covered by e2e.
 */
import { describe, expect, it } from 'vitest';
import {
  FogOfWar,
  FOG_TILES,
  EXPLORE_RADIUS_M,
  worldToMap,
  fogTileCell,
} from '../src/engine/ui/Minimap';

const SIZE = 8000; // 8km map like the portal maps

describe('FogOfWar', () => {
  it('starts fully fogged', () => {
    const f = new FogOfWar(SIZE);
    expect(f.revealedTiles).toBe(0);
    expect(f.coverage).toBe(0);
    expect(f.isRevealed(0, 0)).toBe(false);
  });

  it('reveals exactly the tiles whose centers fall inside the radius', () => {
    const f = new FogOfWar(SIZE);
    const r = EXPLORE_RADIUS_M;
    const fresh = f.reveal(0, 0, r);
    // independent oracle: same rule, computed without FogOfWar internals
    const n = f.tilesPerSide;
    const ts = SIZE / n;
    let expected = 0;
    for (let tz = 0; tz < n; tz++) {
      for (let tx = 0; tx < n; tx++) {
        const cx = -SIZE / 2 + (tx + 0.5) * ts;
        const cz = -SIZE / 2 + (tz + 0.5) * ts;
        if (cx * cx + cz * cz <= r * r) expected++;
      }
    }
    expect(fresh).toBe(expected);
    expect(f.revealedTiles).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('re-revealing the same spot reveals nothing new (idempotent)', () => {
    const f = new FogOfWar(SIZE);
    const r = EXPLORE_RADIUS_M;
    const first = f.reveal(100, -200, r);
    expect(first).toBeGreaterThan(0);
    expect(f.reveal(100, -200, r)).toBe(0);
    expect(f.reveal(100, -200, r * 0.5)).toBe(0);
  });

  it('accumulates along a path (exploration history)', () => {
    const f = new FogOfWar(SIZE);
    const r = EXPLORE_RADIUS_M;
    let total = 0;
    // walk east in 100m steps — each step must add fresh tiles
    for (let x = -1000; x <= 1000; x += 100) total += f.reveal(x, 0, r);
    expect(total).toBe(f.revealedTiles);
    expect(f.revealedTiles).toBeGreaterThan(f.reveal(0, 0, r) + 0); // path > spot
    // the walked line is revealed, far corners are not
    expect(f.isRevealed(500, 0)).toBe(true);
    expect(f.isRevealed(-3500, 3500)).toBe(false);
  });

  it('clamps at map edges without throwing', () => {
    const f = new FogOfWar(SIZE);
    const fresh = f.reveal(SIZE / 2 - 10, SIZE / 2 - 10, EXPLORE_RADIUS_M);
    expect(fresh).toBeGreaterThan(0);
    expect(() => f.reveal(SIZE * 2, SIZE * 2, EXPLORE_RADIUS_M)).not.toThrow();
  });

  it('tileOf rejects off-map positions', () => {
    const f = new FogOfWar(SIZE);
    expect(f.tileOf(SIZE / 2, 0)).toBeNull();
    expect(f.tileOf(0, -SIZE / 2 - 1)).toBeNull();
    expect(f.tileOf(0, 0)).not.toBeNull();
  });

  it('coverage is the revealed fraction', () => {
    const f = new FogOfWar(SIZE);
    f.reveal(0, 0, EXPLORE_RADIUS_M);
    expect(f.coverage).toBeCloseTo(f.revealedTiles / (FOG_TILES * FOG_TILES), 12);
  });

  it('two grids on the same map are independent (map-local keying)', () => {
    const a = new FogOfWar(SIZE);
    const b = new FogOfWar(SIZE);
    a.reveal(0, 0, EXPLORE_RADIUS_M);
    expect(b.revealedTiles).toBe(0);
  });

  it('is fully deterministic for a fixed position history', () => {
    const run = () => {
      const f = new FogOfWar(SIZE);
      for (const [x, z] of [[0, 0], [300, 100], [-500, 800], [300, 100]] as const)
        f.reveal(x, z, EXPLORE_RADIUS_M);
      return f.revealedTiles;
    };
    expect(run()).toBe(run());
  });
});

describe('worldToMap', () => {
  const half = SIZE / 2;
  const px = 208;
  it('maps map corners to canvas corners (north up)', () => {
    const [x0, y0] = worldToMap(-half, half, half, px);   // NW
    const [x1, y1] = worldToMap(half, -half, half, px);   // SE
    expect(x0).toBeCloseTo(0, 9);
    expect(y0).toBeCloseTo(0, 9);
    expect(x1).toBeCloseTo(px, 9);
    expect(y1).toBeCloseTo(px, 9);
  });
  it('maps the origin to the canvas center', () => {
    const [x, y] = worldToMap(0, 0, half, px);
    expect(x).toBeCloseTo(px / 2, 9);
    expect(y).toBeCloseTo(px / 2, 9);
  });
});

describe('fogTileCell', () => {
  it('flips the z row (tile tz=0, south edge, is the bottom canvas row)', () => {
    expect(fogTileCell(0, 0)).toEqual([0, FOG_TILES - 1]);
    expect(fogTileCell(FOG_TILES - 1, FOG_TILES - 1)).toEqual([FOG_TILES - 1, 0]);
  });
  it('tile (tx,tz) covers the same world area as its canvas cell', () => {
    const f = new FogOfWar(SIZE);
    // round-trip: world pos of a tile center → tileOf must return the tile,
    // and its canvas cell must sit at the mapped pixel.
    for (const [tx, tz] of [[0, 0], [63, 64], [127, 127], [10, 100]] as const) {
      const [cx, cz] = f.tileCenter(tx, tz);
      expect(f.tileOf(cx, cz)).toEqual([tx, tz]);
      const [px, py] = worldToMap(cx, cz, f.half, FOG_TILES);
      const [cellX, cellY] = fogTileCell(tx, tz);
      expect(Math.floor(px)).toBe(cellX);
      expect(Math.floor(py)).toBe(cellY);
    }
  });
});
