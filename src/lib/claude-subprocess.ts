/**
 * Subprocess environment helpers.
 *
 * Guarantees that sensitive credentials (TELEGRAM_*, NARRATOR_*, ANTHROPIC_*)
 * never leak into child process environments. Only an explicit allowlist of
 * variables is forwarded; callers pass any additional needed vars via `extra`.
 */

const ALLOWED_KEYS = ['PATH', 'HOME', 'TZ'] as const;

/**
 * Build a clean subprocess env from an explicit allowlist.
 *
 * @param base   Source env (defaults to `process.env`). Only ALLOWED_KEYS are
 *               copied from this object.
 * @param extra  Additional key→value pairs merged in after the allowlist copy.
 *               Extra keys win on conflict (e.g. to override PATH for tests).
 *
 * Critical: TELEGRAM_*, NARRATOR_*, ANTHROPIC_* must NEVER appear in the
 * returned object. Callers control inclusion of anything beyond the allowlist
 * through `extra` — do not add secrets there.
 */
export function buildSubprocessEnv(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  for (const k of ALLOWED_KEYS) {
    if (base[k] !== undefined) {
      result[k] = base[k];
    }
  }

  Object.assign(result, extra);
  return result;
}
