// XANDRIA Unified Exports
// Main entry point for accessing all XANDRIA system capabilities

// Graphics Engine
export { GraphicsEngine, GraphicsStage, createGraphicsEngine, ProgressiveGraphicsEngine } from './graphics/engines/GraphicsEngine';
export { GraphicsVersionManager, getGraphicsVersionManager } from './graphics/upgrades/GraphicsVersionManager';
export { GraphicsUpgradeManager, getGraphicsUpgradeManager } from './graphics/upgrades/upgrade-manager';
export { GraphicsAssetPipeline, getGraphicsAssetPipeline } from './graphics/asset-pipeline-integration';

// Graphics Operators
export { GraphicsOperatorRegistry, getGraphicsOperatorRegistry, OP_22_MATRIX, OP_08_BLOOM, OP_40_INTERFACE, OP_12_WEAVE, OP_16_BRIDGE } from './graphics/operators/graphics-operators';

// Application Router
export { ApplicationRouter, getApplicationRouter } from './apps/application-router';
export { AppStateProvider, useAppState, appActions, selectors, stateSync } from './apps/state-manager';

// AI Services
export { UnifiedGeminiService, createGraphicsForgeGemini, createAIStudioGemini, createAssetGeminiService, createGameEngineGemini } from './services/unified-gemini-service';

// X13 System
export { X13Engine } from './x13-upgrade/core/X13Engine';
export { ExecutionContext } from './x13-upgrade/core/ExecutionContext';
export { LogicSynthesizer } from './x13-upgrade/synthesizers/LogicSynthesizer';

// Orchestration
export { UnifiedAAAOrchestrator } from './src/core/orchestrators/UnifiedAAAOrchestrator';

// Version info
export const XANDRIA_VERSION = '2.0.0';
export const XANDRIA_BUILD = '2026.01.09';
export const XANDRIA_STATUS = 'INTEGRATION_COMPLETE';

// Quick start guide
export const QUICK_START = `
# XANDRIA Quick Start Guide

## Import the system:
import { UnifiedAAAOrchestrator } from './XANDRIA/src/core/orchestrators/UnifiedAAAOrchestrator';

## Initialize the AAA orchestrator:
const orchestrator = new UnifiedAAAOrchestrator();

## Generate AAA content:
const context = { config: { /* your AAA config */ } };
const result = await orchestrator.execute(context);

## Access individual roles:
const cartographerResult = result.cartographer;
const directorResult = result.director;
const smithResult = result.smith;
const graphicsResult = result.graphics;

## Available graphics stages:
- GraphicsStage.PLANETARY: Basic terrain, atmosphere, vegetation
- GraphicsStage.LOD: Performance optimization with level-of-detail
- GraphicsStage.BRIDGE: External asset integration (GLTF/GLB)

## Available operators:
- OP-22_MATRIX: Terrain generation
- OP-08_BLOOM: Vegetation synthesis
- OP-40_INTERFACE: Atmospheric effects
- OP-12_WEAVE: LOD management
- OP-16_BRIDGE: Asset loading
`;