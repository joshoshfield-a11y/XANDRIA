const { unifiedTestSuite } = require('./dist/src/tests/UnifiedTestSuite.js');

async function testJMetric() {
  console.log('Testing J-Metric Quality Validation System...');

  try {
    // Run the quality validation suite
    const result = await unifiedTestSuite.executeSuite('quality-validation');

    console.log('Suite Results:');
    console.log('- Total Tests:', result.totalTests);
    console.log('- Passed:', result.passedTests);
    console.log('- Failed:', result.failedTests);
    console.log('- Success Rate:', result.summary.successRate.toFixed(1) + '%');

    if (result.failedTests > 0) {
      console.log('Failed Tests:');
      result.results.forEach((testResult, index) => {
        if (!testResult.success) {
          console.log('- ' + (result.results[index]?.error || 'Unknown error'));
        }
      });
    }

    // Test quality gate
    const gateResult = await unifiedTestSuite.runQualityGate(80);
    console.log('Quality Gate:', gateResult.passed ? 'PASSED' : 'FAILED');
    console.log('Score:', gateResult.score.toFixed(1) + '%');

  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

testJMetric();