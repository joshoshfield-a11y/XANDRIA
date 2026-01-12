
import { GoogleGenAI, Type } from "@google/genai";
import { GeneratorEngine, ArtifactDiagnostics } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const withRetry = async <T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> => {
  try {
    return await fn();
  } catch (error: any) {
    const isClientError = error?.status >= 400 && error?.status < 500;
    if (retries <= 0 || isClientError) throw error;
    await new Promise(resolve => setTimeout(resolve, delay));
    return withRetry(fn, retries - 1, delay * 2);
  }
};

const ENGINE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    domain: { type: Type.STRING },
    description: { type: Type.STRING },
    config: {
      type: Type.OBJECT,
      properties: {
        parameters: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              key: { type: Type.STRING },
              label: { type: Type.STRING },
              type: { type: Type.STRING, enum: ['range', 'select', 'boolean', 'string'] },
              options: { type: Type.ARRAY, items: { type: Type.STRING } },
              default: { type: Type.STRING }
            },
            required: ['key', 'label', 'type', 'default']
          }
        },
        generationPrompt: { type: Type.STRING },
        assetPrompt: { type: Type.STRING, description: 'Prompt for generating visual assets for this domain.' }
      },
      required: ['parameters', 'generationPrompt']
    }
  },
  required: ['name', 'domain', 'description', 'config']
};

export const synthesizeGenerator = async (intent: string): Promise<GeneratorEngine> => {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: `Architect a procedural generator engine for the domain: ${intent}. Search for the latest best practices for this domain.`,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: ENGINE_SCHEMA
      }
    });

    const data = JSON.parse(response.text || '{}');
    return {
      ...data,
      id: crypto.randomUUID(),
      version: '1.0.0',
      createdAt: Date.now()
    };
  });
};

export const runGenerator = async (engine: GeneratorEngine, params: Record<string, any>, seed: string): Promise<string> => {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `
        Engine: ${engine.name}
        Context: ${engine.config.generationPrompt}
        Params: ${JSON.stringify(params)}
        Seed: ${seed}
        Verify the latest documentation for used libraries via search.
        Output ONLY production-ready code. No markdown.
      `,
      config: { 
        tools: [{ googleSearch: {} }],
        temperature: 0.7 
      }
    });
    return response.text || '';
  });
};

export const reForgeArtifact = async (code: string, instruction: string): Promise<string> => {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: `
        You are a Logic Surgeon. Modify the existing code according to the instruction.
        Instruction: ${instruction}
        Original Code:
        ${code}
        
        Output only the updated complete code.
      `,
      config: { temperature: 0.2 }
    });
    return response.text || code;
  });
};

export const performDiagnostics = async (code: string): Promise<ArtifactDiagnostics> => {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Analyze the following code for health and syntax issues: \n\n ${code}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            healthScore: { type: Type.NUMBER },
            issues: { type: Type.ARRAY, items: { type: Type.STRING } },
            suggestions: { type: Type.STRING }
          },
          required: ['healthScore', 'issues', 'suggestions']
        }
      }
    });
    return JSON.parse(response.text || '{}');
  });
};

export const forgeAsset = async (engine: GeneratorEngine, type: string): Promise<string> => {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: `Generate a high-quality ${type} for the following app domain: ${engine.domain}. Theme: ${engine.config.assetPrompt || 'Modern Cyber UI'}.` }]
      },
      config: {
        imageConfig: { aspectRatio: "1:1" }
      }
    });

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
    }
    throw new Error("No image data returned.");
  });
};
