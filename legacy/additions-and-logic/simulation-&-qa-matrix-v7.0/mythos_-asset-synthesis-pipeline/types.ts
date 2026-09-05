
// Semantic Consistency Graph Node definition
export interface SCGNode {
  id: string;
  label: string;
  type: 'Entity' | 'Constraint' | 'Property' | 'Material';
  properties: Record<string, any>;
}

// Semantic Consistency Graph Link definition
export interface SCGLink {
  source: string;
  target: string;
  label: string;
}

// Level of Detail tier metadata
export interface LODTier {
  level: number;
  polygons: number;
  vertices: number;
  distanceTrigger: number;
}

// Audio synthesis event parameters
export interface AcousticEvent {
  name: string;
  frequency: number;
  type: 'sine' | 'square' | 'sawtooth' | 'triangle';
  decay: number;
  gain: number;
}

// Skeletal joint definition
export interface Joint {
  name: string;
  position: [number, number, number];
  parent: string | null;
}

// Complete synthesized asset manifest structure
export interface AssetManifest {
  id: string;
  name: string;
  semanticTruth: {
    nodes: SCGNode[];
    links: SCGLink[];
  };
  geometry: {
    lods: LODTier[];
  };
  rig: {
    joints: Joint[];
    weightsAssigned: boolean;
  };
  usdSchema: string;
  audio: {
    material: string;
    events: AcousticEvent[];
  };
}

// Pipeline lifecycle states including synthesis stages
export enum PipelineStatus {
  IDLE = 'IDLE',
  SEMANTIC_ANALYSIS = 'SEMANTIC_ANALYSIS',
  GEOMETRY_SOLVE = 'GEOMETRY_SOLVE',
  LOD_GENERATION = 'LOD_GENERATION',
  ACOUSTIC_SYNTHESIS = 'ACOUSTIC_SYNTHESIS',
  RIGGING = 'RIGGING',
  HARMONIZING = 'HARMONIZING',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR'
}
