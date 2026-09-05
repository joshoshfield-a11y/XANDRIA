
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Agent, AgentType, TelemetryData, BuildState, Anomaly } from './types';
import SimulationGrid from './components/SimulationGrid';
import TelemetryDashboard from './components/TelemetryDashboard';
import AgentDetail from './components/AgentDetail';
import { getAutomatedFix, getBalanceTuning } from './services/gemini';
import { Play, RotateCcw, ShieldAlert, Cpu, Terminal, Zap, Download, AlertTriangle, Target, Activity } from 'lucide-react';

const GRID_SIZE = { width: 800, height: 500 };

const App: React.FC = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryData[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [build, setBuild] = useState<BuildState>({
    version: '0.9.8-prime',
    status: 'stable',
    logs: ['[SYSTEM] QA Matrix Kernel Online.', '[SIM] Initializing Adversarial Neural Lattice...']
  });
  const [isSimulating, setIsSimulating] = useState(false);
  const [tuningSuggestions, setTuningSuggestions] = useState<any[]>([]);

  // Ref to track visited grid cells for coverage calculation
  const visitedCells = useRef<Set<string>>(new Set());

  const addLog = (msg: string) => {
    setBuild(prev => ({
      ...prev,
      logs: [...prev.logs.slice(-50), `[${new Date().toLocaleTimeString()}] ${msg}`]
    }));
  };

  const spawnAgents = useCallback(() => {
    visitedCells.current.clear();
    const newAgents: Agent[] = Array.from({ length: 18 }).map((_, i) => ({
      id: `NODE-${(i + 1).toString().padStart(3, '0')}`,
      type: i % 3 === 0 ? AgentType.EXPLORER : i % 3 === 1 ? AgentType.BREAKER : AgentType.STANDARD,
      position: { x: 50, y: 50 + Math.random() * (GRID_SIZE.height - 100) },
      velocity: { x: 1.5 + Math.random() * 2, y: (Math.random() - 0.5) * 3 },
      status: 'active',
      path: [],
      fitness: 0,
      reward: 0,
      convergence: 0.05,
      explorationCoverage: 0,
      actions: [{ timestamp: Date.now(), type: 'move', detail: 'Neural weight sync complete.' }]
    }));
    setAgents(newAgents);
    addLog(`INIT: Synchronized ${newAgents.length} RL Agents with System II.`);
  }, []);

  const detectAnomalies = useCallback((newTelemetry: TelemetryData) => {
    const alerts: Anomaly[] = [];
    if (newTelemetry.avgTTK > 85) {
      alerts.push({
        id: Math.random().toString(),
        timestamp: newTelemetry.time,
        metric: 'Time-to-Kill',
        value: newTelemetry.avgTTK,
        expectedRange: [30, 80],
        severity: 'high'
      });
    }
    if (newTelemetry.successRate < 5 && newTelemetry.avgReward < 100) {
      alerts.push({
        id: Math.random().toString(),
        timestamp: newTelemetry.time,
        metric: 'Policy Stagnation',
        value: newTelemetry.successRate,
        expectedRange: [15, 100],
        severity: 'medium'
      });
    }
    if (alerts.length > 0) {
      setAnomalies(prev => [...alerts, ...prev].slice(0, 15));
      addLog(`WATCHDOG: Flagged ${alerts.length} critical deviations.`);
    }
  }, []);

  const updateSimulation = useCallback(() => {
    if (!isSimulating) return;

    setAgents(prev => {
      const next = prev.map(agent => {
        if (agent.status !== 'active') return agent;

        let vx = agent.velocity.x;
        let vy = agent.velocity.y;
        let newAction = null;

        // Specialized RL Behaviors
        if (agent.type === AgentType.EXPLORER) {
          vx += (Math.random() - 0.35) * 0.8;
          vy += (Math.random() - 0.5) * 1.2;
          // Track Coverage
          const cellKey = `${Math.floor(agent.position.x / 40)},${Math.floor(agent.position.y / 40)}`;
          visitedCells.current.add(cellKey);
          if (Math.random() < 0.03) newAction = { type: 'interact', detail: 'Mapping occlusion...' };
        } else if (agent.type === AgentType.BREAKER) {
          if (agent.position.x > GRID_SIZE.width - 200) {
            vy += (Math.random() - 0.5) * 5; // Intense fuzzing jitter
          }
          vx += 0.4;
          if (Math.random() < 0.08) newAction = { type: 'fuzz', detail: 'Injecting malformed buffer...' };
        } else {
          vx += 0.25; // Standard efficiency
          if (Math.random() < 0.02) newAction = { type: 'jump', detail: 'Platform hop success.' };
        }

        const newPos = { x: agent.position.x + vx, y: agent.position.y + vy };
        let status = agent.status;
        let rewardDelta = 1.0;

        if (newPos.x >= GRID_SIZE.width - 30) {
          status = 'success';
          rewardDelta = 1000;
          addLog(`SUCCESS: ${agent.id} reached target manifold.`);
        }
        if (newPos.y < 0 || newPos.y > GRID_SIZE.height) {
          status = 'failed';
          rewardDelta = -200;
        }
        
        // Random crash trigger for Breakers (simulating finding a bug)
        if (agent.type === AgentType.BREAKER && Math.random() < 0.004) {
          status = 'crashed';
          newAction = { type: 'crash', detail: 'EXCEPTION: Memory access violation at 0xF3.' };
        }

        const currentCoverage = visitedCells.current.size / ((GRID_SIZE.width / 40) * (GRID_SIZE.height / 40));

        return {
          ...agent,
          position: newPos,
          velocity: { x: vx, y: vy },
          status,
          reward: agent.reward + rewardDelta,
          convergence: Math.min(1, agent.convergence + 0.0002),
          explorationCoverage: currentCoverage,
          path: [...agent.path.slice(-40), agent.position],
          actions: newAction ? [...agent.actions.slice(-15), { ...newAction, timestamp: Date.now() }] : agent.actions
        } as Agent;
      });

      const crashed = next.find(a => a.status === 'crashed');
      if (crashed && build.status === 'stable') handleCrash(crashed);

      return next;
    });
  }, [isSimulating, build.status]);

  const handleCrash = async (agent: Agent) => {
    setBuild(prev => ({ ...prev, status: 'unstable' }));
    addLog(`ALERT: Breaker ${agent.id} caused system fault.`);
    try {
      const fix = await getAutomatedFix("Access Violation at 0x00412F", "void* ptr = malloc(size); memcpy(ptr, src, src_len);");
      addLog(`RECOVERY: Gemini patched logic stream.`);
      setBuild(prev => ({ ...prev, status: 'stable', version: `0.9.${Math.floor(Math.random()*999)}-hotfix` }));
    } catch (e) {
      addLog(`ERROR: Automated recovery failed. Escalating...`);
    }
  };

  useEffect(() => {
    const timer = setInterval(updateSimulation, 33);
    return () => clearInterval(timer);
  }, [updateSimulation]);

  useEffect(() => {
    if (!isSimulating) return;
    const telemetryTimer = setInterval(() => {
      const successCount = agents.filter(a => a.status === 'success').length;
      const crashCount = agents.filter(a => a.status === 'crashed').length;
      const totalReward = agents.reduce((acc, a) => acc + a.reward, 0);
      const avgConv = (agents.reduce((acc, a) => acc + a.convergence, 0) / (agents.length || 1)) * 100;

      const newData: TelemetryData = {
        time: new Date().toLocaleTimeString(),
        successRate: (successCount / (agents.length || 1)) * 100,
        avgTTK: 50 + Math.random() * 40,
        crashes: crashCount,
        complexity: 60 + Math.random() * 30,
        avgReward: totalReward / (agents.length || 1),
        policyConvergence: avgConv
      };

      setTelemetry(prev => [...prev.slice(-50), newData]);
      detectAnomalies(newData);

      if (successCount > agents.length * 0.3) handleBalanceTuning();
    }, 2000);
    return () => clearInterval(telemetryTimer);
  }, [isSimulating, agents, detectAnomalies]);

  const handleBalanceTuning = async () => {
    const data = JSON.stringify(telemetry.slice(-5));
    try {
      const suggestions = await getBalanceTuning(data);
      setTuningSuggestions(suggestions.suggestions);
    } catch (e) {
      console.warn("Tuning sync interrupted.");
    }
  };

  const selectedAgent = agents.find(a => a.id === selectedAgentId);

  return (
    <div className="h-screen w-screen flex flex-col p-6 bg-[#05050a] text-white overflow-hidden selection:bg-cyan-500/30">
      <header className="flex justify-between items-start mb-6">
        <div className="glass p-5 rounded-2xl flex flex-col gap-1 min-w-[340px] border-l-4 border-l-cyan-500">
          <div className="flex items-center gap-3">
            <Activity className="w-5 h-5 text-cyan-400 animate-pulse" />
            <h1 className="text-2xl font-bold tracking-widest uppercase italic">AETHELGARD <span className="text-cyan-400">QA_MATRIX</span></h1>
          </div>
          <div className="flex justify-between text-[10px] fira opacity-40 uppercase mt-2">
            <span>Kernel: {build.version}</span>
            <span>Uptime: {Math.floor(performance.now() / 1000)}s</span>
          </div>
        </div>

        <div className="flex gap-4">
          <button 
            onClick={() => setIsSimulating(!isSimulating)}
            className={`flex items-center gap-2 px-8 py-3 rounded-xl font-bold tracking-widest uppercase transition-all duration-300 ${isSimulating ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'bg-cyan-500 text-black shadow-[0_0_25px_rgba(0,243,255,0.3)]'}`}
          >
            {isSimulating ? <Zap className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
            {isSimulating ? 'HALT_SIMULATION' : 'INIT_NEURAL_LINK'}
          </button>
          <button onClick={spawnAgents} className="flex items-center gap-2 px-6 py-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 font-bold uppercase transition-all">
            <RotateCcw className="w-4 h-4" /> REBOOT_LATTICE
          </button>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-12 gap-6 overflow-hidden mb-6">
        <section className="col-span-8 flex flex-col gap-6 overflow-hidden">
          <div className="flex-1 min-h-0">
            <SimulationGrid 
              agents={agents} 
              dimensions={GRID_SIZE} 
              onSelectAgent={setSelectedAgentId}
              selectedAgentId={selectedAgentId}
            />
          </div>
          <div className="h-48">
            <TelemetryDashboard data={telemetry} />
          </div>
        </section>

        <section className="col-span-4 flex flex-col gap-6 overflow-hidden">
          {/* Agent Playthrough Visualizer */}
          <div className="glass flex-1 rounded-2xl p-6 overflow-hidden flex flex-col border-cyan-500/10 shadow-inner">
            {selectedAgent ? (
              <AgentDetail agent={selectedAgent} />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center opacity-30 text-center space-y-4">
                <Target className="w-16 h-16 text-cyan-500/20 animate-spin-slow" />
                <div className="space-y-1">
                  <p className="text-xs uppercase font-bold tracking-[0.2em]">Telemetry Standby</p>
                  <p className="text-[10px] opacity-60">Select a neural node to initiate visual link.</p>
                </div>
              </div>
            )}
          </div>

          {/* Anomaly Detection Hub */}
          <div className="glass h-64 rounded-2xl p-5 flex flex-col border-red-500/10 relative overflow-hidden bg-gradient-to-br from-[#05050a] to-[#0a0a14]">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-white/5">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-500" />
                <h3 className="text-xs font-bold uppercase tracking-widest">Real-time Watchdog</h3>
              </div>
              <span className="text-[9px] px-2 py-0.5 bg-red-500/20 text-red-400 rounded-full font-bold">MONITORING</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 pr-2 scrollbar-hide">
              {anomalies.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-10 space-y-2">
                  <Zap className="w-8 h-8" />
                  <p className="text-[9px] uppercase font-bold">Lattice nominal</p>
                </div>
              ) : (
                anomalies.map((a, i) => (
                  <div key={i} className={`p-3 rounded-lg border transition-all hover:scale-[1.02] ${
                    a.severity === 'high' ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'
                  }`}>
                    <div className="flex justify-between items-center text-[10px] font-bold">
                      <span className="text-white uppercase flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {a.metric}
                      </span>
                      <span className={a.severity === 'high' ? 'text-red-400' : 'text-amber-400'}>{a.value.toFixed(1)}</span>
                    </div>
                    <p className="text-[9px] opacity-60 mt-1 leading-relaxed">{a.severity === 'high' ? 'Critical deviation detected. Corrective measures active.' : 'Minor drift observed in policy outputs.'}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="grid grid-cols-4 gap-6 h-24">
        {[
          { label: 'Policy Convergence', value: telemetry.length > 0 ? `${telemetry[telemetry.length-1].policyConvergence.toFixed(1)}%` : '0.0%', icon: Zap, color: 'text-purple-400' },
          { label: 'Exploration Rate', value: `${(agents.reduce((acc, a) => acc + (a.explorationCoverage || 0), 0) / (agents.length || 1) * 100).toFixed(1)}%`, icon: Target, color: 'text-green-400' },
          { label: 'System Fuzzing', value: 'ACTIVE', icon: Activity, color: 'text-amber-400' },
          { label: 'Anomalies Isolated', value: anomalies.length, icon: AlertTriangle, color: 'text-red-400' },
        ].map((stat, i) => (
          <div key={i} className="glass rounded-xl px-6 flex items-center gap-4 border-white/5 group hover:border-cyan-500/20 transition-all">
            <div className={`p-4 bg-white/5 rounded-2xl group-hover:bg-cyan-500/10 transition-colors ${stat.color}`}>
              <stat.icon className="w-6 h-6" />
            </div>
            <div>
              <p className="text-[10px] font-bold opacity-30 uppercase tracking-[0.2em]">{stat.label}</p>
              <p className="text-2xl font-bold tracking-tighter fira">{stat.value}</p>
            </div>
          </div>
        ))}
      </footer>
    </div>
  );
};

export default App;
