
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const getAutomatedFix = async (errorLog: string, currentCode: string) => {
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: `As System III CI/CD logic, analyze this crash trace and rewrite the faulty function.
    Error Log: ${errorLog}
    Current Function: ${currentCode}
    Return ONLY the corrected TypeScript function block.`,
    config: {
      temperature: 0.7,
      thinkingConfig: { thinkingBudget: 4000 }
    }
  });
  return response.text;
};

export const getBalanceTuning = async (telemetry: string) => {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Analyze this telemetry data from RL agents and suggest balance parameter updates (e.g. enemy_hp, platform_width).
    Data: ${telemetry}
    Return the response as JSON.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          suggestions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                parameter: { type: Type.STRING },
                oldValue: { type: Type.NUMBER },
                newValue: { type: Type.NUMBER },
                reason: { type: Type.STRING }
              }
            }
          }
        }
      }
    }
  });
  return JSON.parse(response.text);
};
