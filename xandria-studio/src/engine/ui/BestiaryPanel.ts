/**
 * Bestiary wave: the enemy codex UI panel.
 *
 * DOM pattern follows SkillsPanel (absolute in the engine container,
 * self-contained inline styles, capture-phase key handling). Lists every
 * bestiary registry entry with its schematic silhouette, unlock/tier
 * state, kill count, weakness notes, and the codex-visible loot table
 * (read from the SAME drop tables rollLoot() uses — the codex never lies
 * about drops).
 *
 * Thumbnails are schematic SVG silhouettes per kind — NOT render-target
 * snapshots. Chosen deliberately: zero new art assets, zero draw calls in
 * the 3D scene, zero canvas-readback flakiness in e2e. Disclosed here and
 * in the wave report.
 *
 * Open/close: the `B` key (capture phase) toggles; Esc closes. A floating
 * "BESTIARY" chip (below the SKILLS chip) gives touch users the toggle.
 * Never opens while another modal owns input (crafting panel, and the
 * skills panel via the optional otherOpen predicate).
 *
 * The `doc` param is injectable so unit tests can pass a minimal DOM stub.
 */
import type { ItemDef } from '@spec';
import {
  type BestiaryEntryDef,
  type BestiaryManager,
  BESTIARY_TIER_NAMES,
  BESTIARY_BOSS_ID,
  ELITE_CODEX_LINES,
} from '../game/bestiary';
import {
  lootTableForBestiary,
  bossLootForBestiary,
} from '../game/loot';
/**
 * ELEMENTAL-DAMAGE-TYPES: the codex resistance section renders the
 * SAME resistance table Enemy.damage() uses (elemental.ts) — observe-only.
 */
import { resistanceLines } from '../game/elemental';

export interface BestiaryPanelOpts {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** live bestiary manager (null = panel shows "no bestiary data") */
  bestiary: () => BestiaryManager | null;
  /** item def table (loot display names) */
  defs: () => Record<string, ItemDef>;
  /** true while another modal (the crafting panel) owns input */
  isModalOpen?: () => boolean;
  /** true while the skills panel is open (avoid modal overlap) */
  otherOpen?: () => boolean;
}

const AMBER = '#ffb545';
const EMBER = '#ff6a3d';
const PANEL_BG = 'rgba(8,10,16,0.96)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';
const DARK = '#3a4150';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- silhouettes

/**
 * Schematic kind silhouettes as inline SVG (no art assets, no texture
 * reads — pure DOM). Accent color rides the kind's ember tone; locked
 * entries render in flat dark with a "?" badge.
 */
const SILHOUETTE_ACCENT: Record<string, string> = {
  walker: '#ff6a3d',
  brute: '#ff3d5e',
  drone: '#ffb545',
  flyer: '#c77dff',
  turret: '#ff9a3d',
  boss: '#ff2222',
};

function silhouetteSvg(kind: string, unlocked: boolean): string {
  const a = unlocked ? (SILHOUETTE_ACCENT[kind] ?? EMBER) : DARK;
  const s = `stroke="${a}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  const body = (inner: string) =>
    `<svg viewBox="0 0 64 64" width="56" height="56" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  switch (kind) {
    case 'walker':
      return body(`<circle cx="32" cy="14" r="7" ${s}/><path d="M32 21v18M32 27l-11 6M32 27l11 6M32 39l-8 17M32 39l8 17" ${s}/><path d="M27 12h10" ${s} stroke="#ffd23d"/>`);
    case 'brute':
      return body(`<circle cx="32" cy="15" r="8" ${s}/><rect x="20" y="23" width="24" height="20" rx="4" ${s}/><circle cx="16" cy="28" r="5" ${s}/><circle cx="48" cy="28" r="5" ${s}/><path d="M26 43l-5 15M38 43l5 15" ${s}/><path d="M26 13h12" ${s} stroke="#ffd23d"/>`);
    case 'drone':
      return body(`<rect x="24" y="26" width="16" height="12" rx="3" ${s}/><path d="M24 26L10 12M40 26l14-14M24 38L10 52M40 38l14 14" ${s}/><circle cx="10" cy="12" r="4" ${s}/><circle cx="54" cy="12" r="4" ${s}/><circle cx="10" cy="52" r="4" ${s}/><circle cx="54" cy="52" r="4" ${s}/><circle cx="32" cy="32" r="3" ${s} stroke="#ffd23d"/>`);
    case 'flyer':
      return body(`<path d="M8 40L32 26l24 14-24 6z" ${s}/><path d="M32 26v22" ${s}/><path d="M20 34l12-8 12 8" ${s} stroke="#ffd23d"/>`);
    case 'turret':
      return body(`<path d="M20 56l4-18h16l4 18z" ${s}/><rect x="26" y="26" width="12" height="12" rx="2" ${s}/><path d="M32 26V8" ${s}/><circle cx="32" cy="8" r="3" ${s} stroke="#ffd23d"/>`);
    case 'boss':
      return body(`<path d="M32 6l10 12 14 4-10 10 2 16-16-8-16 8 2-16-10-10 14-4z" ${s}/><path d="M26 26h12M26 34h12" ${s} stroke="#ffd23d"/>`);
    default:
      return body(`<circle cx="32" cy="32" r="18" ${s}/>`);
  }
}

// ---------------------------------------------------------------- panel

export class BestiaryPanel {
  private root: HTMLElement;
  private cardsEl: HTMLElement;
  private chip: HTMLElement;
  private countEl: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;

  constructor(private readonly opts: BestiaryPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container;

    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(480px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${EMBER}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-bestiary-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Bestiary');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${EMBER}33`,
    ].join(';'));
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
    const titleRow = el(doc, 'div', 'display:flex;align-items:baseline;gap:10px');
    titleRow.append(
      el(doc, 'div', `font-size:15px;font-weight:700;color:${EMBER};letter-spacing:0.05em`, 'BESTIARY'),
      el(doc, 'div', `font-size:12px;color:${DIM}`, 'field notes on the things trying to kill you'),
    );
    headLeft.append(titleRow);
    this.countEl = el(doc, 'div', `font-size:11.5px;color:${DIM}`, '');
    headLeft.append(this.countEl);
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1',
    ].join(';'), '×');
    close.setAttribute('aria-label', 'Close bestiary panel');
    close.addEventListener('click', () => this.hide());
    head.append(headLeft, close);

    this.cardsEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px', 'display:flex',
      'flex-direction:column', 'gap:8px', 'min-height:120px',
    ].join(';'));

    const foot = el(doc, 'div', [
      'padding:8px 14px 10px', `font-size:11px;color:${DIM}`, 'text-align:center',
    ].join(';'), 'B / Esc to close — kills unlock entries; study them to master them');

    root.append(head, this.cardsEl, foot);
    container.appendChild(root);
    this.root = root;

    // floating chip — below the SKILLS chip (top:12px), ≥44px touch target
    const chip = el(doc, 'button', [
      'position:absolute', 'right:12px', 'top:52px', 'z-index:9500',
      `background:${PANEL_BG}`, `border:1px solid ${EMBER}73`, 'border-radius:8px',
      `color:${EMBER}`, 'font-size:12px', 'font-weight:700', 'font-family:inherit',
      'letter-spacing:0.06em', 'padding:8px 12px', 'cursor:pointer',
    ].join(';'), 'BESTIARY') as HTMLButtonElement;
    chip.id = 'xandria-bestiary-chip';
    chip.setAttribute('aria-label', 'Open bestiary panel');
    chip.addEventListener('click', () => this.toggle());
    container.appendChild(chip);
    this.chip = chip;

    this.onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      if (this.open_) {
        if (e.code === 'Escape' || e.code === 'KeyB') {
          e.stopPropagation();
          e.preventDefault();
          this.hide();
        }
        return;
      }
      if (e.code === 'KeyB' && !this.modalBlocked()) {
        e.stopPropagation();
        e.preventDefault();
        this.show();
      }
    };
    const w = (doc as Document & { defaultView?: Window }).defaultView ?? (globalThis as unknown as { window?: Window }).window;
    w?.addEventListener('keydown', this.onKey, true);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Visible for tests: the floating toggle chip. */
  get chipEl(): HTMLElement {
    return this.chip;
  }

  private modalBlocked(): boolean {
    return (this.opts.isModalOpen?.() ?? false) || (this.opts.otherOpen?.() ?? false);
  }

  show(): void {
    if (this.disposed) return;
    if (this.modalBlocked()) return;
    this.root.style.display = 'flex';
    this.chip.style.display = 'none';
    this.open_ = true;
    this.renderCards();
  }

  hide(): void {
    if (this.disposed) return;
    this.root.style.display = 'none';
    this.chip.style.display = '';
    this.open_ = false;
  }

  toggle(): void {
    if (this.open_) this.hide();
    else this.show();
  }

  /** Re-render the cards (call after kills while open). */
  refresh(): void {
    if (this.disposed || !this.open_) return;
    this.renderCards();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.open_ = false;
    this.root.style.display = 'none';
    const w = (this.opts.doc as (Document & { defaultView?: Window }) | undefined)?.defaultView
      ?? (globalThis as unknown as { window?: Window }).window;
    w?.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
    this.chip.remove();
  }

  // ------------------------------------------------------------ cards

  private renderCards(): void {
    const doc = this.opts.doc ?? globalThis.document;
    const bestiary = this.opts.bestiary();
    while (this.cardsEl.firstChild) this.cardsEl.firstChild.remove();
    if (!bestiary) {
      this.cardsEl.append(el(doc, 'div', `font-size:13px;color:${DIM};padding:12px 4px`, 'No bestiary data in this scene.'));
      return;
    }
    const defs = bestiary.defs();
    let unlocked = 0;
    for (const def of defs) {
      const tier = bestiary.tierOf(def.id);
      if (tier > 0) unlocked++;
      this.cardsEl.append(this.entryCard(doc, bestiary, def, tier));
    }
    this.countEl.textContent = `${unlocked} / ${defs.length} identified`;
    // UPGRADE LOOP (elite-affixes): codex section for elite affixes —
    // observe-only presentation of ELITE_AFFIX_DEFS (gold-tinted elites
    // in the world carry these). Rendered for every codex open; no
    // kill-count interaction, no behavior change.
    const eliteHead = el(doc, 'div', `font-size:12px;font-weight:700;color:#ffd700;letter-spacing:0.06em;padding:10px 4px 2px`, 'ELITE AFFIXES — gold-tinted foes carry 1–2 of these');
    this.cardsEl.append(eliteHead);
    for (const line of ELITE_CODEX_LINES) {
      this.cardsEl.append(el(doc, 'div', `font-size:12px;color:${TEXT};padding:4px 4px;line-height:1.45`, `${line.icon} ${line.name} — ${line.effect}`));
    }
  }

  private entryCard(doc: Document, bestiary: BestiaryManager, def: BestiaryEntryDef, tier: number): HTMLElement {
    const card = el(doc, 'div', [
      'border:1px solid rgba(255,255,255,0.09)', 'border-radius:8px',
      'padding:10px 12px', 'display:flex', 'gap:12px',
      'background:rgba(255,255,255,0.025)',
    ].join(';'));
    const locked = tier === 0;

    // silhouette
    const shot = el(doc, 'div', [
      'flex:0 0 auto', 'width:64px', 'height:64px', 'display:flex',
      'align-items:center', 'justify-content:center',
      'border:1px solid rgba(255,255,255,0.08)', 'border-radius:8px',
      locked ? 'background:rgba(0,0,0,0.4)' : 'background:rgba(255,106,61,0.06)',
      'position:relative',
    ].join(';'));
    const wrap = doc.createElement('div');
    wrap.innerHTML = silhouetteSvg(def.silhouette, !locked);
    shot.append(wrap);
    if (locked) {
      const q = el(doc, 'div', [
        'position:absolute', 'right:2px', 'bottom:0px', 'font-size:16px',
        `color:${DIM}`, 'font-weight:700',
      ].join(';'), '?');
      shot.append(q);
    }
    card.append(shot);

    const body = el(doc, 'div', 'display:flex;flex-direction:column;gap:5px;flex:1;min-width:0');

    // name + tier badge
    const top = el(doc, 'div', 'display:flex;align-items:baseline;justify-content:space-between;gap:8px');
    top.append(
      el(doc, 'div', `font-size:13.5px;font-weight:700;color:${locked ? DIM : TEXT}`,
        locked ? '??? — unknown foe' : def.name),
      el(doc, 'div', [
        'font-size:11px', 'font-weight:700', 'letter-spacing:0.08em',
        `color:${locked ? DIM : tier === 3 ? '#ffd23d' : tier === 2 ? '#8fe3a8' : EMBER}`,
      ].join(';'), BESTIARY_TIER_NAMES[tier] ?? 'LOCKED'),
    );
    body.append(top);
    if (!locked) {
      body.append(el(doc, 'div', `font-size:12px;color:${DIM};font-style:italic`, def.epithet));
      body.append(el(doc, 'div', `font-size:12px;color:${DIM}`, def.lore));
    } else {
      body.append(el(doc, 'div', `font-size:12px;color:${DIM}`, 'Defeat one to identify it.'));
    }

    // kill count + tier progress
    const kills = bestiary.countOf(def.id);
    if (!locked) {
      const need = bestiary.killsToNext(def.id);
      const barLabel = need === null
        ? `MASTERED — ${kills} kills`
        : `${kills} kills — ${need} more to ${BESTIARY_TIER_NAMES[tier + 1]}`;
      body.append(el(doc, 'div', `font-size:11.5px;color:${DIM}`, barLabel));
      if (need !== null) {
        // exact progress inside the current tier segment
        const th = bestiary.tierThresholds;
        const lo = tier === 1 ? th.seen : th.studied;
        const hi = tier === 1 ? th.studied : th.mastered;
        const frac = hi > lo ? (kills - lo) / (hi - lo) : 1;
        const track = el(doc, 'div', 'height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden');
        const bar = el(doc, 'div', `height:100%;width:${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%;background:${EMBER};border-radius:3px`);
        track.append(bar);
        body.append(track);
      }
    }

    // weaknesses (unlocked only)
    if (!locked) {
      const wk = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
      wk.append(el(doc, 'div', `font-size:11px;font-weight:700;color:${DIM};letter-spacing:0.08em`, 'FIELD NOTES — WEAKNESSES'));
      for (const line of def.weaknesses) {
        wk.append(el(doc, 'div', `font-size:11.5px;color:${TEXT}`, '▸ ' + line));
      }
      body.append(wk);
    }

    // resistances (unlocked only) — from the SAME table Enemy.damage()
    // uses (elemental.ts), so the codex can never lie about them.
    // Boss entries render the 'boss' row; other entries their kind row.
    if (!locked) {
      const rs = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
      rs.append(el(doc, 'div', `font-size:11px;font-weight:700;color:${DIM};letter-spacing:0.08em`, 'RESISTANCES — DAMAGE TYPES'));
      for (const line of resistanceLines(def.id, def.id === BESTIARY_BOSS_ID)) {
        const row = el(doc, 'div', `font-size:11.5px;color:${line.color}`, line.text);
        rs.append(row);
      }
      body.append(rs);
    }

    // loot table (unlocked only) — from the same tables the roller uses
    if (!locked) {
      const lt = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px');
      lt.append(el(doc, 'div', `font-size:11px;font-weight:700;color:${DIM};letter-spacing:0.08em`, 'KNOWN DROPS'));
      const defsTable = this.opts.defs();
      if (def.id === BESTIARY_BOSS_ID) {
        const b = bossLootForBestiary();
        const gearNames = b.gear.map((id) => defsTable[id]?.name ?? id).join(' / ');
        lt.append(el(doc, 'div', `font-size:11.5px;color:#ffd23d`, `Guaranteed epic+ gear: ${gearNames}`));
        lt.append(el(doc, 'div', `font-size:11.5px;color:${DIM}`, `+ ${b.materialRolls} machine-material rolls`));
      } else {
        const t = lootTableForBestiary(def.id);
        const rows: Array<{ itemId: string; label: string }> = [];
        for (const e of t.materials) rows.push({ itemId: e.itemId, label: `${e.chancePct.toFixed(1)}%` });
        for (const e of t.gear) rows.push({ itemId: e.itemId, label: `${e.chancePct.toFixed(1)}%` });
        if (!rows.length) {
          lt.append(el(doc, 'div', `font-size:11.5px;color:${DIM}`, 'Nothing recorded yet.'));
        } else {
          for (const r of rows) {
            const nm = defsTable[r.itemId]?.name ?? r.itemId;
            lt.append(el(doc, 'div', `font-size:11.5px;color:${TEXT}`, `${nm} — ${r.label} per kill`));
          }
        }
      }
      body.append(lt);
    }

    card.append(body);
    return card;
  }
}
