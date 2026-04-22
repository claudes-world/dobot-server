import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerHandlers } from '../src/router.js';

// Minimal grammY Bot fake — captures registered handlers by event name
function makeFakeBot() {
  let messageHandler: ((ctx: unknown) => Promise<void>) | null = null;
  let editedMessageHandler: ((ctx: unknown) => Promise<void>) | null = null;
  const bot = {
    command: vi.fn(),
    on: (event: string, fn: (ctx: unknown) => Promise<void>) => {
      if (event === 'message') messageHandler = fn;
      if (event === 'edited_message') editedMessageHandler = fn;
    },
    fire: async (ctx: unknown) => {
      if (messageHandler) await messageHandler(ctx);
    },
    fireEdit: async (ctx: unknown) => {
      if (editedMessageHandler) await editedMessageHandler(ctx);
    },
  };
  return bot as unknown as import('grammy').Bot & {
    fire: (ctx: unknown) => Promise<void>;
    fireEdit: (ctx: unknown) => Promise<void>;
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    reply: vi.fn().mockResolvedValue(undefined),
    from: { id: 1 },
    chat: { id: 1 },
    message: { text: 'hello' },
    ...overrides,
  };
}

describe('router crash boundary', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress error output during crash boundary tests
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('catches sync handler throw', async () => {
    const bot = makeFakeBot();
    const narrator = vi.fn().mockImplementation(() => {
      throw new Error('synthetic');
    });
    registerHandlers(bot, { narrator, narratorCallback: vi.fn(), cancel: vi.fn() });
    await expect(bot.fire(makeCtx())).resolves.not.toThrow();
  });

  it('catches async handler throw', async () => {
    const bot = makeFakeBot();
    const narrator = vi.fn().mockRejectedValue(new Error('async-throw'));
    registerHandlers(bot, { narrator, narratorCallback: vi.fn(), cancel: vi.fn() });
    await expect(bot.fire(makeCtx())).resolves.not.toThrow();
  });

  it('catches rejected promise return', async () => {
    const bot = makeFakeBot();
    const narrator = vi.fn().mockReturnValue(Promise.reject(new Error('rejected')));
    registerHandlers(bot, { narrator, narratorCallback: vi.fn(), cancel: vi.fn() });
    await expect(bot.fire(makeCtx())).resolves.not.toThrow();
  });

  it('calls span.end() even when handler throws', async () => {
    const mockSpan = {
      end: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
    };
    const mockTracer = { startSpan: vi.fn().mockReturnValue(mockSpan) };

    // Use doMock (not hoisted vi.mock) so we can set up inline
    vi.doMock('../src/lib/otel.js', () => ({
      getTracer: () => mockTracer,
    }));

    // Re-import router with the mock active
    const { registerHandlers: registerHandlersMocked } = await import('../src/router.js?mock=otel');

    try {
      const bot = makeFakeBot();
      const narrator = vi.fn().mockRejectedValue(new Error('otel-test'));
      registerHandlersMocked(bot, { narrator, narratorCallback: vi.fn(), cancel: vi.fn() });
      await bot.fire(makeCtx());

      // span.end() must be called via finally even on handler throw
      expect(mockSpan.end).toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/lib/otel.js');
    }
  });

  it('catches ctx.reply throwing', async () => {
    const bot = makeFakeBot();
    const ctx = makeCtx({
      reply: vi.fn().mockRejectedValue(new Error('Telegram API error')),
    });
    const narrator = vi.fn().mockImplementation(async (c: typeof ctx) => {
      await (c as typeof ctx).reply('test');
    });
    registerHandlers(bot, { narrator, narratorCallback: vi.fn(), cancel: vi.fn() });
    await expect(bot.fire(ctx)).resolves.not.toThrow();
  });

  it('process.unhandledRejection handler logs without calling process.exit', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: string | number | null) => {
        throw new Error('should not exit');
      });

    // Emit an unhandledRejection directly on the process event emitter
    // (avoids creating a truly unhandled promise which vitest may intercept)
    const reason = new Error('orphan');
    process.emit('unhandledRejection', reason, Promise.resolve());

    // The handler in router.ts logs via console.error — verify it ran
    expect(consoleSpy).toHaveBeenCalledWith('unhandledRejection', reason);

    // And crucially: process.exit was NOT called
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});

describe('router edited_message handling', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it('registers an edited_message handler (not silently dropped at grammy level)', () => {
    const handlers: string[] = [];
    const bot = {
      command: vi.fn(),
      on: (event: string, _fn: unknown) => { handlers.push(event); },
    } as unknown as import('grammy').Bot;
    registerHandlers(bot, { narrator: vi.fn(), narratorCallback: vi.fn(), cancel: vi.fn() });
    expect(handlers).toContain('edited_message');
  });

  it('logs ignore and does not call narrator handler on edited_message', async () => {
    const bot = makeFakeBot();
    const narrator = vi.fn();
    registerHandlers(bot, { narrator, narratorCallback: vi.fn(), cancel: vi.fn() });

    const editCtx = {
      editedMessage: { message_id: 42, text: 'edited text' },
    };
    await bot.fireEdit(editCtx);

    expect(narrator).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith('[router] edited_message ignored (id: 42)');
  });

  it('does not trigger narrator callback on edited_message', async () => {
    const bot = makeFakeBot();
    const narrator = vi.fn();
    const narratorCallback = vi.fn();
    registerHandlers(bot, { narrator, narratorCallback, cancel: vi.fn() });

    const editCtx = {
      editedMessage: { message_id: 99, text: 'updated idea' },
    };
    await bot.fireEdit(editCtx);

    // Neither the narrator handler nor the callback should fire
    expect(narrator).not.toHaveBeenCalled();
    expect(narratorCallback).not.toHaveBeenCalled();
  });

  it('handles missing editedMessage gracefully', async () => {
    const bot = makeFakeBot();
    registerHandlers(bot, { narrator: vi.fn(), narratorCallback: vi.fn(), cancel: vi.fn() });

    // editedMessage may be undefined in edge cases
    const editCtx = { editedMessage: undefined };
    await expect(bot.fireEdit(editCtx)).resolves.not.toThrow();
    expect(debugSpy).toHaveBeenCalledWith('[router] edited_message ignored (id: undefined)');
  });
});
