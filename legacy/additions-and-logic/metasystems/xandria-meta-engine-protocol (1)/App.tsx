
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Rocket, Terminal, Layers, Dna, Sparkles, Wand2,
  Activity, Cpu, Zap, Box, Save, FolderOpen, Bug,
  Trash2, RefreshCw, ChevronRight, Wind, Play, Pause, Info,
  MousePointer2, Flame, RotateCcw, Code, Copy, Check, Send,
  ShieldAlert, Activity as PulseIcon
} from 'lucide-react';
import { SYSTEMS, ARCHETYPES, getIcon } from './constants';
import { PlaneType, NodeLogic, BuildLog, Archetype, SystemState } from './types';
import { interpretIntent, generateSourceCode, executeManifoldStep } from './services/geminiService';
import NodeVisualizer from './components/NodeVisualizer';
import SingularityCore from './components/SingularityCore';

const App: React.FC = () => {
  const [activeSystemId, setActiveSystemId] = useState<string>('void');
  const [intent, setIntent] = useState<string>('');
  const [impulse, setImpulse] = useState<string>('');
  const [isInterpreting, setIsInterpreting] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [activeNodes, setActiveNodes] = useState<NodeLogic[]>([]);
  const [buildLogs, setBuildLogs] = useState<BuildLog[]>([]);
  const [isBuilding, setIsBuilding] = useState(false);
  const [selectedSoulId, setSelectedSoulId] = useState<string | null>(null);
  const [customArchetypes, setCustomArchetypes] = useState<Archetype[]>([]);
  const [debugMode, setDebugMode] = useState(true);
  const [activeNodeId, setActiveNodeId] = useState<string | undefined>();
  const [viewTab, setViewTab] = useState<'manifold' | 'source'>('manifold');
  const [generatedSource, setGeneratedSource] = useState<string>('');
  const [isCopied, setIsCopied] = useState(false);
  
  const [stats, setStats] = useState<SystemState>({
    coherence: 99.13,
    entropy: 0.0001,
    resonance: 1.000,
    activePhase: 'NONE',
    isSimulating: false // Representing "Neural Link" state
  });

  const currentSystem = useMemo(() => 
    SYSTEMS.find(s => s.id === activeSystemId),
    [activeSystemId]
  );

  const selectedNode = useMemo(() => 
    activeNodes.find(n => n.id === activeNodeId), 
    [activeNodes, activeNodeId]
  );

  useEffect(() => {
    const saved = localStorage.getItem('xandria_vaulted_souls');
    if (saved) setCustomArchetypes(JSON.parse(saved));
    addLog("XANDRIA KERNEL v7.0 PRIME: Operational Capacity 100%.", "system");
  }, []);

  const addLog = useCallback((message: string, level: BuildLog['level'] = 'info') => {
    setBuildLogs(prev => [{ timestamp: Date.now(), message, level }, ...prev].slice(0, 50));
  }, []);

  const handleManifest = async () => {
    if (!intent.trim()) return;
    setIsInterpreting(true);
    setGeneratedSource('');
    setViewTab('manifold');
    addLog(`INIT_WAVEFORM_COLLAPSE: Vectoring "${intent.slice(0, 30)}..."`, 'op');
    try {
      const nodes = await interpretIntent(intent);
      setActiveNodes(nodes);
      addLog(`COLLAPSE_COMPLETE: ${nodes.length} nodes synthesized.`, 'success');
      setStats(s => ({ ...s, coherence: Math.min(99.9999, s.coherence + 0.002) }));
    } catch (e) {
      addLog("KERN_ERR: Wavefunction collapse failed.", "error");
    } finally {
      setIsInterpreting(false);
    }
  };

  const handleImpulse = async () => {
    if (!impulse.trim() || !activeNodes.length) return;
    setIsExecuting(true);
    addLog(`NEURAL_IMPULSE: [${impulse.toUpperCase()}]`, 'op');
    try {
      const { nodes, log } = await executeManifoldStep(activeNodes, impulse);
      setActiveNodes(nodes);
      addLog(log, 'success');
      setImpulse('');
      setStats(s => ({ ...s, resonance: Math.min(2.0, s.resonance + 0.05) }));
    } catch (e) {
      addLog("NEURAL_PASS_FAIL: Logic drift detected.", "error");
    } finally {
      setIsExecuting(false);
    }
  };

  const simulateBuild = async () => {
    if (!activeNodes.length) return;
    setIsBuilding(true);
    addLog("ENGAGING_FORGE: Transpiling manifold to source...", "system");
    try {
      const source = await generateSourceCode(intent, activeNodes);
      setGeneratedSource(source);
      setViewTab('source');
      addLog("FORGE_SUCCESS: Source artifact materialized.", "success");
    } catch (e) {
      addLog("FORGE_ERR: Artifact de-materialized during transpile.", "error");
    } finally {
      setIsBuilding(false);
    }
  };

  return (
    <div className="flex h-screen w-full bg-[#020205] text-[#d1d1f0] overflow-hidden selection:bg-cyan-500/30">
      <div className="fixed inset-0 z-0"><SingularityCore coherence={stats.coherence} /></div>

      {/* Sidebar: Substrate Navigation */}
      <aside className="w-80 border-r border-white/5 glass z-10 flex flex-col p-6 space-y-8">
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_20px_#00f3ff]" />
          <h1 className="text-xl font-bold tracking-tighter uppercase italic glitch-text">XANDRIA PRIME</h1>
        </div>

        <nav className="flex-1 overflow-y-auto space-y-6 pr-2 custom-scrollbar">
          {Object.values(PlaneType).map(plane => (
            <div key={plane}>
              <h3 className="text-[9px] opacity-30 uppercase fira tracking-[0.3em] mb-3 ml-2">Plane::{plane}</h3>
              <div className="space-y-1">
                {SYSTEMS.filter(s => s.plane === plane).map(sys => (
                  <button key={sys.id} onClick={() => setActiveSystemId(sys.id)} className={`w-full text-left px-4 py-2.5 rounded-2xl flex items-center gap-3 transition-all ${activeSystemId === sys.id ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' : 'opacity-40 hover:opacity-100 hover:bg-white/5'}`}>
                    {getIcon(sys.icon, 'w-3.5 h-3.5')}
                    <span className="text-[10px] uppercase font-bold tracking-widest">{sys.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="space-y-3 pt-4 border-t border-white/5">
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="text-[9px] opacity-30 uppercase fira">Kernel Status</span>
            <span className="flex items-center gap-1.5 text-[9px] text-green-400 font-bold uppercase"><PulseIcon size={10} className="animate-pulse" /> Operational</span>
          </div>
          <button 
            onClick={() => setStats(s => ({...s, isSimulating: !s.isSimulating}))} 
            disabled={!activeNodes.length} 
            className={`w-full py-3.5 rounded-2xl flex items-center justify-center gap-2 text-[9px] uppercase tracking-widest transition-all border ${stats.isSimulating ? 'bg-cyan-500 text-black border-cyan-400 font-bold shadow-[0_0_20px_rgba(0,243,255,0.4)]' : 'border-white/10 hover:bg-white/5 opacity-50'}`}
          >
            {stats.isSimulating ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            {stats.isSimulating ? "De-link Neural Pass" : "Establish Neural Link"}
          </button>
          <button onClick={simulateBuild} disabled={isBuilding || !activeNodes.length} className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold py-3.5 rounded-2xl flex items-center justify-center gap-2 transition-all disabled:opacity-10 text-[9px] uppercase tracking-widest">
            {isBuilding ? <RefreshCw className="animate-spin" size={16} /> : <Rocket className="w-4 h-4" />}
            Forge Artifact
          </button>
        </div>
      </aside>

      {/* Main Container: Manifestation Zone */}
      <main className="flex-1 flex flex-col z-10 relative">
        <header className="h-28 px-12 border-b border-white/5 flex items-center justify-between glass">
          <div>
            <h2 className="text-2xl font-bold uppercase tracking-tighter text-white">{currentSystem?.name || 'Protocol::Main'}</h2>
            <p className="text-[10px] opacity-40 fira uppercase tracking-widest">{currentSystem?.mechanism || 'Substrate Anchor Established'}</p>
          </div>
          <div className="flex gap-12">
            <div className="text-right">
              <span className="text-[8px] opacity-30 uppercase tracking-[0.3em] block mb-1">Coherence_Pty</span>
              <span className="text-2xl font-bold text-cyan-400 fira">{(stats.coherence).toFixed(4)}%</span>
            </div>
            <div className="text-right border-l border-white/5 pl-12">
              <span className="text-[8px] opacity-30 uppercase tracking-[0.3em] block mb-1">Resonance</span>
              <span className="text-2xl font-bold text-purple-400 fira">x{(stats.resonance).toFixed(3)}</span>
            </div>
            <button onClick={() => setDebugMode(!debugMode)} className={`p-3 rounded-xl transition-all ${debugMode ? 'bg-cyan-400/20 text-cyan-400' : 'opacity-20 hover:opacity-100'}`}>
              <Bug size={20} />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-12 space-y-12 custom-scrollbar">
          <div className="grid grid-cols-12 gap-12">
            <div className="col-span-8 space-y-10">
              <div className="flex gap-4">
                <button onClick={() => setViewTab('manifold')} className={`px-8 py-3 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${viewTab === 'manifold' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' : 'opacity-30 border border-transparent hover:opacity-100'}`}>Lattice Topology</button>
                <button onClick={() => setViewTab('source')} disabled={!generatedSource} className={`px-8 py-3 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${viewTab === 'source' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' : 'opacity-10 border border-transparent'}`}>Source Artifact</button>
              </div>

              {viewTab === 'manifold' ? (
                <NodeVisualizer nodes={activeNodes} activeNodeId={activeNodeId} isSimulating={stats.isSimulating} onNodeClick={setActiveNodeId} />
              ) : (
                <div className="glass h-[600px] rounded-[3rem] p-12 overflow-hidden flex flex-col border border-white/10 animate-in fade-in zoom-in-95 duration-500">
                  <div className="flex items-center justify-between mb-8">
                    <div className="flex items-center gap-3">
                      <Code size={20} className="text-cyan-400" />
                      <h3 className="text-xs font-bold uppercase tracking-widest">Binary Manifold::Source</h3>
                    </div>
                    <button onClick={() => { navigator.clipboard.writeText(generatedSource); setIsCopied(true); setTimeout(() => setIsCopied(false), 2000); }} className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-[9px] uppercase tracking-widest border border-white/10 flex items-center gap-2">
                      {isCopied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                      {isCopied ? "Archived" : "Clone Source"}
                    </button>
                  </div>
                  <pre className="flex-1 bg-black/50 rounded-3xl p-10 fira text-[12px] leading-relaxed text-cyan-50/80 overflow-y-auto border border-white/5 custom-scrollbar"><code>{generatedSource}</code></pre>
                </div>
              )}

              {stats.isSimulating && (
                <div className="glass p-10 rounded-[3rem] border-cyan-500/40 flex items-center gap-8 animate-in slide-in-from-bottom-6 duration-500 shadow-[0_0_40px_rgba(0,243,255,0.1)]">
                  <div className="p-4 bg-cyan-500/20 rounded-full animate-pulse"><Zap size={24} className="text-cyan-400" /></div>
                  <div className="flex-1">
                    <span className="text-[9px] opacity-30 uppercase tracking-[0.3em] block mb-2">Awaiting Neural Impulse</span>
                    <input 
                      value={impulse} 
                      onChange={(e) => setImpulse(e.target.value)} 
                      onKeyDown={(e) => e.key === 'Enter' && handleImpulse()} 
                      placeholder="e.g. 'COLLISION_TRIGGERED', 'NETWORK_SYNC_ERROR'" 
                      className="w-full bg-transparent border-none focus:outline-none text-sm fira uppercase tracking-widest placeholder:opacity-10 text-white" 
                    />
                  </div>
                  <button onClick={handleImpulse} disabled={isExecuting || !impulse} className="p-5 bg-cyan-500 text-black rounded-3xl hover:scale-105 active:scale-95 transition-all disabled:opacity-10">
                    {isExecuting ? <RefreshCw size={20} className="animate-spin" /> : <Send size={20} />}
                  </button>
                </div>
              )}
            </div>

            <div className="col-span-4 space-y-10">
              <div className="glass p-10 rounded-[3.5rem] border-purple-500/30 space-y-8 bg-purple-500/5">
                <div className="flex items-center gap-3">
                  <Sparkles size={20} className="text-purple-400" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-purple-400">Intent Injector</h3>
                </div>
                <textarea 
                  value={intent} 
                  onChange={(e) => setIntent(e.target.value)} 
                  placeholder="Describe your logical architecture..." 
                  className="w-full h-32 bg-black/60 border border-white/5 rounded-[2rem] p-6 text-xs focus:border-purple-500/50 outline-none fira text-white/80 resize-none" 
                />
                <button onClick={handleManifest} disabled={isInterpreting || !intent} className="w-full bg-purple-500 hover:bg-purple-400 text-white font-bold py-5 rounded-2xl flex items-center justify-center gap-3 disabled:opacity-20 transition-all shadow-[0_0_30px_rgba(168,85,247,0.2)]">
                  {isInterpreting ? <RefreshCw className="animate-spin" size={18} /> : <Wand2 size={18} />}
                  <span className="text-[11px] uppercase tracking-widest font-black">Collapse Manifold</span>
                </button>
              </div>

              <div className="glass p-10 rounded-[3.5rem] h-[450px] flex flex-col border-white/5">
                <div className="flex items-center gap-3 mb-8">
                  <Terminal size={18} className="text-cyan-400" />
                  <h3 className="text-xs font-bold uppercase tracking-widest opacity-40">Kernel Trace</h3>
                </div>
                <div className="flex-1 overflow-y-auto space-y-4 fira text-[10px] custom-scrollbar">
                  {buildLogs.map((log, i) => (
                    <div key={i} className={`flex gap-4 border-l-2 pl-4 py-0.5 ${log.level === 'error' ? 'border-red-500/50 text-red-300' : log.level === 'success' ? 'border-green-500/50 text-green-300' : log.level === 'op' ? 'border-cyan-500/50 text-cyan-300' : 'border-white/5 opacity-50'}`}>
                      <span className="opacity-20">{new Date(log.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}</span>
                      <span className="font-medium tracking-tight">{log.message}</span>
                    </div>
                  ))}
                  {buildLogs.length === 0 && <p className="opacity-20 italic">Awaiting kernel activity...</p>}
                </div>
              </div>
            </div>
          </div>
        </div>

        {debugMode && selectedNode && (
          <div className="absolute bottom-24 right-12 w-[380px] glass p-10 rounded-[3.5rem] border-white/10 shadow-2xl animate-in fade-in slide-in-from-right-8 duration-500">
             <div className="flex items-center gap-3 mb-8 border-b border-white/5 pb-4">
               <ShieldAlert size={18} className="text-cyan-400" />
               <h4 className="text-[11px] font-black text-white uppercase tracking-[0.4em]">Node Diagnostic HUD</h4>
             </div>
             <div className="space-y-8">
                <div className="grid grid-cols-2 gap-8">
                  <div>
                    <span className="text-[9px] opacity-30 uppercase block mb-1">Causal Flux</span>
                    <div className="text-2xl font-bold fira tabular-nums">{(selectedNode.metrics?.flux || 0).toFixed(4)}</div>
                  </div>
                  <div>
                    <span className="text-[9px] opacity-30 uppercase block mb-1">Entropy Debt</span>
                    <div className="text-2xl font-bold text-pink-500 fira tabular-nums">{(selectedNode.metrics?.entropy || 0).toFixed(4)}</div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-[9px] opacity-30 uppercase block">Relational Priority</span>
                    <span className="text-[10px] fira text-cyan-400">{(selectedNode.metrics?.weight || 0.5).toFixed(2)}</span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-cyan-400 shadow-[0_0_10px_#00f3ff]" style={{ width: `${(selectedNode.metrics?.weight || 0.5) * 100}%` }} />
                  </div>
                </div>
                <div className="p-4 bg-white/5 rounded-2xl">
                  <p className="text-[9px] fira opacity-40 uppercase mb-2">Logical Address</p>
                  <code className="text-[10px] text-purple-300">XANDRIA::CORE::{selectedNode.id}</code>
                </div>
             </div>
          </div>
        )}
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0, 243, 255, 0.2); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(0, 243, 255, 0.4); }
      `}</style>
    </div>
  );
};

export default App;
