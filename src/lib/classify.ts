/**
 * classifyNarrative — Haiku classify call with JSON parse guards + enum validation.
 *
 * Spawns run.sh with the classify prompt, parses the Claude envelope,
 * validates tone/shape enums, and returns defaults on any failure path.
 */

import { execa } from 'execa';
import { buildSubprocessEnv } from './claude-subprocess.js';
import { config } from '../config.js';

export const VALID_TONES = [
  'serious', 'funny', 'roast', 'grave', 'celebratory',
  'comforting', 'harsh', 'inflammatory', 'surprising', 'jovial',
] as const;

export const VALID_SHAPES = [
  'origin-story', 'postmortem', 'heist-reveal',
  'detective', 'hero-journey', 'confessional',
] as const;

const DEFAULT_TONE = 'serious';
const DEFAULT_SHAPE = 'origin-story';

export interface ClassifyResult {
  tone: string;
  shape: string;
  confidence: number;
  source: 'classify' | 'default';
}

const DEFAULTS: ClassifyResult = {
  tone: DEFAULT_TONE,
  shape: DEFAULT_SHAPE,
  confidence: 0,
  source: 'default',
};

/**
 * Classify the tone and narrative shape of the given narrative text.
 *
 * Uses the first 2000 characters for the classify call.
 * Returns defaults on any failure: parse error, is_error envelope, or invalid enum values.
 */
export async function classifyNarrative(narrative: string, abortSignal?: AbortSignal): Promise<ClassifyResult> {
  const excerpt = narrative.slice(0, 2000);

  const classifyPrompt = `Classify the tone and narrative shape of this text. Return JSON with fields:
- tone: one of [serious, funny, roast, grave, celebratory, comforting, harsh, inflammatory, surprising, jovial]
- shape: one of [origin-story, postmortem, heist-reveal, detective, hero-journey, confessional]
- confidence: float 0-1

Text:
${excerpt}`;

  let stdout = '';
  try {
    const result = await execa(
      config.narrator.agentRunScript,
      ['-p', classifyPrompt, '--output-format', 'json', '--model', config.narrator.classifyModel],
      {
        input: excerpt,
        extendEnv: false,
        env: buildSubprocessEnv(process.env),
        timeout: 60_000,
        cleanup: true,
        killSignal: 'SIGKILL',
        cancelSignal: abortSignal,
      },
    );
    stdout = result.stdout;
  } catch (err) {
    // Non-zero exit — try to extract stdout from ExecaError before returning defaults
    const errStdout = (err as Record<string, unknown>)['stdout'];
    if (typeof errStdout === 'string' && errStdout.trim()) {
      stdout = errStdout;
    } else {
      console.warn('classify: subprocess failed, returning defaults:', String(err));
      return { ...DEFAULTS };
    }
  }

  // Parse outer Claude envelope
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    console.warn('classify: JSON.parse failed on stdout, returning defaults. stdout snippet:', stdout.slice(0, 200));
    return { ...DEFAULTS };
  }

  // is_error check
  if (envelope['is_error'] === true) {
    console.warn('classify: Claude envelope is_error=true, returning defaults. result:', String(envelope['result']).slice(0, 200));
    return { ...DEFAULTS };
  }

  // Extract result string from envelope
  const resultStr = envelope['result'];
  if (typeof resultStr !== 'string') {
    console.warn('classify: envelope.result is not a string, returning defaults');
    return { ...DEFAULTS };
  }

  // Parse the inner JSON result from Claude's response
  let inner: Record<string, unknown>;
  try {
    // Claude may emit preamble text and/or markdown code fences before the JSON object.
    // Strip leading/trailing fences, then extract the substring from first '{' to last '}'.
    const fenceStripped = resultStr.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = fenceStripped.indexOf('{');
    const end = fenceStripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      throw new SyntaxError('no JSON object found in result');
    }
    const cleaned = fenceStripped.slice(start, end + 1);
    inner = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    console.warn('classify: failed to parse envelope.result as JSON, returning defaults. result snippet:', resultStr.slice(0, 200));
    return { ...DEFAULTS };
  }

  // Validate tone
  const rawTone = typeof inner['tone'] === 'string' ? inner['tone'] : '';
  const tone = (VALID_TONES as readonly string[]).includes(rawTone) ? rawTone : DEFAULT_TONE;

  // Validate shape
  const rawShape = typeof inner['shape'] === 'string' ? inner['shape'] : '';
  const shape = (VALID_SHAPES as readonly string[]).includes(rawShape) ? rawShape : DEFAULT_SHAPE;

  // Parse confidence (clamp to 0-1)
  const rawConfidence = typeof inner['confidence'] === 'number' ? inner['confidence'] : 0;
  const confidence = Math.max(0, Math.min(1, rawConfidence));

  return { tone, shape, confidence, source: 'classify' };
}
