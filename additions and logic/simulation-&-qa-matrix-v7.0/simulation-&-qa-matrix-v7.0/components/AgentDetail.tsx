
import React, { useState, useEffect } from 'react';
import { Agent, AgentType } from '../types';
// Add missing ShieldAlert import and remove unused icons Eye and Zap
import { Activity, Cpu, Scan, Crosshair, ShieldAlert } from 'lucide-react';

interface AgentDetailProps {
  agent: Agent;
}

const AgentDetail: React.FC<AgentDetailProps> = ({ agent }) => {
  const [glitch, setGlitch] = useState(false);

  useEffect(() => {
    if (agent.status === 'crashed') {
      setGlitch(true);
      const timer = setTimeout(() => setGlitch(false), 500);
      return () => clearTimeout(timer);
    }
  }, [agent.status]);

  return (
    <div className={`flex flex-col h-full transition-colors duration-300 ${glitch ? 'bg-red-500/20' : ''}`}>
      <div className="flex items-center justify-between mb-6 pb-3 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${agent.status === 'active' ? 'bg-green-400 animate-pulse' : 'bg-red-400 shadow-[0_0_10px_#ef4444]'}`}></div>
          <div>
            <h3 className="text-sm font-bold fira tracking-tighter text-cyan-400">{agent.id}</h3>
            <p className="text-[8px] opacity-40 uppercase tracking-[0.2em] font-bold">{agent.type}</p>
          </div>
        </div>
        <div className="flex gap-2">
           <span className="text-[10px] bg-white/5 px-2 py-1 rounded fira opacity-60">XY: {agent.position.x.toFixed(0)},{agent.position.y.toFixed(0)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-white/5 p-3 rounded-xl border border-white/5">
          <div className="flex items-center gap-1 mb-1">
            <Activity className="w-3 h-3 text-green-400" />
            <p className="text-[9px] opacity-40 uppercase font-bold">Reward</p>
          </div>
          <p className="text-lg font-bold text-green-400 fira">{agent.reward.toFixed(0)}</p>
        </div>
        <div className="bg-white/5 p-3 rounded-xl border border-white/5">
          <div className="flex items-center gap-1 mb-1">
            <Cpu className="w-3 h-3 text-purple-400" />
            <p className="text-[9px] opacity-40 uppercase font-bold">Policy</p>
          </div>
          <p className="text-lg font-bold text-purple-400 fira">{(agent.convergence * 100).toFixed(1)}%</p>
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-6 overflow-hidden">
        {/* Playthrough Perspective */}
        <div className="glass aspect-video rounded-2xl relative overflow-hidden bg-black/60 group">
          <div className="absolute top-3 left-3 flex items-center gap-2 text-[9px] font-bold uppercase z-10 text-white/70">
             <Scan className="w-3 h-3 text-cyan-400" /> FEED_01 // LIVE_VIEW
          </div>
          
          {/* Simulated Perspective Elements */}
          <div className="absolute inset-0 flex items-center justify-center">
             {/* Dynamic scanner lines */}
             <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(0,0,0,0.6)_100%)]"></div>
             <div className="w-full h-px bg-cyan-500/10 absolute animate-scan"></div>
             
             {/* Reticle */}
             <div className={`relative transition-transform duration-300 ${agent.status === 'active' ? 'scale-110' : 'scale-90'}`} style={{ transform: `translate(${(agent.velocity.x * 5)}px, ${(agent.velocity.y * 5)}px)` }}>
               <Crosshair className={`w-12 h-12 transition-colors ${agent.status === 'crashed' ? 'text-red-500' : 'text-cyan-400/30'}`} />
               {agent.status === 'active' && (
                 <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                   <div className="w-24 h-24 border border-cyan-500/10 rounded-full animate-ping"></div>
                 </div>
               )}
             </div>

             {/* Environment HUD */}
             <div className="absolute bottom-4 right-4 text-right space-y-0.5">
                <p className="text-[8px] fira opacity-40">VEL_X: {agent.velocity.x.toFixed(2)}</p>
                <p className="text-[8px] fira opacity-40">VEL_Y: {agent.velocity.y.toFixed(2)}</p>
             </div>
          </div>
          
          {/* Crash Overlay */}
          {agent.status === 'crashed' && (
            <div className="absolute inset-0 bg-red-900/40 flex items-center justify-center backdrop-blur-[2px]">
              <div className="text-center">
                <ShieldAlert className="w-10 h-10 text-white mx-auto mb-2 animate-bounce" />
                <p className="text-xs font-bold uppercase tracking-widest text-white">FATAL_ERROR: MEM_FAULT</p>
              </div>
            </div>
          )}
        </div>

        {/* Live Action Stream */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-2 scrollbar-hide">
          <h4 className="text-[10px] font-bold opacity-30 uppercase tracking-[0.3em] mb-3">Neural Log / Actions</h4>
          {agent.actions.map((action, i) => (
            <div key={i} className="flex gap-4 text-[10px] fira items-start border-l border-white/10 pl-4 py-2 hover:bg-white/5 transition-colors rounded-r-lg group">
              <span className="opacity-20 font-light whitespace-nowrap">{(action.timestamp / 1000).toFixed(2)}s</span>
              <div className="flex-1">
                <div className="flex justify-between">
                  <span className={`uppercase font-bold tracking-tighter ${
                    action.type === 'crash' ? 'text-red-400' : 
                    action.type === 'fuzz' ? 'text-amber-400' :
                    action.type === 'interact' ? 'text-cyan-400' : 'text-white/70'
                  }`}>{action.type}</span>
                </div>
                <p className="opacity-40 text-[9px] mt-0.5 group-hover:opacity-100 transition-opacity">{action.detail}</p>
              </div>
            </div>
          ))}
          {agent.actions.length === 0 && (
            <div className="h-20 flex items-center justify-center text-[10px] opacity-10 uppercase tracking-widest">
              Awaiting signal...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentDetail;
