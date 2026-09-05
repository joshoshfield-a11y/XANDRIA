/**
 * Procedural audio: no asset files. SFX are synthesized per call; music is a generative
 * step-sequencer driven by spec.audio (mood/tempo/key/mode). Resumes on first user gesture.
 */
import type { GameSpec } from '@spec';
import { Rng } from './Rng';

export type Sfx =
  | 'jump' | 'land' | 'hit' | 'hurt' | 'shoot' | 'laser' | 'explosion' | 'pickup' | 'coin' | 'swing'
  | 'dash' | 'die' | 'win' | 'lose' | 'checkpoint' | 'engine' | 'boost' | 'click' | 'powerup' | 'alarm' | 'step';

const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private comp!: DynamicsCompressorNode;
  private spec: GameSpec['audio'];
  private musicTimer: number | null = null;
  private step = 0;
  private rng: Rng;
  private started = false;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  muted = false;
  private intensity = 0.5;

  constructor(spec: GameSpec) {
    this.spec = spec.audio;
    this.rng = new Rng(spec.meta.seed ^ 0xa0d10);
  }

  /** Must be called from a user gesture (click/keydown). Safe to call repeatedly. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const c = this.ctx!;
    this.master = c.createGain();
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -12; this.comp.ratio.value = 4;
    this.sfxBus = c.createGain(); this.sfxBus.gain.value = this.spec.sfxVolume;
    this.musicBus = c.createGain(); this.musicBus.gain.value = this.spec.musicVolume * 0.6;
    this.sfxBus.connect(this.comp); this.musicBus.connect(this.comp);
    this.comp.connect(this.master); this.master.connect(c.destination);
    this.master.gain.value = this.muted ? 0 : 1;
    if (this.spec.music && !this.started) this.startMusic();
    this.started = true;
  }

  setMuted(m: boolean) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 1; }
  /** 0..1 — how intense the music should be (combat raises it). */
  setIntensity(v: number) { this.intensity = Math.max(0, Math.min(1, v)); }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, bus: GainNode, opts: { slide?: number; attack?: number; decay?: number; detune?: number; filter?: number; when?: number } = {}) {
    const c = this.ctx; if (!c) return;
    const t0 = opts.when ?? c.currentTime;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.slide), t0 + dur);
    if (opts.detune) o.detune.value = opts.detune;
    const g = c.createGain();
    const a = opts.attack ?? 0.005;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node: AudioNode = o;
    if (opts.filter) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = opts.filter; o.connect(f); node = f; }
    node.connect(g); g.connect(bus);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  private noise(dur: number, vol: number, bus: GainNode, filterFreq = 1200, when?: number, type: BiquadFilterType = 'lowpass') {
    const c = this.ctx; if (!c) return;
    const t0 = when ?? c.currentTime;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const s = c.createBufferSource(); s.buffer = buf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = filterFreq;
    const g = c.createGain(); g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f); f.connect(g); g.connect(bus); s.start(t0);
  }

  play(name: Sfx, opts: { pitch?: number; vol?: number } = {}) {
    if (!this.ctx) return;
    const p = opts.pitch ?? 1, v = (opts.vol ?? 1) * 0.5, b = this.sfxBus;
    switch (name) {
      case 'jump': this.tone(300 * p, 0.25, 'square', 0.25 * v, b, { slide: 2.2 }); break;
      case 'land': this.noise(0.12, 0.4 * v, b, 600); this.tone(120, 0.1, 'sine', 0.3 * v, b, { slide: 0.5 }); break;
      case 'step': this.noise(0.06, 0.12 * v, b, 900); break;
      case 'hit': this.noise(0.15, 0.5 * v, b, 2500); this.tone(180 * p, 0.12, 'square', 0.3 * v, b, { slide: 0.4 }); break;
      case 'hurt': this.tone(220 * p, 0.3, 'sawtooth', 0.35 * v, b, { slide: 0.5, filter: 1500 }); this.noise(0.2, 0.3 * v, b, 1000); break;
      case 'swing': this.noise(0.18, 0.25 * v, b, 3000, undefined, 'bandpass'); break;
      case 'shoot': this.tone(700 * p, 0.12, 'square', 0.3 * v, b, { slide: 0.3 }); this.noise(0.08, 0.35 * v, b, 4000); break;
      case 'laser': this.tone(1200 * p, 0.18, 'sawtooth', 0.25 * v, b, { slide: 0.25 }); break;
      case 'explosion': this.noise(0.7, 0.9 * v, b, 500); this.tone(70, 0.6, 'sine', 0.6 * v, b, { slide: 0.4 }); break;
      case 'pickup': this.tone(880 * p, 0.1, 'sine', 0.3 * v, b); this.tone(1320 * p, 0.15, 'sine', 0.3 * v, b, { when: this.ctx.currentTime + 0.08 }); break;
      case 'coin': this.tone(1568 * p, 0.08, 'square', 0.18 * v, b); this.tone(2093 * p, 0.2, 'square', 0.18 * v, b, { when: this.ctx.currentTime + 0.07 }); break;
      case 'powerup': for (let i = 0; i < 5; i++) this.tone(440 * Math.pow(1.25, i) * p, 0.12, 'triangle', 0.25 * v, b, { when: this.ctx.currentTime + i * 0.06 }); break;
      case 'dash': this.noise(0.25, 0.35 * v, b, 2000, undefined, 'highpass'); this.tone(200, 0.2, 'sine', 0.2 * v, b, { slide: 3 }); break;
      case 'die': this.tone(400, 0.9, 'sawtooth', 0.4 * v, b, { slide: 0.15, filter: 1200 }); this.noise(0.5, 0.4 * v, b, 800); break;
      case 'checkpoint': [0, 4, 7, 12].forEach((s, i) => this.tone(523 * Math.pow(2, s / 12), 0.2, 'triangle', 0.25 * v, b, { when: this.ctx!.currentTime + i * 0.07 })); break;
      case 'win': [0, 4, 7, 12, 7, 12, 16].forEach((s, i) => this.tone(440 * Math.pow(2, s / 12), 0.35, 'triangle', 0.3 * v, b, { when: this.ctx!.currentTime + i * 0.13 })); break;
      case 'lose': [12, 7, 3, 0].forEach((s, i) => this.tone(330 * Math.pow(2, s / 12), 0.5, 'sawtooth', 0.25 * v, b, { when: this.ctx!.currentTime + i * 0.25, filter: 900 })); break;
      case 'boost': this.tone(150, 0.5, 'sawtooth', 0.3 * v, b, { slide: 4, filter: 2500 }); this.noise(0.4, 0.3 * v, b, 3000, undefined, 'highpass'); break;
      case 'click': this.tone(1000, 0.04, 'square', 0.15 * v, b); break;
      case 'alarm': this.tone(880, 0.15, 'square', 0.2 * v, b); this.tone(660, 0.15, 'square', 0.2 * v, b, { when: this.ctx.currentTime + 0.17 }); break;
      case 'engine': break; // continuous, see setEngine
    }
  }

  /** Continuous engine drone for vehicles. rpm 0..1, throttle 0..1 */
  setEngine(rpm: number, on = true) {
    const c = this.ctx; if (!c) return;
    if (!this.engineOsc) {
      this.engineOsc = c.createOscillator(); this.engineOsc.type = 'sawtooth';
      this.engineGain = c.createGain(); this.engineGain.gain.value = 0;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
      this.engineOsc.connect(f); f.connect(this.engineGain); this.engineGain.connect(this.sfxBus);
      this.engineOsc.start();
    }
    const target = on ? 0.12 : 0;
    this.engineGain!.gain.setTargetAtTime(target, c.currentTime, 0.1);
    this.engineOsc.frequency.setTargetAtTime(40 + rpm * 160, c.currentTime, 0.05);
  }

  // ---------- generative music ----------
  private startMusic() {
    const c = this.ctx!;
    const beat = 60 / this.spec.tempo / 2; // 8th notes
    const scale = SCALES[this.spec.mode] ?? SCALES.minor;
    const root = 110 * Math.pow(2, this.spec.key / 12); // A2-based root
    const mood = this.spec.mood;
    const dark = mood === 'dark' || mood === 'tense' || mood === 'mysterious' || mood === 'aggressive';
    const chordProg = dark ? [0, 5, 3, 6] : [0, 3, 4, 5];
    // pre-generate a 32-step melody motif per seed
    const motif = Array.from({ length: 32 }, () => (this.rng.chance(0.7) ? this.rng.int(0, scale.length * 2 - 1) : -1));
    const bassPat = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 0 : this.rng.chance(0.35) ? this.rng.int(0, 2) : -1));
    let nextTime = c.currentTime + 0.1;
    const lookahead = 0.25;
    const tick = () => {
      if (!this.ctx) return;
      while (nextTime < c.currentTime + lookahead) {
        const s = this.step;
        const bar = Math.floor(s / 16) % chordProg.length;
        const chordDeg = chordProg[bar];
        const deg = (i: number) => {
          const oct = Math.floor(i / scale.length);
          return root * Math.pow(2, (scale[((i % scale.length) + scale.length) % scale.length] + 12 * oct) / 12);
        };
        const intensity = this.intensity;
        // pad chord on bar start
        if (s % 16 === 0) {
          [0, 2, 4].forEach((k) => this.tone(deg(chordDeg + k) * 2, beat * 16, dark ? 'sawtooth' : 'triangle', 0.045, this.musicBus, { attack: 0.4, filter: 900 + intensity * 900, when: nextTime, detune: k * 4 }));
        }
        // bass
        const bp = bassPat[s % 16];
        if (bp >= 0) this.tone(deg(chordDeg + bp * 2) / 2, beat * 0.9, 'square', 0.09, this.musicBus, { filter: 400, when: nextTime });
        // kick / hat via noise + sine
        if (s % 4 === 0) this.tone(55, 0.15, 'sine', 0.35 * (0.5 + intensity), this.musicBus, { slide: 0.3, when: nextTime });
        if (s % 2 === 1 && (intensity > 0.3 || mood === 'retro')) this.noise(0.04, 0.07 * intensity, this.musicBus, 7000, nextTime, 'highpass');
        if (s % 8 === 4 && intensity > 0.55) this.noise(0.18, 0.15, this.musicBus, 1800, nextTime, 'bandpass');
        // melody
        const m = motif[s % 32];
        if (m >= 0 && (intensity > 0.2 || s % 2 === 0)) {
          const lead: OscillatorType = mood === 'retro' ? 'square' : mood === 'chill' ? 'sine' : 'triangle';
          this.tone(deg(chordDeg + m) * 2, beat * 1.6, lead, 0.07 + intensity * 0.04, this.musicBus, { attack: 0.02, filter: 2500, when: nextTime });
        }
        nextTime += beat;
        this.step++;
      }
    };
    this.musicTimer = window.setInterval(tick, 80);
  }

  dispose() {
    if (this.musicTimer) clearInterval(this.musicTimer);
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
