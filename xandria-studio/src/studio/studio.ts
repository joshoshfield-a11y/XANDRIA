/**
 * Xandria Studio UI — prompt → GameSpec → live preview (iframe running player.html) → export.
 * Works in browser (vite dev / built) and inside the Electron shell (file export via IPC).
 */
import { generateSpec } from '../generator/generate';
import { generateWithLLM } from '../generator/llm';
import { GENRE_LABELS } from '../blueprints/index';
import { validateSpec, normalizeSpec, type Genre, type GameSpec, type QualityMode } from '@spec';

declare global {
  interface Window { xandria?: { saveFile(name: string, content: string): Promise<string | null> } }
}

const PRESETS = [
  'epic sword adventure through ancient ruins at dusk',
  'neon cyberpunk fps arena at night, brutal difficulty',
  'racing through a volcanic canyon, ash storm',
  'dreamy platformer in a surreal dreamscape, easy',
  'top-down horde survival in a frozen wasteland at night',
  'tropical island racing grand prix at sunset',
];

function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const css = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Segoe UI',system-ui,sans-serif; background:#0a0d14; color:#dfe6ef; height:100vh; overflow:hidden; }
  #layout { display:flex; height:100vh; }
  #side { width:360px; min-width:360px; padding:18px; display:flex; flex-direction:column; gap:12px;
          background:#0e1220; border-right:1px solid #1e2638; overflow-y:auto; }
  h1 { font-size:19px; letter-spacing:.22em; margin:0; color:#7af7ff; }
  h1 small { display:block; font-size:10px; letter-spacing:.3em; color:#5a6a85; margin-top:2px; }
  textarea { width:100%; height:86px; background:#131a2a; color:#e6ecf5; border:1px solid #2a3550; border-radius:10px;
             padding:10px 12px; font-size:14px; resize:none; outline:none; }
  textarea:focus { border-color:#3fd8ff; }
  select, .row input, #online input { width:100%; background:#131a2a; color:#e6ecf5; border:1px solid #2a3550; border-radius:8px; padding:8px 10px; font-size:13px; }
  .row { display:flex; gap:8px; }
  .lbl { font-size:10px; letter-spacing:.18em; color:#5a6a85; margin-bottom:4px; }
  button { cursor:pointer; border:1px solid #2a3550; border-radius:10px; padding:11px; font-size:13.5px; font-weight:600;
           letter-spacing:.06em; background:linear-gradient(180deg,#24304a,#182034); color:#e6ecf5; }
  button:hover { border-color:#3fd8ff; }
  button.primary { background:linear-gradient(180deg,#1f6d8a,#144256); border-color:#3fd8ff; }
  .presets { display:flex; flex-wrap:wrap; gap:6px; }
  .presets button { font-size:11px; padding:6px 9px; font-weight:400; opacity:.85; }
  #frame-wrap { flex:1; position:relative; background:#000; }
  #game { width:100%; height:100%; border:0; display:block; }
  #empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:10px;
           color:#3a4a65; letter-spacing:.2em; font-size:13px; }
  #meta { font-size:11px; color:#5a6a85; line-height:1.5; white-space:pre-wrap; max-height:150px; overflow:auto; }
  .badge { display:inline-block; padding:2px 8px; border-radius:6px; background:#1a2438; font-size:10.5px; margin:2px 2px 0 0; color:#8fa5c8; }
`;

function el(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild as HTMLElement;
}

export function mountStudio(root: HTMLElement, opts: { playerUrl?: string } = {}) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  root.innerHTML = `
    <div id="layout">
      <div id="side">
        <h1>XANDRIA STUDIO<small>INTENT → PLAYABLE GAME</small></h1>
        <div><div class="lbl">DESCRIBE YOUR GAME</div><textarea id="prompt" placeholder="a dark knight questing through volcanic ruins, brutal difficulty…"></textarea></div>
        <div class="presets" id="presets"></div>
        <div class="row">
          <div style="flex:1"><div class="lbl">GENRE</div><select id="genre"><option value="">auto</option></select></div>
          <div style="flex:1"><div class="lbl">DIFFICULTY</div><select id="diff"><option value="">auto</option><option>easy</option><option>normal</option><option>hard</option></select></div>
        </div>
        <div><div class="lbl">GRAPHICS QUALITY</div><select id="quality"><option value="retro">retro (PS2)</option><option value="standard">standard</option><option value="high">high</option></select></div>
        <details id="online"><summary style="cursor:pointer;font-size:11px;letter-spacing:.18em;color:#5a6a85">🌐 ONLINE / AI OPTIONS</summary>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
            <div><div class="lbl">LLM MODE</div><select id="llm-mode"><option value="">off (deterministic)</option><option value="flavor">flavor (names/colors)</option><option value="architect">architect (full spec)</option></select></div>
            <div><div class="lbl">LLM ENDPOINT</div><input id="llm-endpoint" placeholder="http://localhost:11434/v1"/></div>
            <div class="row">
              <div style="flex:1"><div class="lbl">API KEY</div><input id="llm-key" type="password" placeholder="optional"/></div>
              <div style="flex:1"><div class="lbl">MODEL</div><input id="llm-model" placeholder="llama3.1"/></div>
            </div>
            <div><div class="lbl">ASSET PACKS (.glb/.gltf URLs, one per line)</div><textarea id="asset-packs" style="height:56px" placeholder="trees=https://example.com/trees.glb"></textarea></div>
          </div>
        </details>
        <button class="primary" id="generate">⚡ GENERATE &amp; PLAY</button>
        <div class="row"><button id="export" style="flex:1">⬇ EXPORT .HTML</button><button id="copy" style="flex:1">🔗 SHARE LINK</button></div>
        <div id="meta"></div>
      </div>
      <div id="frame-wrap"><div id="empty">✦<br/>GENERATE A GAME TO PLAY IT HERE</div><iframe id="game" style="display:none"></iframe></div>
    </div>`;

  const prompt = root.querySelector<HTMLTextAreaElement>('#prompt')!;
  const genreSel = root.querySelector<HTMLSelectElement>('#genre')!;
  const diffSel = root.querySelector<HTMLSelectElement>('#diff')!;
  const meta = root.querySelector<HTMLElement>('#meta')!;
  const frame = root.querySelector<HTMLIFrameElement>('#game')!;
  const empty = root.querySelector<HTMLElement>('#empty')!;
  for (const [g, label] of Object.entries(GENRE_LABELS)) {
    genreSel.appendChild(el(`<option value="${g}">${label}</option>`) as HTMLOptionElement);
  }
  const qualitySel = root.querySelector<HTMLSelectElement>('#quality')!;
  const llmMode = root.querySelector<HTMLSelectElement>('#llm-mode')!;
  const llmEndpoint = root.querySelector<HTMLInputElement>('#llm-endpoint')!;
  const llmKey = root.querySelector<HTMLInputElement>('#llm-key')!;
  const llmModel = root.querySelector<HTMLInputElement>('#llm-model')!;
  const assetPacks = root.querySelector<HTMLTextAreaElement>('#asset-packs')!;
  try {
    const saved = JSON.parse(localStorage.getItem('xandria.studio.online') ?? '{}');
    qualitySel.value = saved.quality ?? 'retro';
    llmMode.value = saved.llmMode ?? '';
    llmEndpoint.value = saved.llmEndpoint ?? '';
    llmKey.value = saved.llmKey ?? '';
    llmModel.value = saved.llmModel ?? '';
    assetPacks.value = saved.assetPacks ?? '';
  } catch { /* ignore */ }
  const persistOnline = () => {
    try {
      localStorage.setItem('xandria.studio.online', JSON.stringify({
        quality: qualitySel.value, llmMode: llmMode.value, llmEndpoint: llmEndpoint.value,
        llmKey: llmKey.value, llmModel: llmModel.value, assetPacks: assetPacks.value,
      }));
    } catch { /* ignore */ }
  };
  for (const e of [qualitySel, llmMode, llmEndpoint, llmKey, llmModel, assetPacks]) e.addEventListener('change', persistOnline);

  const presets = root.querySelector<HTMLElement>('#presets')!;
  for (const p of PRESETS) {
    const b = el(`<button>${p.split(',')[0].slice(0, 32)}…</button>`);
    b.addEventListener('click', () => { prompt.value = p; });
    presets.appendChild(b);
  }

  let lastSpec = '';
  const playerBase = opts.playerUrl ?? 'player.html';

  const applyOnline = (spec: GameSpec): GameSpec => {
    const next = JSON.parse(JSON.stringify(spec)) as GameSpec;
    next.custom = next.custom ?? {};
    next.custom.quality = qualitySel.value as QualityMode;
    const packs: Record<string, string> = {};
    for (const line of assetPacks.value.split('\n')) {
      const m = line.match(/^\s*([\w-]+)\s*=\s*(https?:\/\/\S+\.(?:glb|gltf))\s*$/i);
      if (m) packs[m[1]] = m[2];
    }
    if (Object.keys(packs).length) next.custom.assets = { enabled: true, packs };
    const v = validateSpec(next);
    return v.ok ? normalizeSpec(next) : spec;
  };

  const generate = async () => {
    const intent = prompt.value.trim() || 'a heroic adventure in the forest';
    const genOpts = {
      genre: (genreSel.value || undefined) as Genre | undefined,
      difficulty: (diffSel.value || undefined) as 'easy' | 'normal' | 'hard' | undefined,
    };
    let spec: GameSpec;
    let llmNote = '';
    if (llmMode.value && llmEndpoint.value.trim() && llmModel.value.trim()) {
      meta.innerHTML = '<i>contacting LLM…</i>';
      const r = await generateWithLLM(intent, {
        endpoint: llmEndpoint.value.trim(),
        apiKey: llmKey.value.trim() || undefined,
        model: llmModel.value.trim(),
        mode: llmMode.value as 'flavor' | 'architect',
      }, genOpts);
      spec = r.spec;
      llmNote = r.llmUsed ? `<span class="badge">llm:${r.mode}</span>` : '<span class="badge">llm:fallback</span>';
    } else {
      spec = generateSpec(intent, genOpts);
    }
    spec = applyOnline(spec);
    const v = validateSpec(spec);
    if (!v.ok) { meta.textContent = 'SPEC INVALID:\n' + v.errors.join('\n'); return; }
    lastSpec = JSON.stringify(spec);
    const url = `${playerBase}?spec=${b64url(lastSpec)}`;
    frame.src = url;
    frame.style.display = 'block';
    empty.style.display = 'none';
    meta.innerHTML =
      `<span class="badge">${GENRE_LABELS[spec.meta.genre]}</span><span class="badge">${spec.theme.environment}</span>` +
      `<span class="badge">${spec.theme.timeOfDay}</span><span class="badge">${spec.rules.difficulty}</span>` +
      `<span class="badge">seed ${spec.meta.seed}</span>${llmNote}<span class="badge">${spec.custom?.quality ?? 'retro'}</span><br/><br/><b style="color:#8fa5c8">${spec.meta.name}</b> — ${spec.objective.description}`;
  };

  root.querySelector('#generate')!.addEventListener('click', generate);
  prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });

  root.querySelector('#copy')!.addEventListener('click', async () => {
    if (!lastSpec) return;
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}${playerBase}?spec=${b64url(lastSpec)}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    meta.innerHTML += '<br/><i>link copied</i>';
  });

  root.querySelector('#export')!.addEventListener('click', async () => {
    if (!lastSpec) return;
    try {
      // fetch the built single-file player and inject the spec
      const res = await fetch(`${playerBase}?export-template`);
      let html = await res.text();
      html = html.replace('<head>', `<head><script>window.__XANDRIA_SPEC__=${lastSpec};</script>`);
      const name = 'xandria-game.html';
      if (window.xandria?.saveFile) {
        await window.xandria.saveFile(name, html);
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        a.download = name;
        a.click();
      }
      meta.innerHTML += '<br/><i>exported xandria-game.html — double-click to play offline</i>';
    } catch (e) {
      meta.innerHTML += `<br/><i>export failed: ${e}</i>`;
    }
  });
}

mountStudio(document.getElementById('studio')!);
