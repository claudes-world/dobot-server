// TODO: import from src/lib/classify.ts once that file is committed
const VALID_TONES = ['funny', 'roast', 'serious', 'poetic', 'sarcastic', 'dramatic'];
const VALID_SHAPES = ['heist-reveal', 'sports-commentary', 'listicle', 'haiku', 'tweet-thread', 'news-report'];

export interface ParsePrefixResult {
  prefixFound: boolean;
  tone: string | null;
  shape: string | null;
  text: string;
}

export interface ParsePrefixError {
  error: string;
}

export type ParsePrefixReturn = ParsePrefixResult | ParsePrefixError;

const PREFIX_RE = /^\[([a-zA-Z0-9_-]+)(?::([a-zA-Z0-9_-]+))?\]\s*/;

export function parsePrefix(raw: string): ParsePrefixReturn {
  const match = PREFIX_RE.exec(raw);
  if (!match) {
    return { prefixFound: false, tone: null, shape: null, text: raw };
  }

  const toneRaw = match[1].toLowerCase();
  const shapeRaw = match[2]?.toLowerCase() ?? null;
  const text = raw.slice(match[0].length);

  if (!VALID_TONES.includes(toneRaw)) {
    return { error: `Unknown tone '${toneRaw}'. Valid tones: ${VALID_TONES.join(', ')}` };
  }

  if (shapeRaw !== null && !VALID_SHAPES.includes(shapeRaw)) {
    return { error: `Unknown shape '${shapeRaw}'. Valid shapes: ${VALID_SHAPES.join(', ')}` };
  }

  return { prefixFound: true, tone: toneRaw, shape: shapeRaw, text };
}
