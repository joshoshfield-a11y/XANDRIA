/**
 * Spec Inspector — pure core for the v1 edit loop.
 *
 * No DOM, no engine, no schema-field assumptions. The GameSpec schema may
 * evolve; this module treats a spec structurally (deep key lookup) so it
 * works against any spec shape that contains editable fields anywhere in
 * the tree. The studio UI wires these functions to controls; the runtime
 * receives the patched spec and reloads the preview iframe.
 *
 * Rules:
 *  - Patches never mutate the input spec.
 *  - Values are clamped here so the UI can never emit an engine-unsafe spec.
 *  - Unknown keys are ignored silently (forward-compatible).
 *  - Seed locking is UI state, not spec state: when locked, callers must not
 *    pass `seed` in a patch; applyPatch enforces this if `lockedKeys` is set.
 */

export type Scalar = number | string | boolean;

export interface FieldDef {
  key: string;             // leaf key name to search for, e.g. "seed"
  label: string;
  kind: 'int' | 'range' | 'select' | 'color';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export const INSPECTOR_FIELDS: FieldDef[] = [
  { key: 'seed',        label: 'Seed',          kind: 'int',    min: 1, max: 999999, step: 1 },
  { key: 'difficulty',  label: 'Difficulty',    kind: 'select', options: ['easy', 'normal', 'hard'] },
  { key: 'enemyCount',  label: 'Enemy count',   kind: 'range',  min: 0, max: 40, step: 1 },
  { key: 'timeOfDay',   label: 'Time of day',   kind: 'range',  min: 0, max: 1,  step: 0.01 },
  { key: 'fogDensity',  label: 'Fog density',   kind: 'range',  min: 0, max: 1,  step: 0.01 },
  { key: 'primary',     label: 'Primary color', kind: 'color' },
  { key: 'accent',      label: 'Accent color',  kind: 'color' },
];

export interface FieldValue {
  def: FieldDef;
  path: string[];          // location of the leaf inside the spec
  value: Scalar;
}

export interface PatchResult {
  spec: Record<string, unknown>;
  changed: string[];       // dot-paths actually written
  rejected: string[];      // keys rejected (locked, unknown, or absent from spec)
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Depth-first search for the first occurrence of a leaf key. */
export function findPath(root: Record<string, unknown>, key: string): string[] | null {
  const stack: Array<{ node: Record<string, unknown>; path: string[] }> = [{ node: root, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    for (const k of Object.keys(node)) {
      if (k === key) return [...path, k];
      const child = node[k];
      if (isPlainObject(child)) stack.push({ node: child, path: [...path, k] });
    }
  }
  return null;
}

function getAt(root: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setAt(root: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (!isPlainObject(next)) return;
    cur = next;
  }
  cur[path[path.length - 1]] = value;
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T;
}

function clamp(def: FieldDef, value: Scalar): Scalar | null {
  switch (def.kind) {
    case 'int':
    case 'range': {
      const n = typeof value === 'string' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return null;
      let v = n;
      if (def.min !== undefined) v = Math.max(def.min, v);
      if (def.max !== undefined) v = Math.min(def.max, v);
      if (def.kind === 'int') v = Math.round(v);
      return v;
    }
    case 'select':
      return typeof value === 'string' && def.options?.includes(value) ? value : null;
    case 'color':
      return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : null;
  }
}

/** Read every declared field that actually exists in this spec. */
export function readFields(spec: Record<string, unknown>): FieldValue[] {
  const out: FieldValue[] = [];
  for (const def of INSPECTOR_FIELDS) {
    const path = findPath(spec, def.key);
    if (!path) continue;
    const value = getAt(spec, path);
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      out.push({ def, path, value });
    }
  }
  return out;
}

/**
 * Apply a partial patch. Only declared fields are considered; a field is
 * written only if it already exists in the spec (we never invent structure
 * the schema didn't define). `lockedKeys` refuse changes (seed lock).
 */
export function applyPatch(
  spec: Record<string, unknown>,
  patch: Record<string, Scalar>,
  lockedKeys: string[] = [],
): PatchResult {
  const next = clone(spec);
  const changed: string[] = [];
  const rejected: string[] = [];

  for (const [key, raw] of Object.entries(patch)) {
    const def = INSPECTOR_FIELDS.find((f) => f.key === key);
    if (!def || lockedKeys.includes(key)) { rejected.push(key); continue; }
    const path = findPath(next, key);
    if (!path) { rejected.push(key); continue; }
    const value = clamp(def, raw);
    if (value === null) { rejected.push(key); continue; }
    setAt(next, path, value);
    changed.push(path.join('.'));
  }

  return { spec: next, changed, rejected };
}

/** Human-readable one-liner for the preview header. */
export function describeSpec(spec: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const { def, value } of readFields(spec)) parts.push(`${def.label}: ${String(value)}`);
  return parts.length > 0 ? parts.join(' · ') : 'No editable fields found in spec';
}
