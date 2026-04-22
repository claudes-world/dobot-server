import { describe, it, expect, vi } from 'vitest';

// ── getMeter returns a Meter ──────────────────────────────────────────────────

describe('getMeter', () => {
  it('returns a Meter instance with createCounter', async () => {
    const { getMeter } = await import('../../src/lib/otel.js');
    const meter = getMeter('test');
    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe('function');
  });

  it('returns a Meter with createUpDownCounter and createObservableGauge', async () => {
    const { getMeter } = await import('../../src/lib/otel.js');
    const meter = getMeter('test');
    expect(typeof meter.createUpDownCounter).toBe('function');
    expect(typeof meter.createObservableGauge).toBe('function');
  });
});

// ── messages_received counter ─────────────────────────────────────────────────

describe('messages_received counter', () => {
  it('increments on incoming message event', async () => {
    const addSpy = vi.fn();
    const mockCounter = { add: addSpy };
    const mockMeter = {
      createCounter: vi.fn().mockReturnValue(mockCounter),
      createUpDownCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
    };
    const mockSpan = { end: vi.fn(), recordException: vi.fn(), setStatus: vi.fn() };
    const mockTracer = { startSpan: vi.fn().mockReturnValue(mockSpan) };

    vi.doMock('../../src/lib/otel.js', () => ({
      getTracer: () => mockTracer,
      getMeter: () => mockMeter,
    }));

    const { registerHandlers } = await import('../../src/router.js?mock=metrics-recv');

    let msgHandler: ((ctx: unknown) => Promise<void>) | undefined;
    const bot = {
      command: vi.fn(),
      on: vi.fn().mockImplementation((event: string, fn: (ctx: unknown) => Promise<void>) => {
        if (event === 'message') msgHandler = fn;
      }),
    } as unknown as import('grammy').Bot;

    registerHandlers(bot, {
      narrator: vi.fn().mockResolvedValue(undefined),
      narratorCallback: vi.fn(),
      cancel: vi.fn(),
    }, 'narrator');

    const ctx = { from: { id: 1 }, chat: { id: 1 }, message: { text: 'hi' } };
    await msgHandler?.(ctx);

    // messages_received.add(1, { bot: 'narrator' }) must be called
    expect(addSpy).toHaveBeenCalledWith(1, { bot: 'narrator' });

    vi.doUnmock('../../src/lib/otel.js');
  });
});

// ── handler_errors counter ────────────────────────────────────────────────────

describe('handler_errors counter', () => {
  it('increments when narrator handler throws', async () => {
    const addSpy = vi.fn();
    const mockCounter = { add: addSpy };
    const mockMeter = {
      createCounter: vi.fn().mockReturnValue(mockCounter),
      createUpDownCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
    };
    const mockSpan = { end: vi.fn(), recordException: vi.fn(), setStatus: vi.fn() };
    const mockTracer = { startSpan: vi.fn().mockReturnValue(mockSpan) };

    vi.doMock('../../src/lib/otel.js', () => ({
      getTracer: () => mockTracer,
      getMeter: () => mockMeter,
    }));

    const { registerHandlers } = await import('../../src/router.js?mock=handler-err');

    let msgHandler: ((ctx: unknown) => Promise<void>) | undefined;
    const bot = {
      command: vi.fn(),
      on: vi.fn().mockImplementation((event: string, fn: (ctx: unknown) => Promise<void>) => {
        if (event === 'message') msgHandler = fn;
      }),
    } as unknown as import('grammy').Bot;

    registerHandlers(bot, {
      narrator: vi.fn().mockRejectedValue(new Error('boom')),
      narratorCallback: vi.fn(),
      cancel: vi.fn(),
    }, 'narrator');

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = { from: { id: 1 }, chat: { id: 1 }, message: { text: 'hi' } };
    await msgHandler?.(ctx);
    vi.restoreAllMocks();

    // handler_errors.add(1, { bot: 'narrator', handler: 'narrator' }) must be called
    expect(addSpy).toHaveBeenCalledWith(1, { bot: 'narrator', handler: 'narrator' });

    vi.doUnmock('../../src/lib/otel.js');
  });
});

// ── pending_narrator_timeouts UpDownCounter ───────────────────────────────────

describe('pending_narrator_timeouts UpDownCounter', () => {
  it('increments (add 1) when a timeout is armed', async () => {
    const upDownAddSpy = vi.fn();
    const upDownCounter = { add: upDownAddSpy };

    vi.doMock('../../src/lib/otel.js', () => ({
      getTracer: vi.fn().mockReturnValue({ startSpan: vi.fn().mockReturnValue({ end: vi.fn(), setAttribute: vi.fn() }) }),
      getMeter: vi.fn().mockReturnValue({
        createUpDownCounter: vi.fn().mockReturnValue(upDownCounter),
        createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
        createObservableGauge: vi.fn().mockReturnValue({ addCallback: vi.fn() }),
      }),
      withSpan: vi.fn().mockImplementation(
        async (_t: unknown, _n: unknown, _a: unknown, fn: (s: unknown) => unknown) =>
          fn({ setAttribute: vi.fn() })
      ),
    }));

    vi.doMock('../../src/config.js', () => ({
      config: {
        narrator: {
          agentRunScript: '/fake/run.sh', narratorRoot: '/fake/narrator',
          classifyModel: 'claude-haiku-4-5', rewriteModel: 'claude-sonnet-4-6',
          claudeTimeout: 30000, mdSpeakTimeout: 30000, maxSourceWords: 8000,
          storiesDir: '/tmp/stories', tmpDir: '/tmp', maxJobsPerHour: 10,
          maxDailyTtsUsd: 5.0, lengthTimeoutMs: 60000, // long so it doesn't fire
        },
      },
    }));

    vi.doMock('../../src/lib/rate-limit.js', () => ({
      checkAndRecordRate: vi.fn().mockReturnValue('ok'),
    }));

    vi.doMock('../../src/lib/classify.js', () => ({
      classifyNarrative: vi.fn().mockResolvedValue({ tone: 'serious', shape: 'origin-story', confidence: 0.9, source: 'classify' }),
      VALID_TONES: [], VALID_SHAPES: [],
    }));

    vi.doMock('../../src/lib/claude-subprocess.js', () => ({
      buildSubprocessEnv: vi.fn().mockReturnValue({}),
      spawnClaudeWithRetry: vi.fn().mockResolvedValue({
        envelope: { is_error: false, result: 'rewritten text', stop_reason: 'end_turn' },
        retried: false,
      }),
    }));

    vi.doMock('../../src/delivery/narrator.js', () => ({
      deliverNarration: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('node:fs/promises', () => ({
      default: {
        readFile: vi.fn().mockResolvedValue('mock source text'),
        writeFile: vi.fn().mockResolvedValue(undefined),
        unlink: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockRejectedValue(new Error('not found')),
        stat: vi.fn().mockResolvedValue({ size: 1024 }),
      },
      readFile: vi.fn().mockResolvedValue('mock source text'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockRejectedValue(new Error('not found')),
      stat: vi.fn().mockResolvedValue({ size: 1024 }),
    }));

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, handler TEXT, chat_id INTEGER, user_id INTEGER,
        started_at INTEGER, completed_at INTEGER, status TEXT,
        source_kind TEXT, tone TEXT, shape TEXT, length TEXT,
        output_path TEXT, subprocess_pid INTEGER, tts_chars INTEGER,
        tts_usd REAL, tts_failed INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_length_choices (
        job_id TEXT PRIMARY KEY, chat_id INTEGER, keyboard_msg_id INTEGER,
        source_tmpfile TEXT, tone_prefix TEXT, shape_prefix TEXT, expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS rate_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, handler TEXT, ts INTEGER
      );
    `);

    const { createNarratorHandler, pendingTimeouts } = await import('../../src/handlers/narrator.js?mock=updown-add');

    const ctx = {
      from: { id: 42 },
      chat: { id: 100 },
      message: { text: 'hello world test', message_id: 1 },
      reply: vi.fn().mockResolvedValue({ message_id: 99 }),
      api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
    };

    await createNarratorHandler(db)(ctx as unknown as import('grammy').Context);

    // A timeout was armed: upDownCounter.add(1, { bot: 'narrator' }) must be called
    expect(upDownAddSpy).toHaveBeenCalledWith(1, { bot: 'narrator' });
    expect(pendingTimeouts.size).toBeGreaterThan(0);

    // Clear the timeout to avoid leaks in test
    for (const [, handle] of pendingTimeouts) clearTimeout(handle);
    pendingTimeouts.clear();

    vi.doUnmock('../../src/lib/otel.js');
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('../../src/lib/rate-limit.js');
    vi.doUnmock('../../src/lib/classify.js');
    vi.doUnmock('../../src/lib/claude-subprocess.js');
    vi.doUnmock('../../src/delivery/narrator.js');
    vi.doUnmock('node:fs/promises');
  });

  it('decrements (add -1) when timeout is cleared by continueNarration', async () => {
    const upDownAddSpy = vi.fn();
    const upDownCounter = { add: upDownAddSpy };

    vi.doMock('../../src/lib/otel.js', () => ({
      getTracer: vi.fn().mockReturnValue({ startSpan: vi.fn().mockReturnValue({ end: vi.fn(), setAttribute: vi.fn() }) }),
      getMeter: vi.fn().mockReturnValue({
        createUpDownCounter: vi.fn().mockReturnValue(upDownCounter),
        createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
        createObservableGauge: vi.fn().mockReturnValue({ addCallback: vi.fn() }),
      }),
      withSpan: vi.fn().mockImplementation(
        async (_t: unknown, _n: unknown, _a: unknown, fn: (s: unknown) => unknown) =>
          fn({ setAttribute: vi.fn() })
      ),
    }));

    vi.doMock('../../src/config.js', () => ({
      config: {
        narrator: {
          agentRunScript: '/fake/run.sh', narratorRoot: '/fake/narrator',
          classifyModel: 'claude-haiku-4-5', rewriteModel: 'claude-sonnet-4-6',
          claudeTimeout: 30000, mdSpeakTimeout: 30000, maxSourceWords: 8000,
          storiesDir: '/tmp/stories', tmpDir: '/tmp', maxJobsPerHour: 10,
          maxDailyTtsUsd: 5.0, lengthTimeoutMs: 60000,
        },
      },
    }));

    vi.doMock('../../src/lib/rate-limit.js', () => ({
      checkAndRecordRate: vi.fn().mockReturnValue('ok'),
    }));

    vi.doMock('../../src/lib/classify.js', () => ({
      classifyNarrative: vi.fn().mockResolvedValue({ tone: 'serious', shape: 'origin-story', confidence: 0.9, source: 'classify' }),
      VALID_TONES: [], VALID_SHAPES: [],
    }));

    vi.doMock('../../src/lib/claude-subprocess.js', () => ({
      buildSubprocessEnv: vi.fn().mockReturnValue({}),
      spawnClaudeWithRetry: vi.fn().mockResolvedValue({
        envelope: { is_error: false, result: 'rewritten text', stop_reason: 'end_turn' },
        retried: false,
      }),
    }));

    vi.doMock('../../src/delivery/narrator.js', () => ({
      deliverNarration: vi.fn().mockResolvedValue(undefined),
    }));

    vi.doMock('node:fs/promises', () => ({
      default: {
        readFile: vi.fn().mockResolvedValue('mock source text'),
        writeFile: vi.fn().mockResolvedValue(undefined),
        unlink: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockRejectedValue(new Error('not found')),
        stat: vi.fn().mockResolvedValue({ size: 1024 }),
      },
      readFile: vi.fn().mockResolvedValue('mock source text'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      access: vi.fn().mockRejectedValue(new Error('not found')),
      stat: vi.fn().mockResolvedValue({ size: 1024 }),
    }));

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, handler TEXT, chat_id INTEGER, user_id INTEGER,
        started_at INTEGER, completed_at INTEGER, status TEXT,
        source_kind TEXT, tone TEXT, shape TEXT, length TEXT,
        output_path TEXT, subprocess_pid INTEGER, tts_chars INTEGER,
        tts_usd REAL, tts_failed INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS pending_length_choices (
        job_id TEXT PRIMARY KEY, chat_id INTEGER, keyboard_msg_id INTEGER,
        source_tmpfile TEXT, tone_prefix TEXT, shape_prefix TEXT, expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS rate_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, handler TEXT, ts INTEGER
      );
    `);

    const { createNarratorHandler, continueNarration, pendingTimeouts } =
      await import('../../src/handlers/narrator.js?mock=updown-dec');

    const ctx = {
      from: { id: 42 },
      chat: { id: 101 },
      message: { text: 'hello world test', message_id: 1 },
      reply: vi.fn().mockResolvedValue({ message_id: 99 }),
      api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
      callbackQuery: undefined,
    };

    await createNarratorHandler(db)(ctx as unknown as import('grammy').Context);

    // Grab the job ID from the pending timeouts map
    const jobIds = [...pendingTimeouts.keys()];
    expect(jobIds.length).toBe(1);
    const jobId = jobIds[0];

    upDownAddSpy.mockClear(); // reset spy so we only check the decrement call

    // Call continueNarration — this should clearTimeout + delete from map → add(-1)
    await continueNarration(jobId, 'medium', ctx as unknown as import('grammy').Context, db, null, null, 99);

    expect(upDownAddSpy).toHaveBeenCalledWith(-1, { bot: 'narrator' });

    vi.doUnmock('../../src/lib/otel.js');
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('../../src/lib/rate-limit.js');
    vi.doUnmock('../../src/lib/classify.js');
    vi.doUnmock('../../src/lib/claude-subprocess.js');
    vi.doUnmock('../../src/delivery/narrator.js');
    vi.doUnmock('node:fs/promises');
  });
});
