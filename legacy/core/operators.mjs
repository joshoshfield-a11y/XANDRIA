import fs from 'fs';
import path from 'path';

const OPERATORS = [
  { id: 1, name: 'Void' }, { id: 2, name: 'Spark' }, { id: 3, name: 'Intent' },
  { id: 4, name: 'Seed' }, { id: 5, name: 'Root' }, { id: 6, name: 'Stem' },
  { id: 7, name: 'Leaf' }, { id: 8, name: 'Bloom' }, { id: 9, name: 'Wither' },
  { id: 10, name: 'Structure' }, { id: 11, name: 'Link' }, { id: 12, name: 'Weave' },
  { id: 13, name: 'Knot' }, { id: 14, name: 'Thread' }, { id: 15, name: 'Patch' },
  { id: 16, name: 'Stitch' }, { id: 17, name: 'Pattern' }, { id: 18, name: 'Texture' },
  { id: 19, name: 'Dye' }, { id: 20, name: 'Cut' }, { id: 21, name: 'Vector' },
  { id: 22, name: 'Matrix' }, { id: 23, name: 'Scalar' }, { id: 24, name: 'Tensor' },
  { id: 25, name: 'Flux' }, { id: 26, name: 'Delta' }, { id: 27, name: 'Sigma' },
  { id: 28, name: 'Pi' }, { id: 29, name: 'Alpha' }, { id: 30, name: 'Omega' },
  { id: 31, name: 'View' }, { id: 32, name: 'Click' }, { id: 33, name: 'Touch' },
  { id: 34, name: 'Key' }, { id: 35, name: 'Scroll' }, { id: 36, name: 'Focus' },
  { id: 37, name: 'Blur' }, { id: 38, name: 'Hover' }, { id: 39, name: 'Drag' },
  { id: 40, name: 'Interface' }, { id: 41, name: 'Signal' }, { id: 42, name: 'Echo' },
  { id: 43, name: 'Pulse' }, { id: 44, name: 'Wave' }, { id: 45, name: 'Sync' },
  { id: 46, name: 'Push' }, { id: 47, name: 'Pull' }, { id: 48, name: 'Bind' },
  { id: 49, name: 'Route' }, { id: 50, name: 'Gate' }, { id: 51, name: 'Lock' },
  { id: 52, name: 'Key' }, { id: 53, name: 'Wall' }, { id: 54, name: 'Pass' },
  { id: 55, name: 'Mask' }, { id: 56, name: 'Trace' }, { id: 57, name: 'Audit' },
  { id: 58, name: 'Purge' }, { id: 59, name: 'Shield' }, { id: 60, name: 'Vault' },
  { id: 61, name: 'Measure' }, { id: 62, name: 'Reflect' }, { id: 63, name: 'Heal' },
  { id: 64, name: 'Optimize' }, { id: 65, name: 'Cache' }, { id: 66, name: 'Deploy' },
  { id: 67, name: 'Archive' }, { id: 68, name: 'Cycle' }, { id: 69, name: 'Awaken' },
  { id: 70, name: 'Ascend' }, { id: 71, name: 'Eternal' }, { id: 72, name: 'Seal' },
];

export function applyOperators(text, context = {}) {
  const hits = new Set();

  for (const m of text.matchAll(/OP-(\d+)/gi)) {
    hits.add(parseInt(m[1], 10));
  }

  for (const op of OPERATORS) {
    if (new RegExp(`\b${op.name}\b`, 'i').test(text)) {
      hits.add(op.id);
    }
  }

  if (hits.has(72) && context.distDir && fs.existsSync(context.distDir)) {
    const files = fs.readdirSync(context.distDir);
    fs.writeFileSync(path.join(context.distDir, 'seal.json'), JSON.stringify({
      manifest: files.filter(f => f !== 'seal.json'),
      fileCount: files.length,
      sealed_at: new Date().toISOString(),
      operator: 'OP-72-SEAL',
    }, null, 2));
  }

  return Array.from(hits);
}
