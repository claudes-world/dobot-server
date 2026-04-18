import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerHandlers } from '../src/router.js';

// Minimal grammY Bot fake — captures the registered 'message' handler
function makeFakeBot() {
  let messageHandler: ((ctx: unknown) => Promise<void>) | null = null;
  const bot = {
    on: (event: string, fn: (ctx: unknown) => Promise<void>) => {
      if (event === 'message') messageHandler = fn;
    },
    fire: async (ctx: unknown) => {
      if (messageHandler) await messageHandler(ctx);
    },
  };
  return bot as unknown as import('grammy').Bot & { fire: (ctx: unknown) => Promise<void> };
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
    registerHandlers(bot, { narrator });
    await expect(bot.fire(makeCtx())).resolves.not.toThrow();
  });

  it('catches async handler throw', async () => {
    const bot = makeFakeBot();
    const narrator = vi.fn().mockRejectedValue(new Error('async-throw'));
    registerHandlers(bot, { narrator });
    await expect(bot.fire(makeCtx())).resolves.not.toThrow();
  });

  it('catches rejected promise return', async () => {
    const bot = makeFakeBot();
    const narrator = vi.fn().mockReturnValue(Promise.reject(new Error('rejected')));
    registerHandlers(bot, { narrator });
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
      registerHandlersMocked(bot, { narrator });
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
    registerHandlers(bot, { narrator });
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
