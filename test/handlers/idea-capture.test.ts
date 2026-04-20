import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config FIRST — before any imports that pull in config.ts
vi.mock('../../src/config.js', () => ({
  config: {
    telegramNarratorBotToken: 'test-narrator-token',
    telegramIdeaBotToken: 'test-idea-token',
    ideaCapture: {
      allowedUserIds: new Set([1]),
      ideaFile: '/tmp/test-ideas.md',
      photosDir: '/tmp/ideas-photos',
    },
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

vi.mock('node:fs/promises', () => ({
  default: {
    appendFile: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
  appendFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: 'transcribed text from voice note', stderr: '' }),
}));

import { execa } from 'execa';
import { createIdeaCaptureHandler } from '../../src/handlers/idea-capture.js';

function makeBot(overrides: Record<string, unknown> = {}) {
  return {
    token: 'test-token',
    api: {
      getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file.oga' }),
    },
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    from: { id: 1, first_name: 'Liam', last_name: undefined, username: 'liamtest' },
    chat: { id: 100, type: 'private' },
    message: { text: 'This is my idea text', message_id: 42 },
    reply: vi.fn().mockResolvedValue({ message_id: 99 }),
    ...overrides,
  };
}

// Patch global fetch for download tests
function mockFetch(ok = true) {
  const mockArrayBuffer = new ArrayBuffer(8);
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? 'OK' : 'Not Found',
    arrayBuffer: vi.fn().mockResolvedValue(mockArrayBuffer),
  }) as unknown as typeof fetch;
}

describe('ideaCaptureHandler — text messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch();
  });

  it('1. Text message saved — appendFile called with idea content', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const appendSpy = vi.mocked(fsMock.appendFile);

    const bot = makeBot();
    const ctx = makeCtx();
    const handler = createIdeaCaptureHandler(bot as never);
    await handler(ctx as never);

    expect(appendSpy).toHaveBeenCalledOnce();
    const [filePath, content] = appendSpy.mock.calls[0] as [string, string];
    expect(filePath).toBe('/tmp/test-ideas.md');
    expect(content).toContain('This is my idea text');
    expect(content).toContain('text idea');
    expect(content).toContain('Liam (@liamtest)');
  });

  it('2. Text message saved — bot replies with ✅ Idea saved', async () => {
    const bot = makeBot();
    const ctx = makeCtx();
    const handler = createIdeaCaptureHandler(bot as never);
    await handler(ctx as never);

    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith(
      '✅ Idea saved',
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });

  it('3. Unknown user rejected — no appendFile, no reply', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const appendSpy = vi.mocked(fsMock.appendFile);

    const bot = makeBot();
    const ctx = makeCtx({ from: { id: 999, first_name: 'Stranger' } });
    const handler = createIdeaCaptureHandler(bot as never);
    await handler(ctx as never);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('4. Group message rejected — DM-only filter', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const appendSpy = vi.mocked(fsMock.appendFile);

    const bot = makeBot();
    const ctx = makeCtx({ chat: { id: -100, type: 'supergroup' } });
    const handler = createIdeaCaptureHandler(bot as never);
    await handler(ctx as never);

    expect(appendSpy).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

describe('ideaCaptureHandler — voice messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch();
  });

  it('5. Voice message transcribed and saved', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const appendSpy = vi.mocked(fsMock.appendFile);
    const execaMock = vi.mocked(execa);

    const bot = makeBot();
    const ctx = makeCtx({
      message: {
        message_id: 42,
        voice: { file_id: 'voice-file-id-123', duration: 5 },
      },
    });

    const handler = createIdeaCaptureHandler(bot as never);
    await handler(ctx as never);

    // execa called with transcribe binary and a temp path
    expect(execaMock).toHaveBeenCalledOnce();
    const [bin, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe('/home/claude/bin/transcribe');
    expect(args[0]).toMatch(/idea-voice-[0-9a-f-]+\.oga$/);

    // appendFile called with transcribed content
    expect(appendSpy).toHaveBeenCalledOnce();
    const [, content] = appendSpy.mock.calls[0] as [string, string];
    expect(content).toContain('transcribed text from voice note');
    expect(content).toContain('voice idea');

    // Reply sent
    expect(ctx.reply).toHaveBeenCalledWith(
      '✅ Idea saved',
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });

  it('6. Voice temp file cleaned up after transcription', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const unlinkSpy = vi.mocked(fsMock.unlink);

    const bot = makeBot();
    const ctx = makeCtx({
      message: {
        message_id: 42,
        voice: { file_id: 'voice-file-id-456', duration: 3 },
      },
    });

    const handler = createIdeaCaptureHandler(bot as never);
    await handler(ctx as never);

    expect(unlinkSpy).toHaveBeenCalledOnce();
    const unlinkedPath = unlinkSpy.mock.calls[0][0] as string;
    expect(unlinkedPath).toMatch(/idea-voice-[0-9a-f-]+\.oga$/);
  });
});

describe('ideaCaptureHandler — photo messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch();
  });

  it('7. Photo saved to permanent path (no temp file)', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const writeFileSpy = vi.mocked(fsMock.writeFile);
    const unlinkSpy = vi.mocked(fsMock.unlink);

    const bot = makeBot();
    const ctx = makeCtx({
      message: {
        message_id: 42,
        caption: 'cool idea',
        photo: [
          { file_id: 'photo-small', width: 100, height: 100 },
          { file_id: 'photo-large', width: 800, height: 600 },
        ],
      },
    });

    const handler = createIdeaCaptureHandler(bot as never);
    await handler(ctx as never);

    // Photo written directly to permanent path — no unlink
    expect(unlinkSpy).not.toHaveBeenCalled();
    const writtenPath = writeFileSpy.mock.calls[0][0] as string;
    expect(writtenPath).toMatch(/\/tmp\/ideas-photos\/idea-photo-[0-9a-f-]+\.jpg$/);
  });

  it('8. Photo error reply sent and orphan cleaned up when appendFile fails', async () => {
    const { default: fsMock } = await import('node:fs/promises');
    const appendSpy = vi.mocked(fsMock.appendFile);
    const unlinkSpy = vi.mocked(fsMock.unlink);

    appendSpy.mockRejectedValueOnce(new Error('disk full'));

    const bot = makeBot();
    const ctx = makeCtx({
      message: {
        message_id: 42,
        photo: [{ file_id: 'photo-large', width: 800, height: 600 }],
      },
    });

    const handler = createIdeaCaptureHandler(bot as never);
    await handler(ctx as never);

    // Orphaned permanent photo file should be cleaned up on error
    expect(unlinkSpy).toHaveBeenCalledOnce();
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to save photo/),
    );
  });
});
