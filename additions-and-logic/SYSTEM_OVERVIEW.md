# Xandria Synesthesia Forge - Full System Source

This document contains the complete source code for the Xandria Synesthesia Forge system, a sovereign intent-to-code engine integrating Group VIII SENSORIUM operators.

---

## 1. metadata.json
```json
{
  "name": "Xandria Synesthesia Forge",
  "description": "A sovereign intent-to-code engine integrating Group VIII SENSORIUM operators for cross-modal binding between logic and perception.",
  "requestFramePermissions": [
    "camera",
    "microphone"
  ]
}
```

---

## 2. index.html
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Xandria Synesthesia Forge</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;500;700&family=Fira+Code:wght@400;600&display=swap" rel="stylesheet">
    <style>
        body {
            background-color: #020205;
            color: #d1d1f0;
            font-family: 'Space Grotesk', sans-serif;
            overflow: hidden;
            margin: 0;
        }
        .fira { font-family: 'Fira Code', monospace; }
        .glass {
            background: rgba(10, 10, 20, 0.85);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(0, 243, 255, 0.1);
        }
        .syn-hue-obsidian { background: #0a0a0f; border-color: #1a1a2f; }
        .syn-hue-prismatic { background: linear-gradient(135deg, #ff00ff, #00ffff); }
        
        @keyframes pulse-syn {
            0% { transform: scale(1); opacity: 0.8; }
            50% { transform: scale(1.05); opacity: 1; }
            100% { transform: scale(1); opacity: 0.8; }
        }
        .animate-syn { animation: pulse-syn 2s infinite ease-in-out; }
    </style>
<script type="importmap">
{
  "imports": {
    "react-dom/": "https://esm.sh/react-dom@^19.2.3/",
    "react/": "https://esm.sh/react@^19.2.3/",
    "react": "https://esm.sh/react@^19.2.3",
    "three": "https://esm.sh/three@^0.182.0"
  }
}
</script>
</head>
<body>
    <div id="root"></div>
</body>
</html>
```

---

## 3. types.ts
```typescript
export enum OperatorGroup {
  GENESIS = 'GENESIS',
  FABRIC = 'FABRIC',
  TENSOR = 'TENSOR',
  INTERFACE = 'INTERFACE',
  NETWORK = 'NETWORK',
  SECURITY = 'SECURITY',
  SEAL = 'SEAL',
  SENSORIUM = 'SENSORIUM',
}

export type SynestheticOperator = '$Syn' | '$Hue' | '$Tone' | '$Tex' | '$Spat';

export interface AstNode {
  id: string;
  type: 'INDUCER' | 'CONCURRENT' | 'BINDING' | 'BLOCK';
  symbol: string;
  args?: Record<string, any>;
  concurrentNodes?: AstNode[]; // The "Concurrent" y in x -> y
  binding?: Binding; // Explicit relationship metadata
}

export interface Binding {
  inducer: string; 
  concurrent: SynestheticOperator;
  args?: Record<string, any>;
}

export interface PerceptualEmbedding {
  chroma_vector: [number, number, number]; // RGB normalized
  audio_fingerprint: number; // Centroid frequency or complexity index
  spatial_weight: number; // Gravitational mass / logic density
  texture_roughness: number; // 0.0 to 1.0 mapping to visual/haptic grit
}

export interface TraceEntry {
  timestamp: number;
  type: 'INDUCER' | 'CONCURRENT' | 'SYSTEM' | 'PARSER' | 'RECALL';
  message: string;
  payload?: any;
}

export interface Artifact {
  id: string;
  intent: string;
  utl_script: string;
  ast: AstNode[];
  bindings: Binding[];
  embeddings: PerceptualEmbedding;
  timestamp: number;
}
```

---

## 4. index.tsx
```typescript
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error("Could not find root element to mount to");

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

---

## 5. App.tsx
```typescript
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { XandriaEngine } from './engine/XandriaEngine';
import { Artifact, TraceEntry } from './types';
import Visualizer from './components/Visualizer';
import SensoriumOverlay from './components/SensoriumOverlay';

const App: React.FC = () => {
  const [engine] = useState(() => new XandriaEngine());
  const [intent, setIntent] = useState('');
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [recalled, setRecalled] = useState<Artifact[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const traceEndRef = useRef<HTMLDivElement>(null);

  const addTrace = useCallback((entry: Omit<TraceEntry, 'timestamp'>) => {
    setTrace(prev => [...prev, { ...entry, timestamp: Date.now() }].slice(-60));
  }, []);

  const handleManifest = async () => {
    if (!intent.trim() || isProcessing) return;

    setIsProcessing(true);
    addTrace({ type: 'SYSTEM', message: `Intent Injection: "${intent}"` });

    setTimeout(() => {
      addTrace({ type: 'PARSER', message: "Shereshevsky Bridge Algorithm initiated..." });
      
      const artifact = engine.manifest(intent);
      setActiveArtifact(artifact);
      setRecalled([]);

      // Log the transduction steps
      artifact.ast.forEach(node => {
        if (node.type === 'INDUCER') {
          addTrace({ type: 'INDUCER', message: `Activated: ${node.symbol}` });
          node.concurrentNodes?.forEach(c => {
            addTrace({ 
              type: 'CONCURRENT', 
              message: `Sensory Coupling: ${node.symbol} ~> ${c.symbol}`,
              payload: c.args 
            });
          });
        } else if (node.type === 'BINDING') {
          addTrace({ 
            type: 'CONCURRENT', 
            message: `Manual Binding: ${node.args?.inducer} ~> ${node.args?.concurrent} (${node.args?.raw})`
          });
        }
      });

      addTrace({ 
        type: 'SYSTEM', 
        message: `Artifact Sealed into Lattice. Coherence: 1.0 J` 
      });

      setIsProcessing(false);
      setIntent('');
    }, 700);
  };

  const handleRecall = () => {
    if (!activeArtifact) return;
    addTrace({ type: 'RECALL', message: "Searching Lattice Memory by Perceptual Embedding..." });
    const results = engine.recallByFeeling(activeArtifact.embeddings);
    // Filter out current artifact to show historical matches
    setRecalled(results.filter(r => r.id !== activeArtifact.id));
  };

  useEffect(() => {
    if (traceEndRef.current) {
      traceEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [trace]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#020205] text-[#d1d1f0] relative overflow-hidden">
      <SensoriumOverlay activeBindings={activeArtifact?.bindings || []} />
      
      <div className="absolute inset-0 z-0 pointer-events-none">
        <Visualizer activeBindings={activeArtifact?.bindings || []} />
      </div>

      <header className="z-10 p-8 flex justify-between items-start pointer-events-none">
        <div className="glass p-6 rounded-2xl flex flex-col gap-1 pointer-events-auto shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></div>
            <h1 className="text-2xl font-bold tracking-widest uppercase italic">XANDRIA <span className="text-cyan-400">v5.0 Prime</span></h1>
          </div>
          <p className="text-[10px] fira opacity-50 tracking-tighter uppercase">
            Sovereign Engine: <span className="text-cyan-400">SYNESTHESIA_CORE</span>
          </p>
        </div>

        <div className="glass p-6 rounded-2xl flex gap-8 items-center pointer-events-auto shadow-2xl">
          <div className="text-center">
            <p className="text-[9px] opacity-40 uppercase mb-1 fira">Syntropy</p>
            <p className="text-xl font-bold text-cyan-400">99.999%</p>
          </div>
          <div className="w-px h-8 bg-white/10"></div>
          <div className="text-center">
            <p className="text-[9px] opacity-40 uppercase mb-1 fira">Vault_Memory</p>
            <p className="text-xl font-bold text-pink-500">{engine.getVault().length}</p>
          </div>
        </div>
      </header>

      <main className="z-10 flex-1 flex flex-col items-center justify-center p-8 pointer-events-none">
        <div className="w-full max-w-4xl space-y-6 pointer-events-auto">
          <div className="text-center space-y-2 mb-8">
            <h2 className="text-4xl font-light tracking-tighter">Materialize <span className="text-cyan-400 italic">Intent via Sensorium</span></h2>
            <p className="text-[10px] opacity-40 fira uppercase tracking-[0.3em]">Neural Transduction | Shereshevsky Bridge Active</p>
          </div>

          <div className="glass p-2 rounded-full flex items-center pr-4 border-cyan-500/30 focus-within:ring-4 focus-within:ring-cyan-500/10 transition-all shadow-2xl">
            <input 
              type="text" 
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleManifest()}
              placeholder="Inject Intent (e.g. 'Shield the matrix loop') or Binding (e.g. 'OP-22 ~> $Hue(purple)')" 
              className="bg-transparent flex-1 px-8 py-4 text-lg font-light placeholder:opacity-20 outline-none"
            />
            <button 
              onClick={handleManifest}
              disabled={isProcessing}
              className={`bg-cyan-500 text-black font-bold px-8 py-4 rounded-full transition-all ${isProcessing ? 'opacity-50 cursor-not-allowed' : 'hover:scale-105 active:scale-95'}`}
            >
              {isProcessing ? 'SYNTHESIZING...' : 'MANIFEST'}
            </button>
          </div>
        </div>
      </main>

      <footer className="z-10 h-80 p-8 grid grid-cols-4 gap-6 pointer-events-none overflow-hidden mb-4">
        {/* Lattice Perception Panel */}
        <div className="glass p-6 rounded-2xl col-span-1 overflow-hidden flex flex-col pointer-events-auto">
          <h3 className="text-[10px] font-bold opacity-40 uppercase mb-3 tracking-widest">Lattice Perception</h3>
          <div className="flex-1 overflow-y-auto space-y-4 scrollbar-hide">
            {activeArtifact ? (
              <>
                <div className="space-y-3 p-4 bg-white/5 rounded-xl border border-white/5">
                  <div>
                    <p className="text-[9px] opacity-40 uppercase fira mb-2">Chroma Vector</p>
                    <div className="flex gap-1 h-2">
                      {activeArtifact.embeddings.chroma_vector.map((c, i) => (
                        <div key={i} className="flex-1 rounded-full bg-cyan-400" style={{ opacity: Math.max(0.1, c) }} />
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-between text-[10px] fira">
                    <span className="opacity-40">AUDIO_FRQ</span>
                    <span className="text-pink-400">{activeArtifact.embeddings.audio_fingerprint} Hz</span>
                  </div>
                  <div className="flex justify-between text-[10px] fira">
                    <span className="opacity-40">SPAT_WEIGHT</span>
                    <span className="text-purple-400">{activeArtifact.embeddings.spatial_weight.toFixed(2)} M</span>
                  </div>
                  <div className="flex justify-between text-[10px] fira">
                    <span className="opacity-40">TEX_GRIT</span>
                    <span className="text-orange-400">{(activeArtifact.embeddings.texture_roughness * 100).toFixed(0)}%</span>
                  </div>
                </div>

                <button 
                  onClick={handleRecall}
                  className="w-full py-2 bg-cyan-500/10 border border-cyan-500/30 text-[9px] uppercase font-bold text-cyan-400 rounded-lg hover:bg-cyan-500/20 transition-all"
                >
                  Recall by Feeling
                </button>

                {recalled.length > 0 && (
                  <div className="space-y-2 mt-2">
                    <p className="text-[8px] opacity-30 uppercase">Perceptual Matches:</p>
                    {recalled.slice(0, 3).map((r, i) => (
                      <div key={i} className="text-[9px] truncate p-2 bg-white/5 rounded-lg border border-white/5 opacity-60 hover:opacity-100 cursor-pointer transition-opacity">
                        #{r.id.split('-')[1]} | {r.intent}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="text-center mt-10 opacity-20 italic text-xs">Awaiting intent injection...</div>
            )}
          </div>
        </div>

        {/* Synthesis Trace Terminal */}
        <div className="glass p-6 rounded-2xl col-span-3 overflow-hidden flex flex-col pointer-events-auto">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-[10px] font-bold opacity-40 uppercase tracking-widest">Synthesis Trace</h3>
            <span className="text-[10px] fira text-cyan-400 uppercase">Status: Resonance_Active</span>
          </div>
          <div className="flex-1 overflow-y-auto fira text-[10px] leading-relaxed opacity-70 space-y-1.5 scrollbar-hide">
            {trace.length === 0 && <div className="opacity-30 italic">Initializing kernel trace...</div>}
            {trace.map((entry, i) => (
              <div key={i} className="flex gap-3">
                <span className="opacity-20 whitespace-nowrap text-[8px] mt-0.5">
                  {new Date(entry.timestamp).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}
                </span>
                <span className={
                  entry.type === 'INDUCER' ? 'text-purple-400 font-bold' : 
                  entry.type === 'CONCURRENT' ? 'text-pink-400 italic' : 
                  entry.type === 'PARSER' ? 'text-yellow-400' :
                  entry.type === 'RECALL' ? 'text-green-400 font-bold' :
                  'text-cyan-500/40'
                }>
                  [{entry.type}]
                </span>
                <span className="flex-1 border-b border-white/[0.02] pb-0.5">{entry.message}</span>
              </div>
            ))}
            <div ref={traceEndRef} />
          </div>
        </div>
      </footer>

      <style>{`
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
};

export default App;
```

---

## 6. engine/UtlParser.ts
```typescript
import { AstNode, Binding, SynestheticOperator } from '../types';

/**
 * UtlParser: The Neural Transduction Core
 * Implements the Shereshevsky Bridge algorithm to link functional Inducers (x)
 * to sensory Concurrents (y).
 */
export class UtlParser {
  // The Shereshevsky Bridge: Static mapping of functional states to perceptual modes
  private static SENSORIUM_MAP: Record<string, { symbol: SynestheticOperator; args: any }[]> = {
    // SECURITY -> OBSIDIAN HUE + GRAVITY + LOW STEADY HUM + MODERATE FRICTION
    'OP-51': [
      { symbol: '$Hue', args: { color: '#0a0a0f', label: 'Obsidian' } },
      { symbol: '$Spat', args: { weight: 1.8, gravity: true, rotation: 'slow' } },
      { symbol: '$Tone', args: { freq: 110, waveform: 'sine', rhythm: 'steady' } },
      { symbol: '$Tex', args: { roughness: 0.4, grit: 'fine' } }
    ],
    // RECURSION/LOOP -> PULSATING TONE + SPIN + BRIGHT WHITE PULSE
    'OP-12': [
      { symbol: '$Tone', args: { freq: 440, waveform: 'square', rhythm: 'pulse', bpm: 128 } },
      { symbol: '$Spat', args: { weight: 1.2, rotation: 'fast' } },
      { symbol: '$Hue', args: { color: '#ffffff', label: 'Pulse' } },
      { symbol: '$Tex', args: { roughness: 0.1 } }
    ],
    // DATA MATRIX -> PRISMATIC HUE + VOLUME + SHIMMER TONE + CRYSTAL TEX
    'OP-22': [
      { symbol: '$Hue', args: { color: '#00ff99', label: 'Prismatic' } },
      { symbol: '$Spat', args: { weight: 2.5, density: 'high', gravity: false } },
      { symbol: '$Tone', args: { freq: 880, waveform: 'triangle', rhythm: 'shimmer' } },
      { symbol: '$Tex', args: { roughness: 0.2, grit: 'crystalline' } }
    ],
    // ERROR/HEAL -> DISSONANCE + SHAKE + JAGGED TEX + SAWTOOTH CHAOS
    'OP-63': [
      { symbol: '$Hue', args: { color: '#ff0033', label: 'Dissonance' } },
      { symbol: '$Tone', args: { freq: 880, waveform: 'sawtooth', rhythm: 'chaos' } },
      { symbol: '$Tex', args: { roughness: 1.0, grit: 'coarse' } },
      { symbol: '$Spat', args: { weight: 0.7, shake: true } }
    ],
    // GENESIS/VOID -> CYAN CALM + DRONE + SMOOTH
    'OP-01': [
      { symbol: '$Hue', args: { color: '#00f3ff', label: 'Void' } },
      { symbol: '$Tone', args: { freq: 220, waveform: 'sine', rhythm: 'drone' } },
      { symbol: '$Spat', args: { weight: 1.0, rotation: 'normal' } },
      { symbol: '$Tex', args: { roughness: 0.0 } }
    ]
  };

  public static injectShereshevskyBridge(nodes: AstNode[]): AstNode[] {
    return nodes.map(node => {
      if (node.type === 'INDUCER' && this.SENSORIUM_MAP[node.symbol]) {
        const concurrents: AstNode[] = this.SENSORIUM_MAP[node.symbol].map(rule => ({
          id: `syn-${Math.random().toString(36).substr(2, 9)}`,
          type: 'CONCURRENT' as const,
          symbol: rule.symbol,
          args: rule.args,
          binding: {
            inducer: node.symbol,
            concurrent: rule.symbol,
            args: rule.args
          }
        }));
        return { ...node, concurrentNodes: concurrents };
      }
      return node;
    });
  }

  public static parse(script: string): { ast: AstNode[]; bindings: Binding[] } {
    const ast: AstNode[] = [];
    const bindings: Binding[] = [];
    const lines = script.split(/[\n;]+/).map(l => l.trim()).filter(Boolean);

    lines.forEach(line => {
      if (line.includes('~>')) {
        const [left, right] = line.split('~>').map(s => s.trim());
        const inducerSymbol = left.replace(/\$.*?\$/, '').split('(')[0].trim();
        const concurrentMatch = right.match(/(\$\w+)(\((.*?)\))?/);
        if (concurrentMatch) {
          const concurrentSymbol = concurrentMatch[1] as SynestheticOperator;
          const argString = concurrentMatch[3] || '';
          const binding: Binding = {
            inducer: inducerSymbol,
            concurrent: concurrentSymbol,
            args: { manual_binding: true, raw: argString }
          };
          bindings.push(binding);
          ast.push({
            id: `node-${Math.random().toString(36).substr(2, 9)}`,
            type: 'BINDING',
            symbol: '~>',
            args: { inducer: inducerSymbol, concurrent: concurrentSymbol, raw: argString },
            binding: binding
          });
        }
      } else {
        const symbol = line.split('(')[0].trim();
        ast.push({
          id: `node-${Math.random().toString(36).substr(2, 9)}`,
          type: 'INDUCER',
          symbol: symbol,
          args: { raw: line }
        });
      }
    });

    const processedAst = this.injectShereshevskyBridge(ast);
    return { ast: processedAst, bindings };
  }
}
```

---

## 7. engine/XandriaEngine.ts
```typescript
import { Artifact, Binding, PerceptualEmbedding, AstNode } from '../types';
import { UtlParser } from './UtlParser';

export class XandriaEngine {
  private vault: Artifact[] = [];

  public manifest(intent: string): Artifact {
    const utl_script = this.transduceIntentToScript(intent);
    const { ast, bindings: manualBindings } = UtlParser.parse(utl_script);
    const allBindings = [...manualBindings, ...this.extractImplicitBindings(ast)];
    const embeddings = this.calculateEmbeddings(ast);

    const artifact: Artifact = {
      id: `art-${Math.random().toString(36).substr(2, 9)}`,
      intent,
      utl_script,
      ast,
      bindings: allBindings,
      embeddings,
      timestamp: Date.now()
    };

    this.vault.push(artifact);
    return artifact;
  }

  private transduceIntentToScript(intent: string): string {
    let script = "";
    const lower = intent.toLowerCase();
    if (lower.includes('security') || lower.includes('protect')) script += "OP-51(context=shield);\n";
    if (lower.includes('loop') || lower.includes('repeat')) script += "OP-12(cycle=active);\n";
    if (lower.includes('data') || lower.includes('matrix')) script += "OP-22(density=high);\n";
    if (lower.includes('error') || lower.includes('fix')) script += "OP-63(status=critical);\n";
    if (intent.includes('~>')) script += `${intent};\n`;
    return script || "OP-01(void=init);";
  }

  private extractImplicitBindings(ast: AstNode[]): Binding[] {
    const bindings: Binding[] = [];
    ast.forEach(node => {
      node.concurrentNodes?.forEach(c => {
        bindings.push({
          inducer: node.symbol,
          concurrent: c.symbol as any,
          args: c.args
        });
      });
    });
    return bindings;
  }

  private calculateEmbeddings(ast: AstNode[]): PerceptualEmbedding {
    let r = 0, g = 0.9, b = 1.0;
    let freq = 440;
    let weight = 1.0;
    let roughness = 0.0;
    ast.forEach(node => {
      const concurrents = node.concurrentNodes || [];
      concurrents.forEach(c => {
        if (c.symbol === '$Hue') {
          const hex = c.args?.color || '#00f3ff';
          r = parseInt(hex.slice(1, 3), 16) / 255;
          g = parseInt(hex.slice(3, 5), 16) / 255;
          b = parseInt(hex.slice(5, 7), 16) / 255;
        }
        if (c.symbol === '$Tone') freq = c.args?.freq || 440;
        if (c.symbol === '$Spat') weight = c.args?.weight || 1.0;
        if (c.symbol === '$Tex') roughness = c.args?.roughness || 0.0;
      });
    });
    return { chroma_vector: [r, g, b], audio_fingerprint: freq, spatial_weight: weight, texture_roughness: roughness };
  }

  public recallByFeeling(target: PerceptualEmbedding): Artifact[] {
    return this.vault
      .map(art => {
        const dChroma = Math.sqrt(
          Math.pow(art.embeddings.chroma_vector[0] - target.chroma_vector[0], 2) +
          Math.pow(art.embeddings.chroma_vector[1] - target.chroma_vector[1], 2) +
          Math.pow(art.embeddings.chroma_vector[2] - target.chroma_vector[2], 2)
        );
        const dAudio = Math.abs(art.embeddings.audio_fingerprint - target.audio_fingerprint) / 1000;
        const dSpat = Math.abs(art.embeddings.spatial_weight - target.spatial_weight);
        const dTex = Math.abs(art.embeddings.texture_roughness - target.texture_roughness);
        return { art, distance: dChroma + dAudio + dSpat + dTex };
      })
      .sort((a, b) => a.distance - b.distance)
      .map(res => res.art);
  }

  public getVault() { return this.vault; }
}
```

---

## 8. components/Visualizer.tsx
```typescript
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Binding } from '../types';

interface VisualizerProps {
  activeBindings: Binding[];
}

const Visualizer: React.FC<VisualizerProps> = ({ activeBindings }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    lattice: THREE.Mesh;
    particles: THREE.Points;
    lights: THREE.PointLight[];
    clock: THREE.Clock;
  } | null>(null);

  const rotationSpeed = useRef(0.005);
  const shakeIntensity = useRef(0);
  const gravityTargetZ = useRef(12);

  useEffect(() => {
    if (!mountRef.current) return;
    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 12;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    mountRef.current.appendChild(renderer.domElement);
    const clock = new THREE.Clock();
    const geometry = new THREE.IcosahedronGeometry(4, 2);
    const material = new THREE.MeshPhongMaterial({
      color: 0x00f3ff,
      wireframe: true,
      transparent: true,
      opacity: 0.5,
      emissive: 0x004444,
      emissiveIntensity: 0.5
    });
    const lattice = new THREE.Mesh(geometry, material);
    scene.add(lattice);
    const particlesCount = 1200;
    const pos = new Float32Array(particlesCount * 3);
    for (let i = 0; i < particlesCount * 3; i++) pos[i] = (Math.random() - 0.5) * 50;
    const particlesGeom = new THREE.BufferGeometry();
    particlesGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const particlesMat = new THREE.PointsMaterial({ color: 0x00f3ff, size: 0.03, transparent: true, opacity: 0.4 });
    const particles = new THREE.Points(particlesGeom, particlesMat);
    scene.add(particles);
    const light1 = new THREE.PointLight(0xffffff, 1, 100);
    light1.position.set(10, 10, 10);
    const light2 = new THREE.PointLight(0x00f3ff, 1, 100);
    light2.position.set(-10, -10, 10);
    scene.add(light1, light2);
    scene.add(new THREE.AmbientLight(0x050505));
    sceneRef.current = { scene, camera, renderer, lattice, particles, lights: [light1, light2], clock };
    const animate = () => {
      requestAnimationFrame(animate);
      lattice.rotation.y += rotationSpeed.current;
      lattice.rotation.z += rotationSpeed.current * 0.4;
      particles.rotation.y -= rotationSpeed.current * 0.15;
      if (shakeIntensity.current > 0) {
        lattice.position.x = (Math.random() - 0.5) * shakeIntensity.current;
        lattice.position.y = (Math.random() - 0.5) * shakeIntensity.current;
      } else {
        lattice.position.lerp(new THREE.Vector3(0, 0, 0), 0.1);
      }
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, gravityTargetZ.current, 0.05);
      renderer.render(scene, camera);
    };
    animate();
    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      mountRef.current?.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    if (!sceneRef.current) return;
    const { lattice, particles, lights } = sceneRef.current;
    let targetScale = 1;
    let targetColor = new THREE.Color(0x00f3ff);
    let targetRotationSpeed = 0.005;
    let targetShake = 0;
    let targetGravityZ = 12;
    activeBindings.forEach(b => {
      if (b.concurrent === '$Spat') {
        const weight = b.args?.weight || 1.0;
        targetScale = weight;
        if (b.args?.rotation === 'fast') targetRotationSpeed = 0.025;
        else if (b.args?.rotation === 'slow') targetRotationSpeed = 0.001;
        else targetRotationSpeed = 0.005 * weight;
        if (b.args?.shake) targetShake = 0.4;
        if (b.args?.gravity) targetGravityZ = 7;
      }
      if (b.concurrent === '$Hue') targetColor = new THREE.Color(b.args?.color || '#00f3ff');
    });
    lattice.scale.setScalar(THREE.MathUtils.lerp(lattice.scale.x, targetScale, 0.08));
    (lattice.material as THREE.MeshPhongMaterial).color.lerp(targetColor, 0.1);
    (particles.material as THREE.PointsMaterial).color.lerp(targetColor, 0.1);
    lights.forEach(l => l.color.lerp(targetColor, 0.05));
    rotationSpeed.current = targetRotationSpeed;
    shakeIntensity.current = targetShake;
    gravityTargetZ.current = targetGravityZ;
  }, [activeBindings]);

  return <div ref={mountRef} className="w-full h-full" />;
};
export default Visualizer;
```

---

## 9. components/SensoriumOverlay.tsx
```typescript
import React, { useEffect, useState, useRef } from 'react';
import { Binding } from '../types';

interface SensoriumOverlayProps {
  activeBindings: Binding[];
}

interface ActiveOscillator {
  osc: OscillatorNode;
  gain: GainNode;
  lfo?: OscillatorNode;
  lfoGain?: GainNode;
}

const SensoriumOverlay: React.FC<SensoriumOverlayProps> = ({ activeBindings }) => {
  const [style, setStyle] = useState<React.CSSProperties>({});
  const [activeHueLabel, setActiveHueLabel] = useState<string | null>(null);
  const [isRough, setIsRough] = useState(false);
  const [grainFrequency, setGrainFrequency] = useState("0.65");
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeOscillators = useRef<Map<string, ActiveOscillator>>(new Map());

  useEffect(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const newStyle: React.CSSProperties = {};
    let hueLabel: string | null = null;
    let roughnessDetected = false;
    let currentGrit = "0.65";
    const currentToneIds = new Set<string>();

    activeBindings.forEach((b, index) => {
      const bindingId = `${b.inducer}-${b.concurrent}-${index}`;
      if (b.concurrent === '$Hue') {
        hueLabel = b.args?.label || 'Resonance';
        const color = b.args?.color || (b.args?.raw === 'purple' ? '#a855f7' : '#00f3ff');
        newStyle.boxShadow = `inset 0 0 200px ${color}33, inset 0 0 100px ${color}22`;
        newStyle.backgroundColor = `${color}02`;
      }
      if (b.concurrent === '$Tex') {
        const roughness = b.args?.roughness || (b.args?.manual_binding ? 0.5 : 0);
        if (roughness > 0) {
          roughnessDetected = true;
          newStyle.backdropFilter = `blur(${roughness * 10}px) contrast(${1 + roughness}) saturate(${1 + roughness * 0.5})`;
          if (b.args?.grit === 'coarse') currentGrit = "0.95";
          else if (b.args?.grit === 'fine') currentGrit = "0.35";
          else if (b.args?.grit === 'crystalline') currentGrit = "0.1";
        }
      }
      if (b.concurrent === '$Tone' && audioCtxRef.current) {
        currentToneIds.add(bindingId);
        if (!activeOscillators.current.has(bindingId)) {
          const ctx = audioCtxRef.current;
          if (ctx.state === 'suspended') ctx.resume();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = (b.args?.waveform as OscillatorType) || 'sine';
          osc.frequency.setValueAtTime(b.args?.freq || 440, ctx.currentTime);
          gain.gain.setValueAtTime(0, ctx.currentTime);
          let lfo: OscillatorNode | undefined;
          let lfoGain: GainNode | undefined;
          if (b.args?.rhythm === 'pulse') {
            lfo = ctx.createOscillator();
            lfo.frequency.setValueAtTime(6.4, ctx.currentTime);
            lfoGain = ctx.createGain();
            lfoGain.gain.setValueAtTime(0.06, ctx.currentTime);
            lfo.connect(lfoGain);
            lfoGain.connect(gain.gain);
            lfo.start();
          } else if (b.args?.rhythm === 'shimmer') {
            lfo = ctx.createOscillator();
            lfo.frequency.setValueAtTime(28, ctx.currentTime);
            lfoGain = ctx.createGain();
            lfoGain.gain.setValueAtTime(0.03, ctx.currentTime);
            lfo.connect(lfoGain);
            lfoGain.connect(gain.gain);
            lfo.start();
          } else if (b.args?.rhythm === 'chaos') {
            lfo = ctx.createOscillator();
            lfo.type = 'sawtooth';
            lfo.frequency.setValueAtTime(14, ctx.currentTime);
            lfoGain = ctx.createGain();
            lfoGain.gain.setValueAtTime(0.1, ctx.currentTime);
            lfo.connect(lfoGain);
            lfoGain.connect(gain.gain);
            lfo.start();
          } else if (b.args?.rhythm === 'steady' || b.args?.rhythm === 'drone') {
            gain.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 1.2);
          } else {
            gain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.3); 
          }
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          activeOscillators.current.set(bindingId, { osc, gain, lfo, lfoGain });
        }
      }
    });

    activeOscillators.current.forEach((val, id) => {
      if (!currentToneIds.has(id)) {
        const ctx = audioCtxRef.current;
        if (ctx) {
          val.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
          setTimeout(() => {
            val.osc.stop();
            val.osc.disconnect();
            val.gain.disconnect();
            if (val.lfo) val.lfo.stop();
          }, 500);
        }
        activeOscillators.current.delete(id);
      }
    });

    setStyle(newStyle);
    setActiveHueLabel(hueLabel);
    setIsRough(roughnessDetected);
    setGrainFrequency(currentGrit);
  }, [activeBindings]);

  useEffect(() => {
    return () => {
      activeOscillators.current.forEach(val => {
        val.osc.stop();
        val.osc.disconnect();
        val.gain.disconnect();
        if (val.lfo) val.lfo.stop();
      });
      activeOscillators.current.clear();
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  return (
    <>
      <div className="fixed inset-0 pointer-events-none transition-all duration-1000 z-50 flex items-center justify-center overflow-hidden mix-blend-screen" style={style}>
        {activeHueLabel && (
          <div className="text-[12vw] font-black italic select-none uppercase tracking-[2rem] text-white/[0.04] animate-syn whitespace-nowrap">
            {activeHueLabel}
          </div>
        )}
      </div>
      {isRough && (
        <div className="fixed inset-0 z-40 pointer-events-none opacity-40 mix-blend-multiply transition-opacity duration-1000 overflow-hidden">
          <svg width="100%" height="100%" className="w-full h-full">
            <filter id="grain">
              <feTurbulence type="fractalNoise" baseFrequency={grainFrequency} numOctaves="4" stitchTiles="stitch" />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect width="100%" height="100%" filter="url(#grain)" />
          </svg>
        </div>
      )}
    </>
  );
};
export default SensoriumOverlay;
```

---
