/**
 * detect-input.ts — shared helpers for detecting special input kinds in narrator messages.
 * Covers file paths (#55) and URLs (#56).
 */

// Matches absolute paths (/foo/bar) or tilde paths (~/foo/bar).
// Captures the first such path found in the text.
const FILE_PATH_RE = /(?:^|\s)((?:\/|~\/)[\w\-./]+)/;

/**
 * Returns the first absolute or tilde-prefixed file path found in `text`, or null.
 * The path must start at the beginning of the string or after whitespace to
 * avoid false-positives inside prose.
 */
export function detectFilePath(text: string): string | null {
  const trimmed = text.trim();
  // Fast path: if the entire trimmed text is a single path token, return it directly.
  if (/^(?:\/|~\/)[\w\-./]+$/.test(trimmed)) {
    return trimmed;
  }
  const m = FILE_PATH_RE.exec(text);
  return m ? m[1] : null;
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
