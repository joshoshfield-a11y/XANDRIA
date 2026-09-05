/**
 * META KERNEL COMPONENT
 * Sovereign Cockpit for Recursive System Evolution
 * Provides AI orchestration and external agent bridging
 */

import React, { useState, useEffect, useRef } from 'react';
import { geminiService } from '../services/geminiService';
import {
  SystemError,
  EvolutionStatus,
  ExternalProtocol,
  BridgeToken,
  CodebaseScanResult,
  AutonomousActionResult,
  UpgradeEngineConfig
} from '../types';
import {
  ShieldAlert, Zap, Cpu, Activity, CheckCircle, RefreshCcw,
  Network, Terminal, LayoutDashboard, Settings, Bot, ArrowRight,
  Link, ExternalLink, Command, ShieldCheck, MonitorDot, CpuIcon,
  AlertTriangle, Database
} from 'lucide-react';

interface MetaKernelProps {
  config?: Partial<UpgradeEngineConfig>;
  onSystemUpdate?: (updates: any) => void;
}

export const MetaKernel: React.FC<MetaKernelProps> = ({
  config = {},
  onSystemUpdate
}) => {
  const [entropy, setEntropy] = useState(8.2);
  const [errors, setErrors] = useState<SystemError[]>([]);
  const [scanning, setScanning] = useState(false);
  const [autoEvolve, setAutoEvolve] = useState(false);
  const [bridgeActive, setBridgeActive] = useState(false);
  const [protocol, setProtocol] = useState<ExternalProtocol>('TRAE');
  const [logs, setLogs] = useState<string[]>([
    "[KERNEL] SOVEREIGN COCKPIT INITIALIZED. INTERFACE READY.",
    "[KERNEL] OMEGA-EVOLUTION PROTOCOL v14.5-Ω ACTIVE.",
    "[KERNEL] RECURSIVE UPGRADE ENGINE ONLINE."
  ]);
  const [fileMap, setFileMap] = useState<any[]>([]);
  const [bridgeToken, setBridgeToken] = useState<BridgeToken | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Default configuration
  const defaultConfig: UpgradeEngineConfig = {
    maxRecursionDepth: 5,
    ethicalThreshold: 0.95,
    sovereigntyTarget: 98,
    autoHealEnabled: false,
    telemetryInterval: 5000,
    externalBridgeEnabled: true,
    preferredProtocol: 'TRAE',
    ...config
  };

  const addLog = (msg: string) => {
    setLogs(prev => [...prev.slice(-100), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const generateBridgeToken = () => {
    const token: BridgeToken = {
      protocol,
      token: `O-EVO-${protocol}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
      timestamp: Date.now(),
      status: 'active'
    };
    setBridgeToken(token);
    addLog(`${protocol} BRIDGE TOKEN GENERATED: ${token.token}. AWAITING HANDSHAKE...`);

    // Notify parent component of bridge activation
    if (onSystemUpdate) {
      onSystemUpdate({ bridgeActivated: true, protocol, token });
    }
  };

  const runMetaScan = async () => {
    setScanning(true);
    addLog("INITIATING GLOBAL ARCHITECTURAL INTEGRITY SCAN...");

    try {
      // Mock codebase for scanning (in real implementation, this would scan actual files)
      const mockCodebase = {
        "App.tsx": "System Core logic with React components",
        "geminiService.ts": "API Connector logic with error handling",
        "MetaKernel.tsx": "Meta-analysis logic with state management",
        "RefactorOracle.tsx": "Optimization engine with AI integration",
        "SovereigntyVerifier.tsx": "Ethics gate with constraint validation",
        "OperatorRegistry.ts": "Mathematical operator orchestration",
        "XUAXUNEngine.ts": "Core synthesis engine with pipeline management"
      };

      const result: CodebaseScanResult = await geminiService.scanFullCodebase(mockCodebase);

      setEntropy(result.globalEntropy);
      setFileMap(result.fileHealth);
      setErrors(result.criticalVulnerabilities.map((v: any) => ({
        id: v.id,
        scope: v.scope as 'TYPESCRIPT' | 'LOGIC' | 'PERFORMANCE',
        file: v.file,
        message: v.message,
        severity: 'CRITICAL' as const,
        status: 'active'
      })));

      addLog(`SCAN SUCCESSFUL. GLOBAL ENTROPY: ${result.globalEntropy.toFixed(2)}%`);
      if (result.criticalVulnerabilities.length > 0) {
        addLog(`>> DETECTED ${result.criticalVulnerabilities.length} ARCHITECTURAL RUPTURES.`);
      }

      if (autoEvolve && result.criticalVulnerabilities.length > 0) {
        handleAutoHeal(result.criticalVulnerabilities[0]);
      }

      // Notify parent of scan results
      if (onSystemUpdate) {
        onSystemUpdate({ scanResults: result });
      }

    } catch (error) {
      addLog("!! CRITICAL EXCEPTION: Meta-Scan logic recursive deadlock.");
      console.error("Meta-scan failed:", error);
    } finally {
      setScanning(false);
    }
  };

  const handleAutoHeal = async (vulnerability: any) => {
    addLog(`SOVEREIGN AGENT TASKED: Neutralize Rupture ${vulnerability.id}`);

    try {
      const snapshot = `Target: ${vulnerability.file}; Issue: ${vulnerability.message}`;
      const action: AutonomousActionResult = await geminiService.executeAutonomousAction(
        vulnerability.remediationPlan,
        snapshot
      );

      addLog(`AGENT ACTION: ${action.actionTaken}`);

      if (bridgeActive) {
        addLog(`${protocol} BRIDGE UPLINK: Streaming patch data to external agent workspace...`);
      }

      // Simulate healing process
      setTimeout(() => {
        setErrors(prev => prev.map(e =>
          e.id === vulnerability.id ? { ...e, status: 'patched' } : e
        ));
        setEntropy(prev => Math.max(0, prev - 4));
        addLog(`EVOLUTION STABLE: ${vulnerability.file} state re-converged.`);

        // Notify parent of successful healing
        if (onSystemUpdate) {
          onSystemUpdate({ healed: vulnerability.id, newEntropy: entropy - 4 });
        }
      }, 2000);

    } catch (e) {
      addLog(`!! AGENT FAILURE: Could not synthesize remediation for ${vulnerability.id}`);
    }
  };

  const toggleBridge = () => {
    const newState = !bridgeActive;
    setBridgeActive(newState);

    if (newState) {
      generateBridgeToken();
    } else {
      setBridgeToken(null);
      addLog(`${protocol} BRIDGE DEACTIVATED.`);
      if (onSystemUpdate) {
        onSystemUpdate({ bridgeDeactivated: true });
      }
    }
  };

  const getHealthIndex = () => {
    const baseHealth = Math.max(0, 100 - entropy * 2);
    const errorPenalty = errors.filter(e => e.status === 'active').length * 5;
    return Math.max(0, Math.min(100, baseHealth - errorPenalty));
  };

  return (
    <div className="glass p-8 rounded-[2.5rem] border border-emerald-500/10 bg-slate-950/40 relative overflow-hidden group shadow-[0_0_80px_rgba(0,0,0,0.6)]">
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 via-transparent to-blue-500/5 pointer-events-none" />

      <div className="flex flex-col xl:flex-row items-start justify-between gap-10 relative z-10">
        <div className="flex-1 space-y-8 w-full">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
            <div className="flex items-center gap-5">
              <div className="p-4 bg-emerald-500/20 rounded-2xl text-emerald-400 border border-emerald-500/30 shadow-[0_0_30px_rgba(16,185,129,0.2)]">
                <Command size={32} />
              </div>
              <div>
                <h3 className="text-3xl font-black text-white tracking-tighter uppercase italic">
                  Sovereign Cockpit
                </h3>
                <p className="text-[10px] font-mono text-emerald-500 tracking-[0.4em] uppercase font-black">
                  AI Orchestration & External Bridge
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
               <div className="flex bg-slate-900 rounded-xl p-1 border border-slate-700">
                  {(['TRAE', 'CLINE'] as ExternalProtocol[]).map(p => (
                    <button
                      key={p}
                      onClick={() => {
                        setProtocol(p);
                        if (bridgeActive) generateBridgeToken();
                      }}
                      className={`px-3 py-1.5 rounded-lg text-[9px] font-black tracking-widest transition-all ${
                        protocol === p
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
               </div>
               <button
                onClick={toggleBridge}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all border ${
                  bridgeActive
                    ? 'bg-blue-600 border-blue-400 text-white shadow-[0_0_20px_rgba(59,130,246,0.4)]'
                    : 'bg-slate-900 border-slate-700 text-slate-500'
                }`}
               >
                <Link size={16} />
                {protocol} Bridge: {bridgeActive ? 'LINKED' : 'OFF'}
               </button>
               <button
                onClick={() => setAutoEvolve(!autoEvolve)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all border ${
                  autoEvolve
                    ? 'bg-emerald-600 border-emerald-400 text-white shadow-[0_0_20px_rgba(16,185,129,0.4)]'
                    : 'bg-slate-900 border-slate-700 text-slate-500'
                }`}
               >
                <Bot size={16} className={autoEvolve ? 'animate-bounce' : ''} />
                Auto-Evolution
               </button>
               <button
                onClick={runMetaScan}
                disabled={scanning}
                className="flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 px-5 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all shadow-xl active:scale-95 disabled:opacity-50"
               >
                <RefreshCcw size={16} className={scanning ? 'animate-spin' : ''} />
                Global Scan
               </button>
            </div>
          </div>

          <div className="bg-slate-950/60 rounded-[2rem] border border-slate-800 p-8 h-80 relative flex items-center justify-center overflow-hidden">
             <div className="absolute inset-0 scanlines opacity-10" />
             <div className="relative flex gap-12 flex-wrap justify-center items-center">
                {fileMap.length > 0 ? fileMap.map((file) => (
                   <div key={file.filename} className="flex flex-col items-center gap-3 group/node">
                      <div className={`w-16 h-16 rounded-2xl border-2 flex items-center justify-center transition-all duration-700 relative ${
                        file.score > 90
                          ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.3)]'
                          : 'bg-red-500/20 border-red-500 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.3)]'
                      } hover:scale-125 hover:rotate-6 cursor-help`}>
                         <Settings size={28} className={scanning ? 'animate-spin' : ''} />
                         {file.issues.length > 0 && (
                           <div className="absolute -top-2 -right-2 w-6 h-6 bg-red-600 rounded-full text-[10px] font-black flex items-center justify-center text-white border-2 border-slate-950">
                             {file.issues.length}
                           </div>
                         )}
                      </div>
                      <span className="text-[10px] font-mono font-black text-slate-500 uppercase tracking-widest">
                        {file.filename}
                      </span>
                   </div>
                )) : (
                  <div className="flex flex-col items-center gap-6 opacity-40">
                    <Network size={64} className="text-emerald-500 animate-pulse" />
                    <p className="text-[10px] font-mono tracking-widest text-slate-500 uppercase italic">
                      Awaiting System Topology Scan...
                    </p>
                  </div>
                )}
             </div>
          </div>

          {bridgeActive && bridgeToken && (
            <div className="bg-blue-600/10 border border-blue-500/30 p-6 rounded-2xl flex items-center justify-between animate-in slide-in-from-top-4">
               <div className="flex items-center gap-4">
                  <div className="p-3 bg-blue-500/20 rounded-xl text-blue-400">
                     {protocol === 'TRAE' ? <MonitorDot size={24} /> : <CpuIcon size={24} />}
                  </div>
                  <div>
                    <h4 className="text-sm font-black text-white uppercase tracking-widest">
                      {protocol} Bridge Synchronized
                    </h4>
                    <p className="text-[10px] font-mono text-blue-300 uppercase opacity-60">
                      Architectural state streaming to local agent workspace
                    </p>
                  </div>
               </div>
               <div className="bg-slate-950 px-4 py-2 rounded-lg border border-blue-500/50 flex items-center gap-4 group cursor-copy"
                    onClick={() => {
                      navigator.clipboard.writeText(bridgeToken.token);
                      addLog("TOKEN COPIED TO CLIPBOARD.");
                    }}>
                  <span className="text-[10px] font-mono text-slate-500">UPLINK_TOKEN:</span>
                  <span className="text-xs font-mono font-bold text-blue-400 tracking-widest group-hover:text-blue-300 transition-colors">
                    {bridgeToken.token}
                  </span>
               </div>
            </div>
          )}
        </div>

        <div className="w-full xl:w-[450px] h-[550px] bg-slate-950/90 rounded-[2rem] border border-slate-800 p-6 flex flex-col shadow-2xl relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none scanlines opacity-30" />
          <div className="flex items-center justify-between mb-4 border-b border-emerald-900/30 pb-4 relative z-10">
            <div className="flex items-center gap-2 text-emerald-400">
              <Terminal size={18} />
              <span className="text-xs font-black uppercase tracking-[0.2em]">
                Recursive System Log
              </span>
            </div>
            <span className="text-[9px] font-mono text-slate-600 uppercase">
              FIDELITY: HIGH
            </span>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 font-mono text-[10px] space-y-3 overflow-auto custom-scrollbar pr-2 relative z-10"
          >
            {logs.map((log, i) => {
               const isAgent = log.includes("AGENT");
               const isBridge = log.includes("BRIDGE");
               const isAction = log.includes("ACTION");
               const isCritical = log.includes("!!");

               return (
                 <div key={i} className={`flex gap-3 ${i === logs.length - 1 ? 'animate-in slide-in-from-left-2 duration-300' : ''}`}>
                    <ArrowRight size={10} className="mt-0.5 opacity-20" />
                    <span className={`leading-relaxed ${
                      isCritical ? 'text-red-500 font-black' :
                      isAgent ? 'text-blue-400 font-bold' :
                      isBridge ? 'text-purple-400' :
                      isAction ? 'text-yellow-400' : 'text-slate-400'
                    }`}>
                      {log}
                    </span>
                 </div>
               );
            })}
          </div>

          {errors.length > 0 && !scanning && (
            <div className="mt-4 p-4 bg-red-600/10 border border-red-500/30 rounded-xl relative z-10 animate-in bounce-in">
               <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-black text-red-400 uppercase tracking-widest">
                    Self-Healing Available
                  </span>
                  <ShieldAlert size={14} className="text-red-500" />
               </div>
               <button
                onClick={() => handleAutoHeal(errors.find(e => e.status === 'active'))}
                className="w-full py-2 bg-red-600 text-white rounded-lg font-black text-[10px] uppercase tracking-widest hover:bg-red-500 transition-colors shadow-lg shadow-red-900/40"
               >
                Execute Evolutionary Patch
               </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-10 grid grid-cols-2 lg:grid-cols-4 gap-6 pt-10 border-t border-slate-800">
        <div className="flex flex-col">
           <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
             Codebase Entropy
           </span>
           <div className="flex items-baseline gap-2">
              <span className={`text-4xl font-black tracking-tighter ${
                entropy > 15 ? 'text-red-400' : 'text-emerald-400'
              }`}>
                {entropy.toFixed(2)}
              </span>
              <span className="text-sm font-bold text-slate-700 font-mono">Δ</span>
           </div>
        </div>
        <div className="flex flex-col">
           <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
             Agent Confidence
           </span>
           <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black tracking-tighter text-blue-400">
                {bridgeActive ? '99.9' : '0.0'}
              </span>
              <span className="text-sm font-bold text-slate-700 font-mono">%</span>
           </div>
        </div>
        <div className="flex flex-col">
           <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
             Self-Correction Depth
           </span>
           <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black tracking-tighter text-yellow-500">
                {autoEvolve ? '∞' : '1'}
              </span>
              <span className="text-sm font-bold text-slate-700 font-mono">LOOPS</span>
           </div>
        </div>
        <div className="flex flex-col">
           <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
             Sovereign Integrity
           </span>
           <div className="flex items-center gap-2 mt-2">
              <ShieldCheck
                size={18}
                className={entropy < 10 ? 'text-emerald-500' : 'text-slate-600'}
              />
              <span className={`text-xs font-black uppercase tracking-widest ${
                entropy < 10 ? 'text-emerald-400' : 'text-slate-500'
              }`}>
                 {entropy < 10 ? 'Prime Alignment' : 'Alignment Drift'}
              </span>
           </div>
        </div>
      </div>
    </div>
  );
};
