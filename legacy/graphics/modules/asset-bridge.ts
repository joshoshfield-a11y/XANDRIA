// XANDRIA Asset Bridge Module
// Stage 3 Enhancement: External asset integration with GLTF support

export interface AssetConfig {
  fallbackToProcedural: boolean;
  timeout: number;
  maxRetries: number;
  assetQuality: 'high' | 'medium' | 'low';
}

export interface AssetDefinition {
  id: string;
  name: string;
  url?: string; // External GLTF URL
  category: 'vegetation' | 'rocks' | 'buildings' | 'props';
  proceduralFallback: () => any; // Function to generate procedural version
  scale: number;
  lodLevels?: number;
}

export class AssetBridge {
  private config: AssetConfig;
  private loadedAssets: Map<string, any> = new Map();
  private loadingPromises: Map<string, Promise<any>> = new Map();

  constructor(config: AssetConfig) {
    this.config = config;
  }

  // Load external GLTF asset with fallback
  async loadAsset(assetDef: AssetDefinition): Promise<any> {
    const cacheKey = assetDef.id;

    // Return cached asset if available
    if (this.loadedAssets.has(cacheKey)) {
      return this.loadedAssets.get(cacheKey);
    }

    // Return existing promise if already loading
    if (this.loadingPromises.has(cacheKey)) {
      return this.loadingPromises.get(cacheKey);
    }

    // Start loading process
    const loadPromise = this.performAssetLoad(assetDef);
    this.loadingPromises.set(cacheKey, loadPromise);

    try {
      const asset = await loadPromise;
      this.loadedAssets.set(cacheKey, asset);
      this.loadingPromises.delete(cacheKey);
      return asset;
    } catch (error) {
      this.loadingPromises.delete(cacheKey);

      if (this.config.fallbackToProcedural) {
        console.warn(`XANDRIA Asset Bridge: Failed to load ${assetDef.name}, using procedural fallback`);
        const proceduralAsset = assetDef.proceduralFallback();
        this.loadedAssets.set(cacheKey, proceduralAsset);
        return proceduralAsset;
      }

      throw error;
    }
  }

  private async performAssetLoad(assetDef: AssetDefinition): Promise<any> {
    if (!assetDef.url) {
      // No external URL, use procedural fallback immediately
      return assetDef.proceduralFallback();
    }

    // Load external GLTF asset
    const GLTFLoader = (await import('three/examples/jsm/loaders/GLTFLoader.js')).GLTFLoader;
    const loader = new GLTFLoader();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Asset load timeout: ${assetDef.name}`));
      }, this.config.timeout);

      loader.load(
        assetDef.url!,
        (gltf) => {
          clearTimeout(timeoutId);

          // Process GLTF data
          const firstChild = gltf.scene.children[0] as any; // Cast to any for Three.js mesh
          const processedAsset = {
            geometry: firstChild?.geometry,
            material: firstChild?.material,
            animations: gltf.animations,
            originalScene: gltf.scene,
            metadata: {
              source: 'external',
              url: assetDef.url,
              category: assetDef.category,
              scale: assetDef.scale
            }
          };

          resolve(processedAsset);
        },
        (progress) => {
          // Loading progress callback
          console.log(`Loading ${assetDef.name}: ${(progress.loaded / progress.total * 100)}%`);
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        }
      );
    });
  }

  // Create instanced mesh from loaded asset
  createInstancedMesh(asset: any, count: number): any {
    if (!asset.geometry) {
      throw new Error('Asset does not contain geometry');
    }

    const InstancedMesh = (globalThis as any).THREE.InstancedMesh;
    const mesh = new InstancedMesh(
      asset.geometry,
      asset.material || new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x888888 }),
      count
    );

    // Configure for shadows and performance
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;

    return mesh;
  }

  // Batch load multiple assets
  async loadAssetBatch(assetDefs: AssetDefinition[]): Promise<any[]> {
    const loadPromises = assetDefs.map(def => this.loadAsset(def));
    return Promise.all(loadPromises);
  }

  // Create LOD versions of assets
  createLODVersions(asset: any, levels: number = 3): any[] {
    const lodVersions: any[] = [asset]; // Original is LOD 0 (highest quality)

    // Create simplified versions for lower LOD levels
    for (let i = 1; i < levels; i++) {
      const lodAsset = this.simplifyAsset(asset, i);
      lodVersions.push(lodAsset);
    }

    return lodVersions;
  }

  private simplifyAsset(asset: any, level: number): any {
    // Create simplified version based on LOD level
    const simplificationFactor = Math.pow(0.5, level);

    // For now, return a scaled version - in production this would use mesh decimation
    const simplified = {
      ...asset,
      geometry: asset.geometry.clone(),
      metadata: {
        ...asset.metadata,
        lodLevel: level,
        simplificationFactor
      }
    };

    // Scale down geometry complexity (simplified implementation)
    if (simplified.geometry.attributes.position) {
      const positions = simplified.geometry.attributes.position.array;
      // Apply simplification algorithm here in production
    }

    return simplified;
  }

  // Get asset loading statistics
  getStatistics(): { loadedCount: number; loadingCount: number; failedCount: number } {
    return {
      loadedCount: this.loadedAssets.size,
      loadingCount: this.loadingPromises.size,
      failedCount: 0 // Would track failed loads in production
    };
  }

  // Clear asset cache
  clearCache(): void {
    this.loadedAssets.clear();
    this.loadingPromises.clear();
  }

  // Dispose of loaded assets
  dispose(): void {
    this.loadedAssets.forEach(asset => {
      if (asset.geometry) asset.geometry.dispose();
      if (asset.material) {
        if (Array.isArray(asset.material)) {
          asset.material.forEach((mat: any) => mat.dispose());
        } else {
          asset.material.dispose();
        }
      }
    });

    this.clearCache();
  }
}

// Predefined asset library (Khronos Group samples + procedural fallbacks)
export const STANDARD_ASSETS: AssetDefinition[] = [
  {
    id: 'spruce_tree',
    name: 'Spruce Tree',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/SpruceTree/glTF-Binary/SpruceTree.glb',
    category: 'vegetation',
    scale: 1.0,
    proceduralFallback: () => ({
      geometry: new (globalThis as any).THREE.CylinderGeometry(0.1, 1, 15, 8),
      material: new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x2a1a0f }),
      metadata: { source: 'procedural', category: 'vegetation' }
    })
  },
  {
    id: 'rock',
    name: 'Sedimentary Rock',
    url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Rock/glTF-Binary/Rock.glb',
    category: 'rocks',
    scale: 1.0,
    proceduralFallback: () => ({
      geometry: new (globalThis as any).THREE.DodecahedronGeometry(2, 0),
      material: new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x444444 }),
      metadata: { source: 'procedural', category: 'rocks' }
    })
  },
  {
    id: 'pine_tree',
    name: 'Pine Tree',
    category: 'vegetation',
    scale: 1.0,
    proceduralFallback: () => ({
      geometry: new (globalThis as any).THREE.CylinderGeometry(0.1, 0.6, 12, 8),
      material: new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x2a1a0f }),
      metadata: { source: 'procedural', category: 'vegetation' }
    })
  },
  {
    id: 'oak_tree',
    name: 'Oak Tree',
    category: 'vegetation',
    scale: 1.0,
    proceduralFallback: () => ({
      geometry: new (globalThis as any).THREE.CylinderGeometry(0.5, 0.8, 8, 8),
      material: new (globalThis as any).THREE.MeshStandardMaterial({ color: 0x2a1a0f }),
      metadata: { source: 'procedural', category: 'vegetation' }
    })
  }
];

// Asset quality presets
export const ASSET_QUALITY_PRESETS = {
  cinematic: {
    fallbackToProcedural: false,
    timeout: 30000,
    maxRetries: 3,
    assetQuality: 'high' as const
  },
  balanced: {
    fallbackToProcedural: true,
    timeout: 15000,
    maxRetries: 2,
    assetQuality: 'medium' as const
  },
  performance: {
    fallbackToProcedural: true,
    timeout: 5000,
    maxRetries: 1,
    assetQuality: 'low' as const
  }
};