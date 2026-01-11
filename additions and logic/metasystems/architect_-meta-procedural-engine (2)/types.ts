
export interface GeneratorEngine {
  id: string;
  name: string;
  domain: string;
  description: string;
  version: string;
  config: {
    parameters: Array<{
      key: string;
      label: string;
      type: 'range' | 'select' | 'boolean' | 'string';
      options?: string[];
      default: any;
    }>;
    generationPrompt: string;
    assetPrompt?: string; // Guidance for generating icons/images
  };
  createdAt: number;
}

export interface ArtifactDiagnostics {
  healthScore: number;
  issues: string[];
  suggestions: string;
}

export interface GeneratedAsset {
  id: string;
  url: string;
  prompt: string;
  type: 'icon' | 'hero' | 'logo';
}
