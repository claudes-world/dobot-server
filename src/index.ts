import './lib/otel.js';
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
import { createHealthServer } from './health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// sd-notify is a CJS module with a native binding — load via createRequire
const _require = createRequire(import.meta.url);
const sdNotify = _require('sd-notify') as {
  ready: () => void;
  watchdog: () => void;
  startWatchdogMode: (intervalMs: number) => void;
  stopWatchdogMode: () => void;
};

const HEALTH_PORT = 38801;

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

  // Start health HTTP server
  const healthServer = createHealthServer();
  await new Promise<void>((resolve, reject) => {
    healthServer.listen(HEALTH_PORT, '127.0.0.1', resolve);
    healthServer.once('error', reject);
  });
  console.log(`dobot-server: health endpoint listening on 127.0.0.1:${HEALTH_PORT}`);

  // Graceful shutdown — idempotent guard ensures concurrent SIGINT+SIGTERM
  // (e.g. double Ctrl+C) only runs stop/close once.
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      sdNotify.stopWatchdogMode();
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
      await narratorBot.stop();
      if (ideaBot) await ideaBot.stop();
      db.close();
    })();
    return shutdownPromise;
  };
  process.once('SIGINT', () => { shutdown().catch(console.error); });
  process.once('SIGTERM', () => { shutdown().catch(console.error); });

  // Signal systemd ready + start watchdog heartbeat only after ALL bots are confirmed polling.
  // grammy's onStart fires when long-polling has successfully entered the update loop.
  // Use a countdown so READY= is sent only when every configured bot is live.
  const botCount = ideaBot ? 2 : 1;
  let botsStarted = 0;
  const onBotStart = () => {
    botsStarted++;
    if (botsStarted === botCount) {
      sdNotify.ready();
      sdNotify.startWatchdogMode(15_000);
      console.log('dobot-server: sd_notify READY sent');
    }
  };

  console.log('dobot-server listening...');
  try {
    await Promise.all([
      narratorBot.start({ onStart: onBotStart }),
      ...(ideaBot ? [ideaBot.start({ onStart: onBotStart })] : []),
    ]);
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
