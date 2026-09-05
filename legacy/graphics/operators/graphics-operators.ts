// XANDRIA Graphics Operators for X13 Integration
// Registers graphics operators with the X13 Logic Synthesizer

import { LogicSynthesizer, createCoreSynthesizer } from '../../x13-upgrade/synthesizers/LogicSynthesizer';
import { getGraphicsUpgradeManager } from '../upgrades/upgrade-manager';
import { GraphicsStage } from '../engines/GraphicsEngine';

export interface GraphicsOperatorDefinition {
  id: string;
  name: string;
  description: string;
  stage: GraphicsStage;
  parameters: string[];
  synthesizer: LogicSynthesizer;
  execute: (params: any) => Promise<any>;
}

// OP-22 MATRIX: Terrain Synthesis Operator
export const OP_22_MATRIX = createCoreSynthesizer(
  'OP-22_MATRIX',
  'Planetary-scale terrain generation using fractal algorithms and noise synthesis',
  3 // Higher resource cost for complex terrain generation
);

// OP-08 BLOOM: Vegetation Synthesis Operator
export const OP_08_BLOOM = createCoreSynthesizer(
  'OP-08_BLOOM',
  'Vegetation synthesis with wind animation and LOD optimization',
  2
);

// OP-40 INTERFACE: Atmospheric Rendering Operator
export const OP_40_INTERFACE = createCoreSynthesizer(
  'OP-40_INTERFACE',
  'Atmospheric scattering and sky rendering with dynamic lighting',
  2
);

// OP-12 WEAVE: LOD Management Operator
export const OP_12_WEAVE = createCoreSynthesizer(
  'OP-12_WEAVE',
  'Level of Detail (LOD) system management and performance optimization',
  1
);

// OP-16 BRIDGE: External Asset Integration Operator
export const OP_16_BRIDGE = createCoreSynthesizer(
  'OP-16_BRIDGE',
  'External GLTF/GLB asset loading with fallback to procedural generation',
  2
);

// Graphics Operator Registry
export class GraphicsOperatorRegistry {
  private operators: Map<string, GraphicsOperatorDefinition> = new Map();
  private graphicsManager = getGraphicsUpgradeManager();

  constructor() {
    this.initializeOperators();
  }

  private initializeOperators(): void {
    // Register OP-22 MATRIX operator
    this.registerOperator({
      id: 'OP-22_MATRIX',
      name: 'Terrain Matrix',
      description: 'Generate planetary-scale terrain using fractal algorithms',
      stage: GraphicsStage.PLANETARY,
      parameters: ['size', 'resolution', 'noiseScale', 'heightScale', 'seed'],
      synthesizer: OP_22_MATRIX,
      execute: async (params) => {
        const engine = this.graphicsManager.getCurrentEngine();
        return await engine.generateTerrain(params);
      }
    });

    // Register OP-08 BLOOM operator
    this.registerOperator({
      id: 'OP-08_BLOOM',
      name: 'Vegetation Bloom',
      description: 'Create vegetation systems with wind animation',
      stage: GraphicsStage.PLANETARY,
      parameters: ['count', 'windStrength', 'scale', 'lod'],
      synthesizer: OP_08_BLOOM,
      execute: async (params) => {
        const engine = this.graphicsManager.getCurrentEngine();
        return await engine.createVegetation(params);
      }
    });

    // Register OP-40 INTERFACE operator
    this.registerOperator({
      id: 'OP-40_INTERFACE',
      name: 'Atmospheric Interface',
      description: 'Render atmospheric scattering and sky systems',
      stage: GraphicsStage.PLANETARY,
      parameters: ['camera', 'sun', 'turbidity', 'sunElevation', 'sunAzimuth'],
      synthesizer: OP_40_INTERFACE,
      execute: async (params) => {
        const engine = this.graphicsManager.getCurrentEngine();
        return await engine.renderAtmosphere(params.camera, params.sun, {
          turbidity: params.turbidity || 10,
          rayleigh: 3,
          mieCoefficient: 0.005,
          mieDirectionalG: 0.7,
          sunElevation: params.sunElevation || 45,
          sunAzimuth: params.sunAzimuth || 180
        });
      }
    });

    // Register OP-12 WEAVE operator (LOD Stage)
    this.registerOperator({
      id: 'OP-12_WEAVE',
      name: 'LOD Weave',
      description: 'Enable Level of Detail systems for performance',
      stage: GraphicsStage.LOD,
      parameters: ['levels'],
      synthesizer: OP_12_WEAVE,
      execute: async (params) => {
        const engine = this.graphicsManager.getCurrentEngine();
        engine.enableLOD(params.levels || []);
        return { success: true, message: 'LOD systems enabled', levels: params.levels };
      }
    });

    // Register OP-16 BRIDGE operator (Bridge Stage)
    this.registerOperator({
      id: 'OP-16_BRIDGE',
      name: 'Asset Bridge',
      description: 'Load external GLTF assets with procedural fallback',
      stage: GraphicsStage.BRIDGE,
      parameters: ['url', 'fallback'],
      synthesizer: OP_16_BRIDGE,
      execute: async (params) => {
        const engine = this.graphicsManager.getCurrentEngine();
        try {
          return await engine.loadExternalAssets(params.url);
        } catch (error) {
          if (params.fallback) {
            console.warn('Asset loading failed, using procedural fallback');
            return params.fallback();
          }
          throw error;
        }
      }
    });
  }

  private registerOperator(definition: GraphicsOperatorDefinition): void {
    this.operators.set(definition.id, definition);
  }

  // Get operator by ID
  getOperator(operatorId: string): GraphicsOperatorDefinition | undefined {
    return this.operators.get(operatorId);
  }

  // Get all available operators for current graphics stage
  getAvailableOperators(): GraphicsOperatorDefinition[] {
    const currentStage = this.graphicsManager.getCurrentStage();
    return Array.from(this.operators.values())
      .filter(op => op.stage === currentStage || op.stage === GraphicsStage.PLANETARY);
  }

  // Execute graphics operator
  async executeOperator(operatorId: string, parameters: any = {}): Promise<any> {
    const operator = this.getOperator(operatorId);
    if (!operator) {
      throw new Error(`Graphics operator ${operatorId} not found`);
    }

    // Check if operator is available for current stage
    const currentStage = this.graphicsManager.getCurrentStage();
    if (operator.stage !== currentStage && operator.stage !== GraphicsStage.PLANETARY) {
      throw new Error(`Operator ${operatorId} requires ${operator.stage} stage (current: ${currentStage})`);
    }

    console.log(`XANDRIA Graphics: Executing operator ${operatorId}`);
    return await operator.execute(parameters);
  }

  // Get operator definitions for X13 synthesizer registration
  getOperatorDefinitions(): Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    parameters: string[];
    execute: (params: any) => Promise<any>;
  }> {
    return Array.from(this.operators.values()).map(op => ({
      id: op.id,
      name: op.name,
      description: op.description,
      category: 'graphics',
      parameters: op.parameters,
      execute: op.execute.bind(op)
    }));
  }

  // Check if operator is available
  isOperatorAvailable(operatorId: string): boolean {
    const operator = this.getOperator(operatorId);
    if (!operator) return false;

    const currentStage = this.graphicsManager.getCurrentStage();
    return operator.stage === currentStage || operator.stage === GraphicsStage.PLANETARY;
  }

  // Get operator requirements (stage needed)
  getOperatorRequirements(operatorId: string): GraphicsStage | null {
    const operator = this.getOperator(operatorId);
    return operator ? operator.stage : null;
  }

  // Get operators that would be unlocked by upgrading to a stage
  getOperatorsForStage(stage: GraphicsStage): GraphicsOperatorDefinition[] {
    return Array.from(this.operators.values())
      .filter(op => op.stage === stage);
  }

  // Get all registered operator IDs
  getRegisteredOperatorIds(): string[] {
    return Array.from(this.operators.keys());
  }
}

// Singleton instance
let graphicsOperatorRegistry: GraphicsOperatorRegistry | null = null;

export function getGraphicsOperatorRegistry(): GraphicsOperatorRegistry {
  if (!graphicsOperatorRegistry) {
    graphicsOperatorRegistry = new GraphicsOperatorRegistry();
  }
  return graphicsOperatorRegistry;
}

export function disposeGraphicsOperatorRegistry(): void {
  graphicsOperatorRegistry = null;
}

// Helper function to register graphics operators with X13 synthesizer
export function registerGraphicsOperatorsWithX13(synthesizer: any): void {
  const registry = getGraphicsOperatorRegistry();
  const operatorDefinitions = registry.getOperatorDefinitions();

  operatorDefinitions.forEach(def => {
    synthesizer.registerOperator(def.id, {
      name: def.name,
      description: def.description,
      category: def.category,
      execute: def.execute
    });
  });

  console.log(`XANDRIA Graphics: Registered ${operatorDefinitions.length} operators with X13 synthesizer`);
}
