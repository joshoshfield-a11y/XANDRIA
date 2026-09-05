
export enum AgentType {
  EXPLORER = 'EXPLORER',
  BREAKER = 'BREAKER',
  STANDARD = 'STANDARD'
}

export interface Vector2 {
  x: number;
  y: number;
}

export interface AgentAction {
  timestamp: number;
  type: 'move' | 'jump' | 'interact' | 'fuzz' | 'crash';
  detail: string;
}

export interface Agent {
  id: string;
  type: AgentType;
  position: Vector2;
  velocity: Vector2;
  status: 'active' | 'success' | 'failed' | 'crashed';
  path: Vector2[];
  fitness: number;
  reward: number;
  convergence: number; // 0 to 1
  explorationCoverage?: number; // 0 to 1
  actions: AgentAction[];
}

export interface Anomaly {
  id: string;
  timestamp: string;
  metric: string;
  value: number;
  expectedRange: [number, number];
  severity: 'low' | 'medium' | 'high';
}

export interface TelemetryData {
  time: string;
  successRate: number;
  avgTTK: number;
  crashes: number;
  complexity: number;
  avgReward: number;
  policyConvergence: number;
}

export interface BuildState {
  version: string;
  status: 'stable' | 'testing' | 'unstable' | 'deploying';
  logs: string[];
}
