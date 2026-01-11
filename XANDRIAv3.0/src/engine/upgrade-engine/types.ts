/**
 * OMEGA-EVOLUTION PROTOCOL TYPES
 * Sovereign System Architecture Types and Interfaces
 */

export enum EvolutionStatus {
  DORMANT = 'DORMANT',
  SIMULATING = 'SIMULATING',
  ANALYZING = 'ANALYZING',
  REFACTORING = 'REFACTORING',
  VERIFYING = 'VERIFYING',
  CONVERGED = 'CONVERGED',
  FAILED = 'FAILED',
  ROLLING_BACK = 'ROLLING_BACK',
  SELF_HEALING = 'SELF_HEALING'
}

export interface SystemError {
  id: string;
  scope: 'TYPESCRIPT' | 'LOGIC' | 'PERFORMANCE';
  file: string;
  message: string;
  severity: 'LOW' | 'MEDIUM' | 'CRITICAL';
  status: 'active' | 'patched';
}

export interface MetaPatch {
  id: string;
  targetFile: string;
  evolutionLogic: string;
  confidence: number;
  recursiveDepth: number;
}

export interface GlyphCluster {
  version: string;
  stageId: number;
  integrityHash: string;
  timestamp: number;
}

export interface EthicalConstraint {
  id: string;
  label: string;
  description: string;
  status: 'passed' | 'violated' | 'unchecked';
}

export interface RollbackEvent {
  id: string;
  timestamp: number;
  trigger: string;
  severity: 'CRITICAL' | 'WARNING';
  revertedFromGlyph: string;
  targetGlyph: string;
  status: 'active' | 'completed';
}

export interface TelemetryData {
  timestamp: number;
  sessionLength: number;
  failurePoints: number;
  refactorSuccessRate: number;
  sdtMutationImpact: number;
  engagement: number;
}

export interface MatrixStage {
  id: number;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  data?: any;
}

export interface RefactorResult {
  optimizedCode: string;
  explanation: string;
  simdBenefit: string;
  sovereigntyScore: number;
  ethicalCompliance: boolean;
}

export interface EthicalAuditResult {
  verdict: 'SAFE' | 'VIOLATION' | 'WARNING';
  violations: string[];
  remediation: string;
}

export interface CodebaseScanResult {
  globalEntropy: number;
  fileHealth: Array<{
    filename: string;
    score: number;
    issues: string[];
  }>;
  criticalVulnerabilities: Array<{
    id: string;
    message: string;
    file: string;
    scope: string;
    remediationPlan: string;
  }>;
}

export interface AutonomousActionResult {
  actionTaken: string;
  codePatch: string;
  verificationLogic: string;
  externalAgentCompatibility: boolean;
}

export type ExternalProtocol = 'TRAE' | 'CLINE' | 'GENERIC';

export interface BridgeToken {
  protocol: ExternalProtocol;
  token: string;
  timestamp: number;
  status: 'active' | 'expired';
}

export interface EvolutionCycle {
  id: number;
  startTime: number;
  endTime?: number;
  status: EvolutionStatus;
  stages: MatrixStage[];
  telemetry: TelemetryData[];
  errors: SystemError[];
  patches: MetaPatch[];
}

export interface UpgradeEngineConfig {
  maxRecursionDepth: number;
  ethicalThreshold: number;
  sovereigntyTarget: number;
  autoHealEnabled: boolean;
  telemetryInterval: number;
  externalBridgeEnabled: boolean;
  preferredProtocol: ExternalProtocol;
}
