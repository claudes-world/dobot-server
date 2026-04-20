import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Mock config FIRST — before any imports that pull in config.ts
vi.mock('../../src/config.js', () => ({
  config: {
    telegramNarratorBotToken: 'test-token',
    narrator: {
      allowedUserIds: new Set([1]),
      agentRunScript: '/fake/run.sh',
      narratorRoot: '/fake/claudes-world/agents/narrator',
      classifyModel: 'claude-haiku-4-5',
      rewriteModel: 'claude-sonnet-4-6',
      claudeTimeout: 30000,
      mdSpeakTimeout: 30000,
      maxSourceWords: 8000,
      storiesDir: '/tmp/stories',
      tmpDir: '/tmp',
      maxJobsPerHour: 10,
      maxDailyTtsUsd: 5.0,
      lengthTimeoutMs: 20000,
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

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn().mockResolvedValue('mock source text'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockRejectedValue(new Error('not found')), // skill files don't exist by default
  },
  readFile: vi.fn().mockResolvedValue('mock source text'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('not found')),
}));

vi.mock('../../src/lib/classify.js', () => ({
  classifyNarrative: vi.fn().mockResolvedValue({
    tone: 'serious',
    shape: 'origin-story',
    confidence: 0.9,
    source: 'classify',
  }),
  VALID_TONES: ['serious', 'funny', 'roast', 'grave', 'celebratory', 'comforting', 'harsh', 'inflammatory', 'surprising', 'jovial'],
  VALID_SHAPES: ['origin-story', 'postmortem', 'heist-reveal', 'detective', 'hero-journey', 'confessional'],
}));

import { spawnClaudeWithRetry } from '../../src/lib/claude-subprocess.js';
import { deliverNarration } from '../../src/delivery/narrator.js';
import { classifyNarrative } from '../../src/lib/classify.js';
import { createNarratorHandler, continueNarration } from '../../src/handlers/narrator.js';

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
    CREATE TABLE IF NOT EXISTS pending_length_choices (
      job_id          TEXT PRIMARY KEY,
      chat_id         INTEGER NOT NULL,
      keyboard_msg_id INTEGER NOT NULL,
      source_tmpfile  TEXT NOT NULL,
      tone_prefix     TEXT,
      shape_prefix    TEXT,
      expires_at      INTEGER NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id)
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

function insertJob(db: Database.Database, jobId: string, chatId = 100) {
  db.prepare(`
    INSERT INTO jobs (id, handler, chat_id, user_id, started_at, status)
    VALUES (?, 'narrator', ?, 1, ?, 'active')
  `).run(jobId, chatId, Date.now());
}

const mockSuccessEnvelope = {
  envelope: {
    is_error: false,
    result: 'Once upon a time there was a great kingdom.',
    stop_reason: 'end_turn',
  },
  retried: false,
};

describe('narratorHandler — keyboard ack (message phase)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    vi.mocked(spawnClaudeWithRetry).mockResolvedValue(mockSuccessEnvelope);
    vi.mocked(deliverNarration).mockResolvedValue(undefined);
  });

  it('1. Keyboard sent as ack (no spawn in message phase)', async () => {
    const ctx = makeCtx();
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    // reply called with keyboard markup
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('length'),
      expect.objectContaining({ reply_markup: expect.anything() })
    );

    // spawn NOT called in message phase — user must choose length first
    expect(spawnClaudeWithRetry).not.toHaveBeenCalled();
  });

  it('2. Pending row inserted after ack', async () => {
    const ctx = makeCtx();
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    const rows = db.prepare(`SELECT * FROM pending_length_choices`).all();
    expect(rows.length).toBe(1);
  });

  it('3. Ack failure does not abort — pending row inserted with keyboard_msg_id=0', async () => {
    const ctx = makeCtx({
      reply: vi.fn().mockRejectedValue(new Error('Telegram API down')),
    });

    const handler = createNarratorHandler(db);
    // ack fail is best-effort — handler should not throw
    await expect(handler(ctx as never)).resolves.not.toThrow();

    // Row is still inserted (keyboard_msg_id=0) so timeout can fire continueNarration
    const rows = db.prepare(`SELECT * FROM pending_length_choices`).all() as { keyboard_msg_id: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0].keyboard_msg_id).toBe(0);
  });

  it('4. Job row inserted with NULL length', async () => {
    const ctx = makeCtx();
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    const job = db.prepare(`SELECT * FROM jobs`).get() as { length: string | null } | undefined;
    expect(job).toBeTruthy();
    expect(job?.length).toBeNull();
  });
});

describe('continueNarration — spawn + delivery phase', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    vi.mocked(spawnClaudeWithRetry).mockResolvedValue(mockSuccessEnvelope);
    vi.mocked(deliverNarration).mockResolvedValue(undefined);
  });

  it('1. Typing interval cleared on success', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    const jobId = 'job-typing-success';
    insertJob(db, jobId);

    const ctx = makeCtx();
    await continueNarration(jobId, 'medium', ctx as never, db);

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('2. Typing interval cleared on error', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    vi.mocked(spawnClaudeWithRetry).mockRejectedValue(new Error('something went wrong'));

    const jobId = 'job-typing-error';
    insertJob(db, jobId);

    const ctx = makeCtx();
    await expect(continueNarration(jobId, 'medium', ctx as never, db)).rejects.toThrow('something went wrong');

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it('3. Error path sends user-friendly message — auth error maps to "temporarily unavailable"', async () => {
    vi.mocked(spawnClaudeWithRetry).mockRejectedValue(
      new Error('not logged in — please run /login first')
    );

    const jobId = 'job-auth-err';
    insertJob(db, jobId);

    const ctx = makeCtx();
    await expect(continueNarration(jobId, 'medium', ctx as never, db)).rejects.toThrow();

    // Since no ackMessageId, it falls back to ctx.reply
    const replyCalls = vi.mocked(ctx.reply).mock.calls;
    const allMessages = replyCalls.map(c => c[0] as string);
    const anyFriendly = allMessages.some(m => m.includes('temporarily unavailable'));
    expect(anyFriendly).toBe(true);

    // Raw error string must NOT appear in user-visible messages
    const anyRaw = allMessages.some(m => m.includes('not logged in'));
    expect(anyRaw).toBe(false);
  });

  it('4. Spawn called with correct length instructions', async () => {
    const jobId = 'job-len-check';
    insertJob(db, jobId);

    const ctx = makeCtx();
    await continueNarration(jobId, 'short', ctx as never, db);

    expect(spawnClaudeWithRetry).toHaveBeenCalled();
    const callArgs = vi.mocked(spawnClaudeWithRetry).mock.calls[0];
    // args[1] is the args array — -p prompt is first pair
    const argsArray = callArgs[1] as string[];
    const promptIdx = argsArray.indexOf('-p');
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const prompt = argsArray[promptIdx + 1];
    expect(prompt).toContain('200-400');
  });

  it('5. Job length column updated to chosen value', async () => {
    const jobId = 'job-len-col';
    insertJob(db, jobId);

    const ctx = makeCtx();
    await continueNarration(jobId, 'full', ctx as never, db);

    const job = db.prepare(`SELECT length FROM jobs WHERE id = ?`).get(jobId) as { length: string };
    expect(job.length).toBe('full');
  });

  it('6. classifyNarrative called when no prefix override', async () => {
    const jobId = 'job-classify-called';
    insertJob(db, jobId);

    const ctx = makeCtx();
    await continueNarration(jobId, 'medium', ctx as never, db);

    expect(classifyNarrative).toHaveBeenCalled();
  });

  it('7. classifyNarrative NOT called when toneOverride passed directly', async () => {
    const jobId = 'job-prefix-override';
    insertJob(db, jobId);

    const ctx = makeCtx();
    // toneOverride/shapeOverride passed directly (callback/timeout path — no DB read)
    await continueNarration(jobId, 'medium', ctx as never, db, 'funny', 'heist-reveal');

    expect(classifyNarrative).not.toHaveBeenCalled();
  });

  it('8. deliverNarration called with tone and shape from classify', async () => {
    vi.mocked(classifyNarrative).mockResolvedValueOnce({
      tone: 'grave',
      shape: 'postmortem',
      confidence: 0.8,
      source: 'classify',
    });

    const jobId = 'job-deliver-classify-args';
    insertJob(db, jobId);

    const ctx = makeCtx();
    await continueNarration(jobId, 'medium', ctx as never, db);

    expect(deliverNarration).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'grave', shape: 'postmortem' })
    );
  });

  it('9. deliverNarration called with tone and shape from prefix override', async () => {
    const jobId = 'job-deliver-prefix-args';
    insertJob(db, jobId);

    const ctx = makeCtx();
    // toneOverride/shapeOverride passed directly (callback/timeout path — no DB read)
    await continueNarration(jobId, 'medium', ctx as never, db, 'roast', 'detective');

    expect(deliverNarration).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'roast', shape: 'detective' })
    );
  });
});

describe('narratorHandler — prefix parsing (message phase)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    vi.mocked(spawnClaudeWithRetry).mockResolvedValue(mockSuccessEnvelope);
    vi.mocked(deliverNarration).mockResolvedValue(undefined);
  });

  it('10. Invalid tone prefix replies with error and returns early', async () => {
    const ctx = makeCtx({ message: { text: '[badtone] Some text', message_id: 42 } });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    // Should reply with error mentioning the bad tone
    const replyCalls = vi.mocked(ctx.reply).mock.calls;
    expect(replyCalls.length).toBe(1);
    expect(replyCalls[0][0]).toContain("badtone");

    // No job inserted — early return
    const jobs = db.prepare(`SELECT * FROM jobs`).all();
    expect(jobs.length).toBe(0);
  });

  it('11. Valid tone prefix stores tone/shape in pending row', async () => {
    const ctx = makeCtx({ message: { text: '[funny:heist-reveal] Some story text', message_id: 42 } });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    const row = db.prepare(`SELECT tone_prefix, shape_prefix FROM pending_length_choices`).get() as
      { tone_prefix: string | null; shape_prefix: string | null } | undefined;
    expect(row).toBeTruthy();
    expect(row?.tone_prefix).toBe('funny');
    expect(row?.shape_prefix).toBe('heist-reveal');
  });

  it('12. No prefix stores NULL tone/shape in pending row', async () => {
    const ctx = makeCtx({ message: { text: 'A story without prefix', message_id: 42 } });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    const row = db.prepare(`SELECT tone_prefix, shape_prefix FROM pending_length_choices`).get() as
      { tone_prefix: string | null; shape_prefix: string | null } | undefined;
    expect(row).toBeTruthy();
    expect(row?.tone_prefix).toBeNull();
    expect(row?.shape_prefix).toBeNull();
  });
});

describe('narratorHandler — forwarded message handling (#57)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
    vi.mocked(spawnClaudeWithRetry).mockResolvedValue(mockSuccessEnvelope);
    vi.mocked(deliverNarration).mockResolvedValue(undefined);
  });

  it('13. Forwarded message from channel — prepends channel title and proceeds', async () => {
    const ctx = makeCtx({
      message: {
        text: 'Big news from the channel!',
        message_id: 42,
        forward_origin: {
          type: 'channel',
          chat: { title: 'Tech Digest', username: 'techdigest' },
        },
      },
    });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    // Should insert a pending_length_choices row (forwarded message processed as valid input)
    const rows = db.prepare(`SELECT * FROM pending_length_choices`).all();
    expect(rows.length).toBe(1);

    // Should have sent the length keyboard ack
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('length'),
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });

  it('14. Forwarded channel message — source text written with [Forwarded from ...] prefix', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const writeSpy = vi.mocked(fsMock.writeFile);

    const ctx = makeCtx({
      message: {
        text: 'Some channel post content.',
        message_id: 42,
        forward_origin: {
          type: 'channel',
          chat: { title: 'Daily Briefing' },
        },
      },
    });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    // Find the call that wrote the source tmpfile (not the sys prompt file)
    const srcWriteCall = writeSpy.mock.calls.find(c => (c[0] as string).includes('narrator-src-'));
    expect(srcWriteCall).toBeTruthy();
    expect(srcWriteCall![1]).toContain('[Forwarded from Daily Briefing]');
    expect(srcWriteCall![1]).toContain('Some channel post content.');
  });

  it('15. Forwarded message from non-channel (user) — no channel prefix prepended', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const writeSpy = vi.mocked(fsMock.writeFile);

    const ctx = makeCtx({
      message: {
        text: 'A forwarded personal message.',
        message_id: 42,
        forward_origin: {
          type: 'user',
          sender_user: { id: 999, first_name: 'Alice' },
        },
      },
    });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    const srcWriteCall = writeSpy.mock.calls.find(c => (c[0] as string).includes('narrator-src-'));
    expect(srcWriteCall).toBeTruthy();
    // No [Forwarded from ...] prefix for non-channel
    expect(srcWriteCall![1]).not.toContain('[Forwarded from');
    expect(srcWriteCall![1]).toBe('A forwarded personal message.');
  });

  it('16. Forwarded message with no text — replies with error and returns early', async () => {
    const ctx = makeCtx({
      message: {
        message_id: 42,
        forward_origin: { type: 'channel', chat: { title: 'Silent Channel' } },
        // no text, no caption
      },
    });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    expect(ctx.reply).toHaveBeenCalledWith('Forwarded message has no text to narrate');

    // No job inserted — early return
    const jobs = db.prepare(`SELECT * FROM jobs`).all();
    expect(jobs.length).toBe(0);
  });

  it('17. Forwarded message with caption (no text) — uses caption as source', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const writeSpy = vi.mocked(fsMock.writeFile);

    const ctx = makeCtx({
      message: {
        message_id: 42,
        caption: 'This is a photo caption from a channel.',
        forward_date: 1700000000,
        forward_origin: {
          type: 'channel',
          chat: { title: 'Photo Feed' },
        },
      },
    });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    const srcWriteCall = writeSpy.mock.calls.find(c => (c[0] as string).includes('narrator-src-'));
    expect(srcWriteCall).toBeTruthy();
    expect(srcWriteCall![1]).toContain('[Forwarded from Photo Feed]');
    expect(srcWriteCall![1]).toContain('This is a photo caption from a channel.');
  });

  it('18. forward_date-only message (no forward_origin) treated as regular input — no channel prefix', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const writeSpy = vi.mocked(fsMock.writeFile);

    const ctx = makeCtx({
      message: {
        text: 'Message with forward_date but no forward_origin.',
        message_id: 42,
        forward_date: 1700000000,
        // no forward_origin — handler uses forward_origin for detection; forward_date alone is ignored
      },
    });
    const handler = createNarratorHandler(db);
    await handler(ctx as never);

    // Handler treats this as a plain (non-forwarded) message — no attribution prefix,
    // and the text is written as-is to the source tmpfile.
    const srcWriteCall = writeSpy.mock.calls.find(c => (c[0] as string).includes('narrator-src-'));
    expect(srcWriteCall).toBeTruthy();
    expect(srcWriteCall![1]).not.toContain('[Forwarded from');
    expect(srcWriteCall![1]).toBe('Message with forward_date but no forward_origin.');
  });
});
