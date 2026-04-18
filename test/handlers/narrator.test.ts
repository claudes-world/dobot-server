import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock config FIRST — before any imports that pull in config.ts
vi.mock('../../src/config.js', () => ({
  config: {
    telegramNarratorBotToken: 'test-token',
    narrator: {
      allowedUserIds: new Set([1]),
      agentRunScript: '/fake/run.sh',
      classifyModel: 'claude-haiku-4-5',
      rewriteModel: 'claude-sonnet-4-6',
      claudeTimeout: 30000,
      mdSpeakTimeout: 30000,
      maxSourceWords: 8000,
      storiesDir: '/tmp/stories',
      tmpDir: '/tmp',
      maxJobsPerHour: 10,
      maxDailyTtsUsd: 5.0,
    },
  },
}));

vi.mock('../../src/lib/claude-subprocess.js', () => ({
  buildSubprocessEnv: vi.fn().mockReturnValue({}),
  spawnClaudeWithRetry: vi.fn(),
}));

vi.mock('../../src/lib/otel.js', () => ({
  getTracer: () => ({}),
  withSpan: vi.fn().mockImplementation(
    async (_tracer: unknown, _name: unknown, _attrs: unknown, fn: (span: unknown) => unknown) =>
      fn({ setAttribute: vi.fn() })
  ),
}));

vi.mock('../../src/lib/rate-limit.js', () => ({
  checkAndRecordRate: vi.fn().mockReturnValue('ok'),
  recordSpend: vi.fn(),
}));

vi.mock('../../src/delivery/narrator.js', () => ({
  deliverNarration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn().mockResolvedValue('mock system prompt'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

import { spawnClaudeWithRetry } from '../../src/lib/claude-subprocess.js';
import { deliverNarration } from '../../src/delivery/narrator.js';
import { createNarratorHandler } from '../../src/handlers/narrator.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      handler         TEXT NOT NULL,
      chat_id         INTEGER NOT NULL,
      user_id         INTEGER NOT NULL,
      started_at      INTEGER NOT NULL,
      completed_at    INTEGER,
      status          TEXT NOT NULL,
      source_kind     TEXT,
      tone            TEXT,
      shape           TEXT,
      length          TEXT,
      output_path     TEXT,
      subprocess_pid  INTEGER,
      tts_chars       INTEGER,
      tts_usd         REAL,
      tts_failed      INTEGER NOT NULL DEFAULT 0,
      stop_reason     TEXT,
      error           TEXT
    );
    CREATE TABLE IF NOT EXISTS rate_limits_hourly (
      id        INTEGER PRIMARY KEY,
      user_id   INTEGER NOT NULL,
      handler   TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rl_hourly_user_ts ON rate_limits_hourly(user_id, timestamp);
    CREATE TABLE IF NOT EXISTS rate_limits_daily_spend (
      id        INTEGER PRIMARY KEY,
      user_id   INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      tts_usd   REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rl_daily_user_ts ON rate_limits_daily_spend(user_id, timestamp);
  `);
  return db;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    from: { id: 1 },
    chat: { id: 100, type: 'private' },
    message: { text: 'Hello world story', message_id: 42 },
    reply: vi.fn().mockResolvedValue({ message_id: 99 }),
    api: {
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

const mockSuccessEnvelope = {
  envelope: {
    is_error: false,
    result: 'Once upon a time there was a great kingdom.',
    stop_reason: 'end_turn',
  },
  retried: false,
};

describe('narratorHandler — ack + typing indicator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    vi.mocked(spawnClaudeWithRetry).mockResolvedValue(mockSuccessEnvelope);
    vi.mocked(deliverNarration).mockResolvedValue(undefined);
  });

  it('1. Ack sent before spawn', async () => {
    const order: string[] = [];
    vi.mocked(spawnClaudeWithRetry).mockImplementation(async () => {
      order.push('spawn');
      return mockSuccessEnvelope;
    });

    const ctx = makeCtx({
      reply: vi.fn().mockImplementation(async () => {
        order.push('reply');
        return { message_id: 99 };
      }),
    });

    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    // reply (ack) must come before spawn
    const replyIdx = order.indexOf('reply');
    const spawnIdx = order.indexOf('spawn');
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThanOrEqual(0);
    expect(replyIdx).toBeLessThan(spawnIdx);
  });

  it('2. Typing interval cleared on success', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    const ctx = makeCtx();
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('3. Typing interval cleared on error', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    vi.mocked(spawnClaudeWithRetry).mockRejectedValue(new Error('something went wrong'));

    const ctx = makeCtx();
    const handler = createNarratorHandler(db);
    // handler re-throws
    await expect(handler(ctx as never)).rejects.toThrow('something went wrong');

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('4. Error path sends user-friendly message — auth error maps to "temporarily unavailable"', async () => {
    vi.mocked(spawnClaudeWithRetry).mockRejectedValue(
      new Error('not logged in — please run /login first')
    );

    const ctx = makeCtx();
    const handler = createNarratorHandler(db);
    await expect(handler(ctx as never)).rejects.toThrow();

    // The ack edit must show user-friendly text, not the raw error
    const editCalls = vi.mocked(ctx.api.editMessageText).mock.calls;
    const allMessages = editCalls.map(c => c[2] as string);
    const anyFriendly = allMessages.some(m => m.includes('temporarily unavailable'));
    expect(anyFriendly).toBe(true);

    // Raw error string must NOT appear in user-visible messages
    const anyRaw = allMessages.some(m => m.includes('not logged in'));
    expect(anyRaw).toBe(false);
  });

  it('5. Ack failure does not abort job — spawn still called', async () => {
    vi.mocked(spawnClaudeWithRetry).mockResolvedValue(mockSuccessEnvelope);

    const ctx = makeCtx({
      reply: vi.fn().mockRejectedValue(new Error('Telegram API down')),
    });

    const handler = createNarratorHandler(db);
    // best-effort ack failure is swallowed; handler should complete without error
    await expect(handler(ctx as never)).resolves.not.toThrow();

    // Spawn was still called despite ack failure
    expect(spawnClaudeWithRetry).toHaveBeenCalled();
  });
});
