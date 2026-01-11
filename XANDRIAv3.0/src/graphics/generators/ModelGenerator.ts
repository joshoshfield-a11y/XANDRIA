/**
 * XANDRIA AST-TO-3D MODEL GENERATOR
 * Converts abstract syntax trees into 3D geometric representations
 * Maps code semantics to spatial structures and visual forms
 */

import * as THREE from 'three';
import { operatorRegistry } from '../../engine/operators/OperatorRegistry';

export interface ASTNode {
  type: string;
  name?: string;
  value?: any;
  children?: ASTNode[];
  location?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  metadata?: Record<string, any>;
}

export interface ModelGenerationContext {
  complexity: number;
  semanticDensity: number;
  visualStyle: 'abstract' | 'realistic' | 'minimal' | 'ornate';
  colorPalette: string[];
  scale: number;
  recursionDepth: number;
}

export interface GeneratedModel {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  mesh: THREE.Mesh;
  metadata: {
    astComplexity: number;
    semanticScore: number;
    visualComplexity: number;
    generationTime: number;
  };
  animations?: THREE.AnimationClip[];
  textures?: THREE.Texture[];
}

export interface ModelGenerationResult {
  models: GeneratedModel[];
  sceneGraph: THREE.Object3D;
  boundingBox: THREE.Box3;
  statistics: {
    totalVertices: number;
    totalFaces: number;
    totalMaterials: number;
    generationTime: number;
  };
}

export class ModelGenerator {
  private context: ModelGenerationContext;
  private geometryCache: Map<string, THREE.BufferGeometry> = new Map();

  constructor(context: ModelGenerationContext = {
    complexity: 0.5,
    semanticDensity: 0.7,
    visualStyle: 'abstract',
    colorPalette: ['#00FFCC', '#FF3366', '#3366FF', '#FFCC00', '#CC00FF'],
    scale: 1.0,
    recursionDepth: 3
  }) {
    this.context = context;
  }

  /**
   * Generate 3D models from AST
   */
  async generateFromAST(ast: ASTNode): Promise<ModelGenerationResult> {
    const startTime = Date.now();
    console.log('[ModelGenerator] Generating 3D models from AST:', ast.type);

    const models: GeneratedModel[] = [];
    const sceneGraph = new THREE.Object3D();

    // Analyze AST structure
    const astAnalysis = await this.analyzeAST(ast);
    console.log('[ModelGenerator] AST analysis complete:', astAnalysis);

    // Generate models recursively
    const rootModel = await this.generateNodeModel(ast, astAnalysis, 0, new THREE.Vector3(0, 0, 0));
    models.push(rootModel);

    // Add to scene graph
    sceneGraph.add(rootModel.mesh);

    // Generate child models
    if (ast.children && ast.children.length > 0) {
      await this.generateChildModels(ast.children, astAnalysis, models, sceneGraph, rootModel.mesh.position, 1);
    }

    // Calculate bounding box
    const boundingBox = new THREE.Box3().setFromObject(sceneGraph);

    // Generate statistics
    const statistics = this.calculateStatistics(models, startTime);

    console.log(`[ModelGenerator] Generation complete: ${models.length} models, ${statistics.totalVertices} vertices`);

    return {
      models,
      sceneGraph,
      boundingBox,
      statistics
    };
  }

  /**
   * Analyze AST structure and semantics
   */
  private async analyzeAST(ast: ASTNode): Promise<{
    complexity: number;
    depth: number;
    semanticDensity: number;
    nodeTypes: Map<string, number>;
    controlFlow: number;
    dataFlow: number;
  }> {
    const analysis = {
      complexity: 0,
      depth: 0,
      semanticDensity: 0,
      nodeTypes: new Map<string, number>(),
      controlFlow: 0,
      dataFlow: 0
    };

    // Traverse AST and collect metrics
    this.traverseAST(ast, analysis, 0);

    // Calculate derived metrics
    analysis.complexity = Math.min(1.0, (analysis.nodeTypes.size * analysis.depth) / 100);
    analysis.semanticDensity = analysis.controlFlow / Math.max(1, analysis.dataFlow);

    return analysis;
  }

  /**
   * Traverse AST and collect structural metrics
   */
  private traverseAST(node: ASTNode, analysis: any, depth: number): void {
    // Update depth
    analysis.depth = Math.max(analysis.depth, depth);

    // Count node types
    const count = analysis.nodeTypes.get(node.type) || 0;
    analysis.nodeTypes.set(node.type, count + 1);

    // Analyze semantic content
    if (this.isControlFlowNode(node)) {
      analysis.controlFlow++;
    }
    if (this.isDataFlowNode(node)) {
      analysis.dataFlow++;
    }

    // Recurse on children
    if (node.children) {
      for (const child of node.children) {
        this.traverseAST(child, analysis, depth + 1);
      }
    }
  }

  /**
   * Check if node represents control flow
   */
  private isControlFlowNode(node: ASTNode): boolean {
    const controlFlowTypes = ['IfStatement', 'ForStatement', 'WhileStatement', 'SwitchStatement', 'TryStatement'];
    return controlFlowTypes.includes(node.type);
  }

  /**
   * Check if node represents data flow
   */
  private isDataFlowNode(node: ASTNode): boolean {
    const dataFlowTypes = ['VariableDeclaration', 'AssignmentExpression', 'FunctionCall', 'ReturnStatement'];
    return dataFlowTypes.includes(node.type);
  }

  /**
   * Generate 3D model for AST node
   */
  private async generateNodeModel(
    node: ASTNode,
    analysis: any,
    depth: number,
    position: THREE.Vector3
  ): Promise<GeneratedModel> {
    const startTime = Date.now();

    // Determine geometry type based on node type and context
    const geometryType = this.mapNodeToGeometry(node, analysis);
    const geometry = await this.createGeometry(geometryType, node, analysis);

    // Generate material
    const material = this.createMaterial(node, depth, analysis);

    // Create mesh
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Apply transformations based on semantic meaning
    this.applySemanticTransformations(mesh, node, analysis);

    // Generate metadata
    const metadata = {
      astComplexity: analysis.complexity,
      semanticScore: analysis.semanticDensity,
      visualComplexity: this.calculateVisualComplexity(geometry),
      generationTime: Date.now() - startTime
    };

    return {
      geometry,
      material,
      mesh,
      metadata
    };
  }

  /**
   * Map AST node type to 3D geometry
   */
  private mapNodeToGeometry(node: ASTNode, analysis: any): string {
    const typeMappings: Record<string, string> = {
      'FunctionDeclaration': 'cylinder',
      'VariableDeclaration': 'cube',
      'IfStatement': 'pyramid',
      'ForStatement': 'torus',
      'ClassDeclaration': 'sphere',
      'ReturnStatement': 'cone',
      'CallExpression': 'icosahedron',
      'BinaryExpression': 'octahedron',
      'Literal': 'tetrahedron'
    };

    return typeMappings[node.type] || 'box';
  }

  /**
   * Create geometry based on type and node properties
   */
  private async createGeometry(type: string, node: ASTNode, analysis: any): Promise<THREE.BufferGeometry> {
    const cacheKey = `${type}-${node.type}-${analysis.complexity.toFixed(2)}`;

    // Check cache first
    if (this.geometryCache.has(cacheKey)) {
      return this.geometryCache.get(cacheKey)!.clone();
    }

    let geometry: THREE.BufferGeometry;

    // Scale based on context
    const scale = this.context.scale * (1 + analysis.complexity * 0.5);

    switch (type) {
      case 'cylinder':
        geometry = new THREE.CylinderGeometry(0.5 * scale, 0.5 * scale, 2 * scale, 8);
        break;
      case 'cube':
        geometry = new THREE.BoxGeometry(scale, scale, scale);
        break;
      case 'pyramid':
        geometry = new THREE.ConeGeometry(0.8 * scale, 1.5 * scale, 4);
        break;
      case 'torus':
        geometry = new THREE.TorusGeometry(0.7 * scale, 0.2 * scale, 8, 16);
        break;
      case 'sphere':
        geometry = new THREE.SphereGeometry(0.8 * scale, 16, 12);
        break;
      case 'cone':
        geometry = new THREE.ConeGeometry(0.4 * scale, 1.2 * scale, 6);
        break;
      case 'icosahedron':
        geometry = new THREE.IcosahedronGeometry(0.6 * scale);
        break;
      case 'octahedron':
        geometry = new THREE.OctahedronGeometry(0.7 * scale);
        break;
      case 'tetrahedron':
        geometry = new THREE.TetrahedronGeometry(0.5 * scale);
        break;
      default:
        geometry = new THREE.BoxGeometry(scale, scale, scale);
    }

    // Cache the geometry
    this.geometryCache.set(cacheKey, geometry.clone());

    return geometry;
  }

  /**
   * Create material for node
   */
  private createMaterial(node: ASTNode, depth: number, analysis: any): THREE.Material {
    // Select color based on node type and depth
    const colorIndex = (depth * 7 + node.type.length) % this.context.colorPalette.length;
    const baseColor = this.context.colorPalette[colorIndex];

    // Adjust material properties based on context
    const opacity = Math.max(0.3, 1 - depth * 0.1);
    const emissiveIntensity = analysis.semanticDensity * 0.2;

    let material: THREE.Material;

    switch (this.context.visualStyle) {
      case 'realistic':
        material = new THREE.MeshStandardMaterial({
          color: baseColor,
          opacity,
          transparent: opacity < 1,
          emissive: baseColor,
          emissiveIntensity,
          roughness: 0.3,
          metalness: 0.1
        });
        break;

      case 'minimal':
        material = new THREE.MeshBasicMaterial({
          color: baseColor,
          opacity,
          transparent: opacity < 1
        });
        break;

      case 'ornate':
        material = new THREE.MeshPhongMaterial({
          color: baseColor,
          opacity,
          transparent: opacity < 1,
          emissive: baseColor,
          emissiveIntensity: emissiveIntensity * 2,
          shininess: 100,
          specular: '#ffffff'
        });
        break;

      default: // 'abstract'
        material = new THREE.MeshLambertMaterial({
          color: baseColor,
          opacity,
          transparent: opacity < 1,
          emissive: baseColor,
          emissiveIntensity
        });
    }

    return material;
  }

  /**
   * Apply semantic transformations to mesh
   */
  private applySemanticTransformations(mesh: THREE.Mesh, node: ASTNode, analysis: any): void {
    // Rotate based on node complexity
    const rotationFactor = analysis.complexity * Math.PI * 2;
    mesh.rotation.x = rotationFactor * 0.1;
    mesh.rotation.y = rotationFactor * 0.15;
    mesh.rotation.z = rotationFactor * 0.05;

    // Scale based on semantic importance
    const scaleFactor = 1 + (node.children?.length || 0) * 0.1;
    mesh.scale.multiplyScalar(scaleFactor);

    // Position adjustments for hierarchy
    if (node.location) {
      const lineOffset = (node.location.start.line - 1) * 0.5;
      const columnOffset = (node.location.start.column - 1) * 0.1;
      mesh.position.add(new THREE.Vector3(columnOffset, -lineOffset, 0));
    }
  }

  /**
   * Generate models for child nodes
   */
  private async generateChildModels(
    children: ASTNode[],
    analysis: any,
    models: GeneratedModel[],
    sceneGraph: THREE.Object3D,
    parentPosition: THREE.Vector3,
    depth: number
  ): Promise<void> {
    if (depth >= this.context.recursionDepth) return;

    const childSpacing = 2.0;
    const angleStep = (Math.PI * 2) / children.length;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const angle = i * angleStep;
      const radius = childSpacing * (depth + 1);

      const childPosition = new THREE.Vector3(
        parentPosition.x + Math.cos(angle) * radius,
        parentPosition.y - 1.5 * depth, // Stack downward
        parentPosition.z + Math.sin(angle) * radius
      );

      const childModel = await this.generateNodeModel(child, analysis, depth, childPosition);
      models.push(childModel);
      sceneGraph.add(childModel.mesh);

      // Recurse on grandchildren
      if (child.children && child.children.length > 0) {
        await this.generateChildModels(child.children, analysis, models, sceneGraph, childPosition, depth + 1);
      }
    }
  }

  /**
   * Calculate visual complexity of geometry
   */
  private calculateVisualComplexity(geometry: THREE.BufferGeometry): number {
    if (geometry.index) {
      return geometry.index.count / 1000; // Faces per thousand
    } else if (geometry.attributes.position) {
      return geometry.attributes.position.count / 3000; // Vertices per thousand
    }
    return 0.1;
  }

  /**
   * Calculate generation statistics
   */
  private calculateStatistics(models: GeneratedModel[], startTime: number): ModelGenerationResult['statistics'] {
    let totalVertices = 0;
    let totalFaces = 0;
    let totalMaterials = models.length;

    for (const model of models) {
      if (model.geometry.attributes.position) {
        totalVertices += model.geometry.attributes.position.count;
      }
      if (model.geometry.index) {
        totalFaces += model.geometry.index.count / 3; // Triangles
      }
    }

    return {
      totalVertices,
      totalFaces,
      totalMaterials,
      generationTime: Date.now() - startTime
    };
  }

  /**
   * Update generation context
   */
  updateContext(context: Partial<ModelGenerationContext>): void {
    this.context = { ...this.context, ...context };
    console.log('[ModelGenerator] Context updated:', this.context);
  }

  /**
   * Clear geometry cache
   */
  clearCache(): void {
    this.geometryCache.clear();
    console.log('[ModelGenerator] Geometry cache cleared');
  }

  /**
   * Get current context
   */
  getContext(): ModelGenerationContext {
    return { ...this.context };
  }
}

// Export singleton instance
export const modelGenerator = new ModelGenerator();