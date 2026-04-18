import Database from 'better-sqlite3';
import { config } from '../config.js';

export function checkAndRecordRate(db: Database.Database, userId: number, handler: string): "ok" | "exceeded-hourly" | "exceeded-daily" {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // Prune stale hourly rows (older than 1h) on every call
  db.prepare(`DELETE FROM rate_limits_hourly WHERE timestamp < ?`).run(oneHourAgo);

  // Check hourly count for this user+handler
  const hourlyCount = (db.prepare(`
    SELECT COUNT(*) as count FROM rate_limits_hourly
    WHERE user_id = ? AND handler = ? AND timestamp >= ?
  `).get(userId, handler, oneHourAgo) as { count: number }).count;

  if (hourlyCount >= config.narrator.maxJobsPerHour) {
    return "exceeded-hourly";
  }

  // Prune stale daily spend rows (older than 24h)
  db.prepare(`DELETE FROM rate_limits_daily_spend WHERE timestamp < ?`).run(oneDayAgo);

  // Check daily spend
  const spendRow = db.prepare(`
    SELECT COALESCE(SUM(tts_usd), 0) as total FROM rate_limits_daily_spend
    WHERE user_id = ? AND timestamp >= ?
  `).get(userId, oneDayAgo) as { total: number };

  if (spendRow.total >= config.narrator.maxDailyTtsUsd) {
    return "exceeded-daily";
  }

  // Record this job in hourly table
  db.prepare(`INSERT INTO rate_limits_hourly (user_id, handler, timestamp) VALUES (?, ?, ?)`).run(userId, handler, now);

  return "ok";
}

export function recordSpend(db: Database.Database, userId: number, ttsUsd: number): void {
  db.prepare(`INSERT INTO rate_limits_daily_spend (user_id, timestamp, tts_usd) VALUES (?, ?, ?)`).run(userId, Date.now(), ttsUsd);
}

export function dailySpend(db: Database.Database, userId: number): number {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const row = db.prepare(`
    SELECT COALESCE(SUM(tts_usd), 0) as total FROM rate_limits_daily_spend
    WHERE user_id = ? AND timestamp >= ?
  `).get(userId, oneDayAgo) as { total: number };
  return row.total;
}
