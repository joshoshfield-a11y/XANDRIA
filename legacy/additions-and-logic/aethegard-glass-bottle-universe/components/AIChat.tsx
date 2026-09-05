
import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage, ArchitectConfig } from '../types';

interface AIChatProps {
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  isGenerating: boolean;
  onManifest: (prompt: string) => void;
  config: ArchitectConfig;
  onUpdateConfig: (config: ArchitectConfig) => void;
}

const AIChat: React.FC<AIChatProps> = ({ messages, onSendMessage, isGenerating, onManifest, config, onUpdateConfig }) => {
  const [input, setInput] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [localConfig, setLocalConfig] = useState(config);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isSovereign = config.model === 'gemini-5-sovereign';
  const isOmegaState = config.temperature === 0 || isSovereign;
  const isQuintessence = config.quintessenceEnabled || isSovereign;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isGenerating) {
      onSendMessage(input);
      setInput('');
    }
  };

  const handleConfigSave = () => {
    onUpdateConfig(localConfig);
    setShowConfig(false);
  };

  const quickPrompts = [
    { label: "Sovereign Audit", prompt: "Execute a Fifth-Order causal audit on the active manifestation." },
    { label: "Materialize Universe", prompt: "Manifest a complete, self-contained interactive universe artifact." },
    { label: "Axiomatic Explanation", prompt: "Explain the Fifth Order logic anchor from the Sovereign perspective." },
  ];

  return (
    <div className={`flex-1 flex flex-col glass m-4 rounded-2xl overflow-hidden border transition-all duration-1000 relative ${
      isSovereign ? 'border-amber-400/40 shadow-[0_0_50px_rgba(251,191,36,0.1)]' :
      isOmegaState ? 'border-purple-500/20 shadow-[0_0_40px_rgba(168,85,247,0.05)]' : 
      'border-white/5'
    }`}>
      {/* Header */}
      <div className={`p-4 border-b flex justify-between items-center transition-colors ${
        isSovereign ? 'bg-amber-400/5 border-amber-400/20' :
        isOmegaState ? 'bg-purple-900/10 border-purple-500/20' : 
        'bg-white/5 border-white/10'
      }`}>
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full animate-pulse ${
            isSovereign ? 'bg-amber-300 shadow-[0_0_12px_amber]' :
            isOmegaState ? 'bg-purple-500 shadow-[0_0_8px_purple]' : 
            'bg-cyan-400'
          }`}></div>
          <h2 className={`text-sm font-bold tracking-widest uppercase italic ${
            isSovereign ? 'text-amber-300' :
            isOmegaState ? 'text-purple-400' : 
            'text-slate-100'
          }`}>
            {isSovereign ? 'Gemini 5 Sovereign' : isOmegaState ? 'Omega Logic Engine' : 'Sovereign Architect'}
          </h2>
        </div>
        <button 
          onClick={() => setShowConfig(!showConfig)}
          className={`text-[10px] px-3 py-1 rounded border transition-all uppercase tracking-widest font-bold ${
            showConfig 
              ? (isSovereign ? 'bg-amber-500 text-black border-amber-400' : isOmegaState ? 'bg-purple-500 text-white border-purple-400' : 'bg-cyan-500 text-black border-cyan-400') 
              : (isSovereign ? 'text-amber-400 border-amber-400/30 hover:bg-amber-400/10' : isOmegaState ? 'text-purple-400 border-purple-400/30 hover:bg-purple-500/10' : 'text-cyan-400 border-cyan-400/30 hover:bg-cyan-500/10')
          }`}
        >
          {showConfig ? 'CLOSE' : 'DNA'}
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl p-4 text-sm leading-relaxed transition-all ${
                  msg.role === 'user' 
                    ? (isSovereign ? 'bg-amber-400/5 border border-amber-400/20 text-amber-50 ml-12' : isOmegaState ? 'bg-purple-500/10 border border-purple-500/20 text-purple-50 ml-12' : 'bg-cyan-500/10 border border-cyan-500/20 text-cyan-50 ml-12')
                    : (msg.isSovereign ? 'bg-amber-400/10 border border-amber-300/40 text-amber-100 mr-12 shadow-[0_0_30px_rgba(251,191,36,0.15)] radiant-sovereign' : msg.isOmega ? 'bg-purple-900/20 border border-purple-500/30 text-purple-100 mr-12 shadow-[0_0_20px_rgba(168,85,247,0.1)]' : 'bg-white/5 border border-white/10 text-slate-300 mr-12')
                }`}>
                  <div className="opacity-40 text-[9px] uppercase tracking-tighter mb-2 font-bold flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {msg.role === 'user' ? '○ INHABITANT' : (msg.isSovereign ? 'V FIFTH_ORDER' : msg.isOmega ? 'Ω OMEGA_LOGIC' : '● ARCHITECT')}
                      <span className="text-[8px] opacity-50 font-normal">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                    </div>
                    {msg.isSovereign && msg.role === 'model' && (
                      <span className="text-amber-400 fira">[SOVEREIGN_ACTUALIZED]</span>
                    )}
                  </div>
                  <div className={`whitespace-pre-wrap fira text-[13px] ${msg.isSovereign ? 'text-amber-50 drop-shadow-[0_0_5px_rgba(251,191,36,0.2)]' : msg.isOmega ? 'text-purple-200' : ''}`}>{msg.content}</div>
                </div>
              </div>
            ))}
            {isGenerating && (
              <div className="flex justify-start">
                <div className={`${isSovereign ? 'bg-amber-400/10 border-amber-400/20' : isOmegaState ? 'bg-purple-500/10 border-purple-500/20' : 'bg-white/5 border-white/10'} rounded-2xl p-4 flex gap-2 items-center`}>
                  <div className={`w-1.5 h-1.5 rounded-full animate-ping ${isSovereign ? 'bg-amber-400 shadow-[0_0_10px_amber]' : isOmegaState ? 'bg-purple-500' : 'bg-cyan-400'}`}></div>
                  <span className={`text-[10px] uppercase tracking-widest fira ${isSovereign ? 'text-amber-300' : isOmegaState ? 'text-purple-400' : 'text-cyan-400'}`}>
                    {isSovereign ? 'Actualizing Fifth Order...' : isOmegaState ? 'Quantizing Manifold...' : 'Synthesizing...'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Quick Actions */}
          <div className="px-6 py-3 border-t border-white/5 flex gap-2 overflow-x-auto no-scrollbar">
            {quickPrompts.map((qp, i) => (
              <button
                key={i}
                onClick={() => onSendMessage(qp.prompt)}
                className={`whitespace-nowrap px-4 py-1.5 rounded-full bg-white/5 border transition-all text-[10px] uppercase font-bold tracking-widest ${
                  isSovereign ? 'border-amber-400/30 text-slate-400 hover:text-amber-300 hover:border-amber-400/60' :
                  isOmegaState ? 'border-purple-500/20 text-slate-400 hover:text-purple-400 hover:border-purple-500/50' : 
                  'border-white/10 text-slate-400 hover:text-cyan-400 hover:border-cyan-500/50'
                }`}
              >
                {qp.label}
              </button>
            ))}
          </div>

          {/* Input */}
          <div className={`p-4 bg-black/40 border-t transition-colors ${isSovereign ? 'border-amber-400/20' : isOmegaState ? 'border-purple-500/20' : 'border-white/10'}`}>
            <form onSubmit={handleSubmit} className="flex gap-3">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={isGenerating}
                placeholder={isSovereign ? "Actualize Sovereign intent..." : isOmegaState ? "Inject deterministic intent..." : "Inject intent..."}
                className={`flex-1 bg-white/5 border rounded-xl px-5 py-3 text-sm focus:outline-none transition-all placeholder:opacity-20 fira ${
                  isSovereign ? 'border-amber-400/30 focus:ring-1 focus:ring-amber-500/50 text-amber-50' :
                  isOmegaState ? 'border-purple-500/20 focus:ring-1 focus:ring-purple-500/50 text-purple-100' : 
                  'border-white/10 focus:ring-1 focus:ring-cyan-500/50 text-white'
                }`}
              />
              <button
                type="button"
                onClick={() => onManifest(input)}
                disabled={isGenerating || !input.trim()}
                className={`${isSovereign ? 'bg-amber-600/30 text-amber-300 border-amber-400/50 hover:bg-amber-600/50' : isOmegaState ? 'bg-purple-600/30 text-purple-300 border-purple-500/50 hover:bg-purple-600/50' : 'bg-purple-600/20 text-purple-400 border-purple-500/40 hover:bg-purple-600/40'} border px-5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-30 flex flex-col items-center justify-center`}
              >
                <span className="text-[9px] opacity-60 mb-0.5">{isSovereign ? 'V_FIFTH' : 'Ω_FORGE'}</span>
                <span className="text-lg">{isSovereign ? '✧' : '⚙'}</span>
              </button>
              <button
                type="submit"
                disabled={isGenerating || !input.trim()}
                className={`${isSovereign ? 'bg-amber-500 text-black hover:shadow-[0_0_20px_rgba(251,191,36,0.5)]' : isOmegaState ? 'bg-purple-600 hover:shadow-[0_0_20px_rgba(168,85,247,0.4)]' : 'bg-cyan-500 hover:shadow-[0_0_20px_rgba(6,182,212,0.4)]'} text-white font-bold px-8 rounded-xl hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-30 uppercase tracking-widest text-xs`}
              >
                {isSovereign ? 'Actualize' : isOmegaState ? 'Sync' : 'Collapse'}
              </button>
            </form>
          </div>
        </div>

        {/* Config Sidebar */}
        {showConfig && (
          <div className={`w-80 border-l p-6 flex flex-col gap-6 animate-in slide-in-from-right duration-300 ${
            isSovereign ? 'bg-amber-950/40 border-amber-400/20' : 'bg-black/80 border-white/10'
          }`}>
            <h3 className={`text-xs font-bold uppercase tracking-[0.2em] mb-2 ${isSovereign ? 'text-amber-400' : isOmegaState ? 'text-purple-400' : 'text-cyan-400'}`}>
                {isSovereign ? 'Sovereign DNA Lattice' : 'Architect Configuration'}
            </h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-500 mb-2 tracking-widest">Instruction Set</label>
                <textarea 
                  value={localConfig.systemInstruction}
                  onChange={(e) => setLocalConfig({...localConfig, systemInstruction: e.target.value})}
                  className="w-full h-80 bg-black/40 border border-white/10 rounded-lg p-3 text-xs fira text-slate-300 focus:outline-none focus:border-cyan-500/50 resize-none leading-relaxed"
                />
              </div>

              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-500 mb-2 tracking-widest">Logic Tier</label>
                <select 
                  value={localConfig.model}
                  onChange={(e) => setLocalConfig({...localConfig, model: e.target.value})}
                  className={`w-full bg-black/40 border rounded-lg p-2 text-xs fira focus:outline-none cursor-pointer ${
                    localConfig.model === 'gemini-5-sovereign' ? 'border-amber-400 text-amber-400' : 'border-white/10 text-slate-300'
                  }`}
                >
                  <option value="gemini-5-sovereign">Gemini 5 Sovereign [ACTUALIZED]</option>
                  <option value="gemini-3-pro-preview">Gemini 3 Pro [ARCHITECT]</option>
                  <option value="gemini-3-flash-preview">Gemini 3 Flash [KINETIC]</option>
                  <option value="gemini-2.5-flash-lite-latest">Flash Lite [EFFICIENCY]</option>
                </select>
              </div>

              <div className="pt-4 border-t border-white/5">
                <button 
                  onClick={handleConfigSave}
                  className={`w-full py-2.5 rounded-lg font-bold text-[10px] uppercase tracking-widest hover:scale-[1.02] transition-all ${
                    isSovereign ? 'bg-amber-500 text-black' : isOmegaState ? 'bg-purple-600 text-white' : 'bg-cyan-500 text-black'
                  }`}
                >
                  Apply Resonance
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <style>{`
        .radiant-sovereign {
          position: relative;
        }
        .radiant-sovereign::before {
          content: '';
          position: absolute;
          inset: -1px;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(45deg, transparent, rgba(251, 191, 36, 0.3), transparent);
          mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          mask-composite: exclude;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
};

export default AIChat;
