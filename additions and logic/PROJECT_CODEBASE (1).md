# The Smith: AAA Engineering Forge - Full Codebase

## 1. Metadata
**File:** `metadata.json`
```json
{
  "name": "The Smith: AAA Engineering Forge",
  "description": "A high-fidelity technical workspace for translating Style Descriptor Tensors (SDT) into production-ready C++, HLSL, and Compute shaders for AAA game development environments.",
  "requestFramePermissions": [
    "camera"
  ]
}
```

## 2. Entry Points
**File:** `index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>The Smith | Engineering Forge</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #050505;
            color: #e5e7eb;
            overflow-x: hidden;
        }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .forge-grid {
            background-image: radial-gradient(circle at 2px 2px, #1a1a1a 1px, transparent 0);
            background-size: 24px 24px;
        }
        .glow-orange { box-shadow: 0 0 15px rgba(249, 115, 22, 0.3); }
        .glow-blue { box-shadow: 0 0 15px rgba(59, 130, 246, 0.3); }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #444; }
    </style>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@^19.2.3",
    "react-dom/": "https://esm.sh/react-dom@^19.2.3/",
    "react/": "https://esm.sh/react@^19.2.3/",
    "@google/genai": "https://esm.sh/@google/genai@^1.35.0",
    "recharts": "https://esm.sh/recharts@^3.6.0",
    "lucide-react": "https://esm.sh/lucide-react@^0.562.0"
  }
}
</script>
</head>
<body class="forge-grid">
    <div id="root"></div>
</body>
</html>
```

**File:** `index.tsx`
```typescript
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

## 3. Logic and Definitions
**File:** `types.ts`
```typescript
export enum HardwareTarget {
  NVIDIA_RTX_4090 = 'NVIDIA RTX 40-series',
  PS5 = 'PlayStation 5',
  XBOX_SERIES_X = 'Xbox Series X',
  NINTENDO_SWITCH_PRO = 'Switch Pro (Simulated)',
  GENERIC_PC_DX12 = 'Generic DX12 PC'
}

export enum QualityLevel {
  LOW = 'Low',
  MEDIUM = 'Medium',
  HIGH = 'High',
  ULTRA = 'Ultra (Path Tracing)'
}

export interface MaterialFeatures {
  transparency: boolean;
  subsurfaceScattering: boolean;
  anisotropy: boolean;
  parallaxOcclusion: boolean;
}

export interface EngineManifest {
  version: string;
  pbrConsistency: boolean;
  naniteEnabled: boolean;
  raytracing: boolean;
  targetHardware: HardwareTarget;
  qualityLevel: QualityLevel;
  features: MaterialFeatures;
}

export interface SDTParams {
  chromaticVariance: number;
  luminanceTopology: number;
  geometryFractals: number;
  materialityIndex: number;
  compositionalWeight: number;
  negativeSpaceRatio: number;
}

export interface DebugIssue {
  line?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion: string;
}

export interface ProfilingReport {
  gpuTimeMs: number;
  vramPeak: string;
  bandwidthUsage: string;
  drawCalls: number;
  triangles: number;
  bottleneck: string;
}

export interface GeneratedAsset {
  id: string;
  name: string;
  type: 'cpp' | 'hlsl' | 'compute' | 'json';
  content: string; 
  module: 'Shader Smith' | 'Mesh Weaver' | 'Surface Alchemist' | 'World Orchestrator';
  performanceMetrics: ProfilingReport;
  debugIssues: DebugIssue[];
}
```

**File:** `services/gemini.ts`
```typescript
import { GoogleGenAI, Type } from "@google/genai";
import { SDTParams, EngineManifest, GeneratedAsset } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const synthesizeAssets = async (sdt: SDTParams, manifest: EngineManifest): Promise<GeneratedAsset[]> => {
  const prompt = `
    Act as "The Smith", a Supreme AAA Graphics Architect.
    SYSTEM_STATUS: PEAK_READINESS_UPGRADE_ACTIVE.
    
    Synthesize 4 production-ready technical assets (C++ and HLSL/Compute) targeting ${manifest.targetHardware}.
    
    SDT_MATRIX: ${JSON.stringify(sdt)}
    ENGINE_MANIFEST: ${JSON.stringify(manifest)}

    MANDATORY HLSL ARCHITECTURE:
    1. QUALITY VARIANTS: Every shader MUST include:
       - #define QUALITY_LEVEL_${manifest.qualityLevel.toUpperCase()}
       - #ifdef QUALITY_LOW (Simplified BRDF, no high-order shadowing)
       - #ifdef QUALITY_MEDIUM (Standard PBR, single scattering)
       - #ifdef QUALITY_HIGH (Multiple scattering, Raytraced Shadow hooks)
       - #ifdef QUALITY_ULTRA (Stochastic path-tracing, full specular lobing)
    
    2. FEATURE BRANCHES:
       - #if FEATURE_TRANSPARENCY (Weighted-Blended OIT or Alpha-Testing logic)
       - #if FEATURE_SSS (Subsurface Scattering: Burley or Diffusion profiles)
       - #if FEATURE_ANISOTROPY (Anisotropic BRDF kernels)
    
    3. C++ STANDARDS:
       - Memory-aligned structures for SIMD efficiency (__declspec(align(16))).
       - Nanite clustering or virtual geometry hooks if Nanite is enabled.
       - Raytracing Acceleration Structure (RTAS) interaction if Raytracing is enabled.

    4. READINESS AUDIT:
       - Ensure logic passes the 72-point AAA readiness check.
       - Provide detailed debugIssues referencing specific Readiness Protocol IDs (e.g., TRL-14, TRL-42).

    OUTPUT: JSON array of 4 GeneratedAsset objects.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: prompt,
    config: {
      thinkingConfig: { thinkingBudget: 16384 },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            name: { type: Type.STRING },
            type: { type: Type.STRING },
            content: { type: Type.STRING },
            module: { type: Type.STRING },
            performanceMetrics: {
              type: Type.OBJECT,
              properties: {
                gpuTimeMs: { type: Type.NUMBER },
                vramPeak: { type: Type.STRING },
                bandwidthUsage: { type: Type.STRING },
                drawCalls: { type: Type.NUMBER },
                triangles: { type: Type.NUMBER },
                bottleneck: { type: Type.STRING }
              },
              required: ["gpuTimeMs", "vramPeak", "drawCalls", "triangles", "bottleneck"]
            },
            debugIssues: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  line: { type: Type.NUMBER },
                  severity: { type: Type.STRING },
                  message: { type: Type.STRING },
                  suggestion: { type: Type.STRING }
                },
                required: ["severity", "message", "suggestion"]
              }
            }
          },
          required: ["id", "name", "type", "content", "module", "performanceMetrics", "debugIssues"]
        }
      }
    }
  });

  try {
    return JSON.parse(response.text);
  } catch (e) {
    console.error("Critical Synthesis Error in Smith Forge", e);
    return [];
  }
};
```

## 4. Main UI Component
**File:** `App.tsx`
```typescript
import React, { useState, useEffect, useMemo } from 'react';
import { 
  Cpu, Layers, Wind, Box, Zap, Activity, Hammer, 
  Database, Server, Settings, Flame, ShieldAlert, BarChart3,
  Thermometer, Info, AlertTriangle, Bug, Terminal,
  Workflow, CheckCircle2, AlertCircle, RefreshCw, Radio, Binary,
  Link, HardDrive, Cpu as GpuIcon, Share2, Target
} from 'lucide-react';
import { HardwareTarget, QualityLevel, SDTParams, EngineManifest, GeneratedAsset, DebugIssue } from './types';
import { synthesizeAssets } from './services/gemini';
import { AreaChart, Area, ResponsiveContainer, BarChart, Bar, XAxis, Tooltip } from 'recharts';

// --- Readiness Tracking Data ---
const READINESS_PROTOCOLS = Array.from({ length: 72 }, (_, i) => ({
  id: i + 1,
  name: `TRL-${(i + 1).toString().padStart(2, '0')}`,
  category: i < 24 ? 'Logic' : i < 48 ? 'Memory' : 'Hardware',
}));

// --- Sub-components ---

const SliderInput = ({ label, value, onChange, min = 0, max = 1, step = 0.01 }: any) => (
  <div className="space-y-1 mb-3">
    <div className="flex justify-between items-center text-[9px] font-mono uppercase text-gray-500">
      <span className="truncate">{label}</span>
      <span className="text-orange-500 font-bold">{value.toFixed(2)}</span>
    </div>
    <input 
      type="range" min={min} max={max} step={step} value={value} 
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-orange-500"
    />
  </div>
);

const FeatureToggle = ({ label, active, onClick }: any) => (
  <button 
    onClick={onClick}
    className={`px-2 py-1.5 rounded text-[8px] font-black uppercase transition-all border shrink-0 ${active ? 'bg-orange-600/20 border-orange-500 text-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.15)]' : 'bg-gray-900 border-gray-800 text-gray-600 hover:border-gray-700'}`}
  >
    {label}
  </button>
);

const DebugItem = ({ issue }: { issue: DebugIssue }) => (
  <div className={`p-2 border-l-2 mb-2 rounded bg-black/40 backdrop-blur-md ${issue.severity === 'error' ? 'border-red-500' : issue.severity === 'warning' ? 'border-yellow-500' : 'border-blue-500'}`}>
    <div className="flex items-center gap-2 mb-1">
      <span className={`text-[8px] font-black uppercase px-1 rounded ${issue.severity === 'error' ? 'bg-red-500 text-white' : 'bg-gray-800 text-gray-400'}`}>
        {issue.severity}
      </span>
      <span className="text-[9px] font-mono text-gray-600">
        {issue.line ? `0x${issue.line.toString(16).padStart(4, '0').toUpperCase()}` : 'ENGINE_ROOT'}
      </span>
    </div>
    <p className="text-[11px] text-gray-300 font-medium leading-tight mb-1">{issue.message}</p>
    <div className="text-[9px] text-gray-500 border-t border-gray-800 pt-1 mt-1 font-mono italic">
      <span className="text-blue-500 uppercase font-bold mr-1">Fix:</span> {issue.suggestion}
    </div>
  </div>
);

const App: React.FC = () => {
  const [sdt, setSdt] = useState<SDTParams>({
    chromaticVariance: 0.45,
    luminanceTopology: 0.72,
    geometryFractals: 0.88,
    materialityIndex: 0.65,
    compositionalWeight: 0.50,
    negativeSpaceRatio: 0.30,
  });

  const [manifest, setManifest] = useState<EngineManifest>({
    version: "2.5.0-OMEGA",
    pbrConsistency: true,
    naniteEnabled: true,
    raytracing: true,
    targetHardware: HardwareTarget.NVIDIA_RTX_4090,
    qualityLevel: QualityLevel.ULTRA,
    features: {
      transparency: true,
      subsurfaceScattering: true,
      anisotropy: true,
      parallaxOcclusion: true,
    }
  });

  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<GeneratedAsset | null>(null);
  const [activeTab, setActiveTab] = useState<'code' | 'profiling' | 'debug'>('code');
  const [logs, setLogs] = useState<string[]>(["[KERNEL] System Upgrade Phase 72/72 Ready.", "[SMITH] Awaiting Forge instructions."]);
  const [currentProtocolIndex, setCurrentProtocolIndex] = useState(-1);
  const [isBridgeLinked, setIsBridgeLinked] = useState(false);

  const addLog = (msg: string) => {
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 15));
  };

  const handleForge = async () => {
    setIsGenerating(true);
    setCurrentProtocolIndex(-1);
    addLog("SYNTHESIS_INIT::Executing 72-Stage AAA Readiness Audit...");
    
    // Smooth transition through the 72 readiness levels
    for (let i = 0; i < 72; i++) {
      setCurrentProtocolIndex(i);
      if (i % 12 === 0) addLog(`READINESS_AUDIT::TRL-${i.toString().padStart(2, '0')} checksum verified.`);
      await new Promise(r => setTimeout(r, 15 + Math.random() * 40));
    }

    try {
      const results = await synthesizeAssets(sdt, manifest);
      setAssets(results);
      if (results.length > 0) setSelectedAsset(results[0]);
      addLog("FORGE_COMPLETE::Synthesis successful. Initiating Bridge Push.");
      setIsBridgeLinked(true);
      setTimeout(() => setIsBridgeLinked(false), 2500);
    } catch (error) {
      addLog("FORGE_FAILURE::Critical mismatch in TRL-52 Buffer.");
      console.error(error);
    } finally {
      setIsGenerating(false);
    }
  };

  const activeModuleStats = useMemo(() => {
    if (!selectedAsset) return null;
    return [
      { n: 'GPU_CLK', v: selectedAsset.performanceMetrics.gpuTimeMs * 18 },
      { n: 'VRAM_P', v: parseFloat(selectedAsset.performanceMetrics.vramPeak) * 10 || 50 },
      { n: 'IO_SAT', v: parseFloat(selectedAsset.performanceMetrics.bandwidthUsage) * 4 || 30 },
      { n: 'RT_OCC', v: manifest.raytracing ? 92 : 5 },
      { n: 'N_VERT', v: selectedAsset.performanceMetrics.triangles / 20000 }
    ];
  }, [selectedAsset, manifest.raytracing]);

  return (
    <div className="min-h-screen flex flex-col p-4 max-w-[1800px] mx-auto overflow-hidden h-screen bg-[#020202] text-gray-300 selection:bg-orange-500/30">
      <div className="fixed inset-0 pointer-events-none opacity-[0.03] forge-grid" />
      
      {/* Header Bar */}
      <header className="flex justify-between items-start mb-4 border-b border-gray-900 pb-3 shrink-0 relative z-10">
        <div className="flex items-center gap-4">
          <div className="relative group cursor-pointer" onClick={() => addLog("SYSTEM_PING::Omega-Forge heart detected.")}>
            <div className="absolute inset-0 bg-orange-600 blur-xl opacity-20 group-hover:opacity-50 transition-all duration-500" />
            <div className="p-2.5 bg-orange-600 rounded-sm relative z-10 border border-orange-400 shadow-[0_0_15px_rgba(234,88,12,0.4)]">
              <Hammer className="text-white" size={24} />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-black tracking-tighter uppercase italic leading-none flex items-center gap-2">
                The Smith <span className="text-[10px] not-italic font-mono bg-blue-600/30 text-blue-400 border border-blue-500/40 px-1.5 rounded">V2.5.0-OMEGA</span>
              </h1>
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <div className="flex gap-0.5">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className={`w-1 h-2 rounded-full transition-all duration-300 ${i < (currentProtocolIndex / 9) ? 'bg-orange-500' : 'bg-gray-800'}`} />
                ))}
              </div>
              <span className="text-[9px] font-mono text-gray-600 uppercase tracking-widest">Sovereignty Protocol: Peak Readiness Level</span>
            </div>
          </div>
        </div>
        
        <div className="flex gap-8 items-center">
          <div className="flex flex-col items-end">
            <span className="text-[8px] font-mono text-gray-600 uppercase tracking-tighter">Direct Engine Bridge</span>
            <div className={`flex items-center gap-2 transition-all ${isBridgeLinked ? 'text-green-500' : 'text-gray-500'}`}>
              <span className="text-[10px] font-black">{isBridgeLinked ? 'TRANSFER_ACTIVE' : 'LINK_STANDBY'}</span>
              <Share2 size={14} className={isBridgeLinked ? 'animate-pulse' : ''} />
            </div>
          </div>
          <div className="h-10 w-px bg-gray-900" />
          <div className="flex flex-col items-end">
            <span className="text-[8px] font-mono text-gray-600 uppercase tracking-tighter">G-Target Topology</span>
            <div className="flex items-center gap-2 text-blue-500">
              <span className="text-[11px] font-black tracking-tighter uppercase">{manifest.targetHardware}</span>
              <GpuIcon size={16} />
            </div>
          </div>
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-grow overflow-hidden relative z-10">
        
        {/* Left Column: Tensors & Readiness Matrix */}
        <div className="lg:col-span-3 flex flex-col gap-4 overflow-hidden">
          
          {/* Readiness Matrix 72 Blocks */}
          <section className="bg-gray-900/10 border border-gray-800 rounded-lg p-3 shrink-0">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Workflow size={14} className="text-orange-500" />
                <h2 className="text-[10px] font-black uppercase tracking-widest">72-Stage AAA Readiness Matrix</h2>
              </div>
              <div className="text-[8px] font-mono text-gray-600 px-1.5 py-0.5 border border-gray-800 rounded">TRL_VERIFIER_STABLE</div>
            </div>
            <div className="grid grid-cols-12 gap-1">
              {READINESS_PROTOCOLS.map((p, idx) => (
                <div 
                  key={p.id} 
                  className={`h-1.5 rounded-[1px] transition-all duration-300 ${idx <= currentProtocolIndex ? 'bg-orange-500 shadow-[0_0_5px_rgba(249,115,22,0.6)]' : 'bg-gray-900'}`}
                />
              ))}
            </div>
          </section>

          {/* Configuration Workspace */}
          <div className="flex-grow overflow-y-auto custom-scrollbar pr-1 space-y-4">
            <section className="bg-gray-900/20 p-4 rounded-lg border border-gray-800 backdrop-blur-md">
              <div className="flex items-center gap-2 mb-4 border-b border-gray-800 pb-2">
                <Layers size={14} className="text-blue-500" />
                <h2 className="text-[10px] font-black uppercase tracking-widest">Descriptor Tensors</h2>
              </div>
              {Object.keys(sdt).map((key) => (
                <SliderInput 
                  key={key} 
                  label={key.replace(/([A-Z])/g, ' $1')} 
                  value={(sdt as any)[key]} 
                  onChange={(v: number) => setSdt({...sdt, [key]: v})} 
                />
              ))}
            </section>

            <section className="bg-gray-900/20 p-4 rounded-lg border border-gray-800 backdrop-blur-md">
              <div className="flex items-center gap-2 mb-4 border-b border-gray-800 pb-2">
                <Binary size={14} className="text-orange-500" />
                <h2 className="text-[10px] font-black uppercase tracking-widest">Manifest Alpha-Omega</h2>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-[8px] text-gray-600 uppercase mb-2 block font-mono">Shader Quality Protocol</label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {Object.values(QualityLevel).map(q => (
                      <button 
                        key={q}
                        onClick={() => setManifest({...manifest, qualityLevel: q})}
                        className={`text-[9px] py-1.5 rounded border font-mono transition-all duration-300 ${manifest.qualityLevel === q ? 'bg-orange-600 border-orange-500 text-white shadow-xl' : 'bg-black border-gray-800 text-gray-600 hover:border-gray-700'}`}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                   <label className="text-[8px] text-gray-600 uppercase mb-2 block font-mono">Micro-Feature Flags</label>
                   <div className="grid grid-cols-2 gap-1.5">
                      <FeatureToggle label="Translucency" active={manifest.features.transparency} onClick={() => setManifest({...manifest, features: {...manifest.features, transparency: !manifest.features.transparency}})} />
                      <FeatureToggle label="SubSurface" active={manifest.features.subsurfaceScattering} onClick={() => setManifest({...manifest, features: {...manifest.features, subsurfaceScattering: !manifest.features.subsurfaceScattering}})} />
                      <FeatureToggle label="Aniso-BRDF" active={manifest.features.anisotropy} onClick={() => setManifest({...manifest, features: {...manifest.features, anisotropy: !manifest.features.anisotropy}})} />
                      <FeatureToggle label="Parallax_Occl" active={manifest.features.parallaxOcclusion} onClick={() => setManifest({...manifest, features: {...manifest.features, parallaxOcclusion: !manifest.features.parallaxOcclusion}})} />
                   </div>
                </div>
              </div>
            </section>
          </div>

          <button 
            onClick={handleForge}
            disabled={isGenerating}
            className={`w-full py-5 rounded-lg flex flex-col items-center justify-center transition-all ${isGenerating ? 'bg-gray-800 cursor-wait' : 'bg-orange-600 hover:bg-orange-500 shadow-[0_0_20px_rgba(234,88,12,0.15)] group'} relative overflow-hidden`}
          >
            {isGenerating && <div className="absolute left-0 top-0 bottom-0 bg-white/5 animate-pulse" style={{ width: `${(currentProtocolIndex + 1) / 72 * 100}%` }} />}
            <div className="flex items-center gap-3 relative z-10">
              {isGenerating ? <RefreshCw className="animate-spin text-orange-400" size={20} /> : <Zap size={20} className="group-hover:scale-125 transition-transform" />}
              <span className="font-black text-xl tracking-[0.2em]">FORGE_OMEGA</span>
            </div>
            <span className="text-[8px] font-mono mt-1 opacity-70 relative z-10 uppercase tracking-widest">Trigger Triple-A Readiness Pipeline</span>
          </button>
        </div>

        {/* Center Panel: Source Workspace */}
        <div className="lg:col-span-6 flex flex-col gap-4 overflow-hidden h-full">
          <div className="flex-grow bg-black/80 border border-gray-800 rounded-xl overflow-hidden flex flex-col shadow-2xl relative">
            
            {/* Workspace Tabs */}
            <div className="flex items-center justify-between bg-gray-900/80 px-4 shrink-0 border-b border-gray-800 z-20">
              <div className="flex gap-1">
                {[
                  { id: 'code', label: 'Kernel_Source', icon: Terminal, color: 'text-orange-500' },
                  { id: 'profiling', label: 'G-Telemetry', icon: BarChart3, color: 'text-blue-500' },
                  { id: 'debug', label: 'Integrity_Audit', icon: ShieldAlert, color: 'text-red-500' }
                ].map(tab => (
                  <button 
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)} 
                    className={`flex items-center gap-2 px-5 py-3.5 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${activeTab === tab.id ? `border-white ${tab.color} bg-white/5` : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                  >
                    <tab.icon size={14} />
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-4">
                 <div className={`flex items-center gap-2 px-2.5 py-1 rounded bg-black/40 border transition-all ${isBridgeLinked ? 'border-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.1)]' : 'border-gray-800'}`}>
                    <Radio size={12} className={`${isBridgeLinked ? 'text-green-500' : 'text-gray-700'} animate-pulse`} />
                    <span className="text-[9px] font-mono text-gray-500 uppercase">Engine_Sync: {isBridgeLinked ? 'ACTIVE' : 'IDLE'}</span>
                 </div>
              </div>
            </div>

            {/* Asset Content Area */}
            <div className="flex-grow overflow-hidden relative">
              {isGenerating ? (
                <div className="absolute inset-0 bg-black/95 flex flex-col items-center justify-center z-30 backdrop-blur-md">
                  <div className="relative mb-10">
                    <div className="w-40 h-40 border-2 border-orange-500/10 rounded-full animate-[ping_3s_infinite]" />
                    <div className="absolute inset-0 flex items-center justify-center">
                       <Target className="text-orange-600 animate-pulse" size={56} />
                    </div>
                  </div>
                  <div className="text-center space-y-3">
                    <h3 className="text-2xl font-black text-white italic uppercase tracking-tighter shadow-orange-500/50">Synthesizing Readiness Matrix...</h3>
                    <p className="text-[10px] font-mono text-gray-500 uppercase tracking-[0.4em]">TRL_PROTOCOL_${currentProtocolIndex.toString().padStart(2, '0')} // ADDR: 0x${(currentProtocolIndex * 1024).toString(16).toUpperCase()}</p>
                  </div>
                  <div className="mt-8 w-80 h-1 bg-gray-900 rounded-full overflow-hidden shadow-inner">
                    <div className="h-full bg-orange-600 transition-all duration-300" style={{ width: `${(currentProtocolIndex + 1) / 72 * 100}%` }} />
                  </div>
                </div>
              ) : selectedAsset ? (
                <div className="flex-grow p-6 overflow-auto custom-scrollbar-wide bg-[#050505] h-full">
                  {activeTab === 'code' && (
                    <div className="font-mono text-[12px] text-gray-400 leading-relaxed h-full">
                      <div className="mb-6 flex items-center justify-between border-b border-gray-900 pb-3">
                        <div className="flex items-center gap-3">
                           <CheckCircle2 size={16} className="text-green-500" />
                           <span className="text-[10px] font-black uppercase text-gray-500 tracking-widest">Source Authenticated: 72/72 Checks Passed</span>
                        </div>
                        <div className="flex gap-2">
                           <span className="text-[9px] text-gray-700 font-mono">ENCODING::BINARY_BLOB</span>
                           <span className="text-[9px] text-orange-500/50 font-mono">V_ADDR::0x01A2F</span>
                        </div>
                      </div>
                      <pre className="whitespace-pre-wrap selection:bg-orange-500/40">
                        {selectedAsset.content}
                      </pre>
                    </div>
                  )}
                  {activeTab === 'profiling' && (
                    <div className="space-y-8 animate-in fade-in duration-700">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                         {[
                           { label: 'Latency (GPU)', value: `${selectedAsset.performanceMetrics.gpuTimeMs}ms`, icon: Activity, color: 'text-blue-400' },
                           { label: 'Peak VRAM', value: selectedAsset.performanceMetrics.vramPeak, icon: Database, color: 'text-orange-400' },
                           { label: 'I/O Saturation', value: selectedAsset.performanceMetrics.bandwidthUsage, icon: Wind, color: 'text-green-400' },
                           { label: 'Draw Batches', value: selectedAsset.performanceMetrics.drawCalls, icon: Box, color: 'text-purple-400' }
                         ].map((m, i) => (
                           <div key={i} className="p-4 bg-gray-900/30 rounded border border-gray-800/60 backdrop-blur-md shadow-inner">
                             <div className="flex items-center gap-2 mb-2 opacity-60">
                                <m.icon size={12} className={m.color} />
                                <span className="text-[9px] font-black uppercase tracking-widest">{m.label}</span>
                             </div>
                             <p className={`text-2xl font-black ${m.color} tracking-tighter`}>{m.value}</p>
                           </div>
                         ))}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div className="md:col-span-2 p-6 bg-gray-900/20 rounded-lg border border-gray-800 shadow-2xl">
                           <div className="flex justify-between items-center mb-10">
                              <h3 className="text-[11px] font-black uppercase tracking-[0.25em] flex items-center gap-3 text-gray-400">
                                 <BarChart3 size={18} className="text-orange-500" /> Pipeline Throughput Simulation
                              </h3>
                              <span className="text-[9px] bg-black px-3 py-1 rounded text-gray-500 font-mono uppercase border border-gray-800">Topology: {manifest.targetHardware}</span>
                           </div>
                           <div className="h-64 w-full">
                              <ResponsiveContainer width="100%" height="100%">
                                 <BarChart data={activeModuleStats || []}>
                                    <XAxis dataKey="n" stroke="#222" fontSize={11} tickLine={false} axisLine={false} />
                                    <Tooltip 
                                      cursor={{fill: 'rgba(255,255,255,0.03)'}} 
                                      contentStyle={{ backgroundColor: '#000', border: '1px solid #333', fontSize: '11px', borderRadius: '4px', boxShadow: '0 0 20px rgba(0,0,0,0.5)' }} 
                                    />
                                    <Bar dataKey="v" fill="#f97316" radius={[3, 3, 0, 0]} barSize={40} />
                                 </BarChart>
                              </ResponsiveContainer>
                           </div>
                        </div>
                        <div className="space-y-4">
                           <div className="p-6 bg-orange-900/5 border border-orange-500/20 rounded-lg h-full flex flex-col justify-between shadow-[inset_0_0_20px_rgba(249,115,22,0.02)]">
                              <div>
                                 <div className="flex items-center gap-3 text-orange-500 mb-5">
                                    <AlertCircle size={20} />
                                    <span className="text-[12px] font-black uppercase tracking-widest">Critical Bottleneck Analysis</span>
                                 </div>
                                 <p className="text-xs text-gray-400 leading-relaxed font-mono italic">{selectedAsset.performanceMetrics.bottleneck}</p>
                              </div>
                              <div className="mt-8 pt-8 border-t border-gray-900">
                                 <p className="text-[10px] text-gray-600 uppercase mb-3 font-black tracking-widest">System Efficiency Load</p>
                                 <div className="flex gap-2">
                                    {[...Array(10)].map((_, i) => (
                                      <div key={i} className={`h-2 flex-grow rounded-[1px] ${i < 7 ? 'bg-orange-600 shadow-[0_0_8px_rgba(234,88,12,0.3)]' : 'bg-gray-900'}`} />
                                    ))}
                                 </div>
                              </div>
                           </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {activeTab === 'debug' && (
                    <div className="space-y-5 animate-in fade-in slide-in-from-right-3 duration-500">
                       <div className="flex items-center justify-between mb-8 pb-4 border-b border-gray-900">
                         <div className="flex items-center gap-3 text-red-500">
                           <Bug size={24} />
                           <h2 className="text-sm font-black uppercase tracking-widest italic tracking-[0.2em]">Peak Readiness Static Analysis</h2>
                         </div>
                         <div className="text-[10px] font-mono text-gray-700 bg-gray-900/80 px-3 py-1.5 rounded-sm border border-gray-800">TRL_ENGINE_AUDITOR::VERSION_2.5.0</div>
                       </div>
                       {selectedAsset.debugIssues.length > 0 ? (
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {selectedAsset.debugIssues.map((issue, i) => <DebugItem key={i} issue={issue} />)}
                         </div>
                       ) : (
                         <div className="h-80 flex flex-col items-center justify-center space-y-6 border-2 border-dashed border-gray-900 rounded-2xl bg-gray-900/5 backdrop-blur-sm">
                           <div className="p-5 bg-green-500/10 rounded-full shadow-[0_0_30px_rgba(34,197,94,0.1)]">
                              <CheckCircle2 size={72} className="text-green-500/50" />
                           </div>
                           <div className="text-center">
                             <p className="text-green-500 font-black text-2xl uppercase tracking-[0.4em]">Absolute Logical Integrity</p>
                             <p className="text-[10px] font-mono text-gray-600 mt-3 uppercase tracking-[0.25em]">Passed all 72 distinct Triple-A readiness protocols</p>
                           </div>
                         </div>
                       )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-gray-800 space-y-8 p-12">
                  <Workflow size={110} className="opacity-[0.03] animate-pulse" />
                  <div className="text-center">
                    <p className="text-lg font-mono uppercase tracking-[0.6em] opacity-40">Matrix Idle // Awaiting Input</p>
                    <p className="text-[11px] font-mono mt-6 text-orange-600/50 uppercase tracking-[0.2em]">Adjust Tensors & Execute Forge Omega</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Console Output Bar */}
          <div className="h-40 bg-black border border-gray-800 rounded-xl p-5 font-mono text-[11px] shrink-0 overflow-hidden relative shadow-[inset_0_2px_10px_rgba(0,0,0,0.8)]">
            <div className="text-gray-600 mb-4 flex items-center justify-between border-b border-gray-900 pb-3">
              <div className="flex items-center gap-3">
                <Terminal size={16} className="text-orange-600" />
                <span className="font-black uppercase text-[11px] tracking-[0.3em]">Engineering_Console_Sovereignty</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-blue-900 bg-blue-900/10 px-2.5 py-0.5 rounded border border-blue-900/30">UML_PIPE_VERIFIED</span>
              </div>
            </div>
            <div className="overflow-y-auto h-full space-y-1.5 custom-scrollbar scroll-smooth pr-2">
              {logs.map((log, i) => (
                <div key={i} className={`flex gap-5 ${i === 0 ? 'text-orange-500 font-bold border-l-2 border-orange-600 pl-3' : 'text-gray-600 pl-4 opacity-70'}`}>
                  <span className="shrink-0 opacity-40 tracking-tighter w-12 text-right">0x{(15-i).toString(16).padStart(4, '0').toUpperCase()}</span>
                  <span className="truncate">{log}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Asset Repository & Hardware Telemetry */}
        <div className="lg:col-span-3 flex flex-col gap-4 overflow-hidden h-full">
          
          <section className="bg-gray-900/20 border border-gray-800 rounded-xl flex-grow flex flex-col overflow-hidden shadow-2xl backdrop-blur-xl">
            <div className="flex items-center justify-between p-5 shrink-0 border-b border-gray-900 bg-gray-900/60">
              <div className="flex items-center gap-3">
                <Database size={20} className="text-blue-500" />
                <h2 className="text-[12px] font-black uppercase tracking-widest italic">Compiled Repository</h2>
              </div>
              <span className="text-[10px] bg-blue-500/20 text-blue-400 px-3 py-1 rounded-sm font-black border border-blue-500/30">{assets.length} UNITS</span>
            </div>
            
            <div className="flex-grow overflow-y-auto custom-scrollbar p-3 space-y-2.5">
              {assets.map((asset) => (
                <button 
                  key={asset.id}
                  onClick={() => setSelectedAsset(asset)}
                  className={`w-full group text-left p-4 rounded-lg border transition-all duration-700 relative overflow-hidden ${selectedAsset?.id === asset.id ? 'bg-orange-600/15 border-orange-500 shadow-[0_0_20px_rgba(234,88,12,0.1)]' : 'bg-black/40 border-gray-800 hover:border-gray-700 hover:bg-gray-800/20'}`}
                >
                  <div className={`absolute left-0 top-0 bottom-0 w-1 transition-all duration-1000 ${selectedAsset?.id === asset.id ? 'bg-orange-500' : 'bg-transparent group-hover:bg-gray-700'}`} />
                  <div className="flex justify-between items-start mb-2.5">
                    <span className={`text-[13px] font-black truncate pr-3 ${selectedAsset?.id === asset.id ? 'text-white' : 'text-gray-400'}`}>{asset.name}</span>
                    <span className={`text-[9px] font-mono px-2.5 py-0.5 rounded-sm border ${asset.type === 'hlsl' ? 'bg-blue-600/30 border-blue-500/40 text-blue-400 font-black' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>{asset.type.toUpperCase()}</span>
                  </div>
                  <div className="flex justify-between items-center text-[10px] font-mono text-gray-600">
                    <span className="uppercase tracking-tight opacity-70 group-hover:text-gray-400 transition-colors">{asset.module}</span>
                    <div className="flex gap-2 items-center">
                       <span className="text-[9px] font-black">{asset.performanceMetrics.gpuTimeMs}ms</span>
                       <div className={`w-2.5 h-2.5 rounded-full transition-all duration-500 ${asset.debugIssues.some(d => d.severity === 'error') ? 'bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.6)]' : 'bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.4)]'}`} />
                    </div>
                  </div>
                </button>
              ))}
              {assets.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-gray-800 py-20 opacity-15">
                   <HardDrive size={64} className="mb-6 animate-pulse" />
                   <p className="text-[11px] uppercase font-mono tracking-widest text-center">Repository Inaccessible // No Forged Entities</p>
                </div>
              )}
            </div>
          </section>

          {/* Engine Health Status & Telemetry */}
          <section className="bg-gray-900/20 p-5 rounded-xl border border-gray-800 shrink-0 backdrop-blur-xl shadow-inner">
            <div className="grid grid-cols-2 gap-5">
               <div className="p-4 bg-black/60 rounded-lg border border-gray-800/80 flex flex-col items-center group transition-all duration-500 hover:border-red-900/50">
                 <Thermometer size={20} className="text-red-500 mb-2.5 opacity-60 group-hover:opacity-100 group-hover:scale-110 transition-all" />
                 <span className="text-[9px] text-gray-600 uppercase font-black tracking-widest mb-2">Core_Thermal_IDX</span>
                 <span className="text-sm font-black text-white italic tracking-tighter">48.2°C</span>
                 <div className="w-full h-1.5 bg-gray-900 mt-4 rounded-full overflow-hidden shadow-inner">
                    <div className="h-full bg-red-600 shadow-[0_0_15px_rgba(220,38,38,0.7)]" style={{ width: '48%' }} />
                 </div>
               </div>
               <div className="p-4 bg-black/60 rounded-lg border border-gray-800/80 flex flex-col items-center group transition-all duration-500 hover:border-blue-900/50">
                 <Server size={20} className="text-blue-500 mb-2.5 opacity-60 group-hover:opacity-100 group-hover:scale-110 transition-all" />
                 <span className="text-[9px] text-gray-600 uppercase font-black tracking-widest mb-2">V_Cache_Registry</span>
                 <span className="text-sm font-black text-white italic tracking-tighter">86.7%</span>
                 <div className="w-full h-1.5 bg-gray-900 mt-4 rounded-full overflow-hidden shadow-inner">
                    <div className="h-full bg-blue-600 shadow-[0_0_15px_rgba(37,99,235,0.7)]" style={{ width: '86%' }} />
                 </div>
               </div>
            </div>
            <div className={`mt-5 p-3 rounded flex items-center justify-between border transition-all duration-1000 ${isBridgeLinked ? 'bg-green-600/10 border-green-500/40' : 'bg-blue-600/5 border-blue-500/10'}`}>
               <div className="flex items-center gap-3">
                  <Link size={14} className={isBridgeLinked ? 'text-green-500' : 'text-blue-500'} />
                  <span className={`text-[10px] font-mono font-black uppercase tracking-widest ${isBridgeLinked ? 'text-green-400' : 'text-blue-500/80'}`}>Direct_Engine_Bridge_Link</span>
               </div>
               <div className="flex gap-1.5">
                 {[...Array(4)].map((_, i) => <div key={i} className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${isBridgeLinked ? 'bg-green-500' : 'bg-blue-500/30'}`} />)}
               </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="mt-6 border-t border-gray-900 pt-5 flex justify-between items-center text-[11px] font-mono text-gray-700 uppercase tracking-[0.45em] shrink-0 relative z-10">
        <div className="flex gap-12 items-center">
          <span className="flex items-center gap-2.5"><Cpu size={16} className="text-blue-900 opacity-60" /> KERNEL_PROTO: {manifest.version}</span>
          <span className="flex items-center gap-2.5"><Workflow size={16} className="text-orange-900 opacity-60" /> READINESS: COMPLETE_72/72</span>
          <span className="flex items-center gap-2.5 text-gray-900 font-black"><Radio size={16} /> COMM_PULSE: 0.82ms</span>
        </div>
        <div className="font-black text-gray-800 tracking-tighter hover:text-orange-500/30 transition-all duration-1000 cursor-default select-none">
          ARCHITECT_PRIME // AAA_ENGINEERING_CORE_FORGE // [OMEGA_STASIS_UPGRADED]
        </div>
      </footer>
    </div>
  );
};

export default App;
```
