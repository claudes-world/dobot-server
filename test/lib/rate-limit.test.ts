import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkAndRecordRate, dailySpend, recordSpend } from '../../src/lib/rate-limit.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits_hourly (
      id        INTEGER PRIMARY KEY,
      user_id   INTEGER NOT NULL,
      handler   TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rl_hourly_user_ts ON rate_limits_hourly(user_id, timestamp);

    CREATE TABLE IF NOT EXISTS rate_limits_daily_spend (
      id        INTEGER PRIMARY KEY,
      user_id   INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      tts_usd   REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rl_daily_user_ts ON rate_limits_daily_spend(user_id, timestamp);
  `);
  return db;
}

describe('checkAndRecordRate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('1. 10 consecutive calls return "ok"', () => {
    for (let i = 0; i < 10; i++) {
      expect(checkAndRecordRate(db, 1, 'narrator')).toBe('ok');
    }
  });

  it('2. 11th call returns "exceeded-hourly"', () => {
    for (let i = 0; i < 10; i++) {
      checkAndRecordRate(db, 1, 'narrator');
    }
    expect(checkAndRecordRate(db, 1, 'narrator')).toBe('exceeded-hourly');
  });

  it('3. pruning: stale hourly rows (2h old) are pruned on next call', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    // Insert 15 stale rows directly
    const insert = db.prepare(`INSERT INTO rate_limits_hourly (user_id, handler, timestamp) VALUES (?, ?, ?)`);
    for (let i = 0; i < 15; i++) {
      insert.run(1, 'narrator', twoHoursAgo);
    }
    // Call checkAndRecordRate — pruning fires, stale rows deleted, count starts at 0, returns "ok"
    expect(checkAndRecordRate(db, 1, 'narrator')).toBe('ok');
    // Verify stale rows are gone — only the 1 we just recorded remains
    const count = (db.prepare(`SELECT COUNT(*) as count FROM rate_limits_hourly WHERE user_id = 1`).get() as { count: number }).count;
    expect(count).toBe(1);
  });

  it('4. daily spend $4.50 → ok; then add $0.60 → exceeded-daily on next check', () => {
    // Seed daily spend: $4.50 (below $5.00 cap)
    recordSpend(db, 1, 4.50);
    // First check — passes hourly and daily → "ok" (also records hourly entry)
    expect(checkAndRecordRate(db, 1, 'narrator')).toBe('ok');

    // Now push total over cap
    recordSpend(db, 1, 0.60);

    // Next check — daily spend $5.10 >= $5.00 → "exceeded-daily"
    expect(checkAndRecordRate(db, 1, 'narrator')).toBe('exceeded-daily');
  });

  it('5. different user_id isolates limits — user A at limit does not affect user B', () => {
    // User A hits hourly limit
    for (let i = 0; i < 10; i++) {
      checkAndRecordRate(db, 1, 'narrator');
    }
    expect(checkAndRecordRate(db, 1, 'narrator')).toBe('exceeded-hourly');

    // User B is unaffected
    expect(checkAndRecordRate(db, 2, 'narrator')).toBe('ok');
  });
});

describe('dailySpend', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('6. returns correct sum of spend within last 24h', () => {
    recordSpend(db, 1, 1.25);
    recordSpend(db, 1, 2.50);
    // Old spend outside 24h window — should not be counted
    const old = Date.now() - 25 * 60 * 60 * 1000;
    db.prepare(`INSERT INTO rate_limits_daily_spend (user_id, timestamp, tts_usd) VALUES (?, ?, ?)`).run(1, old, 10.00);

    expect(dailySpend(db, 1)).toBeCloseTo(3.75);
  });

  it('returns 0 when no spend recorded', () => {
    expect(dailySpend(db, 999)).toBe(0);
  });
});
