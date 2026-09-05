// XANDRIA Vegetation System Module
// OP-08 BLOOM: Advanced vegetation synthesis with LOD and wind simulation

export interface VegetationConfig {
  count: number;
  windStrength: number;
  scale: number;
  species: VegetationSpecies[];
  lodEnabled: boolean;
  lodDistances: {
    high: number;
    medium: number;
  };
}

export interface VegetationSpecies {
  id: string;
  name: string;
  trunkMaterial: any;
  foliageMaterial: any;
  geometries: {
    high: { trunk: any; foliage: any };
    medium: { trunk: any; foliage: any };
    low: { trunk: any; foliage: any };
  };
  foliageOffsets: number[][]; // Relative positions for foliage clusters
  maxHeight: number;
  minScale: number;
  maxScale: number;
}

export class VegetationSynthesizer {
  private config: VegetationConfig;
  private instances: VegetationInstance[] = [];
  private lodMeshes: { [key: string]: any[] } = {}; // LOD meshes per species

  constructor(config: VegetationConfig) {
    this.config = config;
    this.initializeLODMeshes();
  }

  // Initialize LOD mesh pools for each species
  private initializeLODMeshes(): void {
    this.config.species.forEach(species => {
      const { id, geometries, trunkMaterial, foliageMaterial } = species;

      // Create 3 InstancedMeshes per species (High, Medium, Low)
      this.lodMeshes[`${id}_trunks`] = [
        new (globalThis as any).THREE.InstancedMesh(geometries.high.trunk, trunkMaterial, this.config.count),
        new (globalThis as any).THREE.InstancedMesh(geometries.medium.trunk, trunkMaterial, this.config.count),
        new (globalThis as any).THREE.InstancedMesh(geometries.low.trunk, trunkMaterial, this.config.count)
      ];

      this.lodMeshes[`${id}_foliage`] = [
        new (globalThis as any).THREE.InstancedMesh(geometries.high.foliage, foliageMaterial, this.config.count * 4),
        new (globalThis as any).THREE.InstancedMesh(geometries.medium.foliage, foliageMaterial, this.config.count * 4),
        new (globalThis as any).THREE.InstancedMesh(geometries.low.foliage, foliageMaterial, this.config.count * 4)
      ];

      // Configure shadow casting
      Object.values(this.lodMeshes).forEach(meshArray => {
        meshArray.forEach(mesh => {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        });
      });
    });
  }

  // Generate vegetation instances based on terrain data
  generateVegetation(terrainData: any): any[] {
    const meshes: any[] = [];
    this.instances = [];

    // Generate placement data based on terrain
    for (let i = 0; i < this.config.count; i++) {
      const instance = this.generateInstance(terrainData);
      if (instance) {
        this.instances.push(instance);
      }
    }

    // Create meshes for each LOD level
    if (this.config.lodEnabled) {
      this.updateLODMeshes();
      Object.values(this.lodMeshes).forEach(meshArray => {
        meshes.push(...meshArray);
      });
    } else {
      // Simple non-LOD rendering
      meshes.push(this.createSimpleMesh());
    }

    return meshes;
  }

  private generateInstance(terrainData: any): VegetationInstance | null {
    // Random position within terrain bounds
    const x = (Math.random() - 0.5) * 800;
    const z = (Math.random() - 0.5) * 800;

    // Sample terrain height (simplified - would use actual heightmap)
    const height = this.sampleTerrainHeight(x, z, terrainData);

    // Only place vegetation above water level
    if (height < 2) return null;

    const species = this.config.species[Math.floor(Math.random() * this.config.species.length)];

    return {
      position: new (globalThis as any).THREE.Vector3(x, height, z),
      rotation: new (globalThis as any).THREE.Euler(0, Math.random() * Math.PI, 0),
      scale: species.minScale + Math.random() * (species.maxScale - species.minScale),
      species: species.id,
      windOffset: Math.random() * Math.PI * 2 // Random wind phase
    };
  }

  private sampleTerrainHeight(x: number, z: number, terrainData: any): number {
    // Simplified terrain sampling - would use actual heightmap data
    const noise2D = (globalThis as any).noise2D || ((x: number, z: number) => Math.sin(x * 0.01) * Math.cos(z * 0.01) * 10);
    return noise2D(x / 120, -z / 120) * 25 + noise2D(x / 30, -z / 30) * 6;
  }

  // Update LOD meshes based on camera position
  updateLODMeshes(cameraPosition?: any): void {
    if (!this.config.lodEnabled) return;

    const camPos = cameraPosition || new (globalThis as any).THREE.Vector3(0, 50, 200);

    // Reset instance counts
    const counts: { [key: string]: number[] } = {};
    Object.keys(this.lodMeshes).forEach(key => {
      counts[key] = [0, 0, 0]; // [high, medium, low]
    });

    const dummy = new (globalThis as any).THREE.Object3D();

    this.instances.forEach(instance => {
      const distance = instance.position.distanceTo(camPos);
      let lodIndex = 2; // Default: Low

      if (distance < this.config.lodDistances.high) {
        lodIndex = 0; // High
      } else if (distance < this.config.lodDistances.medium) {
        lodIndex = 1; // Medium
      }

      this.updateInstanceMatrices(instance, lodIndex, counts, dummy);
    });

    // Update mesh counts
    Object.keys(this.lodMeshes).forEach(key => {
      this.lodMeshes[key].forEach((mesh, lodIndex) => {
        mesh.count = counts[key][lodIndex];
        mesh.instanceMatrix.needsUpdate = true;
      });
    });
  }

  private updateInstanceMatrices(instance: VegetationInstance, lodIndex: number, counts: any, dummy: any): void {
    const species = this.config.species.find(s => s.id === instance.species);
    if (!species) return;

    const trunkKey = `${instance.species}_trunks`;
    const foliageKey = `${instance.species}_foliage`;

    // Update trunk matrix
    const trunkHeight = instance.species === 'pine' ? 6 : (instance.species === 'oak' ? 4 : 5);
    dummy.position.copy(instance.position).add(new (globalThis as any).THREE.Vector3(0, trunkHeight, 0));
    dummy.rotation.copy(instance.rotation);
    dummy.scale.setScalar(instance.scale);
    dummy.updateMatrix();
    this.lodMeshes[trunkKey][lodIndex].setMatrixAt(counts[trunkKey][lodIndex]++, dummy.matrix);

    // Update foliage matrices (multiple per tree)
    this.updateFoliageMatrices(instance, species, lodIndex, counts, dummy);
  }

  private updateFoliageMatrices(instance: VegetationInstance, species: VegetationSpecies, lodIndex: number, counts: any, dummy: any): void {
    const foliageKey = `${instance.species}_foliage`;

    if (instance.species === 'pine') {
      // Pine: Multiple foliage layers
      for (let layer = 0; layer < 3; layer++) {
        const height = 8 + layer * 3;
        dummy.position.copy(instance.position).add(new (globalThis as any).THREE.Vector3(0, height, 0));
        dummy.rotation.copy(instance.rotation);
        dummy.scale.setScalar(instance.scale * (1.2 - layer * 0.3));
        dummy.updateMatrix();
        this.lodMeshes[foliageKey][lodIndex].setMatrixAt(counts[foliageKey][lodIndex]++, dummy.matrix);
      }
    } else if (instance.species === 'oak') {
      // Oak: Multiple foliage clusters
      const offsets = [[0, 6, 0], [2, 7, 1], [-2, 7, -1], [0, 9, 0]];
      offsets.forEach(offset => {
        dummy.position.copy(instance.position).add(new (globalThis as any).THREE.Vector3(...offset));
        dummy.rotation.copy(instance.rotation);
        dummy.scale.setScalar(instance.scale * (0.8 + Math.random() * 0.2));
        dummy.updateMatrix();
        this.lodMeshes[foliageKey][lodIndex].setMatrixAt(counts[foliageKey][lodIndex]++, dummy.matrix);
      });
    } else if (instance.species === 'willow') {
      // Willow: Single large foliage
      dummy.position.copy(instance.position).add(new (globalThis as any).THREE.Vector3(0, 10, 0));
      dummy.rotation.copy(instance.rotation);
      dummy.scale.setScalar(instance.scale * 1.5);
      dummy.updateMatrix();
      this.lodMeshes[foliageKey][lodIndex].setMatrixAt(counts[foliageKey][lodIndex]++, dummy.matrix);
    }
  }

  private createSimpleMesh(): any {
    // Fallback for non-LOD rendering
    const geometry = new (globalThis as any).THREE.InstancedMesh(
      new (globalThis as any).THREE.CylinderGeometry(0.2, 0.3, 4, 8),
      new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x2a1a0f }),
      this.instances.length
    );

    const dummy = new (globalThis as any).THREE.Object3D();
    this.instances.forEach((instance, i) => {
      dummy.position.copy(instance.position);
      dummy.rotation.copy(instance.rotation);
      dummy.scale.setScalar(instance.scale);
      dummy.updateMatrix();
      geometry.setMatrixAt(i, dummy.matrix);
    });

    geometry.instanceMatrix.needsUpdate = true;
    return geometry;
  }

  // Wind animation update (called in render loop)
  updateWindAnimation(time: number): void {
    Object.values(this.lodMeshes).forEach(meshArray => {
      meshArray.forEach(mesh => {
        if (mesh.material.uniforms?.uTime) {
          mesh.material.uniforms.uTime.value = time;
        }
      });
    });
  }

  // Get vegetation density statistics
  getStatistics(): { totalInstances: number; speciesCount: { [key: string]: number } } {
    const speciesCount: { [key: string]: number } = {};
    this.instances.forEach(instance => {
      speciesCount[instance.species] = (speciesCount[instance.species] || 0) + 1;
    });

    return {
      totalInstances: this.instances.length,
      speciesCount
    };
  }

  dispose(): void {
    Object.values(this.lodMeshes).forEach(meshArray => {
      meshArray.forEach(mesh => {
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(mat => mat.dispose());
        } else {
          mesh.material.dispose();
        }
      });
    });
    this.lodMeshes = {};
    this.instances = [];
  }
}

// Predefined vegetation species
export const DEFAULT_SPECIES: VegetationSpecies[] = [
  {
    id: 'pine',
    name: 'Pine Tree',
    trunkMaterial: new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x2a1a0f }),
    foliageMaterial: new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x0a2a0a, roughness: 0.9 }),
    geometries: {
      high: {
        trunk: new (globalThis as any).THREE.CylinderGeometry(0.1, 0.6, 12, 8),
        foliage: new (globalThis as any).THREE.ConeGeometry(3, 6, 8)
      },
      medium: {
        trunk: new (globalThis as any).THREE.CylinderGeometry(0.1, 0.6, 12, 5),
        foliage: new (globalThis as any).THREE.ConeGeometry(3, 6, 5)
      },
      low: {
        trunk: new (globalThis as any).THREE.ConeGeometry(1, 15, 4),
        foliage: new (globalThis as any).THREE.BufferGeometry() // Billboard or simple geometry
      }
    },
    foliageOffsets: [[0, 8, 0], [0, 11, 0], [0, 14, 0]],
    maxHeight: 15,
    minScale: 0.8,
    maxScale: 1.3
  },
  {
    id: 'oak',
    name: 'Oak Tree',
    trunkMaterial: new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x2a1a0f }),
    foliageMaterial: new (globalThis as any).THREE.MeshStandardMaterial({
      color: 0x2a3a0a,
      emissive: 0x0a1100,
      emissiveIntensity: 0.2
    }),
    geometries: {
      high: {
        trunk: new (globalThis as any).THREE.CylinderGeometry(0.5, 0.8, 8, 8),
        foliage: new (globalThis as any).THREE.IcosahedronGeometry(3.5, 1)
      },
      medium: {
        trunk: new (globalThis as any).THREE.CylinderGeometry(0.5, 0.8, 8, 5),
        foliage: new (globalThis as any).THREE.IcosahedronGeometry(3.5, 0)
      },
      low: {
        trunk: new (globalThis as any).THREE.CylinderGeometry(0.6, 0.8, 12, 3),
        foliage: new (globalThis as any).THREE.SphereGeometry(3, 4, 3)
      }
    },
    foliageOffsets: [[0, 6, 0], [2, 7, 1], [-2, 7, -1], [0, 9, 0]],
    maxHeight: 12,
    minScale: 0.7,
    maxScale: 1.4
  },
  {
    id: 'willow',
    name: 'Willow Tree',
    trunkMaterial: new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x2a1a0f }),
    foliageMaterial: new (globalThis as any).THREE.MeshStandardMaterial({
      color: 0x220033,
      emissive: 0xaa00aa,
      emissiveIntensity: 0.4
    }),
    geometries: {
      high: {
        trunk: new (globalThis as any).THREE.CylinderGeometry(0.3, 0.4, 10, 8),
        foliage: new (globalThis as any).THREE.TorusKnotGeometry(2.2, 0.6, 48, 8)
      },
      medium: {
        trunk: new (globalThis as any).THREE.CylinderGeometry(0.3, 0.4, 10, 4),
        foliage: new (globalThis as any).THREE.TorusKnotGeometry(2.2, 0.6, 16, 4)
      },
      low: {
        trunk: new (globalThis as any).THREE.BoxGeometry(0.5, 10, 0.5),
        foliage: new (globalThis as any).THREE.IcosahedronGeometry(3, 0)
      }
    },
    foliageOffsets: [[0, 10, 0]],
    maxHeight: 13,
    minScale: 0.9,
    maxScale: 1.6
  }
];

interface VegetationInstance {
  position: any;
  rotation: any;
  scale: number;
  species: string;
  windOffset: number;
}