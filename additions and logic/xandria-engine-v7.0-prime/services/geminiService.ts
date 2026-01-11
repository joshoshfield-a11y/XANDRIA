
import { GoogleGenAI, Type } from "@google/genai";
import { SYSTEM_DNA } from '../constants';

export async function manifestIntent(intent: string, assetsContext: any[] = []) {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const model = 'gemini-3-pro-preview';
  
  try {
    const response = await ai.models.generateContent({
      model,
      contents: `
        MANIFEST INTENT: "${intent}"
        ASSET_CONTEXT_INJECTED: ${JSON.stringify(assetsContext)}
        ACTION: Architect a high-fidelity 3D substrate with physics.
      `,
      config: {
        systemInstruction: SYSTEM_DNA,
        responseMimeType: "application/json",
        tools: [{ googleSearch: {} }], // Enable search for asset grounding
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
              required: ["background", "entities"]
            },
            files: {
              type: Type.OBJECT,
              properties: {
                "App.tsx": { type: Type.STRING },
                "physics-engine.ts": { type: Type.STRING },
                "manifest.json": { type: Type.STRING }
              }
            }
          },
          required: ["scene", "files"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("Null collapse in probability manifold.");

    const parsed = JSON.parse(text);
    
    // Log grounding if available
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (chunks) {
      console.log("Xandria Grounding Data:", chunks);
    }

    return parsed;
  } catch (error) {
    console.error("Xandria Manifestation Error:", error);
    throw error;
  }
}
