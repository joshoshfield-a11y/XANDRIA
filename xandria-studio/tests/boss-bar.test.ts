/**
 * Boss-fights wave: BossBar unit tests (fake DOM, crafting-panel pattern).
 * - show/hide lifecycle
 * - setHealth / setPhase write the DOM only when the value actually changed
 *   (zero per-frame DOM cost when idle)
 * - hide resets the change cache
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BossBar } from '../src/engine/ui/BossBar';

interface FakeEl {
  tag: string;
  children: FakeEl[];
  style: Record<string, string> & { _writes: number };
  textContent: string;
  className: string;
  id: string;
  parentNode: FakeEl | null;
  appendChild(c: FakeEl): FakeEl;
  append(...cs: FakeEl[]): void;
  setAttribute(k: string, v: string): void;
  remove(): void;
}

function makeEl(tag = 'div'): FakeEl {
  const el: FakeEl = {
    tag,
    children: [],
    style: new Proxy({ _writes: 0 } as Record<string, string | number>, {
      set(t, p, v) {
        if (p !== '_writes') (t as Record<string, number>)._writes++;
        (t as Record<string, unknown>)[p as string] = v;
        return true;
      },
      get(t, p) { return (t as Record<string, unknown>)[p as string]; },
    }) as unknown as FakeEl['style'],
    textContent: '',
    className: '',
    id: '',
    parentNode: null,
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    append(...cs) { for (const c of cs) el.appendChild(c); },
    setAttribute() {},
    remove() {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el);
        if (i >= 0) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      }
    },
  };
  return el;
}

function makeDoc() {
  const created: FakeEl[] = [];
  return {
    created,
    createElement: (tag: string) => {
      const e = makeEl(tag);
      created.push(e);
      return e;
    },
  } as unknown as Document;
}

describe('BossBar', () => {
  let container: FakeEl;
  let doc: Document;
  let bar: BossBar;

  beforeEach(() => {
    container = makeEl('div');
    doc = makeDoc();
    bar = new BossBar(container as unknown as HTMLElement, doc);
  });

  it('starts hidden and shows on demand', () => {
    const root = (doc as unknown as { created: FakeEl[] }).created[0];
    // initial hidden state lives in the cssText (like QuestTracker's el())
    expect(root.style.cssText).toContain('display:none');
    expect(bar.isVisible).toBe(false);
    bar.show('THE WARDEN');
    expect(root.style.display).toBe('block');
    expect(bar.isVisible).toBe(true);
    bar.hide();
    expect(root.style.display).toBe('none');
    expect(bar.isVisible).toBe(false);
  });

  it('setHealth writes the DOM only when the quantized value moves', () => {
    bar.show('THE WARDEN');
    const root = (doc as unknown as { created: FakeEl[] }).created[0];
    const fill = root.children[1].children[0]; // track > fill
    const writes0 = fill.style._writes;
    bar.setHealth(1);
    expect(fill.style._writes).toBeGreaterThan(writes0);
    expect(fill.style.width).toBe('100%');
    const writes1 = fill.style._writes;
    bar.setHealth(1); // identical — no write
    bar.setHealth(0.99996); // quantizes to the same 0.1% — no write
    expect(fill.style._writes).toBe(writes1);
    bar.setHealth(0.5);
    expect(fill.style.width).toBe('50%');
    expect(fill.style._writes).toBeGreaterThan(writes1);
  });

  it('setHealth clamps and ignores writes while hidden', () => {
    const root = (doc as unknown as { created: FakeEl[] }).created[0];
    const fill = root.children[1].children[0];
    const writes0 = fill.style._writes;
    bar.setHealth(0.5); // hidden — no DOM cost at all
    expect(fill.style._writes).toBe(writes0);
    bar.show('X');
    bar.setHealth(2);
    expect(fill.style.width).toBe('100%');
    bar.setHealth(-1);
    expect(fill.style.width).toBe('0%');
  });

  it('setPhase writes only on change and uppercases', () => {
    bar.show('THE WARDEN');
    const root = (doc as unknown as { created: FakeEl[] }).created[0];
    const phase = root.children[2];
    bar.setPhase('Enraged');
    expect(phase.textContent).toBe('ENRAGED');
    const text = phase.textContent;
    bar.setPhase('Enraged'); // same — textContent untouched
    expect(phase.textContent).toBe(text);
    bar.setPhase('Desperate');
    expect(phase.textContent).toBe('DESPERATE');
  });

  it('a second bar on the same container disposes its predecessor (one live #xandria-boss-bar)', () => {
    const roots = () =>
      (doc as unknown as { created: FakeEl[] }).created.filter((e) => e.id === 'xandria-boss-bar');
    const first = new BossBar(container as unknown as HTMLElement, doc);
    first.show('THE WARDEN');
    expect(first.isVisible).toBe(true);
    const firstRoot = roots().at(-1)!;
    const second = new BossBar(container as unknown as HTMLElement, doc);
    // predecessor's node is gone and its methods are silenced…
    expect(container.children).not.toContain(firstRoot);
    first.show('EMBER TITAN'); // no-op: name stays as it was
    expect((firstRoot.children[0] as FakeEl).textContent).toBe('THE WARDEN');
    // …while the newcomer works normally
    second.show('EMBER TITAN');
    expect(second.isVisible).toBe(true);
    const secondRoot = roots().at(-1)!;
    expect(container.children).toContain(secondRoot);
    expect((secondRoot.children[0] as FakeEl).textContent).toBe('EMBER TITAN');
  });

  it('dispose removes the root and silences later calls', () => {
    const root = (doc as unknown as { created: FakeEl[] }).created[0];
    bar.show('THE WARDEN');
    bar.dispose();
    expect(container.children).not.toContain(root);
    expect(() => bar.setHealth(0.5)).not.toThrow();
    expect(() => bar.hide()).not.toThrow();
  });
});
