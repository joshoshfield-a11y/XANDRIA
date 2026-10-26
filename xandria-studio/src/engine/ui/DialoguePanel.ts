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

/**
 * Quest wave: optional quest action buttons rendered under the dialogue
 * line (Accept / Turn in). The panel stays presentation-only — the caller
 * (QuestTalkSession) decides which actions exist and handles the clicks.
 */
export interface DialogueQuestAction {
  /** opaque id handed back to onAction, e.g. 'accept:quest_story_1_first_blood' */
  id: string;
  /** button label, e.g. 'Accept: First Blood' */
  label: string;
}

export class DialoguePanel {
  private root: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private lineEl: HTMLDivElement;
  private actionsEl: HTMLDivElement;
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
      // Radiant-quests wave: the action list grows with every quest wave
      // (story + side + radiant offers), and an uncapped panel overflows
      // the viewport top on 720p — the first Accept button lands off-screen
      // and no click can reach it. Cap + scroll instead of overflowing.
      'max-height:80vh', 'overflow-y:auto',
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
      // HUD-polish wave: touch-target floor is 28px (skills-wave precedent).
      'padding:7px 14px', 'font-size:12px', 'cursor:pointer',
      'font-family:inherit',
    ].join(';');
    dismiss.addEventListener('click', () => this.hide());

    const actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px';

    root.append(name, line, actions, dismiss);
    container.appendChild(root);
    this.root = root as HTMLDivElement;
    this.nameEl = name as HTMLDivElement;
    this.lineEl = line as HTMLDivElement;
    this.actionsEl = actions as HTMLDivElement;

    // Capture phase: the panel owns E/Escape while open, so the
    // blueprint key handlers (bubble phase) never see them.
    // stopImmediatePropagation (not stopPropagation): the interaction
    // prompts register their own window-capture KeyE handlers, and the
    // quest prompt's is registered AFTER this one — with plain
    // stopPropagation it would still run, see isModalOpen===false (we just
    // hid), and synchronously reopen the dialogue on the same keypress.
    this.onKey = (e: KeyboardEvent) => {
      if (!this.open_) return;
      if (e.code === 'Escape' || e.code === 'KeyE') {
        e.stopImmediatePropagation();
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
  show(line: DialogueLine, actions?: DialogueQuestAction[], onAction?: (id: string) => void): void {
    if (this.disposed) return;
    this.nameEl.textContent = line.role ? `${line.name} — ${line.role}` : line.name;
    this.lineEl.textContent = `\u201c${line.greeting}\u201d`;
    // quest actions (rebuilt every show — no stale buttons)
    while (this.actionsEl.firstChild) this.actionsEl.firstChild.remove();
    for (const a of actions ?? []) {
      const btn = this.doc.createElement('button') as HTMLButtonElement;
      btn.textContent = a.label;
      btn.setAttribute('data-quest-action', a.id);
      btn.style.cssText = [
        'background:rgba(255,181,69,0.12)', 'color:#ffcf7a',
        'border:1px solid rgba(255,181,69,0.55)', 'border-radius:6px',
        'padding:7px 12px', 'font-size:13px', 'font-weight:600',
        'cursor:pointer', 'font-family:inherit', 'text-align:left',
      ].join(';');
      const id = a.id;
      btn.addEventListener('click', () => onAction?.(id));
      this.actionsEl.append(btn);
    }
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
