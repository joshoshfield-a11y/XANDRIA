/**
 * XANDRIA OPERATOR REGISTRY
 * Central registry for all 216 mathematical operators (UEA, x13, Alpha)
 * Manages operator registration, lookup, execution, and metadata
 */

import { UEAOperators } from './UEAOperators';
import { X13Operators } from './X13Operators';
import { AlphaOperators } from './AlphaOperators';

export interface OperatorMetadata {
  id: string;
  symbol: string;
  triad: 'Procedural' | 'Heuristic' | 'Refactorial';
  scope: 'Syntactic' | 'Algorithmic' | 'Evolutionary' | 'Systemic' | 'Resource' | 'Collaborative' | 'Cultural' | 'Experiential' | 'Invariant' | 'Topological' | 'Generative' | 'Operational' | 'Abstract';
  category: 'Foundational' | 'Dynamic' | 'Relational' | 'Governance';
  description: string;
  parameters: string[];
  returnType: string;
  complexity: number; // 1-10 scale
  stability: number; // 0-1 scale
  dependencies: string[]; // IDs of required operators
}

export interface OperatorResult {
  success: boolean;
  result: any;
  metadata: {
    executionTime: number;
    memoryUsage: number;
    operatorId: string;
    confidence: number;
  };
  errors: string[];
  warnings: string[];
}

export interface OperatorContext {
  input: any;
  config: Record<string, any>;
  state: Record<string, any>;
  previousResults: OperatorResult[];
  environment: {
    timestamp: number;
    sessionId: string;
    userId?: string;
    contextScope: string[];
  };
}

export class OperatorRegistry {
  private operators: Map<string, {
    implementation: Function;
    metadata: OperatorMetadata;
  }> = new Map();

  private categories = {
    foundational: new Set<string>(),
    dynamic: new Set<string>(),
    relational: new Set<string>(),
    governance: new Set<string>()
  };

  private triads = {
    procedural: new Set<string>(),
    heuristic: new Set<string>(),
    refactorial: new Set<string>()
  };

  private scopes = new Map<string, Set<string>>();

  constructor() {
    this.initializeOperators();
  }

  /**
   * Initialize all operator implementations
   */
  private async initializeOperators(): Promise<void> {
    console.log('[OperatorRegistry] Initializing 216 mathematical operators...');

    // Load UEA operators (L1-L18)
    const ueaOps = new UEAOperators();
    const ueaOperatorMap = ueaOps.getOperators();
    for (const [id, operator] of ueaOperatorMap) {
      this.registerOperator(id, operator.implementation, operator.metadata);
    }

    // Load x13 operators (L19-L36)
    const x13Ops = new X13Operators();
    const x13OperatorMap = x13Ops.getOperators();
    for (const [id, operator] of x13OperatorMap) {
      this.registerOperator(id, operator.implementation, operator.metadata);
    }

    // Load Alpha operators (L37-L72)
    const alphaOps = new AlphaOperators();
    const alphaOperatorMap = alphaOps.getOperators();
    for (const [id, operator] of alphaOperatorMap) {
      this.registerOperator(id, operator.implementation, operator.metadata);
    }

    console.log(`[OperatorRegistry] Registered ${this.operators.size} operators successfully`);

    // Validate operator dependencies
    await this.validateDependencies();

    // Build operator graphs
    this.buildOperatorGraphs();
  }

  /**
   * Register a single operator
   */
  private registerOperator(
    id: string,
    implementation: Function,
    metadata: OperatorMetadata
  ): void {
    // Validate operator metadata
    this.validateOperatorMetadata(id, metadata);

    // Register operator
    this.operators.set(id, { implementation, metadata });

    // Add to category index
    const categoryKey = metadata.category.toLowerCase() as keyof typeof this.categories;
    this.categories[categoryKey].add(id);

    // Add to triad index
    const triadKey = metadata.triad.toLowerCase() as keyof typeof this.triads;
    this.triads[triadKey].add(id);

    // Add to scope index
    if (!this.scopes.has(metadata.scope)) {
      this.scopes.set(metadata.scope, new Set());
    }
    this.scopes.get(metadata.scope)!.add(id);

    console.log(`[OperatorRegistry] Registered operator: ${id} (${metadata.symbol})`);
  }

  /**
   * Validate operator metadata
   */
  private validateOperatorMetadata(id: string, metadata: OperatorMetadata): void {
    if (!metadata.id || metadata.id !== id) {
      throw new Error(`Operator ${id} has invalid ID in metadata`);
    }

    if (!metadata.symbol || metadata.symbol.length === 0) {
      throw new Error(`Operator ${id} missing symbol`);
    }

    if (!['Procedural', 'Heuristic', 'Refactorial'].includes(metadata.triad)) {
      throw new Error(`Operator ${id} has invalid triad: ${metadata.triad}`);
    }

    if (!['Foundational', 'Dynamic', 'Relational', 'Governance'].includes(metadata.category)) {
      throw new Error(`Operator ${id} has invalid category: ${metadata.category}`);
    }

    if (metadata.complexity < 1 || metadata.complexity > 10) {
      throw new Error(`Operator ${id} has invalid complexity: ${metadata.complexity}`);
    }

    if (metadata.stability < 0 || metadata.stability > 1) {
      throw new Error(`Operator ${id} has invalid stability: ${metadata.stability}`);
    }
  }

  /**
   * Validate operator dependencies
   */
  private async validateDependencies(): Promise<void> {
    const visited = new Set<string>();
    const visiting = new Set<string>();

    for (const [id, operator] of this.operators) {
      await this.validateDependencyGraph(id, visited, visiting);
    }

    console.log('[OperatorRegistry] All operator dependencies validated');
  }

  /**
   * Validate dependency graph for circular dependencies
   */
  private async validateDependencyGraph(
    operatorId: string,
    visited: Set<string>,
    visiting: Set<string>
  ): Promise<void> {
    if (visited.has(operatorId)) return;
    if (visiting.has(operatorId)) {
      throw new Error(`Circular dependency detected involving operator: ${operatorId}`);
    }

    visiting.add(operatorId);

    const operator = this.operators.get(operatorId);
    if (!operator) return;

    for (const depId of operator.metadata.dependencies) {
      if (!this.operators.has(depId)) {
        throw new Error(`Operator ${operatorId} depends on missing operator: ${depId}`);
      }
      await this.validateDependencyGraph(depId, visited, visiting);
    }

    visiting.delete(operatorId);
    visited.add(operatorId);
  }

  /**
   * Build operator relationship graphs
   */
  private buildOperatorGraphs(): void {
    // Build dependency graph
    const dependencyGraph = new Map<string, Set<string>>();
    const reverseDependencyGraph = new Map<string, Set<string>>();

    for (const [id, operator] of this.operators) {
      dependencyGraph.set(id, new Set(operator.metadata.dependencies));
      reverseDependencyGraph.set(id, new Set());

      for (const dep of operator.metadata.dependencies) {
        if (!reverseDependencyGraph.has(dep)) {
          reverseDependencyGraph.set(dep, new Set());
        }
        reverseDependencyGraph.get(dep)!.add(id);
      }
    }

    console.log('[OperatorRegistry] Operator relationship graphs built');
  }

  /**
   * Execute an operator with full context
   */
  async executeOperator(
    operatorId: string,
    context: OperatorContext
  ): Promise<OperatorResult> {
    const startTime = Date.now();
    const startMemory = process.memoryUsage().heapUsed;

    try {
      // Validate operator exists
      const operator = this.operators.get(operatorId);
      if (!operator) {
        throw new Error(`Operator not found: ${operatorId}`);
      }

      // Check dependencies are satisfied
      await this.checkDependencies(operatorId, context);

      // Execute operator with timeout protection
      const result = await this.executeWithTimeout(
        operator.implementation,
        [context],
        30000 // 30 second timeout
      );

      const executionTime = Date.now() - startTime;
      const memoryUsage = process.memoryUsage().heapUsed - startMemory;

      // Calculate confidence based on operator stability and result quality
      const confidence = this.calculateConfidence(operator.metadata, result, context);

      return {
        success: true,
        result,
        metadata: {
          executionTime,
          memoryUsage,
          operatorId,
          confidence
        },
        errors: [],
        warnings: []
      };

    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const memoryUsage = process.memoryUsage().heapUsed - startMemory;

      return {
        success: false,
        result: null,
        metadata: {
          executionTime,
          memoryUsage,
          operatorId,
          confidence: 0
        },
        errors: [error.message],
        warnings: []
      };
    }
  }

  /**
   * Check if operator dependencies are satisfied
   */
  private async checkDependencies(operatorId: string, context: OperatorContext): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) return;

    for (const depId of operator.metadata.dependencies) {
      const depResult = context.previousResults.find(r => r.metadata.operatorId === depId);
      if (!depResult || !depResult.success) {
        throw new Error(`Dependency not satisfied: ${depId} for operator ${operatorId}`);
      }
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout(
    fn: Function,
    args: any[],
    timeoutMs: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Operator execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const result = fn(...args);
        clearTimeout(timeout);

        // Handle both sync and async results
        if (result instanceof Promise) {
          result.then(resolve).catch(reject);
        } else {
          resolve(result);
        }
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Calculate execution confidence
   */
  private calculateConfidence(
    metadata: OperatorMetadata,
    result: any,
    context: OperatorContext
  ): number {
    let confidence = metadata.stability;

    // Adjust based on result quality
    if (result && typeof result === 'object' && 'confidence' in result) {
      confidence *= result.confidence;
    }

    // Adjust based on context consistency
    if (context.state.consistency) {
      confidence *= context.state.consistency;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Get operator by ID
   */
  getOperator(id: string): { implementation: Function; metadata: OperatorMetadata } | undefined {
    return this.operators.get(id);
  }

  /**
   * Get operator metadata
   */
  getOperatorMetadata(id: string): OperatorMetadata | undefined {
    return this.operators.get(id)?.metadata;
  }

  /**
   * Get all operators in a category
   */
  getOperatorsByCategory(category: string): Map<string, OperatorMetadata> {
    const result = new Map<string, OperatorMetadata>();
    const categoryKey = category.toLowerCase() as keyof typeof this.categories;
    const categorySet = this.categories[categoryKey];

    if (categorySet) {
      for (const id of categorySet) {
        const operator = this.operators.get(id);
        if (operator) {
          result.set(id, operator.metadata);
        }
      }
    }

    return result;
  }

  /**
   * Get operators by triad
   */
  getOperatorsByTriad(triad: string): Map<string, OperatorMetadata> {
    const result = new Map<string, OperatorMetadata>();
    const triadKey = triad.toLowerCase() as keyof typeof this.triads;
    const triadSet = this.triads[triadKey];

    if (triadSet) {
      for (const id of triadSet) {
        const operator = this.operators.get(id);
        if (operator) {
          result.set(id, operator.metadata);
        }
      }
    }

    return result;
  }

  /**
   * Get operators by scope
   */
  getOperatorsByScope(scope: string): Map<string, OperatorMetadata> {
    const result = new Map<string, OperatorMetadata>();
    const scopeSet = this.scopes.get(scope);

    if (scopeSet) {
      for (const id of scopeSet) {
        const operator = this.operators.get(id);
        if (operator) {
          result.set(id, operator.metadata);
        }
      }
    }

    return result;
  }

  /**
   * Get all registered operators
   */
  getAllOperators(): Map<string, OperatorMetadata> {
    const result = new Map<string, OperatorMetadata>();
    for (const [id, operator] of this.operators) {
      result.set(id, operator.metadata);
    }
    return result;
  }

  /**
   * Get operator statistics
   */
  getStatistics(): {
    totalOperators: number;
    categories: Record<string, number>;
    triads: Record<string, number>;
    scopes: Record<string, number>;
    averageComplexity: number;
    averageStability: number;
  } {
    const categories: Record<string, number> = {};
    const triads: Record<string, number> = {};
    const scopes: Record<string, number> = {};
    let totalComplexity = 0;
    let totalStability = 0;

    for (const [id, operator] of this.operators) {
      const meta = operator.metadata;

      // Category counts
      categories[meta.category] = (categories[meta.category] || 0) + 1;

      // Triad counts
      triads[meta.triad] = (triads[meta.triad] || 0) + 1;

      // Scope counts
      scopes[meta.scope] = (scopes[meta.scope] || 0) + 1;

      // Accumulate metrics
      totalComplexity += meta.complexity;
      totalStability += meta.stability;
    }

    return {
      totalOperators: this.operators.size,
      categories,
      triads,
      scopes,
      averageComplexity: totalComplexity / this.operators.size,
      averageStability: totalStability / this.operators.size
    };
  }

  /**
   * Synthesize intent using operator pipeline
   */
  async synthesizeIntent(
    intent: any,
    context: OperatorContext
  ): Promise<OperatorResult[]> {
    console.log('[OperatorRegistry] Synthesizing intent with operator pipeline...');

    const results: OperatorResult[] = [];

    // Phase 1: Intent Analysis (L1-L6)
    const analysisOperators = [
      'L1', // Identity - establish baseline
      'L3', // Feature Projection - identify key elements
      'L4', // Constraint Enforcer - validate intent
      'L5', // Gradient Optimization - find optimal path
      'L6'  // Laplacian Smoothing - remove noise
    ];

    for (const opId of analysisOperators) {
      const result = await this.executeOperator(opId, {
        ...context,
        input: intent,
        previousResults: results
      });
      results.push(result);
    }

    // Phase 2: Synthesis (L19-L36)
    const synthesisOperators = [
      'L21', // Refactoring Pull - optimize structure
      'L23', // Logic Decomposition - break down complexity
      'L25', // Amplitude Mapping - scale appropriately
      'L31'  // Koopman Lifting - linearize dynamics
    ];

    for (const opId of synthesisOperators) {
      const result = await this.executeOperator(opId, {
        ...context,
        input: intent,
        previousResults: results
      });
      results.push(result);
    }

    // Phase 3: Integration (L37-L54)
    const integrationOperators = [
      'L37', // Dependency Adjacency - map relationships
      'L39', // Logic Coupling - connect components
      'L41', // Influence Propagation - distribute effects
      'L48'  // Logic Synchrony - ensure coherence
    ];

    for (const opId of integrationOperators) {
      const result = await this.executeOperator(opId, {
        ...context,
        input: intent,
        previousResults: results
      });
      results.push(result);
    }

    // Phase 4: Governance (L55-L72)
    const governanceOperators = [
      'L63', // Code Renormalization - standardize output
      'L67', // Syntax Grounding - validate against standards
      'L69', // Conservation Logic - preserve information
      'L72'  // Meta-Controller - final optimization
    ];

    for (const opId of governanceOperators) {
      const result = await this.executeOperator(opId, {
        ...context,
        input: intent,
        previousResults: results
      });
      results.push(result);
    }

    console.log(`[OperatorRegistry] Intent synthesis completed with ${results.length} operator executions`);

    return results;
  }
}

// Export singleton instance
export const operatorRegistry = new OperatorRegistry();
