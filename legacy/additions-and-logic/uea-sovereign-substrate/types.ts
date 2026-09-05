
export type OperatorType = 'Deterministic' | 'Dissipative' | 'Probabilistic';

export interface Operator {
  id: string;
  name: string;
  type: OperatorType;
  desc: string;
  layers?: string[];
  category: 'Foundational' | 'Dynamic' | 'Relational' | 'Transformational';
}

export interface EngineState {
  r: number; // Current state variable R(t)
  kappa: number; // Reversion speed
  theta: number; // Equilibrium target
  sigma: number; // Volatility
  frameCount: number;
  history: { frame: number; value: number }[];
  activeOperators: string[];
}

export const LAYERS = [
  "Hardware/Logic", "Semantic/Interface", "Bio-Physiological", 
  "Network/Systemic", "Resource/Exchange", "Governance/Social", 
  "Cultural/Memetic", "Experiential/Awareness", "Structural/Symmetry", 
  "Scope/Boundary", "Generative/Synthetic", "State/Transition", 
  "Abstract/Frameworks"
];
