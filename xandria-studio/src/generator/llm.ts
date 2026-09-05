/**
 * Optional LLM enrichment: an OpenAI-compatible endpoint may refine the *flavor*
 * of a spec (name, description, palette, mood) — never structure. The deterministic
 * compiler's output is the floor; LLM output is merged and re-validated, and any
 * failure silently falls back to the deterministic spec.
 */
import { normalizeSpec, validateSpec, type GameSpec } from '@spec';
import { generateSpec, type GenerateOptions } from './generate';

export interface LLMConfig {
  endpoint: string;   // e.g. http://localhost:11434/v1  (Ollama), OpenRouter, etc.
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

const FLAVOR_PROMPT = (intent: string, base: GameSpec) => `You are a game flavor designer. Given a game intent and a base spec, return ONLY a JSON object with optional overrides:
{"meta":{"name":string,"description":string},"theme":{"palette":{"primary","secondary","accent","sky","horizon","ground","groundAlt","rock","fog","water" — all #rrggbb}},"audio":{"mood":"epic|dark|chill|retro|tense|mysterious|aggressive|heroic","tempo":60-180}}
Intent: "${intent}"
Base genre: ${base.meta.genre}, environment: ${base.theme.environment}.
Return JSON only, no commentary.`;

export async function generateWithLLM(intent: string, cfg: LLMConfig, opts: GenerateOptions = {}): Promise<{ spec: GameSpec; llmUsed: boolean }> {
  const base = generateSpec(intent, opts);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 12000);
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
          { role: 'user', content: FLAVOR_PROMPT(intent, base) },
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return { spec: base, llmUsed: false };
    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? '';
    const jsonStart = text.indexOf('{');
    if (jsonStart < 0) return { spec: base, llmUsed: false };
    const overrides = JSON.parse(text.slice(jsonStart));
    // merge flavor onto the deterministic base and re-validate
    const merged = JSON.parse(JSON.stringify(base));
    if (overrides.meta?.name && typeof overrides.meta.name === 'string') merged.meta.name = overrides.meta.name.slice(0, 60);
    if (overrides.meta?.description && typeof overrides.meta.description === 'string') merged.meta.description = overrides.meta.description.slice(0, 300);
    if (overrides.theme?.palette) {
      for (const [k, v] of Object.entries(overrides.theme.palette)) {
        if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) && k in merged.theme.palette) merged.theme.palette[k] = v;
      }
    }
    if (overrides.audio) {
      if (typeof overrides.audio.mood === 'string') merged.audio.mood = overrides.audio.mood;
      if (typeof overrides.audio.tempo === 'number') merged.audio.tempo = Math.max(40, Math.min(240, overrides.audio.tempo));
    }
    const v = validateSpec(merged);
    if (!v.ok) return { spec: base, llmUsed: false };
    return { spec: normalizeSpec(merged), llmUsed: true };
  } catch {
    return { spec: base, llmUsed: false };
  }
}
