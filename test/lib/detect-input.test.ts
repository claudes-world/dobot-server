import { describe, it, expect } from 'vitest';
import { detectFilePath } from '../../src/lib/detect-input.js';

describe('detectFilePath', () => {
  it('1. absolute path alone — returns path', () => {
    expect(detectFilePath('/home/claude/notes.md')).toBe('/home/claude/notes.md');
  });

  it('2. tilde path alone — returns path', () => {
    expect(detectFilePath('~/claudes-world/TODO.md')).toBe('~/claudes-world/TODO.md');
  });

  it('3. path with leading/trailing whitespace — returns path', () => {
    expect(detectFilePath('  /home/claude/notes.txt  ')).toBe('/home/claude/notes.txt');
  });

  it('4. path after prefix text (space-separated) — returns path', () => {
    expect(detectFilePath('[funny] /home/claude/script.sh')).toBe('/home/claude/script.sh');
  });

  it('5. plain prose with no path — returns null', () => {
    expect(detectFilePath('Once upon a time in a land far away')).toBeNull();
  });

  it('6. empty string — returns null', () => {
    expect(detectFilePath('')).toBeNull();
  });

  it('7. path with .ts extension — detected', () => {
    expect(detectFilePath('/home/claude/code/foo.ts')).toBe('/home/claude/code/foo.ts');
  });

  it('8. path with .json extension — detected', () => {
    expect(detectFilePath('~/config/settings.json')).toBe('~/config/settings.json');
  });

  it('9. path with .py extension — detected', () => {
    expect(detectFilePath('/home/claude/code/script.py')).toBe('/home/claude/code/script.py');
  });

  it('10. relative path (no leading / or ~/) — returns null', () => {
    expect(detectFilePath('some/relative/path.md')).toBeNull();
  });

  it('11. tilde without slash — returns null', () => {
    expect(detectFilePath('~notes.md')).toBeNull();
  });
});
