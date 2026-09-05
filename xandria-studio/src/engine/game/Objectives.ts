/**
 * Objectives — win/lose logic per spec.objective. Blueprints report events;
 * this decides victory/defeat and drives the HUD tracker.
 */
import type { Engine } from '../Engine';
import type { ObjectiveSpec } from '@spec';

export class Objectives {
  progress = 0;
  private timeLeft: number;
  done = false;

  constructor(private engine: Engine, private spec: ObjectiveSpec) {
    this.timeLeft = spec.timeLimit;
    this.updateHud();
  }

  private updateHud() {
    const o = this.spec;
    switch (o.type) {
      case 'collect': this.engine.hud.setProgress(`${this.progress} / ${o.count} collected`); break;
      case 'eliminate': case 'boss': this.engine.hud.setProgress(`${this.progress} / ${o.count} defeated`); break;
      case 'survive': this.engine.hud.setProgress(`${Math.max(0, this.timeLeft).toFixed(0)}s remaining`); break;
      case 'race': this.engine.hud.setProgress(`LAP ${this.progress + 1} / ${o.count}`); break;
      case 'reach': this.engine.hud.setProgress('Reach the beacon'); break;
    }
  }

  /** collect/eliminate/race-lap progress */
  addProgress(n = 1) {
    if (this.done) return;
    this.progress += n;
    this.updateHud();
    const o = this.spec;
    if ((o.type === 'collect' || o.type === 'eliminate' || o.type === 'boss') && this.progress >= o.count) {
      this.done = true;
      this.engine.win();
    }
    if (o.type === 'race' && this.progress >= o.count) {
      this.done = true;
      this.engine.win();
    }
  }

  reachedGoal() {
    if (this.done || this.spec.type !== 'reach') return;
    this.done = true;
    this.engine.win();
  }

  update(dt: number) {
    if (this.done) return;
    if (this.spec.type === 'survive') {
      this.timeLeft -= dt;
      this.updateHud();
      if (this.timeLeft <= 0) { this.done = true; this.engine.win(); }
    } else if (this.spec.timeLimit > 0) {
      this.timeLeft -= dt;
      this.engine.hud.setTimer(Math.max(0, this.timeLeft));
      if (this.timeLeft <= 0) { this.done = true; this.engine.lose('Time ran out.'); }
    } else {
      this.engine.hud.setTimer(this.engine.elapsed);
    }
  }
}
