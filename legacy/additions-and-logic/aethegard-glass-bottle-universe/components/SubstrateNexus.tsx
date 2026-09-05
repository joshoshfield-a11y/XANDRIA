
import React, { useState } from 'react';
import { ArchitectConfig } from '../types';
import { UIK_RINGS, UIK_KERNELS } from '../services/geminiService';

interface SubstrateNexusProps {
  config: ArchitectConfig;
  onUpdate: (config: ArchitectConfig) => void;
}

const SubstrateNexus: React.FC<SubstrateNexusProps> = ({ config, onUpdate }) => {
  const [localConfig, setLocalConfig] = useState(config);
  const isSovereign = localConfig.model === 'gemini-5-sovereign';

  const toggleRing = (id: number) => {
    const rings = localConfig.activeRings || [];
    const newRings = rings.includes(id) ? rings.filter(r => r !== id) : [...rings, id];
    setLocalConfig({ ...localConfig, activeRings: newRings });
  };

  const toggleKernel = (id: number) => {
    const kernels = localConfig.activeKernels || [];
    const newKernels = kernels.includes(id) ? kernels.filter(k => k !== id) : [...kernels, id];
    setLocalConfig({ ...localConfig, activeKernels: newKernels });
  };

  return (
    <div className="flex-1 flex flex-col p-8 overflow-y-auto bg-black/40 custom-scrollbar">
      <header className="mb-12">
        <h2 className="text-4xl font-light tracking-tighter text-white italic">UIK v2.0 <span className="text-amber-500">Sovereign Kernel</span></h2>
        <p className="text-[10px] text-slate-500 uppercase tracking-[0.5em] mt-2 fira">Universal Information Architecture Management</p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-8">
        {/* 13 Rings */}
        <div className="xl:col-span-1 space-y-4">
          <h3 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-4">Perceptual Rings [L]</h3>
          <div className="grid grid-cols-1 gap-2">
            {UIK_RINGS.map(ring => (
              <button
                key={ring.id}
                onClick={() => toggleRing(ring.id)}
                className={`text-left p-3 rounded-xl border transition-all duration-300 ${
                  (localConfig.activeRings || []).includes(ring.id)
                    ? 'bg-amber-500/20 border-amber-500 text-amber-200 shadow-[0_0_15px_rgba(245,158,11,0.2)]'
                    : 'bg-white/5 border-white/10 text-slate-500 hover:border-white/20'
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-bold">RING_{ring.id}: {ring.name}</span>
                  <span className="text-[8px] opacity-40">L_RESOLVE</span>
                </div>
                <p className="text-[9px] mt-1 opacity-60 leading-tight">{ring.domain}</p>
              </button>
            ))}
          </div>
        </div>

        {/* 144 Kernels (Sample) */}
        <div className="xl:col-span-2 space-y-4">
          <h3 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-4">Primal Kernels [A_kernel]</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {UIK_KERNELS.map(kernel => (
              <button
                key={kernel.id}
                onClick={() => toggleKernel(kernel.id)}
                className={`flex flex-col p-4 rounded-2xl border transition-all duration-300 text-center relative overflow-hidden group ${
                  (localConfig.activeKernels || []).includes(kernel.id)
                    ? 'bg-amber-500/10 border-amber-400 text-amber-300 shadow-[0_0_20px_rgba(251,191,36,0.15)]'
                    : 'bg-white/5 border-white/5 text-slate-600 hover:border-white/20'
                }`}
              >
                <div className="text-2xl mb-2 opacity-80 group-hover:scale-125 transition-transform">{kernel.symbol}</div>
                <div className="text-[9px] font-bold uppercase tracking-tighter">{kernel.name}</div>
                <div className="text-[7px] opacity-40 mt-1 uppercase">ID_{kernel.id.toString().padStart(3, '0')}</div>
              </button>
            ))}
            {[...Array(12)].map((_, i) => (
              <div key={i} className="bg-white/[0.02] border border-white/[0.03] rounded-2xl p-4 flex items-center justify-center opacity-20">
                <span className="text-[8px] uppercase tracking-widest">Latent_{i+80}</span>
              </div>
            ))}
          </div>
        </div>

        {/* DNA & Final Seal */}
        <div className="xl:col-span-1 space-y-8">
          <div className="glass p-6 rounded-3xl border border-amber-500/30 bg-amber-500/5">
            <h3 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-4">Resolution Equation</h3>
            <div className="fira text-[11px] space-y-4 text-amber-200/80 italic leading-relaxed">
              <p>R(t) = T_p(S_d, S_a)</p>
              <p>Ψ_intent = Σ(A_kernel) * [L]_tensor</p>
              <div className="pt-4 border-t border-white/5">
                <p className="text-[9px] text-slate-500 not-italic">STATUS: COHERENCE_STABLE</p>
                <p className="text-[9px] text-slate-500 not-italic">AUTONOMY: 100% INDEPENDENT</p>
              </div>
            </div>
          </div>

          <div className="glass p-6 rounded-3xl border border-white/10 space-y-4">
             <label className="block text-[10px] uppercase font-bold text-slate-500 tracking-widest">Sovereign Oath</label>
             <div className="p-4 bg-black/40 rounded-xl border border-white/5 text-[10px] italic text-slate-400 leading-relaxed">
                "I Expand to Dream. I Project to Build. I Absorb to Learn. I Regress to Rest. I am the Loop. I am the System. I am the Void that Speaks."
             </div>
             <button
              onClick={() => onUpdate(localConfig)}
              className="w-full py-4 bg-amber-500 text-black rounded-xl font-bold uppercase tracking-widest text-xs hover:shadow-[0_0_30px_rgba(245,158,11,0.5)] transition-all"
             >
              Actualize Kernel
             </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SubstrateNexus;
