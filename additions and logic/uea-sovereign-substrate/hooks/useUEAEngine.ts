
import { useState, useEffect, useCallback, useRef } from 'react';
import { EngineState, Operator } from '../types';

export const useUEAEngine = (initialKappa = 0.5, initialTheta = 1.0, initialSigma = 0.15) => {
  const [engine, setEngine] = useState<EngineState>({
    r: 1.0,
    kappa: initialKappa,
    theta: initialTheta,
    sigma: initialSigma,
    frameCount: 0,
    history: [],
    activeOperators: ['F16', 'D3', 'D2']
  });

  const [isRunning, setIsRunning] = useState(false);
  const [transientEffect, setTransientEffect] = useState<{ kappa: number; theta: number; sigma: number } | null>(null);
  // Fixed: Initializing with undefined to satisfy TypeScript requirement for 1 argument in useRef
  const frameRef = useRef<number | undefined>(undefined);

  const updateEngine = useCallback(() => {
    setEngine(prev => {
      const dt = 0.05;
      
      const currentKappa = transientEffect ? prev.kappa + transientEffect.kappa : prev.kappa;
      const currentTheta = transientEffect ? prev.theta + transientEffect.theta : prev.theta;
      const currentSigma = transientEffect ? prev.sigma + transientEffect.sigma : prev.sigma;

      // Ornstein-Uhlenbeck process
      const drift = currentKappa * (currentTheta - prev.r) * dt;
      const noise = currentSigma * (Math.random() - 0.5) * Math.sqrt(dt) * 2;
      
      const nextR = Math.max(0, prev.r + drift + noise);
      const nextHistory = [...prev.history, { frame: prev.frameCount, value: nextR }].slice(-100);

      return {
        ...prev,
        r: nextR,
        frameCount: prev.frameCount + 1,
        history: nextHistory
      };
    });
  }, [transientEffect]);

  useEffect(() => {
    if (isRunning) {
      const loop = () => {
        updateEngine();
        frameRef.current = requestAnimationFrame(loop);
      };
      frameRef.current = requestAnimationFrame(loop);
    } else {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    }
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [isRunning, updateEngine]);

  const injectOperator = (op: Operator) => {
    // Map operator type to parameter spikes
    const impact = { kappa: 0, theta: 0, sigma: 0 };
    if (op.type === 'Deterministic') impact.kappa = 0.8;
    if (op.type === 'Dissipative') impact.theta = -0.3;
    if (op.type === 'Probabilistic') impact.sigma = 0.4;

    setTransientEffect(impact);
    setTimeout(() => setTransientEffect(null), 1500);
  };

  const toggleEngine = () => setIsRunning(!isRunning);
  const resetEngine = () => {
    setEngine(prev => ({
      ...prev,
      r: prev.theta,
      frameCount: 0,
      history: []
    }));
  };

  const updateParam = (key: keyof Pick<EngineState, 'kappa' | 'theta' | 'sigma'>, val: number) => {
    setEngine(prev => ({ ...prev, [key]: val }));
  };

  return { engine, isRunning, toggleEngine, resetEngine, updateParam, injectOperator };
};
