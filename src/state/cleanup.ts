import { Context, Api } from 'grammy';
import type { UserFromGetMe, Update } from 'grammy/types';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pendingTimeouts, pendingNarratorTimeouts } from '../handlers/narrator.js';

interface PendingRow {
  job_id: string;
  chat_id: number;
  keyboard_msg_id: number;
  source_tmpfile: string;
  tone_prefix: string | null;
  shape_prefix: string | null;
  expires_at: number;
}

interface JobRow {
  user_id: number;
}

export async function startupSweep(db: Database.Database): Promise<void> {
  // 1. Null stale subprocess PIDs
  db.prepare("UPDATE jobs SET subprocess_pid = NULL WHERE status = 'active'").run();

  // 2. Mark orphaned active jobs failed — exclude jobs with in-window pending choices
  //    (those will get timeouts rebuilt by rebuildPendingTimeouts).
  //    Use a correlated subquery to avoid the SQLite 999-parameter limit.
  const now = Date.now();
  db.prepare(`
    UPDATE jobs SET status = 'failed', error = 'orphaned on restart'
    WHERE status = 'active'
      AND id NOT IN (SELECT job_id FROM pending_length_choices WHERE expires_at >= ?)
  `).run(now);

  // 3. Delete expired pending choices + unlink temp files
  const expired = db.prepare(
    "SELECT source_tmpfile FROM pending_length_choices WHERE expires_at < ?"
  ).all(now) as { source_tmpfile: string }[];
  for (const row of expired) {
    try { await fs.unlink(row.source_tmpfile); } catch { /* already gone */ }
  }
  db.prepare("DELETE FROM pending_length_choices WHERE expires_at < ?").run(now);

  // 4. Sweep stale narrator-src-* files from tmp dir
  try {
    const tmpDir = process.env['NARRATOR_TMP_DIR'] ?? '/tmp';
    const files = (await fs.readdir(tmpDir)).filter(f => f.startsWith('narrator-src-'));
    const known = new Set(
      (db.prepare("SELECT source_tmpfile FROM pending_length_choices").all() as { source_tmpfile: string }[])
        .map(r => r.source_tmpfile)
    );
    for (const f of files) {
      const full = path.join(tmpDir, f);
      if (!known.has(full)) {
        try { await fs.unlink(full); } catch {}
      }
    }
  } catch { /* tmp dir not accessible */ }
}

/**
 * Rebuild setTimeout handles for pending_length_choices that are still within
 * their expiry window. Called once at startup after startupSweep, so in-flight
 * keyboard sessions survive a server restart.
 *
 * On timeout fire: edits the ack message to "Timed out — using default (medium)"
 * and continues narration with default length via the provided continueNarration callback.
 *
 * pendingTimeouts is the module-scoped map in narrator.ts; we write into it so
 * the callback handler can clearTimeout if the user taps before expiry.
 */
export function rebuildPendingTimeouts(
  db: Database.Database,
  api: Api,
  me: UserFromGetMe,
  onTimeout: (jobId: string, length: 'short' | 'medium' | 'full', ctx: Context, toneOverride: string | null, shapeOverride: string | null, ackMessageId?: number) => Promise<void>,
): void {
  const now = Date.now();
  const rows = db.prepare(
    "SELECT job_id, chat_id, keyboard_msg_id, source_tmpfile, tone_prefix, shape_prefix, expires_at FROM pending_length_choices WHERE expires_at >= ?"
  ).all(now) as PendingRow[];

  for (const row of rows) {
    const delay = Math.max(0, row.expires_at - Date.now());

    const handle = setTimeout(async () => {
      try {
        // Atomically consume — avoid double-fire with normal callback path
        const still = db.prepare(`DELETE FROM pending_length_choices WHERE job_id = ? RETURNING *`).get(row.job_id) as
          | { tone_prefix: string | null; shape_prefix: string | null } | undefined;
        pendingTimeouts.delete(row.job_id);
        pendingNarratorTimeouts.add(-1, { bot: 'narrator' });
        if (!still) return; // already handled by callback

        const { job_id: jobId, chat_id: chatId, keyboard_msg_id: ackMessageId } = row;

        // Edit ack message to indicate timeout
        if (ackMessageId) {
          try {
            await api.editMessageText(chatId, ackMessageId, 'Timed out — using default (medium)');
          } catch { /* swallow — message may be gone */ }
        }

        // Look up userId from jobs table (needed to construct synthetic Context)
        const jobRow = db.prepare(`SELECT user_id FROM jobs WHERE id = ?`).get(jobId) as JobRow | undefined;
        if (!jobRow) {
          console.warn(`rebuildPendingTimeouts: no job row for ${jobId} — cannot continue narration`);
          try { await fs.unlink(row.source_tmpfile); } catch { /* gone */ }
          return;
        }

        // Build a synthetic Update so continueNarration gets a proper Context
        const syntheticUpdate: Update = {
          update_id: 0,
          message: {
            message_id: 0,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: 'private' },
            from: {
              id: jobRow.user_id,
              is_bot: false,
              first_name: '',
            },
          } as Update['message'],
        };

        const ctx = new Context(syntheticUpdate, api, me);
        await onTimeout(jobId, 'medium', ctx, still.tone_prefix, still.shape_prefix, ackMessageId || undefined);
      } catch (err) {
        console.error(`rebuildPendingTimeouts: unhandled error in timeout for job ${row.job_id}:`, err);
      }
    }, delay);

    pendingTimeouts.set(row.job_id, handle);
    pendingNarratorTimeouts.add(1, { bot: 'narrator' });
    console.log(`startup: rebuilt timeout for pending choice ${row.job_id} (fires in ${Math.round(delay / 1000)}s)`);
  }
}
