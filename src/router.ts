import { Bot, Context } from 'grammy';
import { getTracer } from './lib/otel.js';

type Handler = (ctx: Context) => Promise<void>;

export function registerHandlers(bot: Bot, handlers: { narrator: Handler }): void {
  // Handler crash boundary: every handler wrapped in try/catch
  bot.on('message', async (ctx) => {
    const tracer = getTracer('narrator');
    const span = tracer.startSpan('handler.narrator.message');
    try {
      await handlers.narrator(ctx);
    } catch (err) {
      console.error('narrator handler threw', err);
      span.recordException(err as Error);
      span.setStatus({ code: 2 /* ERROR */ });
      // Do NOT re-throw — propagation would kill the bot loop
    } finally {
      span.end();
    }
  });
}

// Process-level safety net
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  // Do not exit — log and continue
});
