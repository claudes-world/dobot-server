import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ALLOWED_PREFIXES = [
  "/home/claude/claudes-world/",
  "/home/claude/code/",
  "/home/claude/shared/public/",
];

/** Returns the active allowed-prefix list.
 * Tests may override via PATH_VALIDATOR_ALLOWED_PREFIXES (comma-separated). */
function getAllowedPrefixes(): string[] {
  const env = process.env.PATH_VALIDATOR_ALLOWED_PREFIXES;
  if (env) {
    return env.split(',').map(p => p.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_PREFIXES;
}
const DENY_PATTERNS = [/\.secrets/, /\.ssh/, /\.gnupg/, /\.credentials\.json$/, /\.env$/];
const ALLOWED_EXT = [".md", ".txt", ".rst", ".org"];
const MAX_SOURCE_BYTES = 500 * 1024;

export function validateFilePath(userPath: string): string {
  // 1. Tilde expand
  const expanded = userPath.replace(/^~/, os.homedir());
  // 2. Resolve symlinks
  let resolved: string;
  try {
    resolved = fs.realpathSync(expanded);
  } catch {
    throw new Error(`Path does not exist or cannot be resolved: ${expanded}`);
  }
  // 3. Allowlist prefix check
  if (!getAllowedPrefixes().some(prefix => resolved.startsWith(prefix))) {
    throw new Error(`Path not in allowed prefix list: ${resolved}`);
  }
  // 4. Deny pattern check
  if (DENY_PATTERNS.some(re => re.test(resolved))) {
    throw new Error(`Path matches deny pattern: ${resolved}`);
  }
  // 5. Extension check
  if (!ALLOWED_EXT.some(ext => resolved.endsWith(ext))) {
    throw new Error(`Path extension not allowed: ${path.extname(resolved)}`);
  }
  // 6. Size + type check
  // NOTE: TOCTOU window exists between realpathSync and statSync; callers must
  // re-verify path identity at open() time if high-assurance is required.
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${resolved}`);
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    throw new Error(`File too large: ${stat.size} bytes (max ${MAX_SOURCE_BYTES})`);
  }
  return resolved;
}
