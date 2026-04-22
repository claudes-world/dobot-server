import { Bot, Context } from 'grammy';
import { getTracer, getMeter } from './lib/otel.js';

const meter = getMeter('router');
const messagesReceived = meter.createCounter('messages_received', {
  description: 'Total incoming message events per bot',
});
const handlerErrors = meter.createCounter('handler_errors', {
  description: 'Total handler errors per bot and handler',
});

type Handler = (ctx: Context) => Promise<void>;

export function registerHandlers(bot: Bot, handlers: {
  narrator: Handler;
  narratorCallback: Handler;
  cancel: Handler;
}, botName = 'narrator'): void {
  // bots using registerHandlers ignore edited_message — see issue #73
  bot.on('edited_message', async (ctx) => {
    try {
      const msgId = ctx.editedMessage?.message_id;
      console.debug(`[router] edited_message ignored (id: ${msgId})`);
    } catch (err) {
      console.error('edited_message handler threw', err);
      // Do NOT re-throw — propagation would kill the bot loop
    }
  });

  // /cancel command — registered before generic message handler so it fires first
  bot.command('cancel', async (ctx) => {
    const tracer = getTracer('narrator');
    const span = tracer.startSpan('handler.narrator.cancel');
    try {
      await handlers.cancel(ctx);
    } catch (err) {
      console.error('cancel handler threw', err);
      span.recordException(err as Error);
      span.setStatus({ code: 2 /* ERROR */ });
      handlerErrors.add(1, { bot: botName, handler: 'cancel' });
    } finally {
      span.end();
    }
  });

  // Handler crash boundary: every handler wrapped in try/catch
  bot.on('message', async (ctx) => {
    messagesReceived.add(1, { bot: botName });
    const tracer = getTracer('narrator');
    const span = tracer.startSpan('handler.narrator.message');
    try {
      await handlers.narrator(ctx);
    } catch (err) {
      console.error('narrator handler threw', err);
      span.recordException(err as Error);
      span.setStatus({ code: 2 /* ERROR */ });
      handlerErrors.add(1, { bot: botName, handler: 'narrator' });
      // Do NOT re-throw — propagation would kill the bot loop
    } finally {
      span.end();
    }
  });

  bot.on('callback_query', async (ctx) => {
    const tracer = getTracer('narrator');
    const span = tracer.startSpan('handler.narrator.callback');
    try {
      await handlers.narratorCallback(ctx);
    } catch (err) {
      console.error('narrator callback handler threw', err);
      span.recordException(err as Error);
      span.setStatus({ code: 2 /* ERROR */ });
      handlerErrors.add(1, { bot: botName, handler: 'narratorCallback' });
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
