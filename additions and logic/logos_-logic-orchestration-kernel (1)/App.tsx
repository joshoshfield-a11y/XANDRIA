
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Terminal, 
  Cpu, 
  Layers, 
  ShieldCheck, 
  Activity, 
  Zap, 
  Code2,
  ChevronRight,
  RefreshCcw,
  Play,
  Database,
  Search,
  Settings,
  MousePointer2,
  Move
} from 'lucide-react';
import { gemini } from './services/geminiService';
import { engine } from './ecsEngine';
import { VerificationResult, LogEvent, ComponentType } from './types';

const App: React.FC = () => {
  const [intent, setIntent] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [proofs, setProofs] = useState<VerificationResult[]>([]);
  const [synthesis, setSynthesis] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'verification' | 'ast' | 'ecs' | 'library' | 'editor'>('verification');
  const [fps, setFps] = useState(0);
  const [filter, setFilter] = useState<string>('');
  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastTimeRef = useRef<number>(0);

  const addLogEvent = useCallback((event: LogEvent) => {
    setLogs(prev => [...prev.slice(-200), event]);
  }, []);

  useEffect(() => {
    engine.setLogCallback(addLogEvent);
    addLogEvent({
      id: 'init',
      type: 'ECS_LIFECYCLE',
      message: 'Logos Kernel Boot Sequence Initiated...',
      severity: 'INFO',
      timestamp: Date.now()
    });
  }, [addLogEvent]);

  const runSimulation = useCallback((time: number) => {
    const dt = (time - lastTimeRef.current) / 1000;
    lastTimeRef.current = time;
    
    if (dt > 0) setFps(Math.round(1 / dt));

    engine.update(dt);
    
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx && canvasRef.current) {
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      
      // Grid
      ctx.strokeStyle = 'rgba(0, 243, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 800; i += 40) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 600); ctx.stroke();
      }
      for (let j = 0; j < 600; j += 40) {
        ctx.beginPath(); ctx.moveTo(0, j); ctx.lineTo(800, j); ctx.stroke();
      }

      // Draw Entities
      const entities = engine.getEntities();
      entities.forEach(e => {
        const transform = e.components.get('Transform');
        const stats = e.components.get('Stats');
        const render = e.components.get('Render');
        
        if (transform) {
          const { x, y } = transform.data;
          const color = render?.data?.color || '#00f3ff';
          const isSelected = e.id === selectedEntityId;
          
          if (isSelected) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, 12, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
          }

          ctx.fillStyle = color;
          ctx.shadowBlur = isSelected ? 20 : 10;
          ctx.shadowColor = color;
          ctx.beginPath();
          ctx.arc(x, y, isSelected ? 8 : 6, 0, Math.PI * 2);
          ctx.fill();
          
          // Render Health Bar
          if (stats) {
            const hpWidth = 30;
            const hpRatio = (stats.data.hp || 0) / (stats.data.maxHp || 100);
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(255,255,255,0.1)';
            ctx.fillRect(x - hpWidth/2, y - 18, hpWidth, 3);
            ctx.fillStyle = hpRatio > 0.5 ? '#4ade80' : '#f87171';
            ctx.fillRect(x - hpWidth/2, y - 18, hpWidth * Math.max(0, hpRatio), 3);
          }
        }
      });
    }
    
    requestAnimationFrame(runSimulation);
  }, [selectedEntityId]);

  useEffect(() => {
    requestAnimationFrame(runSimulation);
    // Seed world
    const seed = () => {
      for(let i=0; i<3; i++) {
        const id = engine.createEntity(`Guardian_${i}`);
        engine.addComponent(id, 'Transform', { x: 200 + i * 200, y: 100 });
        engine.addComponent(id, 'Physics', { vx: (Math.random() - 0.5) * 50, vy: 0, ay: 400 });
        engine.addComponent(id, 'Stats', { hp: 100, maxHp: 100, mana: 50, maxMana: 100 });
        engine.addComponent(id, 'Render', { color: '#00f3ff' });
      }
    };
    seed();
  }, [runSimulation]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const id = engine.getEntityAt(x, y);
    setSelectedEntityId(id);
    if (id !== null) {
      setActiveTab('editor');
      addLogEvent({ id: `select-${id}`, type: 'ECS_LIFECYCLE', message: `Kernel focus locked on Entity [${id}]`, severity: 'INFO', timestamp: Date.now() });
    }
  };

  const handleManifest = async () => {
    if (!intent) return;
    setIsProcessing(true);
    addLogEvent({ id: 'synthesis-start', type: 'SYSTEM_UPDATE', message: `Synthesizing logic for: "${intent}"`, severity: 'INFO', timestamp: Date.now() });
    
    try {
      const result = await gemini.synthesizeLogic(intent);
      setSynthesis(result);
      
      const simulatedProofs: VerificationResult[] = result.proofs.map((p: any) => ({
        property: p.property,
        proof: p.proof,
        status: p.severity === 'CRITICAL' ? 'CRITICAL_VIOLATION' : 'PASS',
        timestamp: Date.now()
      }));
      
      setProofs(simulatedProofs);
      setActiveTab('ast');
      addLogEvent({ id: 'synthesis-end', type: 'VERIFICATION', message: `Formal verification suite completed with ${simulatedProofs.length} proofs.`, severity: 'INFO', timestamp: Date.now() });
    } catch (err) {
      addLogEvent({ id: 'synthesis-err', type: 'SYSTEM_UPDATE', message: 'Logic synthesis failed due to AST non-convergence.', severity: 'ERROR', timestamp: Date.now() });
    } finally {
      setIsProcessing(false);
    }
  };

  const filteredLogs = logs.filter(l => 
    l.message.toLowerCase().includes(filter.toLowerCase()) || 
    l.type.toLowerCase().includes(filter.toLowerCase())
  ).reverse();

  const selectedEntity = selectedEntityId !== null ? engine.getEntity(selectedEntityId) : null;

  const updateSelectedComponent = (type: ComponentType, field: string, value: any) => {
    if (selectedEntityId === null) return;
    const comp = selectedEntity?.components.get(type);
    if (comp) {
      engine.updateComponent(selectedEntityId, type, { [field]: value });
    }
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-[#020408] text-slate-200 selection:bg-cyan-500/30 overflow-hidden">
      {/* Header */}
      <header className="h-16 border-b border-white/10 flex items-center justify-between px-8 bg-[#05070a] z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-cyan-500 flex items-center justify-center shadow-[0_0_20px_rgba(0,243,255,0.4)]">
            <Cpu size={24} className="text-[#020408]" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tighter uppercase italic text-cyan-400 leading-none">Logos <span className="text-white opacity-50">Prime Kernel</span></h1>
            <p className="text-[9px] fira opacity-40 uppercase tracking-[0.2em] mt-1">Autonomous Logic & Verification Forge</p>
          </div>
        </div>
        
        <div className="flex items-center gap-8">
          <div className="flex gap-4">
            <div className="text-right">
              <p className="text-[9px] uppercase opacity-40 font-bold">Proof Engine</p>
              <p className="text-xs text-green-400 font-bold">LOCKED_IN</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] uppercase opacity-40 font-bold">Cycle Speed</p>
              <p className="text-xs text-cyan-400 fira">{fps} FPS</p>
            </div>
          </div>
          <div className="w-px h-10 bg-white/10"></div>
          <button 
            onClick={() => { engine.clear(); setSelectedEntityId(null); }} 
            className="p-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded text-red-400 transition-all"
            title="Purge Substrate"
          >
            <RefreshCcw size={16} />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 grid grid-cols-12 gap-1 p-1 overflow-hidden">
        
        {/* Left Section: Input and Simulation */}
        <section className="col-span-8 flex flex-col gap-1">
          <div className="h-24 bg-glass border-glass rounded p-4 flex gap-4 items-center">
            <div className="flex-1 relative group">
              <input 
                type="text" 
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="Declare manifestation intent (e.g. 'Synthesize a multi-agent swarm with obstacle avoidance')"
                className="w-full bg-white/5 border border-white/10 px-6 py-4 rounded-lg focus:outline-none focus:border-cyan-500/50 transition-all text-sm fira"
                onKeyDown={(e) => e.key === 'Enter' && handleManifest()}
              />
              <div className="absolute right-4 top-1/2 -translate-y-1/2 opacity-20 pointer-events-none"><Terminal size={18} /></div>
            </div>
            <button 
              onClick={handleManifest}
              disabled={isProcessing}
              className={`px-10 h-full rounded-lg font-bold text-xs uppercase tracking-widest transition-all flex items-center gap-2 ${
                isProcessing ? 'bg-white/10 text-white/30 cursor-wait' : 'bg-cyan-500 text-black hover:bg-cyan-400 active:scale-95 shadow-[0_0_20px_rgba(0,243,255,0.2)]'
              }`}
            >
              {isProcessing ? <RefreshCcw className="animate-spin" size={18} /> : <Zap size={18} />}
              Manifest
            </button>
          </div>

          <div className="flex-1 bg-glass border-glass rounded relative">
            <div className="absolute top-4 left-4 z-10 flex gap-2">
              <div className="px-3 py-1 bg-cyan-500/10 border border-cyan-500/30 rounded text-[10px] font-bold text-cyan-400 uppercase tracking-tighter">
                Substrate Visualization
              </div>
              <div className="px-3 py-1 bg-white/5 border border-white/10 rounded text-[10px] font-bold text-white/40 uppercase tracking-tighter">
                {engine.getEntities().length} ENTITIES ACTIVE
              </div>
            </div>
            
            <canvas 
              ref={canvasRef} 
              width={800} 
              height={600} 
              className="w-full h-full object-contain cursor-crosshair" 
              onClick={handleCanvasClick}
            />

            <div className="absolute bottom-6 right-6 flex flex-col gap-2">
                <button 
                    onClick={() => {
                        const id = engine.createEntity('New Entity');
                        engine.addComponent(id, 'Transform', { x: 400, y: 100 });
                        engine.addComponent(id, 'Physics', { vx: (Math.random() - 0.5) * 200, vy: -100, ay: 400 });
                        engine.addComponent(id, 'Stats', { hp: 100, maxHp: 100, mana: 100, maxMana: 100 });
                        engine.addComponent(id, 'Render', { color: `hsl(${Math.random()*360}, 70%, 50%)` });
                        setSelectedEntityId(id);
                        setActiveTab('editor');
                    }}
                    className="w-14 h-14 bg-cyan-500 text-black rounded-full flex items-center justify-center hover:scale-110 active:scale-90 transition-all shadow-[0_0_25px_rgba(0,243,255,0.5)]"
                >
                    <Play size={24} fill="currentColor" />
                </button>
            </div>
          </div>
        </section>

        {/* Right Section: Intelligence Suite */}
        <section className="col-span-4 flex flex-col gap-1 overflow-hidden">
          
          {/* Navigation */}
          <div className="bg-glass border-glass rounded flex flex-col overflow-hidden min-h-[500px]">
            <div className="flex border-b border-white/10 bg-black/40">
              {[
                { id: 'verification', icon: ShieldCheck, label: 'Proofs' },
                { id: 'ast', icon: Layers, label: 'AST' },
                { id: 'editor', icon: Settings, label: 'Editor' },
                { id: 'ecs', icon: Activity, label: 'ECS' },
                { id: 'library', icon: Database, label: 'Lib' },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id as any)}
                  className={`flex-1 py-4 flex flex-col items-center gap-1 transition-all relative ${
                    activeTab === t.id ? 'text-cyan-400' : 'opacity-40 hover:opacity-100'
                  }`}
                >
                  <t.icon size={14} />
                  <span className="text-[8px] font-bold uppercase tracking-widest">{t.label}</span>
                  {activeTab === t.id && <div className="absolute bottom-0 w-full h-0.5 bg-cyan-400 shadow-[0_0_10px_#00f3ff]"></div>}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-5 scrollbar-thin">
              {activeTab === 'verification' && (
                <div className="space-y-4">
                  {proofs.length === 0 ? (
                    <div className="h-64 flex flex-col items-center justify-center opacity-20 italic">
                      <ShieldCheck size={48} className="mb-4" />
                      Awaiting Formal Verification Sequence...
                    </div>
                  ) : proofs.map((p, i) => (
                    <div key={i} className={`p-4 border rounded-lg transition-all ${
                        p.status === 'CRITICAL_VIOLATION' 
                        ? 'bg-red-500/10 border-red-500/50' 
                        : 'bg-white/5 border-white/10'
                    }`}>
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] font-bold uppercase text-cyan-400 tracking-tighter">{p.property}</span>
                        <span className={`text-[9px] px-2 py-0.5 rounded fira font-bold ${
                            p.status === 'CRITICAL_VIOLATION' ? 'bg-red-500 text-white' : 'bg-green-500/20 text-green-400'
                        }`}>
                            {p.status}
                        </span>
                      </div>
                      <p className="text-[11px] fira leading-relaxed opacity-60">
                        {p.proof}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'ast' && (
                <div className="space-y-4">
                  {!synthesis ? (
                    <div className="h-64 flex flex-col items-center justify-center opacity-20 italic">
                      <Layers size={48} className="mb-4" />
                      AST Manifestation Pending...
                    </div>
                  ) : (
                    <div className="fira text-[11px] space-y-4">
                      <div className="p-4 bg-cyan-500/5 border border-cyan-500/20 rounded-lg">
                        <div className="flex items-center gap-2 mb-2 text-cyan-400">
                          <Layers size={14} />
                          <span className="font-bold uppercase tracking-tighter">Structure Analysis</span>
                        </div>
                        <div className="text-[10px] space-y-1">
                          <div className="flex justify-between"><span>Root Identifier</span><span className="text-white/60">{synthesis.ast.root}</span></div>
                          <div className="flex justify-between"><span>Lattice Nodes</span><span className="text-white/60">{synthesis.ast.nodes}</span></div>
                          <div className="flex justify-between"><span>Recursive Depth</span><span className="text-white/60">log(N)</span></div>
                        </div>
                      </div>
                      <div className="relative pl-4 space-y-2">
                        <div className="absolute left-0 top-0 bottom-0 w-px bg-white/10"></div>
                        {synthesis.ast.branches.map((b: string, i: number) => (
                          <div key={i} className="group relative">
                            <div className="absolute -left-4 top-2 w-4 h-px bg-white/10 group-hover:bg-cyan-500 transition-colors"></div>
                            <div className="bg-white/5 p-2 rounded border border-white/5 group-hover:border-cyan-500/30 transition-all flex items-center gap-2">
                              <span className="text-white/60 group-hover:text-cyan-400">{b}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'editor' && (
                <div className="space-y-4">
                  {!selectedEntity ? (
                    <div className="h-64 flex flex-col items-center justify-center opacity-20 italic text-center">
                      <MousePointer2 size={48} className="mb-4" />
                      Select an entity in the substrate view to inspect and edit components.
                    </div>
                  ) : (
                    <div className="space-y-6">
                      <div className="flex items-center justify-between p-3 bg-cyan-500/10 border border-cyan-500/20 rounded-lg">
                        <div className="flex items-center gap-3">
                            <Activity size={18} className="text-cyan-400" />
                            <div>
                                <div className="text-xs font-bold uppercase">Entity [{selectedEntity.id}]</div>
                                <div className="text-[9px] opacity-40">Active Substrate Node</div>
                            </div>
                        </div>
                        <button onClick={() => setSelectedEntityId(null)} className="p-1 hover:bg-white/10 rounded transition-colors"><RefreshCcw size={12} /></button>
                      </div>

                      {Array.from(selectedEntity.components.entries()).map(([type, comp]) => (
                        <div key={type} className="p-4 bg-white/5 border border-white/10 rounded-lg space-y-3">
                          <div className="flex justify-between items-center border-b border-white/5 pb-2 mb-2">
                            <span className="text-[10px] font-bold uppercase text-cyan-400">{type}</span>
                            <Settings size={12} className="opacity-20" />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            {Object.entries(comp.data).map(([field, val]) => (
                              <div key={field} className="space-y-1">
                                <label className="text-[9px] uppercase opacity-30 block">{field}</label>
                                {typeof val === 'number' ? (
                                    <input 
                                        type="number"
                                        value={val}
                                        onChange={(e) => updateSelectedComponent(type, field, parseFloat(e.target.value))}
                                        className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] fira focus:border-cyan-500/50 outline-none"
                                    />
                                ) : (
                                    <input 
                                        type="text"
                                        value={val}
                                        onChange={(e) => updateSelectedComponent(type, field, e.target.value)}
                                        className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] fira focus:border-cyan-500/50 outline-none"
                                    />
                                )}
                              </div>
                            ))}
                          </div>
                          {type === 'Physics' && (
                              <div className="flex gap-2 pt-2">
                                  <button 
                                    onClick={() => updateSelectedComponent('Physics', 'vy', -400)}
                                    className="flex-1 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded text-[9px] font-bold flex items-center justify-center gap-1 transition-all"
                                  >
                                      <Move size={10} /> APPLY_IMPULSE
                                  </button>
                                  <button 
                                    onClick={() => updateSelectedComponent('Physics', 'vx', (Math.random() - 0.5) * 500)}
                                    className="flex-1 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-[9px] font-bold transition-all"
                                  >
                                      RAND_VEC
                                  </button>
                              </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'ecs' && (
                <div className="space-y-6">
                  {!synthesis ? (
                    <div className="h-64 flex flex-col items-center justify-center opacity-20 italic">
                      <Activity size={48} className="mb-4" />
                      ECS Logic Not Synthesized.
                    </div>
                  ) : (
                    <>
                      <div className="space-y-3">
                        <h4 className="text-[10px] font-bold uppercase opacity-40 flex items-center gap-2">
                            <Settings size={12} /> Synthesized Components
                        </h4>
                        {synthesis.components.map((c: any, i: number) => (
                          <div key={i} className="p-4 bg-white/5 border border-white/10 rounded-lg group">
                            <div className="text-xs font-bold text-cyan-400 mb-1">{c.name}</div>
                            <p className="text-[10px] opacity-40 mb-3 italic">{c.description}</p>
                            <div className="flex flex-wrap gap-1">
                              {c.fields.map((f: string, j: number) => (
                                <span key={j} className="text-[9px] fira bg-cyan-500/10 px-2 py-0.5 rounded text-cyan-200">{f}</span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'library' && (
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { name: 'Transform', desc: 'x, y, rotation, scale' },
                    { name: 'Physics', desc: 'vx, vy, friction, gravity' },
                    { name: 'Stats', desc: 'hp, mana, level' },
                    { name: 'Render', desc: 'color, sprite, opacity' },
                    { name: 'AiLogic', desc: 'state, targetId, path' },
                    { name: 'InputMap', desc: 'bindingKeys, axisMult' },
                  ].map((item, i) => (
                    <div key={i} className="p-3 bg-white/5 border border-white/10 rounded hover:border-cyan-500/50 transition-all cursor-help group">
                      <div className="text-[10px] font-bold text-cyan-400 mb-1">{item.name}</div>
                      <p className="text-[8px] opacity-40 leading-tight group-hover:opacity-80">{item.desc}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Structured Logging Console */}
          <div className="flex-1 bg-[#05070a] border-glass rounded overflow-hidden flex flex-col">
            <div className="h-10 bg-white/5 flex items-center px-4 justify-between border-b border-white/10">
              <div className="flex items-center gap-4">
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">System Trace Logs</span>
                  <div className="h-6 w-px bg-white/10"></div>
                  <div className="relative">
                      <input 
                        type="text" 
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="FILTER_LOGS"
                        className="bg-transparent text-[10px] fira focus:outline-none w-24 opacity-60"
                      />
                      <Search size={10} className="absolute -left-4 top-1/2 -translate-y-1/2 opacity-20" />
                  </div>
              </div>
              <div className="text-[9px] fira opacity-20 uppercase">Streaming_v2.1</div>
            </div>
            <div className="flex-1 p-3 fira text-[11px] overflow-y-auto space-y-2 scrollbar-thin">
              {filteredLogs.length === 0 ? (
                <div className="h-full flex items-center justify-center opacity-10 uppercase italic tracking-widest text-[10px]">No matches in trace buffer</div>
              ) : filteredLogs.map((log) => (
                <div key={log.id} className="flex gap-3 leading-tight animate-in fade-in slide-in-from-left-2 duration-300">
                  <span className="opacity-20 flex-shrink-0">[{new Date(log.timestamp).toLocaleTimeString([], {hour12: false})}]</span>
                  <span className={`font-bold flex-shrink-0 w-16 uppercase ${
                    log.severity === 'ERROR' || log.severity === 'FATAL' ? 'text-red-400' : 
                    log.severity === 'WARN' ? 'text-yellow-400' : 'text-cyan-600'
                  }`}>
                    {log.type.split('_')[0]}
                  </span>
                  <span className={`${
                    log.severity === 'ERROR' || log.severity === 'FATAL' ? 'text-red-300' : 
                    log.severity === 'WARN' ? 'text-yellow-100' : 'text-white/60'
                  }`}>
                    {log.message}
                    {log.metadata && (
                        <span className="block text-[9px] opacity-20 truncate mt-0.5">METADATA: {JSON.stringify(log.metadata)}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Status Bar */}
      <footer className="h-8 bg-[#05070a] border-t border-white/10 flex items-center justify-between px-6 z-50">
        <div className="flex gap-6 items-center">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${synthesis ? 'bg-cyan-500 animate-pulse' : 'bg-white/10'}`}></div>
            <span className="text-[9px] font-bold uppercase opacity-40 tracking-widest">Synthesis Engine: {synthesis ? 'IDLE' : 'STANDBY'}</span>
          </div>
          <div className="h-4 w-px bg-white/10"></div>
          <div className="flex items-center gap-2">
            <ShieldCheck size={12} className="text-green-500 opacity-40" />
            <span className="text-[9px] font-bold uppercase opacity-40 tracking-widest">Verification: OMNI_SOUND</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
            <div className="text-[9px] fira text-white/20 uppercase">Node_Lattice: {Math.floor(Math.random()*1000)}ms</div>
            <div className="text-[9px] fira text-cyan-400 opacity-60">BUILD_9921_SIGMA</div>
        </div>
      </footer>
    </div>
  );
};

export default App;
