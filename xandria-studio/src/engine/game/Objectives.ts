/**
 * Objectives — win/lose logic per spec.objective. Blueprints report events;
 * this decides victory/defeat and drives the HUD tracker.
 *
 * Stage mode: when spec.objective.stages is present (quest chain), stages form
 * a small directed graph. A stage with `choices` pauses the game and asks the
 * player to pick the next stage; a stage with `next` jumps to the named stage;
 * otherwise the next stage in array order runs. A stage with no successors is
 * terminal and wins the run (using its `winText` when set).
 * Legacy single-objective behavior is unchanged when stages is absent, and a
 * plain linear stages array (no ids/next/choices) walks in order as before.
 */
import type { Engine } from '../Engine';
import type { ObjectiveSpec, ObjectiveStage, ObjectiveType } from '@spec';
import type { RunStats } from './HUD';

export type StageCompleteHandler = (
  index: number,
  stage: ObjectiveStage,
  /** The stage that will run next, or null when the campaign ends here. */
  next: ObjectiveStage | null,
) => void;

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
  /** chapters actually cleared this run (branch-aware; == stageIndex when linear) */
  private cleared = 0;
  /** true while the branch-choice modal is open */
  private awaitingChoice = false;
  private readonly idToIndex = new Map<string, number>();
  private readonly onStageComplete: StageCompleteHandler | undefined;
  private readonly getLevel: () => number;

  constructor(
    engine: Engine,
    spec: ObjectiveSpec,
    onStageComplete?: StageCompleteHandler,
    getLevel?: () => number,
  ) {
    this.engine = engine;
    this.spec = spec;
    this.onStageComplete = onStageComplete;
    this.getLevel = getLevel ?? (() => 1);
    const raw = spec.stages;
    this.stages = Array.isArray(raw) && raw.length > 0 ? raw : null;
    if (this.stages) {
      this.stages.forEach((s, i) => {
        if (s.id) this.idToIndex.set(s.id, i);
      });
    }
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
  /** Id of the currently active stage (undefined in legacy mode). */
  get currentStageId(): string | undefined {
    return this.stages?.[this.stageIndex]?.id;
  }
  /** Chapters fully cleared so far. */
  get stagesCleared(): number {
    return this.stages ? this.cleared : 0;
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
    let stageTag = '';
    if (this.stages != null) {
      const branched = this.stages.some(
        (s) => (s.next?.length ?? 0) > 0 || (s.choices?.length ?? 0) > 0,
      );
      // branched chains have no fixed total — show chapters cleared instead
      stageTag = branched ? ` · Ch.${this.cleared + 1}` : ` [${this.stageIndex + 1}/${this.stages.length}]`;
    }
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
    if (this.done || this.awaitingChoice) return;
    if (!this.stages) {
      this.winRun(undefined);
      return;
    }
    const finished = this.stages[this.stageIndex];
    const finishedIndex = this.stageIndex;
    this.cleared++;
    if (finished.choices && finished.choices.length > 0) {
      // Branch point: pause and let the player pick the next stage.
      this.awaitingChoice = true;
      const choices = finished.choices;
      const labels = choices.map((c) => c.label);
      void this.engine.hud
        .showChoice('CHOOSE YOUR PATH', finished.description, labels)
        .then((picked) => {
          this.awaitingChoice = false;
          if (this.done) return;
          const targetId = choices[picked]?.next;
          const idx = typeof targetId === 'string' ? this.idToIndex.get(targetId) : undefined;
          if (idx === undefined) {
            // Defensive: validated specs always resolve. End the run, don't stall.
            this.winRun(finished);
            return;
          }
          this.advanceTo(idx, finishedIndex, finished);
        });
      return;
    }
    const nextIdx = this.nextIndexAfter(finished, finishedIndex);
    if (nextIdx === null) {
      this.winRun(finished);
      return;
    }
    this.advanceTo(nextIdx, finishedIndex, finished);
  }

  /**
   * Graph successor: explicit `next` by id (an explicit empty array ends the
   * campaign here), else the next stage in array order, else null (terminal).
   */
  private nextIndexAfter(stage: ObjectiveStage, index: number): number | null {
    if (stage.next) {
      return stage.next.length > 0 ? (this.idToIndex.get(stage.next[0]) ?? null) : null;
    }
    return index + 1 < this.stages!.length ? index + 1 : null;
  }

  private advanceTo(nextIdx: number, finishedIndex: number, finished: ObjectiveStage) {
    this.stageIndex = nextIdx;
    this.progress = 0;
    this.timeLeft = this.cur().timeLimit;
    this.updateHud();
    const next = this.stages![nextIdx];
    this.onStageComplete?.(finishedIndex, finished, next);
    this.engine.hooks.emit('onStageComplete', { index: finishedIndex, stage: finished });
    // engine-owned juice: chapter sting + music intensity climbs per chapter
    this.engine.audio?.play('chapter');
    this.engine.audio?.setIntensity(Math.min(1, 0.45 + 0.2 * this.cleared));
  }

  private winRun(finished: ObjectiveStage | undefined) {
    this.done = true;
    const stats: Partial<RunStats> = {
      kills: this.kills,
      stagesCleared: this.stages ? this.cleared : 0,
      level: this.getLevel(),
    };
    // keep the legacy single-arg call shape when there's no branch text
    if (finished?.winText) this.engine.win(stats, finished.winText);
    else this.engine.win(stats);
  }

  update(dt: number) {
    if (this.done || this.awaitingChoice) return;
    const o = this.cur();
    if (o.type === 'survive') {
      this.timeLeft -= dt;
      this.updateHud();
      if (this.timeLeft <= 0) {
        // surviving completes the stage — flow through the quest graph
        // (choices / next / terminal) like every other stage type
        this.completeStep();
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
