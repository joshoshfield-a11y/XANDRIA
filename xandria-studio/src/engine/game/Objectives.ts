/**
 * Objectives — win/lose logic per spec.objective. Blueprints report events;
 * this decides victory/defeat and drives the HUD tracker.
 *
 * Stage mode: when spec.objective.stages is present (quest chain), stages are
 * walked in order, each with its own progress counter and timeLimit.
 * onStageComplete(index, stage) fires per stage; the final stage calls engine.win().
 * Legacy single-objective behavior is unchanged when stages is absent.
 */
import type { Engine } from '../Engine';
import type { ObjectiveSpec, ObjectiveStage, ObjectiveType } from '@spec';
import type { RunStats } from './HUD';

export class Objectives {
  progress = 0;
  /** total eliminate/boss kills across all stages (for end-of-run stats) */
  kills = 0;
  private timeLeft: number;
  done = false;

  private engine: Engine;
  private spec: ObjectiveSpec;
  private stages: ObjectiveStage[] | null = null;
  private stageIndex = 0;
  private readonly onStageComplete:
    | ((index: number, stage: ObjectiveStage) => void)
    | undefined;
  private readonly getLevel: () => number;

  constructor(
    engine: Engine,
    spec: ObjectiveSpec,
    onStageComplete?: (index: number, stage: ObjectiveStage) => void,
    getLevel?: () => number,
  ) {
    this.engine = engine;
    this.spec = spec;
    this.onStageComplete = onStageComplete;
    this.getLevel = getLevel ?? (() => 1);
    const raw = spec.stages;
    this.stages = Array.isArray(raw) && raw.length > 0 ? raw : null;
    this.timeLeft = this.cur().timeLimit;
    this.updateHud();
  }

  /** Number of stages in the chain (0 in legacy single-objective mode). */
  get stageCount(): number {
    return this.stages ? this.stages.length : 0;
  }
  /** Index of the currently active stage (0 in legacy mode). */
  get currentStageIndex(): number {
    return this.stageIndex;
  }
  /** Stages fully cleared so far. */
  get stagesCleared(): number {
    return this.stages ? this.stageIndex : 0;
  }
  get inStageMode(): boolean {
    return this.stages !== null;
  }

  /** The objective driving the current stage — or the legacy single objective. */
  private cur(): ObjectiveSpec | ObjectiveStage {
    return this.stages ? this.stages[this.stageIndex] : this.spec;
  }

  private updateHud() {
    const o = this.cur();
    const stageTag =
      this.stages != null ? ` [${this.stageIndex + 1}/${this.stages.length}]` : '';
    switch (o.type) {
      case 'collect':
        this.engine.hud.setProgress(`${this.progress} / ${o.count} collected${stageTag}`);
        break;
      case 'eliminate':
      case 'boss':
        this.engine.hud.setProgress(`${this.progress} / ${o.count} defeated${stageTag}`);
        break;
      case 'survive':
        this.engine.hud.setProgress(`${Math.max(0, this.timeLeft).toFixed(0)}s remaining${stageTag}`);
        break;
      case 'race':
        this.engine.hud.setProgress(`LAP ${this.progress + 1} / ${o.count}${stageTag}`);
        break;
      case 'reach':
        this.engine.hud.setProgress(`Reach the beacon${stageTag}`);
        break;
    }
  }

  /** collect/eliminate/race-lap progress */
  addProgress(n = 1) {
    if (this.done) return;
    const o = this.cur();
    this.progress += n;
    if (o.type === 'eliminate' || o.type === 'boss') this.kills += n;
    this.updateHud();
    if (
      (o.type === 'collect' || o.type === 'eliminate' || o.type === 'boss') &&
      this.progress >= o.count
    ) {
      this.completeStep();
    }
    if (o.type === 'race' && this.progress >= o.count) {
      this.completeStep();
    }
  }

  reachedGoal() {
    if (this.done || this.cur().type !== 'reach') return;
    this.completeStep();
  }

  /** A stage (or the legacy objective) just hit its completion condition. */
  private completeStep() {
    if (this.stages && this.stageIndex < this.stages.length - 1) {
      const finished = this.stages[this.stageIndex];
      const finishedIndex = this.stageIndex;
      this.stageIndex++;
      this.progress = 0;
      this.timeLeft = this.cur().timeLimit;
      this.updateHud();
      this.onStageComplete?.(finishedIndex, finished);
      return;
    }
    this.done = true;
    const stats: Partial<RunStats> = {
      kills: this.kills,
      stagesCleared: this.stages ? this.stages.length : 0,
      level: this.getLevel(),
    };
    this.engine.win(stats);
  }

  update(dt: number) {
    if (this.done) return;
    const o = this.cur();
    if (o.type === 'survive') {
      this.timeLeft -= dt;
      this.updateHud();
      if (this.timeLeft <= 0) {
        this.done = true;
        this.engine.win({ kills: this.kills, stagesCleared: this.stagesCleared, level: this.getLevel() });
      }
    } else if (o.timeLimit > 0) {
      this.timeLeft -= dt;
      this.engine.hud.setTimer(Math.max(0, this.timeLeft));
      if (this.timeLeft <= 0) {
        this.done = true;
        this.engine.lose('Time ran out.', {
          kills: this.kills,
          stagesCleared: this.stagesCleared,
          level: this.getLevel(),
        });
      }
    } else {
      this.engine.hud.setTimer(this.engine.elapsed);
    }
  }
}
