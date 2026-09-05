import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyOperators } from './core/operators.mjs';
import { measure } from './core/reflector.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const intent = process.argv[2] || 'default';
const genDir = path.join(__dirname, 'XANDRIA', 'generated');
const distDir = path.join(genDir, 'dist');

fs.mkdirSync(distDir, { recursive: true });

const hits = applyOperators(intent, { intent, distDir, root: __dirname });

const artifact = {
  id: Math.random().toString(36).slice(2, 10),
  intent,
  timestamp: Date.now(),
  operatorsApplied: hits,
  generatedFiles: ['index.html', 'main.js', 'manifest.json'],
  status: 'manifested',
};

fs.writeFileSync(path.join(distDir, 'index.html'),
  `<!DOCTYPE html><html><head><title>${intent}</title></head><body><div id="root"></div></body></html>`);
fs.writeFileSync(path.join(distDir, 'main.js'),
  `// XANDRIA manifest: ${intent}\nconsole.log('Artifact: ${artifact.id}');`);
fs.writeFileSync(path.join(distDir, 'manifest.json'),
  JSON.stringify({ intent, artifact_id: artifact.id, timestamp: artifact.timestamp }, null, 2));

fs.writeFileSync(path.join(genDir, 'artifact.json'), JSON.stringify(artifact, null, 2));

// Write seal to genDir (smoke test expects it there)
applyOperators('OP-72 Seal', { intent, distDir: genDir, root: __dirname });

const reflection = measure({ intent, generatedFiles: artifact.generatedFiles });
console.log(`[XANDRIA] Intent: "${intent}"`);
console.log(`[XANDRIA] Operators fired: ${hits.join(', ')}`);
console.log(`[XANDRIA] Reflection score: ${reflection.score}/2`);
console.log(`[XANDRIA] Artifact: ${path.join(genDir, 'artifact.json')}`);
console.log(`[XANDRIA] Seal: ${path.join(genDir, 'seal.json')}`);
