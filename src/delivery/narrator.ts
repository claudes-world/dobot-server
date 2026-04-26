import { Context, InputFile } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { buildSubprocessEnv } from '../lib/claude-subprocess.js';
import { recordSpend } from '../lib/rate-limit.js';
import { toBase64url } from '../lib/telegram.js';

type TtsFailReason = 'timeout' | 'gcp' | 'f3_silent' | 'generic';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTtsErrorMessage(reason: TtsFailReason, timeoutSecs: number, stderr: string): string {
  switch (reason) {
    case 'timeout':
      return `✅ Narrative generated\n❌ Audio timed out — generation exceeded ${timeoutSecs}s and was cancelled.\n\nThe narrative may be unusually long. Try requesting a shorter version, or use the text below.`;
    case 'gcp': {
      const base = '✅ Narrative generated\n❌ Audio unavailable — TTS service error (authentication or quota issue).\n\nThis is a server-side problem, not your text. Retry in a few minutes or notify the operator.';
      return stderr ? `${base}\n<blockquote expandable>${escapeHtml(stderr)}</blockquote>` : base;
    }
    case 'f3_silent':
      return '✅ Narrative generated\n❌ Audio failed — TTS ran but produced no output file (possible ffmpeg or disk issue).\n\nText version below. Operator: check ffmpeg availability and disk space.';
    default:
      return '✅ Narrative generated\n❌ Audio failed — unexpected error during TTS generation.\n\nText version below. Check server logs for details.';
  }
}

async function sendAudio(
  mp3Path: string,
  caption: string,
  keyboard: InlineKeyboard,
  deepLink: string,
  ctx: Context,
): Promise<void> {
  const mp3Stat = await fs.stat(mp3Path);
  const mp3Size = mp3Stat.size;
  const hasKeyboard = { reply_markup: keyboard };

  if (mp3Size < 1_000_000) {
    await ctx.replyWithVoice(new InputFile(mp3Path), { caption, ...hasKeyboard });
  } else if (mp3Size <= 50_000_000) {
    await ctx.replyWithAudio(new InputFile(mp3Path), { caption, ...hasKeyboard });
  } else {
    try {
      const pubResult = await execa('publish-shared', ['--tmp', 'private', mp3Path], {
        extendEnv: false,
        env: buildSubprocessEnv(process.env, {
          ...(process.env['GOOGLE_APPLICATION_CREDENTIALS'] ? { GOOGLE_APPLICATION_CREDENTIALS: process.env['GOOGLE_APPLICATION_CREDENTIALS']! } : {}),
          ...(process.env['GOOGLE_CLOUD_PROJECT'] ? { GOOGLE_CLOUD_PROJECT: process.env['GOOGLE_CLOUD_PROJECT']! } : {}),
          ...(process.env['SHARED_PRIVATE_BASE_URL'] ? { SHARED_PRIVATE_BASE_URL: process.env['SHARED_PRIVATE_BASE_URL']! } : {}),
        }),
        timeout: 60000,
      });
      const urlLine2 = pubResult.stdout.split('\n').find(l => l.startsWith('URL: '));
      const shareUrl = urlLine2 ? urlLine2.replace(/^URL:\s*/, '').trim() : '';
      if (!shareUrl) throw new Error('publish-shared did not output a URL line');
      const urlKeyboard = new InlineKeyboard()
        .url('Download audio', shareUrl).row()
        .url('Read in Pocket Console', deepLink);
      await ctx.reply(caption, { reply_markup: urlKeyboard });
    } catch (pubErr) {
      console.error('narrator: publish-shared failed:', pubErr);
      await ctx.reply(`${caption}\n\n(Audio too large to send directly — ${Math.round(mp3Size / 1_000_000)}MB)`, { reply_markup: keyboard });
    }
  }
}

export interface DeliveryOptions {
  jobId: string;
  userId: number;
  narrative: string;
  stopReason: string;
  tone: string;
  shape: string;
  ctx: Context;
  db: Database.Database;
  ackMessageId?: number;
  abortSignal?: AbortSignal;
}

export async function deliverNarration(opts: DeliveryOptions): Promise<void> {
  const { jobId, userId, narrative, stopReason, tone, shape, ctx, db, ackMessageId, abortSignal } = opts;

  // 1. Build story file path
  const now = new Date();
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = tzFormatter.formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  const timestamp = `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}${get('second')}`;

  // Derive slug from first non-empty line of narrative
  const firstLine = narrative.split('\n').find(l => l.trim()) ?? 'narrative';
  const slug = firstLine.replace(/^#+\s*/, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  const storiesDir = config.narrator.storiesDir;
  await fs.mkdir(storiesDir, { recursive: true });
  const mdPath = path.join(storiesDir, `${timestamp}-${jobId.slice(0, 8)}-${slug}.narration.md`);

  // Ensure narrative starts with H1 (share-doc requirement)
  let finalNarrative = narrative;
  if (!narrative.trimStart().startsWith('#')) {
    const title = firstLine.slice(0, 60);
    finalNarrative = `# ${title}\n\n${narrative}`;
  }
  await fs.writeFile(mdPath, finalNarrative);

  // 2. Construct CPC deep link directly from mdPath
  const deepLink: string = `https://t.me/claude_do_bot/pocket?startapp=${toBase64url(mdPath)}`;

  // 3. Invoke md-speak --no-describe to generate audio
  const mp3Path = mdPath.replace(/\.md$/, '.mp3');
  let ttsChars = 0;
  let ttsDurationMs = 0;
  let audioGenerated = false;
  let ttsFailReason: TtsFailReason = 'generic';
  let ttsStderr = '';

  const mdSpeakStart = Date.now();
  try {
    if (abortSignal?.aborted) {
      throw new Error('aborted');
    }
    await execa('md-speak', ['--no-describe', mdPath], {
      extendEnv: false,
      env: buildSubprocessEnv(process.env, {
        ...(process.env['GOOGLE_APPLICATION_CREDENTIALS'] ? { GOOGLE_APPLICATION_CREDENTIALS: process.env['GOOGLE_APPLICATION_CREDENTIALS']! } : {}),
        ...(process.env['GOOGLE_CLOUD_PROJECT'] ? { GOOGLE_CLOUD_PROJECT: process.env['GOOGLE_CLOUD_PROJECT']! } : {}),
      }),
      timeout: config.narrator.mdSpeakTimeout,
      cleanup: true,
      killSignal: 'SIGKILL',
      cancelSignal: abortSignal,
    });
    ttsDurationMs = Date.now() - mdSpeakStart;
    // Check if mp3 was generated
    try {
      await fs.access(mp3Path);
      audioGenerated = true;
      ttsChars = finalNarrative.length;
    } catch (f3Err) {
      console.warn('narrator: mp3 not produced', { mp3Path, err: f3Err });
      ttsFailReason = 'f3_silent';
    }
  } catch (err) {
    console.error('narrator: md-speak failed:', err);
    const e = err as Record<string, unknown>;
    if (e.timedOut === true) {
      ttsFailReason = 'timeout';
    } else if (!/aborted|cancel/i.test(String(e.message ?? ''))) {
      const stderr = String(e.stderr ?? e.message ?? '');
      ttsStderr = stderr.slice(0, 3800);
      if (/google\.auth|credentials|PERMISSION_DENIED|quota|RESOURCE_EXHAUSTED/i.test(stderr)) {
        ttsFailReason = 'gcp';
      }
    }
  }

  // 4. Build inline keyboard
  const keyboard = new InlineKeyboard();
  keyboard.url('Read in Pocket Console', deepLink);

  // 5. Deliver audio or markdown-only fallback
  if (audioGenerated) {
    const truncatedWarning = stopReason === 'max_tokens' ? ' ⚠️ truncated (max_tokens — 12k cap)' : '';
    const caption = `tone: ${tone} | shape: ${shape} | tts_chars: ${ttsChars}${truncatedWarning}`;
    await sendAudio(mp3Path, caption, keyboard, deepLink, ctx);

    if (ackMessageId) {
      try {
        await ctx.api.editMessageText(ctx.chat!.id, ackMessageId, '✅ Narration complete');
      } catch { /* swallow — ack message may have been deleted */ }
    }
  } else {
    const timeoutSecs = Math.round(config.narrator.mdSpeakTimeout / 1000);
    const partialMsg = buildTtsErrorMessage(ttsFailReason, timeoutSecs, ttsStderr);
    const retryKeyboard = new InlineKeyboard()
      .text('Retry audio', `retry_audio:${jobId}`)
      .url('View text', deepLink);
    const replyOpts: Parameters<typeof ctx.reply>[1] = { reply_markup: retryKeyboard };
    if (ttsFailReason === 'gcp' && ttsStderr) (replyOpts as Record<string, unknown>)['parse_mode'] = 'HTML';
    await ctx.reply(partialMsg, replyOpts);

    // Edit ack to reflect partial success
    if (ackMessageId) {
      try {
        await ctx.api.editMessageText(ctx.chat!.id, ackMessageId, '✅ Narration complete (text only — audio unavailable)');
      } catch { /* swallow — ack message may have been deleted */ }
    }
  }

  // Suppress unused variable warning — ttsDurationMs is available for future telemetry
  void ttsDurationMs;

  // 7. Update jobs row — mark completed here (after delivery succeeds) so a crash during delivery
  // leaves the job as 'active', not phantom-completed
  const ttsUsd = ttsChars > 0 ? (ttsChars / 1_000_000) * 16.0 : 0; // Google TTS ~$16/M chars WaveNet
  try {
    const result = db.prepare(`
      UPDATE jobs SET
        status = 'completed',
        completed_at = ?,
        output_path = ?,
        tts_chars = ?,
        tts_usd = ?,
        tts_failed = ?
      WHERE id = ? AND status = 'active'
    `).run(Date.now(), mdPath, ttsChars, ttsUsd, audioGenerated ? 0 : 1, jobId);
    if ((result as { changes: number }).changes === 0) {
      console.warn(`narrator: job ${jobId} status was not active at completion — skipping completed update`);
    } else if (ttsUsd > 0) {
      // Record spend for daily cap enforcement — only on successful job completion
      try {
        recordSpend(db, userId, ttsUsd);
      } catch (spendErr) {
        console.error('narrator: recordSpend failed (non-fatal):', spendErr);
      }
    }
  } catch (dbErr) {
    console.error('narrator: DB update failed after delivery:', dbErr);
  }
}

export async function retryAudio(
  jobId: string,
  userId: number,
  mdPath: string,
  tone: string,
  shape: string,
  stopReason: string,
  ctx: Context,
  db: Database.Database,
): Promise<void> {
  const mp3Path = mdPath.replace(/\.md$/, '.mp3');
  const deepLink = `https://t.me/claude_do_bot/pocket?startapp=${toBase64url(mdPath)}`;

  let finalNarrative = '';
  try {
    finalNarrative = await fs.readFile(mdPath, 'utf8');
  } catch {
    const kb = new InlineKeyboard().url('View text', deepLink);
    await ctx.reply('❌ Cannot retry — narrative file missing from disk.', { reply_markup: kb }).catch(() => {});
    return;
  }

  let ttsFailReason: TtsFailReason = 'generic';
  let ttsStderr = '';
  let audioGenerated = false;
  let ttsChars = 0;

  try {
    await execa('md-speak', ['--no-describe', mdPath], {
      extendEnv: false,
      env: buildSubprocessEnv(process.env, {
        ...(process.env['GOOGLE_APPLICATION_CREDENTIALS'] ? { GOOGLE_APPLICATION_CREDENTIALS: process.env['GOOGLE_APPLICATION_CREDENTIALS']! } : {}),
        ...(process.env['GOOGLE_CLOUD_PROJECT'] ? { GOOGLE_CLOUD_PROJECT: process.env['GOOGLE_CLOUD_PROJECT']! } : {}),
      }),
      timeout: config.narrator.mdSpeakTimeout,
      cleanup: true,
      killSignal: 'SIGKILL',
    });
    try {
      await fs.access(mp3Path);
      audioGenerated = true;
      ttsChars = finalNarrative.length;
    } catch (f3Err) {
      console.warn('narrator: retry: mp3 not produced', { mp3Path, err: f3Err });
      ttsFailReason = 'f3_silent';
    }
  } catch (err) {
    console.error('narrator: retry: md-speak failed:', err);
    const e = err as Record<string, unknown>;
    if (e.timedOut === true) {
      ttsFailReason = 'timeout';
    } else {
      const stderr = String(e.stderr ?? e.message ?? '');
      ttsStderr = stderr.slice(0, 3800);
      if (/google\.auth|credentials|PERMISSION_DENIED|quota|RESOURCE_EXHAUSTED/i.test(stderr)) {
        ttsFailReason = 'gcp';
      }
    }
  }

  const truncatedWarning = stopReason === 'max_tokens' ? ' ⚠️ truncated (max_tokens — 12k cap)' : '';
  const caption = `tone: ${tone} | shape: ${shape} | tts_chars: ${ttsChars}${truncatedWarning}`;
  const keyboard = new InlineKeyboard().url('Read in Pocket Console', deepLink);

  if (audioGenerated) {
    const ttsUsd = (ttsChars / 1_000_000) * 16.0;
    try {
      db.prepare('UPDATE jobs SET tts_chars = ?, tts_usd = ?, tts_failed = 0 WHERE id = ?').run(ttsChars, ttsUsd, jobId);
      try { recordSpend(db, userId, ttsUsd); } catch { /* non-fatal */ }
    } catch { /* non-fatal */ }
    await sendAudio(mp3Path, caption, keyboard, deepLink, ctx);
  } else {
    const timeoutSecs = Math.round(config.narrator.mdSpeakTimeout / 1000);
    const partialMsg = buildTtsErrorMessage(ttsFailReason, timeoutSecs, ttsStderr);
    const retryKeyboard = new InlineKeyboard()
      .text('Retry audio', `retry_audio:${jobId}`)
      .url('View text', deepLink);
    const replyOpts: Parameters<typeof ctx.reply>[1] = { reply_markup: retryKeyboard };
    if (ttsFailReason === 'gcp' && ttsStderr) (replyOpts as Record<string, unknown>)['parse_mode'] = 'HTML';
    await ctx.reply(partialMsg, replyOpts);
  }
}
