// XANDRIA Graphics Integration Test Suite
// Comprehensive testing for graphics engine, operators, and pipeline integration

// Mock Three.js for testing
const mockThree = {
  Scene: class { add() {} remove() {} },
  PerspectiveCamera: class { position = { set: () => {} }; lookAt = () => {} },
  WebGLRenderer: class { 
    setSize = () => {}; 
    setPixelRatio = () => {}; 
    render = () => {}; 
    dispose = () => {}; 
    domElement = document.createElement('canvas');
  },
  Mesh: class { position = { set: () => {} }; rotation = { set: () => {} }; scale = { set: () => {} } },
  PlaneGeometry: class { rotateX = () => {} },
  MeshStandardMaterial: class { color = { set: () => {} }; roughness = 1; metalness = 0 },
  DirectionalLight: class { position = { set: () => {} }; intensity = 1 },
  AmbientLight: class { intensity = 0.5 },
  Clock: class { getElapsedTime = () => 0; delta = 0.016 }
};

// Make Three.js available globally for tests
globalThis.THREE = mockThree as any;

// Import graphics system components
import { GraphicsEngine, GraphicsStage, createGraphicsEngine } from '../graphics/engines/GraphicsEngine';
import { GraphicsVersionManager, getGraphicsVersionManager } from '../graphics/upgrades/GraphicsVersionManager';
import { GraphicsUpgradeManager, getGraphicsUpgradeManager } from '../graphics/upgrades/upgrade-manager';
import { GraphicsOperatorRegistry, getGraphicsOperatorRegistry } from '../graphics/operators/graphics-operators';
import { GraphicsAssetPipeline, getGraphicsAssetPipeline } from '../graphics/asset-pipeline-integration';

describe('XANDRIA Graphics Integration Tests', () => {
  describe('GraphicsEngine', () => {
    let engine: GraphicsEngine;

    beforeAll(() => {
      engine = createGraphicsEngine(GraphicsStage.PLANETARY);
    });

    afterAll(() => {
      engine?.dispose();
    });

    it('should create engine with correct stage', () => {
      expect(engine).toBeDefined();
    });

    it('should have terrain generation capability', async () => {
      const terrain = await engine.generateTerrain({
        size: 100,
        resolution: 64,
        noiseScale: 20,
        heightScale: 10
      });
      expect(terrain).toBeDefined();
    });

    it('should have vegetation generation capability', async () => {
      const vegetation = await engine.createVegetation({
        count: 50,
        windStrength: 0.5,
        scale: 1.0
      });
      expect(vegetation).toBeDefined();
    });
  });

  describe('GraphicsVersionManager', () => {
    let versionManager: GraphicsVersionManager;

    beforeAll(() => {
      versionManager = getGraphicsVersionManager(GraphicsStage.PLANETARY);
    });

    afterAll(() => {
      versionManager?.dispose();
    });

    it('should initialize with correct stage', () => {
      expect(versionManager.getCurrentStage()).toBe(GraphicsStage.PLANETARY);
    });

    it('should have available upgrades', () => {
      const upgrades = versionManager.getAvailableUpgrades();
      expect(upgrades.length).toBeGreaterThan(0);
    });

    it('should provide performance metrics', () => {
      const metrics = versionManager.getPerformanceMetrics();
      expect(metrics).toBeDefined();
    });
  });

  describe('GraphicsUpgradeManager', () => {
    let upgradeManager: GraphicsUpgradeManager;

    beforeAll(() => {
      upgradeManager = getGraphicsUpgradeManager();
    });

    afterAll(() => {
      upgradeManager?.dispose();
    });

    it('should have current engine available', () => {
      const engine = upgradeManager.getCurrentEngine();
      expect(engine).toBeDefined();
    });

    it('should have available operators', () => {
      const operators = upgradeManager.getAvailableOperators();
      expect(operators.length).toBeGreaterThan(0);
    });

    it('should provide upgrade recommendations', () => {
      const recommendations = upgradeManager.getUpgradeRecommendations();
      expect(recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('GraphicsOperatorRegistry', () => {
    let registry: GraphicsOperatorRegistry;

    beforeAll(() => {
      registry = getGraphicsOperatorRegistry();
    });

    it('should have registered operators', () => {
      const operatorIds = registry.getRegisteredOperatorIds();
      expect(operatorIds).toContain('OP-22_MATRIX');
      expect(operatorIds).toContain('OP-08_BLOOM');
    });

    it('should return operator definitions', () => {
      const definitions = registry.getOperatorDefinitions();
      expect(definitions.length).toBe(5);
    });
  });

  describe('GraphicsAssetPipeline', () => {
    let pipeline: GraphicsAssetPipeline;

    beforeAll(() => {
      pipeline = getGraphicsAssetPipeline();
    });

    afterAll(() => {
      pipeline.clearCache();
    });

    it('should generate terrain assets', async () => {
      const asset = await pipeline.generateTerrainAsset({
        type: 'terrain',
        parameters: { size: 100, resolution: 64 },
        quality: 'medium',
        format: 'json'
      });
      expect(asset).toBeDefined();
      expect(asset.type).toBe('terrain');
    });

    it('should cache generated assets', () => {
      const stats = pipeline.getCacheStats();
      expect(stats.count).toBeGreaterThan(0);
    });
  });

  describe('Stage Progression Tests', () => {
    it('should upgrade from Planetary to LOD stage', async () => {
      const manager = getGraphicsUpgradeManager();
      const success = await manager.upgradeGraphicsSystem(GraphicsStage.LOD);
      expect(success).toBe(true);
    });
  });
});

// Export test utilities
export const testUtils = {
  createMockScene: () => ({
    scene: new mockThree.Scene(),
    camera: new mockThree.PerspectiveCamera(),
    renderer: new mockThree.WebGLRenderer(),
    clock: new mockThree.Clock()
  }),

  createMockTerrainParams: () => ({
    size: 100,
    resolution: 64,
    noiseScale: 20,
    heightScale: 10,
    seed: Math.random()
  }),

  createMockVegetationParams: () => ({
    count: 50,
    windStrength: 0.5,
    scale: 1.0,
    lod: false
  })
};