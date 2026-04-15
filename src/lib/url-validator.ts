import dns from 'node:dns/promises';

const PRIVATE_IP_REGEX = /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|::1|localhost)/;
const ALLOWED_CONTENT_TYPES = ["text/html", "text/markdown", "text/plain"];
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 500 * 1024;
const FETCH_TIMEOUT_MS = 30000;

/**
 * Validates and fetches a URL safely.
 *
 * Known limitation: PRIVATE_IP_REGEX misses IPv6 CIDR ranges, IPv4-mapped addresses (::ffff:10.x),
 * and CGNAT (100.64.0.0/10). Phase 3 upgrade to ipaddr.js will cover these — DO NOT add that
 * dependency here.
 */
export async function validateAndFetchUrl(urlString: string): Promise<string> {
  // 1. Parse and assert HTTPS
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Only HTTPS URLs allowed, got: ${url.protocol}`);
  }

  // 2. Resolve hostname via DNS, assert not private IP
  let resolvedIp: string;
  try {
    const result = await dns.lookup(url.hostname);
    resolvedIp = result.address;
  } catch (err) {
    throw new Error(`DNS resolution failed for ${url.hostname}: ${err}`);
  }
  if (PRIVATE_IP_REGEX.test(resolvedIp)) {
    throw new Error(`URL resolves to private IP address: ${resolvedIp}`);
  }

  // 3. Fetch with timeout and manual redirect following (MAX_REDIRECTS enforced)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let currentUrl = url.toString();
  let redirectCount = 0;
  let response: Response;

  try {
    while (true) {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
        }
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect with no Location header');
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // 4. Assert content-type
  const contentType = response.headers.get('content-type') ?? '';
  const ctBase = contentType.split(';')[0].trim();
  if (!ALLOWED_CONTENT_TYPES.some(ct => ctBase === ct)) {
    throw new Error(`Disallowed content-type: ${ctBase}`);
  }

  // 5. Stream body with byte cap
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is null');

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reader.cancel().catch(() => {});
        throw new Error(`Response body exceeds ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks).toString('utf-8');
}
