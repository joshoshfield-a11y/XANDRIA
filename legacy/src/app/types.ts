/**
 * XANDRIA Unified Application Types
 * Type definitions for the modular application architecture
 */

export interface GameProject {
  id: string;
  name: string;
  description: string;
  code: string;
  qualityMetrics: JMetricResult | null;
  evolutionHistory: EvolutionResult[];
  aiEnhancements: string[];
  synestheticBindings: SynestheticBinding[];
  lastModified: number;
  status: 'generating' | 'evolving' | 'optimizing' | 'complete' | 'error';
}

export interface JMetricResult {
  overallScore: number;
  qualityGrade: string;
  totalViolations: number;
  categoryScores: Record<string, number>;
  recommendations: string[];
}

export interface EvolutionResult {
  improvementMetrics: {
    qualityImprovement: number;
    debtReduction: number;
    maintainabilityGain: number;
  };
  appliedStrategies: string[];
  timestamp: number;
}

export interface SynestheticBinding {
  symbol: string;
  args: Record<string, any>;
  trigger: string;
}

export interface GlobalMetrics {
  totalGamesGenerated: number;
  averageQualityScore: number;
  evolutionImprovements: number;
  aiOptimizations: number;
}

export interface UIState {
  activePanel: 'dashboard' | 'generator' | 'evolver' | 'monitor' | 'synesthesia';
  showGraphics: boolean;
  realTimeUpdates: boolean;
}

export interface UnifiedAppState {
  currentProject: GameProject | null;
  projects: GameProject[];
  globalMetrics: GlobalMetrics;
  uiState: UIState;
}

export interface GameGenerationSpec {
  type: 'game_generation';
  specification: string;
  targetPlatform: string;
  features: string[];
}

export interface CodeEvolutionState {
  complexity: number;
  quality: number;
  technicalDebt: number;
  maintainability: number;
  performance: number;
  timestamp: number;
}

export interface OperatorResult {
  success: boolean;
  result?: {
    code?: string;
    features?: string[];
    metadata?: Record<string, any>;
  };
  error?: string;
}

export interface OperatorEnvironment {
  timestamp: number;
  sessionId: string;
  contextScope: string[];
}