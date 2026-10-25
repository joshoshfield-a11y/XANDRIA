/**
 * Vendor-economy wave: the vendor shop UI panel.
 *
 * DOM pattern follows SkillsPanel (absolute in the engine container,
 * self-contained inline styles, capture-phase key handling, injectable
 * `doc` for unit tests). Two tabs:
 *
 * - BUY: this map visit's seeded stock for the open vendor
 *   (buildVendorStock — pure in (def, npcSpawnSeed, defs)). Sold-out
 *   lines are disabled honestly. Buy is atomic: wallet.spend first;
 *   when the backpack is full the spend is refunded and a toast says so.
 * - SELL: every backpack stack with a positive def.value, at the
 *   vendor's sellMult. One unit per click.
 *
 * Touch: every interactive row button is a native <button> with
 * min-height 28px (the hud-polish precedent). Esc closes; the panel
 * never opens while another modal owns input (isModalOpen).
 *
 * Sold-out state is map-local by design (matches the gathering-nodes
 * precedent): stock lives in a per-(vendorId, spawnSeed) cache on the
 * panel; a portal arrival respawns the vendor with a new spawnSeed, so
 * the identical seeded stock returns, fully restocked.
 */
import type { ItemDef, VendorDef } from '@spec';
import type { Inventory } from '../game/items/Inventory';
import {
  CURRENCY_NAME,
  Wallet,
  buildVendorStock,
  isSellable,
  unitSellPrice,
  type VendorStockEntry,
} from '../game/economy';
import { effectiveBuyPrice, effectiveSellPrice } from '../game/factions';
import { RARITY_COLORS } from './InventoryHUD';

export interface ShopVendor {
  vendorId: string;
  /** npc.spawnSeed — keys the seeded stock for this map visit */
  spawnSeed: number;
  /** display name of the keeper */
  keeperName: string;
}

export interface ShopPanelOpts {
  container: HTMLElement;
  /** DOM document (injectable for unit tests; default: globalThis.document) */
  doc?: Document;
  /** live inventory (null = panel shows "no inventory") */
  inventory: () => Inventory | null;
  /** live player wallet */
  wallet: () => Wallet | null;
  /** item def table */
  defs: () => Record<string, ItemDef>;
  /** resolved vendor roster */
  vendorDefs: () => readonly VendorDef[];
  /** true while another modal (crafting panel / dialogue) owns input */
  isModalOpen?: () => boolean;
  /** toast sink */
  toast?: (msg: string) => void;
  /**
   * factions-reputation wave: current standing for a vendor id (the
   * blueprint maps vendor -> faction first). Absent = 0 (neutral), so
   * un-wired panels price exactly as before.
   */
  standingOf?: (vendorId: string) => number;
  /**
   * factions-reputation wave: fired after a successful buy/sell so the
   * blueprint can adjust standing. Never affects the transaction.
   */
  onTrade?: (vendorId: string, kind: 'buy' | 'sell') => void;
}

const AMBER = '#ffb545';
const PANEL_BG = 'rgba(8,10,16,0.96)';
const TEXT = '#e8ecf4';
const DIM = '#9aa4b8';
const GOOD = '#8fe3a8';
const BAD = '#ff9a8a';

function el(doc: Document, tag: string, css: string, text?: string): HTMLElement {
  const e = doc.createElement(tag) as HTMLElement;
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

const BTN_CSS = [
  'min-height:28px', 'min-width:64px', 'padding:4px 12px',
  'border-radius:6px', 'cursor:pointer', 'font-family:inherit',
  'font-size:13px', 'font-weight:700',
].join(';');

export class ShopPanel {
  private root: HTMLElement;
  private headEl: HTMLElement;
  private balanceEl: HTMLElement;
  private tabBuy: HTMLButtonElement;
  private tabSell: HTMLButtonElement;
  private listEl: HTMLElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;
  private tab: 'buy' | 'sell' = 'buy';
  private vendor: ShopVendor | null = null;
  /** per-(vendorId,spawnSeed) mutable stock for this map visit */
  private stockCache = new Map<string, VendorStockEntry[]>();

  constructor(private readonly opts: ShopPanelOpts) {
    const doc = opts.doc ?? globalThis.document;
    const container = opts.container;

    const root = el(doc, 'div', [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9600', 'width:min(460px,94vw)', 'max-height:84vh',
      'display:none', 'flex-direction:column',
      `background:${PANEL_BG}`, `border:1px solid ${AMBER}73`, 'border-radius:12px',
      'font-family:system-ui,-apple-system,sans-serif', `color:${TEXT}`,
      'box-shadow:0 12px 48px rgba(0,0,0,0.6)',
    ].join(';'));
    root.id = 'xandria-shop-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Vendor shop');

    const head = el(doc, 'div', [
      'display:flex', 'align-items:flex-start', 'justify-content:space-between',
      'padding:12px 14px 10px', `border-bottom:1px solid ${AMBER}33`, 'gap:8px',
    ].join(';'));
    const headLeft = el(doc, 'div', 'display:flex;flex-direction:column;gap:2px;min-width:0');
    this.headEl = el(doc, 'div', `font-size:15px;font-weight:700;color:${AMBER};letter-spacing:0.05em`, '');
    const tagline = el(doc, 'div', `font-size:12px;color:${DIM}`, '');
    tagline.id = 'xandria-shop-tagline';
    const keeper = el(doc, 'div', `font-size:11px;color:${DIM};opacity:0.85`, '');
    keeper.id = 'xandria-shop-keeper';
    headLeft.append(this.headEl, tagline, keeper);
    this.balanceEl = el(doc, 'div', `font-size:13px;font-weight:700;color:${GOOD};white-space:nowrap`, '');
    const close = el(doc, 'button', [
      'background:transparent', `color:${DIM}`, 'border:1px solid rgba(154,164,184,0.4)',
      'border-radius:6px', 'width:28px', 'height:28px', 'font-size:15px',
      'cursor:pointer', 'font-family:inherit', 'line-height:1', 'flex:none',
    ].join(';'), '×') as HTMLButtonElement;
    close.setAttribute('aria-label', 'Close shop');
    close.addEventListener('click', () => this.hide());
    const headRight = el(doc, 'div', 'display:flex;align-items:center;gap:8px;flex:none');
    headRight.append(this.balanceEl, close);
    head.append(headLeft, headRight);

    const tabs = el(doc, 'div', 'display:flex;gap:8px;padding:10px 14px 0');
    this.tabBuy = el(doc, 'button', BTN_CSS, 'BUY') as HTMLButtonElement;
    this.tabSell = el(doc, 'button', BTN_CSS, 'SELL') as HTMLButtonElement;
    this.tabBuy.setAttribute('data-shop-tab', 'buy');
    this.tabSell.setAttribute('data-shop-tab', 'sell');
    for (const b of [this.tabBuy, this.tabSell]) {
      b.style.background = 'transparent';
      b.style.color = DIM;
      b.style.border = '1px solid rgba(154,164,184,0.4)';
    }
    this.tabBuy.addEventListener('click', () => { this.tab = 'buy'; this.render(); });
    this.tabSell.addEventListener('click', () => { this.tab = 'sell'; this.render(); });
    tabs.append(this.tabBuy, this.tabSell);

    this.listEl = el(doc, 'div', [
      'overflow-y:auto', 'padding:8px 10px 12px', 'display:flex',
      'flex-direction:column', 'gap:6px', 'min-height:120px',
    ].join(';'));

    root.append(head, tabs, this.listEl);
    container.appendChild(root);
    this.root = root;

    this.onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.open_) {
        e.stopPropagation();
        this.hide();
      }
    };
    doc.addEventListener('keydown', this.onKey, true);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** vendorId of the open shop (null when closed). */
  get vendorId(): string | null {
    return this.vendor?.vendorId ?? null;
  }

  /**
   * Open the shop for a vendor NPC. Returns false when another modal owns
   * input (the caller falls back to the dialogue instead).
   */
  openForVendor(v: ShopVendor): boolean {
    if (this.disposed) return false;
    if (this.opts.isModalOpen?.()) return false;
    this.vendor = v;
    this.tab = 'buy';
    this.open_ = true;
    this.root.style.display = 'flex';
    this.render();
    return true;
  }

  hide(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.vendor = null;
    this.root.style.display = 'none';
  }

  /** Re-render an open panel (wired to inventory/wallet onChange by the blueprint). */
  refresh(): void {
    if (this.open_) this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    (this.opts.doc ?? globalThis.document).removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }

  /** Mutable per-visit stock (visible for tests + the e2e). */
  stockFor(vendorId: string, spawnSeed: number): VendorStockEntry[] {
    const key = `${vendorId}:${spawnSeed >>> 0}`;
    let stock = this.stockCache.get(key);
    if (!stock) {
      const def = this.opts.vendorDefs().find((d) => d.id === vendorId);
      stock = def ? buildVendorStock(def, spawnSeed, this.opts.defs()) : [];
      this.stockCache.set(key, stock);
    }
    return stock;
  }

  private render(): void {
    const v = this.vendor;
    if (!v) return;
    const doc = this.opts.doc ?? globalThis.document;
    const defs = this.opts.defs();
    const vendorDef = this.opts.vendorDefs().find((d) => d.id === v.vendorId);
    this.headEl.textContent = vendorDef?.name ?? v.keeperName;
    // the keeper's name rides in the header so the player knows WHO
    // they're trading with (the [E] prompt said "Trade with <name>")
    const keeper = doc.getElementById('xandria-shop-keeper');
    if (keeper) keeper.textContent = `keeper: ${v.keeperName}`;
    const tagline = doc.getElementById('xandria-shop-tagline');
    if (tagline) tagline.textContent = vendorDef?.tagline ?? '';
    const wallet = this.opts.wallet();
    this.balanceEl.textContent = `${wallet?.balance ?? 0} ${CURRENCY_NAME}`;
    for (const [b, active] of [[this.tabBuy, this.tab === 'buy'], [this.tabSell, this.tab === 'sell']] as const) {
      b.style.background = active ? AMBER : 'transparent';
      b.style.color = active ? '#10131a' : DIM;
      b.style.border = active ? 'none' : '1px solid rgba(154,164,184,0.4)';
    }
    this.listEl.replaceChildren();
    if (this.tab === 'buy') this.renderBuy(v, vendorDef, defs, wallet);
    else this.renderSell(vendorDef, defs);
  }

  private renderBuy(v: ShopVendor, vendorDef: VendorDef | undefined, defs: Record<string, ItemDef>, wallet: Wallet | null): void {
    const doc = this.opts.doc ?? globalThis.document;
    const stock = this.stockFor(v.vendorId, v.spawnSeed);
    if (stock.length === 0) {
      this.listEl.append(el(doc, 'div', `font-size:13px;color:${DIM};padding:12px`, 'No stock today. Check back after the next portal crossing.'));
      return;
    }
    for (const line of stock) {
      const def = defs[line.itemId];
      const name = def?.name ?? line.itemId;
      const color = def?.rarity ? (RARITY_COLORS[def.rarity] ?? TEXT) : TEXT;
      const row = el(doc, 'div', [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:6px 8px', 'border:1px solid rgba(154,164,184,0.18)', 'border-radius:8px',
      ].join(';'));
      const info = el(doc, 'div', 'display:flex;flex-direction:column;gap:1px;flex:1;min-width:0');
      const nm = el(doc, 'div', `font-size:13px;font-weight:700;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`, name);
      // factions-reputation wave: the standing factor applies AFTER the
      // seeded stock price (jitter + buyMult already inside line.price).
      const price = this.effectiveBuy(line, v.vendorId);
      const sub = el(doc, 'div', `font-size:11px;color:${DIM}`,
        line.stock > 0 ? `${price} ${CURRENCY_NAME} · ${line.stock} left` : 'SOLD OUT');
      info.append(nm, sub);
      const buy = el(doc, 'button', BTN_CSS, 'BUY') as HTMLButtonElement;
      buy.style.background = AMBER;
      buy.style.color = '#10131a';
      buy.style.border = 'none';
      const afford = (wallet?.balance ?? 0) >= price;
      buy.disabled = line.stock <= 0 || !afford;
      if (buy.disabled) { buy.style.opacity = '0.45'; buy.style.cursor = 'default'; }
      buy.setAttribute('aria-label', `Buy ${name} for ${price} ${CURRENCY_NAME}`);
      buy.addEventListener('click', () => this.buy(line));
      row.append(info, buy);
      this.listEl.append(row);
    }
  }

  private renderSell(vendorDef: VendorDef | undefined, defs: Record<string, ItemDef>): void {
    const doc = this.opts.doc ?? globalThis.document;
    const inv = this.opts.inventory();
    const sellMult = vendorDef?.sellMult ?? 0.3;
    const rows: Array<{ itemId: string; count: number; def: ItemDef }> = [];
    if (inv) {
      for (const s of inv.getBackpack()) {
        if (!s) continue;
        const def = defs[s.itemId];
        if (isSellable(def) && !rows.some((r) => r.itemId === s.itemId)) {
          rows.push({ itemId: s.itemId, count: inv.count(s.itemId), def: def! });
        }
      }
    }
    if (rows.length === 0) {
      this.listEl.append(el(doc, 'div', `font-size:13px;color:${DIM};padding:12px`, 'Nothing to sell — loot the wastes, then come back.'));
      return;
    }
    for (const r of rows) {
      // factions-reputation wave: the standing factor applies AFTER
      // unitSellPrice (sellMult already inside it).
      const price = effectiveSellPrice(unitSellPrice(r.def, sellMult), this.standingFor(this.vendor?.vendorId ?? ''));
      const color = r.def.rarity ? (RARITY_COLORS[r.def.rarity] ?? TEXT) : TEXT;
      const row = el(doc, 'div', [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:6px 8px', 'border:1px solid rgba(154,164,184,0.18)', 'border-radius:8px',
      ].join(';'));
      const info = el(doc, 'div', 'display:flex;flex-direction:column;gap:1px;flex:1;min-width:0');
      info.append(
        el(doc, 'div', `font-size:13px;font-weight:700;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`, `${r.def.name} ×${r.count}`),
        el(doc, 'div', `font-size:11px;color:${DIM}`, `${price} ${CURRENCY_NAME} each`),
      );
      const sell = el(doc, 'button', BTN_CSS, 'SELL') as HTMLButtonElement;
      sell.style.background = 'transparent';
      sell.style.color = GOOD;
      sell.style.border = `1px solid ${GOOD}66`;
      sell.setAttribute('aria-label', `Sell one ${r.def.name} for ${price} ${CURRENCY_NAME}`);
      sell.addEventListener('click', () => this.sell(r.itemId, price));
      row.append(info, sell);
      this.listEl.append(row);
    }
  }

  /** Standing for the open vendor's faction (0 when unwired). */
  private standingFor(vendorId: string): number {
    try {
      const v = this.opts.standingOf?.(vendorId) ?? 0;
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  /** Effective buy price for a stock line at the open vendor. */
  private effectiveBuy(line: VendorStockEntry, vendorId: string): number {
    return effectiveBuyPrice(line.price, this.standingFor(vendorId));
  }

  /** Buy one unit of a stock line. Atomic: a full backpack refunds the spend. */
  buy(line: VendorStockEntry): void {
    const inv = this.opts.inventory();
    const wallet = this.opts.wallet();
    if (!inv || !wallet) return;
    if (line.stock <= 0) return;
    // factions-reputation wave: the price is computed at click time
    // from the live standing (the render-time figure is the same value
    // unless standing moved while the panel was open). At neutral the
    // factor is exactly 1, so legacy callers see line.price.
    const price = this.vendor ? this.effectiveBuy(line, this.vendor.vendorId) : line.price;
    if (!wallet.spend(price)) {
      this.opts.toast?.(`Not enough ${CURRENCY_NAME}.`);
      return;
    }
    const leftover = inv.add(line.itemId, 1);
    if (leftover > 0) {
      wallet.add(price); // refund — the backpack had no room
      this.opts.toast?.('Backpack full.');
      this.render();
      return;
    }
    line.stock -= 1;
    this.opts.toast?.(`Bought ${this.opts.defs()[line.itemId]?.name ?? line.itemId}.`);
    if (this.vendor) {
      try { this.opts.onTrade?.(this.vendor.vendorId, 'buy'); } catch (e) { console.warn('[shop] onTrade threw', e); }
    }
    this.render();
  }

  /** Sell one unit from the backpack into the wallet. */
  sell(itemId: string, unitPrice: number): void {
    const inv = this.opts.inventory();
    const wallet = this.opts.wallet();
    if (!inv || !wallet) return;
    if (inv.remove(itemId, 1) === 1) {
      wallet.add(unitPrice);
      this.opts.toast?.(`Sold for ${unitPrice} ${CURRENCY_NAME}.`);
      if (this.vendor) {
        try { this.opts.onTrade?.(this.vendor.vendorId, 'sell'); } catch (e) { console.warn('[shop] onTrade threw', e); }
      }
      this.render();
    }
  }
}
