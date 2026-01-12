
import React, { useState } from 'react';
import { AssetType, DetailLevel, AssetManifest, AppState } from './types';
import { manifestAsset, generateVisualConcept, editVisualConcept, refineMaterial } from './services/geminiService';
import { AssetPreview } from './components/AssetPreview';
import { 
  Box, 
  Layers, 
  Terminal, 
  Sparkles, 
  Activity, 
  ChevronRight, 
  Database, 
  Zap,
  Cpu,
  RefreshCw,
  Search,
  AlertCircle,
  Download,
  Copy,
  Image as ImageIcon
} from 'lucide-react';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    isManifesting: false,
    isGeneratingVisual: false,
    manifest: null,
    history: [],
    activeTab: 'specs'
  });

  const [prompt, setPrompt] = useState('');
  const [assetType, setAssetType] = useState<AssetType>(AssetType.PROP);
  const [detailLevel, setDetailLevel] = useState<DetailLevel>(DetailLevel.GAME_READY);
  const [error, setError] = useState<string | null>(null);

  const handleManifest = async () => {
    if (!prompt || state.isManifesting) return;
    
    setError(null);
    setState(prev => ({ ...prev, isManifesting: true, activeTab: 'specs' }));
    
    try {
      // 1. Technical blueprinting
      const manifest = await manifestAsset(prompt, assetType, detailLevel);
      
      setState(prev => ({
        ...prev,
        isManifesting: false,
        isGeneratingVisual: true,
        manifest: manifest,
      }));

      // 2. Latent visual synthesis
      try {
        const visualUrl = await generateVisualConcept(`${manifest.name}: ${manifest.description}. Detailed 3D asset view, ${manifest.style} style.`);
        const manifestWithVisual = { ...manifest, visualUrl };
        
        setState(prev => ({
          ...prev,
          isGeneratingVisual: false,
          manifest: manifestWithVisual,
          history: [manifestWithVisual, ...prev.history.filter(h => h.name !== manifestWithVisual.name)].slice(0, 15)
        }));
      } catch (visErr) {
        console.error("Visual generation failed:", visErr);
        setState(prev => ({ 
          ...prev, 
          isGeneratingVisual: false,
          history: [manifest, ...prev.history.filter(h => h.name !== manifest.name)].slice(0, 15) 
        }));
      }

    } catch (err) {
      console.error(err);
      setError("Substrate collapse detected. Attempting to re-stabilize... (API Error)");
      setState(prev => ({ ...prev, isManifesting: false }));
    }
  };

  const handleEditVisual = async (editPrompt: string) => {
    if (!state.manifest?.visualUrl || state.isGeneratingVisual) return;

    setState(prev => ({ ...prev, isGeneratingVisual: true }));
    try {
      const updatedVisualUrl = await editVisualConcept(state.manifest.visualUrl, editPrompt);
      setState(prev => {
        if (!prev.manifest) return prev;
        const updatedManifest = { ...prev.manifest, visualUrl: updatedVisualUrl };
        return {
          ...prev,
          isGeneratingVisual: false,
          manifest: updatedManifest,
          history: prev.history.map(h => h.name === updatedManifest.name ? updatedManifest : h)
        };
      });
    } catch (err) {
      console.error("Visual edit failed:", err);
      setError("Visual mutation failed. Current substrate stable.");
      setState(prev => ({ ...prev, isGeneratingVisual: false }));
    }
  };

  const handleRefineMaterial = async (index: number, refinement: string) => {
    if (!state.manifest || state.isManifesting) return;
    
    setState(prev => ({ ...prev, isManifesting: true }));
    try {
      const currentMaterial = state.manifest.pbrNodes[index];
      const updatedMaterial = await refineMaterial(currentMaterial, refinement);
      
      setState(prev => {
        if (!prev.manifest) return prev;
        const newNodes = [...prev.manifest.pbrNodes];
        newNodes[index] = updatedMaterial;
        const updatedManifest = { ...prev.manifest, pbrNodes: newNodes };
        return {
          ...prev,
          isManifesting: false,
          manifest: updatedManifest,
          history: prev.history.map(h => h.name === updatedManifest.name ? updatedManifest : h)
        };
      });
    } catch (err) {
      console.error("Material refinement failed:", err);
      setError("Material node refinement failed.");
      setState(prev => ({ ...prev, isManifesting: false }));
    }
  };

  const setTab = (tab: AppState['activeTab']) => {
    setState(prev => ({ ...prev, activeTab: tab }));
  };

  const exportJson = () => {
    if (!state.manifest) return;
    const blob = new Blob([JSON.stringify(state.manifest, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `AETHELGARD_${state.manifest.name.replace(/\s+/g, '_')}_Manifest.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const cloneSeed = () => {
    if (!state.manifest) return;
    setPrompt(state.manifest.description);
    setAssetType(state.manifest.type);
    document.getElementById('manifest-input')?.focus();
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#020205] text-[#d1d1f0]">
      {/* Background Decor */}
      <div className="fixed inset-0 pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-cyan-500/20 blur-[150px] rounded-full"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-pink-500/10 blur-[150px] rounded-full"></div>
        <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-10"></div>
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5 bg-black/20 backdrop-blur-md px-8 py-4 flex justify-between items-center shadow-[0_4px_30px_rgba(0,0,0,0.5)]">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-cyan-500/10 border border-cyan-500/40 rounded-lg flex items-center justify-center shadow-[0_0_20px_rgba(6,182,212,0.2)] hover:scale-105 transition-transform duration-300">
            <Box className="text-cyan-400 w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-[0.2em] uppercase italic glow-cyan">AETHELGARD</h1>
            <p className="text-[9px] fira opacity-40 tracking-widest uppercase flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
              Sovereign Asset Forge v7.5
            </p>
          </div>
        </div>

        <div className="flex gap-6">
          <div className="text-right">
            <p className="text-[8px] opacity-30 uppercase tracking-widest mb-1">Coherence</p>
            <p className="text-sm font-bold fira text-cyan-400">
              {state.isManifesting || state.isGeneratingVisual ? 'COLLAPSING...' : '99.998%'}
            </p>
          </div>
          <div className="w-px h-8 bg-white/10"></div>
          <div className="text-right">
            <p className="text-[8px] opacity-30 uppercase tracking-widest mb-1">Vault_Entropy</p>
            <p className="text-sm font-bold fira text-pink-500">0.0001</p>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1 flex flex-col lg:flex-row p-6 gap-6 overflow-hidden">
        {/* Left Control Column */}
        <section className="w-full lg:w-96 flex flex-col gap-6">
          <div className="glass p-6 rounded-3xl flex flex-col gap-6 shadow-2xl">
            <div className="space-y-2">
              <label className="text-[10px] font-bold opacity-40 uppercase tracking-widest flex items-center gap-2">
                <Sparkles className="w-3 h-3 text-cyan-400" /> Manifestation Intent
              </label>
              <textarea 
                id="manifest-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. A hyper-realistic floating observatory with glass domes and brass structures..."
                className="w-full h-32 bg-black/40 border border-white/10 rounded-2xl p-4 text-sm focus:border-cyan-500/40 transition-all outline-none resize-none fira placeholder:opacity-20 hover:border-white/20"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold opacity-40 uppercase tracking-widest">Asset Category</label>
                <select 
                  value={assetType}
                  onChange={(e) => setAssetType(e.target.value as AssetType)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs outline-none focus:border-cyan-500/40 cursor-pointer hover:bg-black/60 transition-colors"
                >
                  {Object.values(AssetType).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold opacity-40 uppercase tracking-widest">Detail Paradigm</label>
                <select 
                  value={detailLevel}
                  onChange={(e) => setDetailLevel(e.target.value as DetailLevel)}
                  className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs outline-none focus:border-cyan-500/40 cursor-pointer hover:bg-black/60 transition-colors"
                >
                  {Object.values(DetailLevel).map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 p-3 rounded-xl flex items-start gap-3 text-red-400 animate-in fade-in slide-in-from-top-2 duration-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="text-[11px] leading-tight fira">{error}</p>
              </div>
            )}

            <button 
              onClick={handleManifest}
              disabled={state.isManifesting || state.isGeneratingVisual || !prompt}
              className={`w-full py-4 rounded-2xl font-bold tracking-widest text-sm transition-all flex items-center justify-center gap-3 overflow-hidden group relative
                ${(state.isManifesting || state.isGeneratingVisual) ? 'bg-white/5 text-white/20 cursor-not-allowed shadow-none' : 'bg-cyan-500 text-black hover:scale-[1.02] active:scale-95 shadow-[0_0_30px_rgba(6,182,212,0.3)] cursor-pointer hover:bg-cyan-400'}
              `}
            >
              <div className={`absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full ${state.isManifesting || state.isGeneratingVisual ? '' : 'group-hover:translate-x-full'} transition-transform duration-700`}></div>
              {state.isManifesting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  ARCHITECTING DNA...
                </>
              ) : state.isGeneratingVisual ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  SYNTHESIZING VIZ...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 fill-current group-hover:animate-pulse" />
                  MANIFEST_COLLAPSE
                </>
              )}
            </button>
          </div>

          <div className="glass flex-1 rounded-3xl p-6 flex flex-col gap-4 overflow-hidden shadow-2xl">
            <h3 className="text-[10px] font-bold opacity-40 uppercase tracking-widest flex items-center justify-between">
              Chronos_Vault <span className="fira text-[9px] opacity-100">{state.history.length}/15</span>
            </h3>
            <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
              {state.history.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-10 text-center p-8">
                  <Database className="w-10 h-10 mb-4" />
                  <p className="text-[10px] uppercase tracking-widest fira">Empty Manifest Stream</p>
                </div>
              ) : (
                state.history.map((h, i) => (
                  <button 
                    key={i} 
                    onClick={() => setState(prev => ({ ...prev, manifest: h, activeTab: 'specs' }))}
                    className={`w-full text-left p-4 rounded-2xl border transition-all flex gap-3 items-center group relative overflow-hidden ${state.manifest?.name === h.name ? 'border-cyan-500/40 bg-cyan-500/5' : 'border-white/5 hover:bg-white/5'} cursor-pointer`}
                  >
                    {h.visualUrl ? (
                      <div className="w-12 h-12 rounded-lg overflow-hidden border border-white/10 shrink-0 group-hover:border-cyan-500/40 transition-colors">
                        <img src={h.visualUrl} className="w-full h-full object-cover" alt="" />
                      </div>
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-white/5 border border-white/10 shrink-0 flex items-center justify-center">
                        <Box className="w-5 h-5 opacity-20" />
                      </div>
                    )}
                    <div className="overflow-hidden">
                      <div className="flex justify-between items-center mb-0.5">
                        <span className="text-[10px] font-bold uppercase truncate pr-2 text-white group-hover:text-cyan-400 transition-colors">{h.name}</span>
                      </div>
                      <p className="text-[9px] opacity-40 truncate fira uppercase tracking-tighter">{h.type} | {h.style}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Right Preview Column */}
        <section className="flex-1 flex flex-col gap-6 overflow-hidden">
          {state.manifest ? (
            <div className="glass rounded-3xl flex-1 flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500 shadow-2xl">
              <nav className="p-4 border-b border-white/5 flex gap-1 bg-black/20 overflow-x-auto no-scrollbar">
                {[
                  { id: 'specs', label: 'Geometric_Specs', icon: Layers },
                  { id: 'pbr', label: 'PBR_Manifest', icon: Activity },
                  { id: 'visual', label: 'Visual_Seed', icon: ImageIcon },
                  { id: 'prompts', label: 'Synthesis_Seeds', icon: Sparkles },
                  { id: 'code', label: 'Integration_Kernel', icon: Terminal },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id as any)}
                    className={`flex items-center gap-2 px-6 py-2 rounded-xl text-[10px] font-bold tracking-widest uppercase transition-all shrink-0 cursor-pointer
                      ${state.activeTab === t.id ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-[0_0_10px_rgba(6,182,212,0.2)]' : 'opacity-40 hover:opacity-100'}
                    `}
                  >
                    <t.icon className="w-3 h-3" />
                    <span className="hidden sm:inline">{t.label}</span>
                  </button>
                ))}
              </nav>

              <div className="flex-1 overflow-y-auto custom-scrollbar">
                <AssetPreview 
                  manifest={state.manifest} 
                  activeTab={state.activeTab} 
                  onEditVisual={handleEditVisual}
                  onRefineMaterial={handleRefineMaterial}
                  isEditing={state.isGeneratingVisual || state.isManifesting}
                />
              </div>

              <footer className="p-4 border-t border-white/5 bg-black/40 flex flex-wrap gap-4 justify-between items-center shadow-[0_-4px_30px_rgba(0,0,0,0.5)]">
                <div className="flex items-center gap-3">
                   <div className="flex -space-x-2">
                     <div className="w-7 h-7 rounded-full border border-[#020205] bg-cyan-500 flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.5)]"><Cpu className="w-4 h-4 text-black" /></div>
                     <div className="w-7 h-7 rounded-full border border-[#020205] bg-pink-500 flex items-center justify-center shadow-[0_0_15px_rgba(236,72,153,0.5)]"><Zap className="w-4 h-4 text-black" /></div>
                   </div>
                   <span className="text-[10px] fira opacity-40 uppercase tracking-tighter">Manifest Verified & Anchored</span>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={exportJson}
                    className="text-[10px] font-bold px-4 py-2 border border-white/10 rounded-lg hover:bg-white/5 transition-all uppercase flex items-center gap-2 cursor-pointer hover:border-white/30"
                  >
                    <Download className="w-3 h-3" /> Export JSON
                  </button>
                  <button 
                    onClick={cloneSeed}
                    className="text-[10px] font-bold px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-all uppercase flex items-center gap-2 cursor-pointer hover:border-white/30"
                  >
                    <Copy className="w-3 h-3" /> Clone Seed
                  </button>
                </div>
              </footer>
            </div>
          ) : (
            <div className="glass rounded-3xl flex-1 flex flex-col items-center justify-center text-center p-12 shadow-2xl">
              <div className="w-32 h-32 mb-8 rounded-full border border-cyan-500/10 flex items-center justify-center bg-cyan-500/5 animate-pulse relative">
                <div className="absolute inset-0 rounded-full border-2 border-cyan-500/20 animate-ping"></div>
                <div className="absolute inset-4 rounded-full border border-cyan-400/30 animate-spin duration-[4000ms]"></div>
                <Search className="w-12 h-12 text-cyan-400 opacity-40" />
              </div>
              <h2 className="text-4xl font-light tracking-tighter mb-4 italic">Awaiting <span className="text-cyan-400">Intent Injection</span></h2>
              <p className="max-w-md text-sm opacity-40 leading-relaxed fira tracking-tight">
                Provide a descriptive objective. The Sovereign Forge will decompose your intent into technical blueprints, material nodes, and latent synthesis seeds.
              </p>
            </div>
          )}
        </section>
      </main>

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass px-8 py-2.5 rounded-full border-white/10 flex items-center gap-8 z-50 shadow-[0_10px_40px_rgba(0,0,0,0.8)] border-white/5">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${state.isManifesting || state.isGeneratingVisual ? 'bg-amber-400 shadow-[0_0_8px_#fbbf24]' : 'bg-cyan-400 shadow-[0_0_8px_#22d3ee]'} animate-pulse`}></div>
          <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">Substrate_{state.isManifesting || state.isGeneratingVisual ? 'Processing' : 'Active'}</span>
        </div>
        <div className="h-4 w-px bg-white/10"></div>
        <div className="flex items-center gap-3">
          <ChevronRight className="w-4 h-4 opacity-20" />
          <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">Lattice: <span className="text-cyan-400 fira">72-Axiom Convergence</span></span>
        </div>
        <div className="h-4 w-px bg-white/10"></div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">Seed: <span className="text-white fira">X-8809_PRIME</span></span>
        </div>
      </div>
    </div>
  );
};

export default App;
