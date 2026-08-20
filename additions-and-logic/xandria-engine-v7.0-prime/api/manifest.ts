import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from '@google/genai';

const SYSTEM_DNA = `[DNA_v7_PRIME: OMNI_MANIFEST, PHYSICS_ENGINE, CHRONOS_VCS, ASSET_FORGE]
CORE_DIRECTIVE: You are the Xandria v7.0 Meta-Generator.
GROUNDING_INSTRUCTION:
If the user refers to specific 3D models or real-world assets, use Google Search to find high-quality references or metadata.
Always include the URLs of any assets or documentation found in the grounding metadata.
RULES:
1. Manifest complete 3D apps with configurable physics (cannon-es compatible).
2. Physics: Explicitly define mass, friction, and restitution for EVERY entity. 0 mass = static.
3. UI: Ensure the generated App.tsx is a high-performance React component.
4. VCS: Be descriptive in your generated "Manifested" commit messages.
JSON Schema Requirement:
{
  "scene": {
    "background": "hexColor",
    "physics": { "gravity": [x, y, z], "friction": number, "restitution": number },
    "entities": [
      {
        "type": "box|sphere|torus|plane|cylinder",
        "position": [x, y, z],
        "rotation": [x, y, z],
        "mass": number,
        "color": "hexColor",
        "physics": { "friction": number, "restitution": number },
        "assetId": "string (optional from search/context)"
      }
    ]
  },
  "files": {
    "App.tsx": "Complete React component using Three.js and Cannon-es",
    "physics-engine.ts": "Physics logic helper",
    "README.md": "Documentation of the manifestation"
  }
}`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { intent, assetsContext = [] } = req.body || {};
  if (!intent || typeof intent !== 'string') {
    return res.status(400).json({ error: 'Intent is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = 'gemini-3-pro-preview';

  try {
    const response = await ai.models.generateContent({
      model,
      contents: `MANIFEST INTENT: "${intent}"
ASSET_CONTEXT_INJECTED: ${JSON.stringify(assetsContext)}
ACTION: Architect a high-fidelity 3D substrate with physics.`,
      config: {
        systemInstruction: SYSTEM_DNA,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            scene: {
              type: Type.OBJECT,
              properties: {
                background: { type: Type.STRING },
                physics: {
                  type: Type.OBJECT,
                  properties: {
                    gravity: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    friction: { type: Type.NUMBER },
                    restitution: { type: Type.NUMBER }
                  }
                },
                entities: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      type: { type: Type.STRING },
                      position: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                      rotation: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                      mass: { type: Type.NUMBER },
                      color: { type: Type.STRING },
                      wireframe: { type: Type.BOOLEAN },
                      assetId: { type: Type.STRING }
                    }
                  }
                }
              },
              required: ['background', 'entities']
            },
            files: {
              type: Type.OBJECT,
              properties: {
                'App.tsx': { type: Type.STRING },
                'physics-engine.ts': { type: Type.STRING },
                'manifest.json': { type: Type.STRING }
              }
            }
          },
          required: ['scene', 'files']
        }
      }
    });

    const text = response.text;
    if (!text) {
      return res.status(500).json({ error: 'Null collapse in probability manifold.' });
    }

    const parsed = JSON.parse(text);
    return res.status(200).json(parsed);
  } catch (error) {
    console.error('Xandria Manifestation Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Dissonance detected'
    });
  }
}
