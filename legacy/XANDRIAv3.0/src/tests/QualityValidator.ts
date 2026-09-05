/**
 * XANDRIA QUALITY VALIDATOR
 * High-level interface for quality validation and continuous monitoring
 * Integrates J-Metric assessment with automated validation workflows
 */

import { JMetric, JMetricResult, ValidationContext, CodebaseMetrics, ValidationRule } from './JMetric';
import { operatorRegistry } from '../operators/OperatorRegistry';

export interface ValidationReport {
  timestamp: number;
  duration: number;
  result: JMetricResult;
  status: 'passed' | 'failed' | 'warning';
  blockingIssues: string[];
  recommendations: string[];
  nextValidation: number; // timestamp for next validation
}

export interface ContinuousValidationConfig {
  enabled: boolean;
  interval: number; // milliseconds
  thresholds: {
    criticalScore: number;
    warningScore: number;
    maxViolations: number;
  };
  notifications: {
    onFailure: boolean;
    onWarning: boolean;
    emailRecipients?: string[];
  };
  autoRemediation: {
    enabled: boolean;
    maxAttempts: number;
    strategies: string[];
  };
}

export interface ValidationPipeline {
  name: string;
  description: string;
  context: ValidationContext;
  config: ContinuousValidationConfig;
  history: ValidationReport[];
  lastExecution?: ValidationReport;
}

export class QualityValidator {
  private jMetric: JMetric;
  private pipelines: Map<string, ValidationPipeline> = new Map();
  private activeValidations: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.jMetric = new JMetric();
  }

  /**
   * Create a new validation pipeline
   */
  createPipeline(
    name: string,
    description: string,
    context: ValidationContext,
    config: ContinuousValidationConfig
  ): ValidationPipeline {
    const pipeline: ValidationPipeline = {
      name,
      description,
      context,
      config,
      history: []
    };

    this.pipelines.set(name, pipeline);

    if (config.enabled) {
      this.startContinuousValidation(name);
    }

    console.log(`[QualityValidator] Created validation pipeline: ${name}`);
    return pipeline;
  }

  /**
   * Execute one-time quality validation
   */
  async validateOnce(pipelineName: string): Promise<ValidationReport> {
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) {
      throw new Error(`Validation pipeline '${pipelineName}' not found`);
    }

    const startTime = Date.now();

    try {
      console.log(`[QualityValidator] Executing validation for pipeline: ${pipelineName}`);

      // Execute J-Metric assessment
      const result = await this.jMetric.assessQuality(pipeline.context);

      // Determine status based on thresholds
      const status = this.determineValidationStatus(result, pipeline.config.thresholds);

      // Generate blocking issues
      const blockingIssues = this.identifyBlockingIssues(result);

      // Calculate next validation time
      const nextValidation = pipeline.config.enabled ?
        Date.now() + pipeline.config.interval : 0;

      const report: ValidationReport = {
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        result,
        status,
        blockingIssues,
        recommendations: result.recommendations,
        nextValidation
      };

      // Store in pipeline history
      pipeline.history.push(report);
      pipeline.lastExecution = report;

      // Limit history size
      if (pipeline.history.length > 100) {
        pipeline.history = pipeline.history.slice(-50);
      }

      console.log(`[QualityValidator] Validation complete: ${status} (${(result.overallScore * 100).toFixed(1)}%)`);

      // Trigger notifications if needed
      await this.handleValidationNotifications(pipeline, report);

      // Attempt auto-remediation if enabled and failed
      if (status === 'failed' && pipeline.config.autoRemediation.enabled) {
        await this.attemptAutoRemediation(pipeline, report);
      }

      return report;

    } catch (error) {
      console.error(`[QualityValidator] Validation failed for pipeline ${pipelineName}:`, error);

      const errorReport: ValidationReport = {
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        result: {
          overallScore: 0,
          qualityGrade: 'F',
          categoryScores: [],
          totalViolations: 1,
          criticalViolations: 1,
          recommendations: ['Fix validation system error'],
          metadata: {
            timestamp: Date.now(),
            assessedFiles: 0,
            executionTime: Date.now() - startTime,
            version: 'error'
          }
        },
        status: 'failed',
        blockingIssues: [`Validation system error: ${error instanceof Error ? error.message : 'Unknown error'}`],
        recommendations: ['Investigate validation system failure'],
        nextValidation: 0
      };

      pipeline.history.push(errorReport);
      pipeline.lastExecution = errorReport;

      return errorReport;
    }
  }

  /**
   * Start continuous validation for a pipeline
   */
  startContinuousValidation(pipelineName: string): void {
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) {
      throw new Error(`Pipeline '${pipelineName}' not found`);
    }

    if (this.activeValidations.has(pipelineName)) {
      console.warn(`[QualityValidator] Continuous validation already running for: ${pipelineName}`);
      return;
    }

    console.log(`[QualityValidator] Starting continuous validation for: ${pipelineName}`);

    const intervalId = setInterval(async () => {
      try {
        await this.validateOnce(pipelineName);
      } catch (error) {
        console.error(`[QualityValidator] Continuous validation error for ${pipelineName}:`, error);
      }
    }, pipeline.config.interval);

    this.activeValidations.set(pipelineName, intervalId);
  }

  /**
   * Stop continuous validation for a pipeline
   */
  stopContinuousValidation(pipelineName: string): void {
    const intervalId = this.activeValidations.get(pipelineName);
    if (intervalId) {
      clearInterval(intervalId);
      this.activeValidations.delete(pipelineName);
      console.log(`[QualityValidator] Stopped continuous validation for: ${pipelineName}`);
    }
  }

  /**
   * Update pipeline configuration
   */
  updatePipelineConfig(pipelineName: string, config: Partial<ContinuousValidationConfig>): void {
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) {
      throw new Error(`Pipeline '${pipelineName}' not found`);
    }

    // Stop current validation if running
    this.stopContinuousValidation(pipelineName);

    // Update configuration
    pipeline.config = { ...pipeline.config, ...config };

    // Restart if enabled
    if (pipeline.config.enabled) {
      this.startContinuousValidation(pipelineName);
    }

    console.log(`[QualityValidator] Updated configuration for pipeline: ${pipelineName}`);
  }

  /**
   * Update pipeline context (codebase metrics)
   */
  updatePipelineContext(pipelineName: string, context: Partial<ValidationContext>): void {
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) {
      throw new Error(`Pipeline '${pipelineName}' not found`);
    }

    pipeline.context = { ...pipeline.context, ...context };
    console.log(`[QualityValidator] Updated context for pipeline: ${pipelineName}`);
  }

  /**
   * Get pipeline status and recent history
   */
  getPipelineStatus(pipelineName: string): {
    pipeline: ValidationPipeline;
    isActive: boolean;
    recentReports: ValidationReport[];
    healthScore: number;
  } | null {
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) return null;

    const isActive = this.activeValidations.has(pipelineName);
    const recentReports = pipeline.history.slice(-10);
    const healthScore = this.calculatePipelineHealth(pipeline);

    return {
      pipeline,
      isActive,
      recentReports,
      healthScore
    };
  }

  /**
   * Add custom validation rule
   */
  addCustomRule(rule: ValidationRule): void {
    this.jMetric.addRule(rule);
    console.log(`[QualityValidator] Added custom validation rule: ${rule.id}`);
  }

  /**
   * Generate comprehensive quality report
   */
  async generateQualityReport(pipelineName: string): Promise<{
    summary: {
      totalValidations: number;
      averageScore: number;
      bestScore: number;
      worstScore: number;
      trend: 'improving' | 'declining' | 'stable';
      healthScore: number;
    };
    recentIssues: string[];
    recommendations: string[];
    trends: {
      scoreTrend: number[];
      violationTrend: number[];
      criticalTrend: number[];
    };
  }> {
    const pipeline = this.pipelines.get(pipelineName);
    if (!pipeline) {
      throw new Error(`Pipeline '${pipelineName}' not found`);
    }

    const reports = pipeline.history;
    if (reports.length === 0) {
      throw new Error(`No validation history for pipeline '${pipelineName}'`);
    }

    // Calculate summary statistics
    const scores = reports.map(r => r.result.overallScore);
    const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const bestScore = Math.max(...scores);
    const worstScore = Math.min(...scores);

    // Determine trend
    const recentScores = scores.slice(-5);
    const trend = this.calculateTrend(recentScores);

    // Calculate health score
    const healthScore = this.calculatePipelineHealth(pipeline);

    // Collect recent issues
    const recentIssues: string[] = [];
    const recentReports = reports.slice(-3);
    for (const report of recentReports) {
      recentIssues.push(...report.blockingIssues.slice(0, 2));
    }
    const uniqueIssues = [...new Set(recentIssues)].slice(0, 5);

    // Aggregate recommendations
    const allRecommendations = reports.flatMap(r => r.recommendations);
    const recommendationFrequency = new Map<string, number>();
    for (const rec of allRecommendations) {
      recommendationFrequency.set(rec, (recommendationFrequency.get(rec) || 0) + 1);
    }
    const topRecommendations = Array.from(recommendationFrequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([rec]) => rec);

    // Generate trend data
    const trends = {
      scoreTrend: scores.slice(-10),
      violationTrend: reports.map(r => r.result.totalViolations).slice(-10),
      criticalTrend: reports.map(r => r.result.criticalViolations).slice(-10)
    };

    return {
      summary: {
        totalValidations: reports.length,
        averageScore,
        bestScore,
        worstScore,
        trend,
        healthScore
      },
      recentIssues: uniqueIssues,
      recommendations: topRecommendations,
      trends
    };
  }

  // ===== PRIVATE METHODS =====

  private determineValidationStatus(
    result: JMetricResult,
    thresholds: ContinuousValidationConfig['thresholds']
  ): ValidationReport['status'] {
    if (result.criticalViolations > 0 || result.overallScore < thresholds.criticalScore) {
      return 'failed';
    }
    if (result.totalViolations > thresholds.maxViolations || result.overallScore < thresholds.warningScore) {
      return 'warning';
    }
    return 'passed';
  }

  private identifyBlockingIssues(result: JMetricResult): string[] {
    const blocking: string[] = [];

    // Critical violations are always blocking
    for (const score of result.categoryScores) {
      const criticalViolations = score.violations.filter(v => v.severity === 'critical');
      for (const violation of criticalViolations) {
        blocking.push(`${score.category}: ${violation.message}`);
      }
    }

    // Low scores in critical categories are blocking
    for (const score of result.categoryScores) {
      if (score.weight >= 0.1 && score.score < 0.6) {
        blocking.push(`${score.category}: Score below critical threshold (${(score.score * 100).toFixed(1)}%)`);
      }
    }

    return blocking;
  }

  private async handleValidationNotifications(
    pipeline: ValidationPipeline,
    report: ValidationReport
  ): Promise<void> {
    const config = pipeline.config;

    if (!config.notifications.onFailure && !config.notifications.onWarning) {
      return;
    }

    const shouldNotify =
      (config.notifications.onFailure && report.status === 'failed') ||
      (config.notifications.onWarning && report.status === 'warning');

    if (shouldNotify) {
      console.log(`[QualityValidator] Sending notification for pipeline ${pipeline.name}: ${report.status}`);

      // In a real implementation, this would send emails, Slack notifications, etc.
      // For now, just log the notification
      const notification = {
        pipeline: pipeline.name,
        status: report.status,
        score: (report.result.overallScore * 100).toFixed(1) + '%',
        violations: report.result.totalViolations,
        criticalViolations: report.result.criticalViolations,
        timestamp: new Date(report.timestamp).toISOString()
      };

      console.log('[QualityValidator] Notification:', JSON.stringify(notification, null, 2));
    }
  }

  private async attemptAutoRemediation(
    pipeline: ValidationPipeline,
    report: ValidationReport
  ): Promise<void> {
    console.log(`[QualityValidator] Attempting auto-remediation for pipeline: ${pipeline.name}`);

    const config = pipeline.config.autoRemediation;
    let attempts = 0;

    for (const strategy of config.strategies) {
      if (attempts >= config.maxAttempts) break;
      attempts++;

      try {
        console.log(`[QualityValidator] Trying remediation strategy: ${strategy}`);

        // Apply remediation strategy
        await this.applyRemediationStrategy(pipeline, strategy);

        // Re-validate to check if remediation worked
        const revalidationReport = await this.validateOnce(pipeline.name);

        if (revalidationReport.status === 'passed' || revalidationReport.status === 'warning') {
          console.log(`[QualityValidator] Auto-remediation successful with strategy: ${strategy}`);
          break;
        }

      } catch (error) {
        console.error(`[QualityValidator] Remediation strategy ${strategy} failed:`, error);
      }
    }
  }

  private async applyRemediationStrategy(pipeline: ValidationPipeline, strategy: string): Promise<void> {
    // Simplified remediation strategies
    // In a real implementation, these would be much more sophisticated

    switch (strategy) {
      case 'operator-optimization':
        // Apply optimization operators
        await this.applyOperatorPipeline(pipeline.context, ['L5', 'L21', 'L63']);
        break;

      case 'quality-enhancement':
        // Apply quality-focused operators
        await this.applyOperatorPipeline(pipeline.context, ['L4', 'L67', 'L69']);
        break;

      case 'complexity-reduction':
        // Apply simplification operators
        await this.applyOperatorPipeline(pipeline.context, ['L6', 'L55', 'L3']);
        break;

      default:
        console.warn(`[QualityValidator] Unknown remediation strategy: ${strategy}`);
    }
  }

  private async applyOperatorPipeline(context: ValidationContext, operatorIds: string[]): Promise<void> {
    for (const operatorId of operatorIds) {
      try {
        const operatorContext = {
          input: context.codebase,
          config: { remediation: true },
          state: {},
          previousResults: [],
          environment: {
            timestamp: Date.now(),
            sessionId: 'remediation',
            contextScope: ['validation', 'remediation']
          }
        };

        await operatorRegistry.executeOperator(operatorId, operatorContext);
      } catch (error) {
        console.warn(`[QualityValidator] Operator ${operatorId} remediation failed:`, error);
      }
    }
  }

  private calculateTrend(scores: number[]): 'improving' | 'declining' | 'stable' {
    if (scores.length < 2) return 'stable';

    const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
    const secondHalf = scores.slice(Math.floor(scores.length / 2));

    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    const diff = secondAvg - firstAvg;

    if (diff > 0.05) return 'improving';
    if (diff < -0.05) return 'declining';
    return 'stable';
  }

  private calculatePipelineHealth(pipeline: ValidationPipeline): number {
    if (pipeline.history.length === 0) return 0.5;

    const recentReports = pipeline.history.slice(-5);
    const scores = recentReports.map(r => r.result.overallScore);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    // Factor in trend
    const trend = this.calculateTrend(scores);
    let trendBonus = 0;
    if (trend === 'improving') trendBonus = 0.1;
    if (trend === 'declining') trendBonus = -0.1;

    // Factor in critical violations
    const avgCritical = recentReports.reduce((sum, r) => sum + r.result.criticalViolations, 0) / recentReports.length;
    const violationPenalty = Math.min(avgCritical * 0.1, 0.3);

    return Math.max(0, Math.min(1, avgScore + trendBonus - violationPenalty));
  }

  /**
   * Get all pipeline names
   */
  getPipelineNames(): string[] {
    return Array.from(this.pipelines.keys());
  }

  /**
   * Get all active validation pipelines
   */
  getActivePipelines(): string[] {
    return Array.from(this.activeValidations.keys());
  }

  /**
   * Cleanup and stop all validations
   */
  cleanup(): void {
    for (const pipelineName of this.activeValidations.keys()) {
      this.stopContinuousValidation(pipelineName);
    }
    this.activeValidations.clear();
    console.log('[QualityValidator] Cleanup complete');
  }
}

// Export singleton instance
export const qualityValidator = new QualityValidator();