
import { GoogleGenAI, Type } from "@google/genai";

const API_KEY = process.env.API_KEY || "";

export class GeminiService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: API_KEY });
  }

  async synthesizeLogic(intent: string) {
    const response = await this.ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `You are the Logic Orchestration Kernel (LOGOS). 
      Synthesize a rigorous Entity Component System (ECS) architecture for: "${intent}".
      
      Your core task is to produce code that is formally verified for:
      1. Memory Safety (No null pointer dereferences).
      2. Deadlock Freedom (No circular wait in multi-agent systems).
      3. Finite Loops (Proof that all systems terminate).
      4. Logic Invariants (Adherence to physical laws or game rules).

      Return the response in JSON format.
      
      Requirements:
      1. Define required Component structures (Data-only).
      2. Define System logic in pseudo-code.
      3. Provide a theoretical Abstract Syntax Tree (AST) structure.
      4. Include an "AST Integrity Report" with 3-5 mathematical proofs.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            components: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  fields: { type: Type.ARRAY, items: { type: Type.STRING } },
                  description: { type: Type.STRING }
                }
              }
            },
            systems: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  logic: { type: Type.STRING },
                  invariants: { type: Type.ARRAY, items: { type: Type.STRING } }
                }
              }
            },
            ast: {
              type: Type.OBJECT,
              properties: {
                root: { type: Type.STRING },
                branches: { type: Type.ARRAY, items: { type: Type.STRING } },
                nodes: { type: Type.INTEGER }
              }
            },
            proofs: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  property: { type: Type.STRING },
                  proof: { type: Type.STRING },
                  severity: { type: Type.STRING, enum: ["INFO", "CRITICAL"] }
                }
              }
            }
          },
          required: ["components", "systems", "ast", "proofs"]
        }
      }
    });

    return JSON.parse(response.text);
  }
}

export const gemini = new GeminiService();
