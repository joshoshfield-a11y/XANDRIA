/**
 * Dynamic-events wave: the wandering merchant's barter trade panel.
 *
 * DOM panel (follows the DialoguePanel pattern): BUY lines from the
 * merchant's seeded stock (price in the def's trade-good material) and a
 * SELL section listing the player's backpack items for trade goods.
 * Presentation-only — the caller (DynamicEventManager) decides what
 * buy/sell do. Esc closes; `isOpen` chains into the modal arbitration.
 */
import type { ItemDef } from '@spec';
import type { MerchantStockLine } from '../game/dynamicEvents';

export interface TradePanelInventory {
  count(itemId: string): number;
  /** distinct item ids currently in the backpack. */
  listItems(): string[];
}

export interface TradePanelCallbacks {
  /** buy one unit; returns the failure reason or null on success. */
  onBuy: (itemId: string) => string | null;
  /** sell one unit; returns granted trade-good count (0 = nothing sold). */
  onSell: (itemId: string) => number;
}

const BTN = 'min-height:28px;padding:6px 12px;border-radius:6px;cursor:pointer;font-family:inherit';

export class TradePanel {
  private root: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private buyEl: HTMLDivElement;
  private sellEl: HTMLDivElement;
  private balanceEl: HTMLDivElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;
  private defId = '';
  private index = 0;

  constructor(
    private container: HTMLElement,
    private doc: Document = globalThis.document,
  ) {
    const root = doc.createElement('div');
    root.id = 'xandria-trade-panel';
    root.setAttribute('role', 'dialog');
    root.style.cssText = [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9500', 'min-width:300px', 'max-width:min(460px,94vw)', 'max-height:82vh',
      'overflow-y:auto', 'background:rgba(8,10,16,0.95)',
      'border:1px solid rgba(255,207,122,0.45)', 'border-radius:10px',
      'padding:14px 16px 12px', 'font-family:system-ui,-apple-system,sans-serif',
      'color:#e8ecf4', 'box-shadow:0 8px 32px rgba(0,0,0,0.55)', 'display:none',
    ].join(';');

    const title = doc.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:700;color:#ffcf7a;margin-bottom:2px';

    const sub = doc.createElement('div');
    sub.style.cssText = 'font-size:12px;opacity:0.7;margin-bottom:10px';
    sub.textContent = 'Barter only — no scrap on this map.';

    const balance = doc.createElement('div');
    balance.style.cssText = 'font-size:13px;margin-bottom:10px';

    const buyH = doc.createElement('div');
    buyH.textContent = 'BUY';
    buyH.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:0.1em;opacity:0.75;margin-bottom:6px';
    const buy = doc.createElement('div');
    buy.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px';

    const sellH = doc.createElement('div');
    sellH.textContent = 'SELL';
    sellH.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:0.1em;opacity:0.75;margin-bottom:6px';
    const sell = doc.createElement('div');
    sell.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:10px';

    const close = doc.createElement('button');
    close.textContent = 'Leave  (Esc)';
    close.style.cssText = `${BTN};background:transparent;color:#9aa4b8;border:1px solid rgba(154,164,184,0.4)`;
    close.addEventListener('click', () => this.hide());

    root.append(title, sub, balance, buyH, buy, sellH, sell, close);
    container.appendChild(root);
    this.root = root as HTMLDivElement;
    this.titleEl = title as HTMLDivElement;
    this.buyEl = buy as HTMLDivElement;
    this.sellEl = sell as HTMLDivElement;
    this.balanceEl = balance as HTMLDivElement;

    this.onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Escape' || e.key === 'e' || e.key === 'E') && this.open_) this.hide();
    };
    doc.addEventListener('keydown', this.onKey);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /**
   * Show the panel for a merchant instance. Re-renders stock on every
   * open and after every transaction.
   */
  show(
    merchantName: string,
    defId: string,
    index: number,
    stock: MerchantStockLine[],
    tradeGoodId: string,
    tradeGoodName: string,
    defs: Record<string, ItemDef>,
    inventory: TradePanelInventory,
    cb: TradePanelCallbacks,
  ): void {
    this.defId = defId;
    this.index = index;
    this.titleEl.textContent = `${merchantName} — trader`;
    const render = () => {
      this.balanceEl.textContent = `${tradeGoodName}: ${inventory.count(tradeGoodId)}`;
      this.buyEl.replaceChildren();
      for (const line of stock) {
        const def = defs[line.itemId];
        const row = this.doc.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px';
        const label = this.doc.createElement('span');
        label.textContent = `${def?.name ?? line.itemId}${line.count > 1 ? ` ×${line.count}` : ''} — ${line.cost} ${tradeGoodName}`;
        const btn = this.doc.createElement('button');
        btn.textContent = line.count > 0 ? 'Buy' : 'Sold';
        btn.disabled = line.count <= 0;
        btn.style.cssText = `${BTN};background:rgba(255,207,122,0.12);color:#ffcf7a;border:1px solid rgba(255,207,122,0.4)`;
        btn.addEventListener('click', () => {
          const err = cb.onBuy(line.itemId);
          if (err === 'cant-afford') label.textContent += ' (need more ' + tradeGoodName + ')';
          else if (err === 'no-room') label.textContent += ' (backpack full)';
          render();
        });
        row.append(label, btn);
        this.buyEl.appendChild(row);
      }
      if (stock.length === 0) {
        const empty = this.doc.createElement('div');
        empty.style.cssText = 'font-size:13px;opacity:0.6';
        empty.textContent = 'Nothing left to sell.';
        this.buyEl.appendChild(empty);
      }
      this.sellEl.replaceChildren();
      let anySell = false;
      for (const itemId of inventory.listItems()) {
        if (itemId === tradeGoodId) continue;
        const def = defs[itemId];
        const n = inventory.count(itemId);
        if (n <= 0) continue;
        anySell = true;
        const row = this.doc.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px';
        const label = this.doc.createElement('span');
        label.textContent = `${def?.name ?? itemId} ×${n}`;
        const btn = this.doc.createElement('button');
        btn.textContent = 'Sell';
        btn.style.cssText = `${BTN};background:transparent;color:#9aa4b8;border:1px solid rgba(154,164,184,0.4)`;
        btn.addEventListener('click', () => {
          const got = cb.onSell(itemId);
          if (got > 0) label.textContent += ` (+${got} ${tradeGoodName})`;
          render();
        });
        row.append(label, btn);
        this.sellEl.appendChild(row);
      }
      if (!anySell) {
        const empty = this.doc.createElement('div');
        empty.style.cssText = 'font-size:13px;opacity:0.6';
        empty.textContent = 'Backpack is empty.';
        this.sellEl.appendChild(empty);
      }
    };
    render();
    this.root.style.display = 'block';
    this.open_ = true;
  }

  hide(): void {
    this.root.style.display = 'none';
    this.open_ = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.doc.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
