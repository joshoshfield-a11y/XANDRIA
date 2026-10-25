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
  /** 'auto' follows the spec's quality hint */
  quality: QualitySetting;
  /**
   * Graphics wave 2 (E): perf-tier override. 'auto' resolves via
   * PerformanceManager (?tier= → spec.custom.tier → device auto-detect).
   */
  tier: PerfTierSetting;
}

const DEFAULTS: SettingsData = { volume: 0.8, muted: false, quality: 'auto', tier: 'auto' };
const QUALITIES: QualitySetting[] = ['auto', 'retro', 'standard', 'high'];
const TIERS: PerfTierSetting[] = ['auto', 'desktop', 's25'];

export class Settings {
  data: SettingsData;

  constructor() {
    // save-slots: read the ACTIVE slot's settings (migration handled inside).
    this.data = { ...DEFAULTS, ...loadSlotSettings() };
    this.data.volume = Settings.clampVol(this.data.volume);
    if (!QUALITIES.includes(this.data.quality)) this.data.quality = 'auto';
    if (!TIERS.includes(this.data.tier)) this.data.tier = 'auto';
  }

  private static clampVol(v: unknown): number {
    const n = typeof v === 'number' && isFinite(v) ? v : DEFAULTS.volume;
    return Math.max(0, Math.min(1, n));
  }

  /** Merge a patch and persist into the active slot. Volume is clamped to 0..1. */
  set(patch: Partial<SettingsData>): void {
    Object.assign(this.data, patch);
    this.data.volume = Settings.clampVol(this.data.volume);
    if (patch.quality !== undefined && !QUALITIES.includes(patch.quality)) {
      this.data.quality = 'auto';
    }
    if (patch.tier !== undefined && !TIERS.includes(patch.tier)) {
      this.data.tier = 'auto';
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
    this.data.quality = QUALITIES.includes(fresh.quality) ? fresh.quality : 'auto';
    this.data.tier = TIERS.includes(fresh.tier) ? fresh.tier : 'auto';
  }
}
