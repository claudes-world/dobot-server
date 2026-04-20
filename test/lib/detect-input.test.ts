import { describe, it, expect } from 'vitest';
import { detectFilePath, detectUrl } from '../../src/lib/detect-input.js';

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

describe('detectUrl', () => {
  it('1. bare HTTPS URL — returns URL', () => {
    expect(detectUrl('https://example.com/article')).toBe('https://example.com/article');
  });

  it('2. URL with prefix text — returns URL', () => {
    expect(detectUrl('[funny] https://example.com/page')).toBe('https://example.com/page');
  });

  it('3. URL with trailing period — strips period', () => {
    expect(detectUrl('Check out https://example.com/story.')).toBe('https://example.com/story');
  });

  it('4. URL with trailing comma — strips comma', () => {
    expect(detectUrl('See https://example.com/article, thanks')).toBe('https://example.com/article');
  });

  it('5. HTTP URL — returns null (only HTTPS accepted)', () => {
    expect(detectUrl('http://example.com/article')).toBeNull();
  });

  it('6. plain prose — returns null', () => {
    expect(detectUrl('Once upon a time in a land far away')).toBeNull();
  });

  it('7. empty string — returns null', () => {
    expect(detectUrl('')).toBeNull();
  });

  it('8. URL with query params — returns full URL', () => {
    const url = 'https://example.com/search?q=foo&page=2';
    expect(detectUrl(url)).toBe(url);
  });

  it('9. URL with fragment — returns URL including fragment', () => {
    expect(detectUrl('https://example.com/article#section')).toBe('https://example.com/article#section');
  });

  it('10. URL with port — returns full URL', () => {
    expect(detectUrl('https://example.com:8443/path')).toBe('https://example.com:8443/path');
  });
});
