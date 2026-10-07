/**
 * Spec injection for exported player HTML — shared by the CLI exporter
 * (scripts/export.ts) and the Studio "Export" button (src/studio/studio.ts).
 *
 * The spec bootstrap <script> is inserted immediately after the opening
 * <head> tag, which may carry attributes (e.g. `<head lang="en">`), so the
 * tag is matched with a regex rather than a literal string.
 *
 * Throws when no <head> tag is found. Silently shipping the default knight
 * spec instead of the user's game is worse than a loud failure (QA X3).
 */
export function injectSpecScript(html: string, scriptTag: string): string {
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (!m) {
    throw new Error('spec injection failed: no <head> tag found in the player HTML');
  }
  const at = m.index + m[0].length;
  return html.slice(0, at) + scriptTag + html.slice(at);
}
