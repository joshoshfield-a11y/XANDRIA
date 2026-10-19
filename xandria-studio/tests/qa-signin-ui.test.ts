/**
 * Regression tests for the 2026-10-18 sign-in UI fix ("generate does nothing").
 * - linkedLabelHtml must never claim a linked account when signed out
 *   (the old static "✓ Linked account" label misled unsigned users into
 *   believing they were signed in).
 * - the sign-in nudge must carry the same-browser hint, because magic links
 *   opened in the email app's in-app browser never reach the studio tab.
 */
import { describe, expect, it } from 'vitest';
import { linkedLabelHtml, SIGNIN_NUDGE, truncateEmail } from '../src/studio/tierGate';

describe('linkedLabelHtml', () => {
  it('is empty when signed out — never claims a linked account', () => {
    expect(linkedLabelHtml(null)).toBe('');
  });

  it('shows who is signed in when a session exists', () => {
    const html = linkedLabelHtml('skit@example.com');
    expect(html).toContain('Signed in as');
    expect(html).toContain('skit@example.com');
    expect(html).not.toContain('Linked account');
  });

  it('truncates long emails exactly like the account chip', () => {
    const long = 'verylongaddress1234567890@example.com';
    expect(linkedLabelHtml(long)).toContain(truncateEmail(long));
    expect(linkedLabelHtml(long)).not.toContain(long);
  });

  it('escapes HTML metacharacters in the email', () => {
    const html = linkedLabelHtml('"><img src=x onerror=alert(1)>@a.co');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('SIGNIN_NUDGE', () => {
  it('mentions the free tier and the same-browser requirement', () => {
    expect(SIGNIN_NUDGE).toMatch(/free/i);
    expect(SIGNIN_NUDGE).toMatch(/same browser/i);
  });
});
