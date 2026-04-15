import { describe, it, expect } from 'vitest';
import { buildSubprocessEnv } from '../../src/lib/claude-subprocess.js';

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
});
