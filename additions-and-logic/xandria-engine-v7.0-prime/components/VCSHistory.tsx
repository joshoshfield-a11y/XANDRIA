
import React from 'react';
import { Commit } from '../types';

interface VCSHistoryProps {
  commits: Commit[];
  currentBranch: string;
  allBranches: string[];
  onRestore: (commit: Commit) => void;
  onBranch: (branchName: string) => void;
  onSwitch: (branchName: string) => void;
  onMerge: (sourceBranch: string) => void;
}

const VCSHistory: React.FC<VCSHistoryProps> = ({ commits, currentBranch, allBranches, onRestore, onBranch, onSwitch, onMerge }) => {
  return (
    <div className="flex flex-col h-full">
      <div className="flex justify-between items-center mb-6 pb-2 border-b border-white/5">
        <div className="flex gap-2 items-center">
          <span className="text-[9px] opacity-40 uppercase mr-2 tracking-widest">Branches:</span>
          {allBranches.map(b => (
            <button 
              key={b}
              onClick={() => onSwitch(b)}
              className={`text-[9px] px-3 py-1 rounded-full border transition-all ${currentBranch === b ? 'border-cyan-500 text-cyan-400 bg-cyan-500/10' : 'border-white/10 opacity-60 hover:opacity-100'}`}
            >
              {b}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {allBranches.length > 1 && (
            <select 
              className="bg-black/40 border border-white/10 rounded-full px-3 py-1 text-[9px] outline-none text-white/70"
              onChange={(e) => {
                if (e.target.value) {
                  onMerge(e.target.value);
                  e.target.value = "";
                }
              }}
            >
              <option value="">MERGE_FROM...</option>
              {allBranches.filter(b => b !== currentBranch).map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          )}
          <button 
            onClick={() => {
              const name = prompt("Enter branch name:");
              if (name) onBranch(name);
            }}
            className="text-[9px] font-bold bg-white/5 hover:bg-white/10 px-4 py-1 rounded-full border border-white/10 transition-all text-white/70"
          >
            + NEW_BRANCH
          </button>
        </div>
      </div>
      <div className="space-y-4 overflow-y-auto flex-1 pr-2">
        {commits.map((commit, i) => (
          <div key={commit.id} className="relative pl-6 before:absolute before:left-2 before:top-2 before:bottom-0 before:w-px before:bg-white/10 last:before:hidden">
            <div className={`absolute left-1 top-1.5 w-2 h-2 rounded-full shadow-lg ${i === 0 ? 'bg-cyan-400 animate-pulse' : 'bg-white/20'}`} />
            <div 
              className="glass p-4 rounded-xl border border-white/5 hover:border-cyan-500/30 transition-all group cursor-pointer active:scale-[0.98]" 
              onClick={() => onRestore(commit)}
            >
              <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] font-bold text-cyan-400 fira uppercase tracking-tighter">
                  {commit.id.slice(0, 8)}
                </span>
                <span className="text-[8px] opacity-40 fira">
                  {new Date(commit.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-[11px] opacity-70 group-hover:opacity-100 transition-opacity leading-tight">
                {commit.message}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                 {Object.keys(commit.files).map(f => (
                   <span key={f} className="text-[7px] bg-white/5 px-2 py-0.5 rounded-full border border-white/5 opacity-50 uppercase tracking-widest">
                     {f}
                   </span>
                 ))}
              </div>
            </div>
          </div>
        ))}
        {commits.length === 0 && (
          <div className="text-center opacity-20 py-20 italic text-xs">No commit history on this timeline.</div>
        )}
      </div>
    </div>
  );
};

export default VCSHistory;
