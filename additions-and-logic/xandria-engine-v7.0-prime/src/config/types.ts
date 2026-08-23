/**
 * XANDRIA v3.0 - Unified Configuration Schema
 * Supports both indie and AAA generation modes
 */

// === BASE TYPES ===

export enum GenerationScale {
  INDIE = 'indie',      // <5s, web-focused, simple projects
  AAA = 'aaa'          // 30-300s, multi-platform, complex systems
}

export enum Platform {
  WEB = 'web',
  DESKTOP = 'desktop',
  MOBILE = 'mobile',
  CONSOLE = 'console'
}

export enum QualityLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  ULTRA = 'ultra'
}

// === XUAXUN ENGINE CONFIGURATION ===

export interface XUAXUNConfig {
  operators: OperatorSelection[];
  synthesisMode: SynthesisMode;
  operatorWeights: Record<string, number>;
  recursionDepth: number;
  qualityThreshold: number;
}

export enum SynthesisMode {
  FAST = 'fast',        // Quick generation, fewer operators
  BALANCED = 'balanced', // Standard quality/cost ratio
  DEEP = 'deep',        // Maximum operator utilization
  EXPERIMENTAL = 'experimental' // Cutting-edge combinations
}

export interface OperatorSelection {
  category: OperatorCategory;
  enabled: boolean;
  priority: number;
  customWeights?: Record<string, number>;
}

export enum OperatorCategory {
  LOGIC = 'logic',
  CREATION = 'creation',
  TRANSFORMATION = 'transformation',
  OPTIMIZATION = 'optimization',
  VALIDATION = 'validation'
}

// === CARTOGRAPHER CONFIGURATION ===

export interface CartographerConfig {
  worldScale: number;           // Square kilometers (10-100,000)
  agentCount: number;          // NPC agents for playtesting (10-10,000)
  biomeSettings: BiomeConfig;
  connectivityRequirements: ConnectivityConfig;
  narrativePurpose: boolean;   // Generate story-driven assets
  agentProfiles: AgentProfileConfig[];
}

export interface BiomeConfig {
  primary: BiomeType;
  secondary?: BiomeType;
  transitions: boolean;
  customPalette?: ColorPalette;
}

export enum BiomeType {
  GOTHIC = 'gothic',
  OVERGROWN = 'overgrown',
  INDUSTRIAL = 'industrial',
  CELESTIAL = 'celestial',
  URBAN = 'urban',
  WILDERNESS = 'wilderness',
  UNDERGROUND = 'underground'
}

export interface ConnectivityConfig {
  minConnectivity: number;     // 0-1 scale
  bottleneckLimit: number;     // Max bottlenecks allowed
  deadZoneThreshold: number;   // Max dead zones allowed
  pathOptimization: boolean;
}

export interface AgentProfileConfig {
  type: AgentProfileType;
  count: number;
  behaviorWeights: Record<string, number>;
}

export enum AgentProfileType {
  EXPLORER = 'explorer',
  COMBATANT = 'combatant',
  SPEEDRUNNER = 'speedrunner',
  COLLECTOR = 'collector',
  SOCIAL = 'social'
}

// === DIRECTOR CONFIGURATION ===

export interface DirectorConfig {
  narrativeDepth: NarrativeLevel;
  encounterComplexity: EncounterConfig;
  entropyManagement: boolean;
  chronicleLength: number;     // 1-72 stages
  pacingAlgorithm: PacingAlgorithm;
  playerModeling: PlayerModelConfig;
}

export enum NarrativeLevel {
  SIMPLE = 'simple',           // Basic quest structure
  COMPLEX = 'complex',         // Branching narratives
  EPIC = 'epic',              // Multi-act stories
  LEGENDARY = 'legendary'     // Emergent storytelling
}

export interface EncounterConfig {
  maxDifficulty: number;
  scalingRate: number;
  variety: EncounterVariety;
  adaptiveDifficulty: boolean;
}

export enum EncounterVariety {
  LOW = 'low',                // Few encounter types
  MEDIUM = 'medium',          // Balanced variety
  HIGH = 'high',              // Rich encounter ecosystem
  EXTREME = 'extreme'         // Maximum diversity
}

export enum PacingAlgorithm {
  CLASSIC = 'classic',        // Traditional game pacing
  DYNAMIC = 'dynamic',        // Real-time adaptation
  EMERGENT = 'emergent',      // Player-driven pacing
  CHAOTIC = 'chaotic'         // Unpredictable flow
}

export interface PlayerModelConfig {
  telemetryCollection: boolean;
  adaptationRate: number;     // How quickly to adapt (0-1)
  frustrationThreshold: number;
  engagementModeling: boolean;
}

// === SMITH CONFIGURATION ===

export interface SmithConfig {
  targetHardware: HardwareTarget;
  shaderQuality: ShaderLevel;
  optimizationLevel: OptimizationConfig;
  assetPipeline: AssetPipelineConfig;
  technicalStandards: TechnicalStandards;
}

export enum HardwareTarget {
  RTX_3090 = 'rtx-3090',
  RTX_4090 = 'rtx-4090',
  PS5 = 'ps5',
  XBOX_SERIES_X = 'xbox-series-x',
  SWITCH_PRO = 'switch-pro',
  GENERIC_PC = 'generic-pc'
}

export enum ShaderLevel {
  BASIC = 'basic',            // Simple shaders
  ADVANCED = 'advanced',      // Complex materials
  RAYTRACED = 'raytraced',    // Full raytracing
  EXPERIMENTAL = 'experimental' // Cutting-edge techniques
}

export interface OptimizationConfig {
  targetFPS: number;
  maxMemoryMB: number;
  lodLevels: number;
  compressionLevel: CompressionLevel;
}

export enum CompressionLevel {
  NONE = 'none',
  LIGHT = 'light',
  MEDIUM = 'medium',
  AGGRESSIVE = 'aggressive'
}

export interface AssetPipelineConfig {
  textureResolution: TextureResolution;
  meshOptimization: boolean;
  shaderCompilation: ShaderCompilation;
  bundleStrategy: BundleStrategy;
}

export enum TextureResolution {
  LOW = 'low',       // 512x512
  MEDIUM = 'medium', // 1024x1024
  HIGH = 'high',     // 2048x2048
  ULTRA = 'ultra'    // 4096x4096
}

export enum ShaderCompilation {
  INTERPRETED = 'interpreted',
  COMPILED = 'compiled',
  OPTIMIZED = 'optimized'
}

export enum BundleStrategy {
  SINGLE = 'single',
  MODULAR = 'modular',
  STREAMING = 'streaming'
}

export interface TechnicalStandards {
  pbrCompliance: boolean;
  naniteSupport: boolean;
  raytracingSupport: boolean;
  featureFlags: FeatureFlags;
}

export interface FeatureFlags {
  transparency: boolean;
  subsurfaceScattering: boolean;
  anisotropy: boolean;
  parallaxOcclusion: boolean;
  tessellation: boolean;
  computeShaders: boolean;
}

// === GRAPHICS CONFIGURATION ===

export interface GraphicsConfig {
  renderingEngine: RenderEngine;
  visualQuality: VisualQuality;
  performanceTargets: PerformanceTargets;
  postProcessing: PostProcessingConfig;
  lighting: LightingConfig;
}

export enum RenderEngine {
  WEBGL = 'webgl',
  THREE_JS = 'three-js',
  CUSTOM = 'custom',
  UNREAL = 'unreal',
  UNITY = 'unity'
}

export interface VisualQuality {
  textureFiltering: TextureFiltering;
  antiAliasing: AntiAliasing;
  shadows: ShadowQuality;
  reflections: ReflectionQuality;
}

export enum TextureFiltering {
  NEAREST = 'nearest',
  BILINEAR = 'bilinear',
  TRILINEAR = 'trilinear',
  ANISOTROPIC = 'anisotropic'
}

export enum AntiAliasing {
  NONE = 'none',
  FXAA = 'fxaa',
  MSAA = 'msaa',
  TAA = 'taa'
}

export enum ShadowQuality {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  ULTRA = 'ultra'
}

export enum ReflectionQuality {
  NONE = 'none',
  PLANAR = 'planar',
  SSR = 'ssr',
  RAYTRACED = 'raytraced'
}

export interface PerformanceTargets {
  targetFPS: number;
  minFPS: number;
  maxFrameTime: number;
  memoryBudget: number;
}

export interface PostProcessingConfig {
  bloom: boolean;
  depthOfField: boolean;
  motionBlur: boolean;
  colorGrading: boolean;
  vignette: boolean;
}

export interface LightingConfig {
  globalIllumination: GIQuality;
  lightCount: number;
  shadowCascades: number;
  ambientOcclusion: AOQuality;
}

export enum GIQuality {
  NONE = 'none',
  BAKED = 'baked',
  REALTIME = 'realtime',
  RAYTRACED = 'raytraced'
}

export enum AOQuality {
  NONE = 'none',
  SSAO = 'ssao',
  HBAO = 'hbao',
  RTAO = 'rtao'
}

// === UNIFIED CONFIGURATION SCHEMA ===

export interface XANDRIAConfig {
  // Project metadata
  project: ProjectConfig;

  // System-specific configurations
  xuaxun: XUAXUNConfig;
  cartographer?: CartographerConfig;    // Optional for AAA mode
  director?: DirectorConfig;           // Optional for AAA mode
  smith?: SmithConfig;                 // Optional for AAA mode
  graphics: GraphicsConfig;

  // Integration settings
  orchestration: OrchestrationConfig;
  quality: QualityConfig;
  deployment: DeploymentConfig;
}

export interface ProjectConfig {
  name: string;
  description?: string;
  version: string;
  scale: GenerationScale;
  platforms: Platform[];
  targetQuality: QualityLevel;
  estimatedDuration: number;           // Estimated generation time in seconds
  tags?: string[];
}

export interface OrchestrationConfig {
  sovereignControl: boolean;           // Enable Sovereign Command Hub
  crossSystemSync: boolean;            // Enable inter-system communication
  eventDriven: boolean;               // Use event-driven architecture
  qualityGates: QualityGate[];        // Quality checkpoints
  resourceAllocation: ResourceAllocation;
}

export interface QualityGate {
  stage: string;
  metric: string;
  threshold: number;
  action: GateAction;
}

export enum GateAction {
  CONTINUE = 'continue',
  WARN = 'warn',
  STOP = 'stop',
  ROLLBACK = 'rollback'
}

export interface ResourceAllocation {
  maxConcurrency: number;
  memoryLimit: number;
  timeoutSeconds: number;
  prioritySystem: SystemPriority;
}

export enum SystemPriority {
  BALANCED = 'balanced',
  XUAXUN_FIRST = 'xuaxun-first',
  GRAPHICS_FIRST = 'graphics-first',
  AAA_SYSTEMS_FIRST = 'aaa-systems-first'
}

export interface QualityConfig {
  jMetricTarget: number;              // Target quality score (0-1)
  automatedTesting: boolean;
  humanReview: boolean;
  benchmarkAgainst: string[];         // Previous projects to compare against
  validationRules: ValidationRule[];
}

export interface ValidationRule {
  name: string;
  type: ValidationType;
  parameters: Record<string, any>;
  severity: ValidationSeverity;
}

export enum ValidationType {
  PERFORMANCE = 'performance',
  FUNCTIONALITY = 'functionality',
  VISUAL = 'visual',
  COMPATIBILITY = 'compatibility',
  SECURITY = 'security'
}

export enum ValidationSeverity {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  CRITICAL = 'critical'
}

export interface DeploymentConfig {
  targetPlatforms: Platform[];
  buildOptimization: boolean;
  compression: boolean;
  cdnDeployment: boolean;
  monitoring: MonitoringConfig;
}

export interface MonitoringConfig {
  performanceTracking: boolean;
  errorReporting: boolean;
  usageAnalytics: boolean;
  healthChecks: boolean;
}

// === COLOR AND VISUAL TYPES ===

export interface ColorPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
}

// === LEGACY COMPATIBILITY ===

export interface LegacyConfig {
  // Backward compatibility fields
  operators?: any[];
  graphics?: any;
  tests?: any;
  // Migration helpers
  migrationVersion?: string;
  deprecatedFields?: string[];
}

// === UTILITY TYPES ===

export type ConfigSection = keyof XANDRIAConfig;
export type SystemConfig = XUAXUNConfig | CartographerConfig | DirectorConfig | SmithConfig | GraphicsConfig;
export type OptionalAAAConfig = Partial<Pick<XANDRIAConfig, 'cartographer' | 'director' | 'smith'>>;

// === CONFIGURATION VALIDATION ===

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
  warnings: ConfigValidationWarning[];
  suggestions: ConfigSuggestion[];
}

export interface ConfigValidationError {
  field: string;
  message: string;
  severity: 'error' | 'critical';
}

export interface ConfigValidationWarning {
  field: string;
  message: string;
  suggestion: string;
}

export interface ConfigSuggestion {
  field: string;
  message: string;
  action: 'add' | 'modify' | 'remove';
  value?: any;
}
