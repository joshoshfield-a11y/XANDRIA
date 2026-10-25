/**
 * Tutorial — a data-driven guided first-run tutorial.
 *
 * Design rules (from the upgrade brief):
 *   - The tutorial OBSERVES ONLY. It taps the Modding hook seams (onTick,
 *     onAttack, onPickup, onCraftComplete, onPortalArrive) and reads public
 *     engine state (player position, camera orientation, inventory slots).
 *     It never mutates gameplay, never changes contracts, never touches RNG.
 *   - All tuning lives in TUTORIAL_STEPS below: one row per step with the
 *     prompt text, the trigger condition, the completion condition, the HUD
 *     highlight target, and the auto-skip rule for genres where the step
 *     cannot be performed (racing has no attack, item-less specs have no
 *     equip, crafting-off specs have no craft, portal-off specs have no
 *     portal step). A step that cannot be performed is skipped, never a
 *     dead end.
 *   - Player-scoped 'seen' flag lives in the persistent Profile
 *     (tutorialSeen): once completed or dismissed it never replays, across
 *     reloads. Studio can force it on/off per spec via custom.tutorial.mode
 *     (auto | force | skip).
 *   - Determinism: triggers are pure state observations. No RNG anywhere.
 *
 * Wiring: the Engine constructs one TutorialManager (engine.tutorial) and
 * the blueprint item kit registers the inventory getter (no inventory in a
 * run = the equip step auto-skips). The manager taps engine.hooks, which
 * survive restart(), so a mid-run restart keeps the tutorial's progress.
 */
import * as THREE from 'three';
import type { Engine } from '../Engine';
import type { GameSpec } from '@spec';
import { EQUIP_SLOTS } from '@spec';
import { loadProfile, saveProfile } from './Profile';
import type { Inventory } from './items/Inventory';

/** Studio mode for the tutorial (spec custom.tutorial.mode). */
export type TutorialMode = 'auto' | 'force' | 'skip';

export const TUTORIAL_MODES: readonly TutorialMode[] = ['auto', 'force', 'skip'];

/**
 * One tutorial step. `trigger` / `completeWhen` / `skipWhen` are the
 * human-readable contract; the manager implements exactly what they say.
 * `hudTarget` is a HUD selector to pulse-highlight while the step is active
 * (null = the tutorial card itself is the highlight).
 */
export interface TutorialStepDef {
  id: 'move' | 'look' | 'attack' | 'loot' | 'equip' | 'craft' | 'portal';
  /** short label for the card header ("STEP 2/7 — LOOK") */
  title: string;
  /** player-facing prompt (desktop) */
  prompt: string;
  /** player-facing prompt (touch devices) */
  promptTouch: string;
  /** when this step becomes the active step */
  trigger: string;
  /** what completes the step */
  completeWhen: string;
  /** HUD selector to highlight while active (null = card only) */
  hudTarget: string | null;
  /** when the step is auto-skipped instead of shown */
  skipWhen: string;
  /** tuning: cumulative horizontal meters that complete 'move' */
  moveMeters?: number;
  /** tuning: cumulative look radians (yaw+pitch) that complete 'look' */
  lookRadians?: number;
}

/**
 * THE tutorial defs table — every step, in order, with all tuning in one
 * place. Edit prompts/tuning here; the manager is generic.
 */
export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  {
    id: 'move',
    title: 'MOVE',
    prompt: 'Move with WASD or the arrow keys',
    promptTouch: 'Drag the left stick to move',
    trigger: 'Tutorial starts (fresh profile, mode auto/force)',
    completeWhen: 'Player has moved 6 m total (teleports do not count)',
    hudTarget: null,
    skipWhen: 'Never — movement exists in every genre',
    moveMeters: 6,
  },
  {
    id: 'look',
    title: 'LOOK',
    prompt: 'Move the mouse to look around',
    promptTouch: 'Drag on the right side of the screen to look',
    trigger: 'Move step complete',
    completeWhen: 'Camera has turned 0.6 rad total (yaw + pitch)',
    hudTarget: null,
    skipWhen: 'Never — every genre has a camera',
    lookRadians: 0.6,
  },
  {
    id: 'attack',
    title: 'ATTACK',
    prompt: 'Left-click to attack',
    promptTouch: 'Tap the ATK button to attack',
    trigger: 'Look step complete',
    completeWhen: 'Player attacks once (melee swing or fired shot)',
    hudTarget: null,
    skipWhen: "spec.player.weapon === 'none' (e.g. racing — no player attack)",
  },
  {
    id: 'loot',
    title: 'LOOT',
    prompt: 'Walk over the glowing pickup to grab it',
    promptTouch: 'Walk over the glowing pickup to grab it',
    trigger: 'Attack step complete (or auto-skipped)',
    completeWhen: 'One pickup collected',
    hudTarget: null,
    skipWhen: 'Never — pickups exist in every genre',
  },
  {
    id: 'equip',
    title: 'EQUIP',
    prompt: 'Open your inventory and equip a piece of gear',
    promptTouch: 'Open your inventory and equip a piece of gear',
    trigger: 'Loot step complete',
    completeWhen: 'Any equip slot holds an item',
    hudTarget: null,
    skipWhen: 'No inventory in this run (spec.custom.items absent)',
  },
  {
    id: 'craft',
    title: 'CRAFT',
    prompt: 'Find a workbench, press [E], and craft something',
    promptTouch: 'Find a workbench, tap USE, and craft something',
    trigger: 'Equip step complete (or auto-skipped)',
    completeWhen: 'One craft() transaction completes',
    hudTarget: null,
    skipWhen: 'Crafting disabled (custom.crafting.enabled = false)',
  },
  {
    id: 'portal',
    title: 'PORTAL',
    prompt: 'Step through a glowing portal to travel',
    promptTouch: 'Step through a glowing portal to travel',
    trigger: 'Craft step complete (or auto-skipped)',
    completeWhen: 'Arrival on another map (onPortalArrive)',
    hudTarget: null,
    skipWhen: 'Portals not enabled for this spec (no portal manager)',
  },
];

/** Resolve the Studio tutorial mode from the spec (default 'auto'). */
export function resolveTutorialMode(spec: GameSpec): TutorialMode {
  const raw = (spec.custom as Record<string, unknown> | undefined)?.tutorial;
  const mode =
    raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).mode
      : undefined;
  return (TUTORIAL_MODES as readonly string[]).includes(mode as string)
    ? (mode as TutorialMode)
    : 'auto';
}

/**
 * The tutorial manager. Constructed once per Engine; observes only.
 */
export class TutorialManager {
  /** true while the tutorial is showing steps */
  active = false;
  /** true once completed or skipped (terminal for this engine) */
  done = false;
  /** index into TUTORIAL_STEPS of the current step (-1 when inactive/done) */
  stepIndex = -1;
  readonly mode: TutorialMode;

  private started = false; // card shown on first playing tick
  private inventory: (() => Inventory | null) | null = null;
  private lastPos = new THREE.Vector3();
  private haveLastPos = false;
  private moveAccum = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private haveLastLook = false;
  private lookAccum = 0;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly engine: Engine) {
    this.mode = resolveTutorialMode(engine.spec);
    if (this.mode === 'skip') {
      this.done = true;
      return;
    }
    if (this.mode === 'auto') {
      try {
        if (loadProfile().tutorialSeen) {
          this.done = true;
          return;
        }
      } catch {
        /* corrupt profile = treat as unseen; never crash boot */
      }
    }
    // mode 'force', or 'auto' with an unseen profile: arm the tutorial.
    // The card appears on the first tick in the 'playing' state.
    this.active = true;
    this.stepIndex = 0;
    const hooks = engine.hooks;
    hooks.tap('onTick', () => this.onTick());
    hooks.tap('onAttack', () => this.completeStepIf('attack'));
    hooks.tap('onPickup', () => this.completeStepIf('loot'));
    hooks.tap('onCraftComplete', () => this.completeStepIf('craft'));
    hooks.tap('onPortalArrive', () => this.completeStepIf('portal'));
  }

  /** Current step def, or null when inactive/done. */
  get step(): TutorialStepDef | null {
    return this.active && this.stepIndex >= 0
      ? TUTORIAL_STEPS[this.stepIndex] ?? null
      : null;
  }

  get stepId(): string | null {
    return this.step?.id ?? null;
  }

  /** Blueprint item kit registers the live inventory getter (one line). */
  setInventory(get: () => Inventory | null): void {
    this.inventory = get;
  }

  /** Test seam: restart the tutorial from step 0 regardless of profile/mode. */
  forceStart(): void {
    this.done = false;
    this.active = true;
    this.started = false;
    this.stepIndex = 0;
    this.moveAccum = 0;
    this.lookAccum = 0;
    this.haveLastPos = false;
    this.haveLastLook = false;
  }

  /** Player pressed Skip (or the Studio skip path): never replay. */
  skip(): void {
    if (this.done) return;
    this.finish(false);
  }

  // ------------------------------------------------------------------ ticks

  private onTick(): void {
    if (!this.active || this.done) return;
    if (this.engine.state !== 'playing') return;
    if (!this.started) {
      this.started = true;
      this.activateStep();
      return;
    }
    const step = this.step;
    if (!step) return;
    if (step.id === 'move') this.pollMove(step);
    else if (step.id === 'look') this.pollLook(step);
    else if (step.id === 'equip') this.pollEquip();
  }

  /** Show the current step, auto-skipping steps that can't be performed. */
  private activateStep(): void {
    while (this.active) {
      const step = this.step;
      if (!step) {
        this.finish(true);
        return;
      }
      if (this.shouldSkip(step)) {
        this.stepIndex++;
        continue;
      }
      const touch = this.isTouch();
      this.engine.hud.showTutorialCard(
        `STEP ${this.stepIndex + 1}/${TUTORIAL_STEPS.length} — ${step.title}`,
        touch ? step.promptTouch : step.prompt,
        step.hudTarget,
        () => this.skip(),
      );
      return;
    }
  }

  /** Auto-skip rules, exactly as documented in the defs table. */
  private shouldSkip(step: TutorialStepDef): boolean {
    switch (step.id) {
      case 'attack':
        return this.engine.spec.player.weapon === 'none';
      case 'equip':
        return !this.inventory || !this.inventory();
      case 'craft': {
        // resolveCraftingEnabled default is true; only an explicit
        // custom.crafting.enabled=false disables it.
        const crafting = (this.engine.spec.custom as Record<string, unknown> | undefined)
          ?.crafting as Record<string, unknown> | undefined;
        return crafting?.enabled === false;
      }
      case 'portal':
        return !this.engine.portalManager;
      default:
        return false;
    }
  }

  private completeStepIf(id: TutorialStepDef['id']): void {
    if (!this.active || this.done || !this.started) return;
    if (this.step?.id !== id) return;
    this.advance();
  }

  private advance(): void {
    this.stepIndex++;
    // reset per-step accumulators
    this.moveAccum = 0;
    this.lookAccum = 0;
    this.haveLastPos = false;
    this.haveLastLook = false;
    this.activateStep();
  }

  private finish(completed: boolean): void {
    this.active = false;
    this.done = true;
    this.stepIndex = -1;
    try {
      const p = loadProfile();
      p.tutorialSeen = true;
      saveProfile(p);
    } catch {
      /* storage failures must never break the run */
    }
    this.engine.hud.hideTutorialCard();
    this.engine.hud.toast(
      completed ? 'Tutorial complete — good hunting.' : 'Tutorial skipped.',
    );
  }

  // ------------------------------------------------------- polled observers

  private pollMove(step: TutorialStepDef): void {
    const avatar = this.engine.portalsPlayerAvatar;
    if (!avatar) return;
    const pos = avatar.ctrl.position;
    if (!this.haveLastPos) {
      this.lastPos.copy(pos);
      this.haveLastPos = true;
      return;
    }
    const dx = pos.x - this.lastPos.x;
    const dz = pos.z - this.lastPos.z;
    const d = Math.hypot(dx, dz);
    // ignore teleports / respawns (single-tick jumps are not walking)
    if (d <= 8) this.moveAccum += d;
    this.lastPos.copy(pos);
    if (this.moveAccum >= (step.moveMeters ?? 6)) this.advance();
  }

  private pollLook(step: TutorialStepDef): void {
    this.euler.setFromQuaternion(this.engine.camera.quaternion);
    const yaw = this.euler.y;
    const pitch = this.euler.x;
    if (!this.haveLastLook) {
      this.lastYaw = yaw;
      this.lastPitch = pitch;
      this.haveLastLook = true;
      return;
    }
    this.lookAccum += Math.abs(yaw - this.lastYaw) + Math.abs(pitch - this.lastPitch);
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    if (this.lookAccum >= (step.lookRadians ?? 0.6)) this.advance();
  }

  private pollEquip(): void {
    const inv = this.inventory?.();
    if (!inv) return;
    for (const slot of EQUIP_SLOTS) {
      if (inv.getEquipped(slot) != null) {
        this.advance();
        return;
      }
    }
  }

  private isTouch(): boolean {
    try {
      return this.engine.touch?.active === true;
    } catch {
      return false;
    }
  }
}
