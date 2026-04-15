import dns from 'node:dns/promises';

const PRIVATE_IP_REGEX = /^(0\.|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/;
const PRIVATE_IPV6_LOOPBACK = /^::1$/;
const ALLOWED_CONTENT_TYPES = ["text/html", "text/markdown", "text/plain"];
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 500 * 1024;
const FETCH_TIMEOUT_MS = 30000;

/**
 * Validates and fetches a URL safely.
 *
 * DNS lookup is performed once per hop to provide a best-effort SSRF check.
 * Known limitations (all deferred to Phase 3 upgrade to ipaddr.js + undici dispatcher):
 * - DNS rebinding TOCTOU: fetch() re-resolves the hostname at TCP connect time; an attacker with
 *   a short-TTL record can pass the DNS check then rebind to a private IP. Mitigating this
 *   properly requires pinning the resolved IP at the socket level (undici Agent dispatcher).
 * - PRIVATE_IP_REGEX misses IPv6 ULA (fc00::/7), link-local (fe80::/10),
 *   IPv4-mapped (::ffff:10.x), and CGNAT (100.64.0.0/10).
 * - DO NOT add ipaddr.js or undici dispatcher here; defer all of the above to Phase 3.
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

  /**
   * Resolve hostname → IP, assert not private/loopback.
   * Re-called for each redirect hop as a best-effort SSRF check.
   * See JSDoc for DNS rebinding TOCTOU caveat.
   */
  async function resolveAndAssert(hostname: string): Promise<void> {
    let address: string;
    try {
      const result = await dns.lookup(hostname);
      address = result.address;
    } catch (err) {
      throw new Error(`DNS resolution failed for ${hostname}: ${err}`);
    }
    if (PRIVATE_IP_REGEX.test(address) || PRIVATE_IPV6_LOOPBACK.test(address)) {
      throw new Error(`URL resolves to private IP address: ${address}`);
    }
  }

  // 2. Fetch with AbortController covering the entire operation (headers + body)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let currentUrl = url.toString();
  let redirectCount = 0;
  let response: Response;

  try {
    // 2a. Follow redirects manually (MAX_REDIRECTS enforced, each hop DNS-validated)
    while (true) {
      const hopUrl = new URL(currentUrl);
      await resolveAndAssert(hopUrl.hostname);

      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          response.body?.cancel().catch(() => {});
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
        }
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect with no Location header');
        const nextUrl = new URL(location, currentUrl);
        // Assert redirect target is also HTTPS
        if (nextUrl.protocol !== 'https:') {
          throw new Error(`Redirect to non-HTTPS URL: ${nextUrl.protocol}`);
        }
        currentUrl = nextUrl.toString();
        // Drain/cancel the redirect response body to release the underlying connection
        response.body?.cancel().catch(() => {});
        continue;
      }
      break;
    }

    // 3. Assert content-type
    const contentType = response.headers.get('content-type') ?? '';
    const ctBase = contentType.split(';')[0].trim();
    if (!ALLOWED_CONTENT_TYPES.some(ct => ctBase === ct)) {
      response.body?.cancel().catch(() => {});
      throw new Error(`Disallowed content-type: ${ctBase}`);
    }

    // 4. Stream body with byte cap (timer still active — covers slow-drip responses)
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
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    // Single canonical cleanup — covers all exit paths (normal, throws, abort)
    clearTimeout(timer);
  }
}
