
import { GoogleGenAI, Type } from "@google/genai";
import { AssetType, DetailLevel, AssetManifest, PBRMaterial } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

const ASSET_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    description: { type: Type.STRING },
    type: { type: Type.STRING },
    style: { type: Type.STRING },
    technicalSpecs: {
      type: Type.OBJECT,
      properties: {
        estimatedVerts: { type: Type.STRING },
        topology: { type: Type.STRING },
        lodLevels: { type: Type.NUMBER },
        uvUnwrappingStyle: { type: Type.STRING }
      },
      required: ["estimatedVerts", "topology", "lodLevels", "uvUnwrappingStyle"]
    },
    pbrNodes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          albedo: { type: Type.STRING, description: "Hex color or descriptive string" },
          roughness: { type: Type.NUMBER },
          metallic: { type: Type.NUMBER },
          normalIntensity: { type: Type.NUMBER },
          emissive: { type: Type.STRING },
          subsurface: { type: Type.NUMBER }
        },
        required: ["albedo", "roughness", "metallic", "normalIntensity"]
      }
    },
    generationPrompts: {
      type: Type.OBJECT,
      properties: {
        diffusion: { type: Type.STRING },
        geometry: { type: Type.STRING },
        texture: { type: Type.STRING }
      },
      required: ["diffusion", "geometry", "texture"]
    },
    r3fSnippet: { type: Type.STRING, description: "Complete React Three Fiber code" }
  },
  required: ["name", "description", "type", "style", "technicalSpecs", "pbrNodes", "generationPrompts", "r3fSnippet"]
};

export const manifestAsset = async (
  prompt: string,
  type: AssetType,
  detail: DetailLevel
): Promise<AssetManifest> => {
  const systemInstruction = `You are AETHELGARD, a world-class 3D asset architect. Manifest technical blueprints for ${type} assets. Detail level: ${detail}. Focus on professional PBR workflows and performance-optimized geometry.`;
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{ parts: [{ text: `Generate full asset metadata for: ${prompt}` }] }],
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: ASSET_SCHEMA as any
    }
  });

  return JSON.parse(response.text || '{}') as AssetManifest;
};

export const generateVisualConcept = async (prompt: string): Promise<string> => {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { text: `High-fidelity 3D asset render, studio lighting, octane render, photorealistic, cinematic composition: ${prompt}` },
      ],
    },
    config: { imageConfig: { aspectRatio: "1:1" } },
  });

  for (const candidate of response.candidates || []) {
    for (const part of candidate.content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  }
  throw new Error("Visual synthesis failed.");
};

export const editVisualConcept = async (base64Image: string, editPrompt: string): Promise<string> => {
  const data = base64Image.split(',')[1] || base64Image;
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { inlineData: { data, mimeType: 'image/png' } },
        { text: `Modify the textures and visual details of this 3D asset: ${editPrompt}` },
      ],
    },
  });

  for (const candidate of response.candidates || []) {
    for (const part of candidate.content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  }
  throw new Error("Visual mutation failed.");
};

export const refineMaterial = async (material: PBRMaterial, refinement: string): Promise<PBRMaterial> => {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{ parts: [{ text: `Current material: ${JSON.stringify(material)}. Refinement request: ${refinement}. Return updated JSON.` }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          albedo: { type: Type.STRING },
          roughness: { type: Type.NUMBER },
          metallic: { type: Type.NUMBER },
          normalIntensity: { type: Type.NUMBER },
          emissive: { type: Type.STRING },
          subsurface: { type: Type.NUMBER }
        },
        required: ["albedo", "roughness", "metallic", "normalIntensity"]
      } as any
    }
  });
  return JSON.parse(response.text || '{}') as PBRMaterial;
};
