import { describe, it, expect } from 'vitest';
import { parsePrefix } from '../../src/lib/parse-prefix.js';

describe('parsePrefix', () => {
  it('no prefix — returns prefixFound false with original text', () => {
    const result = parsePrefix('regular message');
    expect(result).toEqual({ prefixFound: false, tone: null, shape: null, text: 'regular message' });
  });

  it('tone-only prefix — strips prefix and returns tone', () => {
    const result = parsePrefix('[funny] The story...');
    expect(result).toEqual({ prefixFound: true, tone: 'funny', shape: null, text: 'The story...' });
  });

  it('tone + shape prefix — strips prefix and returns both', () => {
    const result = parsePrefix('[roast:heist-reveal] The story...');
    expect(result).toEqual({ prefixFound: true, tone: 'roast', shape: 'heist-reveal', text: 'The story...' });
  });

  it('invalid tone — returns error starting with "Unknown tone"', () => {
    const result = parsePrefix('[invalid] text');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/^Unknown tone/);
  });

  it('invalid shape — returns error starting with "Unknown shape"', () => {
    const result = parsePrefix('[funny:badshape] text');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/^Unknown shape/);
  });

  it('case insensitivity — uppercase prefix normalised to lowercase', () => {
    const result = parsePrefix('[FUNNY] text');
    expect(result).toMatchObject({ prefixFound: true, tone: 'funny' });
  });

  it('empty string — returns prefixFound false with empty text', () => {
    const result = parsePrefix('');
    expect(result).toEqual({ prefixFound: false, tone: null, shape: null, text: '' });
  });
});
