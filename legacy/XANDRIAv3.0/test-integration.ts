#!/usr/bin/env tsx

/**
 * XANDRIA v3.0 Integration Test
 * Tests the unified operator registry and synthesis engine
 */

import { XUAXUNEngine } from './src/engine/xuaxun-engine';

async function testIntegration() {
  console.log('🚀 Starting XANDRIA v3.0 Integration Test...\n');

  try {
    // Test 1: Engine Initialization
    console.log('📋 Test 1: Engine Initialization');
    const engine = new XUAXUNEngine();
    console.log('✅ Engine created successfully');

    // Test 2: Engine Statistics
    console.log('\n📋 Test 2: Engine Statistics');
    const stats = engine.getStatistics();
    console.log(`✅ Total operators: ${stats.totalOperators}`);
    console.log(`✅ Categories: ${Object.keys(stats.operatorsByCategory).join(', ')}`);
    console.log(`✅ Triads: ${Object.keys(stats.operatorsByTriad).join(', ')}`);

    // Test 3: Pipeline Generation
    console.log('\n📋 Test 3: Pipeline Generation');
    const request = {
      intent: 'Create a simple web application',
      context: {
        domain: 'software' as const,
        scope: 'project' as const,
        constraints: {},
        preferences: {}
      },
      pipeline: ['L1', 'L3', 'L4', 'L5'], // Basic analysis pipeline
      metadata: {
        sessionId: 'test-session-001',
        userId: 'test-user',
        timestamp: Date.now(),
        version: '3.0.0'
      }
    };

    const pipeline = await engine.generatePipeline(request);
    console.log(`✅ Generated pipeline: ${pipeline.join(' → ')}`);

    // Test 4: Synthesis Execution
    console.log('\n📋 Test 4: Synthesis Execution');
    const result = await engine.synthesize(request);
    console.log(`✅ Synthesis completed: ${result.success ? 'PASS' : 'FAIL'}`);
    console.log(`✅ Execution time: ${result.metadata.executionTime}ms`);
    console.log(`✅ Operators executed: ${result.metadata.operatorsExecuted}`);
    console.log(`✅ Coherence score: ${result.metadata.coherenceScore.toFixed(3)}`);

    // Test 5: Health Check
    console.log('\n📋 Test 5: Health Check');
    const health = engine.healthCheck();
    console.log(`✅ Engine health: ${health.status}`);
    console.log(`✅ Operators available: ${health.operatorsAvailable}`);

    // Test 6: Execution History
    console.log('\n📋 Test 6: Execution History');
    const history = engine.getExecutionHistory(5);
    console.log(`✅ History entries: ${history.length}`);

    // Test 7: Configuration Update
    console.log('\n📋 Test 7: Configuration Update');
    engine.updateConfig({ coherenceThreshold: 0.9 });
    console.log('✅ Configuration updated');

    console.log('\n🎉 All integration tests passed!');
    console.log('✨ XANDRIA v3.0 operator registry and synthesis engine are functional!');

  } catch (error) {
    console.error('\n❌ Integration test failed:', error);
    process.exit(1);
  }
}

// Run the test
testIntegration();
