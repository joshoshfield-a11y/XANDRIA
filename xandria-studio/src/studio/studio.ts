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
import { linkedLabelHtml } from './tierGate';
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
  :root { color-scheme: dark;
    --bg0:#090b0f; --bg1:#10141b; --bg2:#161c25;
    --line:#232c38; --line2:#2e3947;
    --txt:#e9eef5; --mut:#98a2b3; --dim:#5f6b7d;
    --lime:#c9f24b; --lime-hi:#dcff70; --lime-dim:rgba(201,242,75,.10); --lime-line:rgba(201,242,75,.28);
    --green:#3ddc84; --danger:#ff8b95;
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;
         background:var(--bg0); color:var(--txt); height:100vh; overflow:hidden; -webkit-font-smoothing:antialiased; }
  #layout { display:flex; height:100vh; }
  /* ---- Icon rail ---- */
  #sidenav { width:88px; flex:0 0 88px; display:flex; flex-direction:column; align-items:center; gap:4px;
             padding:16px 0 12px; background:var(--bg1); border-right:1px solid var(--line); z-index:25; }
  .nav-logo { width:38px; height:38px; border-radius:11px; background:var(--lime); color:#141806;
              font-weight:900; font-size:20px; display:flex; align-items:center; justify-content:center; margin-bottom:14px; }
  .nav-item { width:68px; padding:10px 4px; display:flex; flex-direction:column; align-items:center; gap:5px;
              background:transparent; border:1px solid transparent; border-radius:12px; color:var(--mut);
              font-size:10px; font-weight:600; letter-spacing:.06em; cursor:pointer; font-family:inherit; }
  .nav-item .ico { font-size:17px; line-height:1; }
  .nav-item:hover { color:var(--txt); background:rgba(255,255,255,.03); }
  #sidenav .nav-item.primary { color:var(--lime); background:var(--lime-dim); border-color:transparent; }
  .nav-foot { margin-top:auto; font-size:8.5px; letter-spacing:.14em; color:var(--dim); text-align:center; line-height:1.7; font-weight:600; }
  /* ---- Main column ---- */
  #side { width:452px; flex:0 0 452px; min-width:0; padding:20px 20px 24px; display:flex; flex-direction:column;
          gap:14px; background:var(--bg0); overflow-y:auto; }
  #topbar { display:flex; align-items:center; justify-content:space-between; }
  .brand { display:flex; align-items:center; gap:10px; }
  .wordmark { font-weight:800; font-size:15px; letter-spacing:.22em; }
  .playable { display:inline-flex; align-items:center; gap:7px; font-size:10px; font-weight:700; letter-spacing:.14em;
              color:var(--mut); border:1px solid var(--line); border-radius:999px; padding:5px 11px; background:var(--bg1); }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--green);
         box-shadow:0 0 8px rgba(61,220,132,.8); display:inline-block; }
  .top-right { display:flex; align-items:center; gap:10px; }
  .credits { display:inline-flex; align-items:center; gap:6px; background:var(--lime-dim); color:var(--lime);
             border:1px solid var(--lime-line); border-radius:10px; padding:7px 12px; font-weight:700; font-size:13px; }
  .avatar { width:34px; height:34px; border-radius:50%; background:#2a3342; border:1px solid var(--line2);
            color:#cfd6e0; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:14px; }
  .card { background:var(--bg1); border:1px solid var(--line); border-radius:16px; padding:22px;
          display:flex; flex-direction:column; gap:16px; }
  .card-head { display:flex; gap:14px; align-items:flex-start; }
  .spark { color:var(--lime); font-size:24px; line-height:1.2; }
  .card-head h2 { margin:0 0 6px; font-size:19px; font-weight:700; letter-spacing:-.01em; }
  .card-head p { margin:0; color:var(--mut); font-size:13.5px; line-height:1.55; }
  .sect { display:flex; flex-direction:column; gap:8px; }
  .lbl { font-size:10.5px; letter-spacing:.16em; color:var(--dim); font-weight:700; text-transform:uppercase; }
  .linked { font-size:12px; color:var(--green); display:flex; align-items:center; gap:6px; }
  #acct-host #acct { background:var(--bg2); border-color:var(--line); }
  #acct-host #acct .email { color:var(--mut); }
  #acct-host #acct .left { color:var(--dim); }
  #acct-host #acct input { background:var(--bg0); border-color:var(--line); color:var(--txt); }
  textarea { width:100%; min-height:96px; background:var(--bg2); color:var(--txt); border:1px solid var(--line);
             border-radius:10px; padding:11px 13px; font-size:14px; resize:vertical; outline:none;
             font-family:inherit; line-height:1.5; }
  textarea:focus { border-color:var(--lime-line); box-shadow:0 0 0 3px rgba(201,242,75,.08); }
  select, .row input, #online input { width:100%; background:var(--bg2); color:var(--txt); border:1px solid var(--line);
             border-radius:10px; padding:10px 12px; font-size:13.5px; outline:none; font-family:inherit; }
  select:focus, input:focus { border-color:var(--lime-line); }
  .row { display:flex; gap:10px; }
  #history, #presets { display:flex; flex-direction:column; gap:8px; }
  .prompt-row { display:flex; align-items:center; gap:6px; background:var(--bg2); border:1px solid var(--line);
                border-radius:10px; padding:4px 4px 4px 12px; }
  .prompt-row .fill { flex:1; min-width:0; background:none; border:none; color:var(--txt); text-align:left;
                      font-size:13px; padding:8px 4px; font-weight:400; letter-spacing:0; cursor:pointer;
                      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:inherit; }
  .prompt-row .fill:hover { color:var(--lime); }
  .prompt-row .rm { background:none; border:none; color:var(--dim); font-size:16px; padding:6px 10px;
                    border-radius:8px; cursor:pointer; }
  .prompt-row .rm:hover { color:var(--danger); background:rgba(255,139,149,.08); }
  button { cursor:pointer; border:1px solid var(--line); border-radius:10px; padding:11px 14px; font-size:13.5px;
           font-weight:600; background:var(--bg2); color:var(--txt); font-family:inherit;
           transition:border-color .15s, background .15s; }
  button:hover { border-color:var(--line2); background:#1a212c; }
  button.primary { background:var(--lime); border-color:transparent; color:#161a08; }
  button.primary:hover { background:var(--lime-hi); }
  #generate { font-size:15px; font-weight:800; letter-spacing:.08em; padding:15px; border-radius:12px;
              display:flex; align-items:center; justify-content:center; gap:10px; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button:disabled:hover { border-color:var(--line); background:var(--bg2); }
  details#online { border:1px solid var(--line); border-radius:10px; background:var(--bg2); padding:0 14px; }
  details#online summary { cursor:pointer; font-size:13px; font-weight:600; color:var(--mut); padding:12px 0;
                           list-style:none; display:flex; align-items:center; gap:9px; }
  details#online summary::-webkit-details-marker { display:none; }
  details#online summary::before { content:'⚙'; font-size:14px; color:var(--dim); }
  details#online summary::after { content:'›'; margin-left:auto; color:var(--dim); font-size:16px; transition:transform .15s; }
  details#online[open] summary::after { transform:rotate(90deg); }
  #online .opt-body { display:flex; flex-direction:column; gap:10px; padding:2px 0 14px; }
  .badge { display:inline-block; padding:2px 7px; border-radius:6px; background:var(--lime-dim); color:var(--lime);
           font-size:10px; font-weight:700; letter-spacing:.08em; margin-left:6px; border:1px solid var(--lime-line); }
  #meta { font-size:11.5px; color:var(--dim); line-height:1.6; white-space:pre-wrap; max-height:160px; overflow:auto; }
  #meta .badge { margin:2px 4px 0 0; }
  #meta b { color:var(--mut); }
  .signin-note { font-size:12px; color:var(--dim); text-align:center; }
  .note { font-size:12px; color:var(--mut); }
  /* ---- Preview ---- */
  #frame-wrap { flex:1; min-width:0; position:relative; background:#04060a; }
  #game { width:100%; height:100%; border:0; display:block; }
  #empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column;
           gap:16px; text-align:center; padding:24px;
           background:radial-gradient(640px 420px at 50% 34%, rgba(201,242,75,.055), transparent 70%); }
  .ready-pill { display:inline-flex; align-items:center; gap:9px; font-size:11px; font-weight:700; letter-spacing:.22em;
                color:var(--lime); border:1px solid var(--lime-line); border-radius:999px;
                padding:9px 18px 9px 14px; background:rgba(201,242,75,.06); }
  #empty p { margin:0; color:var(--mut); font-size:14px; line-height:1.65; max-width:300px; }
  /* ---- Mobile: #side becomes a bottom drawer, #sidenav a top bar ---- */
  #drawer-grabber { display:none; height:52px; flex:0 0 auto; margin:-20px -20px 0; cursor:pointer;
                    align-items:center; justify-content:center; touch-action:manipulation; }
  #drawer-grabber span { display:block; width:56px; height:6px; border-radius:3px; background:#3a4a65; }
  #drawer-fab { display:none; position:fixed; bottom:20px; right:20px; z-index:30; width:56px; height:56px;
                border-radius:50%; padding:0; font-size:22px; align-items:center; justify-content:center;
                background:var(--lime); color:#161a08; border:none;
                box-shadow:0 4px 16px rgba(0,0,0,.5); }
  @media (max-width: 900px) {
    #side { width:400px; flex-basis:400px; }
    #sidenav { width:72px; flex-basis:72px; }
    .nav-item { width:58px; }
  }
  @media (max-width: 720px) {
    #layout { flex-direction:column; }
    #sidenav { width:100%; flex:0 0 58px; flex-direction:row; border-right:none; border-bottom:1px solid var(--line);
               padding:0 10px; align-items:center; gap:2px; }
    .nav-logo { margin:0 8px 0 2px; width:32px; height:32px; font-size:17px; border-radius:9px; }
    .nav-item { width:auto; flex-direction:row; padding:8px 12px; gap:7px; font-size:11px; }
    .nav-item .ico { font-size:15px; }
    .nav-foot { display:none; }
    #side { position:fixed; left:0; right:0; bottom:0; top:auto; width:auto; flex:none; max-height:74vh;
            border-top:1px solid var(--line); border-radius:16px 16px 0 0; background:var(--bg1);
            transform:translateY(calc(100% - 52px)); transition:transform .25s ease; z-index:20; }
    #side.open { transform:translateY(0); }
    #drawer-grabber { display:flex; }
    #drawer-fab { display:flex; }
    #frame-wrap { min-height:0; }
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
      <nav id="sidenav">
        <div class="nav-logo">X</div>
        <button id="tab-generate" class="nav-item primary"><span class="ico">✦</span><span>Generate</span></button>
        <button id="tab-editor" class="nav-item"><span class="ico">&lt;/&gt;</span><span>Editor</span></button>
        ${billingOn ? '<button id="tab-pricing" class="nav-item"><span class="ico">◆</span><span>Pricing</span></button>' : ''}
        <div class="nav-foot">XANDRIA<br/>STUDIO<br/>v1.5.0</div>
      </nav>
      <div id="side">
        <div id="drawer-grabber" role="button" aria-label="toggle panel" title="drag panel"><span></span></div>
        <div id="topbar">
          <div class="brand"><span class="wordmark">XANDRIA</span><span class="playable"><i class="dot"></i>PLAYABLE ▾</span></div>
          <div class="top-right">
            ${billingOn ? '<span id="credits-pill" class="credits" style="display:none">⚡ …</span>' : ''}
            <span class="avatar">X</span>
          </div>
        </div>
        <div id="view-generate" class="card" style="display:flex">
          <div class="card-head"><span class="spark">✦</span><div>
            <h2>Create Your Experience</h2>
            <p>Describe what you want to build. XANDRIA will generate a playable game based on your prompt.</p>
          </div></div>
          ${billingOn ? `<div class="sect"><div class="lbl">Account</div><div id="acct-host"></div><div class="linked" id="linked-label" style="display:none"></div></div>` : ''}
          <div class="sect">
            <div class="lbl">Prompt</div>
            <div id="history" style="display:none"></div>
            <textarea id="prompt" placeholder="a dark knight questing through volcanic ruins, brutal difficulty…"></textarea>
            <div id="presets"></div>
          </div>
          <div class="row">
            <div style="flex:1;min-width:0"><div class="lbl">Genre</div><select id="genre"><option value="">Auto</option></select></div>
            <div style="flex:1;min-width:0"><div class="lbl">Difficulty</div><select id="diff"><option value="">Auto</option><option>easy</option><option>normal</option><option>hard</option></select></div>
          </div>
          <div><div class="lbl">Graphics Quality</div><select id="quality"><option value="retro">retro (PS2)</option><option value="standard">standard</option><option value="high">high</option></select></div>
          <details id="online"><summary>Advanced Options</summary>
            <div class="opt-body">
              <div><div class="lbl">LLM Mode</div><select id="llm-mode"><option value="">off (deterministic)</option><option value="flavor">flavor (names/colors)</option><option value="architect">architect (full spec)</option></select></div>
              <div><div class="lbl">LLM Endpoint</div><input id="llm-endpoint" placeholder="http://localhost:11434/v1"/></div>
              <div class="row">
                <div style="flex:1;min-width:0"><div class="lbl">API Key</div><input id="llm-key" type="password" placeholder="optional"/></div>
                <div style="flex:1;min-width:0"><div class="lbl">Model</div><input id="llm-model" placeholder="llama3.1"/></div>
              </div>
              <div><div class="lbl">Asset Packs (.glb/.gltf URLs, one per line)</div><textarea id="asset-packs" style="min-height:56px" placeholder="trees=https://example.com/trees.glb"></textarea></div>
            </div>
          </details>
          <button class="primary" id="generate">⚡ GENERATE &amp; PLAY →</button>
          <div class="row"><button id="export" style="flex:1">⬇ Export .HTML</button><button id="copy" style="flex:1">🔗 Share Link</button></div>
          ${billingOn ? `<div id="export-extra" style="display:flex;flex-direction:column;gap:10px">
            <div class="row">
              <button id="steam-export" style="flex:1" title="Steam-ready export (Pro tier)">Steam <span class="badge">PRO</span></button>
              <button id="api-access" style="flex:1" title="Programmatic generation API (Pro tier)">API <span class="badge">PRO</span></button>
            </div>
            <div id="splash-row" class="note"></div>
          </div>` : ''}
          <div id="meta"></div>
          ${billingOn ? '<div class="signin-note">Sign in to manage your credit and projects.</div>' : ''}
        </div><!-- /view-generate -->
        <div id="view-editor" style="display:none;flex:1;min-height:0;overflow:hidden"></div>
        ${billingOn ? '<div id="view-pricing" style="display:none;flex:1;min-height:0;overflow-y:auto"></div>' : ''}
      </div>
      <div id="frame-wrap"><div id="empty"><span class="ready-pill"><i class="dot"></i>READY</span><p>Generate a game, scene or interactive experience.</p></div><iframe id="game" style="display:none"></iframe></div>
      <button id="drawer-fab" aria-label="toggle panel" title="panel">✦</button>
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

  // ---- Prompt history (recent successful generations) + dismissible preset
  // ---- rows, one row per prompt: click refills the box, × removes it.
  const loadStrArr = (k: string): string[] => {
    try {
      const v = JSON.parse(localStorage.getItem(k) ?? 'null');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  };
  const saveStrArr = (k: string, v: string[]) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
  };
  const HIST_KEY = 'xandria.studio.history';
  const DISM_KEY = 'xandria.studio.dismissedPresets';
  let history: string[] = loadStrArr(HIST_KEY);
  const dismissed: string[] = loadStrArr(DISM_KEY);
  const historyBox = root.querySelector<HTMLElement>('#history')!;
  const presets = root.querySelector<HTMLElement>('#presets')!;
  const promptRow = (text: string, title: string, onFill: () => void, onRemove: (row: HTMLElement) => void): HTMLElement => {
    const row = el('<div class="prompt-row"><button class="fill"></button><button class="rm" title="remove">×</button></div>');
    const fill = row.querySelector('.fill') as HTMLButtonElement;
    fill.textContent = text;
    fill.title = title;
    fill.addEventListener('click', onFill);
    (row.querySelector('.rm') as HTMLButtonElement).addEventListener('click', () => onRemove(row));
    return row;
  };
  const renderHistory = () => {
    historyBox.innerHTML = '';
    history.forEach((h, i) => historyBox.appendChild(promptRow(h, h,
      () => { prompt.value = h; },
      () => { history.splice(i, 1); saveStrArr(HIST_KEY, history); renderHistory(); })));
    historyBox.style.display = history.length ? 'flex' : 'none';
  };
  renderHistory();
  for (const p of PRESETS) {
    if (dismissed.includes(p)) continue;
    presets.appendChild(promptRow(p.split(',')[0], p,
      () => { prompt.value = p; },
      (row) => { dismissed.push(p); saveStrArr(DISM_KEY, dismissed); row.remove(); }));
  }

  let lastSpec = '';
  const playerBase = opts.playerUrl ?? 'player.html';

  // ---- Billing (subscription checkout). Additive and hook-based: when the
  // ---- supabase env vars are unset, `billing.enabled` is false and every
  // ---- gate below passes through, leaving launch behavior untouched.
  const notifyMeta: Notify = (html) => {
    meta.innerHTML += `<br/>${html}`;
    // Gate blocks must be unmissable: on the mobile bottom-drawer layout the
    // feedback area sits below the fold, which previously read as "nothing happens".
    meta.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const creditsPill = root.querySelector<HTMLElement>('#credits-pill');
  const billing: BillingState = createBillingState(() => { renderAcct(); renderExportRow(); });
  const updateCredits = () => {
    if (!creditsPill || !billing.enabled) return;
    if (!billing.email) { creditsPill.style.display = 'none'; return; }
    creditsPill.style.display = 'inline-flex';
    creditsPill.textContent = `⚡ ${!billing.me ? '…' : billing.me.unlimited ? '∞' : billing.me.generations_remaining}`;
  };
  let renderAcct: () => void = () => { updateCredits(); };
  const acctHost = root.querySelector<HTMLElement>('#acct-host');
  if (billing.enabled && acctHost) {
    const chipRender = mountAccountChip(acctHost, billing, notifyMeta);
    const linkedLabel = root.querySelector<HTMLElement>('#linked-label');
    renderAcct = () => {
      chipRender();
      updateCredits();
      // Keep the link indicator truthful: only claim a linked account when
      // a session actually exists.
      if (linkedLabel) {
        const html = linkedLabelHtml(billing.email);
        linkedLabel.innerHTML = html;
        linkedLabel.style.display = html ? 'flex' : 'none';
      }
    };
  }
  renderAcct();
  const renderExportRow = () => {
    const row = root.querySelector<HTMLElement>('#splash-row');
    if (!row || !billing.enabled) return;
    const tier = billing.me?.tier ?? null;
    if (!billing.email) {
      row.innerHTML = '<i>sign in to manage the splash credit</i>';
    } else if (tier === 'free' || tier === null) {
      row.innerHTML = '✦ splash credit: <b>always on</b> <span style="opacity:.7">(free tier)</span>';
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
      inspector.spec = JSON.parse(lastSpec) as Record<string, unknown>;
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
    // Remember successful prompts for the history list (cap 6, deduped).
    if (intent !== 'a heroic adventure in the forest') {
      history = [intent, ...history.filter((h) => h !== intent)].slice(0, 6);
      saveStrArr(HIST_KEY, history);
      renderHistory();
    }
    meta.innerHTML =
      `<span class="badge">${GENRE_LABELS[spec.meta.genre]}</span><span class="badge">${spec.theme.environment}</span>` +
      `<span class="badge">${spec.theme.timeOfDay}</span><span class="badge">${spec.rules.difficulty}</span>` +
      `<span class="badge">seed ${spec.meta.seed}</span>${llmNote}<span class="badge">${spec.custom?.quality ?? 'retro'}</span><br/><br/><b>${escapeHtml(spec.meta.name)}</b> — ${escapeHtml(spec.objective.description)}`;
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
