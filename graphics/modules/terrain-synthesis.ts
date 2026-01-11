// XANDRIA Terrain Synthesis Module
// OP-22 MATRIX: Planetary-scale terrain generation with progressive enhancement

import { createNoise2D } from 'simplex-noise';

export interface TerrainConfig {
  size: number;
  resolution: number;
  noiseScale: number;
  heightScale: number;
  octaves: number;
  persistence: number;
  lacunarity: number;
  seed?: string;
  waterLevel?: number;
}

export interface LODConfig {
  levels: Array<{
    distance: number;
    resolution: number;
    quality: 'high' | 'medium' | 'low';
  }>;
}

export class TerrainSynthesizer {
  private noise2D: any;
  private config: TerrainConfig;

  constructor(config: TerrainConfig) {
    this.config = config;
    this.noise2D = createNoise2D(config.seed ? parseInt(config.seed, 36) : undefined);
  }

  // OP-22 MATRIX: Core terrain generation
  generateTerrain(): any {
    const { size, resolution, noiseScale, heightScale, octaves, persistence, lacunarity, waterLevel } = this.config;

    // Create geometry
    const geometry = new (globalThis as any).THREE.PlaneGeometry(size, size, resolution, resolution);
    const positions = geometry.attributes.position.array;

    // Apply fractal noise displacement
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i];
      const z = positions[i + 2];

      let height = 0;
      let amplitude = 1;
      let frequency = 1 / noiseScale;

      // Multi-octave noise for natural terrain
      for (let octave = 0; octave < octaves; octave++) {
        height += this.noise2D(x * frequency, z * frequency) * amplitude;
        amplitude *= persistence;
        frequency *= lacunarity;
      }

      positions[i + 1] = height * heightScale;

      // Optional water level adjustment
      if (waterLevel !== undefined && positions[i + 1] < waterLevel) {
        positions[i + 1] = waterLevel;
      }
    }

    geometry.computeVertexNormals();

    // Create material with PBR properties
    const material = new (globalThis as any).THREE.MeshStandardMaterial({
      color: this.getTerrainColor(),
      roughness: 0.8,
      metalness: 0.1,
      normalScale: new (globalThis as any).THREE.Vector2(1, 1)
    });

    // Create mesh
    const mesh = new (globalThis as any).THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    mesh.castShadow = true;

    return mesh;
  }

  // Generate terrain with LOD support (Stage 2 enhancement)
  generateTerrainLOD(lodConfig: LODConfig): any[] {
    const terrains: any[] = [];

    lodConfig.levels.forEach(level => {
      // Create terrain at different resolutions for LOD
      const lodConfig = { ...this.config, resolution: level.resolution };
      const tempSynthesizer = new TerrainSynthesizer(lodConfig);
      const terrain = tempSynthesizer.generateTerrain();

      // Tag with LOD information
      terrain.userData.lodLevel = level.quality;
      terrain.userData.lodDistance = level.distance;

      terrains.push(terrain);
    });

    return terrains;
  }

  // Get biome-appropriate color based on height and location
  private getTerrainColor(): number {
    // Simple height-based coloring (can be enhanced with biomes)
    const height = Math.random(); // Simplified - would use actual height data

    if (height < 0.3) return 0x2d4a22; // Low areas - dark green
    if (height < 0.6) return 0x4a5d23; // Mid areas - green
    if (height < 0.8) return 0x6b4423; // High areas - brown
    return 0x8b7355; // Peaks - light brown
  }

  // Export terrain data for external use
  exportTerrainData(): any {
    return {
      config: this.config,
      heightmap: this.generateHeightmap(),
      metadata: {
        generator: 'OP-22 MATRIX',
        version: '1.0',
        timestamp: Date.now()
      }
    };
  }

  // Generate heightmap for external processing
  private generateHeightmap(): number[][] {
    const { resolution, noiseScale, heightScale, octaves, persistence, lacunarity } = this.config;
    const heightmap: number[][] = [];

    for (let x = 0; x <= resolution; x++) {
      heightmap[x] = [];
      for (let z = 0; z <= resolution; z++) {
        const worldX = (x - resolution / 2) * (this.config.size / resolution);
        const worldZ = (z - resolution / 2) * (this.config.size / resolution);

        let height = 0;
        let amplitude = 1;
        let frequency = 1 / noiseScale;

        for (let octave = 0; octave < octaves; octave++) {
          height += this.noise2D(worldX * frequency, worldZ * frequency) * amplitude;
          amplitude *= persistence;
          frequency *= lacunarity;
        }

        heightmap[x][z] = height * heightScale;
      }
    }

    return heightmap;
  }
}

// Factory functions for different terrain types
export function createMountainTerrain(size = 300, resolution = 256): TerrainSynthesizer {
  return new TerrainSynthesizer({
    size,
    resolution,
    noiseScale: 50,
    heightScale: 15,
    octaves: 4,
    persistence: 0.5,
    lacunarity: 2.0,
    waterLevel: -2
  });
}

export function createPlainsTerrain(size = 500, resolution = 128): TerrainSynthesizer {
  return new TerrainSynthesizer({
    size,
    resolution,
    noiseScale: 100,
    heightScale: 3,
    octaves: 3,
    persistence: 0.6,
    lacunarity: 1.8
  });
}

export function createIslandTerrain(size = 400, resolution = 200): TerrainSynthesizer {
  return new TerrainSynthesizer({
    size,
    resolution,
    noiseScale: 80,
    heightScale: 8,
    octaves: 5,
    persistence: 0.4,
    lacunarity: 2.2,
    waterLevel: 0
  });
}