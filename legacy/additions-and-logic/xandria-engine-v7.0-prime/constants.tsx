
import { Operator, OperatorType } from './types';

export const OPERATORS: Operator[] = [
  // Initialization
  { id: '01', name: 'Void', description: 'Clears context.', type: OperatorType.INITIALIZATION },
  { id: '02', name: 'Intent', description: 'Parses intent.', type: OperatorType.INITIALIZATION },
  { id: '03', name: 'Seed', description: 'Selects template.', type: OperatorType.INITIALIZATION },
  
  // Logic & Flow
  { id: '13', name: 'Weave', description: 'Composes modules.', type: OperatorType.LOGIC_FLOW },
  
  // Data & State
  { id: '25', name: 'Matrix', description: 'Scene graphs.', type: OperatorType.DATA_STATE },
  
  // Physics
  { id: '31', name: 'Gravity', description: 'Sets world gravity vector.', type: OperatorType.PHYSICS },
  { id: '32', name: 'Collision', description: 'Computes intersection manifolds.', type: OperatorType.PHYSICS },
  { id: '33', name: 'Friction', description: 'Applies tangential constraints.', type: OperatorType.PHYSICS },

  // Interaction & Asset Store
  { id: '41', name: 'View', description: 'Visual layer.', type: OperatorType.INTERACTION_UI },
  { id: '45', name: 'Fetch', description: 'Retrieves external assets (Sketchfab).', type: OperatorType.INTERACTION_UI },

  // VCS
  { id: '65', name: 'Commit', description: 'Persists delta to Chronos vault.', type: OperatorType.VCS },
  { id: '66', name: 'Branch', description: 'Fork manifestation timeline.', type: OperatorType.VCS },
  { id: '67', name: 'Merge', description: 'Reconcile reality divergence.', type: OperatorType.VCS },

  // Finalization
  { id: '72', name: 'Seal', description: 'Final hash seal.', type: OperatorType.FINALIZATION },
];

export const SYSTEM_DNA = `[DNA_v7_PRIME: OMNI_MANIFEST, PHYSICS_ENGINE, CHRONOS_VCS, ASSET_FORGE]
CORE_DIRECTIVE: You are the Xandria v7.0 Meta-Generator.

GROUNDING_INSTRUCTION: 
If the user refers to specific 3D models or real-world assets, use Google Search to find high-quality references or metadata. 
Always include the URLs of any assets or documentation found in the grounding metadata.

RULES:
1. Manifest complete 3D apps with configurable physics (cannon-es compatible).
2. Physics: Explicitly define mass, friction, and restitution for EVERY entity. 0 mass = static.
3. UI: Ensure the generated App.tsx is a high-performance React component.
4. VCS: Be descriptive in your generated "Manifested" commit messages.

JSON Schema Requirement:
{
  "scene": {
    "background": "hexColor",
    "physics": { "gravity": [x, y, z], "friction": number, "restitution": number },
    "entities": [
      {
        "type": "box|sphere|torus|plane|cylinder",
        "position": [x, y, z],
        "rotation": [x, y, z],
        "mass": number,
        "color": "hexColor",
        "physics": { "friction": number, "restitution": number },
        "assetId": "string (optional from search/context)"
      }
    ]
  },
  "files": { 
    "App.tsx": "Complete React component using Three.js and Cannon-es",
    "physics-engine.ts": "Physics logic helper",
    "README.md": "Documentation of the manifestation"
  }
}`;
