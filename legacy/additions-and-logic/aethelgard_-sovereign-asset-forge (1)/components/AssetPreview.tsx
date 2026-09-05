
import React, { useState } from 'react';
import { AssetManifest, PBRMaterial, AssetType } from '../types';
import { Edit3, Sparkles, RefreshCcw, Download, Settings, Wand2 } from 'lucide-react';

interface Props {
  manifest: AssetManifest;
  activeTab: string;
  onEditVisual?: (prompt: string) => Promise<void>;
  onRefineMaterial?: (index: number, prompt: string) => Promise<void>;
  isEditing?: boolean;
}

const MaterialCard: React.FC<{ mat: PBRMaterial; index: number; onRefine: (p: string) => void; isEditing: boolean }> = ({ mat, index, onRefine, isEditing }) => {
  const [refineInput, setRefineInput] = useState('');
  const [showRefine, setShowRefine] = useState(false);

  return (
    <div className="bg-white/5 border border-white/10 p-4 rounded-xl flex flex-col gap-3 group">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold opacity-40 uppercase tracking-widest">Node_{index + 1}</span>
        <div className="flex items-center gap-2">
           <button 
             onClick={() => setShowRefine(!showRefine)}
             className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-all text-cyan-400"
           >
             <Settings className="w-3 h-3" />
           </button>
           <div className="w-4 h-4 rounded-full shadow-[0_0_8px_rgba(255,255,255,0.2)] border border-white/20" style={{ backgroundColor: mat.albedo.startsWith('#') ? mat.albedo : '#888' }}></div>
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] fira">
        <div>Rough: <span className="text-cyan-400">{(mat.roughness * 100).toFixed(0)}%</span></div>
        <div>Metal: <span className="text-cyan-400">{(mat.metallic * 100).toFixed(0)}%</span></div>
        <div>Normal: <span className="text-cyan-400">{mat.normalIntensity.toFixed(1)}</span></div>
        <div className="truncate">Albedo: <span className="text-cyan-400">{mat.albedo}</span></div>
      </div>

      {showRefine && (
        <div className="mt-2 flex gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
          <input 
            autoFocus
            type="text"
            value={refineInput}
            onChange={(e) => setRefineInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (onRefine(refineInput), setRefineInput(''), setShowRefine(false))}
            placeholder="e.g. Make more metallic"
            className="flex-1 bg-black/60 border border-white/10 rounded-lg px-3 py-1 text-[10px] outline-none focus:border-cyan-500/50 fira"
          />
          <button 
            disabled={isEditing || !refineInput}
            onClick={() => { onRefine(refineInput); setRefineInput(''); setShowRefine(false); }}
            className="p-1.5 bg-cyan-500 text-black rounded-lg hover:bg-cyan-400 transition-colors"
          >
            <Wand2 className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
};

export const AssetPreview: React.FC<Props> = ({ manifest, activeTab, onEditVisual, onRefineMaterial, isEditing = false }) => {
  const [editPrompt, setEditPrompt] = useState('');

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editPrompt.trim() && onEditVisual) {
      await onEditVisual(editPrompt);
      setEditPrompt('');
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {activeTab === 'specs' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 animate-in fade-in zoom-in-95 duration-300">
          <div className="glass p-6 rounded-2xl flex flex-col gap-4">
            <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-tighter flex items-center gap-2">
              <Sparkles className="w-3 h-3" /> Geometric Substrate
            </h3>
            <div className="space-y-4">
              {[
                { label: 'Estimated Complexity', value: manifest.technicalSpecs.estimatedVerts },
                { label: 'Topology Paradigm', value: manifest.technicalSpecs.topology, color: 'text-cyan-300' },
                { label: 'LOD Strategy', value: `${manifest.technicalSpecs.lodLevels} Layers` },
                { label: 'UV Projection', value: manifest.technicalSpecs.uvUnwrappingStyle },
              ].map((item, i) => (
                <div key={i} className="flex justify-between items-end border-b border-white/5 pb-2">
                  <span className="text-xs opacity-50">{item.label}</span>
                  <span className={`fira text-sm font-bold ${item.color || 'text-white'}`}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="glass p-6 rounded-2xl flex flex-col gap-2">
            <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-tighter">Asset Narrative</h3>
            <p className="text-sm leading-relaxed opacity-70 italic">"{manifest.description}"</p>
            <div className="mt-4 pt-4 border-t border-white/5 flex flex-wrap gap-2">
              <span className="px-2 py-1 bg-cyan-500/10 border border-cyan-500/20 rounded text-[10px] uppercase font-bold text-cyan-400">{manifest.type}</span>
              <span className="px-2 py-1 bg-white/5 border border-white/10 rounded text-[10px] uppercase font-bold">{manifest.style}</span>
              {manifest.type === AssetType.ENVIRONMENT && (
                <span className="px-2 py-1 bg-green-500/10 border border-green-500/20 rounded text-[10px] uppercase font-bold text-green-400">Large Scale</span>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'pbr' && (
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto animate-in fade-in slide-in-from-right-4 duration-300 custom-scrollbar">
          {manifest.pbrNodes.map((mat, idx) => (
            <MaterialCard 
              key={idx} 
              mat={mat} 
              index={idx} 
              isEditing={isEditing}
              onRefine={(p) => onRefineMaterial?.(idx, p)} 
            />
          ))}
        </div>
      )}

      {activeTab === 'prompts' && (
        <div className="p-4 space-y-4 overflow-y-auto animate-in fade-in slide-in-from-bottom-4 duration-300 custom-scrollbar">
          {[
            { label: 'Latent Diffusion Prompt', value: manifest.generationPrompts.diffusion, color: 'text-white' },
            { label: 'Geometric Seed Prompt', value: manifest.generationPrompts.geometry, color: 'text-cyan-400/80' },
            { label: 'Texture Synthesis Seed', value: manifest.generationPrompts.texture, color: 'text-pink-400/80' },
          ].map((prompt, i) => (
            <div key={i} className="glass p-6 rounded-2xl">
              <h4 className="text-[10px] font-bold opacity-40 uppercase mb-2">{prompt.label}</h4>
              <div className={`bg-black/40 p-4 rounded-xl fira text-xs ${prompt.color} leading-relaxed border border-white/5 select-all cursor-copy hover:bg-black/60 transition-colors`}>
                {prompt.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'code' && (
        <div className="p-4 flex-1 flex flex-col animate-in fade-in slide-in-from-left-4 duration-300">
          <div className="glass flex-1 p-6 rounded-2xl flex flex-col gap-4">
             <div className="flex justify-between items-center">
                <h4 className="text-[10px] font-bold opacity-40 uppercase">R3F Integration Kernel</h4>
                <button 
                  onClick={() => navigator.clipboard.writeText(manifest.r3fSnippet)}
                  className="text-[10px] bg-cyan-500/10 border border-cyan-500/30 px-3 py-1 rounded hover:bg-cyan-500/20 transition-all uppercase font-bold"
                >
                  Copy Code
                </button>
             </div>
             <div className="flex-1 bg-black/60 rounded-xl border border-white/10 overflow-hidden relative group">
                <pre className="p-6 h-full overflow-auto fira text-[11px] leading-relaxed text-cyan-50/80 custom-scrollbar">
                  {manifest.r3fSnippet}
                </pre>
             </div>
          </div>
        </div>
      )}

      {activeTab === 'visual' && (
        <div className="p-4 flex-1 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-300 overflow-hidden">
          <div className="flex-1 glass rounded-2xl overflow-hidden relative group bg-[#05050a]">
            {manifest.visualUrl ? (
              <>
                <img 
                  src={manifest.visualUrl} 
                  alt="Asset Visual Concept" 
                  className={`w-full h-full object-contain transition-all duration-700 ${isEditing ? 'opacity-30 blur-sm scale-110' : 'opacity-100 scale-100'}`} 
                />
                {isEditing && (
                   <div className="absolute inset-0 flex items-center justify-center">
                     <div className="flex flex-col items-center gap-3">
                        <div className="relative">
                          <RefreshCcw className="w-12 h-12 text-cyan-400 animate-spin" />
                          <Sparkles className="absolute -top-1 -right-1 w-4 h-4 text-pink-500 animate-pulse" />
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400 drop-shadow-[0_0_8px_rgba(6,182,212,0.8)]">Mutating Latent Substrate</span>
                     </div>
                   </div>
                )}
                <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a 
                    href={manifest.visualUrl} 
                    download={`${manifest.name}_Render.png`}
                    className="p-2 bg-black/60 hover:bg-black/80 rounded-lg border border-white/10 text-white transition-all backdrop-blur-md"
                    title="Download Render"
                  >
                    <Download className="w-4 h-4" />
                  </a>
                </div>
              </>
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-4 opacity-10">
                <Sparkles className="w-16 h-16 animate-pulse" />
                <p className="text-[10px] font-bold uppercase tracking-[0.3em]">Void Detection: No Visual Seed</p>
              </div>
            )}
          </div>

          <div className="glass p-6 rounded-2xl flex flex-col gap-4">
             <div className="flex items-center justify-between">
                <h4 className="text-[10px] font-bold opacity-40 uppercase flex items-center gap-2">
                  <Edit3 className="w-3 h-3" /> Texture & Material Evolution
                </h4>
                <div className="flex items-center gap-2">
                   <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></div>
                   <span className="text-[8px] fira opacity-20 uppercase tracking-tighter">Latent_Mesh_Mutator_Active</span>
                </div>
             </div>
             <form onSubmit={handleEditSubmit} className="flex gap-2">
                <input 
                  type="text" 
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  placeholder="e.g. 'Apply radioactive weathering to textures' or 'Convert to voxel-style structure'"
                  className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs focus:border-cyan-500/40 outline-none fira transition-all"
                  disabled={isEditing || !manifest.visualUrl}
                />
                <button 
                  type="submit"
                  disabled={isEditing || !editPrompt.trim() || !manifest.visualUrl}
                  className="bg-cyan-500 text-black font-bold px-8 rounded-xl text-[10px] uppercase tracking-widest hover:scale-105 active:scale-95 transition-all disabled:opacity-30 disabled:hover:scale-100 shadow-[0_0_20px_rgba(6,182,212,0.2)]"
                >
                  EVOLVE
                </button>
             </form>
          </div>
        </div>
      )}
    </div>
  );
};
