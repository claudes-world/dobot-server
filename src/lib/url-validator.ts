import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent as UndiciAgent, fetch, type Response as UndiciResponse } from 'undici';
import he from 'he';

const ALLOWED_CONTENT_TYPES = ["text/html", "text/markdown", "text/plain"];
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 500 * 1024;
const FETCH_TIMEOUT_MS = 10000;

/**
 * Returns true if the resolved IP address falls in a range that must not be
 * fetched (SSRF guard). Uses ipaddr.js for comprehensive coverage:
 * - IPv4: loopback (127/8), private (10/8, 172.16/12, 192.168/16),
 *         link-local (169.254/16), CGNAT (100.64/10), unspecified (0.0.0.0/8)
 * - IPv6: loopback (::1), link-local (fe80::/10), ULA (fc00::/7),
 *         IPv4-mapped private addresses
 */
function isPrivateAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    const range = parsed.range();
    // Blocked ranges for both IPv4 and IPv6
    const BLOCKED: string[] = [
      'loopback', 'private', 'linkLocal', 'unspecified',
      // IPv6-specific
      'uniqueLocal',
      // CGNAT — ipaddr.js names this 'carrierGradeNat' for IPv4
      'carrierGradeNat',
      // Reserved / IANA special-purpose ranges not covered above
      'reserved',
    ];
    if (BLOCKED.includes(range)) return true;

    // IPv4-mapped IPv6 (::ffff:10.x, etc.) — unwrap and re-check
    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6;
      if (v6.isIPv4MappedAddress()) {
        const v4 = v6.toIPv4Address();
        const v4range = v4.range();
        if (BLOCKED.includes(v4range)) return true;
      }
    }

    // multicast and broadcast — ipaddr.js range() returns 'multicast' for 224-239,
    // but 255.255.255.255 falls outside named ranges; catch both with byte check.
    if (parsed.kind() === 'ipv4') {
      const bytes = (parsed as ipaddr.IPv4).toByteArray();
      if (bytes[0] >= 224) return true; // multicast (224-239) + broadcast (255.255.255.255)
    }

    return false;
  } catch {
    // Unparseable address — treat as private to fail safe
    return true;
  }
}

/**
 * Validates and fetches a URL safely.
 *
 * DNS resolution is performed once per hop via node:dns/promises. The resolved
 * IP is validated with ipaddr.js (SSRF guard) and then pinned at socket level
 * using an undici dispatcher — this prevents DNS rebinding attacks where fetch()
 * might re-resolve to a different IP at TCP connect time.
 *
 * Improvements over Phase 2 regex guard:
 * - ipaddr.js covers IPv6 ULA (fc00::/7), link-local (fe80::/10),
 *   IPv4-mapped private (::ffff:10.x), and CGNAT (100.64.0.0/10)
 * - Fetch timeout reduced to 10 s (was 30 s)
 * - Undici dispatcher pins the pre-resolved IP — full DNS rebinding protection
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
   * Resolve hostname → validated IPv4 address.
   * Throws if DNS fails or the address is private/loopback.
   * Returns the address so it can be pinned in the undici dispatcher.
   */
  async function resolveAndValidate(hostname: string): Promise<string> {
    let address: string;
    try {
      const result = await dns.lookup(hostname, { family: 4 });
      address = result.address;
    } catch (err) {
      throw new Error(`DNS resolution failed for ${hostname}: ${err}`);
    }
    if (isPrivateAddress(address)) {
      throw new Error(`URL resolves to private IP address: ${address}`);
    }
    return address;
  }

  // 2. Fetch with AbortController covering the entire operation (headers + body)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let currentUrl = url.toString();
  let redirectCount = 0;
  let response: UndiciResponse;

  try {
    // lastDispatcher holds the dispatcher for the final (non-redirect) hop.
    // It must stay alive until the body has been fully streamed (see outer finally below).
    let lastDispatcher: UndiciAgent | null = null;
    try {
      // 2a. Follow redirects manually (MAX_REDIRECTS enforced, each hop DNS-validated).
      // For each hop: resolve the IP, validate it, then pin it in the undici dispatcher
      // so the actual TCP connection uses exactly that IP (prevents DNS rebinding).
      while (true) {
        const hopUrl = new URL(currentUrl);
        const resolvedIp = await resolveAndValidate(hopUrl.hostname);

        // Pin the pre-resolved IP at socket level — undici will not re-resolve the hostname.
        // undici 8.x changed the lookup callback contract to cb(null, [{ address, family }]).
        const dispatcher = new UndiciAgent({
          connect: { lookup: (_hostname: string, _opts: unknown, cb: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: resolvedIp, family: 4 }]) }
        });

        let isRedirect = false;
        try {
          response = await fetch(hopUrl.toString(), {
            signal: controller.signal,
            redirect: 'manual',
            dispatcher,
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
            isRedirect = true;
          } else {
            // Final hop — keep the dispatcher alive until body is fully consumed
            lastDispatcher = dispatcher;
          }
        } finally {
          // Safe to destroy redirect-hop dispatchers immediately (body already cancelled).
          // Final-hop dispatcher is NOT destroyed here — lastDispatcher handles it below.
          if (lastDispatcher !== dispatcher) dispatcher.destroy().catch(() => {});
        }

        if (!isRedirect) break;
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

      const raw = Buffer.concat(chunks).toString('utf-8');

      // 5. Strip HTML tags for clean text when content-type is text/html.
      // Order matters: decode entities BEFORE stripping tags so that tags encoded
      // as &lt;script&gt; are not passed through as literal text after stripping.
      // Collapse runs of whitespace introduced by tag removal.
      if (ctBase === 'text/html') {
        return he.decode(raw)
          // Now strip tags (which may include newly-decoded ones)
          .replace(/<script[\s\S]*?<\/script>/gi, '')   // remove script blocks
          .replace(/<style[\s\S]*?<\/style>/gi, '')      // remove style blocks
          .replace(/<[^>]+>/g, ' ')                      // strip remaining tags
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      return raw;
    } finally {
      // Destroy the final-hop dispatcher AFTER body has been consumed (or on any throw).
      lastDispatcher?.destroy().catch(() => {});
    }
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
