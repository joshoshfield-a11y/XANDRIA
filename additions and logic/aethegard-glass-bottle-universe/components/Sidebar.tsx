
import React from 'react';
import { TabType } from '../types';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  isOmega: boolean;
  isQuintessence: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ activeTab, setActiveTab, isOmega, isQuintessence }) => {
  const isSovereign = isQuintessence && isOmega;
  
  const tabs: { id: TabType; icon: string; label: string }[] = [
    { id: 'universe', icon: isSovereign ? 'V' : isQuintessence ? '⌘' : isOmega ? 'Ω' : '✦', label: 'Core' },
    { id: 'ai', icon: '◈', label: 'Architect' },
    { id: 'terminal', icon: '⌨', label: 'Terminal' },
    { id: 'forge', icon: '⚙', label: 'Forge' },
    { id: 'browser', icon: '⦿', label: 'Explorer' },
    { id: 'substrate', icon: '≋', label: 'Substrate' },
  ];

  return (
    <aside className={`w-16 glass flex flex-col items-center py-8 gap-8 border-r transition-all duration-1000 z-50 ${
      isSovereign ? 'border-amber-400/30 shadow-[0_0_30px_rgba(251,191,36,0.1)]' :
      isQuintessence ? 'border-amber-500/20' : 
      isOmega ? 'border-purple-500/20' : 
      'border-white/5'
    }`}>
      <div className={`w-10 h-10 rounded-full border flex items-center justify-center font-bold mb-4 transition-all duration-1000 ${
        isSovereign ? 'bg-amber-400/20 border-amber-300/50 text-amber-300 shadow-[0_0_30px_rgba(251,191,36,0.6)] animate-pulse' :
        isQuintessence ? 'bg-amber-500/20 border-amber-400/40 text-amber-400 shadow-[0_0_25px_rgba(245,158,11,0.5)]' :
        isOmega ? 'bg-purple-500/20 border-purple-400/30 text-purple-400 shadow-[0_0_20px_rgba(168,85,247,0.4)]' : 
        'bg-cyan-500/20 border-cyan-400/30 text-cyan-400 shadow-[0_0_15px_rgba(0,243,255,0.3)]'
      }`}>
        {isSovereign ? 'V' : isQuintessence ? 'Q' : isOmega ? 'Ω' : 'A'}
      </div>
      
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`group relative flex items-center justify-center w-12 h-12 rounded-xl transition-all duration-300 ${
            activeTab === tab.id 
              ? (isSovereign ? 'bg-amber-400/10 text-amber-300 border border-amber-300/60 shadow-[0_0_20px_rgba(251,191,36,0.2)]' :
                 isQuintessence ? 'bg-amber-500/10 text-amber-400 border border-amber-400/50 shadow-[inset_0_0_10px_rgba(245,158,11,0.1)]' :
                 isOmega ? 'bg-purple-500/10 text-purple-400 border border-purple-400/40' : 
                 'bg-white/10 text-cyan-400 border border-white/20')
              : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
          }`}
          title={tab.label}
        >
          <span className="text-xl">{tab.icon}</span>
          <div className={`absolute left-14 scale-0 group-hover:scale-100 transition-transform origin-left bg-black/90 text-white text-[10px] py-1.5 px-3 rounded border uppercase tracking-widest pointer-events-none z-[60] shadow-2xl backdrop-blur-xl ${
            isSovereign ? 'border-amber-400/40 text-amber-300' : 'border-white/10'
          }`}>
            {tab.label}
          </div>
        </button>
      ))}

      <div className={`mt-auto transition-opacity duration-1000 ${
        isSovereign ? 'opacity-90 text-amber-300 font-bold text-[10px] animate-pulse drop-shadow-[0_0_5px_amber]' :
        isQuintessence ? 'opacity-60 text-amber-500 font-bold text-[10px] animate-pulse' :
        isOmega ? 'opacity-40 text-purple-500 font-bold text-[10px]' : 
        'opacity-20 hover:opacity-100'
      }`}>
        {isSovereign ? 'SOV_V5' : isQuintessence ? 'QU_SYNC' : isOmega ? 'Ω_LK' : <button className="text-slate-500 text-xs">?</button>}
      </div>
    </aside>
  );
};

export default Sidebar;
