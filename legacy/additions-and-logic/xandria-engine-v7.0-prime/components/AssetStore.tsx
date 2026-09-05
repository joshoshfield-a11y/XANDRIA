
import React, { useState, useMemo } from 'react';
import { Asset } from '../types';

interface AssetStoreProps {
  onImport: (asset: Asset) => void;
  importedIds: string[];
}

const MOCK_ASSETS: Asset[] = [
  { id: 'sf-1', name: 'Low Poly Car', source: 'Sketchfab', type: 'Model', previewUrl: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=100&h=100&fit=crop' },
  { id: 'sf-2', name: 'Retro Console', source: 'Sketchfab', type: 'Model', previewUrl: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=100&h=100&fit=crop' },
  { id: 'sf-3', name: 'Cyber Building', source: 'Sketchfab', type: 'Model', previewUrl: 'https://images.unsplash.com/photo-1614850523296-d8c1af93d400?w=100&h=100&fit=crop' },
  { id: 'sf-4', name: 'Neon Sphere', source: 'Internal', type: 'Model', previewUrl: 'https://images.unsplash.com/photo-1550684848-fac1c5b4e853?w=100&h=100&fit=crop' },
  { id: 'sf-5', name: 'Terrain Pack', source: 'Sketchfab', type: 'Model', previewUrl: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=100&h=100&fit=crop' },
  { id: 'sf-6', name: 'Vortex VFX', source: 'Internal', type: 'Audio', previewUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100&h=100&fit=crop' },
];

const AssetStore: React.FC<AssetStoreProps> = ({ onImport, importedIds }) => {
  const [search, setSearch] = useState('');

  const filteredAssets = useMemo(() => {
    return MOCK_ASSETS.filter(a => a.name.toLowerCase().includes(search.toLowerCase()));
  }, [search]);

  return (
    <div className="flex flex-col h-full">
      <div className="mb-6 relative">
        <input 
          type="text" 
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Sketchfab & Internal Repositories..." 
          className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-[11px] outline-none focus:border-cyan-500/50 transition-all placeholder:opacity-20"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-20 text-[10px] fira">SEARCH_ALPHA</div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto pr-2 pb-4">
        {filteredAssets.map(asset => {
          const isImported = importedIds.includes(asset.id);
          return (
            <div key={asset.id} className="glass p-3 rounded-2xl border-white/5 hover:border-cyan-500/30 transition-all group relative overflow-hidden">
              <div className="relative aspect-square mb-3 overflow-hidden rounded-xl">
                <img 
                  src={asset.previewUrl} 
                  alt={asset.name} 
                  className={`w-full h-full object-cover transition-all duration-500 group-hover:scale-110 ${isImported ? 'grayscale opacity-30' : 'opacity-60 group-hover:opacity-100'}`} 
                />
                {isImported && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-[8px] font-bold bg-cyan-500 text-black px-2 py-0.5 rounded-full uppercase tracking-widest shadow-lg">Imported</span>
                  </div>
                )}
              </div>
              <p className="text-[10px] font-bold mb-1 truncate group-hover:text-cyan-400 transition-colors">{asset.name}</p>
              <div className="flex justify-between items-center">
                <p className="text-[8px] opacity-40">{asset.source}</p>
                <p className="text-[8px] text-cyan-500/50 fira">{asset.type}</p>
              </div>
              <button 
                onClick={() => !isImported && onImport(asset)}
                disabled={isImported}
                className={`mt-3 w-full text-[9px] py-2 rounded-xl font-bold uppercase tracking-widest transition-all ${
                  isImported 
                    ? 'bg-white/5 text-white/20 cursor-not-allowed' 
                    : 'bg-cyan-500/10 hover:bg-cyan-500 text-cyan-400 hover:text-black shadow-lg shadow-cyan-500/5'
                }`}
              >
                {isImported ? 'SYNCED' : 'IMPORT_ASSET'}
              </button>
            </div>
          );
        })}
        {filteredAssets.length === 0 && (
          <div className="col-span-3 text-center opacity-20 py-20 italic text-xs">No matches in current repository.</div>
        )}
      </div>
    </div>
  );
};

export default AssetStore;
