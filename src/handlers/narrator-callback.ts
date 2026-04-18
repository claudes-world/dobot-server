import { Context } from 'grammy';
import Database from 'better-sqlite3';

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

    // Verify nonce — look up the pending choice
    const pending = db.prepare(
      `SELECT * FROM pending_length_choices WHERE job_id = ?`
    ).get(jobId) as PendingChoice | undefined;

    if (!pending) {
      // Stale keyboard — already handled or timed out
      try {
        await ctx.editMessageText('⏱ Selection expired — already processed or timed out.');
      } catch { /* message may have been deleted */ }
      await ctx.answerCallbackQuery({ text: 'This selection has expired.' });
      return;
    }

    // Sweep other pending keyboards for this chat_id (stale keyboard cleanup)
    const others = db.prepare(
      `SELECT keyboard_msg_id FROM pending_length_choices WHERE chat_id = ? AND job_id != ?`
    ).all(pending.chat_id, jobId) as { keyboard_msg_id: number }[];

    for (const other of others) {
      try {
        await ctx.api.editMessageReplyMarkup(pending.chat_id, other.keyboard_msg_id, undefined);
      } catch { /* message may have been deleted or already removed */ }
    }
    db.prepare(`DELETE FROM pending_length_choices WHERE chat_id = ? AND job_id != ?`).run(pending.chat_id, jobId);

    // Remove this pending choice from DB (consume the nonce)
    db.prepare(`DELETE FROM pending_length_choices WHERE job_id = ?`).run(jobId);

    // Edit keyboard message to show selection
    const labelMap = { short: 'short (~2min)', medium: 'medium (3-7min)', full: 'full length' };
    try {
      await ctx.editMessageText(`Rewriting in ${labelMap[length]} mode…`);
    } catch { /* swallow */ }

    await ctx.answerCallbackQuery();

    // Invoke the continuation (will spawn Claude rewrite)
    await onLengthChosen(jobId, length, ctx);
  };
}
