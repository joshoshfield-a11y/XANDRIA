# XANDRIA API Reference

## 🎯 **Core API**

### **XUAXUN Engine**

#### **Constructor**
```typescript
import { XUAXUN_Engine } from './additions-and-logic/synthesized_engine'

const engine = new XUAXUN_Engine()
```

#### **Primary Methods**

##### **manifest(intent: string): Promise<Artifact>**
Generates complete application from natural language intent.

**Parameters:**
- `intent`: Natural language description of desired application

**Returns:** Promise resolving to artifact object with:
- `id`: Unique artifact identifier
- `intent`: Original user intent
- `codebase`: Generated source code
- `embeddings`: Perceptual embeddings for recall
- `timestamp`: Generation timestamp
- `provenance`: Cryptographic seal

**Example:**
```typescript
const artifact = await engine.manifest("Create a 3D game with physics");
console.log(artifact.codebase); // Complete game source code
```

##### **ingestIntent(intent: string): Promise<string>**
Processes intent into UTL script without full generation.

**Parameters:**
- `intent`: Natural language description

**Returns:** UTL script string with VOID→FABRIC→ARTIFACT structure

##### **recallByFeeling(embeddings: PerceptualEmbedding): Artifact[]**
Retrieves artifacts by similarity to perceptual embeddings.

**Parameters:**
- `embeddings`: Target perceptual embedding

**Returns:** Array of similar artifacts sorted by relevance

---

### **Unified Graphics Engine**

#### **Constructor**
```typescript
import { createUnifiedGraphicsEngine, GraphicsStage } from './graphics/engines/UnifiedGraphicsEngine'

const graphics = createUnifiedGraphicsEngine({
  stage: GraphicsStage.PLANETARY,
  enableShaders: true,
  enablePostProcessing: true,
  enableSynesthesia: true,
  targetFPS: 60,
  maxMemory: 100 * 1024 * 1024
});
```

#### **Generation Methods**

##### **generateTerrain(options: TerrainOptions): Promise<THREE.Mesh>**
Creates procedural terrain mesh.

**Options:**
- `size`: Terrain dimensions (default: 100)
- `resolution`: Mesh resolution (default: 128)
- `heightScale`: Height multiplier (default: 10)
- `noiseScale`: Noise frequency (default: 0.01)
- `seed`: Random seed for reproducibility

##### **generateShader(state: any): Promise<THREE.ShaderMaterial>**
Generates GLSL shader from state parameters.

**Parameters:**
- `state`: Object with shader parameters (value, entropy, etc.)

**Returns:** Three.js ShaderMaterial with vertex/fragment shaders

##### **setupAtmosphere(options: AtmosphereOptions): Promise<void>**
Configures atmospheric scattering and sky rendering.

**Options:**
- `turbidity`: Atmospheric turbidity (2-10)
- `rayleigh`: Rayleigh scattering coefficient
- `mieCoefficient`: Mie scattering coefficient
- `sunElevation`: Sun elevation angle (degrees)
- `sunAzimuth`: Sun azimuth angle (degrees)

---

### **Unified Test Suite**

#### **Constructor**
```typescript
import { createUnifiedTestSuite } from './tests/UnifiedTestSuite'

const testSuite = createUnifiedTestSuite({
  enableGraphicsTests: true,
  enablePerformanceTests: true,
  enableErrorPrevention: true,
  testTimeout: 30000,
  maxMemoryUsage: 100 * 1024 * 1024,
  targetFPS: 60
});
```

#### **Execution Methods**

##### **runAllTests(): Promise<TestReport[]>**
Executes complete test suite across all categories.

**Returns:** Array of test results with pass/fail status and metrics

##### **runUnitTests(): Promise<TestReport[]>**
Runs unit tests for engine functionality.

##### **runGraphicsTests(): Promise<TestReport[]>**
Runs graphics pipeline validation tests.

##### **runPerformanceTests(): Promise<TestReport[]>**
Runs performance benchmarking tests.

##### **runErrorPreventionTests(): Promise<TestReport[]>**
Runs fault tolerance and input validation tests.

##### **generateReport(): string**
Generates formatted test report with summary and details.

---

## 🔧 **Legacy API (Backward Compatibility)**

### **ΩAI Class**

#### **parseIntent(userIntent: string): Promise<IntentResult>**
Legacy intent parsing method (now powered by XUAXUN).

**Parameters:**
- `userIntent`: Natural language intent

**Returns:**
```typescript
{
  operators: number[],        // Selected operator IDs
  confidence: number,         // Processing confidence (0-1)
  embeddings: number[],       // Token embeddings
  synestheticBindings?: any[], // Enhanced synesthetic mappings
  utlScript?: string         // Generated UTL script
}
```

#### **Enhanced Methods**
```typescript
// Direct access to XUAXUN capabilities
await ΩAI.manifest(intent)     // Full artifact generation
ΩAI.recallByFeeling(embeddings) // Perceptual recall
ΩAI.getVault()                // Access artifact storage
```

---

## 📊 **Type Definitions**

### **Core Types**
```typescript
interface Artifact {
  id: string;
  intent: string;
  codebase: string;
  embeddings: PerceptualEmbedding;
  timestamp: number;
  provenance: string;
}

interface PerceptualEmbedding {
  chroma_vector: [number, number, number];  // RGB color representation
  audio_fingerprint: number;                 // Fundamental frequency
  spatial_weight: number;                    // Mass/gravity factor
  texture_roughness: number;                 // Surface characteristics
}

interface TestReport {
  testName: string;
  result: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
  duration: number;
  error?: string;
  metrics?: any;
}
```

### **Graphics Types**
```typescript
interface TerrainOptions {
  size?: number;
  resolution?: number;
  heightScale?: number;
  noiseScale?: number;
  seed?: string;
}

interface AtmosphereOptions {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  sunElevation: number;
  sunAzimuth: number;
}

enum GraphicsStage {
  PLANETARY = 'planetary',
  LOD = 'lod',
  BRIDGE = 'bridge',
  SYNESTHETIC = 'synesthetic'
}
```

---

## 🌐 **HTTP API Endpoints**

### **Base URL:** `http://localhost:8000`

#### **POST /api/manifest**
Generates artifact from intent.

**Request:**
```json
{
  "intent": "Create a React todo application"
}
```

**Response:**
```json
{
  "artifact": {
    "id": "art_1234567890",
    "intent": "Create a React todo application",
    "codebase": "// Generated React component...",
    "embeddings": {
      "chroma_vector": [0.2, 0.8, 0.6],
      "audio_fingerprint": 523.25,
      "spatial_weight": 1.2,
      "texture_roughness": 0.3
    },
    "timestamp": 1700000000000,
    "provenance": "sha256:abc123..."
  }
}
```

#### **GET /api/vault**
Retrieves stored artifacts.

**Query Parameters:**
- `limit`: Maximum number of artifacts (default: 50)
- `offset`: Pagination offset (default: 0)
- `intent`: Filter by intent substring

#### **POST /api/recall**
Retrieves artifacts by perceptual similarity.

**Request:**
```json
{
  "embeddings": {
    "chroma_vector": [0.5, 0.5, 0.5],
    "audio_fingerprint": 440,
    "spatial_weight": 1.0,
    "texture_roughness": 0.0
  },
  "limit": 10
}
```

---

## ⚙️ **Configuration**

### **Environment Variables**
```bash
# Engine Configuration
XANDRIA_STOCHASTIC_KAPPA=0.5      # Mean reversion speed
XANDRIA_STOCHASTIC_THETA=1.0      # Target equilibrium
XANDRIA_STOCHASTIC_SIGMA=0.2      # Diffusion scale

# Graphics Configuration
XANDRIA_GRAPHICS_STAGE=planetary  # Default graphics stage
XANDRIA_TARGET_FPS=60             # Target frame rate
XANDRIA_MAX_MEMORY=104857600      # Max memory usage (100MB)

# Testing Configuration
XANDRIA_TEST_TIMEOUT=30000        # Test timeout (ms)
XANDRIA_ENABLE_GRAPHICS_TESTS=true
XANDRIA_ENABLE_PERFORMANCE_TESTS=true

# Security Configuration
XANDRIA_ENABLE_SEALING=true       # Cryptographic sealing
XANDRIA_MAX_INTENT_SIZE=10000     # Maximum intent length
```

### **Runtime Configuration**
```typescript
const config = {
  engine: {
    stochastic: { kappa: 0.5, theta: 1.0, sigma: 0.2 },
    operators: { enableAll: true, customOperators: [] }
  },
  graphics: {
    stage: GraphicsStage.PLANETARY,
    shaders: { enableDynamic: true, cacheShaders: true },
    postProcessing: { enableBloom: true, enableDOF: false }
  },
  testing: {
    enableFullSuite: true,
    performanceThresholds: { maxGenerationTime: 5000, maxMemory: 100MB }
  }
};
```

---

## 🚨 **Error Handling**

### **Standard Error Codes**
```typescript
enum XandriaError {
  INTENT_TOO_LONG = 'INTENT_TOO_LONG',
  INVALID_SYNTAX = 'INVALID_SYNTAX',
  RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED',
  GRAPHICS_UNAVAILABLE = 'GRAPHICS_UNAVAILABLE',
  CONVERGENCE_FAILED = 'CONVERGENCE_FAILED',
  VALIDATION_FAILED = 'VALIDATION_FAILED'
}
```

### **Error Response Format**
```json
{
  "error": {
    "code": "CONVERGENCE_FAILED",
    "message": "Artifact generation failed to converge within J-metric threshold",
    "details": {
      "finalJMetric": 0.85,
      "targetJMetric": 0.95,
      "iterations": 50
    },
    "timestamp": 1700000000000
  }
}
```

---

## 📈 **Performance Monitoring**

### **Metrics Endpoints**
- `GET /metrics`: Prometheus-compatible metrics
- `GET /health`: System health status
- `GET /performance`: Real-time performance data

### **Key Metrics**
```prometheus
# Engine Metrics
xandria_engine_generations_total{cache="hit"} 12543
xandria_engine_generation_duration_seconds{quantile="0.5"} 2.34
xandria_engine_memory_usage_bytes 67108864

# Graphics Metrics
xandria_graphics_fps{stage="planetary"} 58.5
xandria_graphics_memory_bytes 134217728
xandria_graphics_shaders_compiled_total 156

# Test Metrics
xandria_tests_run_total{result="pass"} 8923
xandria_tests_duration_seconds{category="performance"} 28.5
xandria_coverage_percentage 98.7
```

---

## 🔗 **Integration Examples**

### **React Application**
```tsx
import React, { useState } from 'react';
import { XUAXUN_Engine } from './path/to/engine';

function XandriaGenerator() {
  const [intent, setIntent] = useState('');
  const [artifact, setArtifact] = useState(null);
  const [loading, setLoading] = useState(false);

  const engine = new XUAXUN_Engine();

  const generateArtifact = async () => {
    setLoading(true);
    try {
      const result = await engine.manifest(intent);
      setArtifact(result);
    } catch (error) {
      console.error('Generation failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <textarea
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        placeholder="Describe your application..."
      />
      <button onClick={generateArtifact} disabled={loading}>
        {loading ? 'Generating...' : 'Generate'}
      </button>

      {artifact && (
        <pre>{artifact.codebase}</pre>
      )}
    </div>
  );
}
```

### **Node.js Server**
```javascript
const express = require('express');
const { XUAXUN_Engine } = require('./engine');

const app = express();
const engine = new XUAXUN_Engine();

app.use(express.json());

app.post('/api/manifest', async (req, res) => {
  try {
    const { intent } = req.body;
    const artifact = await engine.manifest(intent);
    res.json({ artifact });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => {
  console.log('XANDRIA API server running on port 3000');
});
```

---

## 📚 **Additional Resources**

- [Architecture Overview](./ARCHITECTURE.md)
- [Operator Reference](./OPERATORS.md)
- [Development Guide](./DEVELOPMENT.md)
- [Deployment Guide](./DEPLOYMENT.md)
- [Test Suite Documentation](./tests/README.md)