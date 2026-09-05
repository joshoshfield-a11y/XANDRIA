
export enum OperatorType {
  INITIALIZATION = 'INITIALIZATION',
  LOGIC_FLOW = 'LOGIC_FLOW',
  DATA_STATE = 'DATA_STATE',
  PHYSICS = 'PHYSICS',
  INTERACTION_UI = 'INTERACTION_UI',
  NETWORKING = 'NETWORKING',
  VCS = 'VCS',
  FINALIZATION = 'FINALIZATION'
}

export interface Operator {
  id: string;
  name: string;
  description: string;
  type: OperatorType;
}

export interface Commit {
  id: string;
  timestamp: number;
  message: string;
  files: Record<string, string>;
  sceneConfig: any;
  parent?: string;
}

export interface Artifact {
  id: string;
  intent: string;
  timestamp: number;
  currentBranch: string;
  branches: Record<string, Commit[]>;
  sceneConfig?: any;
  assetReferences?: Asset[];
}

export interface Asset {
  id: string;
  name: string;
  source: 'Sketchfab' | 'Internal';
  previewUrl: string;
  type: 'Model' | 'Texture' | 'Audio';
}

export interface TraceEntry {
  id: string;
  timestamp: number;
  message: string;
  type: 'SYSTEM' | 'VOICE' | 'RESULT' | 'ERROR' | 'OPERATOR' | 'VCS';
}
