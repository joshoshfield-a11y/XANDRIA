/**
 * Generated cover thumbnail for itch.io uploads.
 * Pure TypeScript: minimal PNG encoder + embedded 5x7 pixel font.
 * No external assets, no network — styled from the game's own palette.
 * Deterministic per spec seed.
 */
import { deflateSync } from 'node:zlib';
import type { GameSpec } from '../src/spec/schema';

// ---------------------------------------------------------------- font ---
// 5x7 pixel font, rows top→bottom, '1' = ink. Covers A-Z 0-9 + punctuation,
// plus Latin-1 accented capitals (À–Þ, composed below). CJK/other scripts → '?'.
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ',': ['00000', '00000', '00000', '00000', '00100', '00100', '01000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00100', '00100'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ':': ['00000', '00100', '00000', '00000', '00000', '00100', '00000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};

// --- Latin-1 accents (QA X4) ---
// Accented capitals compose a 2-row accent mark over the base letter's lower
// 5 rows — cheap in this bitmap format, no new rasterization needed.
// Covers À–Þ (after the title's toUpperCase()); CJK, emoji, and other scripts
// still fall back to '?' — a real multilingual font is out of scope here.
const ACCENT_TOP: Record<string, string[]> = {
  acute: ['00010', '00100'],
  grave: ['00100', '00010'],
  circumflex: ['00100', '01010'],
  tilde: ['01010', '10100'],
  diaeresis: ['01010', '00000'],
  ring: ['01110', '01010'],
};
const ACCENTED: Array<[string, string, string]> = [
  ['À', 'A', 'grave'], ['Á', 'A', 'acute'], ['Â', 'A', 'circumflex'],
  ['Ã', 'A', 'tilde'], ['Ä', 'A', 'diaeresis'], ['Å', 'A', 'ring'],
  ['È', 'E', 'grave'], ['É', 'E', 'acute'], ['Ê', 'E', 'circumflex'], ['Ë', 'E', 'diaeresis'],
  ['Ì', 'I', 'grave'], ['Í', 'I', 'acute'], ['Î', 'I', 'circumflex'], ['Ï', 'I', 'diaeresis'],
  ['Ò', 'O', 'grave'], ['Ó', 'O', 'acute'], ['Ô', 'O', 'circumflex'],
  ['Õ', 'O', 'tilde'], ['Ö', 'O', 'diaeresis'],
  ['Ù', 'U', 'grave'], ['Ú', 'U', 'acute'], ['Û', 'U', 'circumflex'], ['Ü', 'U', 'diaeresis'],
  ['Ý', 'Y', 'acute'],
  ['Ñ', 'N', 'tilde'],
];
for (const [ch, base, ac] of ACCENTED) {
  GLYPHS[ch] = [...ACCENT_TOP[ac], ...GLYPHS[base].slice(2)];
}
// Ligatures / letters that don't decompose into base + mark:
GLYPHS['Æ'] = ['01111', '10001', '10001', '11110', '10001', '10001', '01111'];
GLYPHS['Ç'] = ['01110', '10001', '10000', '10000', '10000', '10001', '00110'];
GLYPHS['Ð'] = ['11100', '10010', '10001', '11111', '10001', '10010', '11100'];
GLYPHS['Ø'] = ['01110', '10011', '10101', '11001', '10001', '10001', '01110'];
GLYPHS['Þ'] = ['10000', '11110', '10001', '10001', '10001', '11110', '10000'];

/** Glyph lookup with '?' fallback; exported for tests. */
export function glyphFor(ch: string): string[] {
  return GLYPHS[ch] ?? GLYPHS['?'];
}

type RGB = [number, number, number];

function hex(h: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim()) ?? ['0', '000000'];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
function shade(c: RGB, f: number): RGB {
  return [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)];
}

// Seeded RNG (mulberry32) so the cover is deterministic per game.
function rng32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 3);
  }
  set(x: number, y: number, c: RGB) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
  }
  rect(x0: number, y0: number, w: number, h: number, c: RGB) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }
  text(str: string, x: number, y: number, scale: number, c: RGB) {
    let cx = x;
    for (const raw of str.toUpperCase()) {
      const g = glyphFor(raw);
      for (let r = 0; r < 7; r++)
        for (let col = 0; col < 5; col++)
          if (g[r][col] === '1') this.rect(cx + col * scale, y + r * scale, scale, scale, c);
      cx += 6 * scale;
    }
  }
  textWidth(str: string, scale: number): number {
    return str.length * 6 * scale - scale;
  }
}

function toPng(c: Canvas): Uint8Array {
  const raw = new Uint8Array(c.h * (1 + c.w * 3));
  for (let y = 0; y < c.h; y++) {
    raw[y * (1 + c.w * 3)] = 0; // filter: none
    raw.set(c.px.subarray(y * c.w * 3, (y + 1) * c.w * 3), y * (1 + c.w * 3) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    return b;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const t = Buffer.from(type, 'ascii');
    const len = u32(data.length);
    let crc = 0xffffffff;
    const bytes = Buffer.concat([t, Buffer.from(data)]);
    for (let i = 0; i < bytes.length; i++)
      crc = CRC_TABLE_PNG[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const cbuf = Buffer.alloc(4);
    cbuf.writeUInt32BE(crc);
    return Buffer.concat([len, t, bytes.subarray(4), cbuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    head,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE_PNG = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const GENRE_LABEL: Record<string, string> = {
  'fps-arena': 'FPS ARENA',
  'third-person-action': 'ACTION',
  racing: 'RACING',
  platformer: 'PLATFORMER',
  'top-down-shooter': 'TOP-DOWN SHOOTER',
};

/** Wrap a title into lines that fit maxWidth at the given scale. */
function wrapTitle(title: string, maxWidth: number, scale: number, cv: Canvas): string[] {
  const words = title.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cv.textWidth(next, scale) <= maxWidth) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : ['UNTITLED'];
}

export function generateCover(spec: GameSpec, width = 630, height = 500): Uint8Array {
  const cv = new Canvas(width, height);
  const pal = spec.theme.palette;
  const top = shade(hex(pal.horizon), 0.35);
  const bottom = shade(hex(pal.ground), 0.3);
  const accent = hex(pal.accent);
  const primary = hex(pal.primary);
  const rand = rng32(spec.meta.seed >>> 0 || 1);

  // Vertical gradient
  for (let y = 0; y < height; y++) {
    const c = mix(top, bottom, y / (height - 1));
    for (let x = 0; x < width; x++) cv.set(x, y, c);
  }
  // Starfield / embers, seeded
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rand() * width);
    const y = Math.floor(rand() * height * 0.7);
    const b = 0.25 + rand() * 0.6;
    cv.rect(x, y, 2, 2, shade(mix(primary, accent, rand()), b));
  }
  // Scanlines
  for (let y = 0; y < height; y += 4)
    for (let x = 0; x < width; x++) {
      const j = (y * width + x) * 3;
      cv.px[j] = Math.round(cv.px[j] * 0.92);
      cv.px[j + 1] = Math.round(cv.px[j + 1] * 0.92);
      cv.px[j + 2] = Math.round(cv.px[j + 2] * 0.92);
    }
  // Accent frame
  const fw = 8;
  cv.rect(0, 0, width, fw, accent);
  cv.rect(0, height - fw, width, fw, accent);
  cv.rect(0, 0, fw, height, accent);
  cv.rect(width - fw, 0, fw, height, accent);

  const ink: RGB = [240, 240, 235];
  const dim: RGB = [170, 170, 165];
  const cx = width / 2;

  // Kicker: genre · environment
  const genre = GENRE_LABEL[spec.meta.genre] ?? spec.meta.genre.toUpperCase();
  const kicker = `${genre} - ${String(spec.theme.environment).toUpperCase().replace(/_/g, ' ')}`;
  const ks = 3;
  cv.text(kicker, Math.round(cx - cv.textWidth(kicker, ks) / 2), 64, ks, accent);

  // Title, auto-fit
  const title = spec.meta.name || 'UNTITLED GAME';
  let scale = 8;
  let lines = wrapTitle(title, width - 120, scale, cv);
  while ((lines.length > 2 || lines.some((l) => cv.textWidth(l, scale) > width - 120)) && scale > 3) {
    scale--;
    lines = wrapTitle(title, width - 120, scale, cv);
  }
  let ty = 150;
  for (const line of lines.slice(0, 3)) {
    cv.text(line, Math.round(cx - cv.textWidth(line, scale) / 2), ty, scale, ink);
    ty += 7 * scale + 12;
  }
  // Accent rule under title
  cv.rect(Math.round(cx - 90), ty + 4, 180, 5, accent);

  // Quest chapters (if any) as diamonds
  const stages = spec.objective.stages;
  if (Array.isArray(stages) && stages.length > 1) {
    const label = `${stages.length} CHAPTERS - XP - UPGRADES - BOSSES`;
    const ls = 2;
    cv.text(label, Math.round(cx - cv.textWidth(label, ls) / 2), ty + 28, ls, dim);
  }

  // Footer
  const foot = 'A XANDRIA-GENERATED GAME - PLAYABLE OFFLINE';
  const fs = 2;
  cv.text(foot, Math.round(cx - cv.textWidth(foot, fs) / 2), height - 48, fs, dim);

  return toPng(cv);
}
