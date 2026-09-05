
import React, { useState, useCallback } from 'react';
import { synthesizeAsset } from './services/geminiService';
import { PipelineStatus, AssetManifest } from './types';
import Stage3D from './components/Stage3D';
import SCGViewer from './components/SCGViewer';
import AcousticConsole from './components/AcousticConsole';

const App: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<PipelineStatus>(PipelineStatus.IDLE);
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLOD, setSelectedLOD] = useState(0);

  const runPipeline = useCallback(async () => {
    if (!prompt) return;
    
    setStatus(PipelineStatus.SEMANTIC_ANALYSIS);
    setError(null);
    setManifest(null);
    setSelectedLOD(0);
    
    try {
      const data = await synthesizeAsset(prompt);
      
      // Explicit stages for LOD and Acoustic generation
      setTimeout(() => setStatus(PipelineStatus.GEOMETRY_SOLVE), 800);
      setTimeout(() => setStatus(PipelineStatus.LOD_GENERATION), 1800);
      setTimeout(() => setStatus(PipelineStatus.ACOUSTIC_SYNTHESIS), 3000);
      setTimeout(() => setStatus(PipelineStatus.RIGGING), 4200);
      setTimeout(() => setStatus(PipelineStatus.HARMONIZING), 5500);
      
      setTimeout(() => {
        setManifest({
          id: Math.random().toString(36).substr(2, 9),
          name: data.name,
          semanticTruth: data.scg,
          geometry: { lods: data.lods },
          rig: { joints: data.joints, weightsAssigned: true },
          usdSchema: data.usdCode,
          audio: data.audio
        });
        setStatus(PipelineStatus.COMPLETE);
      }, 6500);

    } catch (err: any) {
      setError(err.message || 'Pipeline collapsed under entropy.');
      setStatus(PipelineStatus.ERROR);
    }
  }, [prompt]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[#020205] text-slate-200 overflow-hidden">
      {/* Header */}
      <header className="h-16 border-b border-white/10 flex items-center justify-between px-8 glass z-50">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 rounded bg-cyan-500 animate-pulse glow-cyan" />
          <h1 className="text-xl font-bold tracking-tighter uppercase italic">Mythos <span className="text-cyan-400">Pipeline v1.1</span></h1>
        </div>
        <div className="flex items-center gap-6 fira text-[10px]">
          <div className="flex flex-col items-end">
            <span className="opacity-40 uppercase">Substrate State</span>
            <span className={status === PipelineStatus.ERROR ? 'text-red-400' : 'text-green-400'}>{status}</span>
          </div>
          <div className="w-px h-8 bg-white/10" />
          <div className="flex flex-col items-end">
            <span className="opacity-40 uppercase">Coherence</span>
            <span className="text-cyan-400 font-bold">99.991%</span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Controls & Audio */}
        <aside className="w-1/4 border-r border-white/10 flex flex-col p-6 space-y-6 glass overflow-y-auto">
          <section>
            <h3 className="text-[10px] font-bold uppercase tracking-widest opacity-40 mb-4">Intent Injection</h3>
            <div className="space-y-4">
              <textarea 
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe the asset lore (e.g. 'Rusted Iron Key with brass runes')..."
                className="w-full h-24 bg-slate-900/50 border border-white/10 rounded-xl p-4 focus:border-cyan-500 outline-none transition-all text-sm resize-none fira"
              />
              <button 
                onClick={runPipeline}
                disabled={status !== PipelineStatus.IDLE && status !== PipelineStatus.COMPLETE && status !== PipelineStatus.ERROR}
                className="w-full bg-cyan-500 hover:bg-cyan-400 disabled:opacity-30 text-black font-bold py-3 rounded-xl transition-all uppercase tracking-widest text-xs shadow-lg shadow-cyan-500/20"
              >
                Synthesize
              </button>
            </div>
          </section>

          {manifest && (
            <>
              <AcousticConsole events={manifest.audio.events} material={manifest.audio.material} />

              <section className="space-y-4 animate-in fade-in slide-in-from-left duration-700">
                <h3 className="text-[10px] font-bold uppercase tracking-widest opacity-40">Asset Metrics</h3>
                <div className="bg-slate-900/40 border border-white/5 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between text-xs">
                    <span className="opacity-50">LOD Tier</span>
                    <span className="text-cyan-400 font-bold">LOD {selectedLOD}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="opacity-50">Polygons</span>
                    <span>{manifest.geometry.lods[selectedLOD]?.polygons || 0}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="opacity-50">Vertices</span>
                    <span>{manifest.geometry.lods[selectedLOD]?.vertices || 0}</span>
                  </div>
                </div>
              </section>

              <section className="flex-1 overflow-hidden flex flex-col">
                <h3 className="text-[10px] font-bold uppercase tracking-widest opacity-40 mb-3">USD Source Output</h3>
                <div className="flex-1 bg-slate-950 rounded-xl p-4 overflow-y-auto fira text-[9px] text-slate-500 border border-white/5 whitespace-pre leading-tight">
                  {manifest.usdSchema}
                </div>
              </section>
            </>
          )}

          {error && (
            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs fira">
              CRITICAL_ERR: {error}
            </div>
          )}
        </aside>

        {/* Center/Right: Visualizers */}
        <section className="flex-1 flex flex-col relative">
          <div className="flex-1 relative">
            {manifest ? (
              <Stage3D joints={manifest.rig.joints} name={manifest.name} currentLOD={selectedLOD} />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center space-y-6">
                <div className="relative">
                  <div className="w-32 h-32 border border-cyan-500/20 rounded-full animate-ping absolute -inset-2" />
                  <div className="w-32 h-32 border-2 border-cyan-500/50 border-t-cyan-400 rounded-full animate-spin" />
                </div>
                <div className="text-center">
                  <p className="fira text-sm uppercase tracking-[0.3em] font-bold text-cyan-500/50">Awaiting Signal</p>
                  <p className="text-[10px] opacity-30 uppercase mt-2">Harmonization pipeline at zero-point</p>
                </div>
              </div>
            )}
            
            <div className="absolute top-6 right-6 flex flex-col items-end gap-2">
              <div className="bg-black/80 backdrop-blur-xl border border-white/10 px-5 py-2 rounded-full flex items-center gap-3 shadow-2xl">
                <div className={`w-2 h-2 rounded-full ${status === PipelineStatus.COMPLETE ? 'bg-green-500 shadow-[0_0_10px_#22c55e]' : 'bg-cyan-500 animate-pulse shadow-[0_0_10px_#06b6d4]'}`} />
                <span className="fira text-[10px] tracking-widest uppercase font-bold">{status}</span>
              </div>
            </div>

            {/* Stage Controls with LOD Switching */}
            {manifest && (
              <div className="absolute bottom-6 left-6 flex gap-3 p-1 bg-black/40 backdrop-blur-md rounded-xl border border-white/10">
                {manifest.geometry.lods.map((lod, idx) => (
                  <button 
                    key={idx}
                    onClick={() => setSelectedLOD(idx)}
                    className={`px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${selectedLOD === idx ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-500/20' : 'hover:bg-white/5 text-white/60'}`}
                  >
                    LOD_{lod.level}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Bottom Graph View */}
          <div className="h-1/3 border-t border-white/10 p-6 flex flex-col space-y-4 glass">
            <div className="flex justify-between items-center">
              <h3 className="text-[10px] font-bold uppercase tracking-widest opacity-40">Semantic Consistency Graph (SCG)</h3>
              <div className="flex gap-4 text-[9px] fira uppercase opacity-50">
                <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-cyan-500" /> Entity</div>
                <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-red-500" /> Constraint</div>
                <div className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-purple-500" /> Property</div>
              </div>
            </div>
            <div className="flex-1">
              {manifest && (
                <SCGViewer 
                  nodes={manifest.semanticTruth.nodes} 
                  links={manifest.semanticTruth.links} 
                />
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="h-8 bg-black border-t border-white/5 flex items-center justify-between px-8 text-[9px] fira opacity-40 uppercase tracking-widest">
        <span>Mythos Asset Synthesis | LOD & Acoustic Kernel Active</span>
        <div className="flex gap-4">
          <span>Thread_ID: {Math.random().toString(16).slice(2, 10)}</span>
          <span className="text-cyan-500">System_01_Online</span>
        </div>
      </footer>
    </div>
  );
};

export default App;
