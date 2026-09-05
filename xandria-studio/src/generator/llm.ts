/**
 * Optional LLM enrichment, in two modes:
 *
 *  - flavor:    the LLM may refine *flavor* only (name, description, palette, mood).
 *  - architect: the LLM may propose a full partial spec — theme, world, enemies,
 *               weapons, and the freeform `custom` layer (biome/forge/enemy/weapon
 *               mods, quality, asset packs). "If you can describe it, you can make it."
 *
 * In both modes the deterministic compiler's output is the floor: LLM output is
 * merged onto it, re-validated through validateSpec/normalizeSpec, and any failure
 * silently falls back (architect → flavor → deterministic).
 */
import { normalizeSpec, validateSpec, type GameSpec } from '@spec';
import { generateSpec, type GenerateOptions } from './generate';

export interface LLMConfig {
  endpoint: string;   // e.g. http://localhost:11434/v1  (Ollama), OpenRouter, etc.
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  mode?: 'flavor' | 'architect'; // default 'flavor'
}

const FLAVOR_PROMPT = (intent: string, base: GameSpec) => `You are a game flavor designer. Given a game intent and a base spec, return ONLY a JSON object with optional overrides:
{"meta":{"name":string,"description":string},"theme":{"palette":{"primary","secondary","accent","sky","horizon","ground","groundAlt","rock","fog","water" — all #rrggbb}},"audio":{"mood":"epic|dark|chill|retro|tense|mysterious|aggressive|heroic","tempo":60-180}}
Intent: "${intent}"
Base genre: ${base.meta.genre}, environment: ${base.theme.environment}.
Return JSON only, no commentary.`;

const ARCHITECT_PROMPT = (intent: string, base: GameSpec) => `You are XANDRIA's game architect. A player described a game; turn their description into a concrete game spec. Return ONLY a JSON object — a PARTIAL spec; any field you omit keeps its default.

Allowed shape (all optional):
{
 "meta":{"name":string,"description":string},
 "theme":{"environment":"forest|jungle|desert|wasteland|arctic|volcanic|city|neon-city|space-station|ruins|dreamscape|islands|arena",
          "timeOfDay":"day|night|dusk","weather":"clear|rain|storm|snow|fog|ash",
          "palette":{"primary","secondary","accent","sky","horizon","ground","groundAlt","rock","fog","water" — all #rrggbb}},
 "world":{"terrain":{"type":"flat|hills|mountains|canyon|islands|platforms","size":200-800,"maxHeight":4-80,"roughness":0-1,"water":bool,"waterLevel":-10-20},
          "boundary":"walls|cliffs|wrap"},
 "player":{"weapon":"blaster|rifle|shotgun|sword"},
 "enemies":[{"kind":"walker|brute|drone|flyer|turret","count":1-40,"health":10-500,"speed":1-20,"damage":1-50}],
 "audio":{"mood":"epic|dark|chill|retro|tense|mysterious|aggressive|heroic","tempo":60-180},
 "custom":{
   "quality":"retro|standard|high",
   "biome":{"terrainFrequency":0.3-3,"heightScale":0-2.5,"waterBias":-5-8,
            "floraMix":{"pine|oak|palm|cactus|deadtree|mushroom|crystalflora":0-10}},
   "forge":{"headStyle":"visor|horned|helmet|mohawk|hood|antenna|crest","armor":"none|pads|plate|bandolier",
            "bulk":0.7-1.9,"height":0.85-1.3,"vehicleSpoiler":"none|lip|wing|ducktail"},
   "enemyMods":{"size":0.5-2.5,"speed":0.3-3,"aggression":0-3,"glow":"#rrggbb"},
   "weaponMods":{"projectileSpeed":5-200,"rateOfFire":0.5-20,"spread":0-0.5,"pellets":1-12,"beamColor":"#rrggbb"}
 }
}

Match the player's imagination: if they say "giant glowing bugs", use enemyMods.size≈2 + glow; if "moonscape", use theme+palette+world to fake it. Do NOT invent fields outside this shape. Numbers must be numbers, colors #rrggbb.
Intent: "${intent}"
Base genre: ${base.meta.genre}, environment: ${base.theme.environment}.
Return JSON only, no commentary.`;

async function callLLM(cfg: LLMConfig, prompt: string): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 12000);
  try {
    const res = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: 'You output strictly valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? '';
    const jsonStart = text.indexOf('{');
    if (jsonStart < 0) return null;
    return JSON.parse(text.slice(jsonStart));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Deep-merge src onto dst (plain objects only); arrays and scalars replace. */
function deepMerge(dst: Record<string, unknown>, src: Record<string, unknown>) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
      deepMerge(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      dst[k] = v;
    }
  }
}

/** Flavor merge: only whitelisted flavor fields. Returns null if invalid. */
function mergeFlavor(base: GameSpec, overrides: Record<string, unknown>): GameSpec | null {
  const merged = JSON.parse(JSON.stringify(base)) as GameSpec;
  const o = overrides as { meta?: { name?: unknown; description?: unknown }; theme?: { palette?: Record<string, unknown> }; audio?: { mood?: unknown; tempo?: unknown } };
  if (typeof o.meta?.name === 'string') merged.meta.name = o.meta.name.slice(0, 60);
  if (typeof o.meta?.description === 'string') merged.meta.description = o.meta.description.slice(0, 300);
  if (o.theme?.palette) {
    for (const [k, v] of Object.entries(o.theme.palette)) {
      if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) && k in merged.theme.palette) (merged.theme.palette as unknown as Record<string, string>)[k] = v;
    }
  }
  if (o.audio) {
    if (typeof o.audio.mood === 'string') merged.audio.mood = o.audio.mood as GameSpec['audio']['mood'];
    if (typeof o.audio.tempo === 'number') merged.audio.tempo = Math.max(40, Math.min(240, o.audio.tempo));
  }
  const v = validateSpec(merged);
  return v.ok ? normalizeSpec(merged) : null;
}

/** Architect merge: deep-merge the whole partial spec, then validate. Returns null if invalid. */
function mergeArchitect(base: GameSpec, overrides: Record<string, unknown>): GameSpec | null {
  const merged = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  if (overrides.meta && typeof overrides.meta === 'object') delete (overrides.meta as Record<string, unknown>).seed; // never let the LLM change the seed
  deepMerge(merged, overrides);
  const v = validateSpec(merged);
  return v.ok ? normalizeSpec(merged as unknown as GameSpec) : null;
}

export async function generateWithLLM(intent: string, cfg: LLMConfig, opts: GenerateOptions = {}): Promise<{ spec: GameSpec; llmUsed: boolean; mode?: 'flavor' | 'architect' }> {
  const base = generateSpec(intent, opts);
  // architect mode: try full-spec authoring first, then flavor, then deterministic
  if (cfg.mode === 'architect') {
    const overrides = await callLLM(cfg, ARCHITECT_PROMPT(intent, base));
    if (overrides) {
      const spec = mergeArchitect(base, overrides);
      if (spec) return { spec, llmUsed: true, mode: 'architect' };
    }
  }
  const overrides = await callLLM(cfg, FLAVOR_PROMPT(intent, base));
  if (overrides) {
    const spec = mergeFlavor(base, overrides);
    if (spec) return { spec, llmUsed: true, mode: 'flavor' };
  }
  return { spec: base, llmUsed: false };
}
