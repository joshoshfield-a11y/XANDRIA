
import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, ReferenceLine } from 'recharts';

interface Props {
  data: { frame: number; value: number }[];
  target: number;
}

const TelemetryChart: React.FC<Props> = ({ data, target }) => {
  return (
    <div className="w-full h-full min-h-[300px] glass rounded-xl p-4 overflow-hidden border-cyan-500/20">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-xs font-bold uppercase tracking-widest text-cyan-400">Live Telemetry (R(t))</h3>
        <span className="text-[10px] fira opacity-40">Sample: 0.20% Basis-Error</span>
      </div>
      <ResponsiveContainer width="100%" height="80%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="frame" hide />
          <YAxis domain={[target - 0.5, target + 0.5]} hide />
          <ReferenceLine y={target} stroke="#00f3ff" strokeDasharray="3 3" opacity={0.3} />
          <Line 
            type="monotone" 
            dataKey="value" 
            stroke="#00f3ff" 
            strokeWidth={2} 
            dot={false} 
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default TelemetryChart;
