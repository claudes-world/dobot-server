import './lib/otel.js';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Bot } from 'grammy';
import { config } from './config.js';
import { createBot } from './bot-factory.js';
import { openDatabase } from './state/db.js';
import { startupSweep, rebuildPendingTimeouts } from './state/cleanup.js';
import { registerHandlers } from './router.js';
import { createNarratorHandler, continueNarration, createCancelHandler } from './handlers/narrator.js';
import { createLengthCallbackHandler } from './handlers/narrator-callback.js';
import { createIdeaCaptureHandler } from './handlers/idea-capture.js';
import { createGatewayMiddleware } from './gateway/middleware.js';
import { dispatchMessage } from './gateway/dispatcher.js';
import type { GatewayRule } from './gateway/types.js';
import { validateGatewayRules } from './gateway/validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadGatewayRules(agentDir: string): GatewayRule[] {
  const gatewayPath = path.resolve(__dirname, '..', 'agents', agentDir, 'gateway.json');
  const raw = readFileSync(gatewayPath, 'utf8');
  const rules = JSON.parse(raw) as GatewayRule[];
  validateGatewayRules(rules, agentDir);
  return rules;
}

async function main(): Promise<void> {
  const db = openDatabase(config.dobotDbPath);
  await startupSweep(db);

  const narratorBot = createBot(config.telegramNarratorBotToken);

  // Rebuild setTimeout handles for in-window pending choices that survived the restart.
  // Must run after bot creation (needs api + me) but before bot.start().
  const me = await narratorBot.api.getMe();
  rebuildPendingTimeouts(db, narratorBot.api, me,
    (jobId, length, ctx, toneOverride, shapeOverride, ackMessageId) => continueNarration(jobId, length, ctx, db, toneOverride, shapeOverride, ackMessageId));

  // Load narrator gateway rules and apply middleware
  const narratorRules = loadGatewayRules('narrator');
  narratorBot.use(createGatewayMiddleware(narratorRules, me.username));

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

    // Load idea-capture gateway rules and apply middleware
    const ideaRules = loadGatewayRules('idea-capture');
    const ideaMe = await ideaBot.api.getMe();
    ideaBot.use(createGatewayMiddleware(ideaRules, ideaMe.username));

    const ideaCaptureHandler = createIdeaCaptureHandler(ideaBot);
    ideaBot.on('message', async (ctx) => {
      await dispatchMessage(ctx, {
        'idea-capture': ideaCaptureHandler,
      });
    });
    ideaBot.catch((err) => {
      console.error('ideaBot: unhandled error in handler', err);
    });
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
  try {
    await Promise.all([narratorBot.start(), ...(ideaBot ? [ideaBot.start()] : [])]);
  } catch (err) {
    console.error('Bot startup failed — shutting down', err);
    await shutdown();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal boot error', err);
  process.exit(1);
});
