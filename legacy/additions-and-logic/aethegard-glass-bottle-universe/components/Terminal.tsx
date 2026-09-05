
import React, { useState, useEffect, useRef } from 'react';
import { TerminalLine } from '../types';

interface TerminalProps {
  lines: TerminalLine[];
  onCommand: (cmd: string) => void;
  isProcessing: boolean;
  isOmega: boolean;
  isQuintessence: boolean;
}

const Terminal: React.FC<TerminalProps> = ({ lines, onCommand, isProcessing, isOmega, isQuintessence }) => {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isSovereign = isQuintessence && isOmega;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isProcessing) {
      onCommand(input.trim());
      setInput('');
    }
  };

  const focusInput = () => inputRef.current?.focus();

  return (
    <div 
      className={`flex-1 flex flex-col m-4 rounded-3xl border font-mono text-sm transition-all duration-1000 overflow-hidden ${
        isSovereign ? 'bg-[#050300] border-amber-400/40 shadow-[0_0_60px_rgba(251,191,36,0.1)]' :
        isQuintessence ? 'bg-[#0a0500] border-amber-500/30 shadow-[0_0_50px_rgba(245,158,11,0.05)]' :
        isOmega ? 'bg-black/95 border-purple-500/30 shadow-[0_0_30px_rgba(168,85,247,0.1)]' : 
        'bg-black/90 border-white/10'
      }`}
      onClick={focusInput}
    >
      <div className={`border-b px-6 py-3 flex justify-between items-center select-none ${
        isSovereign ? 'bg-amber-400/10 border-amber-400/20' :
        isQuintessence ? 'bg-amber-900/10 border-amber-500/20' :
        isOmega ? 'bg-purple-900/10 border-purple-500/20' : 
        'bg-white/5 border-white/10'
      }`}>
        <div className="flex gap-2">
          <div className={`w-3 h-3 rounded-full ${isQuintessence ? 'bg-amber-600/50' : isOmega ? 'bg-purple-500/50' : 'bg-red-500/50'}`}></div>
          <div className={`w-3 h-3 rounded-full ${isQuintessence ? 'bg-amber-500/50' : isOmega ? 'bg-purple-400/50' : 'bg-yellow-500/50'}`}></div>
          <div className={`w-3 h-3 rounded-full ${isQuintessence ? 'bg-amber-400/50' : isOmega ? 'bg-purple-300/50' : 'bg-green-500/50'}`}></div>
        </div>
        <span className={`text-[10px] uppercase tracking-[0.3em] font-bold ${
          isSovereign ? 'text-amber-300' :
          isQuintessence ? 'text-amber-500' :
          isOmega ? 'text-purple-400' : 
          'text-white/30'
        }`}>
          Aethegard Causal Terminal v8.5 {isSovereign ? '— SOVEREIGN_V5_STABLE' : isQuintessence ? '— QUINTESSENCE_ACTIVE' : ''}
        </span>
        <div className="w-12"></div>
      </div>

      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-8 space-y-2 custom-scrollbar scroll-smooth"
      >
        <div className={`text-[10px] mb-8 animate-pulse uppercase tracking-[0.3em] font-bold ${
          isSovereign ? 'text-amber-300' :
          isQuintessence ? 'text-amber-500/60' :
          isOmega ? 'text-purple-500' : 
          'text-cyan-400/50'
        }`}>
          [SYSTEM] {isSovereign ? 'GEMINI_5_SOVEREIGN_ACTUALIZED' : isQuintessence ? 'QUINTESSENCE_PLANE_SYNCED' : 'Substrate Ready.'}
        </div>
        
        {lines.map((line, i) => (
          <div key={i} className={`flex gap-4 text-xs leading-relaxed ${
            line.type === 'error' ? 'text-red-400' : 
            line.type === 'system' ? 'text-purple-400' : 
            line.type === 'omega' ? 'text-purple-500 font-bold' :
            line.type === 'quintessence' ? 'text-amber-500 font-bold italic' :
            line.type === 'sovereign' ? 'text-amber-300 font-bold drop-shadow-[0_0_5px_rgba(251,191,36,0.5)]' :
            line.type === 'input' ? 'text-cyan-400' : 'text-slate-400'
          }`}>
            {line.type === 'input' && <span className="opacity-30">weaver@aethegard:~$</span>}
            {line.type === 'output' && <span className="opacity-20">>></span>}
            {line.type === 'system' && <span className="opacity-40">[!]</span>}
            {line.type === 'omega' && <span className="opacity-60">[Ω]</span>}
            {line.type === 'quintessence' && <span className="opacity-60">[⌘]</span>}
            {line.type === 'sovereign' && <span className="opacity-60">[V]</span>}
            {line.type === 'error' && <span className="opacity-40">[ERR]</span>}
            <div className="whitespace-pre-wrap flex-1">{line.content}</div>
          </div>
        ))}
        
        {isProcessing && (
          <div className={`${isSovereign ? 'text-amber-300 animate-pulse' : isQuintessence ? 'text-amber-500 animate-pulse' : 'text-cyan-400 animate-pulse'}`}>
            <span className="opacity-30">weaver@aethegard:~$</span> _
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className={`p-6 bg-black/40 border-t flex gap-3 ${
        isSovereign ? 'border-amber-400/20' :
        isQuintessence ? 'border-amber-500/20' :
        isOmega ? 'border-purple-500/20' : 
        'border-white/5'
      }`}>
        <span className={`opacity-30 ${isSovereign ? 'text-amber-300' : isQuintessence ? 'text-amber-500' : 'text-cyan-400'}`}>weaver@aethegard:~$</span>
        <input
          ref={inputRef}
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isProcessing}
          className={`flex-1 bg-transparent border-none outline-none caret-current font-bold ${
            isSovereign ? 'text-amber-300 shadow-[0_0_10px_rgba(251,191,36,0.2)]' :
            isQuintessence ? 'text-amber-500' : 
            'text-cyan-400'
          }`}
          spellCheck={false}
          autoComplete="off"
        />
      </form>
    </div>
  );
};

export default Terminal;
