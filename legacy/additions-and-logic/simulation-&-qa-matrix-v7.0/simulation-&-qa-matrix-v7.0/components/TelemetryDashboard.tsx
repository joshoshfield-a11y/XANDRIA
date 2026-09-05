
import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { TelemetryData } from '../types';

interface TelemetryDashboardProps {
  data: TelemetryData[];
}

const TelemetryDashboard: React.FC<TelemetryDashboardProps> = ({ data }) => {
  return (
    <div className="grid grid-cols-3 gap-4 h-full">
      <div className="glass p-5 rounded-xl flex flex-col border-green-500/10 bg-gradient-to-b from-white/5 to-transparent">
        <h3 className="text-[10px] font-bold opacity-50 uppercase tracking-widest mb-4 flex justify-between items-center">
          Accumulated Reward <span>(Global)</span>
        </h3>
        <div className="flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <defs>
                <linearGradient id="colorReward" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
              <XAxis dataKey="time" hide />
              <YAxis hide />
              <Tooltip 
                contentStyle={{ backgroundColor: '#0a0a14', border: '1px solid #22c55e33', fontSize: '10px', borderRadius: '8px' }}
                itemStyle={{ color: '#22c55e' }}
              />
              <Area type="monotone" dataKey="avgReward" stroke="#22c55e" strokeWidth={2} fillOpacity={1} fill="url(#colorReward)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="glass p-5 rounded-xl flex flex-col border-purple-500/10 bg-gradient-to-b from-white/5 to-transparent">
        <h3 className="text-[10px] font-bold opacity-50 uppercase tracking-widest mb-4 flex justify-between items-center">
          Neural Convergence <span>(Policy)</span>
        </h3>
        <div className="flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
              <XAxis dataKey="time" hide />
              <YAxis hide domain={[0, 100]} />
              <Tooltip contentStyle={{ backgroundColor: '#0a0a14', border: '1px solid #a855f733', fontSize: '10px', borderRadius: '8px' }} />
              <Line type="monotone" dataKey="policyConvergence" stroke="#a855f7" strokeWidth={3} dot={false} shadowBlur={10} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="glass p-5 rounded-xl flex flex-col border-cyan-500/10 bg-gradient-to-b from-white/5 to-transparent">
        <h3 className="text-[10px] font-bold opacity-50 uppercase tracking-widest mb-4 flex justify-between items-center">
          System Load <span>(Entropy/TTK)</span>
        </h3>
        <div className="flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
              <XAxis dataKey="time" hide />
              <YAxis hide />
              <Tooltip contentStyle={{ backgroundColor: '#0a0a14', border: '1px solid #00f3ff33', fontSize: '10px', borderRadius: '8px' }} />
              <Line type="stepAfter" dataKey="complexity" stroke="#f59e0b" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="avgTTK" stroke="#00f3ff" strokeWidth={2} strokeDasharray="5 5" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

export default TelemetryDashboard;
