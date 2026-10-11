/**
 * uploadUI — Supabase Storage upload wiring (phase 2 of the character-model
 * import work). A file picker (accept .glb/.gltf/.png/.jpg/.jpeg/.webp)
 * uploads to a storage bucket and hands the PUBLIC URL back via onUrl().
 *
 * Contract:
 *   attachUploadButton(input, { accept, onUrl, buttonLabel? })
 *   - Inserts an "⬆ UPLOAD" button directly after `input`.
 *   - No Supabase configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 *     missing) → button renders DISABLED with an explanatory tooltip.
 *   - Upload errors → inline status message next to the button. Never throws.
 *
 * Bucket: VITE_SUPABASE_UPLOAD_BUCKET, default 'xandria-uploads'.
 * The bucket must exist in the Supabase project (create it under
 * Storage → New bucket, mark it PUBLIC so getPublicUrl() resolves, and add
 * an INSERT policy for anon or signed-in users). Uploaded objects land at
 * `uploads/<timestamp>-<rand>-<sanitized-name>`.
 *
 * Offline behavior: uploads need network. When offline (or on any storage
 * error) the button stays enabled and the inline message says what failed —
 * the text input next to it remains the always-available fallback.
 */
import { getSupabase } from './auth';

/** Storage bucket for user uploads; create it in the Supabase dashboard first. */
export const UPLOAD_BUCKET =
  (import.meta.env.VITE_SUPABASE_UPLOAD_BUCKET as string | undefined)?.trim() || 'xandria-uploads';

/** Hard cap so a phone video can't eat the quota — surfaced as an inline message. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export interface UploadButtonOpts {
  /** e.g. '.glb,.gltf,.png,.jpg,.jpeg,.webp' */
  accept: string;
  /** Called with the public URL once the upload succeeds. */
  onUrl(url: string): void;
  /** Button label override. */
  buttonLabel?: string;
}

/** True when the Supabase client exists (env configured). */
export function isUploadConfigured(): boolean {
  return getSupabase() !== null;
}

const fmtMB = (b: number): string => `${(b / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Wire an upload button next to a model/texture URL input. Errors are shown
 * inline and never thrown.
 */
export function attachUploadButton(input: HTMLInputElement, opts: UploadButtonOpts): HTMLButtonElement {
  const sb = getSupabase();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'xed-iconbtn';
  btn.textContent = opts.buttonLabel ?? '⬆ UPLOAD';

  const status = document.createElement('span');
  status.className = 'xed-hint';
  status.style.marginLeft = '6px';
  status.setAttribute('aria-live', 'polite');

  const setStatus = (msg: string): void => {
    status.textContent = msg;
  };

  if (!sb) {
    btn.disabled = true;
    btn.title = 'Upload unavailable: Supabase Storage not configured (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY).';
    setStatus('uploads disabled — paste a hosted URL');
  } else {
    btn.title = `Upload a file to Supabase Storage (${UPLOAD_BUCKET}). Max ${fmtMB(UPLOAD_MAX_BYTES)}.`;
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = opts.accept;
  fileInput.style.display = 'none';
  // A stray file input on the page can be picked up by form serialization —
  // keep it inert.
  fileInput.tabIndex = -1;

  btn.addEventListener('click', () => {
    if (!getSupabase()) return; // still unconfigured — tooltip explains
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    void (async () => {
      try {
        const client = getSupabase();
        if (!client) throw new Error('upload not configured');
        if (f.size > UPLOAD_MAX_BYTES) {
          throw new Error(`file too large (${fmtMB(f.size)} — max ${fmtMB(UPLOAD_MAX_BYTES)})`);
        }
        btn.disabled = true;
        setStatus(`uploading ${f.name}…`);
        const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
        const key = `uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
        const { error } = await client.storage
          .from(UPLOAD_BUCKET)
          .upload(key, f, { contentType: f.type || undefined, upsert: false });
        if (error) throw new Error(error.message);
        const { data } = client.storage.from(UPLOAD_BUCKET).getPublicUrl(key);
        setStatus('uploaded ✓');
        opts.onUrl(data.publicUrl);
      } catch (e) {
        // Inline, never thrown — the URL input next to the button still works.
        setStatus(`upload failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        btn.disabled = !getSupabase();
      }
    })();
  });

  input.insertAdjacentElement('afterend', btn);
  btn.insertAdjacentElement('afterend', status);
  // Keep the hidden picker near the button so it doesn't wander in the DOM.
  btn.insertAdjacentElement('afterend', fileInput);
  return btn;
}
