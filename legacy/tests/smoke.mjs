import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../../');
const mainUrl = pathToFileURL(path.join(root, 'main.mjs')).href;

async function run() {
  const original = [...process.argv];
  process.argv = [process.argv[0], 'main.mjs', 'web app'];
  
  console.log('Running Smoke Test: "web app"...');
  try {
      await import(mainUrl);
  } catch (e) {
      console.error("Execution failed:", e);
      process.exit(1);
  }
  process.argv = original;

  const genDir = path.join(root, 'XANDRIA', 'generated');
  const artifact = path.join(genDir, 'artifact.json');
  const dist = path.join(genDir, 'dist');
  const seal = path.join(genDir, 'seal.json');

  const okArtifact = fs.existsSync(artifact);
  const okDist = fs.existsSync(dist) && fs.readdirSync(dist).length > 0;
  const okSeal = fs.existsSync(seal);

  console.log('Artifact Exists:', okArtifact);
  console.log('Dist Content Exists:', okDist);
  console.log('Seal Exists:', okSeal);

  if (!okArtifact || !okDist || !okSeal) {
    console.error('SMOKE TEST FAILED');
    process.exitCode = 1;
  } else {
    console.log('SMOKE TEST PASSED');
  }
}
run();
