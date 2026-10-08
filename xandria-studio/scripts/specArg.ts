/**
 * --spec argument parsing for scripts/export.ts.
 *
 * Lives in its own module (instead of inline in the CLI) so the error paths
 * are unit-testable — importing export.ts would run the CLI. Every failure
 * throws a plain Error whose message is already human-readable; the caller
 * prints it and exits non-zero, with no stack trace (R3-N3).
 */
import { normalizeSpec, validateSpec } from '../src/spec/schema';
import type { GameSpec } from '../src/spec/schema';

/**
 * Parse, validate, and normalize a --spec JSON string.
 * Valid specs pass through; fixable ones are repaired via normalizeSpec.
 * Throws an Error with a readable message for malformed JSON or specs
 * that fail validation and cannot be repaired.
 */
export function resolveSpecArg(specJson: string): GameSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(specJson);
  } catch (e) {
    throw new Error(`not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const v = validateSpec(raw);
  if (v.ok) return raw as GameSpec;
  try {
    return normalizeSpec(raw);
  } catch (e) {
    // normalizeSpec throws 'Invalid GameSpec:' followed by the error list
    // with literal backslash-n separators — render it as a readable list.
    const detail = (e instanceof Error ? e.message : String(e))
      .replace(/^Invalid GameSpec:\s*/, '')
      .replace(/\\n/g, '\n')
      .trim();
    throw new Error(`failed validation and could not be repaired:\n${detail || v.errors.slice(0, 8).join('\n')}`);
  }
}
