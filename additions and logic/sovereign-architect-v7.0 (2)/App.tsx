
import React, { useState, useCallback, useEffect } from 'react';
import { SynthesisPhase, MetaSystem, ArchitectState } from './types';
import { synthesizeArchitecturalBlueprint, diagnoseSystemFailure } from './services/geminiService';
import { Console } from './components/Console';
import { LatticeNode } from './components/LatticeNode';
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer } from 'recharts';

const App: React.FC = () => {
  const [state, setState] = useState<ArchitectState>({
    intent: '',
    phase: SynthesisPhase.IDLE,
    coherence: 99.98,
    entropy: 0.0001,
    artifactReady: false,
    systems: [
      { id: 'brain', name: 'Sovereign Brain Kernel', description: 'The absolute cognitive core. Orchestrates all sub-nodes.', manifest: '// OMNI_BRAIN_v7.P', status: 'ACTIVE', type: 'CORE', category: 'COGNITION', retryCount: 0, health: 100, isEphemeral: false },
      { id: 'law', name: 'Ethical Governor', description: 'Ensures archetypal integrity and legal compliance.', manifest: '// LAW_SUBSTRATE', status: 'ACTIVE', type: 'REGULATORY', category: 'PIPELINE', retryCount: 0, health: 100, isEphemeral: false }
    ],
    logs: ['[BRAIN] Cognitive substrate stabilized.', '[BRAIN] Awaiting resonance intent from Architect-Prime.']
  });

  const [substrateUsage, setSubstrateUsage] = useState(12); // Initial % usage
  const [chartData, setChartData] = useState<{ t: number, c: number }[]>([]);

  useEffect(() => {
    const interval = setInterval(() => {
      setChartData(prev => [...prev.slice(-20), { t: Date.now(), c: 99.9 + (Math.random() * 0.09) }].slice(-20));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const addLog = (msg: string) => {
    setState(prev => ({ ...prev, logs: [...prev.logs, msg] }));
  };

  const executeGrandSynthesis = async () => {
    if (!state.intent.trim()) return;

    // 1. INTROSPECTION & DIALOGUE
    setState(prev => ({ ...prev, phase: SynthesisPhase.INTROSPECTION, artifactReady: false }));
    addLog(`[BRAIN] Processing Intent Dialogue: "${state.intent}"`);
    addLog('[BRAIN] Conceptualizing AAA Manifest... Analyzing resonance archetypes.');
    await new Promise(r => setTimeout(r, 2000));
    addLog('[BRAIN] Goal Identified: Sovereign-class creative artifact generation.');

    try {
      // 2. META-SYNTHESIS (Building the internal factories)
      setState(prev => ({ ...prev, phase: SynthesisPhase.META_SYNTHESIS }));
      addLog('[BRAIN] Constructing internal meta-generators. User interaction restricted to Brain mediator.');
      const blueprint = await synthesizeArchitecturalBlueprint(state.intent);
      
      for (const item of blueprint) {
        await new Promise(r => setTimeout(r, 600));
        const systemId = Math.random().toString(36).substring(7);
        addLog(`[FORGE] Materializing Factory: ${item.name} (ID: ${systemId.toUpperCase()})`);
        setState(prev => ({
          ...prev,
          systems: [...prev.systems, {
            id: systemId,
            name: item.name,
            description: item.description,
            manifest: item.manifest,
            status: 'ACTIVE',
            type: item.type as any,
            category: item.category as any,
            retryCount: 0,
            health: 100,
            isEphemeral: true
          }]
        }));
        setSubstrateUsage(prev => Math.min(100, prev + 8));
      }

      // 3. CONTENT GENESIS (Internal generation)
      setState(prev => ({ ...prev, phase: SynthesisPhase.CONTENT_GENESIS }));
      addLog('[BRAIN] Factories operational. Initiating parallel content genesis...');
      await new Promise(r => setTimeout(r, 3000));
      addLog('[GENESIS] Neural NPC psyches baked. Volumetric landscapes synthesized.');
      setSubstrateUsage(prev => Math.min(100, prev + 15));
      await new Promise(r => setTimeout(r, 1500));

      // 4. COMPILATION
      setState(prev => ({ ...prev, phase: SynthesisPhase.COMPILATION }));
      addLog('[BRAIN] Orchestrating internal linkage. Resolving shader-core dependencies.');
      await new Promise(r => setTimeout(r, 2000));

      // 5. DEPLOYMENT
      setState(prev => ({ ...prev, phase: SynthesisPhase.DEPLOYMENT }));
      addLog('[BRAIN] Final AAA Artifact solidified. Generating export node.');
      await new Promise(r => setTimeout(r, 2000));
      setState(prev => ({ ...prev, artifactReady: true }));
      addLog('[SUCCESS] Sovereign Artifact ready for Architect-Prime retrieval.');

      // 6. CLEANUP (Pruning meta-factories to save space)
      setState(prev => ({ ...prev, phase: SynthesisPhase.CLEANUP }));
      addLog('[BRAIN] Work complete. De-materializing internal factories to optimize substrate...');
      await new Promise(r => setTimeout(r, 3000));
      
      setState(prev => ({
        ...prev,
        systems: prev.systems.filter(s => !s.isEphemeral),
        phase: SynthesisPhase.STABLE,
        coherence: Math.min(100, prev.coherence + 3)
      }));
      setSubstrateUsage(12); // Reset to base usage
      addLog('[STABILITY] Cleanup finalized. Substrate storage optimized. Sub-engines pruned.');

    } catch (error) {
      addLog('[CRITICAL ERROR] Brain-Substrate desync. Purging active intent.');
      setState(prev => ({ ...prev, phase: SynthesisPhase.IDLE, entropy: prev.entropy + 0.1 }));
    }
  };

  const getPhaseProgress = () => {
    const phases = [
      SynthesisPhase.IDLE, SynthesisPhase.INTROSPECTION, SynthesisPhase.META_SYNTHESIS, 
      SynthesisPhase.CONTENT_GENESIS, SynthesisPhase.COMPILATION, SynthesisPhase.DEPLOYMENT, 
      SynthesisPhase.CLEANUP, SynthesisPhase.STABLE
    ];
    return (phases.indexOf(state.phase) / (phases.length - 1)) * 100;
  };

  return (
    <div className="h-screen w-screen flex flex-col p-6 relative overflow-hidden bg-[#020205]">
      <div className="scanline"></div>
      
      {/* Sovereign Header */}
      <header className="flex justify-between items-start z-10 mb-8">
        <div className="glass p-5 rounded-2xl flex flex-col gap-1 border-cyan-500/40 shadow-[0_0_50px_rgba(0,243,255,0.1)]">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${state.phase !== SynthesisPhase.IDLE && state.phase !== SynthesisPhase.STABLE ? 'bg-cyan-400 animate-pulse' : 'bg-cyan-400 shadow-[0_0_15px_#00f3ff]'}`}></div>
            <h1 className="text-2xl font-bold tracking-[0.2em] uppercase italic leading-none glitch-text">
              SOVEREIGN <span className="text-cyan-400">ARCHITECT</span>
            </h1>
          </div>
          <p className="text-[10px] fira opacity-60 uppercase tracking-[0.3em] font-medium">
            Status: <span className="text-purple-400">{state.phase}</span> | Load: <span className="text-cyan-400">{substrateUsage}%_SUBSTRATE</span>
          </p>
        </div>

        <div className="glass p-5 rounded-2xl flex gap-12 items-center border-white/10">
          <div className="text-center">
            <p className="text-[9px] opacity-40 uppercase mb-1 tracking-widest">Coherence ($C$)</p>
            <p className="text-xl font-bold text-cyan-400">{state.coherence.toFixed(3)}%</p>
          </div>
          <div className="w-px h-8 bg-white/10"></div>
          <div className="text-center">
            <p className="text-[9px] opacity-40 uppercase mb-1 tracking-widest">Substrate Storage</p>
            <div className="flex items-center gap-3 mt-1">
              <div className="w-24 h-2 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-purple-500 transition-all duration-500" style={{ width: `${substrateUsage}%` }}></div>
              </div>
              <span className="text-sm font-bold text-purple-400 fira">{substrateUsage}%</span>
            </div>
          </div>
          <div className="w-px h-8 bg-white/10"></div>
          <div className={`flex flex-col gap-1 items-end transition-all duration-500 ${state.artifactReady ? 'scale-110 opacity-100' : 'opacity-30'}`}>
            <span className="text-[8px] opacity-50 uppercase tracking-[0.2em]">AAA Artifact Ready</span>
            <button 
              disabled={!state.artifactReady}
              onClick={() => addLog('[BRAIN] Initiating local deployment of AAA Project...')}
              className={`px-6 py-2 rounded-full text-[10px] font-bold tracking-widest transition-all ${state.artifactReady ? 'bg-cyan-500 text-black shadow-[0_0_20px_#00f3ff]' : 'bg-white/5 text-white/40 cursor-not-allowed'}`}
            >
              {state.artifactReady ? 'EXPORT_PLAYABLE_GAME' : 'SYSTEM_IDLE'}
            </button>
          </div>
        </div>
      </header>

      {/* Lifecycle Visualization */}
      <div className="w-full mb-10 z-10 px-2">
        <div className="flex justify-between text-[9px] fira opacity-40 uppercase tracking-[0.4em] mb-3 px-1">
          {['Intent', 'Dialogue', 'Meta-Build', 'Genesis', 'Linkage', 'Deploy', 'Cleanup', 'Stable'].map((p, i) => (
            <span key={i} className={i <= Math.floor(getPhaseProgress() / 12.5) ? 'text-cyan-400 font-bold' : ''}>{p}</span>
          ))}
        </div>
        <div className="h-1 bg-white/5 rounded-full overflow-hidden shadow-inner">
          <div 
            className="h-full bg-cyan-500 transition-all duration-1000 ease-out shadow-[0_0_15px_#00f3ff]"
            style={{ width: `${getPhaseProgress()}%` }}
          ></div>
        </div>
      </div>

      <main className="flex-1 grid grid-cols-12 gap-8 z-10 overflow-hidden min-h-0">
        
        {/* Interaction Port */}
        <div className="col-span-4 flex flex-col gap-6 overflow-hidden">
          <section className="glass p-8 rounded-3xl flex flex-col gap-6 border-cyan-500/20 shadow-2xl relative">
            <div className="absolute top-0 right-0 p-4 opacity-10 fira text-[8px] select-none">COGNITIVE_INTERFACE_LOCKED</div>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold tracking-[0.1em] opacity-90 uppercase italic">Resonance Dialogue</h2>
              <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_10px_#22c55e]"></div>
            </div>
            <div className="relative flex-1">
              <textarea 
                value={state.intent}
                onChange={(e) => setState(prev => ({ ...prev, intent: e.target.value }))}
                placeholder="Discuss your vision... (e.g., 'An infinite procedural space-horror adventure with shifting gravity')"
                className="w-full h-full bg-black/40 border border-white/10 rounded-2xl p-6 fira text-sm focus:outline-none focus:border-cyan-500/60 resize-none transition-all placeholder:opacity-30 leading-relaxed"
              />
              <button 
                onClick={executeGrandSynthesis}
                disabled={state.phase !== SynthesisPhase.IDLE && state.phase !== SynthesisPhase.STABLE}
                className="absolute bottom-6 right-6 bg-cyan-500 hover:bg-cyan-400 text-black font-bold px-10 py-4 rounded-full text-xs tracking-[0.3em] disabled:opacity-20 transition-all active:scale-95 shadow-[0_0_30px_rgba(0,243,255,0.5)] uppercase"
              >
                {state.phase === SynthesisPhase.IDLE || state.phase === SynthesisPhase.STABLE ? 'Begin_Manifestation' : 'Brain_Is_Orchestrating'}
              </button>
            </div>
          </section>

          <section className="glass h-40 p-6 rounded-3xl overflow-hidden flex flex-col border-white/5">
             <div className="flex justify-between items-center mb-4">
               <h3 className="text-xs font-bold opacity-40 uppercase tracking-widest">Brain Activity Wave</h3>
               <span className="text-[9px] fira text-purple-500/50 italic">SYNAPTIC_FIRE_SYNCED</span>
             </div>
             <div className="flex-1 min-h-0">
               <ResponsiveContainer width="100%" height="100%">
                 <AreaChart data={chartData}>
                   <defs>
                     <linearGradient id="colorC" x1="0" y1="0" x2="0" y2="1">
                       <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4}/>
                       <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                     </linearGradient>
                   </defs>
                   <Area type="monotone" dataKey="c" stroke="#a78bfa" strokeWidth={2} fillOpacity={1} fill="url(#colorC)" isAnimationActive={false} />
                   <YAxis hide domain={[99.5, 100.5]} />
                 </AreaChart>
               </ResponsiveContainer>
             </div>
          </section>
        </div>

        {/* Internal Lattice Node Forge */}
        <div className="col-span-5 flex flex-col overflow-hidden">
          <section className="glass flex-1 p-8 rounded-[2.5rem] relative overflow-hidden border-cyan-500/20 flex flex-col shadow-2xl">
            <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,rgba(0,243,255,0.05)_0%,transparent_70%)]"></div>
            
            <div className="flex justify-between items-center mb-8 z-10">
              <h3 className="text-sm font-bold opacity-90 tracking-[0.4em] flex items-center gap-5">
                <span className="w-10 h-px bg-cyan-500/40"></span>
                INTERNAL_META_FACTORY
              </h3>
              <div className="px-3 py-1 bg-white/5 rounded-lg border border-white/10">
                <span className="text-[10px] fira text-cyan-400 font-bold">{state.systems.length} SYSTEMS ACTIVE</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 overflow-y-auto pr-2 custom-scroll flex-1 z-10 pb-6">
              {state.systems.map((sys) => (
                <LatticeNode 
                  key={sys.id} 
                  system={sys} 
                />
              ))}
              {(state.phase === SynthesisPhase.META_SYNTHESIS || state.phase === SynthesisPhase.CONTENT_GENESIS) && (
                <div className="p-10 rounded-3xl border-2 border-dashed border-cyan-500/30 bg-cyan-500/5 animate-pulse flex flex-col items-center justify-center gap-4 text-center">
                  <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-[10px] fira text-cyan-400 font-bold tracking-[0.2em] uppercase">Forging_Sub_Nodes...</span>
                </div>
              )}
            </div>
            
            <div className="mt-4 pt-4 border-t border-white/5 z-10 text-center">
              <p className="text-[9px] fira opacity-30 italic">User interface restricted to Grand Intent discussions. All sub-system parameters managed by Sovereign Brain.</p>
            </div>
          </section>
        </div>

        {/* Brain Trace & Export */}
        <div className="col-span-3 flex flex-col gap-8 overflow-hidden">
          <section className="glass flex-1 p-6 rounded-[2rem] border-white/5 overflow-hidden shadow-2xl">
            <Console logs={state.logs} />
          </section>

          <section className="glass p-8 rounded-[2rem] border-purple-500/20 shadow-[0_0_30px_rgba(139,92,246,0.1)]">
            <h3 className="text-[10px] font-bold opacity-40 uppercase mb-6 tracking-[0.5em] text-center">Cognitive Control</h3>
            <div className="flex flex-col gap-4">
              <div className="p-4 bg-white/5 rounded-2xl border border-white/10 flex flex-col gap-2">
                <span className="text-[9px] opacity-40 uppercase tracking-widest font-bold">Autonomy Factor</span>
                <div className="flex justify-between items-end">
                  <span className="text-xl font-bold text-cyan-400">100%</span>
                  <span className="text-[8px] fira text-purple-400 mb-1">SOVEREIGN_MODE</span>
                </div>
              </div>
              
              <button 
                onClick={() => {
                  navigator.clipboard.writeText('[AETHELGARD_SOVEREIGN_V7]:_INTENT_COLLAPSE_READY');
                  addLog('[BRAIN] Sovereign DNA exported to local buffer.');
                }}
                className="w-full text-[10px] bg-purple-500/10 hover:bg-purple-500/20 p-5 rounded-2xl border border-purple-500/30 text-left transition-all group flex flex-col gap-2"
              >
                <span className="font-bold text-purple-400 uppercase tracking-widest group-hover:text-purple-300">COPY_SOVEREIGN_DNA</span>
                <span className="text-[8px] opacity-40 leading-relaxed font-light">Bridge the brain substrate to external GPU clusters for infinite generation.</span>
              </button>
            </div>
          </section>
        </div>
      </main>

      <footer className="mt-8 flex justify-between items-end z-10 border-t border-white/5 pt-6">
        <div className="flex gap-20">
          <div className="flex flex-col gap-1">
            <p className="text-[9px] opacity-30 uppercase tracking-[0.4em]">Architect Identity</p>
            <p className="text-[12px] fira font-bold text-purple-400 tracking-tight">SOVEREIGN_BRAIN_v7_PRIME</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-[9px] opacity-30 uppercase tracking-[0.4em]">System Capacity</p>
            <p className="text-[12px] fira font-bold text-cyan-400 tracking-tight italic">GRAND_SYNTHESIS_CAPABLE</p>
          </div>
        </div>
        <div className="text-right flex flex-col gap-1">
          <p className="text-[9px] opacity-20 uppercase tracking-[0.2em]">Resonance Frequency</p>
          <p className="text-[11px] fira opacity-40 uppercase">0.0001Hz_STABLE</p>
        </div>
      </footer>
    </div>
  );
};

export default App;
