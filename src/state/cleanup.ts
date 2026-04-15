import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function startupSweep(db: Database.Database): Promise<void> {
  // 1. Null stale subprocess PIDs
  db.prepare("UPDATE jobs SET subprocess_pid = NULL WHERE status = 'active'").run();

  // 2. Mark orphaned active jobs failed
  db.prepare("UPDATE jobs SET status = 'failed', error = 'orphaned on restart' WHERE status = 'active'").run();

  // 3. Delete expired pending choices + unlink temp files
  const now = Date.now();
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
