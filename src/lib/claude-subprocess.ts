/**
 * Subprocess environment helpers.
 *
 * Guarantees that sensitive credentials (TELEGRAM_*, NARRATOR_*, ANTHROPIC_*)
 * never leak into child process environments. Only an explicit allowlist of
 * variables is forwarded from `base`; callers pass any additional needed vars
 * via `extra`, which is also guarded against forbidden prefixes.
 */

const ALLOWED_KEYS = ['PATH', 'HOME', 'TZ'] as const;

/** Prefixes that must never reach subprocess environments. */
const FORBIDDEN_PREFIXES = ['TELEGRAM_', 'NARRATOR_', 'ANTHROPIC_'] as const;

/**
 * Build a clean subprocess env from an explicit allowlist.
 *
 * @param base   Source env (defaults to `process.env`). Only ALLOWED_KEYS are
 *               copied from this object.
 * @param extra  Additional key→value pairs merged in after the allowlist copy.
 *               Extra keys win on conflict (e.g. to override PATH for tests).
 *               Keys matching FORBIDDEN_PREFIXES are rejected with an error.
 *
 * Critical: TELEGRAM_*, NARRATOR_*, ANTHROPIC_* must NEVER appear in the
 * returned object — enforced for both `base` (via allowlist) and `extra`
 * (via prefix guard).
 */
export function buildSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  // Guard: reject forbidden keys in extra before touching the result object.
  for (const k of Object.keys(extra)) {
    if (FORBIDDEN_PREFIXES.some(prefix => k.startsWith(prefix))) {
      throw new Error(
        `buildSubprocessEnv: forbidden key in extra — "${k}" matches a forbidden prefix (${FORBIDDEN_PREFIXES.join(', ')})`,
      );
    }
  }

  const result: NodeJS.ProcessEnv = {};

  for (const k of ALLOWED_KEYS) {
    if (base[k] !== undefined) {
      result[k] = base[k];
    }
  }

  Object.assign(result, extra);
  return result;
}
