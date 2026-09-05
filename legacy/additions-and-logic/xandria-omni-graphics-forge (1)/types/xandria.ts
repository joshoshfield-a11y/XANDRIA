
export enum OperatorID {
  OP01_VOID = 'OP-01',
  OP03_INTENT = 'OP-03',
  OP08_BLOOM = 'OP-08',
  OP10_STRUCTURE = 'OP-10',
  OP12_WEAVE = 'OP-12',
  OP22_MATRIX = 'OP-22',
  OP40_INTERFACE = 'OP-40',
  OP63_HEAL = 'OP-63',
  OP72_SEAL = 'OP-72',
}

export interface Operator {
  id: OperatorID;
  name: string;
  group: 'GENESIS' | 'FABRIC' | 'TENSOR' | 'INTERFACE' | 'NETWORK' | 'SECURITY' | 'SEAL';
  description: string;
}

export interface GraphicsManifest {
  intent: string;
  seed: number;
  parameters: {
    complexity: number;
    resonance: number;
    entropy: number;
    chroma: string;
  };
  timestamp: number;
}

export const OPERATORS: Operator[] = [
  { id: OperatorID.OP01_VOID, name: 'Void', group: 'GENESIS', description: 'Clears current context and visual state.' },
  { id: OperatorID.OP03_INTENT, name: 'Intent', group: 'GENESIS', description: 'Parses natural language visual objectives.' },
  { id: OperatorID.OP08_BLOOM, name: 'Bloom', group: 'GENESIS', description: 'Synthesizes procedural textures and meshes.' },
  { id: OperatorID.OP22_MATRIX, name: 'Matrix', group: 'TENSOR', description: 'Configures spatial scene graphs and spatial physics.' },
  { id: OperatorID.OP72_SEAL, name: 'Seal', group: 'SEAL', description: 'Finalizes the graphic artifact with cryptographic hashing.' },
];
