import * as dotenv from 'dotenv';
dotenv.config();

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
  narrator: {
    allowedUserIds: new Set(
      optional('NARRATOR_ALLOWED_USER_IDS', '').split(',').filter(Boolean).map(Number)
    ),
    agentRunScript: optional('NARRATOR_AGENT_RUN_SCRIPT', '/home/claude/claudes-world/agents/narrator/run.sh'),
    classifyModel: optional('NARRATOR_CLASSIFY_MODEL', 'claude-haiku-4-5'),
    rewriteModel: optional('NARRATOR_REWRITE_MODEL', 'claude-sonnet-4-6'),
    claudeTimeout: Number(optional('NARRATOR_CLAUDE_TIMEOUT', '600')) * 1000,
    maxSourceWords: Number(optional('NARRATOR_MAX_SOURCE_WORDS', '8000')),
    storiesDir: optional('NARRATOR_STORIES_DIR', '/home/claude/claudes-world/.world/stories'),
    tmpDir: optional('NARRATOR_TMP_DIR', '/tmp'),
  },
};
