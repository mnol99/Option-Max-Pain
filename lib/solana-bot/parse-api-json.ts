/**
 * Avoid "Unexpected token '<'" when the server returns an HTML error page instead of JSON.
 */

export async function parseApiJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    throw new Error(
      `Server returned HTML instead of JSON (HTTP ${res.status}). ` +
        `If you just pulled code, restart "npm run dev" and confirm API routes exist.`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Invalid JSON from server (HTTP ${res.status}): ${trimmed.slice(0, 160)}${trimmed.length > 160 ? '…' : ''}`
    );
  }
}
