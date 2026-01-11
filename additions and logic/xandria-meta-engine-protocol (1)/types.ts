
export enum PlaneType {
  GENESIS = 'GENESIS',
  FABRIC = 'FABRIC',
  TENSOR = 'TENSOR',
  INTERFACE = 'INTERFACE',
  NETWORK = 'NETWORK',
  SECURITY = 'SECURITY',
  SEAL = 'SEAL'
}

export interface XandriaSystem {
  id: string;
  name: string;
  plane: PlaneType;
  description: string;
  mechanism: string;
  icon: string;
}

export interface NodeLogic {
  id: string;
  type: string;
  label: string;
  connectedTo: string[];
  status: 'idle' | 'active' | 'error' | 'simulating';
  value?: string;
  metrics?: {
    flux: number;
    entropy: number;
    weight: number;
  };
}

export interface Archetype {
  id: string;
  name: string;
  description: string;
  nodes: NodeLogic[];
  image: string;
}

export interface BuildLog {
  timestamp: number;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success' | 'system' | 'op';
}

export interface SystemState {
  coherence: number;
  entropy: number;
  resonance: number;
  activePhase: 'VOID' | 'FABRIC' | 'ARTIFACT' | 'NONE';
  isSimulating: boolean;
}
