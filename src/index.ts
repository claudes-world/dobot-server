import 'dotenv/config';
import { config } from './config.js';
import { createBot } from './bot-factory.js';
import { openDatabase } from './state/db.js';
import { startupSweep } from './state/cleanup.js';
import { registerHandlers } from './router.js';

async function main(): Promise<void> {
  const db = openDatabase(config.dobotDbPath);
  await startupSweep(db);

  const narratorBot = createBot(config.telegramNarratorBotToken);

  // Stub handler — real implementation in #5
  registerHandlers(narratorBot, {
    narrator: async (ctx) => {
      console.log('narrator stub: message from', ctx.from?.id);
    },
  });

  // Graceful shutdown — await bot stop before closing DB so in-flight handlers
  // aren't left with a closed database under their feet.
  const shutdown = async (): Promise<void> => {
    await narratorBot.stop();
    db.close();
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
