import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing classify
vi.mock('../../src/config.js', () => ({
  config: {
    narrator: {
      agentRunScript: '/fake/run.sh',
      classifyModel: 'claude-haiku-4-5',
    },
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { classifyNarrative, VALID_TONES, VALID_SHAPES } from '../../src/lib/classify.js';

const mockedExeca = vi.mocked(execa);

/** Build a Claude envelope JSON string wrapping an inner result. */
function makeEnvelope(is_error: boolean, result: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error,
    result,
    stop_reason: 'stop_sequence',
  });
}

/** Build a valid inner classify JSON result. */
function makeClassifyResult(tone: string, shape: string, confidence: number): string {
  return JSON.stringify({ tone, shape, confidence });
}

describe('VALID_TONES and VALID_SHAPES exports', () => {
  it('exports 10 valid tones', () => {
    expect(VALID_TONES).toHaveLength(10);
    expect(VALID_TONES).toContain('serious');
    expect(VALID_TONES).toContain('jovial');
  });

  it('exports 6 valid shapes', () => {
    expect(VALID_SHAPES).toHaveLength(6);
    expect(VALID_SHAPES).toContain('origin-story');
    expect(VALID_SHAPES).toContain('confessional');
  });
});

describe('classifyNarrative', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path — returns valid tone, shape, confidence with source=classify', async () => {
    const inner = makeClassifyResult('funny', 'heist-reveal', 0.9);
    mockedExeca.mockResolvedValueOnce({ stdout: makeEnvelope(false, inner), stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const result = await classifyNarrative('Some narrative text here.');
    expect(result.tone).toBe('funny');
    expect(result.shape).toBe('heist-reveal');
    expect(result.confidence).toBe(0.9);
    expect(result.source).toBe('classify');
  });

  it('truncates input to 2000 chars for the classify call', async () => {
    const inner = makeClassifyResult('grave', 'postmortem', 0.7);
    mockedExeca.mockResolvedValueOnce({ stdout: makeEnvelope(false, inner), stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const longText = 'x'.repeat(5000);
    await classifyNarrative(longText);

    // The prompt passed as -p arg should contain only 2000 chars of the text
    const callArgs = mockedExeca.mock.calls[0];
    const promptArg = callArgs[1][1] as string; // args[1] = prompt string
    // excerpt is last 2000 chars in the prompt — check prompt ends within that range
    expect(promptArg).toContain('x'.repeat(100)); // has the text
    // The stdin input should be 2000 chars
    const callOpts = callArgs[2] as { input: string };
    expect(callOpts.input.length).toBe(2000);
  });

  it('is_error=true envelope — returns defaults', async () => {
    mockedExeca.mockResolvedValueOnce({
      stdout: makeEnvelope(true, 'Not logged in · Please run /login'),
      stderr: '',
      exitCode: 0,
    } as ReturnType<typeof execa>);

    const result = await classifyNarrative('some text');
    expect(result.tone).toBe('serious');
    expect(result.shape).toBe('origin-story');
    expect(result.confidence).toBe(0);
    expect(result.source).toBe('default');
  });

  it('invalid JSON stdout — returns defaults', async () => {
    mockedExeca.mockResolvedValueOnce({ stdout: 'not json at all', stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const result = await classifyNarrative('some text');
    expect(result).toMatchObject({ tone: 'serious', shape: 'origin-story', source: 'default' });
  });

  it('invalid tone in result — falls back to serious', async () => {
    const inner = makeClassifyResult('whimsical', 'hero-journey', 0.6);
    mockedExeca.mockResolvedValueOnce({ stdout: makeEnvelope(false, inner), stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const result = await classifyNarrative('some text');
    expect(result.tone).toBe('serious');
    expect(result.shape).toBe('hero-journey'); // shape was valid
    expect(result.source).toBe('classify');
  });

  it('invalid shape in result — falls back to origin-story', async () => {
    const inner = makeClassifyResult('roast', 'epic-quest', 0.5);
    mockedExeca.mockResolvedValueOnce({ stdout: makeEnvelope(false, inner), stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const result = await classifyNarrative('some text');
    expect(result.tone).toBe('roast'); // tone was valid
    expect(result.shape).toBe('origin-story');
    expect(result.source).toBe('classify');
  });

  it('subprocess throws without stdout — returns defaults', async () => {
    mockedExeca.mockRejectedValueOnce(new Error('spawn failed'));

    const result = await classifyNarrative('some text');
    expect(result).toMatchObject({ tone: 'serious', shape: 'origin-story', source: 'default' });
  });

  it('subprocess throws with valid JSON stdout — uses that stdout', async () => {
    const inner = makeClassifyResult('comforting', 'confessional', 0.8);
    const err = Object.assign(new Error('exit code 1'), {
      stdout: makeEnvelope(false, inner),
    });
    mockedExeca.mockRejectedValueOnce(err);

    const result = await classifyNarrative('some text');
    expect(result.tone).toBe('comforting');
    expect(result.shape).toBe('confessional');
    expect(result.source).toBe('classify');
  });

  it('confidence is clamped to 0-1 range', async () => {
    const inner = makeClassifyResult('serious', 'detective', 1.5);
    mockedExeca.mockResolvedValueOnce({ stdout: makeEnvelope(false, inner), stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const result = await classifyNarrative('some text');
    expect(result.confidence).toBe(1);
  });

  it('inner result wrapped in markdown fences is parsed correctly', async () => {
    const inner = '```json\n' + makeClassifyResult('celebratory', 'hero-journey', 0.95) + '\n```';
    mockedExeca.mockResolvedValueOnce({ stdout: makeEnvelope(false, inner), stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    const result = await classifyNarrative('some text');
    expect(result.tone).toBe('celebratory');
    expect(result.shape).toBe('hero-journey');
    expect(result.confidence).toBe(0.95);
  });

  it('passes correct args to execa — model and output-format flags', async () => {
    const inner = makeClassifyResult('serious', 'origin-story', 0.5);
    mockedExeca.mockResolvedValueOnce({ stdout: makeEnvelope(false, inner), stderr: '', exitCode: 0 } as ReturnType<typeof execa>);

    await classifyNarrative('narrative text');

    expect(mockedExeca).toHaveBeenCalledWith(
      '/fake/run.sh',
      expect.arrayContaining(['--output-format', 'json', '--model', 'claude-haiku-4-5']),
      expect.objectContaining({ input: 'narrative text' }),
    );
  });
});
