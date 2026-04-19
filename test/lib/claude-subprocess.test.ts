import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSubprocessEnv, spawnClaudeWithRetry } from '../../src/lib/claude-subprocess.js';

describe('buildSubprocessEnv', () => {
  it('includes PATH, HOME, TZ when present in base', () => {
    const base = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/claude',
      TZ: 'America/New_York',
    };
    const result = buildSubprocessEnv(base);
    expect(result['PATH']).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(result['HOME']).toBe('/home/claude');
    expect(result['TZ']).toBe('America/New_York');
  });

  it('excludes TELEGRAM_BOT_TOKEN even if present in base', () => {
    const base = {
      PATH: '/usr/bin',
      TELEGRAM_BOT_TOKEN: 'secret-bot-token',
    };
    const result = buildSubprocessEnv(base);
    expect(result['TELEGRAM_BOT_TOKEN']).toBeUndefined();
  });

  it('excludes ANTHROPIC_API_KEY even if present in base', () => {
    const base = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    };
    const result = buildSubprocessEnv(base);
    expect(result['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('excludes NARRATOR_ALLOWED_USER_IDS even if present in base', () => {
    const base = {
      HOME: '/home/claude',
      NARRATOR_ALLOWED_USER_IDS: '12345,67890',
    };
    const result = buildSubprocessEnv(base);
    expect(result['NARRATOR_ALLOWED_USER_IDS']).toBeUndefined();
  });

  it('includes extras passed via second argument', () => {
    const base = { PATH: '/usr/bin' };
    const extra = { GOOGLE_APPLICATION_CREDENTIALS: '/path/to/creds.json' };
    const result = buildSubprocessEnv(base, extra);
    expect(result['GOOGLE_APPLICATION_CREDENTIALS']).toBe('/path/to/creds.json');
  });

  it('extras take precedence over allowlist values when key conflicts', () => {
    const base = { PATH: '/usr/bin' };
    const extra = { PATH: '/custom/bin' };
    const result = buildSubprocessEnv(base, extra);
    expect(result['PATH']).toBe('/custom/bin');
  });

  it('throws if extra contains a TELEGRAM_* key', () => {
    expect(() =>
      buildSubprocessEnv({}, { TELEGRAM_BOT_TOKEN: 'secret' }),
    ).toThrow(/forbidden key/);
  });

  it('throws if extra contains an ANTHROPIC_* key', () => {
    expect(() =>
      buildSubprocessEnv({}, { ANTHROPIC_API_KEY: 'sk-ant-secret' }),
    ).toThrow(/forbidden key/);
  });

  it('throws if extra contains a NARRATOR_* key', () => {
    expect(() =>
      buildSubprocessEnv({}, { NARRATOR_ALLOWED_USER_IDS: '123' }),
    ).toThrow(/forbidden key/);
  });
});

// ─── spawnClaudeWithRetry ────────────────────────────────────────────────────

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
const mockedExeca = vi.mocked(execa);

/** Build a minimal valid ClaudeEnvelope JSON string. */
function makeEnvelopeStdout(is_error: boolean, result: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error,
    result,
    stop_reason: 'stop_sequence',
  });
}

/** Build a fake ExecaError (non-zero exit) with stdout set. */
function makeExecaError(stdout: string, exitCode = 1): Error {
  const err = new Error(`Command failed with exit code ${exitCode}: /run.sh`) as Error & {
    stdout: string;
    exitCode: number;
  };
  err.stdout = stdout;
  err.exitCode = exitCode;
  return err;
}

describe('spawnClaudeWithRetry', () => {
  const RUN = '/fake/run.sh';
  const ARGS = ['-p', 'hi'];
  const ENV = { PATH: '/usr/bin', HOME: '/home/test' };
  const TIMEOUT = 5000;

  beforeEach(() => {
    vi.clearAllMocks();
    // Speed up retry delay in tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clean success — retried: false', async () => {
    const stdout = makeEnvelopeStdout(false, 'nice narrative');
    mockedExeca.mockResolvedValueOnce({ stdout, stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const promise = spawnClaudeWithRetry(RUN, ARGS, 'input', ENV, TIMEOUT);
    await vi.runAllTimersAsync();
    const { envelope, retried } = await promise;

    expect(retried).toBe(false);
    expect(envelope.is_error).toBe(false);
    expect(envelope.result).toBe('nice narrative');
  });

  it('auth error via thrown exception on attempt 1 — retried: true, succeeds on attempt 2', async () => {
    const authErr = makeExecaError(makeEnvelopeStdout(true, 'Not logged in · Please run /login'));
    const successStdout = makeEnvelopeStdout(false, 'recovered narrative');

    mockedExeca
      .mockRejectedValueOnce(authErr)
      .mockResolvedValueOnce({ stdout: successStdout, stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const promise = spawnClaudeWithRetry(RUN, ARGS, 'input', ENV, TIMEOUT);
    await vi.runAllTimersAsync();
    const { envelope, retried } = await promise;

    expect(retried).toBe(true);
    expect(envelope.is_error).toBe(false);
    expect(envelope.result).toBe('recovered narrative');
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });

  it('auth error via is_error envelope on attempt 1 — retried: true, succeeds on attempt 2', async () => {
    const authStdout = makeEnvelopeStdout(true, 'Not logged in · Please run /login');
    const successStdout = makeEnvelopeStdout(false, 'recovered narrative');

    mockedExeca
      .mockResolvedValueOnce({ stdout: authStdout, stderr: '', exitCode: 0 } as ReturnType<typeof execa>)
      .mockResolvedValueOnce({ stdout: successStdout, stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const promise = spawnClaudeWithRetry(RUN, ARGS, 'input', ENV, TIMEOUT);
    await vi.runAllTimersAsync();
    const { envelope, retried } = await promise;

    expect(retried).toBe(true);
    expect(envelope.is_error).toBe(false);
    expect(envelope.result).toBe('recovered narrative');
  });

  it('auth error on both attempts — throws', async () => {
    const authErr = makeExecaError(makeEnvelopeStdout(true, 'Not logged in · Please run /login'));

    mockedExeca
      .mockRejectedValueOnce(authErr)
      .mockRejectedValueOnce(authErr);

    // Attach rejects handler immediately to prevent unhandled rejection warnings
    const resultPromise = expect(
      spawnClaudeWithRetry(RUN, ARGS, 'input', ENV, TIMEOUT),
    ).rejects.toThrow();
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });

  it('non-auth error — throws immediately without retry', async () => {
    const nonAuthErr = new Error('Something else went wrong entirely');
    mockedExeca.mockRejectedValueOnce(nonAuthErr);

    // Attach rejects handler immediately to prevent unhandled rejection warnings
    const resultPromise = expect(
      spawnClaudeWithRetry(RUN, ARGS, 'input', ENV, TIMEOUT),
    ).rejects.toThrow('Something else went wrong entirely');
    await vi.runAllTimersAsync();
    await resultPromise;
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });
});
