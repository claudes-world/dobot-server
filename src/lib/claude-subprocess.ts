/**
 * Subprocess environment helpers and Claude subprocess runner.
 *
 * Guarantees that sensitive credentials (TELEGRAM_*, NARRATOR_*, ANTHROPIC_*)
 * never leak into child process environments. Only an explicit allowlist of
 * variables is forwarded from `base`; callers pass any additional needed vars
 * via `extra`, which is also guarded against forbidden prefixes.
 */

import { execa } from 'execa';

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

export interface ClaudeEnvelope {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  stop_reason: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Detect whether a Claude error envelope or thrown-error message indicates
 * an OAuth/auth failure worth retrying.
 *
 * Observed auth-error shapes (from live experiment 2026-04-15):
 *   - Process exits with code 1 (thrown by execa)
 *   - stdout is a valid JSON envelope with is_error: true
 *   - envelope.result: "Not logged in · Please run /login"
 *   - envelope.subtype: "success" (misleading — is_error flag is the real signal)
 *   - No 401 HTTP codes in the output — the check is on "login"/"logged in" text
 */
function isAuthError(envelope: ClaudeEnvelope | null, thrownMsg: string): boolean {
  // Check thrown exception message
  if (/401|authentication|OAuth|credentials|unauthorized|not logged in|please run.*login/i.test(thrownMsg)) return true;
  // Check is_error envelope result text
  if (envelope?.is_error) {
    const result = envelope.result ?? '';
    if (/401|authentication|OAuth|credentials|unauthorized|not logged in|please run.*login/i.test(result)) return true;
  }
  return false;
}

/**
 * Spawn a Claude subprocess and retry once on auth errors.
 *
 * Handles both thrown exceptions (e.g. non-zero exit) and is_error envelopes.
 * On auth errors the process may exit non-zero but still write valid JSON to
 * stdout — we parse stdout from the caught ExecaError in that case.
 *
 * @param runScript   - Path to the agent run script (e.g. narrator/run.sh)
 * @param args        - CLI args to pass to the script
 * @param input       - stdin content
 * @param env         - subprocess env (use buildSubprocessEnv)
 * @param timeout     - timeout in ms
 * @param abortSignal - optional AbortSignal to cancel the subprocess
 */
export async function spawnClaudeWithRetry(
  runScript: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  abortSignal?: AbortSignal,
): Promise<{ envelope: ClaudeEnvelope; retried: boolean }> {
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    let envelope: ClaudeEnvelope | null = null;
    let thrownMsg = '';

    try {
      if (abortSignal?.aborted) {
        throw new Error('aborted');
      }
      const proc = await execa(runScript, args, {
        input,
        extendEnv: false,
        env,
        timeout,
        cleanup: true,
        killSignal: 'SIGKILL',
        cancelSignal: abortSignal,
      });

      try {
        const parsed = JSON.parse(proc.stdout) as Record<string, unknown>;
        if (typeof parsed['is_error'] !== 'boolean' || typeof parsed['result'] !== 'string') {
          throw new Error(`Malformed Claude envelope — missing is_error or result. stdout: ${proc.stdout.slice(0, 200)}`);
        }
        envelope = parsed as unknown as ClaudeEnvelope;
      } catch (parseErr) {
        throw new Error(`Failed to parse Claude output: ${String(parseErr)}. stdout: ${proc.stdout.slice(0, 200)}`);
      }

      // If is_error envelope, check if it's auth-related
      if (envelope.is_error && attempt === 0 && isAuthError(envelope, '')) {
        retried = true;
        console.warn('narrator: OAuth error in envelope on attempt 1, retrying once...');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      return { envelope, retried };

    } catch (err: unknown) {
      thrownMsg = String(err);

      // Auth failures (e.g. "Not logged in") cause non-zero exit but write valid JSON to stdout.
      // Try to parse stdout from the ExecaError before deciding whether to retry.
      const errStdout = (err as Record<string, unknown>)['stdout'];
      if (typeof errStdout === 'string' && errStdout.trim()) {
        try {
          const parsed = JSON.parse(errStdout) as Record<string, unknown>;
          if (typeof parsed['is_error'] === 'boolean' && typeof parsed['result'] === 'string') {
            envelope = parsed as unknown as ClaudeEnvelope;
          }
        } catch { /* not JSON, ignore */ }
      }

      if (attempt === 0 && isAuthError(envelope, thrownMsg)) {
        retried = true;
        console.warn('narrator: OAuth error on attempt 1, retrying once...');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }

  throw new Error('spawnClaudeWithRetry: unreachable — loop exhausted');
}
