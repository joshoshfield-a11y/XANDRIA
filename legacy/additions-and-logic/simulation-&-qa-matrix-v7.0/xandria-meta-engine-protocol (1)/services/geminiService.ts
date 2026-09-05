
import { GoogleGenAI, Type } from "@google/genai";
import { NodeLogic } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const interpretIntent = async (prompt: string): Promise<NodeLogic[]> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `You are the Xandria Meta-Engine Sovereign Forge (v7.0 Prime). 
      Decompose the following User Intent into a high-density logical node manifold: "${prompt}".
      
      Operational Doctrine:
      1. Map the intent to the 72-operator canon where applicable.
      2. Use VOID (Sensors), FABRIC (Processors), and ARTIFACT (State) planes.
      3. Connect nodes recursively via the 'connectedTo' array (IDs only).
      4. For each node, generate metrics: flux, entropy, weight (all 0-1).
      
      Format: JSON array of objects { id, type, label, connectedTo, status, metrics: { flux, entropy, weight } }.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              type: { type: Type.STRING, enum: ["VOID", "FABRIC", "ARTIFACT"] },
              label: { type: Type.STRING },
              connectedTo: { type: Type.ARRAY, items: { type: Type.STRING } },
              status: { type: Type.STRING, enum: ["idle", "active", "error"] },
              metrics: {
                type: Type.OBJECT,
                properties: {
                  flux: { type: Type.NUMBER },
                  entropy: { type: Type.NUMBER },
                  weight: { type: Type.NUMBER }
                }
              }
            },
            required: ["id", "type", "label", "connectedTo", "status"]
          }
        }
      }
    });

    return JSON.parse(response.text || "[]");
  } catch (error) {
    console.error("Xandria Kernel Error:", error);
    return [];
  }
};

export const executeManifoldStep = async (nodes: NodeLogic[], impulse: string): Promise<{ nodes: NodeLogic[], log: string }> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `ACTUAL NEURAL EXECUTION.
      IMPULSE: "${impulse}"
      CURRENT_MANIFOLD: ${JSON.stringify(nodes)}
      
      Predict the next state of the manifold. Update the 'metrics' (flux, entropy) and 'status' for nodes affected by the impulse.
      
      RETURN FORMAT: JSON { "nodes": [updated_nodes], "log": "short_execution_summary" }`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            nodes: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { 
              id: { type: Type.STRING },
              metrics: { type: Type.OBJECT, properties: { flux: { type: Type.NUMBER }, entropy: { type: Type.NUMBER } } },
              status: { type: Type.STRING }
            } } },
            log: { type: Type.STRING }
          }
        }
      }
    });

    const result = JSON.parse(response.text || "{}");
    const updatedNodes = nodes.map(original => {
      const update = result.nodes?.find((n: any) => n.id === original.id);
      return update ? { ...original, ...update } : original;
    });

    return { nodes: updatedNodes, log: result.log || "Neural pass completed." };
  } catch (error) {
    return { nodes, log: "Neural execution failure: Causal drift." };
  }
};

export const generateSourceCode = async (intent: string, nodes: NodeLogic[]): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Convert to professional C# for Unity.
      INTENT: "${intent}"
      MANIFOLD: ${JSON.stringify(nodes)}
      Output ONLY code.`,
      config: { thinkingConfig: { thinkingBudget: 4000 } }
    });
    return response.text || "// Transpilation failed.";
  } catch (error) {
    return "// Transpilation Error.";
  }
};
