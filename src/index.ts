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

  // Graceful shutdown
  process.once('SIGINT', () => narratorBot.stop());
  process.once('SIGTERM', () => narratorBot.stop());

  console.log('dobot-server listening...');
  await narratorBot.start();
}

main().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
