/**
 * Xandria Studio UI — prompt → GameSpec → live preview (iframe running player.html) → export.
 * Works in browser (vite dev / built) and inside the Electron shell (file export via IPC).
 */
import { generateSpec } from '../generator/generate';
import { generateWithLLM } from '../generator/llm';
import { GENRE_LABELS } from '../blueprints/index';
import { validateSpec, normalizeSpec, type Genre, type GameSpec, type QualityMode } from '@spec';
import './inspector/inspectorPanel';
import { applyPatch, type Scalar } from './inspector/specInspector';
import type { XandriaSpecInspector } from './inspector/inspectorPanel';
import { createEditorPanel, readProjectFile, escapeHtml, type EditorPanel } from './editor/editorPanel';
import { projectToJson } from './editor/specOps';
import { injectSpecScript } from '../../scripts/specInject';
import { isBillingEnabled } from './auth';
import {
  apiGate,
  createBillingState,
  decideGateAction,
  exportGate,
  gateGeneration,
  handleCheckoutReturn,
  mountAccountChip,
  mountPricing,
  recordGeneration,
  steamGate,
  studioSplashEnabled,
  type BillingState,
  type Notify,
} from './billing';

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
  button:disabled { opacity:.45; cursor:not-allowed; }
  button:disabled:hover { border-color:#2a3550; }
  .presets { display:flex; flex-wrap:wrap; gap:6px; }
  .presets button { font-size:11px; padding:6px 9px; font-weight:400; opacity:.85; }
  #frame-wrap { flex:1; position:relative; background:#000; }
  #game { width:100%; height:100%; border:0; display:block; }
  #empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:10px;
           color:#3a4a65; letter-spacing:.2em; font-size:13px; }
  #meta { font-size:11px; color:#5a6a85; line-height:1.5; white-space:pre-wrap; max-height:150px; overflow:auto; }
  .badge { display:inline-block; padding:2px 8px; border-radius:6px; background:#1a2438; font-size:10.5px; margin:2px 2px 0 0; color:#8fa5c8; }
  /* ---- Mobile: convert #side into a collapsible bottom drawer ---- */
  #drawer-grabber { display:none; height:52px; flex:0 0 auto; margin:-18px -18px 0; cursor:pointer;
                    align-items:center; justify-content:center; touch-action:manipulation; }
  #drawer-grabber span { display:block; width:56px; height:6px; border-radius:3px; background:#3a4a65; }
  #drawer-fab { display:none; position:fixed; bottom:20px; right:20px; z-index:30; width:56px; height:56px;
                border-radius:50%; padding:0; font-size:24px; align-items:center; justify-content:center;
                background:linear-gradient(180deg,#1f6d8a,#144256); border:1px solid #3fd8ff;
                box-shadow:0 4px 16px rgba(0,0,0,.5); }
  @media (max-width: 720px) {
    #side { position:fixed; left:0; right:0; bottom:0; top:auto; width:auto; min-width:0; max-height:72vh;
            border-right:none; border-top:1px solid #1e2638; border-radius:16px 16px 0 0;
            transform:translateY(calc(100% - 52px)); transition:transform .25s ease; z-index:20; }
    #side.open { transform:translateY(0); }
    #drawer-grabber { display:flex; }
    #drawer-fab { display:flex; }
  }
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
  // Billing is purely additive: when the supabase env vars are absent the
  // account chip, pricing tab and gates are omitted and the studio behaves
  // exactly as the launch build did.
  const billingOn = isBillingEnabled();

  root.innerHTML = `
    <div id="layout">
      <div id="side">
        <div id="drawer-grabber" role="button" aria-label="toggle panel" title="drag panel"><span></span></div>
        <h1>XANDRIA STUDIO<small>INTENT → PLAYABLE GAME</small></h1>
        ${billingOn ? '<div id="acct-host"></div>' : ''}
        <div class="row" id="viewtabs" style="gap:6px">
          <button id="tab-generate" class="primary" style="flex:1">✨ GENERATE</button>
          <button id="tab-editor" style="flex:1">🛠 EDITOR</button>
          ${billingOn ? '<button id="tab-pricing" style="flex:1">💎 PRICING</button>' : ''}
        </div>
        <div id="view-generate" style="display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow-y:auto">
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
        ${billingOn ? `<div id="export-extra" style="display:flex;flex-direction:column;gap:8px">
          <div class="row">
            <button id="steam-export" style="flex:1" title="Steam-ready export (Pro tier)">📦 STEAM <span class="badge">PRO</span></button>
            <button id="api-access" style="flex:1" title="Programmatic generation API (Pro tier)">🔌 API <span class="badge">PRO</span></button>
          </div>
          <div id="splash-row" style="font-size:11px;color:#5a6a85"></div>
        </div>` : ''}
        <div id="meta"></div>
        </div><!-- /view-generate -->
        <div id="view-editor" style="display:none;flex:1;min-height:0;overflow:hidden"></div>
        ${billingOn ? '<div id="view-pricing" style="display:none;flex:1;min-height:0;overflow-y:auto"></div>' : ''}
      </div>
      <div id="frame-wrap"><div id="empty">✦<br/>GENERATE A GAME TO PLAY IT HERE</div><iframe id="game" style="display:none"></iframe></div>
      <button id="drawer-fab" aria-label="toggle panel" title="panel">✨</button>
    </div>`;

  const prompt = root.querySelector<HTMLTextAreaElement>('#prompt')!;
  const genreSel = root.querySelector<HTMLSelectElement>('#genre')!;
  const diffSel = root.querySelector<HTMLSelectElement>('#diff')!;
  const meta = root.querySelector<HTMLElement>('#meta')!;
  const frame = root.querySelector<HTMLIFrameElement>('#game')!;
  const empty = root.querySelector<HTMLElement>('#empty')!;

  // ---- Mobile drawer: #side collapses to a 52px grabber bar at ≤720px.
  // ---- No-op on desktop (the media query never activates; class is harmless).
  const side = root.querySelector<HTMLElement>('#side')!;
  const toggleDrawer = (force?: boolean) => side.classList.toggle('open', force ?? !side.classList.contains('open'));
  const collapseDrawer = () => side.classList.remove('open');
  root.querySelector<HTMLElement>('#drawer-grabber')!.addEventListener('click', () => toggleDrawer());
  root.querySelector<HTMLButtonElement>('#drawer-fab')!.addEventListener('click', () => toggleDrawer());
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

  // ---- Billing (subscription checkout). Additive and hook-based: when the
  // ---- supabase env vars are unset, `billing.enabled` is false and every
  // ---- gate below passes through, leaving launch behavior untouched.
  const notifyMeta: Notify = (html) => { meta.innerHTML += `<br/>${html}`; };
  let renderAcct: () => void = () => {};
  const billing: BillingState = createBillingState(() => { renderAcct(); renderExportRow(); });
  const acctHost = root.querySelector<HTMLElement>('#acct-host');
  if (billing.enabled && acctHost) {
    renderAcct = mountAccountChip(acctHost, billing, notifyMeta);
  }
  const renderExportRow = () => {
    const row = root.querySelector<HTMLElement>('#splash-row');
    if (!row || !billing.enabled) return;
    const tier = billing.me?.tier ?? null;
    if (!billing.email) {
      row.innerHTML = '<i>sign in to manage the splash credit</i>';
    } else if (tier === 'free' || tier === null) {
      row.innerHTML = '✦ splash credit: <b style="color:#8fa5c8">always on</b> <span style="opacity:.7">(free tier)</span>';
    } else {
      row.innerHTML = `<label style="cursor:pointer;display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="splash-toggle"${billing.splashOn ? ' checked' : ''} style="width:auto"/>
        ✦ show &ldquo;Made with XANDRIA&rdquo; splash on my games</label>`;
      const cb = row.querySelector<HTMLInputElement>('#splash-toggle')!;
      cb.addEventListener('change', () => { billing.splashOn = cb.checked; });
    }
  };
  renderExportRow();
  if (billing.enabled) void handleCheckoutReturn(billing, notifyMeta);

  /** ?splash= flag for preview iframe URLs, from the viewer's tier. */
  const splashQuery = () => (billing.enabled ? `&splash=${studioSplashEnabled(billing) ? 1 : 0}` : '');

  // Spec inspector (v1 edit loop): mounted next to the preview; patches are
  // applied via specInspector and the preview iframe reloads with the new spec.
  const frameWrap = root.querySelector<HTMLElement>('#frame-wrap')!;
  const inspector = document.createElement('xandria-spec-inspector') as XandriaSpecInspector;
  frameWrap.appendChild(inspector);

  const reloadPreview = () => {
    if (!lastSpec) return;
    frame.src = `${playerBase}?spec=${b64url(lastSpec)}${splashQuery()}`;
    frame.style.display = 'block';
    empty.style.display = 'none';
    collapseDrawer(); // mobile: give the canvas the full viewport
  };

  inspector.addEventListener('xandria-spec-patch', (e) => {
    if (!lastSpec) return;
    const detail = (e as CustomEvent<Record<string, Scalar>>).detail;
    const current = JSON.parse(lastSpec) as Record<string, unknown>;
    const { spec: next, changed } = applyPatch(current, detail, inspector.lockedKeys);
    if (changed.length > 0) {
      lastSpec = JSON.stringify(next);
      inspector.spec = next;
      reloadPreview();
    }
  });

  // ---- Editor panel (basic-user editing): tabs for story/world/player/
  // ---- enemies/pickups/assets. Shares the preview iframe via ?spec= URLs.
  const editorHost = {
    getSpec: (): GameSpec | null => (lastSpec ? JSON.parse(lastSpec) as GameSpec : null),
    play: (spec: GameSpec) => {
      const v = validateSpec(spec);
      if (!v.ok) { meta.textContent = 'SPEC INVALID:\n' + v.errors.join('\n'); return; }
      lastSpec = JSON.stringify(spec);
      inspector.spec = JSON.parse(lastSpec) as Record<string, unknown>;
      frame.src = `${playerBase}?spec=${b64url(lastSpec)}&autostart=1${splashQuery()}`;
      frame.style.display = 'block';
      empty.style.display = 'none';
      collapseDrawer(); // mobile: give the canvas the full viewport
    },
    regenerate: (): GameSpec | null => {
      if (!lastSpec) return null;
      const spec = JSON.parse(lastSpec) as GameSpec;
      spec.meta.seed = (Math.random() * 0x7fffffff) | 0;
      if (!validateSpec(spec).ok) return null;
      lastSpec = JSON.stringify(spec);
      inspector.spec = JSON.parse(lastSpec) as Record<string, unknown>;
      return spec;
    },
    saveProject: (spec: GameSpec) => {
      const json = projectToJson(spec);
      const name = `${(spec.meta.name || 'xandria-game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'xandria-game'}.xandria.json`;
      if (window.xandria?.saveFile) {
        window.xandria.saveFile(name, json).catch(() => {});
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
      meta.innerHTML += `<br/><i>saved ${name}</i>`;
    },
    loadProject: (file: File) => readProjectFile(file),
  };
  const editor: EditorPanel = createEditorPanel(editorHost);
  root.querySelector('#view-editor')!.appendChild(editor.root);

  const tabGen = root.querySelector<HTMLButtonElement>('#tab-generate')!;
  const tabEd = root.querySelector<HTMLButtonElement>('#tab-editor')!;
  const tabPricing = root.querySelector<HTMLButtonElement>('#tab-pricing');
  const viewGen = root.querySelector<HTMLElement>('#view-generate')!;
  const viewEd = root.querySelector<HTMLElement>('#view-editor')!;
  const viewPricing = root.querySelector<HTMLElement>('#view-pricing');
  const showTab = (which: 'generate' | 'editor' | 'pricing') => {
    viewGen.style.display = which === 'generate' ? 'flex' : 'none';
    viewEd.style.display = which === 'editor' ? 'flex' : 'none';
    if (viewPricing) viewPricing.style.display = which === 'pricing' ? 'flex' : 'none';
    tabGen.classList.toggle('primary', which === 'generate');
    tabEd.classList.toggle('primary', which === 'editor');
    if (tabPricing) tabPricing.classList.toggle('primary', which === 'pricing');
    if (which === 'editor') editor.setSpec(editorHost.getSpec());
    if (which === 'pricing' && viewPricing) mountPricing(viewPricing, billing, notifyMeta);
  };
  tabGen.addEventListener('click', () => showTab('generate'));
  tabEd.addEventListener('click', () => showTab('editor'));
  if (tabPricing) tabPricing.addEventListener('click', () => showTab('pricing'));

  const applyOnline = (spec: GameSpec): GameSpec => {
    const next = JSON.parse(JSON.stringify(spec)) as GameSpec;
    next.custom = next.custom ?? {};
    next.custom.quality = qualitySel.value as QualityMode;
    const packs: Record<string, string> = {};
    for (const line of assetPacks.value.split('\n')) {
      const m = line.match(/^\s*([\w-]+)\s*=\s*(https?:\/\/\S+\.(?:glb|gltf))\s*$/i);
      if (m) packs[m[1]] = m[2];
    }
    if (Object.keys(packs).length) {
      // Merge: preserve any reskin overrides already in custom.assets instead
      // of clobbering them (the engine skips reskins while packs are enabled,
      // but the data survives for when packs are removed).
      const prev = next.custom.assets as unknown as Record<string, unknown> | undefined;
      const overrides = prev && typeof prev.enabled !== 'boolean' ? prev : {};
      next.custom.assets = { ...overrides, enabled: true, packs } as unknown as NonNullable<GameSpec['custom']>['assets'];
    }
    const v = validateSpec(next);
    return v.ok ? normalizeSpec(next) : spec;
  };

  const generate = async () => {
    // ---- Billing gate: sign-in required, quota enforced server-side.
    // ---- Fail-closed (M-1): every gate failure blocks generation — a
    // ---- backend outage must not become a quota bypass.
    if (billing.enabled) {
      const gate = await gateGeneration(billing);
      const action = decideGateAction(gate, billing.me?.tier ?? null);
      if (!action.proceed) {
        notifyMeta(`<i>${action.nudge}</i>`);
        if (action.focusSignin) root.querySelector<HTMLInputElement>('#acct-email')?.focus();
        if (action.showPricing) showTab('pricing');
        return;
      }
    }
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
    inspector.spec = JSON.parse(lastSpec) as Record<string, unknown>;
    editor.setSpec(spec);
    const url = `${playerBase}?spec=${b64url(lastSpec)}${splashQuery()}`;
    frame.src = url;
    frame.style.display = 'block';
    empty.style.display = 'none';
    collapseDrawer(); // mobile: give the canvas the full viewport
    meta.innerHTML =
      `<span class="badge">${GENRE_LABELS[spec.meta.genre]}</span><span class="badge">${spec.theme.environment}</span>` +
      `<span class="badge">${spec.theme.timeOfDay}</span><span class="badge">${spec.rules.difficulty}</span>` +
      `<span class="badge">seed ${spec.meta.seed}</span>${llmNote}<span class="badge">${spec.custom?.quality ?? 'retro'}</span><br/><br/><b style="color:#8fa5c8">${escapeHtml(spec.meta.name)}</b> — ${escapeHtml(spec.objective.description)}`;
    // Record the COMPLETED generation against the monthly quota. This line is
    // only reached on success — failed builds don't count.
    if (billing.enabled) {
      void recordGeneration().then(() => billing.refresh());
    }
  };

  root.querySelector('#generate')!.addEventListener('click', generate);
  prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });

  root.querySelector('#copy')!.addEventListener('click', async () => {
    if (!lastSpec) return;
    const url = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}${playerBase}?spec=${b64url(lastSpec)}${splashQuery()}`;
    await navigator.clipboard.writeText(url).catch(() => {});
    meta.innerHTML += '<br/><i>link copied</i>';
  });

  // Exporting from `vite dev` serves the dev module graph, not the singlefile
  // bundle — the result is a broken file. Disable in dev with an explanation.
  const exportBtn = root.querySelector<HTMLButtonElement>('#export')!;
  const steamBtn = root.querySelector<HTMLButtonElement>('#steam-export');
  if (import.meta.env.DEV) {
    exportBtn.disabled = true;
    exportBtn.title = 'Export needs a production build: run npm run build, then export from dist/index.html';
    if (steamBtn) {
      steamBtn.disabled = true;
      steamBtn.title = exportBtn.title;
    }
  }

  // Shared export flow. itch.io HTML export needs hobby+; Steam-ready export
  // needs pro. The splash flag is baked per the exporter's tier (free →
  // forced on; paid → the studio splash toggle, default off).
  const doExport = async (kind: 'itch' | 'steam') => {
    if (!lastSpec) { meta.innerHTML += '<br/><i>generate a game first</i>'; return; }
    if (billing.enabled) {
      const g = kind === 'itch' ? exportGate(billing) : steamGate(billing);
      if (!g.ok) { meta.innerHTML += `<br/><i>${g.nudge}</i>`; return; }
    }
    try {
      // fetch the built single-file player and inject the spec
      const res = await fetch(`${playerBase}?export-template`);
      let html = await res.text();
      // Escape </script inside the spec so it can't break out of the injection block
      const specSafe = lastSpec.replace(/<\/script/gi, '<\\/script');
      const splashFlag = studioSplashEnabled(billing);
      // Throws (loudly) if the bundle has no <head> tag — never silently
      // ship the default spec instead of the user's game.
      html = injectSpecScript(html, `<script>window.__XANDRIA_SPEC__=${specSafe};window.__XANDRIA_SPLASH__=${splashFlag};</script>`);
      const name = kind === 'steam' ? 'xandria-game-steam.html' : 'xandria-game.html';
      if (window.xandria?.saveFile) {
        await window.xandria.saveFile(name, html);
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        a.download = name;
        a.click();
      }
      meta.innerHTML += kind === 'steam'
        ? `<br/><i>exported ${name} — Steam-ready single-file build; drop it into your Steam depot wrapper</i>`
        : `<br/><i>exported ${name} — double-click to play offline</i>`;
    } catch (e) {
      meta.innerHTML += `<br/><i>export failed: ${escapeHtml(e instanceof Error ? e.message : String(e))}</i>`;
    }
  };

  root.querySelector('#export')!.addEventListener('click', () => void doExport('itch'));
  if (steamBtn) steamBtn.addEventListener('click', () => void doExport('steam'));
  const apiBtn = root.querySelector<HTMLButtonElement>('#api-access');
  if (apiBtn) apiBtn.addEventListener('click', () => {
    const g = apiGate(billing);
    if (!g.ok) { meta.innerHTML += `<br/><i>${g.nudge}</i>`; return; }
    meta.innerHTML += '<br/><i>API access ships with the backend — your key will appear here when it does.</i>';
  });
}

mountStudio(document.getElementById('studio')!);
