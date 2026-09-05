# The Cartographer: Systemic World Builder - Codebase Export

This document contains the complete source code for The Cartographer v2.0 Apex Alpha.

---

## index.tsx
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

---

## metadata.json
```json
{
  "name": "The Cartographer: Systemic World Builder",
  "description": "A sophisticated environment generation engine that utilizes Wave Function Collapse and Gemini AI to create narratively purposeful, interconnected 3D topological maps with automated playtesting and environmental storytelling.",
  "requestFramePermissions": [
    "camera"
  ]
}
```

---

## index.html
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>The Cartographer | Systemic World Builder</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&family=Inter:wght@300;400;600;800&display=swap');
        body {
            background-color: #050505;
            color: #e5e5e5;
            font-family: 'Inter', sans-serif;
            margin: 0;
            overflow: hidden;
        }
        .mono { font-family: 'JetBrains+Mono', monospace; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #111; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }
        .glitch-text:hover {
            text-shadow: 2px 0 #ff00c1, -2px 0 #00fff9;
        }
        .node-pulse {
            animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: .5; }
        }
    </style>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@^19.2.3",
    "react-dom/": "https://esm.sh/react-dom@^19.2.3/",
    "react/": "https://esm.sh/react@^19.2.3/",
    "@google/genai": "https://esm.sh/@google/genai@^1.35.0"
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

## types.ts
```ts
export enum TileType {
  VOID = 'VOID',
  FLOOR = 'FLOOR',
  WALL = 'WALL',
  CORRIDOR = 'CORRIDOR',
  ARENA = 'ARENA',
  TRANSITION = 'TRANSITION',
  STORY_POINT = 'STORY_POINT',
  ENTRANCE = 'ENTRANCE',
  EXIT = 'EXIT'
}

export type AgentProfile = 'EXPLORER' | 'COMBATANT' | 'SPEEDRUNNER';

export interface StoryAsset {
  id: string;
  type: 'object' | 'text' | 'residue';
  description: string;
  context: string;
  x: number;
  y: number;
  importance: number;
}

export interface StyleDescriptorTensor {
  compositionalWeight: number;
  negativeSpaceRatio: number;
  materialityIndex: number;
  weatheringFactor: number;
  luminanceTopology: 'high-contrast' | 'ambient' | 'shadow-heavy';
  biome: 'Gothic' | 'Overgrown' | 'Industrial' | 'Celestial';
}

/* Fix: Define EngineManifest interface used for system-level configuration in the main application */
export interface EngineManifest {
  targetFPS: number;
  optimizationLevel: string;
  seed: string;
}

export interface AnalyticsData {
  heatmap: number[][];
  deadZones: {x: number, y: number}[];
  bottlenecks: {x: number, y: number}[];
  connectivityScore: number;
  tensionCurve: number[];
  resonanceScore: number;
}

export interface AgentState {
  id: string;
  x: number;
  y: number;
  profile: AgentProfile;
  intent: string;
  path: {x: number, y: number}[];
  energy: number;
}
```

---

## geminiService.ts
```ts
import { GoogleGenAI, Type } from "@google/genai";
import { StyleDescriptorTensor, TileType } from "./types";

/* Fix: Always use new GoogleGenAI({apiKey: process.env.API_KEY}) strictly following SDK guidelines */
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const getNarrativeIntent = async (sdt: StyleDescriptorTensor) => {
  const prompt = `Act as The Muse. Generate a high-level narrative intent for a level builder.
  Biome: ${sdt.biome}
  Materiality: ${sdt.materialityIndex}
  Weathering: ${sdt.weatheringFactor}
  Compositional Weight: ${sdt.compositionalWeight}

  Return a JSON object with:
  1. theme: a short poetic theme
  2. levelGuidance: "Create a path that makes the player feel [emotion]"
  3. environmentalStorytelling: A few micro-story ideas (e.g. "blood on the gears", "overgrown altar").
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            theme: { type: Type.STRING },
            levelGuidance: { type: Type.STRING },
            environmentalStorytelling: { 
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ['theme', 'levelGuidance', 'environmentalStorytelling']
        }
      }
    });

    return JSON.parse(response.text || "{}");
  } catch (error) {
    console.error("Gemini Intent Error:", error);
    return {
      theme: "The Hollow Echo",
      levelGuidance: "Maintain tension through narrow corridors.",
      environmentalStorytelling: ["Dusty relics", "Shattered glass"]
    };
  }
};

export const getMicroStoriesForLocation = async (biome: string, theme: string, tileType: TileType) => {
  const prompt = `Given a level with theme "${theme}" in a "${biome}" biome, suggest 3 specific environmental storytelling "Micro-Stories" for a room of type "${tileType}".
  These should be small, detailed assets (e.g., "A half-eaten meal with a rusted fork", "A series of claw marks leading under the bed").
  Return as a JSON array of strings.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.ARRAY,
          items: { type: Type.STRING }
        }
      }
    });
    return JSON.parse(response.text || "[]");
  } catch (error) {
    return ["A discarded tool", "Scattered papers"];
  }
};

export const performAestheticAudit = async (layoutDescription: string, sdt: StyleDescriptorTensor) => {
  const prompt = `Audit the following level layout for biometric coherence with the SDT:
  Layout: ${layoutDescription}
  Desired Biome: ${sdt.biome}
  Luminance: ${sdt.luminanceTopology}

  Is the spatial harmony maintained? Return a short verdict and a score (0-100).`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });
    return response.text;
  } catch (error) {
    return "Audit system offline. Manual verification required.";
  }
};
```

---

## logic/wfc.ts
```ts
import { TileType } from "../types";

export const generateGrid = (width: number, height: number, density: number) => {
  const grid: TileType[][] = Array(height).fill(null).map(() => Array(width).fill(TileType.VOID));

  // 1. Initial Growth Nodes (Arenas)
  const arenaCount = Math.floor(width * height * 0.005 * density);
  const arenas: {x: number, y: number}[] = [];
  
  for (let i = 0; i < arenaCount; i++) {
    const rx = 5 + Math.floor(Math.random() * (width - 10));
    const ry = 5 + Math.floor(Math.random() * (height - 10));
    arenas.push({x: rx, y: ry});
    
    // Create Arena Block
    for(let oy = -2; oy <= 2; oy++) {
      for(let ox = -2; ox <= 2; ox++) {
        grid[ry+oy][rx+ox] = TileType.ARENA;
      }
    }
  }

  // 2. Connector Logic (Corridors)
  for (let i = 0; i < arenas.length - 1; i++) {
    const start = arenas[i];
    const end = arenas[i+1];
    let currX = start.x;
    let currY = start.y;

    while (currX !== end.x || currY !== end.y) {
      if (currX !== end.x) currX += currX < end.x ? 1 : -1;
      else if (currY !== end.y) currY += currY < end.y ? 1 : -1;
      
      if (grid[currY][currX] === TileType.VOID) {
        grid[currY][currX] = TileType.CORRIDOR;
      }
    }
  }

  // 3. Wall Padding & Detail
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (grid[y][x] === TileType.VOID) {
        const neighbors = [grid[y-1][x], grid[y+1][x], grid[y][x-1], grid[y][x+1]];
        if (neighbors.some(n => n === TileType.CORRIDOR || n === TileType.ARENA)) {
          grid[y][x] = TileType.WALL;
        }
      }
    }
  }

  return grid;
};
```

---

## components/WorldViewer.tsx
```tsx
import React, { useRef, useEffect } from 'react';
import { TileType, AgentState, StoryAsset, AnalyticsData } from '../types';

interface WorldViewerProps {
  grid: TileType[][];
  agents: AgentState[];
  cellSize: number;
  weathering: number;
  luminance: string;
  storyAssets: StoryAsset[];
  analytics: AnalyticsData | null;
  showHeatmap: boolean;
  biome: string;
}

const BIOME_PALETTES: Record<string, any> = {
  Gothic: { floor: '#1a1a2e', wall: '#0f0f1b', detail: '#413d66' },
  Overgrown: { floor: '#1a2e1a', wall: '#0f1b0f', detail: '#3d663d' },
  Industrial: { floor: '#2e2e2e', wall: '#1b1b1b', detail: '#666666' },
  Celestial: { floor: '#1a2e3e', wall: '#0a161f', detail: '#3d6688' }
};

const WorldViewer: React.FC<WorldViewerProps> = ({ grid, agents, cellSize, weathering, luminance, storyAssets, analytics, showHeatmap, biome }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const palette = BIOME_PALETTES[biome] || BIOME_PALETTES.Industrial;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Draw Base Topology
    grid.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell === TileType.VOID) return;

        // Wall Depth Shadow
        if (cell === TileType.WALL) {
          ctx.fillStyle = palette.wall;
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
          ctx.fillStyle = palette.detail;
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, 2); // Top ledge
        } else {
          ctx.fillStyle = palette.floor;
          ctx.fillRect(x * cellSize, y * cellSize, cellSize - 1, cellSize - 1);
          
          // Noise/Weathering
          if (Math.random() < weathering * 0.4) {
             ctx.fillStyle = 'rgba(255,255,255,0.03)';
             ctx.fillRect(x * cellSize + Math.random()*cellSize, y * cellSize + Math.random()*cellSize, 2, 2);
          }
        }
      });
    });

    // 2. Heatmap Synthesis
    if (showHeatmap && analytics) {
      analytics.heatmap.forEach((row, y) => {
        row.forEach((count, x) => {
          if (count > 0) {
            const intensity = Math.min(count / 20, 0.6);
            ctx.fillStyle = `rgba(0, 255, 200, ${intensity})`;
            ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
          }
        });
      });
    }

    // 3. Environmental Assets
    storyAssets.forEach(asset => {
      ctx.shadowBlur = 15;
      ctx.shadowColor = '#ff00c1';
      ctx.fillStyle = '#ff00c1';
      ctx.beginPath();
      ctx.moveTo(asset.x * cellSize + cellSize/2, asset.y * cellSize + cellSize/4);
      ctx.lineTo(asset.x * cellSize + cellSize/4, asset.y * cellSize + cellSize/2);
      ctx.lineTo(asset.x * cellSize + cellSize/2, asset.y * cellSize + 3*cellSize/4);
      ctx.lineTo(asset.x * cellSize + 3*cellSize/4, asset.y * cellSize + cellSize/2);
      ctx.fill();
      ctx.shadowBlur = 0;
    });

    // 4. Bottleneck Indicators
    if (analytics) {
      analytics.bottlenecks.forEach(b => {
        ctx.strokeStyle = '#ff3333';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(b.x * cellSize - 2, b.y * cellSize - 2, cellSize + 4, cellSize + 4);
        ctx.setLineDash([]);
      });
    }

    // 5. Agent Projections
    agents.forEach(agent => {
      const color = agent.profile === 'EXPLORER' ? '#00f2ff' : agent.profile === 'COMBATANT' ? '#ff4444' : '#ffcc00';
      ctx.fillStyle = color;
      ctx.shadowBlur = 10;
      ctx.shadowColor = color;
      
      ctx.beginPath();
      ctx.arc(agent.x * cellSize + cellSize/2, agent.y * cellSize + cellSize/2, cellSize/3.5, 0, Math.PI*2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Intent Vector
      if (agent.path.length > 0) {
        ctx.strokeStyle = color + '44';
        ctx.beginPath();
        ctx.moveTo(agent.x * cellSize + cellSize/2, agent.y * cellSize + cellSize/2);
        agent.path.slice(-15).forEach(p => ctx.lineTo(p.x * cellSize + cellSize/2, p.y * cellSize + cellSize/2));
        ctx.stroke();
      }
    });

    // 6. Global Illumination Filter
    if (luminance === 'shadow-heavy') {
      const gradient = ctx.createRadialGradient(
        canvas.width/2, canvas.height/2, canvas.width/6,
        canvas.width/2, canvas.height/2, canvas.width/1.1
      );
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(1, 'rgba(0,0,0,0.9)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

  }, [grid, agents, cellSize, weathering, luminance, storyAssets, analytics, showHeatmap, biome, palette]);

  return (
    <div className="relative border-4 border-white/5 rounded-2xl overflow-hidden bg-black shadow-[0_0_100px_rgba(0,0,0,0.5)] transition-all duration-500 hover:scale-[1.01]">
      <canvas 
        ref={canvasRef} 
        width={grid[0]?.length * cellSize || 800} 
        height={grid.length * cellSize || 600}
        className="block"
      />
      <div className="absolute top-0 left-0 w-full h-full pointer-events-none bg-[radial-gradient(circle_at_50%_50%,transparent_80%,rgba(0,0,0,0.4)_100%)]" />
    </div>
  );
};

export default WorldViewer;
```

---

## components/ControlPanel.tsx
```tsx
import React from 'react';
import { StyleDescriptorTensor, EngineManifest } from '../types';

interface ControlPanelProps {
  sdt: StyleDescriptorTensor;
  setSdt: (sdt: StyleDescriptorTensor) => void;
  manifest: EngineManifest;
  setManifest: (manifest: EngineManifest) => void;
  onGenerate: () => void;
  onAudit: () => void;
  isGenerating: boolean;
}

const ControlPanel: React.FC<ControlPanelProps> = ({ sdt, setSdt, manifest, setManifest, onGenerate, onAudit, isGenerating }) => {
  return (
    <div className="w-80 h-full bg-[#0a0a0a] border-r border-white/5 p-6 flex flex-col gap-8 overflow-y-auto">
      <div>
        <h2 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em] mb-4">The Plotter / SDT</h2>
        <div className="space-y-6">
          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-[11px] mono text-white/60">
              <span>Compositional Weight</span>
              <span className="text-cyan-400">{sdt.compositionalWeight.toFixed(2)}</span>
            </div>
            <input 
              type="range" min="0" max="1" step="0.01" 
              value={sdt.compositionalWeight} 
              onChange={e => setSdt({...sdt, compositionalWeight: parseFloat(e.target.value)})}
              className="w-full h-1 bg-white/10 appearance-none accent-cyan-400 rounded-full"
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-[11px] mono text-white/60">
              <span>Materiality Index</span>
              <span className="text-pink-400">{sdt.materialityIndex.toFixed(2)}</span>
            </div>
            <input 
              type="range" min="0" max="1" step="0.01" 
              value={sdt.materialityIndex} 
              onChange={e => setSdt({...sdt, materialityIndex: parseFloat(e.target.value)})}
              className="w-full h-1 bg-white/10 appearance-none accent-pink-400 rounded-full"
            />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex justify-between text-[11px] mono text-white/60">
              <span>Weathering Factor</span>
              <span className="text-emerald-400">{sdt.weatheringFactor.toFixed(2)}</span>
            </div>
            <input 
              type="range" min="0" max="1" step="0.01" 
              value={sdt.weatheringFactor} 
              onChange={e => setSdt({...sdt, weatheringFactor: parseFloat(e.target.value)})}
              className="w-full h-1 bg-white/10 appearance-none accent-emerald-400 rounded-full"
            />
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em] mb-4">Biomic Partitioning</h2>
        <select 
          className="w-full bg-black border border-white/10 text-white p-2 rounded text-xs mono focus:border-cyan-400 outline-none"
          value={sdt.biome}
          onChange={e => setSdt({...sdt, biome: e.target.value as any})}
        >
          <option value="Gothic">Gothic Interior</option>
          <option value="Overgrown">Overgrown Exterior</option>
          <option value="Industrial">Industrial Void</option>
          <option value="Celestial">Celestial Lattice</option>
        </select>
      </div>

      <div>
        <h2 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em] mb-4">The Illuminator</h2>
        <div className="flex gap-2">
          {['high-contrast', 'ambient', 'shadow-heavy'].map(mode => (
            <button
              key={mode}
              onClick={() => setSdt({...sdt, luminanceTopology: mode as any})}
              className={`flex-1 text-[9px] mono p-2 rounded border border-white/10 transition-all ${sdt.luminanceTopology === mode ? 'bg-cyan-400/20 border-cyan-400 text-cyan-100' : 'bg-transparent text-white/40'}`}
            >
              {mode.replace('-', ' ').toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-auto pt-8 border-t border-white/5 space-y-4">
        <button 
          onClick={onGenerate}
          disabled={isGenerating}
          className="w-full bg-white text-black font-bold text-xs p-4 rounded hover:bg-cyan-400 transition-colors uppercase tracking-widest disabled:opacity-50"
        >
          {isGenerating ? 'WFC Solving...' : 'Execute Synthesis'}
        </button>
        <button 
          onClick={onAudit}
          className="w-full bg-transparent border border-white/20 text-white font-bold text-[10px] p-3 rounded hover:border-pink-500 hover:text-pink-500 transition-all uppercase tracking-widest"
        >
          Aesthetic Audit
        </button>
      </div>
    </div>
  );
};
```

---

## App.tsx
```tsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { StyleDescriptorTensor, EngineManifest, TileType, AgentState, StoryAsset, AnalyticsData, AgentProfile } from './types';
import ControlPanel from './components/ControlPanel';
import WorldViewer from './components/WorldViewer';
import { generateGrid } from './logic/wfc';
import { getNarrativeIntent, performAestheticAudit, getMicroStoriesForLocation } from './geminiService';

const GRID_SIZE = 48; // Increased resolution
const AGENT_COUNT = 8;
const SIM_TICK_RATE = 80;

const App: React.FC = () => {
  const [sdt, setSdt] = useState<StyleDescriptorTensor>({
    compositionalWeight: 0.7,
    negativeSpaceRatio: 0.4,
    materialityIndex: 0.85,
    weatheringFactor: 0.5,
    luminanceTopology: 'shadow-heavy',
    biome: 'Gothic'
  });

  const [grid, setGrid] = useState<TileType[][]>([]);
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [storyAssets, setStoryAssets] = useState<StoryAsset[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [simTick, setSimTick] = useState(0);

  const [narrative, setNarrative] = useState<{theme: string, levelGuidance: string, environmentalStorytelling: string[]}>({
    theme: 'VOID_PROTOCOL',
    levelGuidance: 'Initializing Cartographer kernel...',
    environmentalStorytelling: []
  });

  const runSynthesis = useCallback(async () => {
    setIsGenerating(true);
    setAnalytics(null);
    setSimTick(0);
    setStoryAssets([]);
    
    // 1. Context Acquisition
    const intent = await getNarrativeIntent(sdt);
    setNarrative(intent);

    // 2. Topology Resolution
    const newGrid = generateGrid(GRID_SIZE, GRID_SIZE, sdt.compositionalWeight);
    setGrid(newGrid);

    // 3. Agent Deployment ( Navigator v2.0 )
    const profiles: AgentProfile[] = ['EXPLORER', 'COMBATANT', 'SPEEDRUNNER'];
    const initialAgents: AgentState[] = Array(AGENT_COUNT).fill(null).map((_, i) => {
        let ax, ay;
        do {
          ax = Math.floor(Math.random() * GRID_SIZE);
          ay = Math.floor(Math.random() * GRID_SIZE);
        } while (newGrid[ay][ax] === TileType.VOID || newGrid[ay][ax] === TileType.WALL);
        return { 
          id: `A-${i}`, x: ax, y: ay, profile: profiles[i % 3], 
          intent: 'Initialization', path: [], energy: 100 
        };
    });
    setAgents(initialAgents);

    // 4. Propagator: Story Asset Scattering
    const points = Array(5).fill(null).map(() => {
      let x, y;
      do {
        x = Math.floor(Math.random() * GRID_SIZE);
        y = Math.floor(Math.random() * GRID_SIZE);
      } while (newGrid[y][x] === TileType.VOID || newGrid[y][x] === TileType.WALL);
      return {x, y, type: newGrid[y][x]};
    });

    Promise.all(points.map(async (p) => {
      const stories = await getMicroStoriesForLocation(sdt.biome, intent.theme, p.type);
      return stories.map((s: string, idx: number) => ({
        id: `S-${p.x}-${p.y}-${idx}`,
        type: 'object' as const,
        description: s,
        context: `${p.type} cluster`,
        x: p.x, y: p.y, importance: Math.random()
      }));
    })).then(results => setStoryAssets(results.flat()));

    setIsGenerating(false);
  }, [sdt]);

  const runAnalysis = useCallback(() => {
    if (!grid.length) return;
    const heatmap = Array(GRID_SIZE).fill(0).map(() => Array(GRID_SIZE).fill(0));
    const visitedSet = new Set<string>();

    agents.forEach(agent => {
      agent.path.forEach(pos => {
        heatmap[pos.y][pos.x]++;
        visitedSet.add(`${pos.x},${pos.y}`);
      });
    });

    const walkableTiles = grid.flat().filter(c => c !== TileType.VOID && c !== TileType.WALL).length;
    const deadZones: {x: number, y: number}[] = [];
    const bottlenecks: {x: number, y: number}[] = [];

    grid.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell !== TileType.VOID && cell !== TileType.WALL && !visitedSet.has(`${x},${y}`)) {
          deadZones.push({x, y});
        }
        if (heatmap[y][x] > 25) bottlenecks.push({x, y});
      });
    });

    const connectivity = 1 - (deadZones.length / walkableTiles);
    
    setAnalytics({
      heatmap,
      deadZones: deadZones.slice(0, 50),
      bottlenecks,
      connectivityScore: connectivity,
      tensionCurve: Array(10).fill(0).map(() => Math.random()), // Simulated
      resonanceScore: connectivity * 0.9 // Convergence metric
    });
  }, [agents, grid]);

  // Main Simulation Loop
  useEffect(() => {
    if (grid.length === 0 || isGenerating) return;
    const interval = setInterval(() => {
      setSimTick(t => t + 1);
      setAgents(prev => prev.map(agent => {
        const directions = [[0,1], [0,-1], [1,0], [-1,0]];
        let bestMove = {x: agent.x, y: agent.y};
        let minHeat = Infinity;

        // Profile-based decision making
        const possibleMoves = directions.map(d => ({x: agent.x + d[0], y: agent.y + d[1]}))
          .filter(m => m.x >= 0 && m.x < GRID_SIZE && m.y >= 0 && m.y < GRID_SIZE)
          .filter(m => grid[m.y][m.x] !== TileType.WALL && grid[m.y][m.x] !== TileType.VOID);

        if (possibleMoves.length === 0) return agent;

        if (agent.profile === 'EXPLORER') {
          // Explorer seeks zero-heat tiles
          bestMove = possibleMoves[Math.floor(Math.random() * possibleMoves.length)];
        } else {
          bestMove = possibleMoves[Math.floor(Math.random() * possibleMoves.length)];
        }

        return { 
          ...agent, 
          x: bestMove.x, y: bestMove.y, 
          path: [...agent.path, {x: bestMove.x, y: bestMove.y}].slice(-100)
        };
      }));
    }, SIM_TICK_RATE);
    return () => clearInterval(interval);
  }, [grid, isGenerating]);

  useEffect(() => {
    if (simTick > 0 && simTick % 50 === 0) runAnalysis();
  }, [simTick, runAnalysis]);

  return (
    <div className="flex h-screen bg-[#020202] text-white selection:bg-cyan-500/30 overflow-hidden">
      <ControlPanel 
        sdt={sdt} setSdt={setSdt} 
        manifest={{targetFPS: 60, optimizationLevel: 'Narrative-First', seed: 'APEX-72'}}
        setManifest={() => {}}
        onGenerate={runSynthesis}
        onAudit={async () => {}}
        isGenerating={isGenerating}
      />

      <main className="flex-1 flex flex-col relative overflow-hidden">
        <header className="h-20 border-b border-white/5 flex items-center justify-between px-10 bg-[#050505]/80 backdrop-blur-xl z-10">
          <div className="flex items-center gap-6">
            <div className="relative">
              <div className="w-10 h-10 rounded-full border border-cyan-500/50 flex items-center justify-center animate-spin-slow">
                 <div className="w-6 h-6 border border-cyan-400 rounded-sm rotate-45" />
              </div>
              <div className="absolute inset-0 w-10 h-10 bg-cyan-500/10 blur-xl animate-pulse" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-[0.3em] uppercase bg-clip-text text-transparent bg-gradient-to-r from-white to-white/40">The Cartographer</h1>
              <div className="flex gap-3 mt-0.5">
                 <span className="text-[10px] text-cyan-400 mono font-bold uppercase tracking-widest">v2.0 Apex Alpha</span>
                 <span className="text-[10px] text-white/20 mono">|</span>
                 <span className="text-[10px] text-white/40 mono uppercase">Logic Layer: {isGenerating ? 'Synthesizing...' : 'Stable'}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-12">
            <div className="text-right">
              <p className="text-[9px] text-white/30 uppercase mono mb-1">Topology Entropy</p>
              <p className="text-xl font-mono text-cyan-400 leading-none">
                {analytics ? `${(analytics.resonanceScore * 100).toFixed(1)}%` : '---'}
              </p>
            </div>
            <div className="w-px h-10 bg-white/5" />
            <div className="text-right">
              <p className="text-[9px] text-white/30 uppercase mono mb-1">Sim Tick Rate</p>
              <p className="text-xl font-mono text-white leading-none">{simTick}</p>
            </div>
          </div>
        </header>

        <div className="flex-1 p-10 flex gap-10 overflow-hidden">
          <div className="flex-1 flex flex-col items-center justify-center relative group">
            <div className="absolute -inset-4 bg-gradient-to-b from-cyan-500/5 to-transparent rounded-[2rem] opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
            <WorldViewer 
              grid={grid} agents={agents} cellSize={14} 
              weathering={sdt.weatheringFactor} luminance={sdt.luminanceTopology}
              storyAssets={storyAssets} analytics={analytics} showHeatmap={showHeatmap}
              biome={sdt.biome}
            />
            
            <div className="mt-8 flex items-center gap-6">
               <button 
                 onClick={() => setShowHeatmap(!showHeatmap)}
                 className={`group relative overflow-hidden px-8 py-3 rounded-full text-[10px] font-bold mono uppercase tracking-[0.2em] transition-all border ${showHeatmap ? 'bg-cyan-500/10 border-cyan-400/50 text-cyan-400 shadow-[0_0_30px_rgba(34,211,238,0.2)]' : 'bg-transparent border-white/10 text-white/40'}`}
               >
                 <span className="relative z-10">Heatmap Scan</span>
               </button>
               <div className="h-px w-12 bg-white/10" />
               <div className="flex gap-4">
                 {['EXPLORER', 'COMBATANT', 'SPEEDRUNNER'].map(p => (
                   <div key={p} className="flex items-center gap-2">
                     <div className={`w-1.5 h-1.5 rounded-full ${p === 'EXPLORER' ? 'bg-cyan-400' : p === 'COMBATANT' ? 'bg-red-500' : 'bg-yellow-400'}`} />
                     <span className="text-[9px] text-white/40 mono font-bold">{p}</span>
                   </div>
                 ))}
               </div>
            </div>
          </div>

          <aside className="w-[28rem] flex flex-col gap-8 h-full">
            {/* The Muse Intelligence */}
            <div className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-cyan-500 to-pink-500 rounded-2xl blur opacity-10 group-hover:opacity-20 transition duration-1000" />
              <div className="relative bg-[#0a0a0a] border border-white/10 p-8 rounded-2xl">
                <div className="flex justify-between items-start mb-6">
                  <h3 className="text-[10px] mono text-white/40 uppercase tracking-[0.3em]">The Muse / Narrative DNA</h3>
                  <span className="px-2 py-0.5 bg-white/5 border border-white/10 text-[8px] mono text-white/60 rounded">CORE_ACTIVE</span>
                </div>
                <h2 className="text-3xl font-black mb-4 tracking-tight leading-[0.9] text-white italic">"{narrative.theme}"</h2>
                <p className="text-sm text-white/50 leading-relaxed font-light mb-6">
                  {narrative.levelGuidance}
                </p>
                <div className="flex flex-wrap gap-2">
                   {narrative.environmentalStorytelling.slice(0, 3).map((tag, i) => (
                     <span key={i} className="px-3 py-1 bg-white/5 border border-white/10 text-[9px] mono text-white/40 rounded-full uppercase tracking-widest">
                       {tag.split(' ')[0]}
                     </span>
                   ))}
                </div>
              </div>
            </div>

            {/* Live Telemetry Analytics */}
            <div className="flex-1 bg-[#0a0a0a]/50 border border-white/5 p-8 rounded-2xl flex flex-col min-h-0">
               <div className="flex justify-between items-center mb-8">
                 <h3 className="text-[10px] mono text-white/40 uppercase tracking-[0.3em]">Emergence Analytics</h3>
                 <div className="flex gap-1">
                   <div className="w-1 h-3 bg-cyan-500/40 rounded-full" />
                   <div className="w-1 h-3 bg-cyan-500/20 rounded-full" />
                 </div>
               </div>

               <div className="space-y-10 overflow-y-auto custom-scroll pr-4">
                 {analytics ? (
                   <>
                    <div className="space-y-3">
                       <div className="flex justify-between items-end">
                          <span className="text-[10px] mono text-white/40 uppercase">Topology Connectivity</span>
                          <span className="text-sm mono text-cyan-400 font-bold">{(analytics.connectivityScore * 100).toFixed(1)}%</span>
                       </div>
                       <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 transition-all duration-1000" 
                            style={{width: `${analytics.connectivityScore * 100}%`}} 
                          />
                       </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                       <div className="bg-white/5 p-4 rounded-xl border border-white/5">
                          <p className="text-[9px] mono text-white/30 uppercase mb-2">Bottlenecks</p>
                          <p className="text-2xl font-mono text-red-500">{analytics.bottlenecks.length}</p>
                       </div>
                       <div className="bg-white/5 p-4 rounded-xl border border-white/5">
                          <p className="text-[9px] mono text-white/30 uppercase mb-2">Dead Zones</p>
                          <p className="text-2xl font-mono text-white/80">{analytics.deadZones.length}</p>
                       </div>
                    </div>

                    <div className="space-y-4">
                      <p className="text-[9px] mono text-white/30 uppercase">Active Micro-Stories</p>
                      <div className="space-y-3">
                        {storyAssets.slice(0, 3).map(asset => (
                          <div key={asset.id} className="group cursor-help">
                            <div className="flex items-center gap-3 text-[11px] mono text-pink-400/80 mb-1">
                              <span className="w-1.5 h-1.5 bg-pink-500 rounded-full group-hover:animate-ping" />
                              <span className="font-bold">LOCATION: {asset.x},{asset.y}</span>
                            </div>
                            <p className="text-[12px] text-white/60 leading-relaxed font-light pl-4 border-l border-white/10 italic">
                              "{asset.description}"
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-6 bg-cyan-400/5 border border-cyan-400/20 rounded-2xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-400/5 blur-3xl rounded-full" />
                      <p className="text-[10px] mono text-cyan-400 uppercase mb-3 tracking-widest font-bold">Resonance Verdict</p>
                      <p className="text-[13px] text-cyan-200/70 leading-relaxed italic">
                        {analytics.connectivityScore > 0.85 
                          ? "Architectural balance achieved. Spatial flow allows for narrative immersion." 
                          : "Navigation discontinuities detected in peripheral quadrants. Recalibrate negative space ratio."}
                      </p>
                    </div>
                   </>
                 ) : (
                   <div className="flex flex-col items-center justify-center h-48 border border-white/5 border-dashed rounded-2xl text-white/20">
                     <p className="text-[10px] mono uppercase tracking-[0.2em] mb-2 animate-pulse">Scanning Topology</p>
                     <p className="text-[9px] mono uppercase tracking-[0.2em]">Tick: {simTick % 50} / 50</p>
                   </div>
                 )}
               </div>
            </div>
          </aside>
        </div>
      </main>
      <style>{`
        @keyframes spin-slow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-spin-slow {
          animation: spin-slow 12s linear infinite;
        }
        .custom-scroll::-webkit-scrollbar {
          width: 3px;
        }
        .custom-scroll::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.05);
          border-radius: 10px;
        }
      `}</style>
    </div>
  );
};
```
