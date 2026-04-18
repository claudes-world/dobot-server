import './lib/otel.js';
import 'dotenv/config';
import { config } from './config.js';
import { createBot } from './bot-factory.js';
import { openDatabase } from './state/db.js';
import { startupSweep, rebuildPendingTimeouts } from './state/cleanup.js';
import { registerHandlers } from './router.js';
import { createNarratorHandler, continueNarration } from './handlers/narrator.js';
import { createLengthCallbackHandler } from './handlers/narrator-callback.js';

async function main(): Promise<void> {
  const db = openDatabase(config.dobotDbPath);
  await startupSweep(db);

  const narratorBot = createBot(config.telegramNarratorBotToken);

  // Rebuild setTimeout handles for in-window pending choices that survived the restart.
  // Must run after bot creation (needs api + me) but before bot.start().
  const me = await narratorBot.api.getMe();
  rebuildPendingTimeouts(db, narratorBot.api, me,
    (jobId, length, ctx) => continueNarration(jobId, length, ctx, db));

  registerHandlers(narratorBot, {
    narrator: createNarratorHandler(db),
    narratorCallback: createLengthCallbackHandler(db, (jobId, length, ctx) =>
      continueNarration(jobId, length, ctx, db)
    ),
  });

  // Graceful shutdown — idempotent guard ensures concurrent SIGINT+SIGTERM
  // (e.g. double Ctrl+C) only runs stop/close once.
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await narratorBot.stop();
      db.close();
    })();
    return shutdownPromise;
  };
  process.once('SIGINT', () => { shutdown().catch(console.error); });
  process.once('SIGTERM', () => { shutdown().catch(console.error); });

  console.log('dobot-server listening...');
  await narratorBot.start();
}

main().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
