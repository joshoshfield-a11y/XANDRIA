/**
 * RECURSIVE UPGRADE ENGINE - MAIN ENTRY POINT
 * Omega-Evolution Protocol for Sovereign System Architecture
 */

export { RecursiveUpgradeEngine, recursiveUpgradeEngine } from './UpgradeEngine.js';
export { GeminiService, geminiService } from './services/geminiService';

// Export types for external usage
export type {
  EvolutionStatus,
  SystemError,
  EthicalConstraint,
  UpgradeEngineConfig,
  CodebaseScanResult,
  AutonomousActionResult,
  ExternalProtocol,
  BridgeToken,
  EvolutionCycle,
  MatrixStage,
  TelemetryData,
  RollbackEvent,
  GlyphCluster,
  MetaPatch
} from './types';

// Main cockpit interface for Cline integration
export class UpgradeCockpit {
  private engine: typeof import('./UpgradeEngine').recursiveUpgradeEngine;

  constructor() {
    this.engine = require('./UpgradeEngine').recursiveUpgradeEngine;
  }

  /**
   * Initialize the upgrade cockpit
   */
  async initialize(): Promise<void> {
    console.log('[UpgradeCockpit] INITIALIZING OMEGA-EVOLUTION COCKPIT...');
    await this.engine.initialize();
    console.log('[UpgradeCockpit] COCKPIT READY. CLINE INTEGRATION ACTIVE.');
  }

  /**
   * Get current system status
   */
  getStatus(): any {
    return this.engine.getSystemStatus();
  }

  /**
   * Perform recursive system upgrade
   */
  async performUpgrade(): Promise<void> {
    console.log('[UpgradeCockpit] INITIATING RECURSIVE SYSTEM UPGRADE...');
    await this.engine.performRecursiveUpgrade();
    console.log('[UpgradeCockpit] SYSTEM UPGRADE COMPLETE.');
  }

  /**
   * Get system errors
   */
  getErrors(): any[] {
    return this.engine.getSystemErrors();
  }

  /**
   * Toggle external bridge
   */
  async toggleBridge(protocol?: 'TRAE' | 'CLINE'): Promise<void> {
    await this.engine.toggleBridge(protocol);
  }

  /**
   * Execute autonomous healing
   */
  async executeHealing(): Promise<void> {
    console.log('[UpgradeCockpit] EXECUTING AUTONOMOUS HEALING...');
    await this.engine.executeAutonomousHealing();
    console.log('[UpgradeCockpit] HEALING COMPLETE.');
  }
}

// Export cockpit instance for immediate use
export const upgradeCockpit = new UpgradeCockpit();

// Quick access functions for Cline integration
export const cockpit = {
  // Initialize the entire upgrade system
  async init(): Promise<void> {
    await upgradeCockpit.initialize();
  },

  // Get system status
  status(): any {
    return upgradeCockpit.getStatus();
  },

  // Perform full system upgrade
  async upgrade(): Promise<void> {
    await upgradeCockpit.performUpgrade();
  },

  // Get current errors
  errors(): any[] {
    return upgradeCockpit.getErrors();
  },

  // Toggle bridge connection
  async bridge(protocol?: 'TRAE' | 'CLINE'): Promise<void> {
    await upgradeCockpit.toggleBridge(protocol);
  },

  // Execute healing
  async heal(): Promise<void> {
    await upgradeCockpit.executeHealing();
  }
};

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                   OMEGA-EVOLUTION PROTOCOL                     ║
║                   RECURSIVE UPGRADE ENGINE                     ║
║                                                                ║
║  Status: ACTIVE | Version: 14.5-Ω | Sovereignty: MAXIMUM      ║
║                                                                ║
║  Available Commands:                                           ║
║  • cockpit.init()    - Initialize upgrade system              ║
║  • cockpit.status()  - Get system status                       ║
║  • cockpit.upgrade() - Perform recursive upgrade               ║
║  • cockpit.errors()  - Get current errors                      ║
║  • cockpit.bridge()  - Toggle external bridge                  ║
║  • cockpit.heal()    - Execute autonomous healing              ║
║                                                                ║
║  Cline Integration: READY | TRAE Protocol: AVAILABLE          ║
╚══════════════════════════════════════════════════════════════════╝
`);
