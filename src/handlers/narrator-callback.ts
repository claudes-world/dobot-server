import { Context } from 'grammy';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import { pendingTimeouts } from './narrator.js';

interface PendingChoice {
  job_id: string;
  chat_id: number;
  keyboard_msg_id: number;
  source_tmpfile: string;
  tone_prefix: string | null;
  shape_prefix: string | null;
  expires_at: number;
}

/**
 * Handle inline keyboard callback for length selection.
 * callback_data format: "length:<jobId>:<short|medium|full>"
 */
export function createLengthCallbackHandler(
  db: Database.Database,
  onLengthChosen: (jobId: string, length: 'short' | 'medium' | 'full', ctx: Context) => Promise<void>
) {
  return async function lengthCallbackHandler(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data;
    if (!data?.startsWith('length:')) {
      await ctx.answerCallbackQuery();
      return;
    }

    const parts = data.split(':');
    if (parts.length !== 3) {
      await ctx.answerCallbackQuery({ text: 'Invalid selection.' });
      return;
    }

    const [, jobId, lengthStr] = parts;
    const length = lengthStr as 'short' | 'medium' | 'full';

    if (!['short', 'medium', 'full'].includes(length)) {
      await ctx.answerCallbackQuery({ text: 'Invalid length.' });
      return;
    }

    // Atomically consume nonce — chat_id constraint prevents cross-chat replay and avoids
    // consuming a row that belongs to a different chat (row stays intact if chat_id mismatches)
    const pending = db.prepare(
      `DELETE FROM pending_length_choices WHERE job_id = ? AND chat_id = ? RETURNING *`
    ).get(jobId, ctx.chat!.id) as PendingChoice | undefined;

    if (!pending) {
      // Already consumed (race), never existed, or chat_id mismatch — row not touched in mismatch case
      try {
        await ctx.editMessageText('⏱ Selection expired — already processed or timed out.');
      } catch { /* message may have been deleted */ }
      await ctx.answerCallbackQuery({ text: 'This selection has expired.' });
      return;
    }

    // Check expires_at (belt-and-suspenders; row may have been kept by startup rebuild)
    if (Date.now() > pending.expires_at) {
      if (pending.keyboard_msg_id) {
        try { await ctx.editMessageText('⏱ Selection expired.'); } catch { /* swallow */ }
      }
      db.prepare(`UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'active'`)
        .run(Date.now(), 'length selection expired', pending.job_id);
      try { await fs.unlink(pending.source_tmpfile); } catch { /* already gone */ }
      try { await ctx.answerCallbackQuery({ text: 'Selection expired.' }); } catch { /* non-fatal */ }
      return;
    }

    // Sweep other pending keyboards for this chat_id — clean up jobs + temp files (stale keyboard fix)
    const others = db.prepare(
      `DELETE FROM pending_length_choices WHERE chat_id = ? AND job_id != ? RETURNING job_id, keyboard_msg_id, source_tmpfile`
    ).all(pending.chat_id, jobId) as { job_id: string; keyboard_msg_id: number; source_tmpfile: string }[];

    for (const other of others) {
      // Clear stale timeout handle to prevent accumulation (Fix 4: timeout leak)
      const staleHandle = pendingTimeouts.get(other.job_id);
      if (staleHandle !== undefined) {
        clearTimeout(staleHandle);
        pendingTimeouts.delete(other.job_id);
      }
      // Disable keyboard UI
      try {
        await ctx.api.editMessageReplyMarkup(pending.chat_id, other.keyboard_msg_id, undefined);
      } catch { /* message may have been deleted or already removed */ }
      // Mark job cancelled (was never started)
      db.prepare(`UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status = 'active'`)
        .run(Date.now(), 'superseded by newer keyboard selection', other.job_id);
      // Clean up temp file
      try { await fs.unlink(other.source_tmpfile); } catch { /* already gone */ }
    }

    // Edit keyboard message to show selection
    const labelMap = { short: 'short (~2min)', medium: 'medium (3-7min)', full: 'full length' };
    try {
      await ctx.editMessageText(`Rewriting in ${labelMap[length]} mode…`);
    } catch { /* swallow */ }

    // Wrap answerCallbackQuery so a throw doesn't prevent onLengthChosen
    try {
      await ctx.answerCallbackQuery();
    } catch (err) {
      console.warn('narrator: answerCallbackQuery failed (non-fatal):', err);
    }

    // Invoke the continuation (will spawn Claude rewrite)
    await onLengthChosen(jobId, length, ctx);
  };
}
