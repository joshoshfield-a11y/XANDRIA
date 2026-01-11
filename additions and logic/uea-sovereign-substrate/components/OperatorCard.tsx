
import React from 'react';
import { Operator } from '../types';

interface Props {
  operator: Operator;
  isActive?: boolean;
  onClick?: () => void;
}

const OperatorCard: React.FC<Props> = ({ operator, isActive, onClick }) => {
  const typeColors = {
    Deterministic: 'border-green-500/40 text-green-400 bg-green-500/5',
    Dissipative: 'border-red-500/40 text-red-400 bg-red-500/5',
    Probabilistic: 'border-purple-500/40 text-purple-400 bg-purple-500/5',
  };

  return (
    <div 
      onClick={onClick}
      className={`p-3 border rounded-lg cursor-pointer transition-all duration-300 hover:scale-[1.02] ${
        isActive ? 'ring-2 ring-cyan-400 shadow-[0_0_15px_rgba(0,243,255,0.3)]' : 'opacity-70 grayscale hover:grayscale-0'
      } ${typeColors[operator.type]}`}
    >
      <div className="flex justify-between items-start mb-1">
        <span className="text-[9px] fira font-bold opacity-60">{operator.id}</span>
        <span className="text-[8px] uppercase tracking-tighter opacity-80">{operator.type}</span>
      </div>
      <h4 className="text-xs font-bold truncate mb-1">{operator.name}</h4>
      <p className="text-[9px] leading-tight opacity-60 line-clamp-2">{operator.desc}</p>
    </div>
  );
};

export default OperatorCard;
