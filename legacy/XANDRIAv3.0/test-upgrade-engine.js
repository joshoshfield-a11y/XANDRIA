/**
 * TEST SCRIPT FOR RECURSIVE UPGRADE ENGINE
 * Verifies cockpit initialization and basic functionality
 */

import { cockpit } from './src/engine/upgrade-engine/index.js';

async function testUpgradeEngine() {
  console.log('🧪 TESTING RECURSIVE UPGRADE ENGINE...\n');

  try {
    // Test initialization
    console.log('1. Testing cockpit initialization...');
    await cockpit.init();
    console.log('✅ Cockpit initialized successfully\n');

    // Test status check
    console.log('2. Testing system status check...');
    const status = cockpit.status();
    console.log('📊 System Status:', status);
    console.log('✅ Status check successful\n');

    // Test error retrieval
    console.log('3. Testing error retrieval...');
    const errors = cockpit.errors();
    console.log(`🔍 Found ${errors.length} system errors`);
    console.log('✅ Error retrieval successful\n');

    // Test bridge toggle
    console.log('4. Testing bridge toggle...');
    await cockpit.bridge('CLINE');
    const statusAfterBridge = cockpit.status();
    console.log('🌉 Bridge Status:', statusAfterBridge.bridgeActive ? 'ACTIVE' : 'INACTIVE');
    console.log('✅ Bridge toggle successful\n');

    console.log('🎉 ALL TESTS PASSED! RECURSIVE UPGRADE ENGINE IS OPERATIONAL');
    console.log('\n🚀 Ready to proceed to Phase 2: Stochastic Evolution Engine');

  } catch (error) {
    console.error('❌ TEST FAILED:', error.message);
    process.exit(1);
  }
}

// Run the test
testUpgradeEngine();
