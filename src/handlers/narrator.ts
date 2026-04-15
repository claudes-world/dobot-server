import { Context } from 'grammy';
import Database from 'better-sqlite3';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { deliverNarration } from '../delivery/narrator.js';

const SYSTEM_PROMPT_PARTS = [
  '/home/claude/claudes-world/agents/narrator/.claude/output-styles/narrator.md',
  '/home/claude/claudes-world/agents/narrator/narrative-writing-guide.md',
];

const USER_PROMPT = `Rewrite the source provided via stdin as a serious origin-story narrative suitable for text-to-speech playback.
Target length: medium (approximately 600-900 words of output).
Respond ONLY with the narrative prose — do not write files, do not include preamble, do not add commentary at the end.`;

interface ClaudeEnvelope {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  stop_reason: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export function createNarratorHandler(db: Database.Database) {
  return async function narratorHandler(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    // 1. Filter — silently reject if not in allowlist
    if (!config.narrator.allowedUserIds.has(userId)) return;

    const sourceText = ctx.message?.text;
    if (!sourceText) return;

    // Word-count guard — reject oversized input before spawning subprocess
    const wordCount = sourceText.split(/\s+/).filter(Boolean).length;
    if (wordCount > config.narrator.maxSourceWords) {
      console.log(`narrator: rejected oversized input (${wordCount} words) from user ${userId}`);
      return;
    }

    const jobId = randomUUID();
    const now = Date.now();

    // 2. Insert jobs row
    db.prepare(`
      INSERT INTO jobs (id, handler, chat_id, user_id, started_at, status, source_kind, tone, shape, length)
      VALUES (?, 'narrator', ?, ?, ?, 'active', 'text', 'serious', 'origin-story', 'medium')
    `).run(jobId, ctx.chat?.id ?? userId, userId, now);

    let sysTmpFile: string | null = null;

    try {
      // 3. Build system prompt file
      sysTmpFile = path.join(config.narrator.tmpDir, `narrator-sys-${jobId}.md`);
      const parts = await Promise.all(SYSTEM_PROMPT_PARTS.map(p => fs.readFile(p, 'utf8')));
      await fs.writeFile(sysTmpFile, parts.join('\n\n---\n\n'));

      // 4. Spawn narrator subprocess
      const result = await spawnNarrator({
        runScript: config.narrator.agentRunScript,
        model: config.narrator.rewriteModel,
        sysFile: sysTmpFile,
        sourceText,
        timeout: config.narrator.claudeTimeout,
      });

      const envelope = result.envelope;

      // 5. Handle error envelope — mark failed and write error column
      if (envelope.is_error) {
        console.error('narrator: claude returned is_error', envelope);
        try {
          db.prepare(`UPDATE jobs SET status = 'failed', completed_at = ?, stop_reason = ?, error = ? WHERE id = ?`)
            .run(Date.now(), envelope.stop_reason ?? null, envelope.result.slice(0, 500), jobId);
        } catch { /* DB may be closing */ }
        // Write error text so DB is diagnosable without log scraping
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
        narrative,
        stopReason,
        ctx,
        db,
      });

    } catch (err: unknown) {
      // Update job row to failed — any unhandled throw reaches here
      try {
        db.prepare(`
          UPDATE jobs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?
        `).run(Date.now(), String(err), jobId);
      } catch { /* DB may be closing */ }
      throw err;  // re-throw so router crash boundary logs it
    } finally {
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
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const proc = await execa(opts.runScript, [
        '-p', USER_PROMPT,
        '--output-format', 'json',
        '--append-system-prompt-file', opts.sysFile,
        '--model', opts.model,
        '--allowedTools', '',  // zero-tool allowlist — narrator rewrite needs no tools; empty allowlist > denylist
      ], {
        input: opts.sourceText,
        extendEnv: false,
        env: {
          // OAuth-only per ADR 0013 — ANTHROPIC_API_KEY intentionally excluded.
          // run.sh sets CLAUDE_CONFIG_DIR pointing to .credentials.json symlink.
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env['HOME'] ?? '/home/claude',
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: '12000',
        },
        timeout: opts.timeout,
        cleanup: true,
        killSignal: 'SIGKILL',
      });

      let envelope: ClaudeEnvelope;
      try {
        const parsed = JSON.parse(proc.stdout) as Record<string, unknown>;
        // Runtime shape check — ensure critical fields are present
        if (typeof parsed['is_error'] !== 'boolean' || typeof parsed['result'] !== 'string') {
          throw new Error(`Malformed Claude envelope — missing is_error or result. stdout: ${proc.stdout.slice(0, 200)}`);
        }
        envelope = parsed as unknown as ClaudeEnvelope;
      } catch (parseErr) {
        throw new Error(`Failed to parse Claude output: ${String(parseErr)}. stdout: ${proc.stdout.slice(0, 200)}`);
      }
      return { envelope, retried };

    } catch (err: unknown) {
      const msg = String(err);
      const isAuthError = msg.includes('401') || msg.includes('authentication') || msg.includes('OAuth');

      if (attempt === 0 && isAuthError) {
        retried = true;
        console.warn('narrator: OAuth error on attempt 1, retrying once...');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      throw err;
    }
  }

  throw new Error('narrator: exhausted retries');
}
