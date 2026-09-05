
import { Operator } from './types';

export const OPERATOR_LIBRARY: Operator[] = [
  // Foundational (F1-F18)
  { id: "F1", category: "Foundational", name: "Baseline Identity", type: "Deterministic", desc: "Returns state unchanged; baseline reference." },
  { id: "F2", category: "Foundational", name: "Buffer Reset", type: "Dissipative", desc: "Total absorption; clears data registers." },
  { id: "F3", category: "Foundational", name: "Projection", type: "Deterministic", desc: "Feature extraction; maps inputs to subspace." },
  { id: "F4", category: "Foundational", name: "Constraint Enforcer", type: "Deterministic", desc: "Clamping and admissible set enforcement." },
  { id: "F5", category: "Foundational", name: "Gradient Vector", type: "Deterministic", desc: "Direction of maximum logic optimization." },
  { id: "F6", category: "Foundational", name: "Variance Smoother", type: "Dissipative", desc: "Blurs local jitter; data diffusion." },
  { id: "F7", category: "Foundational", name: "Time Derivative", type: "Deterministic", desc: "Calculates rates of change per frame." },
  { id: "F8", category: "Foundational", name: "Magnitude Metric", type: "Deterministic", desc: "Computes L2 or L-inf norms." },
  { id: "F10", category: "Foundational", name: "Logic Superposition", type: "Probabilistic", desc: "Merges multiple signals without loss." },
  { id: "F16", category: "Foundational", name: "SDE Generator", type: "Deterministic", desc: "Core driver for state evolution." },
  
  // Dynamic (D1-D18)
  { id: "D1", category: "Dynamic", name: "Motion Drift", type: "Deterministic", desc: "Forward motion or trend logic." },
  { id: "D2", category: "Dynamic", name: "Organic Diffusion", type: "Probabilistic", desc: "Brownian-noise-driven fluctuations." },
  { id: "D3", category: "Dynamic", name: "Equilibrium Memory", type: "Deterministic", desc: "Pull toward long-term stability." },
  { id: "D4", category: "Dynamic", name: "Logic Damping", type: "Dissipative", desc: "Decay of signals to prevent runaway loops." },
  { id: "D5", category: "Dynamic", name: "Spectral Splitter", type: "Deterministic", desc: "Decomposes signals into frequencies." },
  { id: "D8", category: "Dynamic", name: "Frame Propagator", type: "Deterministic", desc: "Advances global state by dt." },
  { id: "D17", category: "Dynamic", name: "State Jump", type: "Probabilistic", desc: "Discontinuous regime switches." },

  // Relational (R1-R18)
  { id: "R1", category: "Relational", name: "Adjacency Map", type: "Deterministic", desc: "Encodes network connectivity." },
  { id: "R2", category: "Relational", name: "Graph Laplacian", type: "Dissipative", desc: "Consensus smoothing logic." },
  { id: "R10", category: "Relational", name: "Causal Inference", type: "Probabilistic", desc: "Estimates directed influence." },
  { id: "R12", category: "Relational", name: "Synchrony", type: "Probabilistic", desc: "Drives all nodes to global state." },

  // Transformational (T1-T18)
  { id: "T1", category: "Transformational", name: "PCA Optimizer", type: "Deterministic", desc: "Simplifies data complexity." },
  { id: "T10", category: "Transformational", name: "Asset Sampler", type: "Probabilistic", desc: "Generates content from learned priors." },
  { id: "T11", category: "Transformational", name: "Criticality Detector", type: "Probabilistic", desc: "Detects proximity to system failure." },
  { id: "T12", category: "Transformational", name: "Global Validator", type: "Deterministic", desc: "Consistency check across all layers." },
  { id: "T13", category: "Transformational", name: "Standard Anchor", type: "Deterministic", desc: "Grounds engine in CODATA axioms." }
];
