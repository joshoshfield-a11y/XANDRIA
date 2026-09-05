
import React, { useRef, useEffect } from 'react';
import { Agent, AgentType } from '../types';

interface SimulationGridProps {
  agents: Agent[];
  dimensions: { width: number; height: number };
  onSelectAgent: (id: string) => void;
  selectedAgentId: string | null;
}

const SimulationGrid: React.FC<SimulationGridProps> = ({ agents, dimensions, onSelectAgent, selectedAgentId }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrame: number;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw Grid
      ctx.strokeStyle = 'rgba(0, 243, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let i = 0; i < canvas.width; i += 40) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, canvas.height); ctx.stroke();
      }
      for (let i = 0; i < canvas.height; i += 40) {
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(canvas.width, i); ctx.stroke();
      }

      // Draw Agents
      agents.forEach((agent) => {
        const isSelected = selectedAgentId === agent.id;

        // Draw Path
        if (agent.path.length > 1) {
          ctx.beginPath();
          ctx.strokeStyle = isSelected ? 'rgba(255, 255, 255, 0.4)' :
                          agent.type === AgentType.EXPLORER ? 'rgba(34, 197, 94, 0.2)' : 
                          agent.type === AgentType.BREAKER ? 'rgba(239, 68, 68, 0.2)' : 'rgba(59, 130, 246, 0.2)';
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.moveTo(agent.path[0].x, agent.path[0].y);
          agent.path.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
          ctx.stroke();
        }

        // Draw Agent Body
        const color = agent.status === 'crashed' ? '#ef4444' :
                      agent.type === AgentType.EXPLORER ? '#22c55e' : 
                      agent.type === AgentType.BREAKER ? '#f59e0b' : '#3b82f6';

        ctx.fillStyle = color;
        ctx.shadowBlur = isSelected ? 20 : 10;
        ctx.shadowColor = color;
        ctx.beginPath();
        ctx.arc(agent.position.x, agent.position.y, isSelected ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        
        if (isSelected) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.shadowBlur = 0;

        // Label
        ctx.fillStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.4)';
        ctx.font = isSelected ? 'bold 10px Fira Code' : '8px Fira Code';
        ctx.fillText(agent.type.slice(0, 3), agent.position.x + 10, agent.position.y);
      });

      animationFrame = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrame);
  }, [agents, selectedAgentId]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Find nearest agent
    const nearest = agents.find(a => {
      const dx = a.position.x - x;
      const dy = a.position.y - y;
      return Math.sqrt(dx * dx + dy * dy) < 20;
    });

    if (nearest) onSelectAgent(nearest.id);
  };

  return (
    <div className="relative w-full h-full glass rounded-xl overflow-hidden">
      <div className="scanner-line"></div>
      <canvas 
        ref={canvasRef} 
        width={dimensions.width} 
        height={dimensions.height}
        onClick={handleClick}
        className="w-full h-full cursor-crosshair"
      />
    </div>
  );
};

export default SimulationGrid;
