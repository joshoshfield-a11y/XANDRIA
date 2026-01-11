/**
 * XANDRIA UNIFIED TEST SUITE
 * Comprehensive testing framework integrating J-Metric validation,
 * operator testing, and system validation
 */

import { JMetric } from './JMetric';
import { qualityValidator, QualityValidator } from './QualityValidator';
import { operatorRegistry } from '../operators/OperatorRegistry';
import { stochasticEvolutionEngine } from '../stochastic/StochasticEvolutionEngine';
import { CodebaseMetrics, ValidationContext } from './JMetric';

export interface TestSuite {
  name: string;
  description: string;
  tests: TestCase[];
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
  timeout?: number;
}

export interface TestCase {
  name: string;
  description: string;
  category: 'unit' | 'integration' | 'system' | 'performance' | 'quality' | 'operator';
  priority: 'critical' | 'high' | 'medium' | 'low';
  test: () => Promise<TestResult>;
  timeout?: number;
  skip?: boolean;
  tags?: string[];
}

export interface TestResult {
  success: boolean;
  duration: number;
  result?: any;
  error?: string;
  warnings?: string[];
  metrics?: Record<string, number>;
  assertions?: TestAssertion[];
}

export interface TestAssertion {
  description: string;
  passed: boolean;
  expected?: any;
  actual?: any;
  error?: string;
}

export interface TestSuiteResult {
  suiteName: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  duration: number;
  results: TestResult[];
  summary: {
    successRate: number;
    averageDuration: number;
    criticalFailures: number;
    recommendations: string[];
  };
}

export interface TestConfiguration {
  parallel: boolean;
  maxWorkers: number;
  timeout: number;
  failFast: boolean;
  verbose: boolean;
  coverage: boolean;
  categories: string[];
  tags: string[];
}

export class UnifiedTestSuite {
  private testSuites: Map<string, TestSuite> = new Map();
  private configuration: TestConfiguration;
  private jMetric: JMetric;
  private qualityValidatorInstance: QualityValidator;

  constructor(config: Partial<TestConfiguration> = {}) {
    this.configuration = {
      parallel: false,
      maxWorkers: 4,
      timeout: 30000,
      failFast: false,
      verbose: false,
      coverage: false,
      categories: [],
      tags: [],
      ...config
    };

    this.jMetric = new JMetric();
    this.qualityValidatorInstance = new QualityValidator();
    this.initializeDefaultSuites();
  }

  /**
   * Initialize default test suites
   */
  private initializeDefaultSuites(): void {
    this.addSuite(this.createOperatorTestSuite());
    this.addSuite(this.createQualityTestSuite());
    this.addSuite(this.createEvolutionTestSuite());
    this.addSuite(this.createIntegrationTestSuite());
    this.addSuite(this.createPerformanceTestSuite());
  }

  /**
   * Create operator validation test suite
   */
  private createOperatorTestSuite(): TestSuite {
    return {
      name: 'operator-validation',
      description: 'Comprehensive validation of all 216 mathematical operators',
      tests: [
        {
          name: 'operator-registry-completeness',
          description: 'Verify all 216 operators are registered and functional',
          category: 'operator',
          priority: 'critical',
          test: async () => {
            const startTime = Date.now();
            const operators = operatorRegistry.getAllOperators();

            const assertions: TestAssertion[] = [
              {
                description: 'All 216 operators registered',
                passed: operators.size === 216,
                expected: 216,
                actual: operators.size
              },
              {
                description: 'No missing operator IDs',
                passed: Array.from(operators.keys()).every(id => id.startsWith('L') && !isNaN(parseInt(id.substring(1)))),
                expected: true,
                actual: Array.from(operators.keys()).every(id => id.startsWith('L') && !isNaN(parseInt(id.substring(1))))
              }
            ];

            return {
              success: assertions.every(a => a.passed),
              duration: Date.now() - startTime,
              assertions,
              metrics: {
                registeredOperators: operators.size,
                categories: new Set(Array.from(operators.values()).map(op => op.category)).size,
                triads: new Set(Array.from(operators.values()).map(op => op.triad)).size
              }
            };
          }
        },
        {
          name: 'operator-functionality-test',
          description: 'Test basic functionality of key operators',
          category: 'operator',
          priority: 'high',
          test: async () => {
            const startTime = Date.now();
            const testOperators = ['L1', 'L2', 'L3', 'L4', 'L5']; // Test foundational operators
            const assertions: TestAssertion[] = [];

            for (const opId of testOperators) {
              try {
                const context = {
                  input: { test: 'data' },
                  config: {},
                  state: {},
                  previousResults: [],
                  environment: {
                    timestamp: Date.now(),
                    sessionId: 'operator-test',
                    contextScope: ['test', 'operator']
                  }
                };

                const result = await operatorRegistry.executeOperator(opId, context);
                assertions.push({
                  description: `Operator ${opId} executes successfully`,
                  passed: result.success,
                  result: result.result
                });
              } catch (error) {
                assertions.push({
                  description: `Operator ${opId} execution failed`,
                  passed: false,
                  error: error instanceof Error ? error.message : 'Unknown error'
                });
              }
            }

            return {
              success: assertions.every(a => a.passed),
              duration: Date.now() - startTime,
              assertions,
              metrics: {
                testedOperators: testOperators.length,
                successfulOperators: assertions.filter(a => a.passed).length
              }
            };
          }
        },
        {
          name: 'operator-dependency-validation',
          description: 'Validate operator dependency chains',
          category: 'operator',
          priority: 'medium',
          test: async () => {
            const startTime = Date.now();
            const operators = operatorRegistry.getAllOperators();
            const assertions: TestAssertion[] = [];

            for (const [id, operator] of operators) {
              const dependencies = operator.dependencies;
              const missingDeps = dependencies.filter(depId => !operators.has(depId));

              assertions.push({
                description: `Operator ${id} dependencies satisfied`,
                passed: missingDeps.length === 0,
                expected: [],
                actual: missingDeps
              });
            }

            return {
              success: assertions.every(a => a.passed),
              duration: Date.now() - startTime,
              assertions,
              metrics: {
                totalDependencies: Array.from(operators.values()).reduce((sum, op) => sum + op.dependencies.length, 0),
                unsatisfiedDependencies: assertions.filter(a => !a.passed).length
              }
            };
          }
        }
      ]
    };
  }

  /**
   * Create quality validation test suite
   */
  private createQualityTestSuite(): TestSuite {
    return {
      name: 'quality-validation',
      description: 'J-Metric quality assessment and validation',
      tests: [
        {
          name: 'j-metric-completeness',
          description: 'Verify J-Metric implements all 14 validation categories',
          category: 'quality',
          priority: 'critical',
          test: async () => {
            const startTime = Date.now();
            const categories = this.jMetric.getCategories();
            const expectedCategories = 14;

            const assertion: TestAssertion = {
              description: 'All 14 quality categories implemented',
              passed: categories.length === expectedCategories,
              expected: expectedCategories,
              actual: categories.length
            };

            return {
              success: assertion.passed,
              duration: Date.now() - startTime,
              assertions: [assertion],
              metrics: {
                implementedCategories: categories.length,
                expectedCategories
              }
            };
          }
        },
        {
          name: 'quality-assessment-execution',
          description: 'Test full quality assessment pipeline',
          category: 'quality',
          priority: 'high',
          test: async () => {
            const startTime = Date.now();

            // Create test context
            const context: ValidationContext = {
              codebase: {
                files: 42,
                linesOfCode: 15420,
                functions: 89,
                classes: 12,
                complexity: 8.5,
                testCoverage: 75,
                dependencies: 23,
                languages: ['typescript', 'javascript']
              },
              targetPlatform: 'web',
              qualityThresholds: {
                minimumScore: 0.7,
                criticalThreshold: 0.6,
                warningThreshold: 0.8
              }
            };

            try {
              const result = await this.jMetric.assessQuality(context);

              const assertions: TestAssertion[] = [
                {
                  description: 'Quality assessment completes successfully',
                  passed: result !== null && result.categoryScores.length > 0
                },
                {
                  description: 'Overall score is reasonable',
                  passed: result.overallScore >= 0 && result.overallScore <= 1,
                  expected: '0-1 range',
                  actual: result.overallScore
                },
                {
                  description: 'Grade is assigned',
                  passed: result.qualityGrade !== null && result.qualityGrade !== undefined,
                  actual: result.qualityGrade
                }
              ];

              return {
                success: assertions.every(a => a.passed),
                duration: Date.now() - startTime,
                result,
                assertions,
                metrics: {
                  overallScore: result.overallScore,
                  totalViolations: result.totalViolations,
                  criticalViolations: result.criticalViolations,
                  executionTime: result.metadata.executionTime
                }
              };
            } catch (error) {
              return {
                success: false,
                duration: Date.now() - startTime,
                error: error instanceof Error ? error.message : 'Unknown error'
              };
            }
          }
        }
      ]
    };
  }

  /**
   * Create evolution engine test suite
   */
  private createEvolutionTestSuite(): TestSuite {
    return {
      name: 'evolution-engine',
      description: 'Stochastic evolution engine validation',
      tests: [
        {
          name: 'evolution-strategy-availability',
          description: 'Verify all evolution strategies are available',
          category: 'system',
          priority: 'high',
          test: async () => {
            const startTime = Date.now();
            const strategies = stochasticEvolutionEngine.getAvailableStrategies();

            const assertion: TestAssertion = {
              description: 'All 4 evolution strategies available',
              passed: strategies.length === 4,
              expected: 4,
              actual: strategies.length
            };

            return {
              success: assertion.passed,
              duration: Date.now() - startTime,
              assertions: [assertion],
              result: strategies
            };
          }
        },
        {
          name: 'evolution-execution-test',
          description: 'Test basic evolution execution',
          category: 'system',
          priority: 'medium',
          test: async () => {
            const startTime = Date.now();

            const initialState = {
              complexity: 0.8,
              quality: 0.6,
              technicalDebt: 0.7,
              maintainability: 0.5,
              performance: 0.6,
              timestamp: Date.now()
            };

            try {
              const result = await stochasticEvolutionEngine.evolveCodebase(
                initialState,
                'quality-enhancement',
                10 // Short test run
              );

              const assertions: TestAssertion[] = [
                {
                  description: 'Evolution completes successfully',
                  passed: result !== null
                },
                {
                  description: 'Quality improvement achieved',
                  passed: result.finalState.quality >= initialState.quality,
                  expected: `>= ${initialState.quality}`,
                  actual: result.finalState.quality
                },
                {
                  description: 'Iterations completed',
                  passed: result.totalIterations > 0,
                  actual: result.totalIterations
                }
              ];

              return {
                success: assertions.every(a => a.passed),
                duration: Date.now() - startTime,
                result,
                assertions,
                metrics: {
                  qualityImprovement: result.improvementMetrics.qualityImprovement,
                  debtReduction: result.improvementMetrics.debtReduction,
                  iterations: result.totalIterations
                }
              };
            } catch (error) {
              return {
                success: false,
                duration: Date.now() - startTime,
                error: error instanceof Error ? error.message : 'Unknown error'
              };
            }
          }
        }
      ]
    };
  }

  /**
   * Create integration test suite
   */
  private createIntegrationTestSuite(): TestSuite {
    return {
      name: 'system-integration',
      description: 'End-to-end system integration tests',
      tests: [
        {
          name: 'operator-registry-integration',
          description: 'Test operator registry integration with quality validator',
          category: 'integration',
          priority: 'high',
          test: async () => {
            const startTime = Date.now();

            // Test that operators can be used in validation context
            const context = {
              input: { testData: 'integration test' },
              config: { integration: true },
              state: {},
              previousResults: [],
              environment: {
                timestamp: Date.now(),
                sessionId: 'integration-test',
                contextScope: ['integration', 'test']
              }
            };

            try {
              const result = await operatorRegistry.executeOperator('L1', context); // Identity operator

              const assertion: TestAssertion = {
                description: 'Operator executes in integration context',
                passed: result.success,
                result: result.result
              };

              return {
                success: assertion.passed,
                duration: Date.now() - startTime,
                assertions: [assertion],
                result: result.result
              };
            } catch (error) {
              return {
                success: false,
                duration: Date.now() - startTime,
                error: error instanceof Error ? error.message : 'Unknown error'
              };
            }
          }
        }
      ]
    };
  }

  /**
   * Create performance test suite
   */
  private createPerformanceTestSuite(): TestSuite {
    return {
      name: 'performance-testing',
      description: 'Performance benchmarks and stress testing',
      tests: [
        {
          name: 'operator-execution-performance',
          description: 'Measure operator execution performance',
          category: 'performance',
          priority: 'medium',
          test: async () => {
            const startTime = Date.now();
            const iterations = 10;
            const executionTimes: number[] = [];

            for (let i = 0; i < iterations; i++) {
              const opStart = Date.now();
              const context = {
                input: { iteration: i },
                config: {},
                state: {},
                previousResults: [],
                environment: {
                  timestamp: Date.now(),
                  sessionId: 'performance-test',
                  contextScope: ['performance', 'test']
                }
              };

              await operatorRegistry.executeOperator('L1', context);
              executionTimes.push(Date.now() - opStart);
            }

            const avgTime = executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length;
            const maxTime = Math.max(...executionTimes);

            const assertions: TestAssertion[] = [
              {
                description: 'Average execution time acceptable',
                passed: avgTime < 100, // Less than 100ms
                expected: '< 100ms',
                actual: `${avgTime.toFixed(2)}ms`
              },
              {
                description: 'No execution timeouts',
                passed: maxTime < 1000, // Less than 1s
                expected: '< 1000ms',
                actual: `${maxTime}ms`
              }
            ];

            return {
              success: assertions.every(a => a.passed),
              duration: Date.now() - startTime,
              assertions,
              metrics: {
                averageExecutionTime: avgTime,
                maxExecutionTime: maxTime,
                totalIterations: iterations
              }
            };
          }
        }
      ]
    };
  }

  /**
   * Add a test suite
   */
  addSuite(suite: TestSuite): void {
    this.testSuites.set(suite.name, suite);
    console.log(`[UnifiedTestSuite] Added test suite: ${suite.name}`);
  }

  /**
   * Execute a single test suite
   */
  async executeSuite(suiteName: string): Promise<TestSuiteResult> {
    const suite = this.testSuites.get(suiteName);
    if (!suite) {
      throw new Error(`Test suite '${suiteName}' not found`);
    }

    const startTime = Date.now();
    console.log(`[UnifiedTestSuite] Executing suite: ${suite.name}`);

    // Setup
    if (suite.setup) {
      await suite.setup();
    }

    const results: TestResult[] = [];
    let passedTests = 0;
    let failedTests = 0;
    let skippedTests = 0;

    // Filter tests based on configuration
    const filteredTests = suite.tests.filter(test => {
      if (this.configuration.categories.length > 0 &&
          !this.configuration.categories.includes(test.category)) {
        return false;
      }
      if (this.configuration.tags.length > 0 &&
          !test.tags?.some(tag => this.configuration.tags.includes(tag))) {
        return false;
      }
      return true;
    });

    // Execute tests
    for (const test of filteredTests) {
      if (test.skip) {
        skippedTests++;
        results.push({
          success: true,
          duration: 0,
          result: 'skipped'
        });
        continue;
      }

      try {
        const timeout = test.timeout || suite.timeout || this.configuration.timeout;
        const result = await this.executeTestWithTimeout(test, timeout);
        results.push(result);

        if (result.success) {
          passedTests++;
        } else {
          failedTests++;
          if (this.configuration.failFast) {
            console.log(`[UnifiedTestSuite] Failing fast due to test failure: ${test.name}`);
            break;
          }
        }
      } catch (error) {
        failedTests++;
        results.push({
          success: false,
          duration: 0,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Teardown
    if (suite.teardown) {
      await suite.teardown();
    }

    const totalDuration = Date.now() - startTime;
    const successRate = (passedTests / (passedTests + failedTests)) * 100;

    const result: TestSuiteResult = {
      suiteName,
      totalTests: filteredTests.length,
      passedTests,
      failedTests,
      skippedTests,
      duration: totalDuration,
      results,
      summary: {
        successRate,
        averageDuration: totalDuration / filteredTests.length,
        criticalFailures: results.filter(r => !r.success).length,
        recommendations: this.generateTestRecommendations(results)
      }
    };

    console.log(`[UnifiedTestSuite] Suite ${suiteName} completed: ${passedTests}/${filteredTests.length} passed (${successRate.toFixed(1)}%)`);

    return result;
  }

  /**
   * Execute all test suites
   */
  async executeAllSuites(): Promise<TestSuiteResult[]> {
    const results: TestSuiteResult[] = [];

    for (const suiteName of this.testSuites.keys()) {
      try {
        const result = await this.executeSuite(suiteName);
        results.push(result);
      } catch (error) {
        console.error(`[UnifiedTestSuite] Failed to execute suite ${suiteName}:`, error);
        // Add error result
        results.push({
          suiteName,
          totalTests: 0,
          passedTests: 0,
          failedTests: 1,
          skippedTests: 0,
          duration: 0,
          results: [],
          summary: {
            successRate: 0,
            averageDuration: 0,
            criticalFailures: 1,
            recommendations: ['Fix test suite execution error']
          }
        });
      }
    }

    return results;
  }

  /**
   * Execute test with timeout
   */
  private async executeTestWithTimeout(test: TestCase, timeout: number): Promise<TestResult> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Test timeout after ${timeout}ms`));
      }, timeout);

      test.test()
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Generate test recommendations based on results
   */
  private generateTestRecommendations(results: TestResult[]): string[] {
    const recommendations: string[] = [];
    const failures = results.filter(r => !r.success);

    if (failures.length > 0) {
      recommendations.push(`${failures.length} test failures detected - investigate and fix`);
    }

    const slowTests = results.filter(r => r.duration > 5000); // Tests taking > 5s
    if (slowTests.length > 0) {
      recommendations.push(`${slowTests.length} slow tests detected - optimize performance`);
    }

    if (results.some(r => r.error?.includes('timeout'))) {
      recommendations.push('Timeout issues detected - increase timeout limits or optimize test execution');
    }

    return recommendations;
  }

  /**
   * Get test suite information
   */
  getSuiteInfo(suiteName: string): TestSuite | undefined {
    return this.testSuites.get(suiteName);
  }

  /**
   * Get all available test suites
   */
  getAvailableSuites(): string[] {
    return Array.from(this.testSuites.keys());
  }

  /**
   * Update test configuration
   */
  updateConfiguration(config: Partial<TestConfiguration>): void {
    this.configuration = { ...this.configuration, ...config };
    console.log('[UnifiedTestSuite] Configuration updated');
  }

  /**
   * Generate comprehensive test report
   */
  async generateTestReport(): Promise<{
    summary: {
      totalSuites: number;
      totalTests: number;
      passedTests: number;
      failedTests: number;
      successRate: number;
      averageDuration: number;
    };
    suiteResults: TestSuiteResult[];
    recommendations: string[];
    qualityMetrics: {
      testCoverage: number;
      performanceScore: number;
      reliabilityScore: number;
    };
  }> {
    const suiteResults = await this.executeAllSuites();

    const totalSuites = suiteResults.length;
    const totalTests = suiteResults.reduce((sum, r) => sum + r.totalTests, 0);
    const passedTests = suiteResults.reduce((sum, r) => sum + r.passedTests, 0);
    const failedTests = suiteResults.reduce((sum, r) => sum + r.failedTests, 0);
    const successRate = totalTests > 0 ? (passedTests / totalTests) * 100 : 0;
    const averageDuration = suiteResults.reduce((sum, r) => sum + r.summary.averageDuration, 0) / totalSuites;

    // Aggregate recommendations
    const allRecommendations = suiteResults.flatMap(r => r.summary.recommendations);
    const uniqueRecommendations = [...new Set(allRecommendations)].slice(0, 10);

    // Calculate quality metrics
    const qualityMetrics = {
      testCoverage: Math.min(100, (passedTests / Math.max(totalTests, 1)) * 100),
      performanceScore: Math.max(0, 100 - (averageDuration / 100)), // Arbitrary performance scoring
      reliabilityScore: Math.max(0, successRate)
    };

    return {
      summary: {
        totalSuites,
        totalTests,
        passedTests,
        failedTests,
        successRate,
        averageDuration
      },
      suiteResults,
      recommendations: uniqueRecommendations,
      qualityMetrics
    };
  }

  /**
   * Run quality gate check
   */
  async runQualityGate(minimumSuccessRate: number = 90): Promise<{
    passed: boolean;
    score: number;
    issues: string[];
  }> {
    const report = await this.generateTestReport();

    const passed = report.summary.successRate >= minimumSuccessRate;
    const issues: string[] = [];

    if (!passed) {
      issues.push(`Success rate ${report.summary.successRate.toFixed(1)}% below threshold ${minimumSuccessRate}%`);
    }

    if (report.summary.failedTests > 0) {
      issues.push(`${report.summary.failedTests} tests failed`);
    }

    if (report.qualityMetrics.performanceScore < 70) {
      issues.push('Performance score below acceptable threshold');
    }

    return {
      passed,
      score: report.summary.successRate,
      issues
    };
  }
}

// Export singleton instance
export const unifiedTestSuite = new UnifiedTestSuite();