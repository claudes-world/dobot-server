import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createLengthCallbackHandler } from '../../src/handlers/narrator-callback.js';

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
  `);
  return db;
}

function insertJob(db: Database.Database, jobId: string, chatId = 100) {
  db.prepare(`
    INSERT INTO jobs (id, handler, chat_id, user_id, started_at, status)
    VALUES (?, 'narrator', ?, 1, ?, 'active')
  `).run(jobId, chatId, Date.now());
}

function insertPending(db: Database.Database, jobId: string, chatId = 100, keyboardMsgId = 99) {
  db.prepare(`
    INSERT INTO pending_length_choices (job_id, chat_id, keyboard_msg_id, source_tmpfile, tone_prefix, shape_prefix, expires_at)
    VALUES (?, ?, ?, '/tmp/narrator-src-test', NULL, NULL, ?)
  `).run(jobId, chatId, keyboardMsgId, Date.now() + 20000);
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    callbackQuery: { data: '' },
    from: { id: 1 },
    chat: { id: 100 },
    message: { message_id: 42 },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    api: {
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    },
    reply: vi.fn().mockResolvedValue({ message_id: 99 }),
    ...overrides,
  };
}

describe('narratorCallbackHandler', () => {
  let db: Database.Database;
  let onLengthChosen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDb();
    onLengthChosen = vi.fn().mockResolvedValue(undefined);
    vi.clearAllMocks();
  });

  it('1. Valid callback (length:jobId:medium) with pending row — deletes row, edits message, calls onLengthChosen', async () => {
    const jobId = 'job-test-1';
    insertJob(db, jobId);
    insertPending(db, jobId, 100, 99);

    const ctx = makeCtx({
      callbackQuery: { data: `length:${jobId}:medium` },
    });

    const handler = createLengthCallbackHandler(db, onLengthChosen);
    await handler(ctx as never);

    // Pending row should be deleted
    const row = db.prepare(`SELECT * FROM pending_length_choices WHERE job_id = ?`).get(jobId);
    expect(row).toBeUndefined();

    // Edit message called
    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('medium'));

    // Answer callback
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();

    // onLengthChosen invoked with correct args (tone/shape prefix are null — not set in insertPending)
    expect(onLengthChosen).toHaveBeenCalledWith(jobId, 'medium', ctx, null, null, 99);
  });

  it('2. Expired/missing callback_data (no "length:" prefix) — answers callback, no crash', async () => {
    const ctx = makeCtx({
      callbackQuery: { data: 'some-other-data' },
    });

    const handler = createLengthCallbackHandler(db, onLengthChosen);
    await expect(handler(ctx as never)).resolves.not.toThrow();

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(onLengthChosen).not.toHaveBeenCalled();
  });

  it('2b. Malformed data (too many/few parts) — answers callback with error text, no crash', async () => {
    const ctx = makeCtx({
      callbackQuery: { data: 'length:onlytwoparts' },
    });

    const handler = createLengthCallbackHandler(db, onLengthChosen);
    await expect(handler(ctx as never)).resolves.not.toThrow();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Invalid selection.' });
    expect(onLengthChosen).not.toHaveBeenCalled();
  });

  it('3. Unknown jobId (stale keyboard) — edits message to expired text, answers callback, no crash', async () => {
    const jobId = 'job-nonexistent';

    const ctx = makeCtx({
      callbackQuery: { data: `length:${jobId}:short` },
    });

    const handler = createLengthCallbackHandler(db, onLengthChosen);
    await expect(handler(ctx as never)).resolves.not.toThrow();

    expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'This selection has expired.' });
    expect(onLengthChosen).not.toHaveBeenCalled();
  });

  it('4. Sweep: 2 other pending keyboards for same chat_id get their reply_markup removed', async () => {
    const jobId = 'job-main';
    const jobIdOther1 = 'job-other-1';
    const jobIdOther2 = 'job-other-2';
    const chatId = 100;

    insertJob(db, jobId, chatId);
    insertJob(db, jobIdOther1, chatId);
    insertJob(db, jobIdOther2, chatId);

    insertPending(db, jobId, chatId, 99);
    insertPending(db, jobIdOther1, chatId, 201);
    insertPending(db, jobIdOther2, chatId, 202);

    const ctx = makeCtx({
      callbackQuery: { data: `length:${jobId}:full` },
    });

    const handler = createLengthCallbackHandler(db, onLengthChosen);
    await handler(ctx as never);

    // Both other keyboards should have reply_markup removed
    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(ctx.api.editMessageReplyMarkup).mock.calls;
    const removedMsgIds = calls.map(c => c[1]);
    expect(removedMsgIds).toContain(201);
    expect(removedMsgIds).toContain(202);

    // Other pending rows should be deleted from DB
    const other1 = db.prepare(`SELECT * FROM pending_length_choices WHERE job_id = ?`).get(jobIdOther1);
    const other2 = db.prepare(`SELECT * FROM pending_length_choices WHERE job_id = ?`).get(jobIdOther2);
    expect(other1).toBeUndefined();
    expect(other2).toBeUndefined();

    // onLengthChosen still called for main job (tone/shape prefix null — not set in insertPending)
    expect(onLengthChosen).toHaveBeenCalledWith(jobId, 'full', ctx, null, null, 99);
  });

  it('5. Invalid length value — answers callback with error, no crash, onLengthChosen not called', async () => {
    const jobId = 'job-invalid-len';
    insertJob(db, jobId);
    insertPending(db, jobId);

    const ctx = makeCtx({
      callbackQuery: { data: `length:${jobId}:superlong` },
    });

    const handler = createLengthCallbackHandler(db, onLengthChosen);
    await expect(handler(ctx as never)).resolves.not.toThrow();

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Invalid length.' });
    expect(onLengthChosen).not.toHaveBeenCalled();
  });
});
