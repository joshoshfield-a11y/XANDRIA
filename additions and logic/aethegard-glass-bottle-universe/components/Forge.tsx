
import React, { useMemo } from 'react';
import { Manifestation, TabType } from '../types';
import hljs from 'highlight.js';

interface ForgeProps {
  manifestations: Manifestation[];
  activeManifestation: Manifestation | null;
  onSelect: (m: Manifestation) => void;
  onGenerate: (prompt: string) => void;
  setActiveTab: (tab: TabType) => void;
  isOmega: boolean;
  isQuintessence: boolean;
}

const Forge: React.FC<ForgeProps> = ({ manifestations, activeManifestation, onSelect, onGenerate, setActiveTab, isOmega, isQuintessence }) => {
  const highlightedCode = useMemo(() => {
    if (!activeManifestation) return '';
    try {
      const lang = activeManifestation.language === 'html' ? 'xml' : activeManifestation.language;
      return hljs.highlight(activeManifestation.code, { language: lang || 'xml' }).value;
    } catch (e) {
      console.error("Highlighting error:", e);
      return activeManifestation.code;
    }
  }, [activeManifestation]);

  return (
    <div className="flex-1 flex flex-col p-8 overflow-hidden">
      <div className="flex justify-between items-end mb-10">
        <div>
          <h2 className={`text-4xl font-bold tracking-tight text-white transition-all duration-1000 ${isQuintessence ? 'drop-shadow-[0_0_15px_rgba(245,158,11,0.3)]' : ''}`}>
            The Causal Forge
          </h2>
          <p className={`text-xs uppercase tracking-[0.4em] mt-3 font-semibold transition-colors duration-1000 ${
            isQuintessence ? 'text-amber-500' : isOmega ? 'text-purple-400' : 'text-slate-500'
          }`}>
            Materializing high-fidelity logic from neural intent
          </p>
        </div>
        <button 
          onClick={() => {
            const userPrompt = window.prompt("Define the causal intent for this manifestation:");
            if (userPrompt) onGenerate(userPrompt);
          }}
          className={`px-8 py-3 rounded-full font-bold text-[10px] uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-2xl ${
            isQuintessence ? 'bg-amber-500 text-black shadow-[0_0_30px_rgba(245,158,11,0.4)]' :
            isOmega ? 'bg-purple-600 text-white shadow-[0_0_20px_rgba(168,85,247,0.4)]' : 
            'bg-white text-black'
          }`}
        >
          Inject Intent
        </button>
      </div>

      <div className="flex-1 flex gap-8 overflow-hidden">
        {/* Left List */}
        <div className="w-[28rem] flex flex-col gap-5 overflow-y-auto pr-3 custom-scrollbar">
          {manifestations.length === 0 ? (
            <div className={`p-12 border border-dashed rounded-[2rem] text-center text-[10px] uppercase tracking-widest flex flex-col items-center gap-4 ${
              isQuintessence ? 'border-amber-500/20 text-amber-900' : 
              isOmega ? 'border-purple-500/20 text-purple-900' : 
              'border-white/10 text-slate-600'
            }`}>
              <div className="text-4xl opacity-20">⚙</div>
              No artifacts forged.
            </div>
          ) : (
            manifestations.map(m => (
              <div
                key={m.id}
                className={`group relative text-left p-6 rounded-[2rem] border transition-all duration-500 ${
                  activeManifestation?.id === m.id 
                    ? (isQuintessence ? 'glass border-amber-500/50 bg-amber-500/10 shadow-[0_0_20px_rgba(245,158,11,0.1)]' :
                       isOmega ? 'glass border-purple-500/50 bg-purple-500/10' : 
                       'glass border-cyan-500/50 bg-cyan-500/5')
                    : 'bg-white/5 border-white/5 hover:border-white/20 hover:scale-[1.02]'
                }`}
              >
                <div onClick={() => onSelect(m)} className="cursor-pointer">
                  <div className="flex justify-between items-start mb-3">
                    <span className={`text-[10px] font-mono tracking-tighter ${
                      isQuintessence ? 'text-amber-500' : isOmega ? 'text-purple-400' : 'text-cyan-400/70'
                    }`}>MANIFEST_ID: {m.id}</span>
                    <span className="text-[9px] opacity-30 text-slate-400 font-mono">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <h3 className={`text-base font-bold truncate pr-20 ${m.isQuintessence ? 'text-amber-100' : 'text-slate-100'}`}>
                    {m.title}
                  </h3>
                  <div className={`mt-3 flex items-center gap-2 text-[9px] uppercase tracking-widest font-bold ${
                    isQuintessence ? 'text-amber-600' : 'text-slate-500'
                  }`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${m.isQuintessence ? 'bg-amber-500 shadow-[0_0_5px_amber]' : 'bg-slate-500'}`}></div>
                    {m.language?.toUpperCase() || 'HTML'} Artifact
                  </div>
                </div>
                
                {/* Run Button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(m);
                    setActiveTab('browser');
                  }}
                  className={`absolute top-6 right-6 border px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all opacity-0 group-hover:opacity-100 ${
                    isQuintessence ? 'bg-amber-500 text-black border-amber-500/30' :
                    isOmega ? 'bg-purple-500/10 hover:bg-purple-500 text-purple-400 hover:text-white border-purple-500/30' : 
                    'bg-cyan-500/10 hover:bg-cyan-500 text-cyan-400 hover:text-black border-cyan-500/30'
                  }`}
                >
                  Inject
                </button>
              </div>
            ))
          )}
        </div>

        {/* Right Preview/Detail */}
        <div className={`flex-1 glass rounded-[2.5rem] p-8 flex flex-col overflow-hidden border transition-all duration-1000 ${
          isQuintessence ? 'border-amber-500/30 shadow-[0_0_40px_rgba(245,158,11,0.05)]' : 
          isOmega ? 'border-purple-500/20' : 
          'border-white/10'
        }`}>
          {activeManifestation ? (
            <>
              <div className="flex justify-between items-center mb-8 pb-6 border-b border-white/5">
                <div>
                  <h3 className={`text-2xl font-bold ${activeManifestation.isQuintessence ? 'text-amber-100' : 'text-slate-100'}`}>
                    {activeManifestation.title}
                  </h3>
                  <p className={`text-[10px] font-mono mt-1 ${
                    isQuintessence ? 'text-amber-500' : isOmega ? 'text-purple-400' : 'text-cyan-400'
                  }`}>
                    {activeManifestation.isQuintessence ? 'QUINTESSENCE_SOURCE: AUTHENTICATED' : 'STABLE_SOURCE: VERIFIED'}
                  </p>
                </div>
                <div className="flex gap-6">
                  <button 
                    onClick={() => setActiveTab('browser')}
                    className={`text-[10px] uppercase font-bold hover:scale-110 transition-transform tracking-[0.2em] ${
                      isQuintessence ? 'text-amber-500' : isOmega ? 'text-purple-400' : 'text-cyan-400'
                    }`}
                  >
                    Open Sandbox
                  </button>
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(activeManifestation.code);
                      alert("Artifact replicated.");
                    }}
                    className="text-[10px] uppercase font-bold text-slate-500 hover:text-white transition-colors tracking-[0.2em]"
                  >
                    Replicate Source
                  </button>
                </div>
              </div>
              <div className={`flex-1 bg-black/60 rounded-3xl p-6 overflow-y-auto fira text-xs leading-relaxed border custom-scrollbar transition-all ${
                isQuintessence ? 'border-amber-500/10' : isOmega ? 'border-purple-500/10' : 'border-white/5'
              }`}>
                <pre 
                  className={`whitespace-pre-wrap hljs ${isQuintessence ? 'gold-leaf' : ''}`} 
                  dangerouslySetInnerHTML={{ __html: highlightedCode }}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-600 italic gap-4">
              <div className={`text-6xl opacity-10 animate-pulse ${isQuintessence ? 'text-amber-500' : ''}`}>⌘</div>
              <p className="text-xs uppercase tracking-[0.3em]">Select an artifact to analyze the causal chain.</p>
            </div>
          )}
        </div>
      </div>
      <style>{`
        .gold-leaf .hljs-attr, .gold-leaf .hljs-keyword { color: #f59e0b !important; }
        .gold-leaf .hljs-string { color: #fbbf24 !important; }
        .gold-leaf .hljs-tag { color: #d97706 !important; }
      `}</style>
    </div>
  );
};

export default Forge;
