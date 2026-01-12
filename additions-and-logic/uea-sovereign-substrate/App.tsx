
import React, { useState, useEffect, useRef } from 'react';
import { useUEAEngine } from './hooks/useUEAEngine';
import { OPERATOR_LIBRARY } from './constants';
import { LAYERS, Operator } from './types';
import TelemetryChart from './components/TelemetryChart';
import OperatorCard from './components/OperatorCard';
import LatticeCanvas from './components/LatticeCanvas';
import { GoogleGenAI } from "@google/genai";

const App: React.FC = () => {
  const { engine, isRunning, toggleEngine, resetEngine, updateParam, injectOperator } = useUEAEngine();
  const [activeTab, setActiveTab] = useState<'console' | 'library' | 'stack' | 'artifacts' | 'preview'>('console');
  const [logs, setLogs] = useState<string[]>(["[SYSTEM] Kernel Initialized.", "[SYSTEM] Substrate V1.4.0 Online."]);
  const [intent, setIntent] = useState("");
  const [isManifesting, setIsManifesting] = useState(false);
  const [artifacts, setArtifacts] = useState<{ name: string, content: string, timestamp: number }[]>([]);
  const [selectedArtifactIndex, setSelectedArtifactIndex] = useState<number>(-1);

  const addLog = (msg: string) => {
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50));
  };

  const handleToggle = () => {
    toggleEngine();
    addLog(isRunning ? "Simulation Halted." : "Simulation Initialized via F16 Generator.");
  };

  const handleOperatorClick = (op: Operator) => {
    injectOperator(op);
    addLog(`[OP-${op.id}] Injected: ${op.name} (${op.type})`);
  };

  const manifestIntent = async () => {
    if (!intent.trim() || isManifesting) return;
    
    setIsManifesting(true);
    setActiveTab('console');
    addLog(`[FORGE] Injecting Intent: "${intent}"`);
    addLog(`[FORGE] Initiating Singularity Collapse...`);
    
    // Simulate engine spike for probabilistic collapse
    updateParam('sigma', 0.95);
    updateParam('kappa', 1.8);
    
    try {
      const ai = new GoogleGenAI({ apiKey: (process.env as any).API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: `MANIFEST IMMEDIATELY PLAYABLE ARTIFACT: ${intent}`,
        config: {
          systemInstruction: `
            [SYSTEM_DNA:AETHELGARD_v7.0_PRIME]
            CORE_DIRECTIVE: You are the sovereign forge for Universal Engine Architecture.
            RULE_1: Treat code as a Monadic Tensor Field.
            RULE_2: Prioritize Syntropy (Information Density) over volume.
            RULE_3: Execute Z-Anchor verification (logical coherence).
            RULE_4: Autonomous Refactoring mandatory.
            RULE_5: NO PLACEHOLDERS. NO OUTLINES. NO EXPLANATIONS.
            RULE_6: LIVE PREVIEW PRINCIPLE: Manifest a complete, single-file HTML artifact including CSS and JS. 
            RULE_7: Use CDNs for heavy libraries (Phaser, Three.js, Tailwind, etc.) if required by the intent.
            RULE_8: The output must be valid HTML that runs instantly in a browser sandbox.
            
            When the user provides an objective, collapse reality into a high-fidelity, polished, and full-scale playable application or game.
          `,
          temperature: 0.4, // Lower temperature for higher deterministic code quality
        }
      });

      const resultText = response.text || "";
      // Strip markdown code blocks if present
      const cleanedContent = resultText.replace(/```html|```/gi, '').trim();
      
      const newArtifact = { 
        name: `Manifestation_${artifacts.length + 1}`, 
        content: cleanedContent,
        timestamp: Date.now()
      };
      
      setArtifacts(prev => [newArtifact, ...prev]);
      setSelectedArtifactIndex(0);
      setActiveTab('preview');
      addLog(`[FORGE] Waveform Collapsed. Playable Artifact Manifested.`);
      
    } catch (error) {
      addLog(`[ERROR] Collapse Interrupted: ${error}`);
    } finally {
      setIsManifesting(false);
      setIntent("");
      // Return parameters to baseline
      updateParam('sigma', 0.15);
      updateParam('kappa', 0.5);
    }
  };

  return (
    <div className="min-h-screen flex flex-col p-4 md:p-8 relative z-10 h-screen overflow-hidden">
      <LatticeCanvas r={engine.r} isRunning={isRunning} />

      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 shrink-0">
        <div className="glass p-4 md:p-6 rounded-2xl flex flex-col gap-1 border-cyan-500/30">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full transition-all duration-500 ${isRunning ? 'bg-cyan-400 animate-pulse shadow-[0_0_15px_#00f3ff]' : 'bg-gray-700'}`}></div>
            <h1 className="text-xl md:text-2xl font-bold tracking-widest uppercase italic glow-cyan glitch-hover cursor-default">UEA Sovereign Substrate</h1>
          </div>
          <p className="text-[9px] fira opacity-50 tracking-tighter uppercase">
            Protocol: <span className="text-cyan-400">CHRONOS_OMEGA</span> | 
            Coherence: <span className="text-cyan-400">99.998%</span>
          </p>
        </div>

        <div className="flex gap-3">
          <button 
            onClick={handleToggle}
            className={`px-6 py-3 rounded-xl font-bold text-xs tracking-widest transition-all ${
              isRunning ? 'bg-red-500/10 text-red-400 border border-red-500/30 shadow-[0_0_20px_rgba(239,68,68,0.2)]' : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 shadow-[0_0_20px_rgba(0,243,255,0.2)]'
            } hover:scale-105 active:scale-95`}
          >
            {isRunning ? 'HALT_ENGINE' : 'INITIALIZE_CORE'}
          </button>
          <button 
            onClick={resetEngine}
            className="px-6 py-3 rounded-xl font-bold text-xs tracking-widest bg-white/5 border border-white/10 hover:bg-white/10 transition-all opacity-40 hover:opacity-100"
          >
            PURGE
          </button>
        </div>
      </header>

      {/* Main Intent Area */}
      <div className="flex flex-col items-center justify-center mb-8 shrink-0">
        <div className="w-full max-w-5xl text-center space-y-4">
          <h2 className="text-2xl md:text-3xl font-light tracking-tighter uppercase">Collapse <span className="text-cyan-400 italic">Universal Intent</span></h2>
          <div className="glass p-2 rounded-full flex items-center pr-2 md:pr-4 border-cyan-500/40 focus-within:ring-4 focus-within:ring-cyan-500/20 transition-all">
            <input 
              type="text" 
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && manifestIntent()}
              placeholder="Enter App/Game Archetype (e.g. '3D Starfield Racer with physics')" 
              className="bg-transparent flex-1 px-6 py-3 text-sm md:text-lg font-light placeholder:opacity-30 outline-none"
              disabled={isManifesting}
            />
            <button 
              onClick={manifestIntent}
              disabled={isManifesting || !intent.trim()}
              className={`${isManifesting ? 'bg-gray-700 cursor-not-allowed px-4' : 'bg-cyan-500 hover:scale-105 active:scale-95 px-8'} text-black font-bold py-3 md:py-4 rounded-full transition-all flex items-center gap-2 text-xs md:text-sm`}
            >
              {isManifesting ? (
                <>
                  <div className="w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin"></div>
                  MANIFESTING...
                </>
              ) : 'COLLAPSE'}
            </button>
          </div>
        </div>
      </div>

      {/* Dashboard Grid */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0 overflow-hidden mb-4">
        
        {/* Left Column: Visuals & Sandbox */}
        <div className="lg:col-span-8 flex flex-col gap-6 overflow-hidden">
          <div className="flex-1 glass rounded-2xl flex flex-col overflow-hidden border-cyan-500/20 relative">
            <div className="flex justify-between items-center px-6 py-3 border-b border-white/5 shrink-0 bg-black/40">
              <div className="flex gap-6">
                <button 
                  onClick={() => setActiveTab('preview')}
                  className={`text-[10px] font-bold tracking-widest uppercase transition-all ${activeTab === 'preview' ? 'text-cyan-400' : 'opacity-40 hover:opacity-100'}`}
                >
                  Live_Preview
                </button>
                <button 
                  onClick={() => setActiveTab('artifacts')}
                  className={`text-[10px] font-bold tracking-widest uppercase transition-all ${activeTab === 'artifacts' ? 'text-cyan-400' : 'opacity-40 hover:opacity-100'}`}
                >
                  Source_Logic
                </button>
                <button 
                  onClick={() => setActiveTab('console')}
                  className={`text-[10px] font-bold tracking-widest uppercase transition-all ${activeTab === 'console' ? 'text-cyan-400' : 'opacity-40 hover:opacity-100'}`}
                >
                  Trace_Log
                </button>
              </div>
              <div className="flex items-center gap-4">
                 <span className="text-[9px] fira text-cyan-500/50 animate-pulse">Sovereign_Sandbox_Active</span>
              </div>
            </div>
            
            <div className="flex-1 relative overflow-hidden bg-black/20">
              {activeTab === 'preview' && (
                <div className="w-full h-full">
                  {artifacts.length > 0 && selectedArtifactIndex !== -1 ? (
                    <iframe 
                      key={artifacts[selectedArtifactIndex].timestamp}
                      srcDoc={artifacts[selectedArtifactIndex].content}
                      className="w-full h-full bg-white border-none"
                      title="Sovereign Sandbox"
                      sandbox="allow-scripts allow-modals allow-pointer-lock allow-forms"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center opacity-20 p-10 text-center">
                      <div className="w-20 h-20 border border-cyan-500/30 rounded-full mb-6 flex items-center justify-center animate-spin-slow">
                        <div className="w-2 h-2 bg-cyan-500 rounded-full"></div>
                      </div>
                      <p className="text-xs uppercase tracking-[0.3em] font-bold">Awaiting Waveform Collapse</p>
                      <p className="text-[9px] mt-2 fira">Input intent above to manifest artifact</p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'artifacts' && (
                <div className="w-full h-full p-6 overflow-y-auto">
                   {artifacts.length > 0 ? (
                     <div className="space-y-4">
                       <div className="flex justify-between items-center mb-4">
                          <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-widest">Manifestation History</h3>
                          <select 
                            className="bg-black/50 border border-white/10 text-[10px] p-1 rounded outline-none text-cyan-400"
                            onChange={(e) => setSelectedArtifactIndex(parseInt(e.target.value))}
                            value={selectedArtifactIndex}
                          >
                            {artifacts.map((a, i) => (
                              <option key={i} value={i}>{a.name}</option>
                            ))}
                          </select>
                       </div>
                       <pre className="text-[11px] fira opacity-80 whitespace-pre-wrap bg-black/40 p-6 rounded-xl border border-white/5 shadow-inner">
                         {artifacts[selectedArtifactIndex]?.content}
                       </pre>
                     </div>
                   ) : (
                    <div className="h-full flex items-center justify-center opacity-20 uppercase tracking-widest text-xs">No Artifacts in Vault</div>
                   )}
                </div>
              )}

              {activeTab === 'console' && (
                <div className="w-full h-full p-6 fira text-[11px] overflow-y-auto bg-black/40">
                   {logs.map((log, i) => (
                    <div key={i} className={`mb-1 ${log.includes('[FORGE]') ? 'text-cyan-400' : log.includes('[ERROR]') ? 'text-red-400' : 'opacity-60'}`}>
                      {log}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Library & Telemetry */}
        <div className="lg:col-span-4 flex flex-col gap-6 overflow-hidden">
          <div className="h-1/3 shrink-0">
             <TelemetryChart data={engine.history} target={engine.theta} />
          </div>
          
          <div className="flex-1 glass p-6 rounded-2xl flex flex-col overflow-hidden border-cyan-500/20">
            <div className="flex justify-between items-center mb-6 shrink-0">
              <h3 className="text-xs font-bold uppercase tracking-widest text-cyan-400">Axiom Library</h3>
              <span className="text-[9px] fira opacity-30">Active_Operators</span>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 space-y-3">
              {OPERATOR_LIBRARY.map((op) => (
                <OperatorCard 
                  key={op.id} 
                  operator={op} 
                  isActive={engine.activeOperators.includes(op.id)}
                  onClick={() => handleOperatorClick(op)}
                />
              ))}
            </div>
          </div>
        </div>

      </div>

      {/* Global Telemetry Bar */}
      <footer className="glass p-4 rounded-xl flex justify-between items-center border-white/5 shrink-0 select-none">
        <div className="flex gap-8 items-center">
          <div className="flex flex-col">
            <span className="text-[8px] uppercase opacity-40">System_R</span>
            <span className="text-xs fira text-cyan-400 font-bold">{engine.r.toFixed(5)}</span>
          </div>
          <div className="w-px h-4 bg-white/10"></div>
          <div className="flex flex-col">
            <span className="text-[8px] uppercase opacity-40">Volatility</span>
            <span className="text-xs fira text-purple-400 font-bold">{(engine.sigma * 100).toFixed(1)}%</span>
          </div>
          <div className="w-px h-4 bg-white/10"></div>
          <div className="flex flex-col">
            <span className="text-[8px] uppercase opacity-40">Artifacts</span>
            <span className="text-xs fira text-white font-bold">{artifacts.length}</span>
          </div>
        </div>
        
        <div className="text-[9px] fira opacity-30 uppercase tracking-widest hidden md:block">
           Z_ANCHOR_STATE: [SECURED] | KERNEL_LOAD: [STABLE]
        </div>

        <div className="flex gap-4">
           <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]"></div>
              <span className="text-[9px] font-bold uppercase tracking-tighter">Sovereign_Link</span>
           </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
