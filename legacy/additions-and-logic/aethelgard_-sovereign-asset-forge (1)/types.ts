
export enum AssetType {
  CHARACTER = 'CHARACTER',
  ENVIRONMENT = 'ENVIRONMENT',
  PROP = 'PROP',
  VEHICLE = 'VEHICLE',
  MATERIAL = 'MATERIAL',
  WORLD = 'WORLD'
}

export enum DetailLevel {
  LOW_POLY = 'LOW_POLY',
  GAME_READY = 'GAME_READY',
  CINEMATIC = 'CINEMATIC',
  HYPER_REALISTIC = 'HYPER_REALISTIC'
}

export interface PBRMaterial {
  albedo: string;
  roughness: number;
  metallic: number;
  normalIntensity: number;
  emissive?: string;
  subsurface?: number;
}

export interface GeometricMetadata {
  estimatedVerts: string;
  topology: string;
  lodLevels: number;
  uvUnwrappingStyle: string;
}

export interface AssetManifest {
  name: string;
  description: string;
  type: AssetType;
  style: string;
  technicalSpecs: GeometricMetadata;
  pbrNodes: PBRMaterial[];
  generationPrompts: {
    diffusion: string;
    geometry: string;
    texture: string;
  };
  r3fSnippet: string;
  visualUrl?: string;
}

export interface AppState {
  isManifesting: boolean;
  isGeneratingVisual: boolean;
  manifest: AssetManifest | null;
  history: AssetManifest[];
  activeTab: 'specs' | 'pbr' | 'prompts' | 'code' | 'visual';
}
