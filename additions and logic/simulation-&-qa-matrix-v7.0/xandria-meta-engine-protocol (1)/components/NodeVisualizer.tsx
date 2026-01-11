
import React, { useMemo } from 'react';
import { Brain, Wind, Activity, Zap, Box, Shield, Cpu, Target } from 'lucide-react';
import { NodeLogic } from '../types';

interface NodeVisualizerProps {
  nodes: NodeLogic[];
  activeNodeId?: string;
  isSimulating?: boolean;
  onNodeClick?: (id: string) => void;
}

const NodeVisualizer: React.FC<NodeVisualizerProps> = ({ nodes, activeNodeId, isSimulating, onNodeClick }) => {
  const nodePositions = useMemo(() => {
    const pos: Record<string, { x: number; y: number }> = {};
    const colSize = 4;
    nodes.forEach((node, idx) => {
      const col = idx % colSize;
      const row = Math.floor(idx / colSize);
      pos[node.id] = {
        x: 120 + col * 200,
        y: 80 + row * 150
      };
    });
    return pos;
  }, [nodes]);

  const connections = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; id: string; active: boolean; weight: number }[] = [];
    nodes.forEach((node) => {
      const start = nodePositions[node.id];
      if (!start) return;
      node.connectedTo.forEach(targetId => {
        const end = nodePositions[targetId];
        if (end) {
          lines.push({ 
            x1: start.x, 
            y1: start.y, 
            x2: end.x, 
            y2: end.y, 
            id: `${node.id}-${targetId}`,
            active: isSimulating || node.status === 'active' || activeNodeId === node.id,
            weight: node.metrics?.weight || 0.5
          });
        }
      });
    });
    return lines;
  }, [nodes, nodePositions, activeNodeId, isSimulating]);

  const getNodeIcon = (label: string, type: string) => {
    const lower = label.toLowerCase();
    if (lower.includes('ai') || lower.includes('perception') || lower.includes('behavior')) return <Brain size={12} className="text-pink-400" />;
    if (lower.includes('physics') || lower.includes('collision') || lower.includes('rigid')) return <Wind size={12} className="text-orange-400" />;
    if (lower.includes('input') || lower.includes('button')) return <Zap size={12} className="text-purple-400" />;
    if (lower.includes('controller') || lower.includes('solver')) return <Cpu size={12} className="text-cyan-400" />;
    if (type === 'VOID') return <Target size={12} className="opacity-50" />;
    if (type === 'ARTIFACT') return <Shield size={12} className="text-green-400" />;
    return <Box size={12} className="opacity-50" />;
  };

  return (
    <div className="relative w-full h-[580px] glass rounded-[3rem] overflow-hidden border border-white/5 group shadow-2xl">
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(var(--cyan) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
      
      <svg className="absolute inset-0 w-full h-full">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <linearGradient id="activeLine" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0" />
            <stop offset="50%" stopColor="var(--cyan)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {connections.map(line => (
          <g key={line.id}>
            <path 
              d={`M ${line.x1} ${line.y1} C ${(line.x1+line.x2)/2} ${line.y1}, ${(line.x1+line.x2)/2} ${line.y2}, ${line.x2} ${line.y2}`}
              fill="none"
              stroke="rgba(255, 255, 255, 0.05)"
              strokeWidth={1 + line.weight * 2}
            />
            {line.active && (
              <path 
                d={`M ${line.x1} ${line.y1} C ${(line.x1+line.x2)/2} ${line.y1}, ${(line.x1+line.x2)/2} ${line.y2}, ${line.x2} ${line.y2}`}
                fill="none"
                stroke="url(#activeLine)"
                strokeWidth={2 + line.weight * 2}
                strokeDasharray="10,10"
                className="animate-flow"
              />
            )}
          </g>
        ))}

        {nodes.map((node) => {
          const { x, y } = nodePositions[node.id];
          const isSelected = node.id === activeNodeId;
          const isActive = isSelected || node.status === 'active';
          
          return (
            <g key={node.id} 
               onClick={() => onNodeClick?.(node.id)}
               className={`cursor-pointer transition-all duration-500`}>
              <rect 
                x={x - 85} y={y - 40} width="170" height="80" rx="20"
                fill="rgba(5, 5, 15, 0.98)"
                stroke={isActive ? 'var(--cyan)' : 'rgba(255, 255, 255, 0.1)'}
                strokeWidth={isActive ? 2 : 1}
                filter={isActive ? "url(#glow)" : ""}
                className="transition-all duration-300"
              />
              <foreignObject x={x - 70} y={y - 30} width="140" height="60">
                <div className="flex flex-col h-full items-center justify-center text-center space-y-1 select-none">
                  <div className="flex items-center gap-2">
                    {getNodeIcon(node.label, node.type)}
                    <span className="text-[7px] fira uppercase tracking-[0.2em] text-white/30">
                      {node.type}
                    </span>
                  </div>
                  <div className={`text-[10px] font-bold text-white leading-tight uppercase transition-colors ${isSelected ? 'text-cyan-400' : ''}`}>
                    {node.label}
                  </div>
                  {isSimulating && (
                    <div className="w-full bg-white/5 h-0.5 rounded-full mt-2 overflow-hidden">
                       <div 
                        className="h-full bg-cyan-500/50 transition-all duration-500" 
                        style={{ width: `${(node.metrics?.flux || 0.5) * 100}%` }} 
                       />
                    </div>
                  )}
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
      
      {!nodes.length && (
        <div className="flex flex-col items-center justify-center h-full space-y-6 opacity-20 group-hover:opacity-40 transition-opacity">
          <Activity size={64} className="animate-pulse text-cyan-400" />
          <p className="text-sm uppercase tracking-[0.5em] fira">Substrate Latent</p>
        </div>
      )}

      <style>{`
        @keyframes flow { from { stroke-dashoffset: 20; } to { stroke-dashoffset: 0; } }
        .animate-flow { animation: flow 1s linear infinite; }
      `}</style>
    </div>
  );
};

export default NodeVisualizer;
