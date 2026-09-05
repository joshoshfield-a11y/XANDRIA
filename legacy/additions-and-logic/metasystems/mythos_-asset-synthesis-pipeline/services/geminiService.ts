
import { GoogleGenAI, Type } from "@google/genai";

// Initialize the Gemini API client with the API key from environment variables
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export async function synthesizeAsset(prompt: string) {
  // Directly call generateContent with model and prompt as per SDK recommendations
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Architect a game-ready asset for the following concept: "${prompt}". 
    You must provide:
    1. A Semantic Consistency Graph (SCG) representing the physical 'truth' (mass, scale, materials).
    2. A USDA (Universal Scene Description ASCII) code block utilizing VariantSets for LODs (LOD0, LOD1, LOD2).
    3. Three LOD tiers with specific polygon counts (LOD0=High, LOD1=Medium, LOD2=Low).
    4. Procedural Audio parameters for Web Audio API: define 'impact' and 'scrape' sounds with frequencies (Hz), oscillator types, and decay values matching the materials in the SCG.
    5. A skeletal rig definition including joint names, 3D positions, and parent-child links.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          scg: {
            type: Type.OBJECT,
            properties: {
              nodes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    label: { type: Type.STRING },
                    type: { type: Type.STRING },
                    properties: { 
                      type: Type.OBJECT,
                      properties: {
                        mass: { type: Type.NUMBER, description: "Normalized mass value" },
                        material: { type: Type.STRING, description: "Material identifier" }
                      }
                    }
                  },
                  required: ["id", "label", "type"]
                }
              },
              links: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    source: { type: Type.STRING },
                    target: { type: Type.STRING },
                    label: { type: Type.STRING }
                  }
                }
              }
            }
          },
          lods: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                level: { type: Type.INTEGER },
                polygons: { type: Type.INTEGER },
                vertices: { type: Type.INTEGER },
                distanceTrigger: { type: Type.NUMBER }
              }
            }
          },
          joints: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                position: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                parent: { type: Type.STRING, nullable: true }
              }
            }
          },
          usdCode: { type: Type.STRING },
          audio: {
            type: Type.OBJECT,
            properties: {
              material: { type: Type.STRING },
              events: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING },
                    frequency: { type: Type.NUMBER },
                    type: { type: Type.STRING },
                    decay: { type: Type.NUMBER },
                    gain: { type: Type.NUMBER }
                  }
                }
              }
            }
          }
        },
        required: ["name", "scg", "lods", "joints", "usdCode", "audio"]
      }
    }
  });

  // Extract generated text from the property, not by calling it as a method
  return JSON.parse(response.text || '{}');
}
