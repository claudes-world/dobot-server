import { Context, InputFile } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

export interface DeliveryOptions {
  jobId: string;
  narrative: string;
  stopReason: string;
  ctx: Context;
  db: Database.Database;
}

export async function deliverNarration(opts: DeliveryOptions): Promise<void> {
  const { jobId, narrative, stopReason, ctx, db } = opts;

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

  // 2. Invoke share-doc --no-audio to get deep link
  let deepLink: string | null = null;
  try {
    const shareResult = await execa('share-doc', ['--no-audio', mdPath], {
      extendEnv: true, // share-doc needs full env (Google creds etc.)
      timeout: 60000,
    });
    // share-doc outputs a URL on stdout
    deepLink = shareResult.stdout.trim() || null;
  } catch (err) {
    console.warn('narrator: share-doc failed, no deep link:', err);
  }

  // 3. Invoke md-speak --no-describe to generate audio
  const mp3Path = mdPath.replace('.narration.md', '.mp3');
  let ttsChars = 0;
  let ttsDurationMs = 0;
  let audioGenerated = false;

  const mdSpeakStart = Date.now();
  try {
    await execa('md-speak', ['--no-describe', mdPath], {
      extendEnv: true,
      timeout: config.narrator.mdSpeakTimeout,
      cleanup: true,
      killSignal: 'SIGKILL',
    });
    ttsDurationMs = Date.now() - mdSpeakStart;
    // Check if mp3 was generated
    try {
      await fs.access(mp3Path);
      audioGenerated = true;
      ttsChars = finalNarrative.length;
    } catch { /* mp3 not created */ }
  } catch (err) {
    console.error('narrator: md-speak failed:', err);
  }

  // 4. Build inline keyboard
  const keyboard = new InlineKeyboard();
  if (deepLink) {
    keyboard.url('Read in Pocket Console', deepLink);
  }

  // 5. Build caption
  const truncatedWarning = stopReason === 'max_tokens' ? ' ⚠️ truncated (max_tokens — 12k cap)' : '';
  const caption = `tone: serious | shape: origin-story | length: medium | tts_chars: ${ttsChars}${truncatedWarning}`;

  // 6. Deliver audio or markdown-only fallback
  if (audioGenerated) {
    const mp3Stat = await fs.stat(mp3Path);
    const mp3Size = mp3Stat.size;
    const hasKeyboard = deepLink ? { reply_markup: keyboard } : {};

    if (mp3Size < 1_000_000) {
      // < 1MB: send as voice note
      await ctx.replyWithVoice(new InputFile(mp3Path), { caption, ...hasKeyboard });
    } else if (mp3Size <= 50_000_000) {
      // 1-50MB: send as audio
      await ctx.replyWithAudio(new InputFile(mp3Path), { caption, ...hasKeyboard });
    } else {
      // > 50MB: publish to VPS share
      try {
        const pubResult = await execa('publish-shared', ['--tmp', 'private', mp3Path], {
          extendEnv: true,
          timeout: 60000,
        });
        const shareUrl = pubResult.stdout.trim();
        const urlKeyboard = new InlineKeyboard().url('Download audio', shareUrl);
        if (deepLink) urlKeyboard.url('Read in Pocket Console', deepLink);
        await ctx.reply(caption, { reply_markup: urlKeyboard });
      } catch (pubErr) {
        console.error('narrator: publish-shared failed:', pubErr);
        await ctx.reply(`${caption}\n\n(Audio too large to send directly — ${Math.round(mp3Size / 1_000_000)}MB)`, deepLink ? { reply_markup: keyboard } : {});
      }
    }
  } else {
    // No audio: deliver markdown only
    await ctx.reply(`${caption}\n\n(Audio generation failed — see logs)`, deepLink ? { reply_markup: keyboard } : {});
  }

  // Suppress unused variable warning — ttsDurationMs is available for future telemetry
  void ttsDurationMs;

  // 7. Update jobs row
  const ttsUsd = ttsChars > 0 ? (ttsChars / 1_000_000) * 16.0 : 0; // Google TTS ~$16/M chars WaveNet
  try {
    db.prepare(`
      UPDATE jobs SET
        output_path = ?,
        tts_chars = ?,
        tts_usd = ?
      WHERE id = ?
    `).run(mdPath, ttsChars, ttsUsd, jobId);
  } catch (dbErr) {
    console.error('narrator: DB update failed after delivery:', dbErr);
  }
}
