# PR #50 Tier-1 Review — feat(narrator): length timeout + stale keyboard sweep + startup rebuild

## Focus Area Results

### 1. Circular dependency: cleanup.ts → narrator.ts
CLEAN. One-way: cleanup.ts imports pendingTimeouts from narrator.ts; narrator.ts does not import from cleanup.ts. No cycle risk.

### 2. Startup race: ordering of startupSweep vs rebuildPendingTimeouts
CLEAN. Base index.ts calls `await startupSweep(db)` before `createBot()`. Diff inserts `getMe()` + `rebuildPendingTimeouts()` after bot creation. Resolved order:
1. await startupSweep(db) — orphan sweep, expired row deletion
2. createBot() — bot created
3. await getMe() — identity resolved
4. rebuildPendingTimeouts() — timeouts rebuilt for surviving rows
5. registerHandlers(), await bot.start() — bot goes live

### 3. Synthetic Context: ctx.from?.id and ctx.chat?.id
CLEAN for the accessed fields. grammy resolves ctx.from via update.message?.from = { id: jobRow.user_id, ... } and ctx.chat via update.message?.chat = { id: chatId, type: 'private' }. Both fields resolve correctly.

### 4. TOCTOU in orphan sweep exclusion
[SEVERITY: low] src/state/cleanup.ts — startupSweep computes `now = Date.now()` once at entry; rebuildPendingTimeouts computes its own Date.now() one API round-trip later (~100ms). A row expiring in that gap is excluded from the orphan sweep (job stays active) but NOT found by rebuildPendingTimeouts (expires_at < rebuild_now), leaving the job permanently stuck active with no forward-progress mechanism. The stale pending_length_choices row also survives (step 3 only deletes expires_at < startupSweep_now). Gap is ~100ms against a 20s timeout — low probability but real.

### 5. Job status when rebuilt timeout fires
CLEAN. Jobs excluded from orphan sweep stay active. When rebuilt timeout fires, continueNarration's guard (`SELECT status FROM jobs WHERE id = ?`) sees status = 'active' and proceeds normally.

### 6. Error handling in rebuildPendingTimeouts — onTimeout not guarded
[SEVERITY: medium] src/state/cleanup.ts — inside the `setTimeout(async () => { ... })` callback, `await onTimeout(jobId, 'medium', ctx)` has no try/catch. api.editMessageText is guarded; continueNarration (Claude subprocess + TTS + Telegram delivery) is not. If it throws, the rejection is unhandled — Node v15+ crashes the process by default.

Fix: wrap the call:

    try {
      await onTimeout(jobId, 'medium', ctx);
    } catch (err) {
      console.error('rebuildPendingTimeouts: onTimeout failed for ' + row.job_id, err);
    }

### 7. Other correctness issues

[SEVERITY: low] src/state/cleanup.ts — `chat: { id: chatId, type: 'private' }` hardcoded in synthetic Update. chatId is stored from ctx.chat?.id which can be a group or supergroup. Any code in continueNarration or deliverNarration that branches on ctx.chat?.type will see 'private' incorrectly. Currently deliverNarration does not branch on type so this is latent, not active — but fragile. If it matters later, store chat_type in pending_length_choices.

[SEVERITY: low] src/state/cleanup.ts — `as Update['message']` cast on the synthetic message object suppresses TypeScript checks for required Message fields. At runtime grammy only accesses fields that exist, so safe today — but the cast hides future regressions if continueNarration starts accessing additional ctx properties.

## Summary

| Severity | Count | Items |
|----------|-------|-------|
| HIGH     | 0     | — |
| MEDIUM   | 1     | Unhandled rejection if onTimeout throws (focus area 6) |
| LOW      | 3     | TOCTOU gap (4); hardcoded type:'private' (7a); unsafe as-cast (7b) |

Medium must be fixed before merge. Lows are acceptable technical debt.
