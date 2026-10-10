/**
 * XANDRIA Studio billing UI + API client.
 *
 * - Account chip: magic-link sign-in form ↔ signed-in chip (email, tier
 *   badge, generations remaining, sign-out).
 * - Pricing view: Free / Hobby / Pro cards → Stripe Checkout via /api/checkout.
 * - Splash toggle for paid tiers (free tier: splash forced on).
 *
 * All network calls carry the Supabase JWT as `Authorization: Bearer`.
 * Every failure degrades to a visible nudge — never a silent failure, never
 * a thrown exception into the studio UI.
 *
 * NOTE: `Tier` is imported from '../billing/entitlements', which the backend
 * builder owns. That module does not exist on this branch yet, so tsc fails
 * on that import until the branches merge (expected; final verification
 * happens post-merge). Pure gating logic lives in ./tierGate.ts and is
 * unit-tested without touching this module.
 */
import type { Tier } from '../billing/entitlements';
import {
  getAccessToken,
  getUser,
  isBillingEnabled,
  onAuthChange,
  signInWithOtp,
  signOut,
} from './auth';
import {
  SIGNIN_NUDGE,
  TIER_GENERATIONS_PER_MONTH,
  canExportItch,
  canExportSteam,
  canUseApi,
  effectiveSplash,
  tierBadge,
  truncateEmail,
  upgradeNudge,
  type Tier as GateTier,
} from './tierGate';

export interface MeResponse {
  tier: Tier;
  status: string;
  generations_used: number;
  generations_remaining: number;
  month: string;
}

export type Notify = (html: string) => void;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function api(path: string, token: string | null, init?: RequestInit): Promise<Response | null> {
  if (!token) return null;
  try {
    return await fetch(`/api${path}`, {
      ...init,
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
  } catch (e) {
    console.warn(`[xandria] /api${path} unreachable:`, e);
    return null;
  }
}

/** GET /api/me — the caller's tier and remaining generations. Null when
 *  signed out, unconfigured, or the backend is unreachable. */
export async function fetchMe(): Promise<MeResponse | null> {
  const token = await getAccessToken();
  const res = await api('/me', token);
  if (!res || !res.ok) {
    if (res) console.warn('[xandria] /api/me returned', res.status);
    return null;
  }
  try {
    return (await res.json()) as MeResponse;
  } catch {
    return null;
  }
}

/**
 * POST /api/generations — record one COMPLETED generation. Called only
 * after a successful generate() ("failed builds don't count").
 */
export async function recordGeneration(): Promise<MeResponse | null> {
  const token = await getAccessToken();
  const res = await api('/generations', token, { method: 'POST' });
  if (!res || !res.ok) {
    if (res) console.warn('[xandria] /api/generations returned', res.status);
    return null;
  }
  try {
    return (await res.json()) as MeResponse;
  } catch {
    return null;
  }
}

/** POST /api/checkout {tier} → Stripe Checkout URL, or null on failure. */
export async function createCheckoutUrl(tier: 'hobby' | 'pro'): Promise<string | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const res = await api('/checkout', token, {
    method: 'POST',
    body: JSON.stringify({ tier }),
  });
  if (!res || !res.ok) {
    if (res) console.warn('[xandria] /api/checkout returned', res.status);
    return null;
  }
  try {
    const body = (await res.json()) as { url?: string };
    return typeof body.url === 'string' && body.url.startsWith('https://') ? body.url : null;
  } catch {
    return null;
  }
}

export interface BillingState {
  enabled: boolean;
  email: string | null;
  me: MeResponse | null;
  /** Paid-tier splash toggle (default off). Free tier ignores it (forced on). */
  splashOn: boolean;
  refresh(): Promise<void>;
}

/**
 * Shared billing state for the studio session. `onChange` re-renders the
 * account chip / export row whenever session or quota changes.
 */
export function createBillingState(onChange: () => void): BillingState {
  const state: BillingState = {
    enabled: isBillingEnabled(),
    email: null,
    me: null,
    splashOn: false,
    refresh: async () => {
      if (!state.enabled) return;
      const user = await getUser();
      state.email = user?.email ?? null;
      state.me = state.email ? await fetchMe() : null;
      onChange();
    },
  };
  if (state.enabled) {
    onAuthChange(() => {
      void state.refresh();
    });
    void state.refresh();
  } else {
    console.info('[xandria] billing UI disabled: supabase env vars not set');
  }
  return state;
}

/** Generation gate result for generate(). */
export type GateResult = { ok: true } | { ok: false; reason: 'signin' | 'limit' | 'unavailable' };

/**
 * Should this generation be allowed to run? Pure w.r.t. the caller's quota:
 * no session → 'signin'; quota exhausted → 'limit'; backend unreachable →
 * 'unavailable'. The studio maps the result through decideGateAction, which
 * is fail-closed: every failure blocks generation.
 */
export async function gateGeneration(state: BillingState): Promise<GateResult> {
  if (!state.enabled) return { ok: true };
  if (!state.email) return { ok: false, reason: 'signin' };
  const me = await fetchMe();
  if (!me) return { ok: false, reason: 'unavailable' };
  state.me = me;
  if (me.generations_remaining <= 0) return { ok: false, reason: 'limit' };
  return { ok: true };
}

/** What the studio does with a gate result. */
export interface GateAction {
  proceed: boolean;
  /** HTML nudge shown when blocked; null when proceeding. */
  nudge: string | null;
  focusSignin: boolean;
  showPricing: boolean;
}

/**
 * Fail-closed gate policy (M-1 fix). Every gate failure blocks generation:
 * - 'signin' → nudge to sign in (focus the email field)
 * - 'limit' → upgrade nudge (show the pricing tab)
 * - 'unavailable' → BLOCKED with a connection-error nudge.
 *
 * Deliberate product-behavior change (2026-10-09): with server-side quota
 * enforcement in POST /api/generations, the old warn-and-proceed on
 * 'unavailable' was a one-click quota bypass (DevTools → block /api/* →
 * generate freely, nothing counted). A signed-in user whose quota cannot
 * be verified now does not generate. A backend outage therefore blocks
 * generation until the backend is reachable again.
 */
export function decideGateAction(gate: GateResult, tier: GateTier | null): GateAction {
  if (gate.ok) return { proceed: true, nudge: null, focusSignin: false, showPricing: false };
  if (gate.reason === 'signin') {
    return { proceed: false, nudge: SIGNIN_NUDGE, focusSignin: true, showPricing: false };
  }
  if (gate.reason === 'limit') {
    return { proceed: false, nudge: upgradeNudge('generate', tier), focusSignin: false, showPricing: true };
  }
  return {
    proceed: false,
    nudge: 'Billing service unreachable — your quota could not be verified, so generation is blocked. Check your connection and try again.',
    focusSignin: false,
    showPricing: false,
  };
}

const chipCss = `
  #acct { display:flex; flex-direction:column; gap:8px; padding:10px 12px; background:#111827;
          border:1px solid #1e2638; border-radius:10px; }
  #acct .row { display:flex; gap:8px; align-items:center; }
  #acct input { flex:1; min-width:0; background:#131a2a; color:#e6ecf5; border:1px solid #2a3550;
                border-radius:8px; padding:8px 10px; font-size:12.5px; }
  #acct button { padding:8px 10px; font-size:12px; white-space:nowrap; }
  #acct .chip { display:flex; align-items:center; gap:8px; font-size:12px; }
  #acct .email { color:#8fa5c8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:150px; }
  #acct .tier { padding:2px 8px; border-radius:6px; font-size:10.5px; font-weight:700; letter-spacing:.08em; }
  #acct .tier.free { background:#1a2438; color:#8fa5c8; }
  #acct .tier.hobby { background:#0e2f3d; color:#3fd8ff; border:1px solid #1f6d8a; }
  #acct .tier.pro { background:#2f270e; color:#ffd76a; border:1px solid #8a6d1f; }
  #acct .left { color:#5a6a85; font-size:11px; }
  #acct .note { font-size:11px; color:#5a6a85; line-height:1.4; }
  #acct .err { font-size:11px; color:#ff8b95; }
`;

function ensureChipCss() {
  if (document.getElementById('xandria-acct-css')) return;
  const s = document.createElement('style');
  s.id = 'xandria-acct-css';
  s.textContent = chipCss;
  document.head.appendChild(s);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Mount the account chip into `host` (placed under the studio H1).
 * Re-render by calling the returned function after state.refresh().
 */
export function mountAccountChip(host: HTMLElement, state: BillingState, notify: Notify): () => void {
  ensureChipCss();
  const render = () => {
    host.innerHTML = '';
    const box = document.createElement('div');
    box.id = 'acct';
    if (!state.email) {
      box.innerHTML = `
        <div class="lbl">ACCOUNT — SIGN IN TO GENERATE</div>
        <div class="row"><input id="acct-email" type="email" placeholder="you@example.com" autocomplete="email"/>
        <button id="acct-send" class="primary">✉ SEND LINK</button></div>
        <div class="note">Free: 5 generations/mo, no card. We email you a sign-in link.</div>`;
      const input = box.querySelector<HTMLInputElement>('#acct-email')!;
      const send = box.querySelector<HTMLButtonElement>('#acct-send')!;
      const doSend = async () => {
        const email = input.value.trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          box.querySelector('.note')!.outerHTML = `<div class="err">Enter a valid email address.</div>`;
          return;
        }
        send.disabled = true;
        send.textContent = 'SENDING…';
        const r = await signInWithOtp(email);
        if (r.ok) {
          box.querySelector('.note, .err')!.outerHTML =
            `<div class="note">✉ Check <b>${esc(email)}</b> for your sign-in link.</div>`;
        } else {
          box.querySelector('.note, .err')!.outerHTML = `<div class="err">Couldn't send: ${esc(r.error)}</div>`;
        }
        send.disabled = false;
        send.textContent = '✉ SEND LINK';
      };
      send.addEventListener('click', () => void doSend());
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doSend(); });
    } else {
      const tier = (state.me?.tier ?? 'free') as GateTier;
      const left = state.me ? `${state.me.generations_remaining} left` : '…';
      box.innerHTML = `
        <div class="chip">
          <span class="email" title="${esc(state.email)}">${esc(truncateEmail(state.email))}</span>
          <span class="tier ${tier}">${tierBadge(tier)}</span>
          <span class="left">${esc(left)}</span>
          <button id="acct-out" title="Sign out">⎋</button>
        </div>`;
      box.querySelector('#acct-out')!.addEventListener('click', () => {
        void signOut().then(() => state.refresh());
      });
    }
    host.appendChild(box);
  };
  render();
  return render;
}

const pricingCss = `
  #pricing { display:flex; flex-direction:column; gap:10px; }
  #pricing .lbl { font-size:10px; letter-spacing:.18em; color:#5a6a85; }
  #pricing .card { border:1px solid #1e2638; border-radius:12px; padding:14px; background:#111827;
                   display:flex; flex-direction:column; gap:8px; }
  #pricing .card.pro { border-color:#8a6d1f; }
  #pricing .card.hobby { border-color:#1f6d8a; }
  #pricing .name { font-size:14px; font-weight:700; letter-spacing:.12em; color:#7af7ff; }
  #pricing .card.pro .name { color:#ffd76a; }
  #pricing .price { font-size:20px; font-weight:700; }
  #pricing .price small { font-size:11px; color:#5a6a85; font-weight:400; }
  #pricing ul { margin:0; padding-left:18px; font-size:12px; color:#9fb0cc; line-height:1.7; }
  #pricing button { width:100%; }
  #pricing .cur { font-size:11px; color:#5a6a85; text-align:center; }
`;

/**
 * Mount the pricing tab content. Hobby/Pro buttons require sign-in first,
 * then POST /api/checkout and redirect to the Stripe URL.
 */
export function mountPricing(host: HTMLElement, state: BillingState, notify: Notify): void {
  if (!document.getElementById('xandria-pricing-css')) {
    const s = document.createElement('style');
    s.id = 'xandria-pricing-css';
    s.textContent = pricingCss;
    document.head.appendChild(s);
  }

  const current: GateTier | null = state.me ? (state.me.tier as GateTier) : state.email ? 'free' : null;

  const card = (
    name: string, cls: string, price: string, per: string, features: string[], cta: string,
    tier: GateTier, action: () => void,
  ) => {
    const isCurrent = current === tier;
    return `<div class="card ${cls}">
      <div class="name">${name}</div>
      <div class="price">${price} <small>${per}</small></div>
      <ul>${features.map((f) => `<li>${f}</li>`).join('')}</ul>
      ${isCurrent
        ? `<div class="cur">✓ current plan</div>`
        : `<button data-tier="${tier}">${cta}</button>`}
    </div>`;
  };

  host.innerHTML = `<div id="pricing"><div class="lbl">PRICING — CANCEL ANYTIME</div>${[
    card('FREE', '', '$0', 'forever', [
      `${TIER_GENERATIONS_PER_MONTH.free} generations / month`,
      'Unskippable "Made with XANDRIA" splash',
      'Non-commercial use',
    ], state.email ? 'USE FREE' : 'SIGN IN FOR FREE', 'free', () => {
      if (!state.email) notify(SIGNIN_NUDGE);
    }),
    card('HOBBY', 'hobby', '$12', '/ month', [
      `${TIER_GENERATIONS_PER_MONTH.hobby} generations / month`,
      'Splash removable (your choice)',
      'itch.io HTML export',
      'Commercial use',
    ], 'UPGRADE TO HOBBY', 'hobby', () => void startCheckout('hobby', state, notify)),
    card('PRO', 'pro', '$39', '/ month', [
      `${TIER_GENERATIONS_PER_MONTH.pro} generations / month`,
      'Everything in Hobby',
      'Steam-ready export',
      'API access',
      'Priority queue',
    ], 'UPGRADE TO PRO', 'pro', () => void startCheckout('pro', state, notify)),
  ].join('')}</div>`;

  host.querySelectorAll<HTMLButtonElement>('button[data-tier]').forEach((b) => {
    const t = b.dataset.tier as GateTier;
    b.addEventListener('click', () => {
      if (t === 'free') {
        if (!state.email) notify(SIGNIN_NUDGE);
        return;
      }
      void startCheckout(t, state, notify);
    });
  });
}

async function startCheckout(tier: 'hobby' | 'pro', state: BillingState, notify: Notify): Promise<void> {
  if (!state.email) {
    notify(SIGNIN_NUDGE + ' Then come back to upgrade.');
    return;
  }
  notify(`Opening secure checkout for ${tier === 'hobby' ? 'Hobby ($12/mo)' : 'Pro ($39/mo)'}…`);
  const url = await createCheckoutUrl(tier);
  if (url) {
    // Full redirect: Stripe Checkout completes off-site, then returns to
    // ?checkout=success / ?checkout=canceled.
    location.href = url;
  } else {
    notify('Checkout failed to start — check your connection and try again. No charge was made.');
  }
}

/** Handle ?checkout=success | ?checkout=canceled on studio load. */
export async function handleCheckoutReturn(state: BillingState, notify: Notify): Promise<void> {
  const params = new URLSearchParams(location.search);
  const result = params.get('checkout');
  if (result !== 'success' && result !== 'canceled') return;
  // Strip the param so a refresh doesn't re-fire the toast.
  params.delete('checkout');
  const next = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`;
  history.replaceState(null, '', next);
  if (result === 'success') {
    await state.refresh();
    const tier = state.me?.tier;
    notify(
      tier === 'pro' || tier === 'hobby'
        ? `🎉 Welcome to XANDRIA ${tierBadge(tier as GateTier)} — your plan is active.`
        : '🎉 Payment received — your plan is activating (refresh in a few seconds if the badge hasn\'t updated).',
    );
  } else {
    notify('Checkout canceled — no charge was made.');
  }
}

/** Effective splash flag for previews/exports from the studio. */
export function studioSplashEnabled(state: BillingState): boolean {
  if (!state.enabled) return true; // billing off → player default (ON)
  return effectiveSplash(state.me ? (state.me.tier as GateTier) : null, state.splashOn);
}

/** Export gating shared by the studio export row. */
export function exportGate(state: BillingState): { ok: true } | { ok: false; nudge: string } {
  if (!state.enabled) return { ok: true };
  const tier = state.me ? (state.me.tier as GateTier) : null;
  if (canExportItch(tier)) return { ok: true };
  return { ok: false, nudge: upgradeNudge('export', tier) };
}

export function steamGate(state: BillingState): { ok: true } | { ok: false; nudge: string } {
  if (!state.enabled) return { ok: true };
  const tier = state.me ? (state.me.tier as GateTier) : null;
  if (canExportSteam(tier)) return { ok: true };
  return { ok: false, nudge: upgradeNudge('steam', tier) };
}

export function apiGate(state: BillingState): { ok: true } | { ok: false; nudge: string } {
  if (!state.enabled) return { ok: true };
  const tier = state.me ? (state.me.tier as GateTier) : null;
  if (canUseApi(tier)) return { ok: true };
  return { ok: false, nudge: upgradeNudge('api', tier) };
}
