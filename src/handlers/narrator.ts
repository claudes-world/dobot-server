import { Context } from 'grammy';
import Database from 'better-sqlite3';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

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

      // 5. Update jobs row
      db.prepare(`
        UPDATE jobs SET
          status = ?,
          completed_at = ?,
          stop_reason = ?
        WHERE id = ?
      `).run(
        envelope.is_error ? 'failed' : 'completed',
        Date.now(),
        envelope.stop_reason ?? null,
        jobId
      );

      if (envelope.is_error) {
        console.error('narrator: claude returned is_error', envelope);
        return;
      }

      const narrative = envelope.result;

      // 6. Log output (delivery wired in #6)
      const storiesDir = config.narrator.storiesDir;
      await fs.mkdir(storiesDir, { recursive: true });
      const slug = new Date().toISOString().replace(/[:.]/g, '-');
      const outPath = path.join(storiesDir, `${slug}-narrator.narration.md`);
      await fs.writeFile(outPath, narrative);

      console.log(`narrator: job ${jobId} complete — stop_reason=${envelope.stop_reason}, output written to ${outPath}`);

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
      ], {
        input: opts.sourceText,
        extendEnv: false,
        env: {
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
