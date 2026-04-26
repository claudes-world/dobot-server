import { Context, InlineKeyboard } from 'grammy';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getTracer, getMeter, withSpan } from '../lib/otel.js';

const meter = getMeter('narrator');
export const pendingNarratorTimeouts = meter.createUpDownCounter('pending_narrator_timeouts', {
  description: 'Number of pending narrator length-choice timeouts',
});
import { deliverNarration } from '../delivery/narrator.js';
import { buildSubprocessEnv, spawnClaudeWithRetry, ClaudeEnvelope } from '../lib/claude-subprocess.js';
import { checkAndRecordRate } from '../lib/rate-limit.js';
import { parsePrefix } from '../lib/parse-prefix.js';
import { classifyNarrative } from '../lib/classify.js';
import { detectFilePath, detectUrl } from '../lib/detect-input.js';
import { validateFilePath } from '../lib/path-validator.js';
import { validateAndFetchUrl } from '../lib/url-validator.js';

function narratorSkillPath(...parts: string[]): string {
  return path.join(config.narrator.narratorRoot, ...parts);
}

const SYSTEM_PROMPT_PARTS = [
  narratorSkillPath('.claude', 'output-styles', 'narrator.md'),
  narratorSkillPath('narrative-writing-guide.md'),
];

function buildUserPrompt(tone: string, shape: string): string {
  return `Rewrite the source provided via stdin as a ${tone} ${shape} narrative suitable for text-to-speech playback.
Respond ONLY with the narrative prose — do not write files, do not include preamble, do not add commentary at the end.`;
}

const LENGTH_INSTRUCTIONS: Record<'short' | 'medium' | 'full', string> = {
  short: 'Target length: short (approximately 200-400 words of output).',
  medium: 'Target length: medium (approximately 600-900 words of output).',
  full: 'Target length: full length (approximately 1200-1800 words of output).',
};

const tracer = getTracer('narrator');

// Module-scoped map so callback handler and startup rebuild can clearTimeout by jobId
export const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/** Active narration state per chat — keyed by chat_id. */
interface ActiveJob {
  controller: AbortController;
  jobId: string;
  ackMessageId: number | undefined;
}

/** Map of chat_id → active narration. Populated at start of continueNarration, cleared on finish/cancel. */
export const activeJobs = new Map<number, ActiveJob>();

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

    // 1a. Forwarded message detection — check before plain text extraction
    // Note: forward_origin is the canonical forwarded-message indicator in Bot API 7.x+.
    // forward_date was removed from grammy types in newer versions.
    const forwardOrigin = ctx.message?.forward_origin;
    let sourceTextOverride: string | undefined;

    // Pre-parsed prefix from forwarded message — set when the forwarded text itself
    // contains a [tone:shape] override. Avoids running parsePrefix on the combined
    // attribution+content string where the attribution would shadow the prefix.
    let forwardedPrefixResult: ReturnType<typeof parsePrefix> | undefined;

    if (forwardOrigin) {
      const fwdText = ctx.message?.text ?? ctx.message?.caption;
      if (!fwdText) {
        await ctx.reply('Forwarded message has no text to narrate');
        return;
      }
      // 1. Parse prefix from raw forwarded text BEFORE prepending attribution.
      // This ensures [tone:shape] in the forwarded content is honoured correctly.
      const fwdParsed = parsePrefix(fwdText);
      if ('error' in fwdParsed) {
        await ctx.reply(fwdParsed.error);
        return;
      }
      forwardedPrefixResult = fwdParsed;

      // 2. Prepend channel attribution AFTER prefix stripping
      if (forwardOrigin && (forwardOrigin as { type: string }).type === 'channel') {
        const channelName = (forwardOrigin as { chat?: { title?: string; username?: string } }).chat?.title
          ?? (forwardOrigin as { chat?: { title?: string; username?: string } }).chat?.username
          ?? 'Unknown Channel';
        // sourceTextOverride = attribution + stripped forwarded text (no tone prefix)
        sourceTextOverride = `[Forwarded from ${channelName}]\n\n${fwdParsed.text}`;
      } else {
        sourceTextOverride = fwdParsed.text;
      }
    }

    const rawText = sourceTextOverride ?? ctx.message?.text;
    if (!rawText) return;

    // 1b. Parse prefix — validate tone/shape override before anything else.
    // For forwarded messages, prefix was already parsed from raw fwdText above;
    // skip re-parsing to avoid attribution string shadowing the prefix.
    const prefixResult = forwardedPrefixResult ?? parsePrefix(rawText);
    if ('error' in prefixResult) {
      await ctx.reply(prefixResult.error);
      return;
    }

    // prefixResult.text is the stripped text (prefix removed if found)
    // For forwarded messages, sourceTextOverride already contains the stripped text
    // (with attribution prepended), so use sourceTextOverride if set.
    let sourceText = sourceTextOverride ?? prefixResult.text;
    const tonePrefix = prefixResult.prefixFound ? prefixResult.tone : null;
    const shapePrefix = prefixResult.prefixFound ? prefixResult.shape : null;

    // File-path / URL detection — only run when sourceTextOverride is NOT set.
    // If sourceTextOverride is set (forwarded message), the text is already the source — skip detection.
    const detectedPath = sourceTextOverride ? null : detectFilePath(sourceText.trim());
    if (detectedPath !== null) {
      let resolvedPath: string;
      try {
        resolvedPath = validateFilePath(detectedPath);
      } catch (err) {
        await ctx.reply(`Cannot read file: ${String(err)}`);
        return;
      }
      try {
        sourceText = await fs.readFile(resolvedPath, 'utf8');
      } catch (err) {
        await ctx.reply(`Failed to read file: ${String(err)}`);
        return;
      }
    } else {
      // URL detection — if stripped text contains an HTTPS URL, fetch it as the source.
      const detectedUrl = sourceTextOverride ? null : detectUrl(sourceText.trim());
      if (detectedUrl !== null) {
        try {
          const fetchedContent = await validateAndFetchUrl(detectedUrl);
          // Wrap in untrusted boundary to prevent prompt injection from web content.
          // Escape any closing tag inside the content to prevent early-close injection.
          const escaped = fetchedContent.replace(/<\/untrusted_source\s*>/gi, '<\\/untrusted_source>');
          sourceText = `<untrusted_source>\n${escaped}\n</untrusted_source>`;
        } catch (err) {
          const msg = String(err);
          if (/private IP/i.test(msg) || /SSRF/i.test(msg)) {
            await ctx.reply('Cannot fetch that URL: it resolves to a private or reserved address.');
          } else {
            await ctx.reply(`Failed to fetch URL: ${msg}`);
          }
          return;
        }
      }
    }

    // Empty-body guard — reject prefix-only input (e.g. "[funny]" with no text)
    if (!sourceText.trim()) {
      await ctx.reply('Please include some text after the prefix. Example: [funny] Your text here…');
      return;
    }

    // Word-count guard — reject oversized input before spawning subprocess
    const wordCount = sourceText.split(/\s+/).filter(Boolean).length;
    if (wordCount > config.narrator.maxSourceWords) {
      console.log(`narrator: rejected oversized input (${wordCount} words) from user ${userId}`);
      await ctx.reply('Your source text is too long. Please trim it to under the word limit and try again.');
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
    const chatId = ctx.chat!.id;

    // 2. Insert jobs row — length NULL until user chooses (or timeout defaults to medium)
    db.prepare(`
      INSERT INTO jobs (id, handler, chat_id, user_id, started_at, status, source_kind, tone, shape, length)
      VALUES (?, 'narrator', ?, ?, ?, 'active', 'text', NULL, NULL, NULL)
    `).run(jobId, chatId, userId, now);

    // 3–6. Write temp file, send keyboard, record pending choice, arm timeout.
    // If any step fails, mark job failed and clean up (MEDIUM-3: orphan cleanup on setup failure).
    let sourceTmpFile: string | null = null;
    try {
      sourceTmpFile = path.join(config.narrator.tmpDir, `narrator-src-${jobId}`);
      await fs.writeFile(sourceTmpFile, sourceText);

      // 4. Send inline keyboard as ack
      const keyboard = new InlineKeyboard()
        .text('Short (~2min)', `length:${jobId}:short`)
        .text('Medium (default)', `length:${jobId}:medium`)
        .text('Full length', `length:${jobId}:full`);

      let ackMessageId: number | undefined;
      try {
        const ackMsg = await ctx.reply('Got your text. Choose a length:', {
          reply_parameters: { message_id: ctx.message!.message_id },
          reply_markup: keyboard,
        });
        ackMessageId = ackMsg.message_id;
      } catch (ackErr) {
        console.warn('narrator: ack send failed (best-effort):', ackErr);
      }

      // 5. Record pending length choice — always insert so timeout can fire even if ack failed.
      // keyboard_msg_id = 0 signals ack was not sent (no message to edit on timeout).
      // tone_prefix/shape_prefix non-null only when user provided a [tone:shape] prefix override.
      const expiresAt = Date.now() + config.narrator.lengthTimeoutMs;
      db.prepare(`
        INSERT INTO pending_length_choices (job_id, chat_id, keyboard_msg_id, source_tmpfile, tone_prefix, shape_prefix, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, chatId, ackMessageId ?? 0, sourceTmpFile, tonePrefix, shapePrefix, expiresAt);

      // 6. Default timeout — use medium if user doesn't tap within lengthTimeoutMs
      const timeoutHandle = setTimeout(async () => {
        try {
          // Atomically consume — avoids SELECT+DELETE race with callback path
          const still = db.prepare(`DELETE FROM pending_length_choices WHERE job_id = ? RETURNING *`).get(jobId) as
            | { tone_prefix: string | null; shape_prefix: string | null } | undefined;
          pendingTimeouts.delete(jobId); // Always clean up map entry (MEDIUM-1: prevent leak on early return)
          pendingNarratorTimeouts.add(-1, { bot: 'narrator' });
          if (!still) return; // already handled by callback
          if (ackMessageId) {
            try {
              await ctx.api.editMessageText(chatId, ackMessageId, 'Timed out — using default (medium)');
            } catch { /* swallow */ }
          }
          await continueNarration(jobId, 'medium', ctx, db, still.tone_prefix, still.shape_prefix, ackMessageId);
        } catch (err) {
          console.error(`narrator: unhandled error in timeout for job ${jobId}:`, err);
        }
      }, config.narrator.lengthTimeoutMs);

      pendingTimeouts.set(jobId, timeoutHandle);
      pendingNarratorTimeouts.add(1, { bot: 'narrator' });
    } catch (setupErr) {
      // Clean up orphaned job and temp file
      if (sourceTmpFile) { try { await fs.unlink(sourceTmpFile); } catch { /* already gone */ } }
      db.prepare(`UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`)
        .run(Date.now(), String(setupErr), jobId);
      await ctx.reply('Failed to start narration. Please try again.').catch(() => {});
      return;
    }
  };
}

/**
 * Continue narration after length selection (from callback or timeout).
 * Contains the Claude rewrite + delivery logic.
 */
export async function continueNarration(
  jobId: string,
  length: 'short' | 'medium' | 'full',
  ctx: Context,
  db: Database.Database,
  toneOverride?: string | null,
  shapeOverride?: string | null,
  ackMessageId?: number,
): Promise<void> {
  // Clear any pending timeout for this job (if called from callback)
  const existingTimeout = pendingTimeouts.get(jobId);
  if (existingTimeout !== undefined) {
    clearTimeout(existingTimeout);
    pendingTimeouts.delete(jobId);
    pendingNarratorTimeouts.add(-1, { bot: 'narrator' });
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  const chatId = ctx.chat?.id ?? (ctx.callbackQuery?.message?.chat.id) ?? userId;

  // Register AbortController for this active job — /cancel uses this map
  const controller = new AbortController();

  // Update job row with chosen length
  db.prepare(`UPDATE jobs SET length = ? WHERE id = ?`).run(length, jobId);

  // Read source from tmpfile
  const sourceTmpFile = path.join(config.narrator.tmpDir, `narrator-src-${jobId}`);
  let sourceText: string;
  try {
    sourceText = await fs.readFile(sourceTmpFile, 'utf8');
  } catch (err) {
    console.error(`narrator: could not read source tmpfile for job ${jobId}:`, err);
    try {
      db.prepare(`UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`)
        .run(Date.now(), `source tmpfile missing: ${String(err)}`, jobId);
    } catch { /* DB may be closing */ }
    return;
  }

  // Note: pending_length_choices row is already deleted by the time we run here (callback path deletes it
  // atomically before calling continueNarration; timeout path deletes with RETURNING and passes result inline).
  // Tone/shape overrides are passed in directly via toneOverride/shapeOverride to avoid the race.

  // Typing indicator — record_voice shows "recording voice message..."
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  try {
    await ctx.api.sendChatAction(chatId, 'record_voice');
  } catch { /* ignore */ }
  typingInterval = setInterval(async () => {
    try {
      await ctx.api.sendChatAction(chatId, 'record_voice');
    } catch {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
  }, 4000);

  let sysTmpFile: string | null = null;

  // Register active job — /cancel reads this map
  activeJobs.set(chatId, { controller, jobId, ackMessageId });

  try {
    // Resolve tone + shape:
    // toneOverride/shapeOverride are passed in directly (avoids pending_length_choices race).
    // If no override, classify the source text.
    let tone: string;
    let shape: string;
    if (toneOverride) {
      tone = toneOverride;
      shape = shapeOverride ?? 'origin-story';
      console.log(`narrator: job ${jobId} using prefix override — tone=${tone}, shape=${shape}`);
    } else {
      const classified = await classifyNarrative(sourceText, controller.signal);
      tone = classified.tone;
      shape = classified.shape;
      console.log(`narrator: job ${jobId} classified — tone=${tone}, shape=${shape}, confidence=${classified.confidence}, source=${classified.source}`);
    }

    // Persist resolved tone/shape to jobs row so analytics/debugging sees actual values used
    db.prepare(`UPDATE jobs SET tone = ?, shape = ? WHERE id = ?`).run(tone, shape, jobId);

    // Build system prompt file — base persona + tone skill + shape skill
    sysTmpFile = path.join(config.narrator.tmpDir, `narrator-sys-${jobId}.md`);
    const toneSkillPath = narratorSkillPath('.claude', 'skills', `tone-${tone}`, 'SKILL.md');
    const shapeSkillPath = narratorSkillPath('.claude', 'skills', `shape-${shape}`, 'SKILL.md');

    const systemParts = [...SYSTEM_PROMPT_PARTS];
    // Only append skill files that exist — missing skills are non-fatal (graceful degradation)
    for (const skillPath of [toneSkillPath, shapeSkillPath]) {
      try {
        await fs.access(skillPath);
        systemParts.push(skillPath);
      } catch {
        console.warn(`narrator: skill file not found (skipping): ${skillPath}`);
      }
    }

    const partContents = await Promise.all(systemParts.map(p => fs.readFile(p, 'utf8')));
    await fs.writeFile(sysTmpFile, partContents.join('\n\n---\n\n'));

    const userPrompt = `${buildUserPrompt(tone, shape)}\n${LENGTH_INSTRUCTIONS[length]}`;

    // Spawn narrator subprocess — wrapped in OTEL span
    const result = await withSpan(tracer, 'rewrite.sonnet', {
      job_id: jobId,
      chat_id: String(chatId),
      user_id: String(userId),
      handler_name: 'narrator',
      claude_model: config.narrator.rewriteModel,
    }, async (span) => {
      const r = await spawnNarrator({
        runScript: config.narrator.agentRunScript,
        model: config.narrator.rewriteModel,
        sysFile: sysTmpFile!,
        sourceText,
        userPrompt,
        timeout: config.narrator.claudeTimeout,
        abortSignal: controller.signal,
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

    // Handle error envelope — mark failed and write error column
    if (envelope.is_error) {
      console.error('narrator: claude returned is_error', envelope);
      try {
        db.prepare(`UPDATE jobs SET status = 'failed', completed_at = ?, stop_reason = ?, error = ? WHERE id = ?`)
          .run(Date.now(), envelope.stop_reason ?? null, envelope.result.slice(0, 500), jobId);
      } catch { /* DB may be closing */ }
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

    // Record stop_reason only — status stays 'active' until deliverNarration succeeds
    db.prepare(`UPDATE jobs SET stop_reason = ? WHERE id = ?`).run(stopReason, jobId);

    console.log(`narrator: job ${jobId} rewrite done — stop_reason=${stopReason}, starting delivery`);

    // Guard: check job is still active before invoking paid TTS
    const activeRow = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId) as { status: string } | undefined;
    if (!activeRow || activeRow.status !== 'active') {
      console.warn(`narrator: job ${jobId} no longer active before delivery — skipping`);
      return;
    }

    // Deliver (writes story file, runs md-speak, sends audio, updates output_path/tts_chars/tts_usd)
    await deliverNarration({
      jobId,
      userId,
      narrative,
      stopReason,
      tone,
      shape,
      ctx,
      db,
      ackMessageId,
      abortSignal: controller.signal,
    });

  } catch (err: unknown) {
    const errMsg = String(err);
    // Check if aborted by /cancel — don't overwrite the 'cancelled' status set by cancelHandler
    const wasCancelled = controller.signal.aborted || /aborted|cancel/i.test(errMsg);
    if (!wasCancelled) {
      // Edit ack or send new message with user-friendly error
      const friendlyMsg = `❌ ${userFacingError(err)}`;
      if (ackMessageId) {
        try {
          await ctx.api.editMessageText(chatId, ackMessageId, friendlyMsg);
        } catch { /* swallow */ }
      } else {
        await ctx.reply(friendlyMsg).catch(() => {});
      }
      // Update job row to failed
      try {
        db.prepare(`
          UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?
        `).run(Date.now(), String(err), jobId);
      } catch { /* DB may be closing */ }
      throw err; // re-throw so router crash boundary logs it
    }
    // If cancelled, cancelHandler already updated the job row — swallow the abort error
  } finally {
    // Always remove from activeJobs map — only if we still own this slot
    if (activeJobs.get(chatId)?.jobId === jobId) {
      activeJobs.delete(chatId);
    }
    clearInterval(typingInterval);
    if (sysTmpFile) {
      try { await fs.unlink(sysTmpFile); } catch { /* already gone */ }
    }
    // Clean up source tmpfile
    try { await fs.unlink(sourceTmpFile); } catch { /* already gone */ }
  }
}

interface SpawnOptions {
  runScript: string;
  model: string;
  sysFile: string;
  sourceText: string;
  userPrompt: string;
  timeout: number;
  abortSignal?: AbortSignal;
}

interface SpawnResult {
  envelope: ClaudeEnvelope;
  retried: boolean;
}

async function spawnNarrator(opts: SpawnOptions): Promise<SpawnResult> {
  const args = [
    '-p', opts.userPrompt,
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
  return spawnClaudeWithRetry(opts.runScript, args, opts.sourceText, env, opts.timeout, opts.abortSignal);
}

/**
 * Handle /cancel command — aborts active narration for the chat.
 * Also handles the keyboard-selection phase: if a pending_length_choices row
 * exists for this chat, clears the timeout, deletes the row, and cancels the job
 * before the user's 20s selection window fires.
 */
export function createCancelHandler(db: Database.Database) {
  return async function cancelHandler(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const chatId = ctx.chat!.id;
    const active = activeJobs.get(chatId);

    // 1. Consume all pending keyboard rows for this chat (unconditionally)
    type PendingRow = { job_id: string; chat_id: number; keyboard_msg_id: number | null; source_tmpfile: string; expires_at: number };
    const pendingRows = db.prepare(
      `DELETE FROM pending_length_choices WHERE chat_id = ? RETURNING *`
    ).all(chatId) as PendingRow[];

    // 2. Abort active job immediately (sync — fires signal before any awaits)
    if (active) {
      const { controller, jobId } = active;
      controller.abort();
      try {
        db.prepare(
          `UPDATE jobs SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ? AND status = 'active'`
        ).run(Date.now(), 'cancelled by user', jobId);
      } catch { /* DB may be closing */ }
    }

    // 3. Nothing to cancel if no active job and no pending rows
    if (!active && pendingRows.length === 0) {
      await ctx.reply('Nothing to cancel.').catch(() => {});
      return;
    }

    // 4. Cleanup every pending row (async: clearTimeout, editMessageText, fs.unlink)
    for (const pending of pendingRows) {
      const handle = pendingTimeouts.get(pending.job_id);
      if (handle !== undefined) {
        clearTimeout(handle);
        pendingTimeouts.delete(pending.job_id);
        pendingNarratorTimeouts.add(-1, { bot: 'narrator' });
      }
      try {
        db.prepare(
          `UPDATE jobs SET status = 'cancelled', completed_at = ?, error = ? WHERE id = ? AND status = 'active'`
        ).run(Date.now(), 'cancelled by user', pending.job_id);
      } catch { /* DB may be closing */ }
      if (pending.keyboard_msg_id) {
        try {
          await ctx.api.editMessageText(chatId, pending.keyboard_msg_id, 'Cancelled');
        } catch { /* message may have been deleted */ }
      }
      try { await fs.unlink(pending.source_tmpfile); } catch { /* already gone */ }
    }

    // 5. Edit active-job ack message (async, after abort already fired)
    if (active) {
      const { ackMessageId } = active;
      if (ackMessageId) {
        try {
          await ctx.api.editMessageText(chatId, ackMessageId, 'Cancelled');
        } catch { /* message may have been deleted */ }
      }
    }

    await ctx.reply('Cancelled.').catch(() => {});
  };
}
