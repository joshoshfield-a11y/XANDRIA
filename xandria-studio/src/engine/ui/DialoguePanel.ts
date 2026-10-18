/**
 * NPCs wave (workstream C): the dialogue STUB panel — name + one seeded
 * greeting line + dismiss. No trees, no state machines (those are the
 * quest wave's job); `requires`/`produces` stay reserved.
 *
 * DOM pattern follows PortalTransitionOverlay (absolute in the engine
 * container, self-contained styles, no pointer-events leaks): the panel
 * blocks pointer input while open so clicks don't fight the game, and the
 * key handler dismisses on Escape or E. The `doc` param is injectable so
 * unit tests can pass a minimal DOM stub.
 */
export interface DialogueLine {
  name: string;
  role?: string;
  greeting: string;
}

export class DialoguePanel {
  private root: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private lineEl: HTMLDivElement;
  private onKey: (e: KeyboardEvent) => void;
  private disposed = false;
  private open_ = false;

  constructor(
    private container: HTMLElement,
    private doc: Document = globalThis.document,
  ) {
    const root = doc.createElement('div');
    root.id = 'xandria-dialogue-panel';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-live', 'polite');
    root.style.cssText = [
      'position:absolute', 'left:50%', 'bottom:12%', 'transform:translateX(-50%)',
      'z-index:9500', 'min-width:280px', 'max-width:min(480px,86%)',
      'background:rgba(8,10,16,0.94)', 'border:1px solid rgba(255,181,69,0.45)',
      'border-radius:10px', 'padding:14px 18px 12px',
      'font-family:system-ui,-apple-system,sans-serif', 'color:#e8ecf4',
      'box-shadow:0 8px 32px rgba(0,0,0,0.55)',
      'display:none',
    ].join(';');

    const name = doc.createElement('div');
    name.style.cssText = 'font-size:15px;font-weight:700;color:#ffcf7a;letter-spacing:0.04em;margin-bottom:6px';

    const line = doc.createElement('div');
    line.style.cssText = 'font-size:14px;line-height:1.5;opacity:0.92;font-style:italic';

    const dismiss = doc.createElement('button');
    dismiss.textContent = 'Goodbye  (E)';
    dismiss.style.cssText = [
      'margin-top:10px', 'background:transparent', 'color:#9aa4b8',
      'border:1px solid rgba(154,164,184,0.4)', 'border-radius:6px',
      'padding:5px 12px', 'font-size:12px', 'cursor:pointer',
      'font-family:inherit',
    ].join(';');
    dismiss.addEventListener('click', () => this.hide());

    root.append(name, line, dismiss);
    container.appendChild(root);
    this.root = root as HTMLDivElement;
    this.nameEl = name as HTMLDivElement;
    this.lineEl = line as HTMLDivElement;

    // Capture phase: the panel owns E/Escape while open, so the
    // blueprint key handlers (bubble phase) never see them.
    this.onKey = (e: KeyboardEvent) => {
      if (!this.open_) return;
      if (e.code === 'Escape' || e.code === 'KeyE') {
        e.stopPropagation();
        e.preventDefault();
        this.hide();
      }
    };
    // `window` may not exist in the DOM-stub test harness.
    const w = (doc as Document & { defaultView?: Window }).defaultView ?? globalThis.window;
    w?.addEventListener('keydown', this.onKey, true);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Show the stub for one NPC. Re-opening swaps the content in place. */
  show(line: DialogueLine): void {
    if (this.disposed) return;
    this.nameEl.textContent = line.role ? `${line.name} — ${line.role}` : line.name;
    this.lineEl.textContent = `\u201c${line.greeting}\u201d`;
    this.root.style.display = 'block';
    this.open_ = true;
  }

  hide(): void {
    if (this.disposed) return;
    this.root.style.display = 'none';
    this.open_ = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    const w = (this.doc as Document & { defaultView?: Window }).defaultView ?? (globalThis as any).window;
    w?.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }
}
