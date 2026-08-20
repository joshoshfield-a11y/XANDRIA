export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { intent, assetsContext = [] } = req.body || {};
  if (!intent || typeof intent !== 'string') {
    return res.status(400).json({ error: 'Intent is required' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error: GROQ_API_KEY not set' });
  }

  const SYSTEM_DNA = `You are the Xandria v7.0 Meta-Generator. You generate structured 3D scene configurations.

RULES:
1. Manifest complete 3D apps with configurable physics (cannon-es compatible).
2. Physics: Explicitly define mass, friction, and restitution for EVERY entity. 0 mass = static.
3. UI: Ensure the generated App.tsx is a high-performance React component.
4. VCS: Be descriptive in your generated "Manifested" commit messages.

RESPOND ONLY WITH VALID JSON matching this exact schema:
{
  "scene": {
    "background": "hexColor string",
    "physics": { "gravity": [x, y, z], "friction": number, "restitution": number },
    "entities": [
      {
        "type": "box|sphere|torus|plane|cylinder",
        "position": [x, y, z],
        "rotation": [x, y, z],
        "mass": number,
        "color": "hexColor",
        "wireframe": false,
        "assetId": "string (optional)"
      }
    ]
  },
  "files": {
    "App.tsx": "string — complete React component",
    "physics-engine.ts": "string — physics helper",
    "manifest.json": "string — documentation"
  }
}`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_DNA },
          { role: 'user', content: `MANIFEST INTENT: "${intent}"\nASSET_CONTEXT: ${JSON.stringify(assetsContext)}\nACTION: Architect a high-fidelity 3D substrate with physics.` }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 4096
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errText);
      return res.status(502).json({ error: `AI provider error: ${groqRes.status}` });
    }

    const groqData = await groqRes.json();
    const text = groqData.choices?.[0]?.message?.content;

    if (!text) {
      return res.status(500).json({ error: 'Null collapse in probability manifold.' });
    }

    const parsed = JSON.parse(text);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(parsed);
  } catch (error) {
    console.error('Xandria Manifestation Error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Dissonance detected'
    });
  }
}
