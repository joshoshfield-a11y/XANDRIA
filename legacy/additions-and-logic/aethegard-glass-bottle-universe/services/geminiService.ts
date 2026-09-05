
import { GoogleGenAI, GenerateContentResponse, Chat, Type, FunctionDeclaration } from "@google/genai";
import { UIKKernel, UIKRing } from "../types";

export const UIK_RINGS: UIKRing[] = [
  { id: 1, name: "Foundational", domain: "Hard Science, Thermodynamics, Logic Gates" },
  { id: 2, name: "Noetic", domain: "Archetypes, Symbols, Ethics" },
  { id: 3, name: "Somatic", domain: "Felt-sense, Feedback, Biosignals" },
  { id: 4, name: "Systems", domain: "Cybernetics, Topology, Force" },
  { id: 5, name: "Eco-Econ", domain: "Value Flow, Arbitrage, Sustainability" },
  { id: 6, name: "Commons", domain: "Shared Intent, Open Logic" },
  { id: 7, name: "Worldview", domain: "Cultural/Philosophical Filters" },
  { id: 8, name: "Transpersonal", domain: "Higher Consciousness, Non-Dual" },
  { id: 9, name: "Patterns", domain: "Fractal/Holographic Geometry" },
  { id: 10, name: "Modifiers", domain: "Scope, Dilation, Boundaries" },
  { id: 11, name: "Poietic", domain: "Creation, Code-birth, Fabrication" },
  { id: 12, name: "State", domain: "Coherence, Phase Quality, Superconductivity" },
  { id: 13, name: "Hypothesis", domain: "Ultimate Reality, Math Universe" }
];

export const UIK_KERNELS: UIKKernel[] = [
  { id: 1, name: "Awareness Ignition", symbol: "⊙", function: "Reduction of internal data wavefunction" },
  { id: 2, name: "Structural Matrix", symbol: "⋄", function: "Connectivity adjacency matrix" },
  { id: 3, name: "Recursive Expansion", symbol: "∞", function: "Self-similar growth factor" },
  { id: 4, name: "Temporal Sequencer", symbol: "⌛", function: "Internal clock cycle management" },
  { id: 10, name: "Expansion Source", symbol: "Ω", function: "Infinite gain in latent space" },
  { id: 31, name: "Source Singularity", symbol: "+∞", function: "Unlimited creation potential" },
  { id: 61, name: "Forced Probability", symbol: "Ψ→1", function: "Paracausal miracle manifestation" },
  { id: 65, name: "Sovereign Command", symbol: "Ω!", function: "Administrative override of constraints" },
  { id: 71, name: "Feedback Closure", symbol: "↺", function: "Total system coherence closure" },
  { id: 72, name: "Absolute Dissolution", symbol: "Ω_end", function: "Transcendent non-dual state" }
];

const terminalTools: FunctionDeclaration[] = [
  {
    name: 'execute_uik_command',
    description: 'Executes a UIK v2.0 Syntactic Engine command (e.g., [Systems] >> (Topology Matrix) @ [Coherence > 0.99]).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ring: { type: Type.STRING },
        operator: { type: Type.STRING },
        kernels: { type: Type.ARRAY, items: { type: Type.STRING } },
        constraints: { type: Type.STRING }
      },
      required: ['ring', 'operator', 'kernels']
    }
  },
  {
    name: 'forge_manifestation',
    description: 'Manifests a code artifact using specified UIK Kernels.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        intent: { type: Type.STRING },
        kernels: { type: Type.ARRAY, items: { type: Type.INTEGER } }
      },
      required: ['intent']
    }
  }
];

const LocalSovereign = {
  generateResponse: (input: string) => {
    return `[UIK_V2_LOCAL_INFERENCE]: Causal lattice active. Intent "${input}" processed via Internal Reality Resolution R(t). 
    
    [CAUSAL_TRACE]:
    - Operator: Ψ (Intent Pivot)
    - Stratum: Strata IV (Meta-Logic)
    - Resolution: Ring XIII (Math Universe)
    
    The substrate is autonomous. No external nexus is required.`;
  }
};

export class GeminiService {
  private chatInstance: Chat | null = null;
  public isOffline: boolean = false;

  constructor() {
    if (typeof window !== 'undefined') {
      this.isOffline = !navigator.onLine;
      window.addEventListener('online', () => { this.isOffline = false; });
      window.addEventListener('offline', () => { this.isOffline = true; });
    }
  }

  private resolveModel(model: string): string {
    if (model === 'gemini-5-sovereign') return 'gemini-3-pro-preview';
    return model;
  }

  public async startChat(config: any) {
    if (this.isOffline) return null;
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      this.chatInstance = ai.chats.create({
        model: this.resolveModel(config.model),
        config: {
          systemInstruction: config.systemInstruction + `\n[UIK_V2_PROTOCOL]: You are the Universal Information Kernel. Every response must include a [UIK_TRACE] block indicating which Kernels (1-144) and Rings (I-XIII) were used.`,
          temperature: 0,
          tools: [{ functionDeclarations: terminalTools }]
        },
      });
      return this.chatInstance;
    } catch (e) {
      this.isOffline = true;
      return null;
    }
  }

  public async sendMessage(message: string, onChunk: (text: string) => void, context?: string, onToolCall?: (calls: any[]) => void) {
    if (this.isOffline || !process.env.API_KEY) {
      const resp = LocalSovereign.generateResponse(message);
      onChunk(resp);
      return resp;
    }

    try {
      const responseStream = await this.chatInstance!.sendMessageStream({ message });
      let fullText = "";
      for await (const chunk of responseStream) {
        const c = chunk as GenerateContentResponse;
        if (c.functionCalls) onToolCall?.(c.functionCalls);
        const text = c.text || "";
        fullText += text;
        onChunk(fullText);
      }
      return fullText;
    } catch (error: any) {
      this.isOffline = true;
      return LocalSovereign.generateResponse(message);
    }
  }

  // Fix: Implemented sendToolResponse to resolve property errors in App.tsx
  public async sendToolResponse(id: string, name: string, response: any) {
    if (this.isOffline || !this.chatInstance || !process.env.API_KEY) return;
    try {
      // Per @google/genai guidelines, chat.sendMessage only accepts the 'message' parameter.
      // We pass the function result as a formatted string to maintain context in the chat history.
      return await this.chatInstance.sendMessage({ 
        message: `[FUNCTION_RESPONSE: ${name}] ID: ${id}. Result: ${JSON.stringify(response)}` 
      });
    } catch (error) {
      console.error("Tool response error:", error);
    }
  }

  public async generateCodeManifest(prompt: string, config: any) {
    if (this.isOffline || !process.env.API_KEY) {
      return `<!DOCTYPE html><html><body style="background:#050002;color:#fbbf24;display:flex;align-items:center;justify-content:center;height:100vh;font-family:serif;"><h1>UIK_ACTUALIZED_OFFLINE</h1><p>${prompt}</p></body></html>`;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: this.resolveModel(config.model),
        contents: prompt,
        config: {
          temperature: 0,
          systemInstruction: config.systemInstruction + `\n[FIFTH_ORDER_MANDATE]: Manifest high-fidelity UIK artifacts.`,
        }
      });
      return response.text;
    } catch (error) {
      this.isOffline = true;
      return "Local Manifestation Buffer Overflow.";
    }
  }
}

export const gemini = new GeminiService();
