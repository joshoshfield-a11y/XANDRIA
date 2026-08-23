/**
 * XANDRIA Unified API Route
 * Server-side manifest generation using the full 72-operator lattice
 * Replaces the simple OpenRouter fetch with real operator execution
 */

import { unifiedBridge, ManifestRequest } from '../UnifiedOperatorBridge';

export default async function handler(req: Request): Promise<Response> {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers
    });
  }

  try {
    const body = await req.json();
    const request: ManifestRequest = {
      intent: body.intent || 'a default scene',
      assetsContext: body.assetsContext || [],
      domain: body.domain || 'gaming',
      scope: body.scope || 'project'
    };

    console.log(`[UnifiedAPI] Manifesting: "${request.intent}" in domain "${request.domain}"`);

    // Execute through the unified bridge (72-operator lattice)
    const result = await unifiedBridge.manifest(request);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers
    });
  } catch (error: any) {
    console.error('[UnifiedAPI] Error:', error.message);
    return new Response(JSON.stringify({
      error: 'Manifestation failed',
      details: error.message,
      success: false
    }), {
      status: 500,
      headers
    });
  }
}
