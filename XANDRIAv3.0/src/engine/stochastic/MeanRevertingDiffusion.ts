/**
 * XANDRIA MEAN-REVERTING DIFFUSION ENGINE
 * Implements Ornstein-Uhlenbeck process for stochastic code evolution
 * dC(t) = κ(Θ - C(t))dt + σ dW(t)
 */

export interface DiffusionParameters {
  kappa: number;        // κ - Standardization speed (mean reversion rate)
  theta: number;        // Θ - Architectural equilibrium (long-run mean)
  sigma: number;        // σ - Heuristic fluctuation (volatility)
  dt: number;          // Time step size
  initialState: number; // C(0) - Initial code state
}

export interface DiffusionState {
  currentState: number;   // C(t) - Current code quality/complexity
  time: number;          // Current time
  drift: number;         // Deterministic drift component
  diffusion: number;     // Stochastic diffusion component
  equilibriumDistance: number; // Distance from architectural equilibrium
  convergenceRate: number;     // Rate of approach to equilibrium
}

export interface EvolutionTrajectory {
  states: DiffusionState[];
  parameters: DiffusionParameters;
  totalTime: number;
  finalState: number;
  convergenceAchieved: boolean;
  technicalDebtReduction: number;
}

export class MeanRevertingDiffusion {
  private parameters: DiffusionParameters;

  constructor(parameters: DiffusionParameters) {
    this.validateParameters(parameters);
    this.parameters = { ...parameters };
  }

  /**
   * Validate diffusion parameters
   */
  private validateParameters(params: DiffusionParameters): void {
    if (params.kappa <= 0) {
      throw new Error('Standardization speed (kappa) must be positive');
    }
    if (params.sigma < 0) {
      throw new Error('Volatility (sigma) cannot be negative');
    }
    if (params.dt <= 0 || params.dt > 1) {
      throw new Error('Time step (dt) must be between 0 and 1');
    }
  }

  /**
   * Generate Wiener process increment (Brownian motion)
   */
  private generateWienerIncrement(): number {
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return z0 * Math.sqrt(this.parameters.dt);
  }

  /**
   * Compute single time step evolution
   */
  private evolveSingleStep(currentState: number, currentTime: number): DiffusionState {
    const { kappa, theta, sigma } = this.parameters;

    // Deterministic drift: κ(Θ - C(t))
    const drift = kappa * (theta - currentState) * this.parameters.dt;

    // Stochastic diffusion: σ dW(t)
    const diffusion = sigma * this.generateWienerIncrement();

    // Update state: C(t+dt) = C(t) + drift + diffusion
    const newState = currentState + drift + diffusion;

    // Ensure state stays within reasonable bounds
    const boundedState = Math.max(0, Math.min(1, newState));

    const equilibriumDistance = Math.abs(theta - boundedState);
    const convergenceRate = kappa * equilibriumDistance;

    return {
      currentState: boundedState,
      time: currentTime + this.parameters.dt,
      drift,
      diffusion,
      equilibriumDistance,
      convergenceRate
    };
  }

  /**
   * Evolve system over multiple time steps
   */
  evolve(trajectoryLength: number): EvolutionTrajectory {
    const states: DiffusionState[] = [];
    let currentState = this.parameters.initialState;
    let currentTime = 0;

    // Initial state
    states.push({
      currentState,
      time: currentTime,
      drift: 0,
      diffusion: 0,
      equilibriumDistance: Math.abs(this.parameters.theta - currentState),
      convergenceRate: this.parameters.kappa * Math.abs(this.parameters.theta - currentState)
    });

    // Evolve through time
    for (let i = 0; i < trajectoryLength; i++) {
      const newState = this.evolveSingleStep(currentState, currentTime);
      states.push(newState);
      currentState = newState.currentState;
      currentTime = newState.time;
    }

    const totalTime = currentTime;
    const finalState = currentState;
    const convergenceAchieved = Math.abs(this.parameters.theta - finalState) < 0.01;
    const technicalDebtReduction = this.parameters.initialState - finalState;

    return {
      states,
      parameters: { ...this.parameters },
      totalTime,
      finalState,
      convergenceAchieved,
      technicalDebtReduction
    };
  }

  /**
   * Multi-dimensional evolution for complex codebases
   */
  evolveMultidimensional(
    initialStates: number[],
    trajectoryLength: number
  ): EvolutionTrajectory[] {
    return initialStates.map(initialState => {
      const params = { ...this.parameters, initialState };
      const engine = new MeanRevertingDiffusion(params);
      return engine.evolve(trajectoryLength);
    });
  }

  /**
   * Adaptive parameter optimization based on convergence performance
   */
  optimizeParameters(
    trajectory: EvolutionTrajectory,
    targetConvergenceTime: number
  ): DiffusionParameters {
    const { kappa, sigma, theta } = this.parameters;
    let optimizedParams = { ...this.parameters };

    // Analyze convergence performance
    const convergenceTime = this.calculateConvergenceTime(trajectory);
    const convergenceRatio = convergenceTime / targetConvergenceTime;

    // Adjust kappa based on convergence speed
    if (convergenceRatio > 1.2) {
      // Too slow - increase kappa
      optimizedParams.kappa = Math.min(kappa * 1.1, 2.0);
    } else if (convergenceRatio < 0.8) {
      // Too fast - decrease kappa
      optimizedParams.kappa = Math.max(kappa * 0.9, 0.1);
    }

    // Adjust sigma based on stability
    const stability = this.calculateTrajectoryStability(trajectory);
    if (stability < 0.7) {
      // Too unstable - decrease sigma
      optimizedParams.sigma = Math.max(sigma * 0.9, 0.01);
    } else if (stability > 0.9) {
      // Too stable - increase sigma for exploration
      optimizedParams.sigma = Math.min(sigma * 1.05, 0.5);
    }

    return optimizedParams;
  }

  /**
   * Calculate time to convergence (when state is within 1% of equilibrium)
   */
  private calculateConvergenceTime(trajectory: EvolutionTrajectory): number {
    const convergenceThreshold = 0.01;
    const equilibrium = trajectory.parameters.theta;

    for (let i = 0; i < trajectory.states.length; i++) {
      const distance = Math.abs(trajectory.states[i].currentState - equilibrium);
      if (distance <= convergenceThreshold) {
        return trajectory.states[i].time;
      }
    }

    return trajectory.totalTime; // No convergence achieved
  }

  /**
   * Calculate trajectory stability (inverse of variance)
   */
  private calculateTrajectoryStability(trajectory: EvolutionTrajectory): number {
    const states = trajectory.states.map(s => s.currentState);
    const mean = states.reduce((a, b) => a + b, 0) / states.length;
    const variance = states.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / states.length;

    // Convert variance to stability score (0-1, higher is more stable)
    return Math.max(0, 1 - Math.min(variance * 10, 1));
  }

  /**
   * Predict future evolution without computing full trajectory
   */
  predictFutureState(
    currentState: number,
    predictionHorizon: number
  ): { predictedState: number; confidence: number; timeToConvergence: number } {
    const { kappa, theta, sigma } = this.parameters;

    // Analytical solution for Ornstein-Uhlenbeck process
    const expectedState = theta + (currentState - theta) * Math.exp(-kappa * predictionHorizon);
    const variance = (sigma * sigma / (2 * kappa)) * (1 - Math.exp(-2 * kappa * predictionHorizon));
    const standardDeviation = Math.sqrt(variance);

    // Time to convergence (within 1% of equilibrium)
    const convergenceThreshold = 0.01;
    const timeToConvergence = convergenceThreshold > 0 ?
      Math.abs(Math.log(convergenceThreshold / Math.abs(theta - currentState))) / kappa : 0;

    // Confidence based on prediction accuracy
    const confidence = Math.max(0.1, 1 - (standardDeviation / 0.1));

    return {
      predictedState: expectedState,
      confidence,
      timeToConvergence
    };
  }

  /**
   * Get current diffusion parameters
   */
  getParameters(): DiffusionParameters {
    return { ...this.parameters };
  }

  /**
   * Update diffusion parameters
   */
  updateParameters(newParams: Partial<DiffusionParameters>): void {
    const updated = { ...this.parameters, ...newParams };
    this.validateParameters(updated);
    this.parameters = updated;
  }

  /**
   * Reset to initial state
   */
  reset(): void {
    // Reset parameters to defaults if needed
    this.parameters.initialState = 0.5; // Default initial state
  }
}