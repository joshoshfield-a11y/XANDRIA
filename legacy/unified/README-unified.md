# XANDRIA Unified v4.0

## The Complete System

This is the consolidated, unified version of the XANDRIA engine. It brings together:

- **72-operator lattice** (UEA + X13 + Alpha) — the full CLM
- **13-layer development stack** — from hardware to abstract frameworks
- **3-phase synthesis pipeline** — @VOID → @FABRIC → @ARTIFACT
- **8 sub-applications** — each a complete React/Three.js app
- **Stochastic evolution engine** — mean-reverting diffusion for stability
- **Synesthesia bridge** — 5-modality cross-sensory mapping
- **Quality validation** — JMetric + 50+ validation rules
- **Test infrastructure** — 6 suite types, smoke tests, CI/CD

## Quick Start

```bash
# Install dependencies
npm install

# Run the unified app router
npm run dev

# Or run any specific sub-app
npm run app:v7          # v7.0 Prime (the deployed demo)
npm run app:aethegard   # Universe simulation
npm run app:logos       # ECS logic orchestration
npm run app:mythos      # Asset synthesis pipeline
npm run app:simulation  # QA matrix
npm run app:architect   # Meta-procedural engine
npm run app:meta        # Meta-engine protocol

# Run the CLI
npm run engine:synthesize "a solar system" gaming

# Run tests
npm test                # Core tests
npm run test:engine     # Engine tests
npm run test:quality    # JMetric quality scoring
npm run test:smoke      # Smoke tests
npm run test:all        # Everything
```

## Architecture

See `XANDRIA_ARCHITECTURE_v4.0.md` for the complete system map.

## Operator Lattice

The 72 operators are organized into three classes:

| Class | Operators | Domain |
|-------|-----------|--------|
| UEA | L1–L18 | Foundational |
| X13 | L19–L36 | Dynamic |
| Alpha | L37–L72 | Relational + Governance |

## Sub-Apps

| App | Path | Status |
|-----|------|--------|
| v7.0 Prime | `additions-and-logic/xandria-engine-v7.0-prime/` | Stable |
| Aethegard Universe | `additions-and-logic/aethegard-glass-bottle-universe/` | Beta |
| Logos Kernel | `additions-and-logic/logos_-logic-orchestration-kernel/` | Beta |
| Mythos Pipeline | `additions-and-logic/mythos_-asset-synthesis-pipeline/` | Beta |
| Simulation Matrix | `additions-and-logic/simulation-&-qa-matrix-v7.0/` | Beta |
| Architect Engine | `additions-and-logic/architect_-meta-procedural-engine/` | Beta |
| Meta Protocol | `additions-and-logic/xandria-meta-engine-protocol/` | Beta |
| Asset Forge | `additions-and-logic/aethelgard_-sovereign-asset-forge/` | Beta |

## License

MIT
