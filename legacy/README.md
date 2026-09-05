# 🜂 XANDRIA

> **Unified Engine v4.0** — [View Complete Architecture Spec](XANDRIA_ARCHITECTURE_v4.0.md)

## Quick Links

| Resource | Description |
|----------|-------------|
| [Architecture v4.0](XANDRIA_ARCHITECTURE_v4.0.md) | Complete 72-operator lattice, 13-layer stack, 530-file map |
| [Unified Layer](unified/) | Consolidation bridge — v3.0 engine → v7.0 demo |
| [v7.0 Prime Demo](additions-and-logic/xandria-engine-v7.0-prime/) | Deployed React + Three.js + physics demo |
| [Core Engine](XANDRIAv3.0/) | 72-operator lattice, XUAXUN synthesis, stochastic evolution |

---

# XANDRIA

**Type any intent. Watch a 3D world with real physics appear in seconds.**

XANDRIA is an AI-native engine that transforms natural language into fully interactive 3D physics simulations — complete with gravity, collision, friction, and a built-in version control system for every world you manifest.

[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Powered by Gemini](https://img.shields.io/badge/AI-Gemini%203%20Pro-blue)](https://aistudio.google.com)
[![Three.js](https://img.shields.io/badge/3D-Three.js%200.182-black)](https://threejs.org)
[![CI](https://github.com/joshoshfield-a11y/XANDRIA/actions/workflows/ci.yml/badge.svg)](https://github.com/joshoshfield-a11y/XANDRIA/actions/workflows/ci.yml)

---

## Quick Start

### 1. Get a free Gemini API key
→ [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — 1,500 free requests/day

### 2. Clone and configure
```bash
git clone https://github.com/joshoshfield-a11y/XANDRIA.git
cd XANDRIA/additions-and-logic/xandria-engine-v7.0-prime
cp .env.example .env
# Open .env and set: GEMINI_API_KEY=your_key_here
```

### 3. Run
```bash
npm install && npm run dev
# → http://localhost:3000
```

### 4. Manifest
Type any intent. Hit **MANIFEST**. A live 3D physics scene appears in ~5 seconds.

Try: `"solar system with asteroid belt"` · `"zero-g neon room"` · `"crumbling tower with debris"`

---

## How It Works

```
Intent (plain English)
    ↓
Gemini 3 Pro → structured JSON scene config + React/Three.js source files
    ↓
Three.js + Cannon-ES → live interactive 3D physics in browser
    ↓
Chronos VCS → commit / branch / merge / restore every manifestation
```

---

## Features

| Feature | What it does |
|---|---|
| **Intent Manifester** | Natural language → 3D app in ~5 seconds |
| **Physics Engine** | Cannon-ES rigid bodies: gravity, friction, restitution per entity |
| **Chronos VCS** | Commit/branch/merge timeline in localStorage |
| **Artifact Export** | Download any manifestation as a `.zip` React project |
| **Asset Store** | Inject 3D model references into generation context |
| **Operator Lattice** | 72-node animated synthesis visualizer |

---

## Stack

React 19 · TypeScript · Vite 6 · Three.js 0.182 · Cannon-ES 0.20 · Gemini 3 Pro · JSZip

---

## Repo Structure

```
XANDRIA/
├── additions-and-logic/
│   └── xandria-engine-v7.0-prime/   ← START HERE
│       ├── App.tsx
│       ├── services/geminiService.ts
│       ├── components/
│       └── .env.example
├── XANDRIAv3.0/                     ← v3.0 engine (in development)
├── OPERATORS.md                     ← 216-operator reference
└── ARCHITECTURE.md
```

---

## License
MIT

---

## 🔷 ARCF Governance

XANDRIA integrates the [Alexandria Reality-Contact Framework](https://github.com/joshoshfield-a11y/alexandria-os) for empirical validation of all claims, metrics, and automated agents.

### Metric Cards

Every major subsystem maintains a YAML metric record with counter-metrics, gaming paths, off-dashboard audit plans, and expiry rules:

| Metric | File | Status |
|--------|------|--------|
| Correlation Matrix Accuracy | [`metrics/correlation-matrix.yaml`](metrics/correlation-matrix.yaml) | Semantic: 4, Implementation: 5, Operational: 2 |
| ATE Precision | [`metrics/ate-precision.yaml`](metrics/ate-precision.yaml) | Semantic: 5, Implementation: 4, Operational: 2 |
| GMECP Pass Rate | [`metrics/gmecp-pass-rate.yaml`](metrics/gmecp-pass-rate.yaml) | Semantic: 4, Implementation: 4, Operational: 1 |
| Aegis Safety Filter | [`metrics/aegis-safety.yaml`](metrics/aegis-safety.yaml) | Semantic: 4, Implementation: 3, Operational: 1 |
| Cross-Module Consistency | [`metrics/consistency-score.yaml`](metrics/consistency-score.yaml) | Semantic: 3, Implementation: 4, Operational: 2 |

### Agent Constitution

The generation pipeline agent is registered with mandate, non-goals, authority bounds, and kill-switch:

- [`agents/generation-pipeline.yaml`](agents/generation-pipeline.yaml)

### Pre-Mortem Required

Before any T2-T4 decision (reversible pilot through consequential automation), run the pre-mortem gate defined in `alexandria-os/runtime/pre-mortem-gate.yaml`.
