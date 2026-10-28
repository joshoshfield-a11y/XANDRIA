/**
 * UPGRADE LOOP (player-camp): the camp panel — build structures, use the
 * storage chest, rest, activate the workbench buff.
 *
 * DOM panel (follows the TradePanel pattern): re-renders on every open
 * and after every action. Presentation-only — the caller (the camp
 * session) decides what build/deposit/withdraw/rest/buff do. Esc closes;
 * `isOpen` chains into the modal arbitration.
 *
 * Buttons carry data-action attributes + stable ids so e2e can click the
 * real UI path: #xandria-camp-build-<id>, #xandria-camp-deposit-<item>,
 * #xandria-camp-withdraw-<item>, #xandria-camp-rest,
 * #xandria-camp-workbench.
 */
import type { CampStructureDef } from '../game/camp';

export interface CampPanelSource {
  structures: () => readonly CampStructureDef[];
  built: () => Set<string>;
  inventoryCount: (itemId: string) => number;
  chestContents: () => Record<string, number>;
  backpackItems: () => string[];
  defName: (itemId: string) => string;
  buffRemaining: () => number;
  /** camp-upgrades: current upgrade tier of a structure (0 = base build) */
  tierOf: (id: string) => number;
  /** camp-upgrades: highest upgrade tier a structure supports */
  maxTier: (id: string) => number;
  /** camp-upgrades: short current-tier effect text for a structure */
  tierEffect: (id: string) => string;
  /** camp-upgrades: next tier's cost as "have/need" text ('' at max tier) */
  nextTierCost: (id: string) => string;
  /** camp-upgrades: chest capacity in total stored units */
  chestCapacity: () => number;
  /** camp-upgrades: units currently stored in the chest */
  chestUsed: () => number;
  /** camp-upgrades: seconds of rested bonus remaining (0 when inactive) */
  restedRemaining: () => number;
  /** camp-upgrades: upgrade one structure a tier; failure reason or null */
  onUpgrade: (id: string) => string | null;
  /** build one structure; returns the failure reason or null on success */
  onBuild: (id: string) => string | null;
  /** deposit n units; returns units actually moved */
  onDeposit: (itemId: string, count: number) => number;
  /** withdraw n units; returns units actually moved */
  onWithdraw: (itemId: string, count: number) => number;
  /** rest; returns the failure reason or null on success */
  onRest: () => string | null;
  /** activate the workbench buff; returns the failure reason or null */
  onActivateBuff: () => string | null;
}

const BTN = 'min-height:28px;padding:6px 12px;border-radius:6px;cursor:pointer;font-family:inherit';
const ROW = 'display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px';
const HEAD = 'font-size:12px;font-weight:700;letter-spacing:0.1em;opacity:0.75;margin-bottom:6px';
const NOTE = 'font-size:13px;opacity:0.6';

export class CampPanel {
  private root: HTMLDivElement;
  private bodyEl: HTMLDivElement;
  private msgEl: HTMLDivElement;
  private summaryEl: HTMLDivElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;

  constructor(
    private container: HTMLElement,
    private source: CampPanelSource,
    private doc: Document = globalThis.document,
  ) {
    const root = doc.createElement('div');
    root.id = 'xandria-camp-panel';
    root.setAttribute('role', 'dialog');
    root.style.cssText = [
      'position:absolute', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
      'z-index:9500', 'min-width:300px', 'max-width:min(480px,94vw)', 'max-height:82vh',
      'overflow-y:auto', 'background:rgba(8,10,16,0.95)',
      'border:1px solid rgba(74,222,128,0.45)', 'border-radius:10px',
      'padding:14px 16px 12px', 'font-family:system-ui,-apple-system,sans-serif',
      'color:#e8ecf4', 'box-shadow:0 8px 32px rgba(0,0,0,0.55)', 'display:none',
    ].join(';');

    const title = doc.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:700;color:#4ade80;margin-bottom:2px';
    title.textContent = 'Camp';

    const sub = doc.createElement('div');
    sub.style.cssText = 'font-size:12px;opacity:0.7;margin-bottom:10px';
    sub.textContent = 'One camp per map. Structures persist on this map; the chest follows you everywhere.';

    const body = doc.createElement('div');
    const msg = doc.createElement('div');
    msg.style.cssText = 'font-size:13px;color:#ffcf7a;min-height:18px;margin-bottom:6px';
    // camp-upgrades: tier indicator — one line, every structure's tier.
    const summary = doc.createElement('div');
    summary.id = 'xandria-camp-tier-summary';
    summary.style.cssText = 'font-size:12px;color:#4ade80;margin-bottom:10px';

    const close = doc.createElement('button');
    close.textContent = 'Leave  (Esc)';
    close.style.cssText = `${BTN};background:transparent;color:#9aa4b8;border:1px solid rgba(154,164,184,0.4)`;
    close.addEventListener('click', () => this.hide());

    root.append(title, sub, summary, msg, body, close);
    container.appendChild(root);
    this.root = root as HTMLDivElement;
    this.bodyEl = body as HTMLDivElement;
    this.msgEl = msg as HTMLDivElement;
    this.summaryEl = summary as HTMLDivElement;

    this.onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.open_) this.hide();
    };
    doc.addEventListener('keydown', this.onKey);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Open (and re-render) the panel. */
  open(): void {
    this.render();
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

  private setMsg(text: string): void {
    this.msgEl.textContent = text;
  }

  private section(title: string): HTMLDivElement {
    const h = this.doc.createElement('div');
    h.textContent = title;
    h.style.cssText = HEAD;
    return h as HTMLDivElement;
  }

  private button(label: string, disabled: boolean, id?: string): HTMLButtonElement {
    const b = this.doc.createElement('button');
    b.textContent = label;
    b.disabled = disabled;
    if (id) b.id = id;
    b.style.cssText = `${BTN};background:rgba(74,222,128,0.12);color:#4ade80;border:1px solid rgba(74,222,128,0.4)`;
    return b as HTMLButtonElement;
  }

  private render(): void {
    const s = this.source;
    const built = s.built();
    this.bodyEl.replaceChildren();
    this.setMsg('');

    // camp-upgrades: tier indicator line (also the e2e-readable summary).
    this.summaryEl.textContent = s.structures().map((def) => {
      const isBuilt = built.has(def.id);
      const tier = s.tierOf(def.id);
      const max = s.maxTier(def.id);
      return isBuilt ? `${def.name}: Tier ${tier}/${max}` : `${def.name}: not built`;
    }).join(' · ');

    // --- BUILD ---
    this.bodyEl.appendChild(this.section('BUILD'));
    const buildEl = this.doc.createElement('div');
    buildEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px';
    for (const def of s.structures()) {
      const row = this.doc.createElement('div');
      row.style.cssText = ROW;
      const isBuilt = built.has(def.id);
      const tier = s.tierOf(def.id);
      const max = s.maxTier(def.id);
      const costText = def.cost.map((c) => `${s.defName(c.itemId)} ${s.inventoryCount(c.itemId)}/${c.count}`).join(' · ');
      const label = this.doc.createElement('span');
      label.textContent = isBuilt
        ? `${def.name} [Tier ${tier}/${max}] — ${s.tierEffect(def.id)} [${costText}]`
        : `${def.name} — ${def.desc} [${costText}]`;
      let btn: HTMLButtonElement;
      if (!isBuilt) {
        btn = this.button('Build', false, `xandria-camp-build-${def.id}`);
        btn.addEventListener('click', () => {
          const err = s.onBuild(def.id);
          if (err) this.setMsg(err);
          this.render();
        });
      } else if (tier < max) {
        // camp-upgrades: upgrade path — cost shown is the NEXT tier's
        // cost, read live from the tier table via the session's counts.
        const nextCost = s.nextTierCost(def.id);
        const upLabel = this.doc.createElement('span');
        upLabel.textContent = `Next tier: ${nextCost}`;
        upLabel.style.cssText = 'font-size:12px;opacity:0.75';
        btn = this.button(`Upgrade → Tier ${tier + 1}`, false, `xandria-camp-upgrade-${def.id}`);
        btn.addEventListener('click', () => {
          const err = s.onUpgrade(def.id);
          if (err) this.setMsg(err);
          this.render();
        });
        const btnCol = this.doc.createElement('span');
        btnCol.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:2px';
        btnCol.append(upLabel, btn);
        row.append(label, btnCol);
        buildEl.appendChild(row);
        continue;
      } else {
        btn = this.button('Max tier', true, `xandria-camp-upgrade-${def.id}`);
      }
      row.append(label, btn);
      buildEl.appendChild(row);
    }
    this.bodyEl.appendChild(buildEl);

    // --- STORAGE ---
    this.bodyEl.appendChild(this.section(built.has('chest')
      ? `STORAGE CHEST (${s.chestUsed()}/${s.chestCapacity()})`
      : 'STORAGE CHEST'));
    const storeEl = this.doc.createElement('div');
    storeEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px';
    if (!built.has('chest')) {
      const empty = this.doc.createElement('div');
      empty.style.cssText = NOTE;
      empty.textContent = 'Build the storage chest to store items.';
      storeEl.appendChild(empty);
    } else {
      const chest = s.chestContents();
      const chestIds = Object.keys(chest).filter((id) => chest[id] > 0);
      if (chestIds.length === 0) {
        const empty = this.doc.createElement('div');
        empty.style.cssText = NOTE;
        empty.textContent = 'Chest is empty.';
        storeEl.appendChild(empty);
      }
      for (const id of chestIds) {
        const row = this.doc.createElement('div');
        row.style.cssText = ROW;
        const label = this.doc.createElement('span');
        label.textContent = `${s.defName(id)} ×${chest[id]} (in chest)`;
        const btns = this.doc.createElement('span');
        btns.style.cssText = 'display:flex;gap:6px';
        const w1 = this.button('Take 1', false, `xandria-camp-withdraw-${id}`);
        w1.addEventListener('click', () => { s.onWithdraw(id, 1); this.render(); });
        const wall = this.button('Take all', false);
        wall.addEventListener('click', () => { s.onWithdraw(id, chest[id]); this.render(); });
        btns.append(w1, wall);
        row.append(label, btns);
        storeEl.appendChild(row);
      }
      const packIds = s.backpackItems().filter((id) => s.inventoryCount(id) > 0);
      for (const id of packIds) {
        const row = this.doc.createElement('div');
        row.style.cssText = ROW;
        const label = this.doc.createElement('span');
        label.textContent = `${s.defName(id)} ×${s.inventoryCount(id)} (backpack)`;
        const btns = this.doc.createElement('span');
        btns.style.cssText = 'display:flex;gap:6px';
        const d1 = this.button('Store 1', false, `xandria-camp-deposit-${id}`);
        d1.addEventListener('click', () => { s.onDeposit(id, 1); this.render(); });
        const dall = this.button('Store all', false);
        dall.addEventListener('click', () => { s.onDeposit(id, s.inventoryCount(id)); this.render(); });
        btns.append(d1, dall);
        row.append(label, btns);
        storeEl.appendChild(row);
      }
    }
    this.bodyEl.appendChild(storeEl);

    // --- REST ---
    this.bodyEl.appendChild(this.section('REST'));
    const restEl = this.doc.createElement('div');
    restEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px';
    const restRow = this.doc.createElement('div');
    restRow.style.cssText = ROW;
    const restLabel = this.doc.createElement('span');
    const rested = s.restedRemaining();
    restLabel.textContent = rested > 0
      ? `Rested bonus active for ${Math.ceil(rested)}s more.`
      : built.has('rest') ? `Rest — ${s.tierEffect('rest')}.` : 'Build the rest point to rest here.';
    const restBtn = this.button('Rest', !built.has('rest'), 'xandria-camp-rest');
    restBtn.addEventListener('click', () => {
      const err = s.onRest();
      if (err) this.setMsg(err);
      else this.setMsg('Rested — HP fully restored.');
      this.render();
    });
    restRow.append(restLabel, restBtn);
    restEl.appendChild(restRow);
    this.bodyEl.appendChild(restEl);

    // --- WORKBENCH ---
    this.bodyEl.appendChild(this.section('WORKBENCH'));
    const wbEl = this.doc.createElement('div');
    wbEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:10px';
    const wbRow = this.doc.createElement('div');
    wbRow.style.cssText = ROW;
    const remaining = s.buffRemaining();
    const wbLabel = this.doc.createElement('span');
    wbLabel.textContent = remaining > 0
      ? `Sharpened — ${s.tierEffect('workbench')} for ${Math.ceil(remaining)}s more.`
      : built.has('workbench') ? `Sharpen tools: ${s.tierEffect('workbench')}.` : 'Build the workbench to sharpen tools.';
    const wbBtn = this.button('Sharpen', !built.has('workbench'), 'xandria-camp-workbench');
    wbBtn.addEventListener('click', () => {
      const err = s.onActivateBuff();
      if (err) this.setMsg(err);
      this.render();
    });
    wbRow.append(wbLabel, wbBtn);
    wbEl.appendChild(wbRow);
    this.bodyEl.appendChild(wbEl);
  }
}
