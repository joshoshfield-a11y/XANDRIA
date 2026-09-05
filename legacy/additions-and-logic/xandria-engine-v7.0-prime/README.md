# Xandria v7.0 Prime

**AI-Native 3D Engine — Intent → Manifestation Pipeline**

Type an intent. Watch 8 operator nodes light up in sequence. Receive a live Three.js + Cannon-es physics scene with generated React code, version-controlled artifacts, and exportable project files.

---

## Quick Start

```bash
cd additions-and-logic/xandria-engine-v7.0-prime

# 1. Install dependencies
npm install

# 2. Set your Gemini API key
cp .env.example .env
# Edit .env and replace with your key from https://aistudio.google.com/apikey

# 3. Run
npm run dev
# → http://localhost:3000
```

---

## Deploy to Vercel

```bash
cd additions-and-logic/xandria-engine-v7.0-prime
npx vercel --prod
```

**Required: Set Environment Variables in Vercel Dashboard**

Go to your Vercel project → Settings → Environment Variables, then add:

| Variable | Value | Location |
|---|---|---|
| `GEMINI_API_KEY` | Your key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Server (Production) |

⚠️ **Never commit the real key.** `.env` is gitignored. The key stays server-side — never in the client bundle.

## First Manifestation

1. Type any intent in the input field — `"a solar system"` is a good first test
2. Hit **MANIFEST**
3. Watch the operator lattice sequence: Intent → Gravity → Collision → Weave → Matrix → View → Commit → Seal
4. The **Preview** tab auto-opens with a live physics simulation
5. Switch to **Artifact** to view the generated source code
6. Use **VCS** to branch, merge, or revert timelines
7. Hit **EXPORT** to download a ZIP of the full project

---

## Architecture

| Layer | Tech | Purpose |
|---|---|---|
| UI | React 19 + Vite | Operator lattice, trace log, tabbed workspace |
| Graphics | Three.js | Background lattice + live scene preview |
| Physics | Cannon-es | Real-time rigid-body simulation |
| AI | Gemini 3 Pro Preview | Intent → structured scene JSON + code generation |
| VCS | Client-side (localStorage) | Branch, merge, commit, restore |
| Export | JSZip | Project artifact bundling |

---

## Operator Lattice (13 Active)

| ID | Name | Type |
|---|---|---|
| 01 | Void | Initialization |
| 02 | Intent | Initialization |
| 03 | Seed | Initialization |
| 13 | Weave | Logic & Flow |
| 25 | Matrix | Data & State |
| 31 | Gravity | Physics |
| 32 | Collision | Physics |
| 33 | Friction | Physics |
| 41 | View | Interaction & UI |
| 45 | Fetch | Interaction & UI |
| 65 | Commit | VCS |
| 66 | Branch | VCS |
| 67 | Merge | VCS |
| 72 | Seal | Finalization |

---

## Environment Variables

| Variable | Required | Source |
|---|---|---|
| `GEMINI_API_KEY` | Yes | [Google AI Studio](https://aistudio.google.com/apikey) |

---

## Known Limitations

- Asset Store uses mock data (Sketchfab integration placeholder)
- Persistence is localStorage only (no backend database yet)
- `googleSearch` tool removed due to `responseSchema` API conflict — asset grounding is prompt-based only

---

*Xandria v7.0 Prime — Quasi-Stable Core Online.*
