
# The Director: Encounter & Entropy Orchestrator - Full Manifest

## 1. metadata.json
```json
{
  "name": "The Director: Encounter & Entropy Orchestrator",
  "description": "A high-fidelity adaptive game direction dashboard that manages narrative pacing, environmental entropy, and dynamic NPC encounters using real-time player telemetry and LLM-driven chronicling.",
  "requestFramePermissions": []
}
```

## 2. index.html
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>The Director | Encounter & Entropy Orchestrator</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;700&family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #050505;
            color: #e5e7eb;
            overflow: hidden;
        }
        .mono { font-family: 'JetBrains+Mono', monospace; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #555; }
    </style>
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@^19.2.3",
    "react-dom/": "https://esm.sh/react-dom@^19.2.3/",
    "react/": "https://esm.sh/react@^19.2.3/",
    "@google/genai": "https://esm.sh/@google/genai@^1.35.0",
    "recharts": "https://esm.sh/recharts@^3.6.0",
    "lucide-react": "https://esm.sh/lucide-react@^0.562.0"
  }
}
</script>
</head>
<body>
    <div id="root"></div>
</body>
</html>
```

## 3. types.ts
```typescript
export enum PacingState {
  RELAXATION = 'RELAXATION',
  BUILDUP = 'BUILDUP',
  PEAK = 'PEAK',
  FADE = 'FADE',
  OMEGA = 'OMEGA_STATE',
  SINGULARITY = 'SINGULARITY_EVENT'
}

export interface Telemetry {
  health: number;
  ammo: number;
  speed: number;
  combatEfficiency: number;
  explorationRate: number;
  objectivesCompleted: number;
  objectivesFailed: number;
  recursionDepth: number; 
  coherenceIndex: number; 
  stressIndex: number;
}

export interface WorldState {
  entropy: number; 
  tension: number; 
  corruption: number; 
  pacing: PacingState;
  iteration: number; 
}

export interface Encounter {
  id: string;
  type: 'AMBUSH' | 'DIALOGUE' | 'PUZZLE' | 'LOOT' | 'BOSS' | 'SINGULARITY';
  difficulty: number;
  timestamp: number;
  status: 'ACTIVE' | 'RESOLVED' | 'FAILED' | 'COLLAPSED';
}

export interface ChronicleEntry {
  id: string;
  event: string;
  narrative: string;
  timestamp: number;
  impact: 'MINOR' | 'SIGNIFICANT' | 'CATASTROPHIC' | 'AXIOMATIC';
}

export interface DifficultyConfig {
  enemyHealthMult: number;
  spawnRateMult: number;
  resourceFrequency: number;
  difficultyTier: 'EASY' | 'NORMAL' | 'HARD' | 'LETHAL' | 'OMEGA';
  recursionPower: number;
}

export interface PlayerFeedback {
  rating: number;
  comment: string;
  timestamp: number;
}

export interface SessionRecord {
  id: string;
  telemetry: Telemetry;
  feedback?: PlayerFeedback;
  difficultyConfig: DifficultyConfig;
  coherenceDelta: number;
}
```

## 4. services/geminiService.ts
```typescript
import { GoogleGenAI, Type } from "@google/genai";
import { Telemetry, WorldState, Encounter, SessionRecord, DifficultyConfig } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });

export async function generateChronicleEntry(
  telemetry: Telemetry,
  worldState: WorldState,
  latestEncounter: Encounter | null
) {
  const prompt = `
    Invoke Protocol: [SUPREME_SCRIBE_OMEGA].
    Objective: Transcribe Recursive Reality Iteration ${worldState.iteration}/72 into AAA Narrative History.
    
    Current System Coherence: ${(telemetry.coherenceIndex * 100).toFixed(2)}%.
    World State Vector:
    - Pacing Phase: ${worldState.pacing}
    - Entropy Factor: ${worldState.entropy.toFixed(2)}
    - Corruption Index: ${worldState.corruption.toFixed(2)}
    - Recursion Depth: ${telemetry.recursionDepth.toFixed(2)}
    
    Event Focus: ${latestEncounter ? `${latestEncounter.type} (Difficulty Scalar: ${latestEncounter.difficulty.toFixed(2)})` : 'Ambient Exploration'}
    
    Output Format: JSON { narrative: string, event: string, impact: string }
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            narrative: { type: Type.STRING },
            event: { type: Type.STRING },
            impact: { type: Type.STRING },
          },
          required: ["narrative", "event", "impact"]
        }
      }
    });

    return JSON.parse(response.text);
  } catch (error) {
    return {
      narrative: "The chronicle fractures as the iteration exceeds current coherence limits.",
      event: "LATTICE_RUPTURE",
      impact: "AXIOMATIC"
    };
  }
}

export async function analyzePerformance(
  history: SessionRecord[],
  currentTelemetry: Telemetry
): Promise<DifficultyConfig> {
  const prompt = `
    Invoke Protocol: [ARCHITECT_PRIME_CALIBRATION].
    Task: Orchestrate 72x Power Scaling for Recursive Loop Upgrade.
    Return JSON { enemyHealthMult, spawnRateMult, resourceFrequency, difficultyTier, recursionPower }.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            enemyHealthMult: { type: Type.NUMBER },
            spawnRateMult: { type: Type.NUMBER },
            resourceFrequency: { type: Type.NUMBER },
            difficultyTier: { type: Type.STRING },
            recursionPower: { type: Type.NUMBER },
          },
          required: ["enemyHealthMult", "spawnRateMult", "resourceFrequency", "difficultyTier", "recursionPower"]
        }
      }
    });

    return JSON.parse(response.text);
  } catch (error) {
    return {
      enemyHealthMult: 1.0, spawnRateMult: 1.0, resourceFrequency: 1.0, difficultyTier: 'NORMAL', recursionPower: 0.1
    };
  }
}
```

## 5. components/EntropyOverlay.tsx
(Refer to the full EntropyOverlay.tsx provided in the XML changes)

## 6. components/TensionChart.tsx
(Refer to the full TensionChart.tsx provided in the XML changes)

## 7. App.tsx
(Refer to the full App.tsx provided in the XML changes)
