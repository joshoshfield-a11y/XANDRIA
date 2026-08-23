/**
 * XANDRIA Unified Entry Point
 * Dispatches to: core engine, any sub-app, or CLI mode
 */

import { XUAXUNEngine } from './XANDRIAv3.0/src/engine/xuaxun-engine';
import { UnifiedOperatorBridge } from './UnifiedOperatorBridge';

export { XUAXUNEngine, UnifiedOperatorBridge };
export * from './XANDRIAv3.0/src/engine/operators/OperatorRegistry';
export * from './XANDRIAv3.0/src/config/types';

// CLI entry
export async function cli() {
  const args = process.argv.slice(2);
  const intent = args[0] || 'a solar system';
  const domain = (args[1] as any) || 'gaming';

  console.log(`\n🜂 XANDRIA Unified Engine v4.0`);
  console.log(`   Intent: "${intent}"`);
  console.log(`   Domain: ${domain}\n`);

  const bridge = new UnifiedOperatorBridge();
  const result = await bridge.manifest({
    intent,
    assetsContext: [],
    domain,
    scope: 'project'
  });

  if (result.success) {
    console.log(`✅ Synthesis complete`);
    console.log(`   Operators: ${result.operators.executed.join(' → ')}`);
    console.log(`   Coherence: ${(result.operators.coherence * 100).toFixed(1)}%`);
    console.log(`   Confidence: ${(result.operators.confidence * 100).toFixed(1)}%`);
    console.log(`   Quality: ${result.quality.grade} (${result.quality.score}/100)`);
    console.log(`   Time: ${result.metadata.executionTime}ms`);
    console.log(`\n   Scene: ${result.scene.entities.length} entities`);
    console.log(`   Files: ${result.code.files.length} generated\n`);
  } else {
    console.log(`❌ Synthesis failed`);
    console.log(`   Violations: ${result.quality.violations.join(', ')}\n`);
  }
}

// If run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
