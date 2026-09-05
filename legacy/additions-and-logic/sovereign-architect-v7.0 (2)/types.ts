
export enum SynthesisPhase {
  IDLE = 'IDLE',
  INTROSPECTION = 'INTROSPECTION',
  META_SYNTHESIS = 'META_SYNTHESIS', // Building the factories
  CONTENT_GENESIS = 'CONTENT_GENESIS', // Factories generating the game
  COMPILATION = 'COMPILATION', // Final assembly
  DEPLOYMENT = 'DEPLOYMENT', // Export/Install
  CLEANUP = 'CLEANUP', // Pruning ephemeral factories
  STABLE = 'STABLE'
}

export interface MetaSystem {
  id: string;
  name: string;
  description: string;
  manifest: string;
  status: 'ACTIVE' | 'BUILDING' | 'PENDING' | 'FAILED' | 'DIAGNOSING' | 'RETRYING' | 'STALLED';
  type: 'CORE' | 'FACTORY' | 'REGULATORY';
  category: 'ENGINE' | 'ASSETS' | 'PIPELINE' | 'COGNITION' | 'DEPLOYMENT';
  error?: string;
  retryCount?: number;
  health: number;
  isEphemeral: boolean; // True if it should be pruned after deployment
}

export interface ArchitectState {
  intent: string;
  phase: SynthesisPhase;
  coherence: number;
  entropy: number;
  systems: MetaSystem[];
  logs: string[];
  artifactReady: boolean;
}
