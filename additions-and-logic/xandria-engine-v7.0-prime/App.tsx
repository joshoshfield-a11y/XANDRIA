
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Operator, Artifact, TraceEntry, OperatorType, Asset, Commit } from './types';
import { OPERATORS } from './constants';
import { manifestIntent } from './services/geminiService';
import LatticeVisualizer from './components/LatticeVisualizer';
import ArtifactViewer from './components/ArtifactViewer';
import AssetStore from './components/AssetStore';
import VCSHistory from './components/VCSHistory';
import JSZip from 'jszip';

const App: React.FC = () => {
  const [intent, setIntent] = useState('');
  const [isManifesting, setIsManifesting] = useState(false);
  const [coherence, setCoherence] = useState(99.9982);
  const [activeTab, setActiveTab] = useState<'vault' | 'trace' | 'artifact' | 'preview' | 'vcs' | 'store'>('trace');
  const [vault, setVault] = useState<Artifact[]>([]);
  const [currentArtifact, setCurrentArtifact] = useState<Artifact | null>(null);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [activeNodes, setActiveNodes] = useState<Set<string>>(new Set());
  const [assetLibrary, setAssetLibrary] = useState<Asset[]>([]);

  const traceEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    addTrace('Xandria Substrate v7.0 Prime Online.', 'SYSTEM');
    addTrace('Grounding Matrix: Connected.', 'SYSTEM');
    addTrace('Chronos Temporal Storage Ready.', 'SYSTEM');
    
    const saved = localStorage.getItem('xandria_v7_manifest_vault');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setVault(parsed);
        if (parsed.length > 0) setCurrentArtifact(parsed[0]);
      } catch (e) {
        console.error("Vault desync", e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('xandria_v7_manifest_vault', JSON.stringify(vault));
  }, [vault]);

  useEffect(() => {
    traceEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [trace]);

  const addTrace = (message: string, type: TraceEntry['type']) => {
    setTrace(prev => [
      ...prev, 
      { id: Math.random().toString(36), timestamp: Date.now(), message, type }
    ]);
  };

  const manifest = async () => {
    if (!intent.trim() || isManifesting) return;

    setIsManifesting(true);
    addTrace(`Injecting Intent: "${intent}"`, 'VOICE');
    addTrace("Resolving Probability Waveform...", 'SYSTEM');
    
    const nodeSequence = ['02', '31', '32', '13', '25', '41', '65', '72'];
    for (const node of nodeSequence) {
      setActiveNodes(prev => new Set(prev).add(node));
      await new Promise(resolve => setTimeout(resolve, 60));
    }

    try {
      const result = await manifestIntent(intent, assetLibrary);
      
      const commit: Commit = {
        id: Math.random().toString(36).replace('0.', ''),
        timestamp: Date.now(),
        message: `Genesis Manifestation: ${intent.slice(0, 40)}`,
        files: result.files || {},
        sceneConfig: result
      };

      if (currentArtifact) {
        const updatedArtifact = {
          ...currentArtifact,
          branches: {
            ...currentArtifact.branches,
            [currentArtifact.currentBranch]: [commit, ...currentArtifact.branches[currentArtifact.currentBranch]]
          },
          sceneConfig: result
        };
        setVault(prev => prev.map(a => a.id === updatedArtifact.id ? updatedArtifact : a));
        setCurrentArtifact(updatedArtifact);
        addTrace(`Chronos: Commit ${commit.id.slice(0,8)} verified.`, 'VCS');
      } else {
        const newArtifact: Artifact = {
          id: Math.random().toString(36).replace('0.', ''),
          intent,
          timestamp: Date.now(),
          currentBranch: 'main',
          branches: { main: [commit] },
          sceneConfig: result,
          assetReferences: [...assetLibrary]
        };
        setVault(prev => [newArtifact, ...prev]);
        setCurrentArtifact(newArtifact);
        addTrace(`VCS: New repository initialized at ${newArtifact.id.slice(0,8)}`, 'VCS');
      }

      addTrace("Waveform collapse complete. Artifact solidified.", 'RESULT');
      setCoherence(prev => Math.min(99.9999, prev + 0.0003));
      setActiveTab('preview');
      setIntent('');
    } catch (error) {
      addTrace(`Substrate Error: ${error instanceof Error ? error.message : 'Dissonance detected'}`, 'ERROR');
    } finally {
      setIsManifesting(false);
      setTimeout(() => setActiveNodes(new Set()), 1000);
    }
  };

  const manualCommit = () => {
    if (!currentArtifact) return;
    const msg = prompt("Commit signature:");
    if (!msg) return;

    const commit: Commit = {
      id: Math.random().toString(36).replace('0.', ''),
      timestamp: Date.now(),
      message: msg,
      files: { ...currentArtifact.branches[currentArtifact.currentBranch][0].files },
      sceneConfig: currentArtifact.sceneConfig
    };

    const updated = {
      ...currentArtifact,
      branches: {
        ...currentArtifact.branches,
        [currentArtifact.currentBranch]: [commit, ...currentArtifact.branches[currentArtifact.currentBranch]]
      }
    };
    setCurrentArtifact(updated);
    setVault(prev => prev.map(a => a.id === updated.id ? updated : a));
    addTrace(`Chronos: Snapshot ${commit.id.slice(0,8)} recorded.`, 'VCS');
  };

  const mergeBranch = (source: string) => {
    if (!currentArtifact) return;
    const sourceCommit = currentArtifact.branches[source][0];
    const targetBranch = currentArtifact.currentBranch;

    const mergeCommit: Commit = {
      id: Math.random().toString(36).replace('0.', ''),
      timestamp: Date.now(),
      message: `Merge Timeline: '${source}' → '${targetBranch}'`,
      files: { ...sourceCommit.files },
      sceneConfig: { ...sourceCommit.sceneConfig }
    };

    const updated = {
      ...currentArtifact,
      branches: {
        ...currentArtifact.branches,
        [targetBranch]: [mergeCommit, ...currentArtifact.branches[targetBranch]]
      },
      sceneConfig: mergeCommit.sceneConfig
    };
    setCurrentArtifact(updated);
    setVault(prev => prev.map(a => a.id === updated.id ? updated : a));
    addTrace(`VCS: Merged branch '${source}' into current.`, 'VCS');
    setActiveTab('preview');
  };

  const exportProject = async () => {
    if (!currentArtifact) return;
    addTrace("Aggregating project substrate...", "SYSTEM");
    const zip = new JSZip();
    const currentFiles = currentArtifact.branches[currentArtifact.currentBranch][0].files;
    
    Object.entries(currentFiles).forEach(([name, content]) => {
      zip.file(name, content);
    });
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `manifest-${currentArtifact.id.slice(0,6)}.zip`;
    a.click();
    addTrace("Artifact exported successfully.", "RESULT");
  };

  const importAsset = (asset: Asset) => {
    setAssetLibrary(prev => [...prev, asset]);
    addTrace(`Forge Context Update: Imported ${asset.name}.`, 'SYSTEM');
  };

  const restoreCommit = (commit: Commit) => {
    if (!currentArtifact) return;
    const updated = { ...currentArtifact, sceneConfig: commit.sceneConfig };
    setCurrentArtifact(updated);
    setVault(prev => prev.map(a => a.id === updated.id ? updated : a));
    addTrace(`Chronos: Timeline reverted to ${commit.id.slice(0,8)}`, 'VCS');
    setActiveTab('preview');
  };

  const createBranch = (name: string) => {
    if (!currentArtifact) return;
    if (currentArtifact.branches[name]) return addTrace(`Branch ${name} already exists.`, 'ERROR');
    
    const updated = {
      ...currentArtifact,
      currentBranch: name,
      branches: {
        ...currentArtifact.branches,
        [name]: [...currentArtifact.branches[currentArtifact.currentBranch]]
      }
    };
    setCurrentArtifact(updated);
    setVault(prev => prev.map(a => a.id === updated.id ? updated : a));
    addTrace(`VCS: Timeline forked: "${name}"`, 'VCS');
  };

  const switchBranch = (name: string) => {
    if (!currentArtifact) return;
    const updated = { ...currentArtifact, currentBranch: name, sceneConfig: currentArtifact.branches[name][0].sceneConfig };
    setCurrentArtifact(updated);
    setVault(prev => prev.map(a => a.id === updated.id ? updated : a));
    addTrace(`VCS: Switched focus to "${name}"`, 'VCS');
    setActiveTab('preview');
  };

  return (
    <div className="h-screen w-screen flex flex-col p-8 relative overflow-hidden selection:bg-cyan-500/20 text-cyan-50">
      <LatticeVisualizer />

      {/* Sovereign Header */}
      <header className="flex justify-between items-start z-10">
        <div className="glass p-6 rounded-[2rem] flex flex-col gap-1 border-cyan-500/30 shadow-[0_0_30px_rgba(0,243,255,0.1)]">
          <div className="flex items-center gap-4">
            <div className={`w-3 h-3 rounded-full bg-cyan-400 ${isManifesting ? 'animate-ping' : 'animate-pulse'}`} />
            <h1 className="text-2xl font-bold tracking-[0.2em] glitch-text uppercase italic">Xandria v7.0 Prime</h1>
          </div>
          <p className="text-[10px] fira opacity-40 tracking-[0.1em] uppercase">
            STATUS: <span className="text-cyan-400 font-bold">{isManifesting ? 'ACTIVE_COLLAPSE' : 'QUASI_STABLE'}</span> | 
            CORE: <span className="text-white/60">HYPER_ENGINE_READY</span>
          </p>
        </div>

        <div className="flex gap-4">
          <div className="glass p-6 rounded-[2.5rem] flex gap-12 items-center border-white/5 shadow-2xl backdrop-blur-3xl">
            <div className="text-center">
              <p className="text-[9px] opacity-30 uppercase mb-1 tracking-widest font-bold">Lattice Coherence</p>
              <p className="text-2xl font-bold text-cyan-400 fira">{coherence.toFixed(4)}%</p>
            </div>
            <div className="w-px h-12 bg-white/5" />
            <div className="flex flex-col items-end gap-1">
               <div className="flex gap-6">
                  <button 
                    onClick={() => setVault([])}
                    className="text-[9px] font-bold text-pink-500/60 hover:text-pink-400 transition-colors uppercase tracking-[0.15em]"
                  >
                    PURGE_LATTICE
                  </button>
                  <button 
                    onClick={exportProject}
                    disabled={!currentArtifact}
                    className="text-[9px] font-bold text-cyan-400 hover:text-cyan-300 transition-colors uppercase tracking-[0.15em] disabled:opacity-10"
                  >
                    DEPLOY_ARTIFACT
                  </button>
               </div>
               <button className="bg-cyan-500/5 hover:bg-cyan-500/10 border border-cyan-500/20 px-6 py-2 rounded-2xl text-[10px] font-bold tracking-widest transition-all text-cyan-400 uppercase">System_Evolution</button>
            </div>
          </div>
        </div>
      </header>

      {/* Core Manifestation Unit */}
      <main className="flex-1 flex flex-col items-center justify-center z-10 px-4">
        <div className="w-full max-w-5xl space-y-20">
          <div className="text-center space-y-6">
            <h2 className="text-8xl font-light tracking-tighter leading-none select-none">
              Infinite <span className="text-cyan-400 italic">Manifestation</span>
            </h2>
            <div className="flex items-center justify-center gap-6 opacity-30">
               <div className="h-px w-20 bg-gradient-to-r from-transparent to-white" />
               <p className="text-xs fira uppercase tracking-[0.4em]">Substrate Logic Active</p>
               <div className="h-px w-20 bg-gradient-to-l from-transparent to-white" />
            </div>
          </div>
          
          <div className="glass p-3 rounded-full flex items-center pr-6 border-cyan-500/20 group focus-within:ring-[20px] focus-within:ring-cyan-500/5 transition-all duration-700 shadow-[0_0_100px_rgba(0,0,0,0.4)] backdrop-blur-3xl relative">
            <div className="absolute inset-0 rounded-full bg-gradient-to-r from-cyan-500/5 to-purple-500/5 opacity-0 group-focus-within:opacity-100 transition-opacity" />
            <input 
              type="text" 
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && manifest()}
              placeholder="Inject objective into the forge..." 
              className="bg-transparent flex-1 px-10 py-7 text-2xl font-light placeholder:opacity-10 outline-none text-cyan-50 z-10"
            />
            <button 
              onClick={manifest}
              disabled={isManifesting}
              className={`bg-cyan-500 text-black font-bold px-16 py-7 rounded-full hover:scale-105 active:scale-95 transition-all flex items-center gap-4 shadow-2xl shadow-cyan-500/30 z-10 ${isManifesting ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {isManifesting ? (
                <>
                  <span className="w-5 h-5 border-3 border-black border-t-transparent animate-spin rounded-full" />
                  COLLAPSING
                </>
              ) : (
                <>MANIFEST</>
              )}
            </button>
          </div>
        </div>
      </main>

      {/* System Readouts */}
      <footer className="h-[24rem] grid grid-cols-5 gap-10 z-10 mt-12 mb-4">
        <div className="glass p-8 rounded-[2.5rem] col-span-1 overflow-hidden flex flex-col border-white/5 shadow-2xl">
          <h3 className="text-[10px] font-bold opacity-30 uppercase mb-8 tracking-[0.2em]">Axiomatic Lattice</h3>
          <div className="grid grid-cols-4 gap-4 flex-1 content-start">
            {OPERATORS.map((op) => (
              <div 
                key={op.id}
                title={`${op.name}: ${op.description}`}
                className={`aspect-square rounded-xl border border-white/5 transition-all duration-1000 ${activeNodes.has(op.id) ? 'node-active' : 'bg-white/5 hover:bg-white/10'}`}
              />
            ))}
          </div>
          <button 
            onClick={manualCommit}
            disabled={!currentArtifact}
            className="mt-6 bg-white/5 hover:bg-cyan-500/20 border border-white/10 text-[9px] py-3 rounded-2xl text-white/30 hover:text-cyan-400 uppercase tracking-widest disabled:opacity-0 transition-all font-bold"
          >
            Chronos_Snapshot
          </button>
        </div>

        <div className="glass p-10 rounded-[2.5rem] col-span-4 overflow-hidden flex flex-col border-white/10 shadow-2xl backdrop-blur-3xl">
          <div className="flex justify-between items-center mb-10 pb-6 border-b border-white/5">
            <div className="flex gap-12">
              {(['trace', 'preview', 'vcs', 'store', 'artifact'] as const).map(tab => (
                <button 
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`text-[12px] font-bold tracking-[0.15em] uppercase transition-all pb-6 -mb-6 ${activeTab === tab ? 'text-cyan-400 border-b-2 border-cyan-400 opacity-100' : 'opacity-20 hover:opacity-100'}`}
                >
                  {tab === 'store' ? 'ASSET_FORGE' : tab === 'vcs' ? 'TEMPORAL_VCS' : tab.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-6">
              {assetLibrary.length > 0 && (
                <span className="text-[10px] bg-cyan-500/10 text-cyan-400 px-4 py-1.5 rounded-full border border-cyan-500/20 font-bold fira">
                  {assetLibrary.length} ASSETS_LOCALIZED
                </span>
              )}
              {currentArtifact && (
                <div className="flex items-center gap-3">
                   <div className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse" />
                   <span className="text-[10px] text-white/40 fira uppercase tracking-widest">
                     Lattice: <span className="text-cyan-400">{currentArtifact.currentBranch}</span>
                   </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 custom-scroll">
            {activeTab === 'trace' && (
              <div className="fira text-[13px] leading-relaxed opacity-60 space-y-3 pr-4">
                {trace.map(entry => (
                  <div key={entry.id} className="flex gap-6 animate-in fade-in slide-in-from-left-4 duration-500">
                    <span className={`font-bold shrink-0 tracking-tighter ${entry.type === 'ERROR' ? 'text-pink-500' : entry.type === 'VCS' ? 'text-purple-400 font-medium' : entry.type === 'RESULT' ? 'text-cyan-400' : 'text-cyan-700'}`}>
                      [{entry.type}]
                    </span>
                    <span className="text-white/90 font-light">{entry.message}</span>
                  </div>
                ))}
                <div ref={traceEndRef} />
              </div>
            )}

            {activeTab === 'preview' && (
              <div className="w-full h-full animate-in zoom-in-95 duration-1000">
                {currentArtifact ? (
                  <ArtifactViewer sceneConfig={currentArtifact.sceneConfig} />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center opacity-10 italic fira text-xl space-y-6">
                    <div className="w-24 h-24 border-2 border-dashed border-white rounded-full animate-spin-slow" />
                    <p className="tracking-widest">Awaiting Manifestation Command...</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'vcs' && (
              currentArtifact ? (
                <VCSHistory 
                  commits={currentArtifact.branches[currentArtifact.currentBranch]} 
                  currentBranch={currentArtifact.currentBranch}
                  allBranches={Object.keys(currentArtifact.branches)}
                  onRestore={restoreCommit}
                  onBranch={createBranch}
                  onSwitch={switchBranch}
                  onMerge={mergeBranch}
                />
              ) : (
                <div className="text-center opacity-10 py-32 italic text-lg tracking-widest uppercase fira">No Repositories Synchronized.</div>
              )
            )}

            {activeTab === 'store' && (
              <AssetStore 
                onImport={importAsset} 
                importedIds={assetLibrary.map(a => a.id)}
              />
            )}

            {activeTab === 'artifact' && (
              <div className="space-y-10 pr-4">
                {currentArtifact ? Object.entries(currentArtifact.branches[currentArtifact.currentBranch][0].files).map(([name, content]) => (
                  <div key={name} className="space-y-4 group">
                    <div className="flex justify-between items-center px-4">
                      <p className="text-[11px] font-bold opacity-20 uppercase tracking-[0.3em] fira">// manifest://{name}</p>
                      <button 
                        onClick={() => {
                          navigator.clipboard.writeText(content);
                          addTrace(`Copied ${name} to buffer.`, 'SYSTEM');
                        }}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-cyan-500 hover:text-cyan-400 transition-all font-bold"
                      >
                        SYNC_TO_CLIPBOARD
                      </button>
                    </div>
                    <pre className="glass p-8 rounded-3xl fira text-[13px] text-cyan-100/60 overflow-x-auto border-white/5 bg-black/50 shadow-inner">
                      <code>{content}</code>
                    </pre>
                  </div>
                )) : (
                  <div className="text-center opacity-10 py-32 italic text-lg tracking-widest uppercase fira">No Artifact Data Found.</div>
                )}
              </div>
            )}
          </div>
        </div>
      </footer>
      
      <style>{`
        @keyframes spin-slow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-spin-slow {
          animation: spin-slow 15s linear infinite;
        }
        .custom-scroll::-webkit-scrollbar {
          width: 5px;
        }
        .custom-scroll::-webkit-scrollbar-thumb {
          background: rgba(0, 243, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 243, 255, 0.3);
        }
      `}</style>
    </div>
  );
};

export default App;
