import { Context, Bot } from 'grammy';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { config } from '../config.js';

export interface IdeaCaptureCTX {
  repo: string;
  folder: string;
}

/** Format the "from" field: "Display Name (@username)" or just "Display Name". */
function formatFrom(ctx: Context): string {
  const user = ctx.from;
  if (!user) return 'unknown';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return user.username ? `${name} (@${user.username})` : name;
}

/** Format a filename-safe timestamp: YYYY-MM-DD-HH-MM-SS in Eastern Time. */
function fileTimestampET(date: Date): string {
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
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}-${parts.second}`;
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

/** Write an idea to a per-file path under the ideas directory. */
async function writeIdeaFile(opts: {
  ideasDir: string;
  timestamp: string;
  type: 'text' | 'voice' | 'photo';
  from: string;
  isoTimestamp: string;
  body: string;
  photoPath?: string;
}): Promise<void> {
  const { ideasDir, timestamp, type, from, isoTimestamp, body, photoPath } = opts;
  await fs.mkdir(ideasDir, { recursive: true });
  const uuid = randomUUID();
  const filePath = path.join(ideasDir, `${timestamp}-${uuid}.md`);
  const photoLine = photoPath ? `![photo](${photoPath}) ` : '';
  const content = `---\n## ${type} idea — ${isoTimestamp}\n**From:** ${from}\n\n${photoLine}${body}\n`;
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * Factory — returns a grammY message handler for idea capture.
 * Requires pre-gated ctx from the gateway middleware.
 * gatewayCTX provides { repo, folder } routing context.
 */
export function createIdeaCaptureHandler(bot: Bot) {
  return async function ideaCaptureHandler(ctx: Context, gatewayCTX: unknown): Promise<void> {
    const { repo, folder } = gatewayCTX as IdeaCaptureCTX;
    const ideasDir = path.join(repo, 'captured-ideas', folder);

    const from = formatFrom(ctx);
    const now = new Date();
    const timestamp = fileTimestampET(now);
    const isoTimestamp = isoTimestampET(now);

    // --- Text message ---
    const text = ctx.message?.text;
    if (text) {
      try {
        await writeIdeaFile({ ideasDir, timestamp, type: 'text', from, isoTimestamp, body: text });
        await ctx.reply('✅ Idea saved');
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

        await writeIdeaFile({ ideasDir, timestamp, type: 'voice', from, isoTimestamp, body: transcribed });
        await ctx.reply('✅ Idea saved');
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
        await writeIdeaFile({ ideasDir, timestamp, type: 'photo', from, isoTimestamp, body: caption, photoPath: permanentPath });
        recorded = true;
        await ctx.reply('✅ Idea saved');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[idea-capture/photo] Error:', msg);
        if (!recorded) {
          try { await fs.unlink(permanentPath); } catch { }
        }
        await ctx.reply('⚠️ Failed to save photo').catch(() => {});
      }
      return;
    }
  };
}
