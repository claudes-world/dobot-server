/**
 * detect-input.ts — shared helpers for detecting special input kinds in narrator messages.
 * Covers file paths (#55) and URLs (#56).
 */

// Matches an entire trimmed string that is an absolute path (/foo/bar) or tilde path (~/foo/bar).
// No substring extraction — the whole input must be the path.
const FILE_PATH_WHOLE_RE = /^(?:\/|~\/)[\w\-./]+$/;

/**
 * Returns the file path if the ENTIRE trimmed `text` is an absolute or tilde-prefixed path.
 * Returns null if the text contains anything before or after the path (prose, reddit slugs, etc.).
 * This strict whole-string match prevents false-positives like "/r/programming" inside sentences.
 */
export function detectFilePath(text: string): string | null {
  const trimmed = text.trim();
  if (FILE_PATH_WHOLE_RE.test(trimmed)) {
    return trimmed;
  }
  return null;
}

// Matches a single HTTPS URL anywhere in the text.
// Only HTTPS is accepted — HTTP is not suitable as a narrator source (security + reliability).
const URL_RE = /https:\/\/[^\s<>"{}|\\^`[\]]+/i;

/**
 * Detect a URL in user text.
 * Returns the first HTTPS URL found, or null if none.
 */
export function detectUrl(text: string): string | null {
  const match = URL_RE.exec(text);
  if (!match) return null;
  // Strip trailing punctuation that users commonly append after a URL
  const raw = match[0].replace(/[.,;:!?'")\]]+$/, '');
  try {
    new URL(raw);
    return raw;
  } catch {
    return null;
  }
}
