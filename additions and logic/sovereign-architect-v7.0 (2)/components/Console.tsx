
import React, { useEffect, useRef } from 'react';

interface ConsoleProps {
  logs: string[];
}

export const Console: React.FC<ConsoleProps> = ({ logs }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex justify-between items-center mb-3 px-1 border-b border-white/5 pb-2">
        <span className="text-[10px] font-bold opacity-50 uppercase tracking-[0.3em]">Synaptic Trace Log</span>
        <div className="flex items-center gap-2">
           <span className="text-[8px] fira text-cyan-500 bg-cyan-500/10 px-2 py-0.5 rounded">AUTO_LOG_ON</span>
           <div className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse"></div>
        </div>
      </div>
      <div 
        ref={scrollRef}
        className="flex-1 bg-black/60 rounded-xl p-5 fira text-[11px] leading-relaxed overflow-y-auto border border-white/5 custom-scroll shadow-inner"
      >
        {logs.map((log, i) => {
          const isError = log.includes('[ERROR]') || log.includes('[CRITICAL]');
          const isBrain = log.includes('[BRAIN]');
          const isForge = log.includes('[FORGE]');
          
          return (
            <div key={i} className="mb-2 group">
              <span className={`text-[9px] opacity-20 mr-3 font-bold group-hover:opacity-50 transition-opacity`}>
                {new Date().toLocaleTimeString()}
              </span>
              <span className={`
                ${isError ? 'text-red-400 font-bold' : 
                  isBrain ? 'text-cyan-400 font-bold' : 
                  isForge ? 'text-purple-400 font-bold' : 
                  'opacity-80 text-white/80'}
              `}>
                {log}
              </span>
            </div>
          );
        })}
        <div className="animate-pulse inline-block w-2 h-3 bg-cyan-500/40 ml-1"></div>
      </div>
    </div>
  );
};
