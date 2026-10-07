/**
 * QA X4 — the cover pixel font covers Latin-1 accented capitals (À–Þ);
 * CJK and other scripts still fall back to '?'.
 */
import { describe, it, expect } from 'vitest';
import { glyphFor } from '../scripts/cover';

const LATIN1_ACCENTED = 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ';

describe('cover pixel font', () => {
  it('renders every Latin-1 accented capital as a real glyph, not "?"', () => {
    for (const ch of LATIN1_ACCENTED) {
      const g = glyphFor(ch);
      expect(g, ch).not.toBe(glyphFor('?'));
      expect(g, ch).toHaveLength(7);
      for (const row of g) {
        expect(row, `${ch} row`).toMatch(/^[01]{5}$/);
      }
      // not blank: an accented letter must have ink
      expect(g.join(''), ch).toContain('1');
    }
  });

  it('accented glyphs share the base letter body (accent on top rows)', () => {
    // É = acute mark over E's lower 5 rows
    const e = glyphFor('É');
    expect(e.slice(0, 2)).toEqual(['00010', '00100']);
    expect(e.slice(2)).toEqual(glyphFor('E').slice(2));
  });

  it('non-Latin scripts still fall back to "?" (documented limitation)', () => {
    for (const ch of ['日', '本', '語', '☃', 'Ω', '中']) {
      expect(glyphFor(ch)).toBe(glyphFor('?'));
    }
    // lowercase accented input works via the title's toUpperCase() in text()
    expect(glyphFor('é'.toUpperCase())).not.toBe(glyphFor('?'));
  });
});
