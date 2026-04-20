import './lib/otel.js';
import 'dotenv/config';
import { Bot } from 'grammy';
import { config } from './config.js';
import { createBot } from './bot-factory.js';
import { openDatabase } from './state/db.js';
import { startupSweep, rebuildPendingTimeouts } from './state/cleanup.js';
import { registerHandlers } from './router.js';
import { createNarratorHandler, continueNarration, createCancelHandler } from './handlers/narrator.js';
import { createLengthCallbackHandler } from './handlers/narrator-callback.js';
import { createIdeaCaptureHandler } from './handlers/idea-capture.js';

async function main(): Promise<void> {
  const db = openDatabase(config.dobotDbPath);
  await startupSweep(db);

  const narratorBot = createBot(config.telegramNarratorBotToken);

  // Rebuild setTimeout handles for in-window pending choices that survived the restart.
  // Must run after bot creation (needs api + me) but before bot.start().
  const me = await narratorBot.api.getMe();
  rebuildPendingTimeouts(db, narratorBot.api, me,
    (jobId, length, ctx, toneOverride, shapeOverride, ackMessageId) => continueNarration(jobId, length, ctx, db, toneOverride, shapeOverride, ackMessageId));

  registerHandlers(narratorBot, {
    narrator: createNarratorHandler(db),
    narratorCallback: createLengthCallbackHandler(db, (jobId, length, ctx, toneOverride, shapeOverride, ackMessageId) =>
      continueNarration(jobId, length, ctx, db, toneOverride, shapeOverride, ackMessageId)
    ),
    cancel: createCancelHandler(db),
  });

  // Wire idea capture bot if token is configured
  let ideaBot: Bot | undefined;
  const ideaBotToken = config.telegramIdeaBotToken;
  if (ideaBotToken) {
    ideaBot = createBot(ideaBotToken);
    ideaBot.on('message', createIdeaCaptureHandler(ideaBot));
    console.log('dobot-server: idea capture bot enabled');
  } else {
    console.warn('dobot-server: TELEGRAM_IDEA_BOT_TOKEN not set — idea capture bot disabled');
  }

  // Graceful shutdown — idempotent guard ensures concurrent SIGINT+SIGTERM
  // (e.g. double Ctrl+C) only runs stop/close once.
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await narratorBot.stop();
      if (ideaBot) await ideaBot.stop();
      db.close();
    })();
    return shutdownPromise;
  };
  process.once('SIGINT', () => { shutdown().catch(console.error); });
  process.once('SIGTERM', () => { shutdown().catch(console.error); });

  console.log('dobot-server listening...');
  const botPromises: Promise<void>[] = [narratorBot.start()];
  if (ideaBot) botPromises.push(ideaBot.start());
  await Promise.all(botPromises);
}

main().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
