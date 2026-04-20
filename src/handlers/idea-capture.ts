import { Context, InlineKeyboard, Bot } from 'grammy';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { config } from '../config.js';
import { toBase64url } from '../lib/telegram.js';

/** Format the "from" field: "Display Name (@username)" or just "Display Name". */
function formatFrom(ctx: Context): string {
  const user = ctx.from;
  if (!user) return 'unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return user.username ? `${name} (@${user.username})` : name;
}

/** Get ISO8601 timestamp in Eastern Time. */
function isoTimestampET(date: Date): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  // Determine ET offset (EDT = -04:00, EST = -05:00)
  const tzFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
  const tzParts = tzFmt.formatToParts(date);
  const tzName = tzParts.find(p => p.type === 'timeZoneName')?.value;
  const offset = tzName === 'EDT' ? '-04:00' : '-05:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/** Download a Telegram file by file_id and save to destPath. */
async function downloadTelegramFile(bot: Bot, fileId: string, destPath: string, signal?: AbortSignal): Promise<void> {
  const file = await Promise.race([
    bot.api.getFile(fileId),
    new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(new Error('getFile timeout'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new Error('getFile timeout')), { once: true });
    }),
  ]);
  if (!file.file_path) {
    throw new Error(`Telegram returned no file_path for file_id ${fileId}`);
  }
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const resp = await fetch(url, { signal });
  if (!resp.ok) {
    throw new Error(`Failed to download file: ${resp.status} ${resp.statusText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(destPath, buf);
}

/** Append an idea entry to the idea file. */
async function appendIdea(opts: {
  type: 'text' | 'voice' | 'photo';
  from: string;
  timestamp: string;
  body: string;
  photoPath?: string;
}): Promise<void> {
  const { type, from, timestamp, body, photoPath } = opts;
  const photoLine = photoPath ? `![photo](${photoPath}) ` : '';
  const entry = `---\n## ${type} idea — ${timestamp}\n**From:** ${from}\n\n${photoLine}${body}\n\n`;
  await fs.appendFile(config.ideaCapture.ideaFile, entry, 'utf8');
}

/** Build the CPC t.me deep-link button for the idea file. */
function buildIdeaKeyboard(): InlineKeyboard {
  const deepLink = `https://t.me/claude_do_bot/pocket?startapp=${toBase64url(config.ideaCapture.ideaFile)}`;
  return new InlineKeyboard().url('View in Pocket', deepLink);
}

/**
 * Factory — returns a grammY message handler for idea capture.
 * Handles text, voice, and photo messages.
 */
export function createIdeaCaptureHandler(bot: Bot) {
  return async function ideaCaptureHandler(ctx: Context): Promise<void> {
    // DM-only
    if (ctx.chat?.type !== 'private') return;

    const userId = ctx.from?.id;
    if (!userId) return;

    // Access guard — silently reject if not in allowlist
    if (!config.ideaCapture.allowedUserIds.has(userId)) return;

    const from = formatFrom(ctx);
    const now = new Date();
    const timestamp = isoTimestampET(now);
    const keyboard = buildIdeaKeyboard();

    // --- Text message ---
    const text = ctx.message?.text;
    if (text) {
      try {
        await appendIdea({ type: 'text', from, timestamp, body: text });
        await ctx.reply('✅ Idea saved', { reply_markup: keyboard });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[idea-capture/text] Error:', msg);
        await ctx.reply(`Failed to save idea: ${msg}`);
      }
      return;
    }

    // --- Voice message ---
    const voice = ctx.message?.voice;
    if (voice) {
      const tempPath = path.join(os.tmpdir(), `idea-voice-${randomUUID()}.oga`);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          await downloadTelegramFile(bot, voice.file_id, tempPath, controller.signal);
        } finally {
          clearTimeout(timer);
        }

        const result = await execa('/home/claude/bin/transcribe', [tempPath], {
          timeout: 60000,
        });
        const transcribed = result.stdout.trim();

        if (!transcribed) {
          await ctx.reply('Could not transcribe voice note (empty result)');
          return;
        }

        await appendIdea({ type: 'voice', from, timestamp, body: transcribed });
        await ctx.reply('✅ Idea saved', { reply_markup: keyboard });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[idea-capture/voice] Error:', msg);
        await ctx.reply(`Voice transcription failed: ${msg}`);
      } finally {
        try { await fs.unlink(tempPath); } catch { /* temp file may not exist */ }
      }
      return;
    }

    // --- Photo message ---
    const photos = ctx.message?.photo;
    if (photos && photos.length > 0) {
      // Telegram sends photos sorted by size — take the largest
      const largest = photos[photos.length - 1];
      const permanentPath = path.join(config.ideaCapture.photosDir, `idea-photo-${randomUUID()}.jpg`);
      let recorded = false;
      try {
        await fs.mkdir(config.ideaCapture.photosDir, { recursive: true });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          await downloadTelegramFile(bot, largest.file_id, permanentPath, controller.signal);
        } finally {
          clearTimeout(timer);
        }

        const caption = ctx.message?.caption ?? '';
        const relPath = path.relative(path.dirname(config.ideaCapture.ideaFile), permanentPath);
        await appendIdea({ type: 'photo', from, timestamp, body: caption, photoPath: relPath });
        recorded = true;  // file is now referenced in the idea entry
        await ctx.reply('✅ Idea saved', { reply_markup: keyboard });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[idea-capture/photo] Error:', msg);
        if (!recorded) {
          // Only clean up if the entry was never committed
          try { await fs.unlink(permanentPath); } catch { }
        }
        await ctx.reply('⚠️ Failed to save photo').catch(() => {});
      }
      return;
    }
  };
}
