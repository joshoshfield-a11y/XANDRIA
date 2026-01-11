
import React, { useState, useEffect } from 'react';
import { Manifestation } from '../types';

interface BrowserProps {
  manifestation: Manifestation | null;
  manifestations: Manifestation[];
  onSelect: (m: Manifestation) => void;
  // Added isOmega to Props to fix type mismatch in App.tsx
  isOmega: boolean;
  // Added isQuintessence to fix Type mismatch in App.tsx
  isQuintessence: boolean;
}

const Browser: React.FC<BrowserProps> = ({ manifestation, manifestations, onSelect, isOmega, isQuintessence }) => {
  const [urlInput, setUrlInput] = useState(manifestation ? `aethegard://manifestation/${manifestation.id}` : 'aethegard://empty-void');
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Sync address bar when a manifestation is selected externally
  useEffect(() => {
    if (manifestation) {
      setExternalUrl(null);
      setUrlInput(`aethegard://manifestation/${manifestation.id}`);
    }
  }, [manifestation]);

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUrl = urlInput.trim();
    
    // Check for "Loophole" - real internet access
    if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
      setExternalUrl(trimmedUrl);
      return;
    }

    // Standard internal navigation
    const match = trimmedUrl.match(/manifestation\/([a-z0-9]+)/i) || trimmedUrl.match(/id=([a-z0-9]+)/i);
    if (match) {
      const found = manifestations.find(m => m.id === match[1]);
      if (found) {
        setExternalUrl(null);
        onSelect(found);
      }
    }
  };

  return (
    <div className={`flex-1 flex flex-col transition-colors duration-1000 ${isQuintessence ? 'bg-[#030008]' : isOmega ? 'bg-[#05000a]' : 'bg-[#f8fafc]'}`}>
      {/* Browser Chrome UI */}
      <div className={`h-12 border-b flex items-center px-4 gap-4 z-20 transition-colors duration-1000 ${
        isQuintessence ? 'bg-amber-900/10 border-amber-500/20' : 
        isOmega ? 'bg-purple-900/20 border-purple-500/20' : 
        'bg-slate-200 border-slate-300'
      }`}>
        <div className="flex gap-1.5 mr-2">
          <div className={`w-3 h-3 rounded-full shadow-inner ${isQuintessence ? 'bg-amber-600' : isOmega ? 'bg-purple-600' : 'bg-red-400'}`}></div>
          <div className={`w-3 h-3 rounded-full shadow-inner ${isQuintessence ? 'bg-amber-500' : isOmega ? 'bg-purple-500' : 'bg-yellow-400'}`}></div>
          <div className={`w-3 h-3 rounded-full shadow-inner ${isQuintessence ? 'bg-amber-400' : isOmega ? 'bg-purple-400' : 'bg-green-400'}`}></div>
        </div>
        
        <div className="flex gap-1">
          <button className={`p-1.5 rounded transition-colors ${
            isQuintessence ? 'hover:bg-amber-500/20 text-amber-400' :
            isOmega ? 'hover:bg-purple-500/20 text-purple-400' : 
            'hover:bg-slate-300 text-slate-600'
          }`} onClick={() => { setExternalUrl(null); onSelect(manifestations[0]); }}>
            <span className="text-lg">←</span>
          </button>
          <button className="p-1.5 rounded transition-colors text-slate-600 disabled:opacity-30" disabled>
            <span className="text-lg">→</span>
          </button>
          <button className={`p-1.5 rounded transition-colors ${
            isQuintessence ? 'hover:bg-amber-500/20 text-amber-400' :
            isOmega ? 'hover:bg-purple-500/20 text-purple-400' : 
            'hover:bg-slate-300 text-slate-600'
          }`} onClick={() => {
            const current = urlInput;
            setUrlInput('');
            setTimeout(() => setUrlInput(current), 10);
          }}>
            <span className="text-base">↻</span>
          </button>
        </div>

        <form onSubmit={handleUrlSubmit} className="flex-1 relative">
          <input 
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Enter aethegard:// or https://"
            className={`w-full rounded-md border px-10 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 transition-all ${
              isQuintessence
                ? 'bg-black/40 border-amber-500/30 text-amber-300 focus:ring-amber-500/20'
                : isOmega 
                ? 'bg-black/40 border-purple-500/30 text-purple-300 focus:ring-purple-500/20' 
                : 'bg-white border-slate-300 text-slate-600 focus:ring-blue-500/20'
            }`}
          />
          <div className={`absolute left-3 top-1/2 -translate-y-1/2 ${isQuintessence ? 'text-amber-500' : isOmega ? 'text-purple-500' : 'text-slate-400'}`}>
            {externalUrl ? '🌐' : '🔒'}
          </div>
          <button 
            type="button"
            onClick={() => setShowHistory(!showHistory)}
            className={`absolute right-3 top-1/2 -translate-y-1/2 hover:scale-110 transition-transform ${isQuintessence ? 'text-amber-400' : isOmega ? 'text-purple-400' : 'text-slate-400'}`}
          >
            ▼
          </button>

          {/* Manifestation Dropdown */}
          {showHistory && (
            <div className={`absolute top-full left-0 right-0 mt-1 border shadow-xl rounded-md overflow-hidden max-h-60 overflow-y-auto z-50 transition-all ${
              isQuintessence ? 'bg-black border-amber-500/30' :
              isOmega ? 'bg-black border-purple-500/30' : 'bg-white border-slate-300'
            }`}>
              <div className={`p-2 text-[9px] uppercase font-bold tracking-widest ${
                isQuintessence ? 'bg-amber-900/20 text-amber-400' :
                isOmega ? 'bg-purple-900/20 text-purple-400' : 'bg-slate-100 text-slate-400'
              }`}>Local Manifestations</div>
              {manifestations.length === 0 ? (
                <div className="p-4 text-xs text-slate-400 text-center uppercase tracking-widest italic">Vault Empty</div>
              ) : (
                manifestations.map(m => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setExternalUrl(null);
                      onSelect(m);
                      setShowHistory(false);
                    }}
                    className={`w-full text-left px-4 py-3 border-b last:border-0 transition-colors flex items-center gap-3 ${
                      isQuintessence
                        ? 'hover:bg-amber-900/20 border-amber-500/10'
                        : isOmega 
                        ? 'hover:bg-purple-900/20 border-purple-500/10' 
                        : 'hover:bg-slate-50 border-slate-100'
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full ${isQuintessence ? 'bg-amber-500 shadow-[0_0_5px_amber]' : isOmega ? 'bg-purple-500 shadow-[0_0_5px_purple]' : 'bg-blue-400'}`}></div>
                    <div>
                      <div className={`text-xs font-bold truncate ${isQuintessence ? 'text-amber-200' : isOmega ? 'text-purple-200' : 'text-slate-700'}`}>{m.title}</div>
                      <div className={`text-[10px] font-mono ${isQuintessence ? 'text-amber-500' : isOmega ? 'text-purple-500' : 'text-slate-400'}`}>aethegard://manifestation/{m.id}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </form>

        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-full border flex items-center justify-center text-[10px] font-bold transition-all ${
            isQuintessence ? 'bg-amber-900/40 border-amber-500/40 text-amber-400' :
            isOmega ? 'bg-purple-900/40 border-purple-500/40 text-purple-400' : 'bg-slate-300 border-slate-400 text-slate-600'
          }`}>
            {externalUrl ? 'WEB' : 'BOT'}
          </div>
        </div>
      </div>

      {/* Sandbox Iframe */}
      <div className={`flex-1 relative overflow-hidden shadow-inner ${isQuintessence ? 'bg-[#030008]' : isOmega ? 'bg-[#0a0015]' : 'bg-white'}`}>
        {externalUrl ? (
          <iframe
            src={externalUrl}
            title="External Intelligence Loophole"
            className="w-full h-full border-none"
            sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          />
        ) : manifestation ? (
          <iframe
            key={manifestation.id}
            srcDoc={manifestation.code}
            title="Aethegard Sandbox"
            className="w-full h-full border-none"
            sandbox="allow-scripts allow-modals allow-popups allow-forms allow-same-origin"
          />
        ) : (
          <div className={`w-full h-full flex flex-col items-center justify-center font-light italic transition-colors ${
            isQuintessence ? 'bg-[#030008] text-amber-900' :
            isOmega ? 'bg-[#0a0015] text-purple-900' : 
            'bg-[#eef2f6] text-slate-400'
          }`}>
            <div className="relative mb-8">
              <div className={`w-32 h-32 border-2 rounded-full animate-spin-slow ${isQuintessence ? 'border-amber-500/20' : isOmega ? 'border-purple-500/20' : 'border-slate-300'}`}></div>
              <div className="absolute inset-0 flex items-center justify-center text-4xl opacity-20">
                ⦿
              </div>
            </div>
            <p className={`text-sm font-bold tracking-widest uppercase opacity-40 ${isQuintessence ? 'text-amber-500' : isOmega ? 'text-purple-500' : ''}`}>Explorer Substrate Offline</p>
            <p className="text-xs opacity-30 mt-2">Initialize a manifestation or enter a web URL.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Browser;
