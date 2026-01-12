
import React, { useRef } from 'react';
import { AcousticEvent } from '../types';

interface AcousticConsoleProps {
  events: AcousticEvent[];
  material: string;
}

const AcousticConsole: React.FC<AcousticConsoleProps> = ({ events, material }) => {
  const audioCtxRef = useRef<AudioContext | null>(null);

  const playSound = (event: AcousticEvent) => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = event.type as OscillatorType;
    osc.frequency.setValueAtTime(event.frequency, ctx.currentTime);
    
    gain.gain.setValueAtTime(event.gain, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + event.decay);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + event.decay);
  };

  return (
    <div className="bg-slate-900/50 border border-white/5 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex justify-between items-center mb-1">
        <h4 className="text-[10px] uppercase font-bold text-cyan-400">Acoustic Harmonizer</h4>
        <span className="text-[9px] fira opacity-40">Resonance: {material}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {events.map((ev, idx) => (
          <button 
            key={idx}
            onClick={() => playSound(ev)}
            className="bg-white/5 hover:bg-cyan-500/20 border border-white/10 px-3 py-2 rounded-lg text-left transition-all group"
          >
            <div className="text-[10px] font-bold group-hover:text-cyan-400 uppercase tracking-tighter">{ev.name}</div>
            <div className="text-[8px] opacity-40 fira">{ev.frequency}Hz | {ev.type}</div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default AcousticConsole;
