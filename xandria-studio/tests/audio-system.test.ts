/**
 * UPGRADE LOOP (audio-system): synthesized ambient music + SFX.
 *
 * - biomeMusicPattern is pure: same (biome, seed) -> identical pattern,
 *   verified against an INDEPENDENT reimplementation (mulberry32 + FNV-1a
 *   + the documented draw order) so the test does not just re-call the code.
 * - AudioEngine bus math is verified against a stub AudioContext that
 *   counts created nodes (perf evidence: no per-frame allocation — the
 *   engine drone reuses its nodes, the scheduler ticks every 80ms, and
 *   play() allocates only on the event itself).
 * - audioWiring taps are verified on fake hooks, including the deliberate
 *   onPickup exclusion (blueprints already sound Pickups.onCollect).
 * - Settings/Profile persistence covers the new per-bus fields, including
 *   migration of old slot stores that lack them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { biomeMusicPattern, AUDIO_SALT, BIOME_MODES, SCALE_LENGTHS, CHORD_PROGS } from '../src/engine/game/biomeMusic';
import { AudioEngine } from '../src/engine/core/Audio';
import { wireAudioHooks, audioWiringTaps } from '../src/engine/game/audioWiring';
import { Settings } from '../src/engine/game/Settings';
import {
  _setProfileStorage, loadSlotSettings, saveSlotSettings, SLOTS_KEY,
} from '../src/engine/game/Profile';

// ---------------------------------------------------------------------------
// independent replication of biomeMusicPattern (mulberry32 + FNV-1a)
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function replicatePattern(biomeId: string, mapSeed: number) {
  const id = (['plains', 'desert-canyon', 'forest', 'snow', 'volcanic', 'coastline', 'caves'] as const).includes(biomeId as never)
    ? biomeId : 'plains';
  const next = mulberry32((mapSeed ^ AUDIO_SALT ^ fnv1a(id)) >>> 0);
  const range = (min: number, max: number) => min + (max - min) * next();
  const int = (min: number, max: number) => Math.floor(range(min, max + 1));
  const chance = (p: number) => next() < p;
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)];
  const mode = pick(BIOME_MODES[id as keyof typeof BIOME_MODES]);
  const key = int(0, 11);
  const tempo = int(70, 140);
  const chordProg = [...pick(CHORD_PROGS)];
  const scaleLen = SCALE_LENGTHS[mode] ?? 7;
  const motif = Array.from({ length: 32 }, () => (chance(0.7) ? int(0, scaleLen * 2 - 1) : -1));
  const bassPat = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 0 : chance(0.35) ? int(0, 2) : -1));
  return { biomeId: id, mapSeed: mapSeed >>> 0, mode, key, tempo, chordProg, motif, bassPat };
}

describe('biomeMusicPattern', () => {
  it('is deterministic: same inputs -> identical pattern', () => {
    expect(biomeMusicPattern('forest', 987654)).toEqual(biomeMusicPattern('forest', 987654));
    expect(biomeMusicPattern('volcanic', 42)).toEqual(biomeMusicPattern('volcanic', 42));
  });

  it('matches an independent replication of the algorithm', () => {
    for (const [biome, seed] of [['forest', 987654], ['volcanic', 42], ['coastline', 1], ['snow', 0]] as const) {
      expect(biomeMusicPattern(biome, seed)).toEqual(replicatePattern(biome, seed));
    }
  });

  it('stays in range and falls back for unknown biomes', () => {
    const p = biomeMusicPattern('forest', 7);
    expect(p.key).toBeGreaterThanOrEqual(0); expect(p.key).toBeLessThanOrEqual(11);
    expect(p.tempo).toBeGreaterThanOrEqual(70); expect(p.tempo).toBeLessThanOrEqual(140);
    expect(p.motif).toHaveLength(32); expect(p.bassPat).toHaveLength(16);
    for (const m of p.motif) expect(m === -1 || (m >= 0 && m < 14)).toBe(true);
    expect(biomeMusicPattern('not-a-biome', 7).biomeId).toBe('plains');
    expect(biomeMusicPattern('forest', 7)).not.toEqual(biomeMusicPattern('forest', 8));
  });
});

// ---------------------------------------------------------------------------
// stub AudioContext
// ---------------------------------------------------------------------------

class FakeParam {
  value = 0;
  lastTarget: number | null = null;
  setValueAtTime(v: number) { this.value = v; }
  linearRampToValueAtTime(v: number) { this.value = v; }
  exponentialRampToValueAtTime(v: number) { this.value = v; }
  setTargetAtTime(v: number) { this.lastTarget = v; this.value = v; }
}
class FakeNode {
  connect() { return this; }
}
class FakeOsc extends FakeNode {
  frequency = new FakeParam();
  detune = new FakeParam();
  type: OscillatorType = 'sine';
  start() {} stop() {}
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeFilter extends FakeNode {
  frequency = new FakeParam();
  type: BiquadFilterType = 'lowpass';
}
class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  start() {}
}
class FakeCtx {
  static instances: FakeCtx[] = [];
  sampleRate = 44100;
  currentTime = 0;
  state: AudioContextState = 'running';
  destination = new FakeNode();
  oscillators = 0;
  gains = 0;
  buffers = 0;
  constructor() { FakeCtx.instances.push(this); }
  createOscillator() { this.oscillators++; return new FakeOsc(); }
  createDynamicsCompressor() {
    const node = new FakeGain() as FakeGain & { threshold: FakeParam; ratio: FakeParam };
    node.threshold = new FakeParam(); node.ratio = new FakeParam();
    return node;
  }
  createGain() { this.gains++; return new FakeGain(); }
  createBiquadFilter() { return new FakeFilter(); }
  createBuffer(_ch: number, len: number, _sr: number) {
    this.buffers++;
    return { getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() { return new FakeBufferSource(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

function specAudio(over: Record<string, unknown> = {}) {
  return {
    meta: { seed: 123456 },
    audio: {
      music: true, mood: 'epic', tempo: 110, key: 0, mode: 'minor',
      sfxVolume: 0.9, musicVolume: 0.7, ...over,
    },
  } as never;
}

describe('AudioEngine buses + SFX', () => {
  let engines: AudioEngine[] = [];
  beforeEach(() => {
    FakeCtx.instances = [];
    engines = [];
    (globalThis as any).window = {
      AudioContext: FakeCtx,
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (id: unknown) => clearInterval(id as never),
    };
  });
  afterEach(() => {
    for (const e of engines) e.dispose();
    delete (globalThis as any).window;
  });

  function unlocked(over: Record<string, unknown> = {}): AudioEngine {
    const e = new AudioEngine(specAudio(over));
    engines.push(e);
    e.unlock();
    return e;
  }
  const bus = (e: AudioEngine, name: 'sfxBus' | 'musicBus' | 'master') =>
    (e as unknown as Record<string, FakeGain>)[name].gain.value;

  it('applies master volume + mute without touching bus ratios', () => {
    const e = unlocked();
    // sfx: spec 0.9 * user 0.8; music: spec 0.7 * 0.6 * user 0.8
    expect(bus(e, 'sfxBus')).toBeCloseTo(0.72, 6);
    expect(bus(e, 'musicBus')).toBeCloseTo(0.336, 6);
    e.setMuted(true);
    expect(bus(e, 'master')).toBe(0);
    expect(bus(e, 'sfxBus')).toBeCloseTo(0.72, 6);
    e.setMuted(false);
    expect(bus(e, 'master')).toBeCloseTo(0.8, 6);
  });

  it('music/sfx toggles silence only their own bus; volumes multiply', () => {
    const e = unlocked();
    e.setMusicEnabled(false);
    expect(bus(e, 'musicBus')).toBe(0);
    expect(bus(e, 'sfxBus')).toBeCloseTo(0.72, 6);
    e.setMusicEnabled(true);
    e.setSfxEnabled(false);
    expect(bus(e, 'sfxBus')).toBe(0);
    expect(bus(e, 'musicBus')).toBeCloseTo(0.336, 6);
    e.setSfxEnabled(true);
    e.setSfxVolume(0.5);
    expect(bus(e, 'sfxBus')).toBeCloseTo(0.45, 6);
    e.setMusicVolume(0.5);
    expect(bus(e, 'musicBus')).toBeCloseTo(0.21, 6);
    e.setMusicVolume(5); // clamped
    expect(bus(e, 'musicBus')).toBeCloseTo(0.42, 6);
  });

  it('pre-unlock bus settings are honored at unlock', () => {
    const e = new AudioEngine(specAudio());
    engines.push(e);
    e.setMusicEnabled(false);
    e.setSfxVolume(0.25);
    e.unlock();
    expect(bus(e, 'musicBus')).toBe(0);
    expect(bus(e, 'sfxBus')).toBeCloseTo(0.225, 6);
  });

  it('new SFX (craft/quest/portal) synthesize nodes; play() without a context is a no-op', () => {
    const e = unlocked();
    const ctx = FakeCtx.instances[0];
    const before = ctx.oscillators;
    e.play('craft'); e.play('quest'); e.play('portal');
    expect(ctx.oscillators).toBeGreaterThan(before);
    const silent = new AudioEngine(specAudio());
    engines.push(silent);
    expect(() => silent.play('kill')).not.toThrow();
    expect(FakeCtx.instances).toHaveLength(1);
  });

  it('setBiome swaps the pattern; same seed reproduces it', () => {
    const e = unlocked();
    const p = biomeMusicPattern('forest', 4242);
    e.setBiome(p);
    expect(e.currentBiomePattern()).toEqual(p);
    e.setBiome(biomeMusicPattern('forest', 4242));
    expect(e.currentBiomePattern()).toEqual(p);
    expect(e.currentBiomePattern()).not.toEqual(biomeMusicPattern('forest', 4243));
  });

  it('perf: the engine drone allocates its nodes once and reuses them', () => {
    const e = unlocked();
    const ctx = FakeCtx.instances[0];
    e.setEngine(0.5, true);
    const oscCount = ctx.oscillators;
    e.setEngine(0.9, true);
    e.setEngine(0.2, true);
    expect(ctx.oscillators).toBe(oscCount);
    e.setEngine(0, false);
    const gain = (e as unknown as { engineGain: FakeGain }).engineGain;
    expect(gain.gain.lastTarget).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// audio wiring
// ---------------------------------------------------------------------------

describe('audioWiring', () => {
  it('taps kill/level-up/craft/portal/quest, never onPickup, and never double-taps', () => {
    const taps = new Map<string, Array<() => void>>();
    const played: string[] = [];
    const fake = {
      hooks: { tap: (name: string, fn: () => void) => {
        const list = taps.get(name) ?? [];
        list.push(fn); taps.set(name, list);
      } },
      audio: { play: (name: string) => { played.push(name); } },
    };
    wireAudioHooks(fake as never);
    wireAudioHooks(fake as never); // idempotent
    const emit = (name: string) => { for (const fn of taps.get(name) ?? []) fn(); };
    emit('onKill'); emit('onLevelUp'); emit('onCraftComplete');
    emit('onPortalArrive'); emit('onQuestTurnIn');
    expect(played).toEqual(['kill', 'levelup', 'craft', 'portal', 'quest']);
    for (const [name, list] of taps) expect(list).toHaveLength(1);
    expect(audioWiringTaps().map(([h]) => h)).not.toContain('onPickup');
    expect(taps.has('onPickup')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// settings persistence
// ---------------------------------------------------------------------------

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    _map: m,
  };
}

describe('audio settings persistence', () => {
  afterEach(() => { _setProfileStorage(undefined); });

  it('music/sfx fields round-trip through the active slot', () => {
    _setProfileStorage(memoryStorage());
    const s = new Settings();
    expect(s.data.musicEnabled).toBe(true);
    expect(s.data.sfxEnabled).toBe(true);
    s.set({ musicEnabled: false, musicVolume: 0.25, sfxEnabled: false, sfxVolume: 0.5 });
    const reloaded = new Settings();
    expect(reloaded.data.musicEnabled).toBe(false);
    expect(reloaded.data.musicVolume).toBe(0.25);
    expect(reloaded.data.sfxEnabled).toBe(false);
    expect(reloaded.data.sfxVolume).toBe(0.5);
    reloaded.reload();
    expect(reloaded.data.musicEnabled).toBe(false);
  });

  it('Settings clamps bus volumes', () => {
    _setProfileStorage(memoryStorage());
    const s = new Settings();
    s.set({ musicVolume: 5, sfxVolume: -2 });
    expect(s.data.musicVolume).toBe(1);
    expect(s.data.sfxVolume).toBe(0);
  });

  it('old slot stores without bus fields migrate to defaults; garbage clamps', () => {
    const store = memoryStorage();
    _setProfileStorage(store);
    // legacy-shaped slot store: settings lack the audio-system fields.
    store._map.set(SLOTS_KEY, JSON.stringify({
      version: 1, activeSlotId: 'slot-1', nextSeq: 2,
      slots: [{
        id: 'slot-1', name: 'Slot 1',
        profile: { version: 1 },
        settings: { volume: 0.5, muted: false, quality: 'auto', tier: 'auto' },
        createdAt: 0, updatedAt: 0,
      }],
    }));
    const migrated = loadSlotSettings();
    expect(migrated.musicEnabled).toBe(true);
    expect(migrated.sfxEnabled).toBe(true);
    expect(migrated.musicVolume).toBe(0.8);
    expect(migrated.sfxVolume).toBe(0.8);
    // garbage bus volume clamps instead of corrupting the slot.
    saveSlotSettings({ ...migrated, musicVolume: 9 as never });
    expect(loadSlotSettings().musicVolume).toBe(1);
  });
});
