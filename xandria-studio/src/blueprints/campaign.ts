/**
 * Campaign-layer wiring shared by all genre blueprints.
 *
 * Quest chains (Objectives stage sequencer), intro/chapter story cards,
 * and the XP level-up flow (Progression + HUD modal). All helpers are
 * no-ops when the spec lacks the new fields, so legacy specs keep working.
 */
import type { Engine } from '../engine/Engine';
import type { GameSpec, ObjectiveStage, ObjectiveType } from '@spec';
import { Objectives } from '../engine/game/Objectives';
import { Progression, type UpgradeDef, type UpgradeId } from '../engine/game/Progression';
import type { PlayerAvatar } from './common';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
export const roman = (n: number): string => ROMAN[n - 1] ?? String(n);

/** Intro story card (non-blocking, auto-dismisses). Guard: narrative is optional. */
export function showIntroCard(engine: Engine, spec: GameSpec): void {
  const premise = spec.narrative?.premise;
  if (premise) {
    // fire-and-forget: showCard never pauses, so boot flow is unaffected
    void engine.hud.showCard(spec.meta.name, premise);
  }
}

export type StageHandler = (finishedIndex: number, finished: ObjectiveStage) => void;

/**
 * Build an Objectives sequencer wired to chapter cards.
 * On each stage completion: banner "Chapter <roman>" + refresh the HUD
 * objective line to the new stage's description.
 */
export function makeCampaignObjectives(
  engine: Engine,
  spec: GameSpec,
  extra?: StageHandler,
  getLevel?: () => number,
): Objectives {
  const hud = engine.hud;
  const objectives = new Objectives(engine, spec.objective, (finishedIndex, finished) => {
    const next = spec.objective.stages?.[finishedIndex + 1];
    const label = `Chapter ${roman(finishedIndex + 2)}`;
    const body = next?.description ?? finished.description;
    hud.showCard(label, body);
    hud.setObjective(spec.meta.name.toUpperCase(), body);
    extra?.(finishedIndex, finished);
  }, getLevel);
  const first = spec.objective.stages?.[0];
  hud.setObjective(spec.meta.name.toUpperCase(), first?.description ?? spec.objective.description);
  return objectives;
}

/**
 * Level-up flow for humanoid blueprints (PlayerAvatar present).
 * Returns a `notifyLevelUp()` function: call it whenever Progression.onKill()
 * or onPickup() returns true. Modals are queued so rapid multi-level-ups
 * each get their own choice screen. 'dash' is filtered out (no mutable hook
 * on CharacterController); speed upgrades scale spec.player.speed, which the
 * controller reads per-frame.
 */
export function makeLevelUpFlow(
  engine: Engine,
  spec: GameSpec,
  prog: Progression,
  avatar: PlayerAvatar,
): () => void {
  let chain: Promise<void> = Promise.resolve();
  return () => {
    chain = chain.then(async () => {
      const all = prog.getUpgradeChoices();
      const usable = all.filter((c: UpgradeDef) => c.id !== 'dash');
      const id = (await engine.hud.showLevelUp(usable.length ? usable : all)) as UpgradeId;
      prog.applyUpgrade(id, avatar);
      if (id === 'speed') spec.player.speed *= 1.12; // == speedMult() for one stack, compounds
    });
  };
}

/** XP for a kill; triggers the level-up queue when a level is gained. */
export function grantKillXp(prog: Progression, notifyLevelUp: () => void): void {
  if (prog.onKill()) notifyLevelUp();
}

/** XP for a pickup; triggers the level-up queue when a level is gained. */
export function grantPickupXp(prog: Progression, notifyLevelUp: () => void): void {
  if (prog.onPickup()) notifyLevelUp();
}

/** Boss-phase banner shared by all combat blueprints. */
export function bossPhaseBanner(engine: Engine, phase: number): void {
  engine.hud.showCard(
    'THE WARDEN ENRAGES',
    phase >= 2 ? 'It fights with desperate fury — finish it!' : 'Its attacks quicken. Watch the tells!',
  );
  engine.audio.play('alarm');
}

/** True when this spec has any boss stage (quest chain or legacy). */
export function hasBossStage(spec: GameSpec): boolean {
  if (spec.objective.type === 'boss') return true;
  return !!spec.objective.stages?.some((s: ObjectiveStage) => s.type === 'boss');
}

/** ObjectiveType import re-export for blueprint convenience. */
export type { ObjectiveType };
