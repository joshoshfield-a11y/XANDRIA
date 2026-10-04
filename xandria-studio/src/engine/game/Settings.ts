/**
 * Player settings: master volume, mute, render quality. Persisted to
 * localStorage so they survive restarts; the pause menu edits them live.
 * Storage access is guarded — headless/test environments get clean defaults.
 */
export type QualitySetting = 'auto' | 'retro' | 'standard' | 'high';

export interface SettingsData {
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** 'auto' follows the spec's quality hint */
  quality: QualitySetting;
}

const KEY = 'xandria.settings.v1';

const DEFAULTS: SettingsData = { volume: 0.8, muted: false, quality: 'auto' };
const QUALITIES: QualitySetting[] = ['auto', 'retro', 'standard', 'high'];

export class Settings {
  data: SettingsData;

  constructor() {
    this.data = { ...DEFAULTS, ...Settings.read() };
    this.data.volume = Settings.clampVol(this.data.volume);
    if (!QUALITIES.includes(this.data.quality)) this.data.quality = 'auto';
  }

  private static clampVol(v: unknown): number {
    const n = typeof v === 'number' && isFinite(v) ? v : DEFAULTS.volume;
    return Math.max(0, Math.min(1, n));
  }

  private static read(): Partial<SettingsData> {
    try {
      if (typeof localStorage === 'undefined') return {};
      const raw = localStorage.getItem(KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Partial<SettingsData>) : {};
    } catch {
      return {};
    }
  }

  /** Merge a patch and persist. Volume is clamped to 0..1. */
  set(patch: Partial<SettingsData>): void {
    Object.assign(this.data, patch);
    this.data.volume = Settings.clampVol(this.data.volume);
    if (patch.quality !== undefined && !QUALITIES.includes(patch.quality)) {
      this.data.quality = 'auto';
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable — settings still apply for this session */
    }
  }

  /** Re-read from storage (picks up changes made elsewhere). */
  reload(): void {
    const fresh = Settings.read();
    if (fresh.volume !== undefined) this.data.volume = Settings.clampVol(fresh.volume);
    if (fresh.muted !== undefined) this.data.muted = !!fresh.muted;
    if (fresh.quality !== undefined && QUALITIES.includes(fresh.quality)) this.data.quality = fresh.quality;
  }
}
