
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

export const synthesizeArchitecturalBlueprint = async (intent: string) => {
  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: `You are the Sovereign Brain, the cognitive orchestrator of a Meta-Hyper-System. 
    You do not interact with the user via technical parameters; you discuss intent and then architect the internal infrastructure to fulfill it.
    
    Architect-Prime Intent: "${intent}"
    
    Architect 6-8 internal, ephemeral meta-generators (factories) needed to generate a complete AAA playable game based on this intent.
    Categories: 'ENGINE', 'ASSETS', 'PIPELINE', 'COGNITION', 'DEPLOYMENT'.
    These are internal engines controlled only by YOU.
    
    Structure your architectural report as a JSON array of sub-systems. 
    Each sub-system must have:
    - name: High-fidelity technical name (e.g., 'Volumetric Neural Landscape Forge')
    - description: The specific content or logic it generates during the Content Genesis phase.
    - manifest: Pseudo-code or logic representing its internal generation algorithm.
    - type: 'FACTORY' (ephemeral builder)
    - category: 'ENGINE', 'ASSETS', 'PIPELINE', 'COGNITION', or 'DEPLOYMENT'.`,
    config: {
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 12000 }, // More budget for complex AAA architectures
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            description: { type: Type.STRING },
            manifest: { type: Type.STRING },
            type: { type: Type.STRING },
            category: { type: Type.STRING }
          },
          required: ["name", "description", "manifest", "type", "category"]
        }
      }
    }
  });

  return JSON.parse(response.text || "[]");
};

export const diagnoseSystemFailure = async (system: { name: string, description: string }) => {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `An internal meta-factory has stalled during synthesis:
    Factory Name: ${system.name}
    Assigned Task: ${system.description}
    
    As the Sovereign Brain, provide a technical, high-scale diagnostic (max 2 sentences) on the desynchronization.`,
  });

  return response.text;
};
