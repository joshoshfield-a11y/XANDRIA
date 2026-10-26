/**
 * UPGRADE LOOP (audio-system): observe-only SFX wiring.
 *
 * Subscribes the audio engine to engine hooks that previously played no
 * sound. Every tap is presentation-only: hooks fire whether or not anyone
 * listens, so gameplay behavior is unchanged when audio is muted, locked,
 * or absent (AudioEngine.play() is a no-op without a context).
 *
 * Deliberately NOT wired:
 * - onPickup: blueprints already play 'pickup'/'coin' in Pickups.onCollect,
 *   which runs AFTER the onPickup emit — a tap here would double every
 *   pickup sound. ItemWorld drops (which have no blueprint sound site)
 *   play 'pickup' directly at their collect site instead.
 * - onAttack: melee/ranged swings already play 'swing'/'shoot'/'hit' at
 *   their call sites (blueprints/common.ts).
 *
 * Idempotent: wiring the same engine twice (restart paths) taps once —
 * a second wire call is a no-op, so a kill can never double-sound.
 */
import type { Sfx } from '../core/Audio';
import type { HookName, HookFn } from './Modding';

export interface AudioWiringEngine {
  hooks: { tap<N extends HookName>(name: N, fn: HookFn<N>): void };
  audio: { play(name: Sfx): void };
}

const WIRED = new WeakSet<object>();

const TAPS: readonly (readonly [HookName, Sfx])[] = [
  ['onKill', 'kill'],
  ['onLevelUp', 'levelup'],
  ['onCraftComplete', 'craft'],
  ['onPortalArrive', 'portal'],
  ['onQuestTurnIn', 'quest'],
];

/** Subscribe audio SFX to the engine's observe-only hooks. Safe to call twice. */
export function wireAudioHooks(engine: AudioWiringEngine): void {
  if (WIRED.has(engine)) return;
  WIRED.add(engine);
  for (const [hook, sfx] of TAPS) {
    engine.hooks.tap(hook, () => { engine.audio.play(sfx); });
  }
}

/** The hook→SFX table above, for tests (assert the onPickup exclusion). */
export function audioWiringTaps(): readonly (readonly [HookName, Sfx])[] {
  return TAPS;
}
