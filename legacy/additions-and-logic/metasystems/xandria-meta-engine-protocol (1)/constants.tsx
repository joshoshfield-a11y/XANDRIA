
import React from 'react';
import { 
  Zap, Box, Cloud, Droplet, ShieldCheck, 
  MessageSquare, Dna, Activity, Cpu, Wifi,
  Settings, Layers, Terminal, Rocket, Search, 
  Play, Database, Shield, Monitor
} from 'lucide-react';
import { XandriaSystem, PlaneType, Archetype } from './types';

export const SYSTEMS: XandriaSystem[] = [
  {
    id: 'void',
    name: 'OP-01 Void',
    plane: PlaneType.GENESIS,
    description: 'Sanitizes workspace and establishes the Null-State Anchor.',
    mechanism: 'Clears KV-cache and reduces all active state vectors to vacuum state |0⟩.',
    icon: 'Zap'
  },
  {
    id: 'intent',
    name: 'OP-03 Intent',
    plane: PlaneType.GENESIS,
    description: 'Parses natural language into formal logic constraints.',
    mechanism: 'Wavefunction reduction via the Projection Operator (Tp).',
    icon: 'MessageSquare'
  },
  {
    id: 'husk',
    name: 'OP-12 Weave',
    plane: PlaneType.FABRIC,
    description: 'Pre-compiled engine shell orchestrator.',
    mechanism: 'Injects assets into a master binary manifold bypassing lengthy compilation.',
    icon: 'Box'
  },
  {
    id: 'matrix',
    name: 'OP-22 Matrix',
    plane: PlaneType.TENSOR,
    description: 'Configures 3D scene graphs and physics grids.',
    mechanism: 'Topological vector space mapping using the Metric Tensor.',
    icon: 'Layers'
  },
  {
    id: 'delta',
    name: 'OP-27 Delta',
    plane: PlaneType.TENSOR,
    description: 'Tracks state changes for high-fidelity diffing.',
    mechanism: 'Calculates the Entropy Rate (dS/dt) for self-correction loops.',
    icon: 'Activity'
  },
  {
    id: 'interface',
    name: 'OP-36 Interface',
    plane: PlaneType.INTERFACE,
    description: 'Optimizes UX layer by injecting atemporal base styles.',
    mechanism: 'Persona shifting and coordinate change via Transformation Matrix [T].',
    icon: 'Monitor'
  },
  {
    id: 'gate',
    name: 'OP-41 Gate',
    plane: PlaneType.NETWORK,
    description: 'Sequential causal logic management.',
    mechanism: 'Orders events in linear time via sequential BC chain links.',
    icon: 'Wifi'
  },
  {
    id: 'vault',
    name: 'OP-51 Vault',
    plane: PlaneType.SECURITY,
    description: 'Digital signature chain verification.',
    mechanism: 'AES-256-GCM encryption of sensitive identity metadata.',
    icon: 'ShieldCheck'
  },
  {
    id: 'seal',
    name: 'OP-61 Seal',
    plane: PlaneType.SEAL,
    description: 'Finalizes artifact with a cryptographic hash.',
    mechanism: 'Forced collapse into a statistically improbable, stable outcome.',
    icon: 'Shield'
  },
  {
    id: 'forge',
    name: 'OP-72 Forge',
    plane: PlaneType.SEAL,
    description: 'Full transcendence build completion.',
    mechanism: 'The Omega Point transition where Δt → 0 and Integration Σ → ∞.',
    icon: 'Rocket'
  }
];

export const ARCHETYPES: Archetype[] = [
  {
    id: 'platformer',
    name: 'Side-Scroller Soul',
    description: 'Kinematic movement, jump buffers, and gravity manifolds.',
    image: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=800&q=80',
    nodes: [
      { id: 'n1', type: 'VOID', label: 'Axis: Horizontal', connectedTo: ['n2'], status: 'idle' },
      { id: 'n2', type: 'FABRIC', label: 'Velocity Resolver', connectedTo: ['n3', 'n5'], status: 'idle' },
      { id: 'n3', type: 'FABRIC', label: 'Gravity: 9.81m/s²', connectedTo: ['n5'], status: 'idle' },
      { id: 'n4', type: 'VOID', label: 'Button: Jump', connectedTo: ['n5'], status: 'idle' },
      { id: 'n5', type: 'ARTIFACT', label: 'CharController2D', connectedTo: [], status: 'idle' }
    ]
  },
  {
    id: 'survival',
    name: 'Survival Sandbox Soul',
    description: 'Persistence loops, crafting logic, and biological entropy simulation.',
    image: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=800&q=80',
    nodes: [
      { id: 's1', type: 'VOID', label: 'Clock: DayCycle', connectedTo: ['s2', 's3'], status: 'idle' },
      { id: 's2', type: 'FABRIC', label: 'Metabolic Drain', connectedTo: ['s4'], status: 'idle' },
      { id: 's3', type: 'FABRIC', label: 'Global Temperature', connectedTo: ['s4'], status: 'idle' },
      { id: 's4', type: 'FABRIC', label: 'Player Vital Monitor', connectedTo: ['s5'], status: 'idle' },
      { id: 's5', type: 'ARTIFACT', label: 'PostProcess: Vignette', connectedTo: [], status: 'idle' },
      { id: 's6', type: 'VOID', label: 'Inventory Event', connectedTo: ['s7'], status: 'idle' },
      { id: 's7', type: 'FABRIC', label: 'Crafting Resolver', connectedTo: ['s8'], status: 'idle' },
      { id: 's8', type: 'ARTIFACT', label: 'Persistence Storage', connectedTo: [], status: 'idle' }
    ]
  },
  {
    id: 'mmo',
    name: 'Net-Swarm Soul',
    description: 'Massively concurrent agent state-sync and authoritative server bridging.',
    image: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=800&q=80',
    nodes: [
      { id: 'm1', type: 'VOID', label: 'Remote Agent Input', connectedTo: ['m2'], status: 'idle' },
      { id: 'm2', type: 'FABRIC', label: 'Rollback Interceptor', connectedTo: ['m3'], status: 'idle' },
      { id: 'm3', type: 'FABRIC', label: 'Authority Resolver', connectedTo: ['m4', 'm5'], status: 'idle' },
      { id: 'm4', type: 'ARTIFACT', label: 'State Sync: TCP', connectedTo: [], status: 'idle' },
      { id: 'm5', type: 'ARTIFACT', label: 'Holographic Echo', connectedTo: [], status: 'idle' },
      { id: 'm6', type: 'VOID', label: 'Heartbeat Pulse', connectedTo: ['m2'], status: 'idle' }
    ]
  }
];

export const getIcon = (iconName: string, className?: string) => {
  const icons: Record<string, any> = {
    Zap, Box, Cloud, Droplet, ShieldCheck, 
    MessageSquare, Dna, Activity, Cpu, Wifi,
    Settings, Layers, Terminal, Rocket, Search, 
    Play, Database, Shield, Monitor
  };
  const IconComponent = icons[iconName];
  return IconComponent ? <IconComponent className={className} /> : null;
};
