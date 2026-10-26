/**
 * Player settings: master volume, mute, render quality. Persisted per save
 * slot (UPGRADE LOOP: save-slots) — each slot carries its own settings, so
 * switching slots switches settings too. Legacy xandria.settings.v1 is
 * consumed once into 'Slot 1' by the slot migration in Profile.ts.
 * Storage access is guarded — headless/test environments get clean defaults.
 */
import type { PerfTierSetting } from '../core/PerformanceManager';
import { loadSlotSettings, saveSlotSettings } from './Profile';

export type QualitySetting = 'auto' | 'retro' | 'standard' | 'high';

export interface SettingsData {
  /** 0..1 */
  volume: number;
  muted: boolean;
  /**
   * UPGRADE LOOP (audio-system): per-bus audio controls, persisted per save
   * slot like volume/muted. musicEnabled/sfxEnabled gate their bus gain to
   * zero (the other bus keeps playing); volumes are 0..1 multipliers on top
   * of the spec's musicVolume/sfxVolume. Missing keys default (see below)
   * so old slot stores migrate without a version bump.
   */
  musicEnabled: boolean;
  sfxEnabled: boolean;
  /** 0..1 */
  musicVolume: number;
  /** 0..1 */
  sfxVolume: number;
  /** 'auto' follows the spec's quality hint */
  quality: QualitySetting;
  /**
   * Graphics wave 2 (E): perf-tier override. 'auto' resolves via
   * PerformanceManager (?tier= → spec.custom.tier → device auto-detect).
   */
  tier: PerfTierSetting;
  /**
   * DAMAGE-NUMBERS: floating combat-text master toggle. Default true;
   * persisted per save slot like the rest of SettingsData, so it
   * survives reload (Engine.applySettings re-applies it to Juice).
   */
  floatingText: boolean;
}

const DEFAULTS: SettingsData = { volume: 0.8, muted: false, quality: 'auto', tier: 'auto', floatingText: true, musicEnabled: true, sfxEnabled: true, musicVolume: 0.8, sfxVolume: 0.8 };
const QUALITIES: QualitySetting[] = ['auto', 'retro', 'standard', 'high'];
const TIERS: PerfTierSetting[] = ['auto', 'desktop', 's25'];

export class Settings {
  data: SettingsData;

  constructor() {
    // save-slots: read the ACTIVE slot's settings (migration handled inside).
    this.data = { ...DEFAULTS, ...loadSlotSettings() };
    this.data.volume = Settings.clampVol(this.data.volume);
    this.data.musicVolume = Settings.clampVol(this.data.musicVolume);
    this.data.sfxVolume = Settings.clampVol(this.data.sfxVolume);
    this.data.musicEnabled = this.data.musicEnabled !== false;
    this.data.sfxEnabled = this.data.sfxEnabled !== false;
    if (!QUALITIES.includes(this.data.quality)) this.data.quality = 'auto';
    if (!TIERS.includes(this.data.tier)) this.data.tier = 'auto';
    // Older slots predate the damage-numbers toggle: undefined must read
    // as the default (true), never as falsy-off.
    if (typeof this.data.floatingText !== 'boolean') this.data.floatingText = true;
  }

  private static clampVol(v: unknown): number {
    const n = typeof v === 'number' && isFinite(v) ? v : DEFAULTS.volume;
    return Math.max(0, Math.min(1, n));
  }

  /** Merge a patch and persist into the active slot. Volume is clamped to 0..1. */
  set(patch: Partial<SettingsData>): void {
    Object.assign(this.data, patch);
    this.data.volume = Settings.clampVol(this.data.volume);
    this.data.musicVolume = Settings.clampVol(this.data.musicVolume);
    this.data.sfxVolume = Settings.clampVol(this.data.sfxVolume);
    if (patch.quality !== undefined && !QUALITIES.includes(patch.quality)) {
      this.data.quality = 'auto';
    }
    if (patch.tier !== undefined && !TIERS.includes(patch.tier)) {
      this.data.tier = 'auto';
    }
    if (patch.floatingText !== undefined) {
      this.data.floatingText = patch.floatingText === true;
    }
    saveSlotSettings(this.data);
  }

  /**
   * Re-read from storage (picks up changes made elsewhere — including a
   * save-slot switch, which is why Engine calls this after select/delete).
   */
  reload(): void {
    const fresh = loadSlotSettings();
    this.data.volume = Settings.clampVol(fresh.volume);
    this.data.muted = !!fresh.muted;
    this.data.musicEnabled = fresh.musicEnabled !== false;
    this.data.sfxEnabled = fresh.sfxEnabled !== false;
    this.data.musicVolume = Settings.clampVol(fresh.musicVolume);
    this.data.sfxVolume = Settings.clampVol(fresh.sfxVolume);
    this.data.quality = QUALITIES.includes(fresh.quality) ? fresh.quality : 'auto';
    this.data.tier = TIERS.includes(fresh.tier) ? fresh.tier : 'auto';
    this.data.floatingText = typeof fresh.floatingText === 'boolean' ? fresh.floatingText : true;
  }
}
