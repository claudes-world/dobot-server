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
  db.exec(sql);

  return db;
}
