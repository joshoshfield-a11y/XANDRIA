/**
 * QA N9 — validator errors embed raw spec strings (stage ids, descriptions)
 * and load errors echo project-file content. Both reach errBox via
 * innerHTML, so the escaping primitive must neutralize markup payloads.
 * (The panel itself needs DOM and has no test harness; the pure helpers
 * it relies on are tested here.)
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, errorRowHtml } from '../src/studio/editor/editorPanel';

describe('escapeHtml', () => {
  it('neutralizes tag injection', () => {
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('neutralizes event-handler attributes', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('escapes quotes and ampersands', () => {
    expect(escapeHtml(`" onmouseover="alert(1)`))
      .toBe('&quot; onmouseover=&quot;alert(1)');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('leaves plain text alone apart from markup chars', () => {
    expect(escapeHtml('objective.stages[0].count must be >= 1'))
      .toBe('objective.stages[0].count must be &gt;= 1');
  });
});

describe('errorRowHtml', () => {
  it('bolds the path and escapes both halves', () => {
    const row = errorRowHtml('objective.stages[0]: <img src=x onerror=alert(1)>');
    expect(row).toBe(
      '<div class="xed-err"><b>objective.stages[0]</b>: &lt;img src=x onerror=alert(1)&gt;</div>',
    );
  });

  it('escapes a malicious stage id in the path half', () => {
    const row = errorRowHtml('objective.stages[<svg onload=alert(1)>]: bad id');
    expect(row).not.toContain('<svg');
    expect(row).toContain('&lt;svg onload=alert(1)&gt;');
  });

  it('handles errors without a colon without mangling', () => {
    expect(errorRowHtml('weird<script>')).toBe('<div class="xed-err"><b>weird&lt;script&gt;</b></div>');
  });
});
