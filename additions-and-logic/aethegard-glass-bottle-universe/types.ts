
export type TabType = 'browser' | 'ai' | 'forge' | 'universe' | 'terminal' | 'substrate';

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  timestamp: number;
  isOmega?: boolean;
  isQuintessence?: boolean;
  isSovereign?: boolean;
  uikLog?: string;
}

export interface Manifestation {
  id: string;
  title: string;
  code: string;
  language: string;
  timestamp: number;
  complexity?: number;
  coherence?: number;
  isQuintessence?: boolean;
  isSovereign?: boolean;
  kernels?: number[];
}

export interface ArchitectConfig {
  systemInstruction: string;
  temperature: number;
  model: string;
  thinkingBudget?: number;
  quintessenceEnabled?: boolean;
  activeRings?: number[];
  activeKernels?: number[];
}

export interface TerminalLine {
  type: 'input' | 'output' | 'error' | 'system' | 'omega' | 'quintessence' | 'sovereign' | 'uik';
  content: string;
  timestamp: number;
}

export interface UIKKernel {
  id: number;
  name: string;
  symbol: string;
  function: string;
  isMirror?: boolean;
}

export interface UIKRing {
  id: number;
  name: string;
  domain: string;
}
