import { Context } from 'grammy';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getTracer, withSpan } from '../lib/otel.js';
import { deliverNarration } from '../delivery/narrator.js';
import { buildSubprocessEnv, spawnClaudeWithRetry, ClaudeEnvelope } from '../lib/claude-subprocess.js';
import { checkAndRecordRate } from '../lib/rate-limit.js';

const SYSTEM_PROMPT_PARTS = [
  '/home/claude/claudes-world/agents/narrator/.claude/output-styles/narrator.md',
  '/home/claude/claudes-world/agents/narrator/narrative-writing-guide.md',
];

const USER_PROMPT = `Rewrite the source provided via stdin as a serious origin-story narrative suitable for text-to-speech playback.
Target length: medium (approximately 600-900 words of output).
Respond ONLY with the narrative prose — do not write files, do not include preamble, do not add commentary at the end.`;

const tracer = getTracer('narrator');

function userFacingError(err: unknown): string {
  const msg = String(err);
  if (/not logged in|login|401|authentication|oauth/i.test(msg)) {
    return 'Narration service temporarily unavailable. Try again in a moment.';
  }
  if (/timeout|timed out/i.test(msg)) {
    return 'Narration timed out. Try a shorter text.';
  }
  if (/too large|max_tokens|12k/i.test(msg)) {
    return 'Source text too long. Try a shorter excerpt.';
  }
  return 'Something went wrong. Try again or contact the orchestrator.';
}

export function createNarratorHandler(db: Database.Database) {
  return async function narratorHandler(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    // 1. Filter — silently reject if not in allowlist
    if (!config.narrator.allowedUserIds.has(userId)) return;

    // 2. DM-only — silently reject group/supergroup/channel messages (#47)
    if (ctx.chat?.type !== "private") return;

    const sourceText = ctx.message?.text;
    if (!sourceText) return;

    // Word-count guard — reject oversized input before spawning subprocess
    const wordCount = sourceText.split(/\s+/).filter(Boolean).length;
    if (wordCount > config.narrator.maxSourceWords) {
      console.log(`narrator: rejected oversized input (${wordCount} words) from user ${userId}`);
      return;
    }

    // Rate limit check (after text + word-count validation, before Claude — only valid jobs consume quota)
    const rateResult = checkAndRecordRate(db, userId, 'narrator');
    if (rateResult !== 'ok') {
      await ctx.reply(rateResult === 'exceeded-hourly'
        ? 'Rate limit: max 10 narrations per hour. Try again later.'
        : `Daily cost cap reached ($${config.narrator.maxDailyTtsUsd.toFixed(2)}). Resets on a rolling 24-hour window.`);
      return;
    }

    const jobId = randomUUID();
    const now = Date.now();

    // 2. Insert jobs row
    db.prepare(`
      INSERT INTO jobs (id, handler, chat_id, user_id, started_at, status, source_kind, tone, shape, length)
      VALUES (?, 'narrator', ?, ?, ?, 'active', 'text', 'serious', 'origin-story', 'medium')
    `).run(jobId, ctx.chat?.id ?? userId, userId, now);

    // Best-effort ack (don't abort job if ack fails)
    let ackMessageId: number | undefined;
    const chatId = ctx.chat!.id;
    try {
      const ackMsg = await ctx.reply('Got your text. Generating narration...', {
        reply_parameters: { message_id: ctx.message!.message_id },
      });
      ackMessageId = ackMsg.message_id;
    } catch (ackErr) {
      console.warn('narrator: ack send failed (best-effort):', ackErr);
    }

    // Typing indicator — record_voice shows "recording voice message..."
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    try {
      await ctx.api.sendChatAction(chatId, 'record_voice');
    } catch { /* ignore */ }
    typingInterval = setInterval(async () => {
      try {
        await ctx.api.sendChatAction(chatId, 'record_voice');
      } catch {
        // On failure, clear interval, don't retry
        clearInterval(typingInterval);
        typingInterval = undefined;
      }
    }, 4000);

    let sysTmpFile: string | null = null;

    try {
      // 3. Build system prompt file
      sysTmpFile = path.join(config.narrator.tmpDir, `narrator-sys-${jobId}.md`);
      const parts = await Promise.all(SYSTEM_PROMPT_PARTS.map(p => fs.readFile(p, 'utf8')));
      await fs.writeFile(sysTmpFile, parts.join('\n\n---\n\n'));

      // 4. Spawn narrator subprocess — wrapped in OTEL span
      const result = await withSpan(tracer, 'rewrite.sonnet', {
        job_id: jobId,
        chat_id: String(ctx.chat?.id ?? userId),
        user_id: String(userId),
        handler_name: 'narrator',
        claude_model: config.narrator.rewriteModel,
      }, async (span) => {
        const r = await spawnNarrator({
          runScript: config.narrator.agentRunScript,
          model: config.narrator.rewriteModel,
          sysFile: sysTmpFile!,
          sourceText,
          timeout: config.narrator.claudeTimeout,
        });
        span.setAttribute('claude_stop_reason', r.envelope.stop_reason ?? 'unknown');
        const usage = (r.envelope as unknown as Record<string, unknown>)['usage'] as
          | { input_tokens?: number; output_tokens?: number }
          | undefined;
        if (usage) {
          span.setAttribute('claude_tokens_in', usage.input_tokens ?? 0);
          span.setAttribute('claude_tokens_out', usage.output_tokens ?? 0);
        }
        return r;
      });

      const envelope = result.envelope;

      // 5. Handle error envelope — mark failed and write error column
      if (envelope.is_error) {
        console.error('narrator: claude returned is_error', envelope);
        try {
          db.prepare(`UPDATE jobs SET status = 'failed', completed_at = ?, stop_reason = ?, error = ? WHERE id = ?`)
            .run(Date.now(), envelope.stop_reason ?? null, envelope.result.slice(0, 500), jobId);
        } catch { /* DB may be closing */ }
        // Notify user via ack edit or new message
        if (ackMessageId) {
          try {
            await ctx.api.editMessageText(chatId, ackMessageId,
              `❌ Narration failed: Claude returned an error (${envelope.stop_reason ?? 'unknown'})`);
          } catch { /* swallow */ }
        } else {
          await ctx.reply(`❌ Narration failed: Claude returned an error.`).catch(() => {});
        }
        return;
      }

      const narrative = envelope.result;
      const stopReason = envelope.stop_reason ?? 'end_turn';

      // 6. Record stop_reason only — status stays 'active' until deliverNarration succeeds
      // This prevents a phantom completed row if delivery crashes after this point
      db.prepare(`UPDATE jobs SET stop_reason = ? WHERE id = ?`).run(stopReason, jobId);

      console.log(`narrator: job ${jobId} rewrite done — stop_reason=${stopReason}, starting delivery`);

      // Guard: check job is still active before invoking paid TTS
      const activeRow = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId) as { status: string } | undefined;
      if (!activeRow || activeRow.status !== 'active') {
        console.warn(`narrator: job ${jobId} no longer active before delivery — skipping`);
        return;
      }

      // 7. Deliver (writes story file, runs md-speak, sends audio, updates output_path/tts_chars/tts_usd)
      await deliverNarration({
        jobId,
        userId,
        narrative,
        stopReason,
        ctx,
        db,
        ackMessageId,
      });

    } catch (err: unknown) {
      // Edit ack or send new message with user-friendly error
      const friendlyMsg = `❌ ${userFacingError(err)}`;
      if (ackMessageId) {
        try {
          await ctx.api.editMessageText(chatId, ackMessageId, friendlyMsg);
        } catch { /* swallow */ }
      } else {
        await ctx.reply(friendlyMsg).catch(() => {});
      }
      // Update job row to failed — any unhandled throw reaches here
      try {
        db.prepare(`
          UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?
        `).run(Date.now(), String(err), jobId);
      } catch { /* DB may be closing */ }
      throw err;  // re-throw so router crash boundary logs it
    } finally {
      clearInterval(typingInterval);
      if (sysTmpFile) {
        try { await fs.unlink(sysTmpFile); } catch { /* already gone */ }
      }
    }
  };
}

interface SpawnOptions {
  runScript: string;
  model: string;
  sysFile: string;
  sourceText: string;
  timeout: number;
}

interface SpawnResult {
  envelope: ClaudeEnvelope;
  retried: boolean;
}

async function spawnNarrator(opts: SpawnOptions): Promise<SpawnResult> {
  const args = [
    '-p', USER_PROMPT,
    '--output-format', 'json',
    '--append-system-prompt-file', opts.sysFile,
    '--model', opts.model,
    '--allowedTools', '',  // zero-tool allowlist — narrator rewrite needs no tools; empty allowlist > denylist
  ];
  // OAuth-only per ADR 0013 — ANTHROPIC_API_KEY intentionally excluded.
  // run.sh sets CLAUDE_CONFIG_DIR pointing to .credentials.json symlink.
  // buildSubprocessEnv allowlist: PATH, HOME, TZ only — TELEGRAM_*/NARRATOR_*/ANTHROPIC_* never forwarded.
  const env = buildSubprocessEnv(process.env, {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '12000',
  });
  return spawnClaudeWithRetry(opts.runScript, args, opts.sourceText, env, opts.timeout);
}
