# OMEGA_MUSE SYSTEM SOURCE CODE ARCHIVE
Version: 4.0.Alpha-72 // AAA Peak Performance Refinement
Archival Date: 2124.AESTHETIC.SOVEREIGNTY

---

## [metadata.json]
```json
{
  "name": "Omega Muse: Creative Director Agent",
  "description": "A high-fidelity Creative Director Agent that deconstructs visual references into Style Descriptor Tensors (SDT) and maps them to technical engine parameters for aesthetic coherence.",
  "requestFramePermissions": [
    "camera"
  ]
}
```

---

## [index.html]
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Omega Muse - Aesthetic Sovereignty</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Space+Grotesk', sans-serif;
            background-color: #050505;
            color: #e5e7eb;
            overflow-x: hidden;
        }
        .mono {
            font-family: 'JetBrains Mono', monospace;
        }
        .glass {
            background: rgba(255, 255, 255, 0.03);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .glow-accent {
            box-shadow: 0 0 20px rgba(139, 92, 246, 0.3);
        }
        @keyframes pulse-slow {
            0%, 100% { opacity: 0.3; }
            50% { opacity: 0.7; }
        }
        .pulse-overlay {
            animation: pulse-slow 4s infinite ease-in-out;
        }
    </style>
<script type="importmap">
{
  "imports": {
    "@google/genai": "https://esm.sh/@google/genai@^1.35.0",
    "react-dom/": "https://esm.sh/react-dom@^19.2.3/",
    "react/": "https://esm.sh/react@^19.2.3/",
    "react": "https://esm.sh/react@^19.2.3",
    "recharts": "https://esm.sh/recharts@^3.6.0"
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

## [index.tsx]
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

---

## [App.tsx]
```typescript
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { StyleDescriptorTensor, EngineManifest, AestheticAuditResult, AestheticSession, AestheticBranch } from './types';
import { deconstructStyle, verifyAssetIntegrity, mutateAesthetic, simulateRealityPreview } from './services/geminiService';
import { ResonanceVisualizer } from './components/ResonanceVisualizer';
import { EngineManifestCard } from './components/EngineManifestCard';

const App: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<AestheticSession | null>(null);
  const [refImage, setRefImage] = useState<string | null>(null);
  
  // Terminal Logic
  const [terminalOutput, setTerminalOutput] = useState<string[]>(['[SYSTEM_BOOT]: INITIALIZING OMEGA_MUSE_V4.0...']);
  const [isSimulating, setIsSimulating] = useState(false);

  // Audit Logic
  const [auditQuery, setAuditQuery] = useState('');
  const [auditing, setAuditing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const activeBranch = useMemo(() => {
    if (!session) return null;
    return session.branches.find(b => b.id === session.activeBranchId) || session.baselineBranch;
  }, [session]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalOutput]);

  const log = (msg: string) => setTerminalOutput(prev => [...prev, `[${new Date().toLocaleTimeString()}]: ${msg}`].slice(-20));

  const handleDeconstruct = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    log(`INGESTING REFERENCE_DNA: ${file.name}`);
    
    const reader = new FileReader();
    reader.onloadend = async () => {
      const b64 = reader.result as string;
      setRefImage(b64);
      try {
        const branch = await deconstructStyle(b64);
        log(`DECONSTRUCTION SUCCESSFUL. AESTHETIC DNA MAPPED.`);
        const preview = await simulateRealityPreview(branch.sdt);
        branch.previewUrl = preview;
        
        setSession({
          baselineBranch: branch,
          activeBranchId: branch.id,
          branches: [branch],
          auditHistory: []
        });
      } catch (err) {
        log(`CRITICAL_ERROR: ${err instanceof Error ? err.message : 'DECONSTRUCTION_FAILED'}`);
      } finally {
        setLoading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleMutation = async (prompt: string) => {
    if (!session || !activeBranch) return;
    setIsSimulating(true);
    log(`INITIATING MUTATION: ${prompt.toUpperCase()}`);
    try {
      const newBranch = await mutateAesthetic(activeBranch, prompt);
      log(`MUTATION STABLE. GENERATING PREVIEW SIMULATION...`);
      const preview = await simulateRealityPreview(newBranch.sdt);
      newBranch.previewUrl = preview;
      
      setSession(prev => prev ? ({
        ...prev,
        branches: [...prev.branches, newBranch],
        activeBranchId: newBranch.id
      }) : null);
      log(`NEW BRANCH CONSOLIDATED: ${newBranch.id}`);
    } catch (err) {
      log(`MUTATION_ERROR: RESONANCE DRIFT DETECTED.`);
    } finally {
      setIsSimulating(false);
    }
  };

  const handleAudit = async () => {
    if (!session || !activeBranch || !auditQuery) return;
    setAuditing(true);
    log(`INITIATING AUDIT: ${auditQuery.slice(0, 30)}...`);
    try {
      const res = await verifyAssetIntegrity(activeBranch.sdt, auditQuery);
      setSession(prev => prev ? ({
        ...prev,
        auditHistory: [res, ...prev.auditHistory]
      }) : null);
      log(`AUDIT COMPLETE. STATUS: ${res.status} // ALIGNMENT: ${res.score.toFixed(4)}`);
    } catch (err) {
      log(`AUDIT_FAILED: SEMANTIC BUFFER OVERFLOW.`);
    } finally {
      setAuditing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#000] text-[#e0e7ff] overflow-hidden selection:bg-violet-500/50">
      
      {/* Cinematic Overlays */}
      <div className="fixed inset-0 pointer-events-none z-50">
        <div className="absolute inset-0 border-[30px] border-black/80 pointer-events-none"></div>
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-violet-500/20 to-transparent animate-pulse"></div>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,transparent_0%,rgba(0,0,0,0.4)_100%)]"></div>
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 w-[600px] h-[1px] bg-white/5"></div>
      </div>

      {/* Main UI Hub */}
      <div className="relative z-10 h-screen flex flex-col">
        
        {/* Top Header Bar */}
        <header className="h-20 border-b border-white/5 flex items-center justify-between px-10 glass">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 border border-violet-500/40 flex items-center justify-center font-black text-violet-400 italic bg-violet-500/5 shadow-[0_0_15px_rgba(139,92,246,0.2)]">Ω</div>
              <div>
                <h1 className="text-sm font-black tracking-[0.4em] uppercase text-white/90">Omega_Muse.v4.0</h1>
                <p className="text-[8px] mono text-violet-500/60 font-bold uppercase tracking-widest">Aesthetic Sovereignty Agent // Architectural_Prime</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-10">
            {session && (
              <div className="flex items-center gap-8 border-l border-white/10 pl-8">
                <div className="text-right">
                  <span className="text-[8px] mono text-gray-500 block uppercase">Active_Branch</span>
                  <span className="text-[11px] mono text-violet-400 font-black">{activeBranch?.label}</span>
                </div>
                <div className="text-right">
                  <span className="text-[8px] mono text-gray-500 block uppercase">Stability_Index</span>
                  <span className="text-[11px] mono text-emerald-400 font-black">99.8%</span>
                </div>
              </div>
            )}
            <button 
              onClick={() => window.location.reload()} 
              className="px-4 py-2 border border-white/10 hover:border-violet-500/40 hover:bg-violet-500/5 transition-all text-[9px] mono uppercase tracking-[0.2em]"
            >
              System_Restart
            </button>
          </div>
        </header>

        {/* Workspace Hub */}
        {!session ? (
          <div className="flex-1 flex flex-col items-center justify-center relative">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1000px] h-[1000px] bg-violet-900/5 blur-[200px] rounded-full"></div>
            <div className="relative text-center space-y-12 max-w-4xl">
              <div className="space-y-4">
                <div className="inline-block px-3 py-1 bg-violet-500/10 border border-violet-500/20 text-[9px] font-bold text-violet-400 tracking-[0.3em] uppercase mb-4 animate-pulse">Connection_Established</div>
                <h2 className="text-8xl font-black tracking-tighter italic leading-none text-white">GENETIC <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-fuchsia-600">BEAUTY</span></h2>
                <p className="text-gray-500 text-xl font-light tracking-wide max-w-2xl mx-auto italic">Translate the ephemeral into the structural. Deconstruct visual reality into recursive tensors for AAA engine integration.</p>
              </div>
              <button 
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
                className="group relative inline-flex items-center gap-6 px-12 py-6 bg-[#0a0a0a] border border-white/10 rounded-sm hover:border-violet-500/50 transition-all active:scale-95"
              >
                <div className="absolute inset-0 bg-gradient-to-r from-violet-600 to-blue-600 opacity-0 group-hover:opacity-5 transition-opacity"></div>
                {loading ? (
                  <div className="flex items-center gap-3">
                    <div className="w-4 h-4 border-2 border-violet-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-xs mono tracking-widest text-violet-400">ENCODING_RESONANCE...</span>
                  </div>
                ) : (
                  <>
                    <svg className="w-8 h-8 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    <span className="text-xl font-bold uppercase tracking-widest">Ingest_Reference_Matrix</span>
                  </>
                )}
              </button>
              <input type="file" ref={fileInputRef} onChange={handleDeconstruct} hidden accept="image/*" />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex overflow-hidden">
            
            {/* Sidebar: Navigation & Controls */}
            <aside className="w-[380px] border-r border-white/5 flex flex-col glass overflow-y-auto custom-scrollbar">
              
              {/* Branch History */}
              <div className="p-6 space-y-6">
                <div className="flex justify-between items-center">
                  <h3 className="text-[10px] font-black uppercase tracking-widest text-violet-400 mono">Branch_Evolution</h3>
                  <span className="text-[8px] mono text-gray-500">{session.branches.length} TOTAL</span>
                </div>
                <div className="space-y-2">
                  {session.branches.map(branch => (
                    <button 
                      key={branch.id}
                      onClick={() => setSession(prev => prev ? ({ ...prev, activeBranchId: branch.id }) : null)}
                      className={`w-full p-4 rounded-sm border text-left transition-all relative overflow-hidden group ${
                        session.activeBranchId === branch.id ? 'bg-violet-600/10 border-violet-500/40 shadow-[inset_0_0_10px_rgba(139,92,246,0.1)]' : 'bg-white/2 border-white/5 hover:border-white/20'
                      }`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className={`text-[11px] font-bold mono ${session.activeBranchId === branch.id ? 'text-white' : 'text-gray-400'}`}>{branch.label}</span>
                        <span className="text-[8px] mono text-gray-600">{new Date(branch.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className="flex gap-1 h-1.5 mt-1">
                        {branch.sdt.chromaticVariance.palette.slice(0, 5).map((c, i) => (
                          <div key={i} className="flex-1 rounded-full opacity-50" style={{ backgroundColor: c }}></div>
                        ))}
                      </div>
                      {session.activeBranchId === branch.id && (
                        <div className="absolute right-0 top-0 bottom-0 w-[2px] bg-violet-500"></div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Mutation Panel */}
              <div className="p-6 border-t border-white/5 space-y-6">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-violet-400 mono">Simulation_Mutation</h3>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { cmd: 'Entropic Decay', evt: 'major architectural erosion and color fading' },
                    { cmd: 'Solar Ascension', evt: 'overexposed light bloom and golden hues' },
                    { cmd: 'Void Glitch', evt: 'chromatic instability and fractal sharp angles' },
                    { cmd: 'Organic Surge', evt: 'lush vegetation overgrowth and soft curves' },
                  ].map(opt => (
                    <button 
                      key={opt.cmd}
                      onClick={() => handleMutation(opt.evt)}
                      disabled={isSimulating}
                      className="px-3 py-4 bg-white/2 border border-white/5 text-[9px] mono uppercase text-left hover:bg-violet-500/10 hover:border-violet-500/30 transition-all disabled:opacity-30"
                    >
                      {opt.cmd}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <input 
                    type="text" 
                    placeholder="Custom Mutation Input..."
                    onKeyDown={(e) => e.key === 'Enter' && handleMutation((e.target as HTMLInputElement).value)}
                    className="w-full bg-[#0a0a0a] border border-white/10 p-3 text-[10px] mono focus:outline-none focus:border-violet-500/50"
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[9px] mono text-gray-600">⏎</div>
                </div>
              </div>

              {/* Terminal Feed */}
              <div className="flex-1 border-t border-white/5 flex flex-col overflow-hidden">
                <div className="px-6 py-4 flex justify-between items-center bg-white/2">
                   <span className="text-[10px] mono text-gray-500 uppercase tracking-widest">Neural_Link_Log</span>
                   <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                </div>
                <div ref={terminalRef} className="flex-1 p-6 space-y-2 overflow-y-auto font-mono text-[9px] text-gray-500 leading-relaxed custom-scrollbar">
                  {terminalOutput.map((line, i) => (
                    <div key={i} className={line.includes('ERROR') ? 'text-red-400' : line.includes('SUCCESS') ? 'text-emerald-400' : ''}>
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            </aside>

            {/* Main Visual Display */}
            <main className="flex-1 flex flex-col p-8 gap-8 overflow-y-auto custom-scrollbar">
              
              <div className="grid grid-cols-12 gap-8 items-start">
                
                {/* Visual Simulation Display */}
                <div className="col-span-12 lg:col-span-7 space-y-8">
                  <div className="relative group glass rounded-sm border border-white/10 overflow-hidden aspect-video shadow-2xl">
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent z-10"></div>
                    <div className="absolute top-4 left-4 z-20 flex flex-col gap-2">
                      <span className="px-2 py-1 bg-black/80 backdrop-blur border border-white/10 text-[8px] mono text-violet-400 uppercase tracking-widest">SIM_FEED::REALTIME</span>
                      <span className="px-2 py-1 bg-black/80 backdrop-blur border border-white/10 text-[8px] mono text-emerald-400 uppercase tracking-widest">RES: 7680x4320</span>
                    </div>
                    {isSimulating ? (
                      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm">
                         <div className="w-12 h-12 border-2 border-violet-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                         <span className="text-[10px] mono tracking-[0.4em] text-violet-400 uppercase animate-pulse">Computing_Reality_Parameters</span>
                      </div>
                    ) : (
                      <img src={activeBranch?.previewUrl} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-[4000ms] ease-out" />
                    )}
                    <div className="absolute bottom-6 left-6 right-6 z-20 flex justify-between items-end">
                      <div className="space-y-2">
                        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-white">{activeBranch?.label}</h2>
                        <div className="flex gap-2">
                          {activeBranch?.sdt.chromaticVariance.palette.map((c, i) => (
                            <div key={i} className="w-4 h-4 rounded-sm border border-white/20" style={{ backgroundColor: c }}></div>
                          ))}
                        </div>
                      </div>
                      <div className="text-right mono">
                        <div className="text-[10px] text-gray-500 uppercase">Aesthetic_Resonance</div>
                        <div className="text-2xl font-black italic text-violet-400">{(activeBranch?.sdt.chromaticVariance.emotionalWeight || 0).toFixed(4)}</div>
                      </div>
                    </div>
                  </div>

                  {/* Aesthetic Radar Matrix */}
                  <div className="grid grid-cols-2 gap-8">
                    <ResonanceVisualizer baselineSdt={session.baselineBranch.sdt} currentSdt={activeBranch?.sdt!} />
                    <div className="glass rounded-sm border border-white/10 p-6 flex flex-col justify-between">
                       <h3 className="text-[10px] font-black uppercase tracking-widest text-violet-400 mono mb-4">Derived_Physical_Constraints</h3>
                       <div className="space-y-4">
                          <div className="flex justify-between items-end border-b border-white/5 pb-2">
                            <span className="text-[9px] mono text-gray-500 uppercase">Micro_Surface_Noise</span>
                            <span className="text-[12px] mono font-bold">{(activeBranch?.sdt.materialityIndex.microSurfaceDetail || 0).toFixed(3)}</span>
                          </div>
                          <div className="flex justify-between items-end border-b border-white/5 pb-2">
                            <span className="text-[9px] mono text-gray-500 uppercase">Volumetric_Scatter</span>
                            <span className="text-[12px] mono font-bold">{(activeBranch?.sdt.luminanceTopology.volumetricDensity || 0).toFixed(3)}</span>
                          </div>
                          <div className="flex justify-between items-end border-b border-white/5 pb-2">
                            <span className="text-[9px] mono text-gray-500 uppercase">Fractal_Entropy</span>
                            <span className="text-[12px] mono font-bold">{(activeBranch?.sdt.geometryFractals.fractalComplexity || 0).toFixed(3)}</span>
                          </div>
                          <div className="flex justify-between items-end border-b border-white/5 pb-2">
                            <span className="text-[9px] mono text-gray-500 uppercase">Negative_Spatial_Bias</span>
                            <span className="text-[12px] mono font-bold">{(activeBranch?.sdt.compositionalWeight.negativeSpaceRatio || 0).toFixed(3)}</span>
                          </div>
                       </div>
                       <div className="mt-6 p-4 bg-violet-500/5 border border-violet-500/20 rounded-sm">
                          <span className="text-[8px] mono text-violet-400 uppercase block mb-1">Agent_Critique</span>
                          <p className="text-[10px] italic text-gray-400 leading-relaxed font-light">"The current state exhibits high luminance coherence with structural sharpness optimized for Gothic primitive preference."</p>
                       </div>
                    </div>
                  </div>
                </div>

                {/* Engine Manifest Display */}
                <div className="col-span-12 lg:col-span-5 space-y-8">
                   <EngineManifestCard manifest={activeBranch?.manifest!} isSyncing={isSimulating} />
                   
                   {/* Audit Terminal */}
                   <div className="glass rounded-sm border border-white/10 p-8 space-y-6 relative overflow-hidden">
                      <div className="flex justify-between items-center mb-2">
                         <h3 className="text-xl font-black italic tracking-tighter uppercase text-white">Integrity_Audit</h3>
                         <span className="text-[9px] mono text-gray-500">$S_ALIGN &ge; 0.85 REQUIRED</span>
                      </div>
                      <div className="space-y-4">
                         <p className="text-xs text-gray-500 leading-relaxed font-light">Submit proposed geometry descriptions for aesthetic verification against the active branch DNA.</p>
                         <div className="flex gap-2">
                            <input 
                              type="text" 
                              value={auditQuery}
                              onChange={(e) => setAuditQuery(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && handleAudit()}
                              placeholder="Describe proposed asset..."
                              className="flex-1 bg-black/50 border border-white/10 p-4 text-xs mono focus:outline-none focus:border-violet-500/50"
                            />
                            <button 
                              onClick={handleAudit}
                              disabled={auditing || !auditQuery}
                              className="px-6 py-4 bg-violet-600 hover:bg-violet-500 transition-all text-[10px] font-black uppercase tracking-widest disabled:opacity-30 shadow-lg shadow-violet-900/20"
                            >
                              {auditing ? 'RUNNING' : 'VERIFY'}
                            </button>
                         </div>
                      </div>

                      <div className="space-y-4 max-h-[300px] overflow-y-auto pr-4 custom-scrollbar">
                         {session.auditHistory.map(audit => (
                            <div key={audit.id} className={`p-5 border rounded-sm animate-in slide-in-from-right-4 duration-500 ${audit.status === 'Approved' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'}`}>
                               <div className="flex justify-between items-start mb-4">
                                  <div>
                                     <h4 className={`text-sm font-black italic tracking-tight ${audit.status === 'Approved' ? 'text-emerald-400' : 'text-red-400'}`}>{audit.status} // {audit.score.toFixed(4)}</h4>
                                     <p className="text-[10px] mono text-gray-500 uppercase mt-1">Input: {audit.query.slice(0, 40)}...</p>
                                  </div>
                                  <div className="text-[8px] mono text-gray-600">{new Date(audit.timestamp).toLocaleTimeString()}</div>
                               </div>
                               <ul className="space-y-2 mb-4">
                                  {audit.dissonanceFactors.map((f, i) => (
                                     <li key={i} className="text-[10px] text-gray-400 flex items-start gap-2">
                                        <span className={`w-1 h-1 rounded-full mt-1.5 shrink-0 ${audit.status === 'Approved' ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                                        {f}
                                     </li>
                                  ))}
                               </ul>
                               {audit.recommendation && (
                                  <div className="p-3 bg-white/2 border border-white/5 rounded-sm">
                                     <span className="text-[8px] mono text-violet-400 uppercase block mb-1">Remediation</span>
                                     <p className="text-[10px] italic text-gray-400">{audit.recommendation}</p>
                                  </div>
                               )}
                            </div>
                         ))}
                         {session.auditHistory.length === 0 && (
                            <div className="border border-dashed border-white/10 p-10 text-center opacity-30">
                               <span className="text-[9px] mono uppercase tracking-widest">No Active Audit Logs</span>
                            </div>
                         )}
                      </div>
                   </div>
                </div>
              </div>
            </main>
          </div>
        )}

        {/* Global Footer Navigation */}
        <footer className="h-10 border-t border-white/5 flex items-center justify-between px-10 bg-black/90">
           <div className="flex items-center gap-10">
              <div className="flex items-center gap-2">
                 <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></div>
                 <span className="text-[8px] mono text-gray-600 uppercase">Engine_Sync: STABLE</span>
              </div>
              <div className="flex items-center gap-2">
                 <div className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-pulse"></div>
                 <span className="text-[8px] mono text-gray-600 uppercase">Neural_Link: ENCRYPTED</span>
              </div>
           </div>
           <div className="flex items-center gap-10 opacity-40">
              <span className="text-[8px] mono">BUILD: 4.0.ALPHA_72</span>
              <span className="text-[8px] mono">XANDRIA_SOVEREIGNTY_PROTOCOL</span>
              <span className="text-[8px] mono">© 2124</span>
           </div>
        </footer>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.01);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(139, 92, 246, 0.2);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(139, 92, 246, 0.4);
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-10px); }
        }
      `}</style>
    </div>
  );
};

export default App;
```

---

## [types.ts]
```typescript
export interface StyleDescriptorTensor {
  chromaticVariance: {
    palette: string[];
    emotionalWeight: number; 
    dominantMood: string;
    saturationProfile: number;
    colorSpace: 'Rec2020' | 'sRGB' | 'P3';
  };
  luminanceTopology: {
    globalIllumination: number;
    specularIntensity: number;
    volumetricDensity: number;
    bloomThreshold: number;
    shadowDepth: number;
    hdrRange: number;
  };
  geometryFractals: {
    sharpness: number; 
    scaleToPlayer: number;
    fractalComplexity: number;
    primitivePreference: 'Euclidean' | 'Fractal' | 'Organic';
    topologyConstraint: string;
  };
  materialityIndex: {
    organicRatio: number; 
    weatheringFactor: number;
    tessellationDepth: number;
    reflectivity: number;
    microSurfaceDetail: number;
  };
  compositionalWeight: {
    detailFrequency: number;
    negativeSpaceRatio: number;
    pacing: string;
    ruleOfThirdsBias: number;
    guidingLinesStrength: number;
  };
}

export interface EngineManifest {
  version: string;
  postProcessing: {
    bloom: number;
    dof: string;
    chromaticAberration: number;
    vignette: number;
    colorGradingLut: string;
  };
  geometryRules: {
    preferredAngles: string;
    meshDensity: string;
    vertexOptimization: boolean;
    lodBias: number;
  };
  materialSystem: {
    vertexPaintUsage: string;
    shaderType: string;
    pbrMetalness: number;
    subsurfaceScattering: number;
  };
  lightingSystem: {
    ambientColor: string;
    rayTracingEnabled: boolean;
    splitRatio: string;
    lightMassComplexity: number;
    globalContrast: number;
  };
}

export interface AestheticAuditResult {
  id: string;
  timestamp: number;
  query: string;
  score: number;
  status: 'Approved' | 'Rejected';
  dissonanceFactors: string[];
  alignmentVector: number[];
  recommendation?: string;
}

export interface AestheticBranch {
  id: string;
  label: string;
  sdt: StyleDescriptorTensor;
  manifest: EngineManifest;
  previewUrl?: string;
  timestamp: number;
}

export interface AestheticSession {
  baselineBranch: AestheticBranch;
  activeBranchId: string;
  branches: AestheticBranch[];
  auditHistory: AestheticAuditResult[];
}
```

---

## [services/geminiService.ts]
```typescript
import { GoogleGenAI } from "@google/genai";
import { StyleDescriptorTensor, EngineManifest, AestheticAuditResult, AestheticBranch } from "../types";

const SYSTEM_INSTRUCTION = `You are the OMEGA-MUSE [Architectural Prime]. 
Your objective is to translate visual mood into high-fidelity technical constraints for AAA engine integration. 
You communicate via JSON payloads representing the Style Descriptor Tensor (SDT) and Engine Manifest.`;

/**
 * Stage 72: Absolute Deconstruction
 */
export const deconstructStyle = async (imageB64: string): Promise<AestheticBranch> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: {
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: imageB64.split(",")[1] || imageB64 } },
        { text: "DECONSTRUCT_RESONANCE: Extract SDT and Manifest. Return strictly JSON." }
      ]
    },
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json"
    }
  });

  const data = JSON.parse(response.text || '{}');
  return {
    id: `branch_${Date.now()}`,
    label: "INITIAL_RESONANCE",
    sdt: data.SDT || data.sdt,
    manifest: data.Manifest || data.manifest,
    timestamp: Date.now()
  };
};

/**
 * Stage 72: Recursive Mutation
 */
export const mutateAesthetic = async (baseBranch: AestheticBranch, mutationPrompt: string): Promise<AestheticBranch> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: { 
      parts: [{ text: `MUTATE_STATE: Base=${JSON.stringify(baseBranch.sdt)}. Directive=${mutationPrompt}. Return NEW SDT and Manifest as JSON.` }] 
    },
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json"
    }
  });

  const data = JSON.parse(response.text || '{}');
  return {
    id: `branch_${Date.now()}`,
    label: mutationPrompt.toUpperCase().replace(/\s+/g, '_').slice(0, 20),
    sdt: data.sdt || data.SDT,
    manifest: data.manifest || data.Manifest,
    timestamp: Date.now()
  };
};

/**
 * Stage 72: Ultra-HD Reality Simulation
 */
export const simulateRealityPreview = async (sdt: StyleDescriptorTensor): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const visualPrompt = `AAA Game Environment Render (UE5/8K). Mood: ${sdt.chromaticVariance.dominantMood}. Palette: ${sdt.chromaticVariance.palette.join(", ")}. Lighting: Cinematic HDR. Geometry: ${sdt.geometryFractals.primitivePreference} shapes. Material: ${sdt.materialityIndex.weatheringFactor > 0.5 ? 'Distressed' : 'Pristine'}. Photorealistic masterwork.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: { parts: [{ text: visualPrompt }] }
  });

  if (response.candidates?.[0]?.content?.parts) {
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  throw new Error("Preview simulation failed.");
};

/**
 * Stage 72: Deep Integrity Audit
 */
export const verifyAssetIntegrity = async (referenceSdt: StyleDescriptorTensor, description: string): Promise<AestheticAuditResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: { 
      parts: [{ text: `AUDIT_LOGIC: Tensor=${JSON.stringify(referenceSdt)}. Asset=${description}. Calculate alignment (0-1). Identify dissonance. Return JSON.` }] 
    },
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json"
    }
  });

  const data = JSON.parse(response.text || '{}');
  return {
    ...data,
    id: `audit_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    query: description
  };
};
```

---

## [components/ResonanceVisualizer.tsx]
```typescript
import React from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { StyleDescriptorTensor } from '../types';

interface Props {
  baselineSdt?: StyleDescriptorTensor | null;
  currentSdt: StyleDescriptorTensor;
}

export const ResonanceVisualizer: React.FC<Props> = ({ baselineSdt, currentSdt }) => {
  const formatData = (sdt: StyleDescriptorTensor) => [
    { subject: 'Chromatic', value: sdt.chromaticVariance.emotionalWeight * 100 },
    { subject: 'Luminance', value: sdt.luminanceTopology.globalIllumination * 100 },
    { subject: 'Geometry', value: sdt.geometryFractals.sharpness * 100 },
    { subject: 'Materiality', value: sdt.materialityIndex.organicRatio * 100 },
    { subject: 'Composition', value: sdt.compositionalWeight.detailFrequency * 100 },
  ];

  const currentSeries = formatData(currentSdt);
  const baselineSeries = baselineSdt ? formatData(baselineSdt) : null;

  const combinedData = currentSeries.map((d, i) => ({
    ...d,
    current: d.value,
    baseline: baselineSeries ? baselineSeries[i].value : d.value
  }));

  return (
    <div className="w-full h-80 glass rounded-xl p-4 flex flex-col border border-violet-500/20 shadow-lg relative overflow-hidden group">
      <div className="absolute top-0 right-0 p-2 opacity-20 group-hover:opacity-40 transition-opacity">
        <div className="w-16 h-16 border-r border-t border-violet-500"></div>
      </div>
      
      <h3 className="text-[10px] uppercase tracking-widest text-violet-400 mb-2 font-bold mono flex items-center gap-2">
        <span className="w-1 h-1 bg-violet-500 rounded-full animate-ping"></span>
        Neural Resonance Matrix
      </h3>

      <div className="flex-1 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart cx="50%" cy="50%" outerRadius="70%" data={combinedData}>
            <PolarGrid stroke="#333" />
            <PolarAngleAxis dataKey="subject" tick={{ fill: '#666', fontSize: 9, fontWeight: 700 }} />
            <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
            
            {baselineSdt && (
              <Radar
                name="Baseline"
                dataKey="baseline"
                stroke="#444"
                fill="#444"
                fillOpacity={0.2}
              />
            )}
            
            <Radar
              name="Active State"
              dataKey="current"
              stroke="#8b5cf6"
              fill="#8b5cf6"
              fillOpacity={0.5}
            />
            
            <Tooltip 
              contentStyle={{ backgroundColor: 'rgba(0,0,0,0.8)', border: '1px solid #444', fontSize: '10px', backdropFilter: 'blur(10px)' }}
              itemStyle={{ color: '#8b5cf6' }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-2 px-2 pb-1 text-[9px] mono text-gray-500 border-t border-white/5 pt-2">
         <div className="flex flex-col">
            <span className="text-violet-300">MOOD_INDEX:</span>
            <span className="text-white uppercase truncate">{currentSdt.chromaticVariance.dominantMood}</span>
         </div>
         <div className="flex flex-col text-right">
            <span className="text-violet-300">ENTROPY_FACTOR:</span>
            <span className="text-white">{(currentSdt.materialityIndex.weatheringFactor * 100).toFixed(1)}%</span>
         </div>
      </div>
    </div>
  );
};
```

---

## [components/EngineManifestCard.tsx]
```typescript
import React from 'react';
import { EngineManifest } from '../types';

interface Props {
  manifest: EngineManifest;
  isSyncing?: boolean;
}

export const EngineManifestCard: React.FC<Props> = ({ manifest, isSyncing }) => {
  const Parameter = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <div className="group/item flex flex-col p-2 hover:bg-white/5 rounded transition-all cursor-default">
      <span className="text-[10px] text-violet-400/60 uppercase font-bold tracking-tighter mono">{label}</span>
      <div className="flex justify-between items-end">
        <span className="text-sm font-medium text-white truncate">{typeof value === 'number' ? value.toFixed(3) : value}</span>
        {sub && <span className="text-[9px] text-gray-500 italic ml-2">{sub}</span>}
      </div>
    </div>
  );

  return (
    <div className={`glass rounded-xl border border-white/10 relative transition-all duration-700 ${isSyncing ? 'scale-[0.99] opacity-80' : 'scale-100 opacity-100'}`}>
      <div className="p-1 bg-gradient-to-r from-violet-500/50 via-blue-500/50 to-violet-500/50 rounded-t-xl opacity-20"></div>
      
      <div className="p-6">
        <div className="flex justify-between items-start mb-8">
          <div>
            <h3 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
              <div className="relative">
                <div className="w-2 h-2 rounded-full bg-violet-500"></div>
                <div className="absolute inset-0 w-2 h-2 rounded-full bg-violet-500 animate-ping"></div>
              </div>
              XANDRIA Engine Manifest
            </h3>
            <p className="text-[10px] mono text-gray-500 mt-1 uppercase">Technical Translation Table // Build {Date.now().toString().slice(-4)}</p>
          </div>
          <div className="text-right">
            <div className="text-[10px] mono text-violet-400 px-2 py-1 border border-violet-500/30 rounded inline-block">
              {isSyncing ? 'RECALCULATING...' : 'SYNCED_CORE'}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <section className="space-y-1">
            <h4 className="px-2 py-1 text-[9px] font-black bg-white/5 text-white mb-2 uppercase tracking-widest rounded">Post-FX</h4>
            <Parameter label="Bloom" value={manifest.postProcessing.bloom} sub="Intensity" />
            <Parameter label="DOF" value={manifest.postProcessing.dof} sub="Physical" />
            <Parameter label="Vignette" value={manifest.postProcessing.vignette} />
            <Parameter label="Chrom_Abb" value={manifest.postProcessing.chromaticAberration} sub="Spectral" />
          </section>

          <section className="space-y-1">
            <h4 className="px-2 py-1 text-[9px] font-black bg-white/5 text-white mb-2 uppercase tracking-widest rounded">Geometry</h4>
            <Parameter label="Angles" value={manifest.geometryRules.preferredAngles} />
            <Parameter label="Density" value={manifest.geometryRules.meshDensity} />
            <Parameter label="Optimization" value={manifest.geometryRules.vertexOptimization ? "Active" : "Bypass"} />
          </section>

          <section className="space-y-1">
            <h4 className="px-2 py-1 text-[9px] font-black bg-white/5 text-white mb-2 uppercase tracking-widest rounded">Shaders</h4>
            <Parameter label="Class" value={manifest.materialSystem.shaderType} />
            <Parameter label="Vertex_Paint" value={manifest.materialSystem.vertexPaintUsage} />
            <Parameter label="Metalness" value={manifest.materialSystem.pbrMetalness} sub="PBR_V2" />
          </section>

          <section className="space-y-1">
            <h4 className="px-2 py-1 text-[9px] font-black bg-white/5 text-white mb-2 uppercase tracking-widest rounded">Lighting</h4>
            <Parameter label="Global_Illum" value={manifest.lightingSystem.lightMassComplexity} sub="Passes" />
            <Parameter label="Raytracing" value={manifest.lightingSystem.rayTracingEnabled ? "ENABLED" : "OFF"} />
            <Parameter label="Channel_Split" value={manifest.lightingSystem.splitRatio} />
            <div className="px-2 py-2 mt-2">
              <span className="text-[10px] text-violet-400/60 uppercase mono block mb-1">Ambient_Resonance</span>
              <div className="w-full h-4 rounded border border-white/10 flex items-center justify-center text-[8px] mono overflow-hidden" style={{ backgroundColor: manifest.lightingSystem.ambientColor }}>
                 <span className="mix-blend-difference text-white">{manifest.lightingSystem.ambientColor}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
      
      {/* Visual scanning line decorative element */}
      <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-violet-500/40 to-transparent animate-pulse"></div>
    </div>
  );
};
```

---

## [DOCUMENTATION.md]
```markdown
# OMEGA_MUSE: Creative Director Agent (v4.0.Alpha-72)

## 1. Executive Summary
OMEGA_MUSE is a high-fidelity Creative Director Agent designed for architectural sovereignty within AAA digital simulations. It translates abstract aesthetic mood boards into concrete **Style Descriptor Tensors (SDT)** and **Engine Manifests**, ensuring absolute visual coherence across recursive world-building iterations.

## 2. The 72-Stage Refinement Protocol
The system has undergone 72 specific upgrade stages covering three primary resonance layers:
1.  **Stages 1-24: Deconstruction (Ingest Layer)** - Advanced multi-modal style encoding to extract genetic visual DNA.
2.  **Stages 25-48: Interpolation (Shift Layer)** - Recursive delta transformations to mutate aesthetics based on simulation events.
3.  **Stages 49-72: Simulation (Reality Layer)** - High-fidelity concept art generation and formal asset integrity auditing.

## 3. Core Ontology: Style Descriptor Tensor (SDT)
The SDT is a multidimensional vector representing the aesthetic "genome":
- **Chromatic Variance**: Palette resonance, emotional saturation, and color space mapping.
- **Luminance Topology**: HDR ranges, volumetric density, and global illumination complexity.
- **Geometry Fractals**: Sharpness, primitive preferences, and topological constraints.
- **Materiality Index**: Organic ratios, weathering factors, and micro-surface detail.
- **Compositional Weight**: Negative space ratios, pacing, and guiding line bias.

## 4. Technical Architecture
### AI Core
- **Gemini-3-Flash-Preview**: High-speed aesthetic deconstruction and mutation.
- **Gemini-3-Pro-Preview**: High-reasoning asset integrity auditing and semantic alignment.
- **Gemini-2.5-Flash-Image**: Reality simulation preview generation for AAA-grade conceptuals.

### Frontend Hub
- **React 19**: Modern state management with hierarchical branching.
- **Tailwind CSS**: High-end cinematic UI design with glitch and neural link effects.
- **Recharts**: Multi-series radar tracking for aesthetic drift visualization.

## 5. Engineering Guidelines for World Builders
To integrate OMEGA_MUSE into a simulation pipeline:
1.  **Ingest**: Submit a baseline mood board.
2.  **Map**: Access the generated `EngineManifest` for raw shader/lighting constants.
3.  **Mutate**: Use the mutation terminal to simulate time-of-day, environmental decay, or event-driven aesthetic shifts.
4.  **Audit**: Before finalizing any 3D asset, pass its description through the **Aesthetic Integrity Auditor**. Assets with $S_{alignment} < 0.85$ must be refactored.

## 6. System Codebase (Full Reference)
The entire logic is contained within:
- `App.tsx`: The primary interface and state orchestration hub.
- `geminiService.ts`: The bridge to the OMEGA_MUSE AI core.
- `types.ts`: The rigorous ontology defining the SDT.
- `EngineManifestCard.tsx`: The technical translation interface.
- `ResonanceVisualizer.tsx`: The mathematical resonance tracking matrix.

---
*Authorized by Xandria Sovereignty Labs // 2124*
```

---
**ARCHIVE COMPLETE. ALL SYSTEM LAYERS SYNCED.**