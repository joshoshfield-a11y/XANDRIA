/**
 * XANDRIA SHERESHEVSKY BRIDGE
 * Synesthetic cross-modal perception system
 * Maps code semantics to simultaneous multi-sensory experiences
 * Based on synesthesia principles and neural cross-modal binding
 */

import { operatorRegistry } from '../engine/operators/OperatorRegistry';
import { stochasticEvolutionEngine } from '../stochastic/StochasticEvolutionEngine';

export interface SynestheticMapping {
  codeElement: string;
  sensoryBindings: {
    visual: VisualSensation;
    auditory: AuditorySensation;
    tactile: TactileSensation;
    olfactory?: OlfactorySensation;
    gustatory?: GustatorySensation;
  };
  intensity: number;
  coherence: number;
  metadata: {
    source: string;
    confidence: number;
    timestamp: number;
  };
}

export interface VisualSensation {
  hue: number;        // 0-360 degrees
  saturation: number; // 0-1
  brightness: number; // 0-1
  texture: string;    // 'smooth', 'rough', 'metallic', 'organic', etc.
  geometry: string;   // 'sphere', 'cube', 'wave', 'spiral', etc.
  scale: number;      // Relative size
  animation: string;  // 'pulse', 'rotate', 'flow', 'static', etc.
}

export interface AuditorySensation {
  frequency: number;    // Hz
  amplitude: number;    // 0-1
  waveform: string;     // 'sine', 'square', 'sawtooth', 'noise', etc.
  harmony: number[];    // Array of harmonic frequencies
  rhythm: number;       // BPM
  timbre: string;       // 'warm', 'bright', 'dark', 'metallic', etc.
  duration: number;     // seconds
}

export interface TactileSensation {
  pressure: number;     // 0-1 (light to heavy)
  temperature: number;  // 0-1 (cold to hot)
  texture: string;      // 'smooth', 'rough', 'sticky', 'bumpy', etc.
  vibration: number;    // Frequency in Hz
  pattern: string;      // 'continuous', 'pulsing', 'wave', 'random'
  location: string;     // Body part mapping
}

export interface OlfactorySensation {
  primary: string;      // Base scent family
  intensity: number;    // 0-1
  complexity: number;   // Number of scent layers
  duration: number;     // Persistence in seconds
  association: string;  // Semantic association
}

export interface GustatorySensation {
  primary: string;      // 'sweet', 'sour', 'salty', 'bitter', 'umami'
  intensity: number;    // 0-1
  complexity: number;   // Flavor profile richness
  aftertaste: string;   // Lingering flavor
  association: string;  // Semantic association
}

export interface SynestheticContext {
  userProfile: {
    synestheticType: string;    // Individual synesthesia variant
    sensoryPreferences: string[];
    intensityThreshold: number;
    adaptationRate: number;
  };
  environment: {
    ambientNoise: number;
    lighting: number;
    temperature: number;
    userState: 'focused' | 'distracted' | 'fatigued' | 'engaged';
  };
  session: {
    duration: number;
    adaptationLevel: number;
    coherenceScore: number;
  };
}

export interface SynestheticExperience {
  mappings: SynestheticMapping[];
  overallCoherence: number;
  sensoryHarmony: number;
  cognitiveLoad: number;
  userAdaptation: number;
  metadata: {
    sessionId: string;
    timestamp: number;
    duration: number;
    modalities: string[];
  };
}

export class ShereshevskyBridge {
  private context: SynestheticContext;
  private activeMappings: Map<string, SynestheticMapping> = new Map();
  private sensoryHistory: SynestheticExperience[] = new Map();
  private neuralBindings: Map<string, any> = new Map();

  constructor(context: Partial<SynestheticContext> = {}) {
    this.context = {
      userProfile: {
        synestheticType: 'grapheme-color',
        sensoryPreferences: ['visual', 'auditory', 'tactile'],
        intensityThreshold: 0.3,
        adaptationRate: 0.1,
        ...context.userProfile
      },
      environment: {
        ambientNoise: 0.2,
        lighting: 0.7,
        temperature: 0.5,
        userState: 'focused',
        ...context.environment
      },
      session: {
        duration: 0,
        adaptationLevel: 0,
        coherenceScore: 0.8,
        ...context.session
      }
    };

    this.initializeNeuralBindings();
  }

  /**
   * Generate synesthetic experience from code analysis
   */
  async generateSynestheticExperience(
    codeElements: Array<{ type: string; content: string; complexity: number; location?: any }>
  ): Promise<SynestheticExperience> {
    const startTime = Date.now();
    console.log('[ShereshevskyBridge] Generating synesthetic experience for', codeElements.length, 'elements');

    const mappings: SynestheticMapping[] = [];

    for (const element of codeElements) {
      const mapping = await this.createSynestheticMapping(element);
      if (mapping.intensity >= this.context.userProfile.intensityThreshold) {
        mappings.push(mapping);
        this.activeMappings.set(element.content, mapping);
      }
    }

    // Calculate overall experience metrics
    const overallCoherence = this.calculateSensoryCoherence(mappings);
    const sensoryHarmony = this.calculateSensoryHarmony(mappings);
    const cognitiveLoad = this.calculateCognitiveLoad(mappings);
    const userAdaptation = this.adaptToUserExperience(mappings);

    const experience: SynestheticExperience = {
      mappings,
      overallCoherence,
      sensoryHarmony,
      cognitiveLoad,
      userAdaptation,
      metadata: {
        sessionId: `syn-${Date.now()}`,
        timestamp: Date.now(),
        duration: Date.now() - startTime,
        modalities: this.getActiveModalities(mappings)
      }
    };

    // Store in history
    this.sensoryHistory.set(experience.metadata.sessionId, experience);

    // Update session context
    this.context.session.adaptationLevel += userAdaptation * 0.1;
    this.context.session.coherenceScore = overallCoherence;

    console.log(`[ShereshevskyBridge] Experience generated: ${mappings.length} mappings, coherence: ${(overallCoherence * 100).toFixed(1)}%`);

    return experience;
  }

  /**
   * Create synesthetic mapping for a code element
   */
  private async createSynestheticMapping(element: any): Promise<SynestheticMapping> {
    const { type, content, complexity, location } = element;

    // Generate base sensory bindings
    const visual = this.mapToVisualSensation(type, content, complexity);
    const auditory = this.mapToAuditorySensation(type, content, complexity);
    const tactile = this.mapToTactileSensation(type, content, complexity);

    // Add optional modalities based on context
    const olfactory = this.shouldIncludeOlfactory() ?
      this.mapToOlfactorySensation(type, content) : undefined;
    const gustatory = this.shouldIncludeGustatory() ?
      this.mapToGustatorySensation(type, content) : undefined;

    // Calculate intensity and coherence
    const intensity = this.calculateSensoryIntensity(element);
    const coherence = this.calculateMappingCoherence({ visual, auditory, tactile, olfactory, gustatory });

    // Apply user adaptation
    this.adaptSensoryBindings({ visual, auditory, tactile, olfactory, gustatory });

    const mapping: SynestheticMapping = {
      codeElement: content,
      sensoryBindings: {
        visual,
        auditory,
        tactile,
        olfactory,
        gustatory
      },
      intensity,
      coherence,
      metadata: {
        source: type,
        confidence: this.calculateConfidence(element),
        timestamp: Date.now()
      }
    };

    return mapping;
  }

  /**
   * Map code element to visual sensation
   */
  private mapToVisualSensation(type: string, content: string, complexity: number): VisualSensation {
    // Create visual mapping based on code semantics
    const hash = this.simpleHash(content);
    const normalizedHash = hash / 1000000; // Normalize

    const visualMappings: Record<string, Partial<VisualSensation>> = {
      'function': { geometry: 'cylinder', texture: 'smooth', animation: 'pulse' },
      'variable': { geometry: 'cube', texture: 'metallic', animation: 'static' },
      'loop': { geometry: 'torus', texture: 'rough', animation: 'rotate' },
      'condition': { geometry: 'pyramid', texture: 'smooth', animation: 'pulse' },
      'class': { geometry: 'sphere', texture: 'organic', animation: 'flow' },
      'operator': { geometry: 'tetrahedron', texture: 'metallic', animation: 'static' }
    };

    const baseMapping = visualMappings[type] || { geometry: 'cube', texture: 'smooth', animation: 'static' };

    return {
      hue: (normalizedHash * 360) % 360,
      saturation: 0.5 + complexity * 0.5,
      brightness: 0.3 + complexity * 0.7,
      texture: baseMapping.texture || 'smooth',
      geometry: baseMapping.geometry || 'cube',
      scale: 0.5 + complexity * 1.5,
      animation: baseMapping.animation || 'static'
    };
  }

  /**
   * Map code element to auditory sensation
   */
  private mapToAuditorySensation(type: string, content: string, complexity: number): AuditorySensation {
    const hash = this.simpleHash(content);
    const baseFrequency = 200 + (hash % 800); // 200-1000 Hz range

    const auditoryMappings: Record<string, Partial<AuditorySensation>> = {
      'function': { waveform: 'sine', timbre: 'warm' },
      'variable': { waveform: 'square', timbre: 'bright' },
      'loop': { waveform: 'sawtooth', timbre: 'metallic' },
      'condition': { waveform: 'sine', timbre: 'warm' },
      'class': { waveform: 'sine', timbre: 'dark' },
      'operator': { waveform: 'square', timbre: 'bright' }
    };

    const baseMapping = auditoryMappings[type] || { waveform: 'sine', timbre: 'warm' };

    return {
      frequency: baseFrequency * (0.5 + complexity * 0.5),
      amplitude: 0.3 + complexity * 0.7,
      waveform: baseMapping.waveform || 'sine',
      harmony: [baseFrequency * 2, baseFrequency * 3], // Simple harmonics
      rhythm: 60 + complexity * 120, // 60-180 BPM
      timbre: baseMapping.timbre || 'warm',
      duration: 0.5 + complexity * 2.0
    };
  }

  /**
   * Map code element to tactile sensation
   */
  private mapToTactileSensation(type: string, content: string, complexity: number): TactileSensation {
    const hash = this.simpleHash(content);
    const normalizedHash = hash / 1000000;

    const tactileMappings: Record<string, Partial<TactileSensation>> = {
      'function': { texture: 'smooth', pattern: 'continuous' },
      'variable': { texture: 'rough', pattern: 'static' },
      'loop': { texture: 'bumpy', pattern: 'pulsing' },
      'condition': { texture: 'smooth', pattern: 'wave' },
      'class': { texture: 'organic', pattern: 'flow' },
      'operator': { texture: 'metallic', pattern: 'static' }
    };

    const baseMapping = tactileMappings[type] || { texture: 'smooth', pattern: 'continuous' };

    return {
      pressure: 0.2 + complexity * 0.8,
      temperature: 0.3 + normalizedHash * 0.7,
      texture: baseMapping.texture || 'smooth',
      vibration: 10 + complexity * 50, // 10-60 Hz
      pattern: baseMapping.pattern || 'continuous',
      location: this.mapToBodyLocation(type, hash)
    };
  }

  /**
   * Map to olfactory sensation (optional)
   */
  private mapToOlfactorySensation(type: string, content: string): OlfactorySensation {
    const olfactoryMappings: Record<string, string> = {
      'function': 'fresh',
      'variable': 'metallic',
      'loop': 'spicy',
      'condition': 'citrus',
      'class': 'woody',
      'operator': 'sharp'
    };

    const primary = olfactoryMappings[type] || 'neutral';

    return {
      primary,
      intensity: 0.3,
      complexity: 1,
      duration: 2.0,
      association: `${primary} - ${type} construct`
    };
  }

  /**
   * Map to gustatory sensation (optional)
   */
  private mapToGustatorySensation(type: string, content: string): GustatorySensation {
    const gustatoryMappings: Record<string, string> = {
      'function': 'sweet',
      'variable': 'salty',
      'loop': 'sour',
      'condition': 'bitter',
      'class': 'umami',
      'operator': 'sharp'
    };

    const primary = gustatoryMappings[type] || 'neutral';

    return {
      primary,
      intensity: 0.2,
      complexity: 1,
      aftertaste: primary,
      association: `${primary} - ${type} logic`
    };
  }

  /**
   * Map code element to body location for tactile feedback
   */
  private mapToBodyLocation(type: string, hash: number): string {
    const locations = [
      'fingertips', 'palms', 'wrists', 'forearms', 'shoulders',
      'neck', 'chest', 'back', 'thighs', 'calves', 'feet'
    ];

    const index = Math.abs(hash) % locations.length;
    return locations[index];
  }

  /**
   * Calculate sensory intensity for element
   */
  private calculateSensoryIntensity(element: any): number {
    const { complexity, type } = element;

    // Base intensity from complexity
    let intensity = complexity * 0.7;

    // Adjust based on element type significance
    const typeWeights: Record<string, number> = {
      'function': 1.2,
      'class': 1.1,
      'loop': 1.0,
      'condition': 0.9,
      'variable': 0.8,
      'operator': 0.6
    };

    intensity *= typeWeights[type] || 0.7;

    // Apply user adaptation
    intensity *= (1 - this.context.session.adaptationLevel * 0.3);

    return Math.min(1.0, Math.max(0.0, intensity));
  }

  /**
   * Calculate coherence between sensory modalities
   */
  private calculateMappingCoherence(bindings: any): number {
    // Simplified coherence calculation
    // In practice, this would analyze cross-modal consistency
    const modalities = Object.values(bindings).filter(b => b !== undefined);
    if (modalities.length <= 1) return 1.0;

    // Calculate average coherence between modality pairs
    let totalCoherence = 0;
    let pairCount = 0;

    for (let i = 0; i < modalities.length; i++) {
      for (let j = i + 1; j < modalities.length; j++) {
        const coherence = this.calculateModalityPairCoherence(modalities[i], modalities[j]);
        totalCoherence += coherence;
        pairCount++;
      }
    }

    return pairCount > 0 ? totalCoherence / pairCount : 1.0;
  }

  /**
   * Calculate coherence between two modalities
   */
  private calculateModalityPairCoherence(modality1: any, modality2: any): number {
    // Simplified cross-modal coherence
    // Real implementation would use more sophisticated analysis
    const similarity = Math.random() * 0.4 + 0.6; // 0.6-1.0 range
    return similarity;
  }

  /**
   * Adapt sensory bindings to user preferences and context
   */
  private adaptSensoryBindings(bindings: any): void {
    const preferences = this.context.userProfile.sensoryPreferences;
    const environment = this.context.environment;

    // Adjust intensities based on environment
    Object.keys(bindings).forEach(modality => {
      if (bindings[modality]) {
        // Reduce intensity in noisy environments
        if (environment.ambientNoise > 0.7 && modality === 'auditory') {
          bindings[modality].amplitude *= 0.7;
        }

        // Adjust based on lighting
        if (environment.lighting < 0.3 && modality === 'visual') {
          bindings[modality].brightness *= 1.3;
        }

        // User state adjustments
        if (this.context.environment.userState === 'fatigued') {
          if (modality === 'intensity') {
            bindings[modality] *= 0.8;
          }
        }
      }
    });
  }

  /**
   * Calculate confidence in synesthetic mapping
   */
  private calculateConfidence(element: any): number {
    const { complexity, type } = element;

    // Base confidence from element characteristics
    let confidence = 0.7 + complexity * 0.3;

    // Type-specific adjustments
    const typeConfidences: Record<string, number> = {
      'function': 0.9,
      'class': 0.85,
      'variable': 0.75,
      'operator': 0.8,
      'loop': 0.8,
      'condition': 0.8
    };

    confidence *= typeConfidences[type] || 0.7;

    return Math.min(1.0, confidence);
  }

  /**
   * Calculate overall sensory coherence
   */
  private calculateSensoryCoherence(mappings: SynestheticMapping[]): number {
    if (mappings.length === 0) return 1.0;

    const coherences = mappings.map(m => m.coherence);
    return coherences.reduce((sum, c) => sum + c, 0) / coherences.length;
  }

  /**
   * Calculate sensory harmony across modalities
   */
  private calculateSensoryHarmony(mappings: SynestheticMapping[]): number {
    // Simplified harmony calculation
    const avgIntensity = mappings.reduce((sum, m) => sum + m.intensity, 0) / mappings.length;
    const intensityVariance = mappings.reduce((sum, m) => sum + Math.pow(m.intensity - avgIntensity, 2), 0) / mappings.length;

    // Lower variance = higher harmony
    return Math.max(0, 1 - intensityVariance);
  }

  /**
   * Calculate cognitive load of synesthetic experience
   */
  private calculateCognitiveLoad(mappings: SynestheticMapping[]): number {
    const modalityCount = this.getActiveModalities(mappings).length;
    const mappingCount = mappings.length;

    // Cognitive load increases with modalities and mappings
    const load = (modalityCount * 0.2) + (mappingCount * 0.1);
    return Math.min(1.0, load);
  }

  /**
   * Adapt system to user experience patterns
   */
  private adaptToUserExperience(mappings: SynestheticMapping[]): number {
    const adaptation = this.context.userProfile.adaptationRate;
    const coherence = this.calculateSensoryCoherence(mappings);

    // Increase adaptation if coherence is high
    const adaptationIncrease = coherence * adaptation * 0.1;
    this.context.session.adaptationLevel = Math.min(1.0, this.context.session.adaptationLevel + adaptationIncrease);

    return adaptationIncrease;
  }

  /**
   * Get active sensory modalities
   */
  private getActiveModalities(mappings: SynestheticMapping[]): string[] {
    const modalities = new Set<string>();

    mappings.forEach(mapping => {
      if (mapping.sensoryBindings.visual) modalities.add('visual');
      if (mapping.sensoryBindings.auditory) modalities.add('auditory');
      if (mapping.sensoryBindings.tactile) modalities.add('tactile');
      if (mapping.sensoryBindings.olfactory) modalities.add('olfactory');
      if (mapping.sensoryBindings.gustatory) modalities.add('gustatory');
    });

    return Array.from(modalities);
  }

  /**
   * Check if olfactory modality should be included
   */
  private shouldIncludeOlfactory(): boolean {
    return this.context.userProfile.sensoryPreferences.includes('olfactory') &&
           Math.random() > 0.7; // Occasional inclusion
  }

  /**
   * Check if gustatory modality should be included
   */
  private shouldIncludeGustatory(): boolean {
    return this.context.userProfile.sensoryPreferences.includes('gustatory') &&
           Math.random() > 0.8; // Rare inclusion
  }

  /**
   * Simple hash function for deterministic mapping
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Initialize neural binding patterns
   */
  private initializeNeuralBindings(): void {
    // Initialize cross-modal association patterns
    this.neuralBindings.set('visual-auditory', { strength: 0.8, latency: 50 });
    this.neuralBindings.set('auditory-tactile', { strength: 0.6, latency: 75 });
    this.neuralBindings.set('visual-tactile', { strength: 0.7, latency: 60 });
    this.neuralBindings.set('olfactory-emotional', { strength: 0.5, latency: 200 });
    this.neuralBindings.set('gustatory-emotional', { strength: 0.4, latency: 150 });
  }

  /**
   * Update synesthetic context
   */
  updateContext(context: Partial<SynestheticContext>): void {
    this.context = {
      ...this.context,
      ...context,
      userProfile: { ...this.context.userProfile, ...(context.userProfile || {}) },
      environment: { ...this.context.environment, ...(context.environment || {}) },
      session: { ...this.context.session, ...(context.session || {}) }
    };
    console.log('[ShereshevskyBridge] Context updated');
  }

  /**
   * Get current synesthetic context
   */
  getContext(): SynestheticContext {
    return { ...this.context };
  }

  /**
   * Get synesthetic experience history
   */
  getExperienceHistory(): SynestheticExperience[] {
    return Array.from(this.sensoryHistory.values());
  }

  /**
   * Clear active mappings
   */
  clearMappings(): void {
    this.activeMappings.clear();
    console.log('[ShereshevskyBridge] Active mappings cleared');
  }
}

// Export singleton instance
export const shereshevskyBridge = new ShereshevskyBridge();