// XANDRIA Graphics Upgrade Management System
// Integrates graphics upgrades with the main XANDRIA orchestration system

import { GraphicsVersionManager, getGraphicsVersionManager } from './GraphicsVersionManager';
import { GraphicsStage } from '../engines/GraphicsEngine';

export interface SystemIntegration {
  orchestrator: any;
  synthesizer: any;
  assetPipeline: any;
  operatorRegistry: any;
}

export interface GraphicsOperator {
  id: string;
  name: string;
  stage: GraphicsStage;
  description: string;
  parameters: any[];
  execute: (params: any) => Promise<any>;
}

export class GraphicsUpgradeManager {
  private versionManager: GraphicsVersionManager;
  private systemIntegration: SystemIntegration | null = null;
  private registeredOperators: Map<string, GraphicsOperator> = new Map();

  constructor() {
    this.versionManager = getGraphicsVersionManager();
    this.initializeGraphicsOperators();
  }

  // Connect to main XANDRIA systems
  connectToSystem(integration: SystemIntegration): void {
    this.systemIntegration = integration;
    console.log('XANDRIA Graphics: Connected to main system orchestration');

    // Register graphics operators with synthesizer
    this.registerOperatorsWithSynthesizer();

    // Connect to asset pipeline
    this.connectToAssetPipeline();

    // Update orchestrator with graphics capabilities
    this.updateOrchestratorCapabilities();
  }

  // Upgrade graphics system to next stage
  async upgradeGraphicsSystem(targetStage?: GraphicsStage): Promise<boolean> {
    const currentStage = this.versionManager.getCurrentStage();

    if (targetStage && targetStage === currentStage) {
      console.log('Graphics system already at target stage');
      return true;
    }

    // Determine upgrade path
    const upgradePath = this.calculateUpgradePath(currentStage, targetStage);

    for (const upgradeId of upgradePath) {
      console.log(`XANDRIA Graphics: Applying upgrade ${upgradeId}`);

      try {
        const success = await this.versionManager.applyUpgrade(upgradeId);

        if (!success) {
          console.error(`XANDRIA Graphics: Failed to apply upgrade ${upgradeId}`);
          return false;
        }

        // Update system integration after each upgrade
        this.updateSystemAfterUpgrade(upgradeId);

      } catch (error) {
        console.error(`XANDRIA Graphics: Upgrade error for ${upgradeId}:`, error);
        return false;
      }
    }

    console.log(`XANDRIA Graphics: Successfully upgraded to ${this.versionManager.getCurrentStage()} stage`);
    return true;
  }

  // Get current graphics engine
  getCurrentEngine(): any {
    return this.versionManager.getCurrentEngine();
  }

  // Get current graphics stage
  getCurrentStage(): any {
    return this.versionManager.getCurrentStage();
  }

  // Get current graphics capabilities
  getCurrentCapabilities(): any {
    return {
      stage: this.versionManager.getCurrentStage(),
      capabilities: this.versionManager.getCurrentCapabilities(),
      availableUpgrades: this.versionManager.getAvailableUpgrades(),
      performance: this.versionManager.getPerformanceMetrics()
    };
  }

  // Execute graphics operator
  async executeOperator(operatorId: string, parameters: any = {}): Promise<any> {
    const operator = this.registeredOperators.get(operatorId);

    if (!operator) {
      throw new Error(`Graphics operator not found: ${operatorId}`);
    }

    // Check if operator is available for current stage
    if (operator.stage !== this.versionManager.getCurrentStage() &&
        operator.stage !== GraphicsStage.PLANETARY) { // Base operators always available
      throw new Error(`Operator ${operatorId} requires ${operator.stage} stage (current: ${this.versionManager.getCurrentStage()})`);
    }

    console.log(`XANDRIA Graphics: Executing operator ${operatorId}`);
    return await operator.execute(parameters);
  }

  // Get available graphics operators for current stage
  getAvailableOperators(): GraphicsOperator[] {
    const currentStage = this.versionManager.getCurrentStage();
    return Array.from(this.registeredOperators.values())
      .filter(op => op.stage === currentStage || op.stage === GraphicsStage.PLANETARY);
  }

  // Get upgrade recommendations based on system usage
  getUpgradeRecommendations(): any[] {
    const recommendations = [];
    const availableUpgrades = this.versionManager.getAvailableUpgrades();

    for (const upgrade of availableUpgrades) {
      const recommendation = {
        upgrade,
        priority: this.calculateUpgradePriority(upgrade),
        reason: this.getUpgradeReason(upgrade)
      };
      recommendations.push(recommendation);
    }

    return recommendations.sort((a, b) => b.priority - a.priority);
  }

  // Dispose upgrade manager
  dispose(): void {
    this.registeredOperators.clear();
    this.systemIntegration = null;
  }

  // Initialize graphics operators
  private initializeGraphicsOperators(): void {
    const operators: GraphicsOperator[] = [
      // Base operators (available in all stages)
      {
        id: 'OP-22_MATRIX',
        name: 'Terrain Matrix',
        stage: GraphicsStage.PLANETARY,
        description: 'Generate planetary-scale terrain using fractal algorithms',
        parameters: ['size', 'resolution', 'noiseScale', 'heightScale'],
        execute: async (params) => {
          const engine = this.versionManager.getCurrentEngine();
          return await engine.generateTerrain(params);
        }
      },
      {
        id: 'OP-08_BLOOM',
        name: 'Vegetation Bloom',
        stage: GraphicsStage.PLANETARY,
        description: 'Create vegetation systems with wind animation',
        parameters: ['count', 'windStrength', 'scale'],
        execute: async (params) => {
          const engine = this.versionManager.getCurrentEngine();
          return await engine.createVegetation(params);
        }
      },
      {
        id: 'OP-40_INTERFACE',
        name: 'Atmospheric Interface',
        stage: GraphicsStage.PLANETARY,
        description: 'Render atmospheric scattering and sky systems',
        parameters: ['camera', 'sun', 'turbidity', 'sunElevation'],
        execute: async (params) => {
          const engine = this.versionManager.getCurrentEngine();
          return await engine.renderAtmosphere(params.camera, params.sun, {
            turbidity: params.turbidity || 10,
            rayleigh: 3,
            mieCoefficient: 0.005,
            mieDirectionalG: 0.7,
            sunElevation: params.sunElevation || 45,
            sunAzimuth: params.sunAzimuth || 180
          });
        }
      },

      // LOD stage operators
      {
        id: 'OP-12_WEAVE',
        name: 'LOD Weave',
        stage: GraphicsStage.LOD,
        description: 'Enable Level of Detail systems for performance optimization',
        parameters: ['levels'],
        execute: async (params) => {
          const engine = this.versionManager.getCurrentEngine();
          engine.enableLOD(params.levels || []);
          return { success: true, message: 'LOD systems enabled' };
        }
      },

      // Bridge stage operators
      {
        id: 'OP-16_BRIDGE',
        name: 'Asset Bridge',
        stage: GraphicsStage.BRIDGE,
        description: 'Load external GLTF assets with fallback to procedural generation',
        parameters: ['url', 'fallback'],
        execute: async (params) => {
          const engine = this.versionManager.getCurrentEngine();
          try {
            return await engine.loadExternalAssets(params.url);
          } catch (error) {
            if (params.fallback) {
              console.warn('Asset loading failed, using fallback');
              return params.fallback();
            }
            throw error;
          }
        }
      }
    ];

    operators.forEach(op => {
      this.registeredOperators.set(op.id, op);
    });
  }

  // Register operators with synthesizer
  private registerOperatorsWithSynthesizer(): void {
    if (!this.systemIntegration?.synthesizer) return;

    const operators = this.getAvailableOperators();
    operators.forEach(op => {
      this.systemIntegration!.synthesizer.registerOperator(op.id, {
        name: op.name,
        description: op.description,
        category: 'graphics',
        execute: op.execute
      });
    });

    console.log(`XANDRIA Graphics: Registered ${operators.length} operators with synthesizer`);
  }

  // Connect to asset pipeline
  private connectToAssetPipeline(): void {
    if (!this.systemIntegration?.assetPipeline) return;

    // Register graphics asset generators
    this.systemIntegration.assetPipeline.registerGenerator('terrain', {
      generate: async (params: any) => {
        const engine = this.versionManager.getCurrentEngine();
        const terrain = await engine.generateTerrain(params);
        return {
          type: '3d-model',
          data: terrain,
          metadata: { generator: 'OP-22_MATRIX', params }
        };
      }
    });

    console.log('XANDRIA Graphics: Connected to asset pipeline');
  }

  // Update orchestrator with graphics capabilities
  private updateOrchestratorCapabilities(): void {
    if (!this.systemIntegration?.orchestrator) return;

    const capabilities = this.getCurrentCapabilities();
    this.systemIntegration.orchestrator.updateCapabilities('graphics', capabilities);

    console.log('XANDRIA Graphics: Updated orchestrator capabilities');
  }

  // Calculate upgrade path
  private calculateUpgradePath(fromStage: GraphicsStage, toStage?: GraphicsStage): string[] {
    const upgradePath: string[] = [];

    if (!toStage) {
      // Upgrade to next available stage
      const availableUpgrades = this.versionManager.getAvailableUpgrades();
      if (availableUpgrades.length > 0) {
        upgradePath.push(availableUpgrades[0].id);
      }
    } else {
      // Calculate path to specific stage
      if (fromStage === GraphicsStage.PLANETARY && toStage === GraphicsStage.LOD) {
        upgradePath.push('planetary-to-lod');
      } else if (fromStage === GraphicsStage.PLANETARY && toStage === GraphicsStage.BRIDGE) {
        upgradePath.push('planetary-to-lod', 'lod-to-bridge');
      } else if (fromStage === GraphicsStage.LOD && toStage === GraphicsStage.BRIDGE) {
        upgradePath.push('lod-to-bridge');
      }
    }

    return upgradePath;
  }

  // Update system after upgrade
  private updateSystemAfterUpgrade(upgradeId: string): void {
    // Re-register operators (new ones may be available)
    this.registerOperatorsWithSynthesizer();

    // Update orchestrator capabilities
    this.updateOrchestratorCapabilities();

    // Notify asset pipeline of new capabilities
    if (this.systemIntegration?.assetPipeline) {
      this.systemIntegration.assetPipeline.notifyUpgrade(this.versionManager.getCurrentStage());
    }

    console.log(`XANDRIA Graphics: System updated after ${upgradeId} upgrade`);
  }

  // Calculate upgrade priority
  private calculateUpgradePriority(upgrade: any): number {
    let priority = 1;

    // Higher priority for performance improvements
    if (upgrade.benefits.some((b: string) => b.includes('performance') || b.includes('FPS'))) {
      priority += 2;
    }

    // Higher priority for quality improvements
    if (upgrade.benefits.some((b: string) => b.includes('quality') || b.includes('realistic'))) {
      priority += 1;
    }

    return priority;
  }

  // Get upgrade reason
  private getUpgradeReason(upgrade: any): string {
    const reasons = upgrade.benefits.slice(0, 2); // Take first 2 benefits
    return reasons.join(', ') + (upgrade.benefits.length > 2 ? ' and more' : '');
  }
}

// Export singleton instance
let upgradeManagerInstance: GraphicsUpgradeManager | null = null;

export function getGraphicsUpgradeManager(): GraphicsUpgradeManager {
  if (!upgradeManagerInstance) {
    upgradeManagerInstance = new GraphicsUpgradeManager();
  }
  return upgradeManagerInstance;
}

export function disposeGraphicsUpgradeManager(): void {
  if (upgradeManagerInstance) {
    upgradeManagerInstance.dispose();
    upgradeManagerInstance = null;
  }
}