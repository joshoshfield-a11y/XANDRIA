
import React from 'react';
import { MetaSystem } from '../types';

interface LatticeNodeProps {
  system: MetaSystem;
  onDebug?: (id: string) => void;
  onRetry?: (id: string) => void;
}

export const LatticeNode: React.FC<LatticeNodeProps> = ({ system, onDebug, onRetry }) => {
  const getStatusColor = () => {
    switch (system.status) {
      case 'ACTIVE': return 'bg-cyan-500 shadow-[0_0_20px_rgba(6,182,212,0.6)]';
      case 'BUILDING': return 'bg-yellow-500 animate-pulse';
      case 'RETRYING': return 'bg-orange-500 animate-[pulse_1.5s_cubic-bezier(0.4,0,0.6,1)_infinite] shadow-[0_0_25px_rgba(249,115,22,0.7)]';
      case 'DIAGNOSING': return 'bg-purple-500 animate-[pulse_2s_cubic-bezier(0.4,0,0.6,1)_infinite] shadow-[0_0_25px_rgba(168,85,247,0.7)]';
      case 'FAILED': return 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.5)]';
      case 'STALLED': return 'bg-red-900 shadow-[0_0_10px_rgba(127,29,29,0.5)]';
      default: return 'bg-slate-700';
    }
  };

  const getHealthColor = (health: number) => {
    if (health > 75) return 'bg-cyan-500';
    if (health > 40) return 'bg-orange-500';
    return 'bg-red-500';
  };

  const getBorderColor = () => {
    if (system.status === 'FAILED' || system.status === 'STALLED') return 'border-red-500/50';
    if (system.status === 'DIAGNOSING') return 'border-purple-500/60';
    if (system.status === 'RETRYING') return 'border-orange-500/60';
    switch (system.category) {
      case 'ENGINE': return 'border-blue-500/50';
      case 'ASSETS': return 'border-emerald-500/50';
      case 'PIPELINE': return 'border-yellow-500/50';
      case 'COGNITION': return 'border-purple-500/50';
      case 'DEPLOYMENT': return 'border-pink-500/50';
      default: return 'border-cyan-500/50';
    }
  };

  const getCategoryColor = (cat: string) => {
    switch (cat) {
      case 'ENGINE': return 'text-blue-400';
      case 'ASSETS': return 'text-emerald-400';
      case 'PIPELINE': return 'text-yellow-400';
      case 'COGNITION': return 'text-purple-400';
      case 'DEPLOYMENT': return 'text-pink-400';
      default: return 'text-cyan-400';
    }
  };

  const getBgColor = () => {
    switch (system.status) {
      case 'FAILED': return 'bg-red-500/10';
      case 'STALLED': return 'bg-red-950/30';
      case 'DIAGNOSING': return 'bg-purple-500/10';
      case 'RETRYING': return 'bg-orange-500/10';
      default: return 'hover:bg-white/5';
    }
  };

  return (
    <div className={`p-4 rounded-xl border-2 ${getBorderColor()} glass group transition-all duration-300 hover:scale-[1.03] ${getBgColor()}`}>
      <div className="flex justify-between items-start mb-2">
        <div className="flex flex-col truncate">
          <span className={`text-[9px] font-bold uppercase tracking-[0.25em] mb-1 ${getCategoryColor(system.category)}`}>
            {system.category}
          </span>
          <h4 className={`text-sm font-bold tracking-widest truncate mr-2 ${
            system.status === 'FAILED' || system.status === 'STALLED' ? 'text-red-400' : 
            system.status === 'DIAGNOSING' ? 'text-purple-400 glitch-text' : 
            system.status === 'RETRYING' ? 'text-orange-400' : 
            'text-white/90'
          }`}>
            {system.name}
          </h4>
        </div>
        <div className={`w-3 h-3 rounded-full ${getStatusColor()}`}></div>
      </div>
      
      <div className="w-full h-1 bg-white/5 rounded-full mb-3 overflow-hidden">
        <div 
          className={`h-full transition-all duration-1000 ease-in-out ${getHealthColor(system.health)}`}
          style={{ width: `${system.health}%` }}
        ></div>
      </div>

      <div className={`text-[10px] mb-3 fira leading-tight h-10 overflow-hidden line-clamp-2 transition-colors duration-300 ${
        system.status === 'FAILED' || system.status === 'STALLED' ? 'text-red-400/90' : 
        system.status === 'DIAGNOSING' ? 'text-purple-300/90 italic' : 
        system.status === 'RETRYING' ? 'text-orange-300/90' : 
        'text-white/50 italic'
      }`}>
        {system.status === 'DIAGNOSING' ? (
          <span className="flex items-center gap-2">
            <span className="animate-spin h-2 w-2 border-t border-purple-400 rounded-full inline-block"></span>
            TRACING_LOGIC_VECTOR...
          </span>
        ) : system.status === 'RETRYING' ? (
          <span className="flex flex-col">
            <span className="font-bold">RE_SYNCHRONIZING_CORE...</span>
            <span className="text-[9px] opacity-70">Attempt Vector: {system.retryCount || 1}/3</span>
          </span>
        ) : system.status === 'STALLED' ? (
          'LATTICE_CRITICAL: INTEGRITY_LIMIT_REACHED.'
        ) : (
          system.status === 'FAILED' ? (system.error || 'Logical collision detected.') : system.description
        )}
      </div>

      <div className="flex justify-between items-center mt-auto pt-2 border-t border-white/10">
        <div className="flex items-center gap-3">
          <span className={`text-[8px] fira uppercase tracking-[0.1em] opacity-50`}>
            {system.type}
          </span>
          <div className="flex items-center gap-1">
             <div className={`w-1 h-1 rounded-full ${getHealthColor(system.health)}`}></div>
             <span className={`text-[8px] fira font-bold tracking-tighter ${getHealthColor(system.health).replace('bg-', 'text-')}`}>
              {Math.round(system.health)}%_STABLE
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {system.status === 'STALLED' ? (
            <button 
              onClick={() => onRetry?.(system.id)}
              className="text-[9px] font-bold text-orange-400 hover:text-orange-300 underline underline-offset-4 decoration-orange-500/50 transition-all"
            >
              FORCE_RESUME
            </button>
          ) : (
            <button 
              onClick={() => system.status === 'FAILED' && onDebug?.(system.id)}
              className={`text-[9px] font-bold transition-all px-2 py-0.5 rounded border border-transparent ${
                system.status === 'FAILED' ? 'text-red-400 hover:border-red-500/30 hover:bg-red-500/10' : 
                system.status === 'DIAGNOSING' ? 'text-purple-400 animate-pulse' : 
                system.status === 'RETRYING' ? 'text-orange-400' : 
                'text-cyan-400 opacity-0 group-hover:opacity-100 hover:text-cyan-300'
              }`}
            >
              {system.status === 'FAILED' ? 'INIT_DEBUG' : 
               system.status === 'DIAGNOSING' ? 'TRACING' : 
               system.status === 'RETRYING' ? 'SYNCING' : 
               'VIEW_CORE'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
