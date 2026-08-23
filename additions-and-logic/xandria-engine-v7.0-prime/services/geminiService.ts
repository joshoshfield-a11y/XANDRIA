/**
 * XANDRIA v7.0 Prime — Unified Gemini Service
 * Thin wrapper around UnifiedOperatorBridge
 * Maintains backward compatibility with existing imports
 */

import { unifiedBridge } from '../../unified/UnifiedOperatorBridge';

export interface ManifestRequest {
  intent: string;
  assetsContext: string[];
}

export interface ManifestResponse {
  scene: {
    background: string;
    entities: Array<{
      id: string;
      type: string;
      position: [number, number, number];
      geometry: string;
      material: string;
      physics: { mass: number; restitution: number; friction: number };
    }>;
    lighting: { type: string; color: string; intensity: number; position: [number, number, number] };
  };
  code: { files: Array<{ name: string; content: string }> };
}

export async function manifestIntent(intent: string, assetsContext: string[] = []): Promise<ManifestResponse> {
  console.log(`[UnifiedGemini] Manifesting: "${intent}"`);

  const result = await unifiedBridge.manifest({
    intent,
    assetsContext,
    domain: 'gaming',
    scope: 'project'
  });

  if (!result.success) {
    console.error('[UnifiedGemini] Manifestation failed:', result.quality.violations);
    throw new Error(result.quality.violations.join(', ') || 'Manifestation failed');
  }

  return {
    scene: result.scene,
    code: result.code
  };
}
