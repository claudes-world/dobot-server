import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateFilePath } from '../../src/lib/path-validator.js';

// Use temp directories so tests work on any machine / CI runner.
// The PID suffix avoids collisions between parallel test runs.
const FIXTURE_DIR = path.join(os.tmpdir(), `path-validator-test-${process.pid}`);
// Tilde-expansion requires a file reachable via ~, so we use a subdir of os.homedir().
const HOME_FIXTURE_DIR = path.join(os.homedir(), `.path-validator-test-${process.pid}`);

// Fixture paths
const validFile = path.join(FIXTURE_DIR, 'valid-test.md');
const tildeFile = path.join(HOME_FIXTURE_DIR, 'tilde-test.md');
const oversizedFile = path.join(FIXTURE_DIR, 'oversized-test.md');
const symlinkInAllowed = path.join(FIXTURE_DIR, 'symlink-escape.md');
// Wrong extension inside allowed prefix so it reaches the extension check
const wrongExtInAllowed = path.join(FIXTURE_DIR, 'wrong-ext-test.py');
// Deny pattern: a real .env file inside the allowed prefix (matches /\.env$/)
const deniedEnvFile = path.join(FIXTURE_DIR, 'test.env');

beforeAll(() => {
  // Allow the temp fixture dirs so the validator accepts these paths on any machine.
  process.env.PATH_VALIDATOR_ALLOWED_PREFIXES = [
    FIXTURE_DIR + '/',
    HOME_FIXTURE_DIR + '/',
  ].join(',');

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.mkdirSync(HOME_FIXTURE_DIR, { recursive: true });

  // 1. Valid .md file
  fs.writeFileSync(validFile, '# Test fixture\n');

  // 3. Tilde test file (lives under os.homedir() so ~ expansion reaches it)
  fs.writeFileSync(tildeFile, '# Tilde test fixture\n');

  // 4. Deny pattern — create a real .env file so realpathSync succeeds and deny check fires
  fs.writeFileSync(deniedEnvFile, 'SECRET=test\n');

  // 5. Wrong extension — create in allowed prefix so prefix check passes
  fs.writeFileSync(wrongExtInAllowed, 'print("hello")\n');

  // 6. Oversized file (600KB)
  const chunk = Buffer.alloc(1024, 'a');
  const fd = fs.openSync(oversizedFile, 'w');
  for (let i = 0; i < 600; i++) fs.writeSync(fd, chunk);
  fs.closeSync(fd);

  // 2. Symlink escape: symlink inside allowed prefix → /etc/passwd
  if (fs.existsSync(symlinkInAllowed)) fs.unlinkSync(symlinkInAllowed);
  fs.symlinkSync('/etc/passwd', symlinkInAllowed);
});

afterAll(() => {
  delete process.env.PATH_VALIDATOR_ALLOWED_PREFIXES;
  for (const f of [validFile, tildeFile, oversizedFile, wrongExtInAllowed, deniedEnvFile]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(symlinkInAllowed); } catch { /* ignore */ }
  try { fs.rmdirSync(FIXTURE_DIR); } catch { /* ignore */ }
  try { fs.rmdirSync(HOME_FIXTURE_DIR); } catch { /* ignore */ }
});

describe('validateFilePath', () => {
  it('1. allowed path — returns resolved absolute path', () => {
    const result = validateFilePath(validFile);
    expect(result).toBe(validFile);
  });

  it('2. symlink escape — throws (resolves outside allowed prefix)', () => {
    expect(() => validateFilePath(symlinkInAllowed)).toThrow();
  });

  it('3. tilde expansion — resolves correctly', () => {
    const tildePath = tildeFile.replace(os.homedir(), '~');
    const result = validateFilePath(tildePath);
    expect(result).toBe(tildeFile);
  });

  it('4. denied pattern .env — throws with deny message (real file, exercises deny-pattern branch)', () => {
    expect(() => validateFilePath(deniedEnvFile)).toThrow(/deny pattern/);
  });

  it('5. wrong extension — throws', () => {
    expect(() => validateFilePath(wrongExtInAllowed)).toThrow(/extension not allowed/);
  });

  it('6. oversized file — throws', () => {
    expect(() => validateFilePath(oversizedFile)).toThrow(/too large/);
  });

  it('7. nonexistent path — throws', () => {
    expect(() => validateFilePath(path.join(FIXTURE_DIR, 'nonexistent-99999.md'))).toThrow();
  });

  it('8. path outside allowed prefix (direct, no symlink) — throws with prefix error', () => {
    // /etc/hostname is a real file outside all allowed prefixes
    expect(() => validateFilePath('/etc/hostname')).toThrow(/allowed prefix/);
  });
});
