import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  telegramNarratorBotToken: required('TELEGRAM_NARRATOR_BOT_TOKEN'),
  telegramIdeaBotToken: process.env['TELEGRAM_IDEA_BOT_TOKEN'],
  dobotDbPath: optional('DOBOT_DB_PATH', '/home/claude/.local/share/dobot-server/state.db'),
  ideaCapture: {
    allowedUserIds: new Set(
      optional('IDEA_ALLOWED_USER_IDS', '').split(',').filter(Boolean).map(Number)
    ),
    ideaFile: optional('IDEA_FILE', '/home/claude/ideas.md'),
    photosDir: path.resolve(process.env['IDEA_PHOTOS_DIR'] ?? path.join(os.homedir(), 'ideas-photos')),
  },
  narrator: {
    allowedUserIds: new Set(
      optional('NARRATOR_ALLOWED_USER_IDS', '').split(',').filter(Boolean).map(Number)
    ),
    agentRunScript: optional('NARRATOR_AGENT_RUN_SCRIPT', '/home/claude/claudes-world/agents/narrator/run.sh'),
    narratorRoot: optional('NARRATOR_ROOT', path.resolve(__dirname, '..', 'agents', 'narrator')),
    classifyModel: optional('NARRATOR_CLASSIFY_MODEL', 'claude-haiku-4-5'),
    rewriteModel: optional('NARRATOR_REWRITE_MODEL', 'claude-sonnet-4-6'),
    claudeTimeout: Number(optional('NARRATOR_CLAUDE_TIMEOUT', '600')) * 1000,
    mdSpeakTimeout: Number(optional('NARRATOR_MDSPEAK_TIMEOUT', '600')) * 1000,
    maxSourceWords: Number(optional('NARRATOR_MAX_SOURCE_WORDS', '8000')),
    storiesDir: optional('NARRATOR_STORIES_DIR', '/home/claude/claudes-world/.world/stories'),
    tmpDir: optional('NARRATOR_TMP_DIR', '/tmp'),
    maxJobsPerHour: Number(optional('NARRATOR_MAX_JOBS_PER_HOUR', '10')),
    maxDailyTtsUsd: Number(optional('NARRATOR_MAX_DAILY_TTS_USD', '5.00')),
    lengthTimeoutMs: Number(optional('NARRATOR_LENGTH_TIMEOUT', '20')) * 1000,
  },
};
