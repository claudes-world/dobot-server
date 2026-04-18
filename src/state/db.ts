import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDatabase(dbPath: string): Database.Database {
  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Run migrations
  const migrationPath = path.resolve(__dirname, '../../migrations/001-initial.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    db.exec(sql);
    db.pragma('user_version = 1');
  }

  if (version < 2) {
    const migration2 = fs.readFileSync(path.resolve(__dirname, '../../migrations/002-tts-failed.sql'), 'utf8');
    db.exec(migration2);
    db.pragma('user_version = 2');
  }

  return db;
}
