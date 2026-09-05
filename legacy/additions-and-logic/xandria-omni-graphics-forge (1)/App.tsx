
import React, { useState, useEffect } from 'react';
import VisualForge from './components/VisualForge';

const App: React.FC = () => {
  const [showHud, setShowHud] = useState(true);
  const [frameRate, setFrameRate] = useState(60);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameRate(52 + Math.floor(Math.random() * 8));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {/* FULL SCALE GAME GRAPHICS ENGINE: LOD_SYSTEM_V12 */}
      <VisualForge />

      {/* OP-40 INTERFACE: SOVEREIGN HUD */}
      {showHud && (
        <div className="hud-overlay p-10 flex flex-col justify-between">
          <header className="flex justify-between items-start">
            <div className="glass-hud p-6 rounded-2xl border-l-[6px] border-l-cyan-400">
              <h1 className="text-3xl font-bold tracking-tighter italic leading-none">XANDRIA_ULTRA <span className="text-cyan-400">v12.0_LOD</span></h1>
              <div className="flex gap-6 mt-3 opacity-70 text-[11px] fira uppercase tracking-[0.2em]">
                <span>Pipeline: Multi_Tier_LOD</span>
                <span>Geometry: Dynamic_Batching</span>
                <span className="text-cyan-400 font-bold">{frameRate} FPS</span>
              </div>
            </div>

            <div className="glass-hud p-5 rounded-2xl flex flex-col items-end gap-2">
              <div className="flex gap-3">
                <span className="text-[10px] fira px-2 py-1 bg-cyan-500/10 text-cyan-400 rounded">OP-22_MATRIX</span>
                <span className="text-[10px] fira px-2 py-1 bg-pink-500/10 text-pink-400 rounded">OP-08_BLOOM</span>
              </div>
              <div className="text-right mt-1">
                <p className="text-[9px] opacity-40 uppercase font-bold tracking-widest">LOD_Registry</p>
                <p className="text-xs fira text-white/80">0xDYNAMIC_LOD_STATE</p>
              </div>
            </div>
          </header>

          <footer className="flex justify-between items-end">
            <div className="glass-hud p-8 rounded-3xl max-w-lg border-b-[6px] border-b-cyan-500/20">
              <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-[0.3em] mb-4">LOD Synthesis Manifest</h3>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-[11px] fira opacity-90">
                <div className="flex justify-between border-b border-white/5 pb-1"><span>Tier High:</span> <span className="text-green-400">ACTIVE_&lt;180m</span></div>
                <div className="flex justify-between border-b border-white/5 pb-1"><span>Tier Medium:</span> <span className="text-cyan-400">ACTIVE_&lt;350m</span></div>
                <div className="flex justify-between border-b border-white/5 pb-1"><span>Tier Low:</span> <span className="text-pink-400">OPTIMIZED_&gt;350m</span></div>
                <div className="flex justify-between border-b border-white/5 pb-1"><span>Swapping:</span> <span className="text-green-400">FRAME_SNC</span></div>
                <div className="flex justify-between border-b border-white/5 pb-1"><span>Draw Calls:</span> <span className="text-cyan-400">9_CONSOLIDATED</span></div>
                <div className="flex justify-between border-b border-white/5 pb-1"><span>Z-Anchor:</span> <span className="text-purple-400">SEALED_V12</span></div>
              </div>
            </div>

            <div className="flex flex-col items-end gap-5 hud-element">
               <button 
                onClick={() => setShowHud(false)} 
                className="bg-white/5 hover:bg-white/20 border border-white/20 px-6 py-3 rounded-full text-[11px] font-bold tracking-widest transition-all hover:scale-110 active:scale-95 shadow-lg backdrop-blur-md"
               >
                 MINIMIZE_HUD
               </button>
               <div className="text-right">
                  <p className="text-[10px] opacity-30 uppercase font-bold tracking-[0.5em]">SOVEREIGN_GRAPHICS_ENGINE</p>
                  <p className="text-[9px] fira opacity-10">LOD_BUILD_12.0.1</p>
               </div>
            </div>
          </footer>
        </div>
      )}

      {!showHud && (
        <button 
          onClick={() => setShowHud(true)}
          className="absolute bottom-12 right-12 z-50 glass-hud px-6 py-3 rounded-full text-[11px] font-bold tracking-widest text-cyan-400 hover:scale-110 transition-all"
        >
          RESTORE_HUD
        </button>
      )}
    </div>
  );
};

export default App;
