/**
 * XANDRIA v3.0 - Configuration Validation
 * Ensures all settings are valid and compatible
 */

import {
  XANDRIAConfig,
  ConfigValidationResult,
  ConfigValidationError,
  ConfigValidationWarning,
  ConfigSuggestion,
  GenerationScale,
  Platform,
  QualityLevel,
  HardwareTarget,
  RenderEngine,
  OperatorCategory,
  SynthesisMode,
  TextureFiltering,
  AntiAliasing,
  ShadowQuality,
  ReflectionQuality,
  GIQuality,
  AOQuality,
  GateAction,
  SystemPriority,
  ValidationType,
  ValidationSeverity,
  BiomeType,
  AgentProfileType,
  NarrativeLevel,
  EncounterVariety,
  PacingAlgorithm,
  ShaderLevel,
  CompressionLevel,
  TextureResolution,
  ShaderCompilation,
  BundleStrategy
} from './types';

export class ConfigValidator {
  /**
   * Validate complete XANDRIA configuration
   */
  static validate(config: XANDRIAConfig): ConfigValidationResult {
    const errors: ConfigValidationError[] = [];
    const warnings: ConfigValidationWarning[] = [];
    const suggestions: ConfigSuggestion[] = [];

    // Validate project configuration
    this.validateProject(config, errors, warnings, suggestions);

    // Validate system configurations
    this.validateXUAXUN(config, errors, warnings, suggestions);
    this.validateCartographer(config, errors, warnings, suggestions);
    this.validateDirector(config, errors, warnings, suggestions);
    this.validateSmith(config, errors, warnings, suggestions);
    this.validateGraphics(config, errors, warnings, suggestions);

    // Validate integration settings
    this.validateOrchestration(config, errors, warnings, suggestions);
    this.validateQuality(config, errors, warnings, suggestions);
    this.validateDeployment(config, errors, warnings, suggestions);

    // Cross-system validation
    this.validateCrossSystemCompatibility(config, errors, warnings, suggestions);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      suggestions
    };
  }

  private static validateProject(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    const { project } = config;

    // Required fields
    if (!project.name || project.name.trim().length === 0) {
      errors.push({
        field: 'project.name',
        message: 'Project name is required',
        severity: 'error'
      });
    }

    // Version format
    const versionRegex = /^\d+\.\d+\.\d+/;
    if (!versionRegex.test(project.version)) {
      warnings.push({
        field: 'project.version',
        message: 'Version should follow semantic versioning (x.y.z)',
        suggestion: 'Use format like "1.0.0" or "2.5.0-OMEGA"'
      });
    }

    // Scale validation
    if (project.scale === GenerationScale.AAA) {
      if (!config.cartographer || !config.director || !config.smith) {
        errors.push({
          field: 'project.scale',
          message: 'AAA scale requires cartographer, director, and smith configurations',
          severity: 'error'
        });
      }
    }

    // Platform validation
    if (project.platforms.length === 0) {
      warnings.push({
        field: 'project.platforms',
        message: 'No platforms specified, defaulting to web',
        suggestion: 'Add at least one platform for deployment'
      });
    }

    // Duration estimation
    const estimated = this.estimateGenerationTime(config);
    if (Math.abs(project.estimatedDuration - estimated) > estimated * 0.5) {
      warnings.push({
        field: 'project.estimatedDuration',
        message: `Estimated duration seems inaccurate (expected ~${estimated}s)`,
        suggestion: `Update to approximately ${estimated} seconds`
      });
    }
  }

  private static validateXUAXUN(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    const { xuaxun } = config;

    // Operator validation
    if (xuaxun.operators.length === 0) {
      warnings.push({
        field: 'xuaxun.operators',
        message: 'No operators selected, using defaults',
        suggestion: 'Specify operator categories for better control'
      });
    }

    // Recursion depth validation
    if (xuaxun.recursionDepth < 1 || xuaxun.recursionDepth > 10) {
      errors.push({
        field: 'xuaxun.recursionDepth',
        message: 'Recursion depth must be between 1 and 10',
        severity: 'error'
      });
    }

    // Quality threshold validation
    if (xuaxun.qualityThreshold < 0 || xuaxun.qualityThreshold > 1) {
      errors.push({
        field: 'xuaxun.qualityThreshold',
        message: 'Quality threshold must be between 0 and 1',
        severity: 'error'
      });
    }

    // Synthesis mode validation
    if (config.project.scale === GenerationScale.AAA &&
        xuaxun.synthesisMode === 'fast') {
      warnings.push({
        field: 'xuaxun.synthesisMode',
        message: 'Fast mode may not be sufficient for AAA projects',
        suggestion: 'Consider using "deep" or "balanced" mode for AAA scale'
      });
    }
  }

  private static validateCartographer(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    if (!config.cartographer) {
      if (config.project.scale === GenerationScale.AAA) {
        errors.push({
          field: 'cartographer',
          message: 'Cartographer configuration required for AAA projects',
          severity: 'error'
        });
      }
      return;
    }

    const { cartographer } = config;

    // World scale validation
    if (cartographer.worldScale < 1 || cartographer.worldScale > 100000) {
      errors.push({
        field: 'cartographer.worldScale',
        message: 'World scale must be between 1 and 100,000 square kilometers',
        severity: 'error'
      });
    }

    // Agent count validation
    if (cartographer.agentCount < 1 || cartographer.agentCount > 10000) {
      errors.push({
        field: 'cartographer.agentCount',
        message: 'Agent count must be between 1 and 10,000',
        severity: 'error'
      });
    }

    // Connectivity requirements
    if (cartographer.connectivityRequirements.minConnectivity < 0 ||
        cartographer.connectivityRequirements.minConnectivity > 1) {
      errors.push({
        field: 'cartographer.connectivityRequirements.minConnectivity',
        message: 'Minimum connectivity must be between 0 and 1',
        severity: 'error'
      });
    }
  }

  private static validateDirector(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    if (!config.director) {
      if (config.project.scale === GenerationScale.AAA) {
        errors.push({
          field: 'director',
          message: 'Director configuration required for AAA projects',
          severity: 'error'
        });
      }
      return;
    }

    const { director } = config;

    // Chronicle length validation
    if (director.chronicleLength < 1 || director.chronicleLength > 72) {
      errors.push({
        field: 'director.chronicleLength',
        message: 'Chronicle length must be between 1 and 72 stages',
        severity: 'error'
      });
    }

    // Player modeling validation
    if (director.playerModeling.adaptationRate < 0 ||
        director.playerModeling.adaptationRate > 1) {
      errors.push({
        field: 'director.playerModeling.adaptationRate',
        message: 'Adaptation rate must be between 0 and 1',
        severity: 'error'
      });
    }
  }

  private static validateSmith(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    if (!config.smith) {
      if (config.project.scale === GenerationScale.AAA) {
        errors.push({
          field: 'smith',
          message: 'Smith configuration required for AAA projects',
          severity: 'error'
        });
      }
      return;
    }

    const { smith } = config;

    // Performance targets validation
    if (smith.optimizationLevel.targetFPS < 1 || smith.optimizationLevel.targetFPS > 300) {
      errors.push({
        field: 'smith.optimizationLevel.targetFPS',
        message: 'Target FPS must be between 1 and 300',
        severity: 'error'
      });
    }

    // Memory validation
    if (smith.optimizationLevel.maxMemoryMB < 100 || smith.optimizationLevel.maxMemoryMB > 100000) {
      errors.push({
        field: 'smith.optimizationLevel.maxMemoryMB',
        message: 'Max memory must be between 100MB and 100GB',
        severity: 'error'
      });
    }

    // Hardware compatibility checks
    if (smith.targetHardware === HardwareTarget.SWITCH_PRO &&
        smith.shaderQuality === 'raytraced') {
      warnings.push({
        field: 'smith.targetHardware',
        message: 'Switch Pro does not support raytracing',
        suggestion: 'Use "advanced" shader quality for Switch Pro'
      });
    }
  }

  private static validateGraphics(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    const { graphics } = config;

    // Performance targets validation
    if (graphics.performanceTargets.targetFPS < 1 ||
        graphics.performanceTargets.targetFPS > 300) {
      errors.push({
        field: 'graphics.performanceTargets.targetFPS',
        message: 'Target FPS must be between 1 and 300',
        severity: 'error'
      });
    }

    // Engine compatibility checks
    if (graphics.renderingEngine === RenderEngine.WEBGL &&
        graphics.visualQuality.reflections === 'raytraced') {
      warnings.push({
        field: 'graphics.renderingEngine',
        message: 'WebGL does not support raytraced reflections',
        suggestion: 'Use "ssr" or "planar" reflections for WebGL'
      });
    }

    // Platform compatibility
    if (config.project.platforms.includes(Platform.MOBILE) &&
        graphics.performanceTargets.memoryBudget > 1000) {
      warnings.push({
        field: 'graphics.performanceTargets.memoryBudget',
        message: 'Memory budget may be too high for mobile platforms',
        suggestion: 'Reduce memory budget for mobile compatibility'
      });
    }
  }

  private static validateOrchestration(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    const { orchestration } = config;

    // Resource allocation validation
    if (orchestration.resourceAllocation.maxConcurrency < 1 ||
        orchestration.resourceAllocation.maxConcurrency > 16) {
      errors.push({
        field: 'orchestration.resourceAllocation.maxConcurrency',
        message: 'Max concurrency must be between 1 and 16',
        severity: 'error'
      });
    }

    // Timeout validation
    if (orchestration.resourceAllocation.timeoutSeconds < 30 ||
        orchestration.resourceAllocation.timeoutSeconds > 3600) {
      errors.push({
        field: 'orchestration.resourceAllocation.timeoutSeconds',
        message: 'Timeout must be between 30 and 3600 seconds',
        severity: 'error'
      });
    }

    // AAA mode requirements
    if (config.project.scale === GenerationScale.AAA &&
        !orchestration.sovereignControl) {
      warnings.push({
        field: 'orchestration.sovereignControl',
        message: 'Sovereign control recommended for AAA projects',
        suggestion: 'Enable sovereign control for coordinated AAA generation'
      });
    }
  }

  private static validateQuality(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    const { quality } = config;

    // J-metric validation
    if (quality.jMetricTarget < 0 || quality.jMetricTarget > 1) {
      errors.push({
        field: 'quality.jMetricTarget',
        message: 'J-metric target must be between 0 and 1',
        severity: 'error'
      });
    }

    // AAA quality requirements
    if (config.project.scale === GenerationScale.AAA &&
        quality.jMetricTarget < 0.9) {
      warnings.push({
        field: 'quality.jMetricTarget',
        message: 'AAA projects typically require J-metric ≥ 0.9',
        suggestion: 'Consider increasing J-metric target for AAA quality'
      });
    }
  }

  private static validateDeployment(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    const { deployment } = config;

    // Platform compatibility
    if (deployment.targetPlatforms.length === 0) {
      warnings.push({
        field: 'deployment.targetPlatforms',
        message: 'No deployment platforms specified',
        suggestion: 'Specify target platforms for deployment'
      });
    }

    // Platform mismatch
    const configPlatforms = new Set(config.project.platforms);
    const deployPlatforms = new Set(deployment.targetPlatforms);
    const missingPlatforms = [...configPlatforms].filter(p => !deployPlatforms.has(p));

    if (missingPlatforms.length > 0) {
      warnings.push({
        field: 'deployment.targetPlatforms',
        message: `Missing deployment configuration for platforms: ${missingPlatforms.join(', ')}`,
        suggestion: 'Add deployment config for all target platforms'
      });
    }
  }

  private static validateCrossSystemCompatibility(
    config: XANDRIAConfig,
    errors: ConfigValidationError[],
    warnings: ConfigValidationWarning[],
    suggestions: ConfigSuggestion[]
  ): void {
    // Graphics and Smith compatibility
    if (config.smith && config.graphics) {
      if (config.smith.targetHardware === HardwareTarget.SWITCH_PRO &&
          config.graphics.performanceTargets.memoryBudget > 2000) {
        warnings.push({
          field: 'graphics.performanceTargets.memoryBudget',
          message: 'Switch Pro memory budget too high for graphics settings',
          suggestion: 'Reduce memory budget or adjust graphics quality'
        });
      }
    }

    // Cartographer and Director integration
    if (config.cartographer && config.director) {
      if (config.cartographer.worldScale > 50000 &&
          config.director.chronicleLength < 24) {
        warnings.push({
          field: 'director.chronicleLength',
          message: 'Large worlds may benefit from longer chronicles',
          suggestion: 'Consider increasing chronicle length for large worlds'
        });
      }
    }

    // Quality level consistency
    const qualityLevels = [
      config.project.targetQuality,
      config.smith?.shaderQuality,
      config.graphics.visualQuality.shadows
    ].filter(Boolean);

    if (qualityLevels.length > 1) {
      const inconsistent = qualityLevels.some(level => level !== qualityLevels[0]);
      if (inconsistent) {
        warnings.push({
          field: 'quality.consistency',
          message: 'Quality levels are inconsistent across systems',
          suggestion: 'Align quality settings for optimal performance'
        });
      }
    }
  }

  private static estimateGenerationTime(config: XANDRIAConfig): number {
    let baseTime = 5; // Indie baseline

    if (config.project.scale === GenerationScale.AAA) {
      baseTime = 120; // AAA baseline

      // World scale factor
      if (config.cartographer) {
        baseTime += (config.cartographer.worldScale / 1000) * 2;
        baseTime += config.cartographer.agentCount / 10;
      }

      // Director complexity
      if (config.director) {
        baseTime += config.director.chronicleLength * 0.5;
      }

      // Smith optimization
      if (config.smith) {
        if (config.smith.shaderQuality === 'raytraced') baseTime += 60;
        if (config.smith.targetHardware === HardwareTarget.RTX_4090) baseTime *= 0.8;
      }
    }

    // Quality factor
    switch (config.project.targetQuality) {
      case QualityLevel.ULTRA: baseTime *= 1.5; break;
      case QualityLevel.HIGH: baseTime *= 1.2; break;
      case QualityLevel.LOW: baseTime *= 0.8; break;
    }

    // Platform factor
    baseTime *= (1 + config.project.platforms.length * 0.1);

    return Math.round(baseTime);
  }

  /**
   * Create default configuration for given scale
   */
  static createDefault(scale: GenerationScale): XANDRIAConfig {
    const baseConfig: XANDRIAConfig = {
      project: {
        name: 'XANDRIA Project',
        version: '1.0.0',
        scale,
        platforms: [Platform.WEB],
        targetQuality: QualityLevel.MEDIUM,
        estimatedDuration: scale === GenerationScale.AAA ? 120 : 5
      },
      xuaxun: {
        operators: [
          { category: OperatorCategory.LOGIC, enabled: true, priority: 1 },
          { category: OperatorCategory.CREATION, enabled: true, priority: 1 },
          { category: OperatorCategory.TRANSFORMATION, enabled: true, priority: 1 },
          { category: OperatorCategory.OPTIMIZATION, enabled: true, priority: 1 },
          { category: OperatorCategory.VALIDATION, enabled: true, priority: 1 }
        ],
        synthesisMode: scale === GenerationScale.AAA ? SynthesisMode.DEEP : SynthesisMode.BALANCED,
        operatorWeights: {},
        recursionDepth: 3,
        qualityThreshold: 0.8
      },
      graphics: {
        renderingEngine: RenderEngine.THREE_JS,
        visualQuality: {
          textureFiltering: TextureFiltering.ANISOTROPIC,
          antiAliasing: AntiAliasing.MSAA,
          shadows: ShadowQuality.HIGH,
          reflections: ReflectionQuality.SSR
        },
        performanceTargets: {
          targetFPS: 60,
          minFPS: 30,
          maxFrameTime: 16.67,
          memoryBudget: scale === GenerationScale.AAA ? 2000 : 500
        },
        postProcessing: {
          bloom: true,
          depthOfField: scale === GenerationScale.AAA,
          motionBlur: true,
          colorGrading: true,
          vignette: false
        },
        lighting: {
          globalIllumination: scale === GenerationScale.AAA ? GIQuality.REALTIME : GIQuality.BAKED,
          lightCount: scale === GenerationScale.AAA ? 50 : 10,
          shadowCascades: 4,
          ambientOcclusion: AOQuality.SSAO
        }
      },
      orchestration: {
        sovereignControl: scale === GenerationScale.AAA,
        crossSystemSync: true,
        eventDriven: true,
        qualityGates: [
          { stage: 'world-gen', metric: 'connectivity', threshold: 0.8, action: GateAction.WARN },
          { stage: 'asset-gen', metric: 'performance', threshold: 0.9, action: GateAction.STOP }
        ],
        resourceAllocation: {
          maxConcurrency: scale === GenerationScale.AAA ? 8 : 4,
          memoryLimit: scale === GenerationScale.AAA ? 8000 : 2000,
          timeoutSeconds: scale === GenerationScale.AAA ? 600 : 60,
          prioritySystem: SystemPriority.BALANCED
        }
      },
      quality: {
        jMetricTarget: scale === GenerationScale.AAA ? 0.95 : 0.8,
        automatedTesting: true,
        humanReview: scale === GenerationScale.AAA,
        benchmarkAgainst: [],
        validationRules: [
          { name: 'performance', type: ValidationType.PERFORMANCE, parameters: { minFps: 30 }, severity: ValidationSeverity.ERROR },
          { name: 'memory', type: ValidationType.PERFORMANCE, parameters: { maxMemory: 1000 }, severity: ValidationSeverity.WARN }
        ]
      },
      deployment: {
        targetPlatforms: [Platform.WEB],
        buildOptimization: true,
        compression: true,
        cdnDeployment: false,
        monitoring: {
          performanceTracking: scale === GenerationScale.AAA,
          errorReporting: true,
          usageAnalytics: scale === GenerationScale.AAA,
          healthChecks: true
        }
      }
    };

    // Add AAA-specific configurations
    if (scale === GenerationScale.AAA) {
      baseConfig.cartographer = {
        worldScale: 10000,
        agentCount: 100,
        biomeSettings: {
          primary: BiomeType.URBAN,
          transitions: true
        },
        connectivityRequirements: {
          minConnectivity: 0.85,
          bottleneckLimit: 5,
          deadZoneThreshold: 10,
          pathOptimization: true
        },
        narrativePurpose: true,
        agentProfiles: [
          { type: AgentProfileType.EXPLORER, count: 40, behaviorWeights: { curiosity: 0.8, caution: 0.2 } },
          { type: AgentProfileType.COMBATANT, count: 30, behaviorWeights: { aggression: 0.7, strategy: 0.3 } },
          { type: AgentProfileType.SPEEDRUNNER, count: 20, behaviorWeights: { speed: 0.9, precision: 0.1 } },
          { type: AgentProfileType.COLLECTOR, count: 10, behaviorWeights: { thoroughness: 0.8, efficiency: 0.2 } }
        ]
      };

      baseConfig.director = {
        narrativeDepth: NarrativeLevel.EPIC,
        encounterComplexity: {
          maxDifficulty: 10,
          scalingRate: 0.1,
          variety: EncounterVariety.HIGH,
          adaptiveDifficulty: true
        },
        entropyManagement: true,
        chronicleLength: 48,
        pacingAlgorithm: PacingAlgorithm.DYNAMIC,
        playerModeling: {
          telemetryCollection: true,
          adaptationRate: 0.3,
          frustrationThreshold: 0.7,
          engagementModeling: true
        }
      };

      baseConfig.smith = {
        targetHardware: HardwareTarget.RTX_4090,
        shaderQuality: ShaderLevel.ADVANCED,
        optimizationLevel: {
          targetFPS: 60,
          maxMemoryMB: 4000,
          lodLevels: 4,
          compressionLevel: CompressionLevel.MEDIUM
        },
        assetPipeline: {
          textureResolution: TextureResolution.ULTRA,
          meshOptimization: true,
          shaderCompilation: ShaderCompilation.OPTIMIZED,
          bundleStrategy: BundleStrategy.MODULAR
        },
        technicalStandards: {
          pbrCompliance: true,
          naniteSupport: true,
          raytracingSupport: true,
          featureFlags: {
            transparency: true,
            subsurfaceScattering: true,
            anisotropy: true,
            parallaxOcclusion: true,
            tessellation: true,
            computeShaders: true
          }
        }
      };

      baseConfig.project.platforms = [Platform.WEB, Platform.DESKTOP, Platform.CONSOLE];
      baseConfig.project.targetQuality = QualityLevel.ULTRA;
      baseConfig.deployment.targetPlatforms = [Platform.WEB, Platform.DESKTOP];
    }

    return baseConfig;
  }
}
