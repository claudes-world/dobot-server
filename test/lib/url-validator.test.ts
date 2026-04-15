import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAndFetchUrl } from '../../src/lib/url-validator.js';

// Mock dns/promises module
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from 'node:dns/promises';
const mockDnsLookup = dns.lookup as ReturnType<typeof vi.fn>;

// Helper to build a minimal Response-like object
function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  location?: string;
}): Response {
  const { status = 200, headers = {}, body = '' } = opts;
  const headerMap = new Headers(headers);
  if (opts.location) headerMap.set('location', opts.location);

  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  return new Response(stream, { status, headers: headerMap });
}

// Stub global fetch
let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchStub = vi.fn();
  vi.stubGlobal('fetch', fetchStub);
  mockDnsLookup.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('validateAndFetchUrl', () => {
  it('1. valid HTTPS URL — returns body', async () => {
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    fetchStub.mockResolvedValue(
      makeResponse({ headers: { 'content-type': 'text/html' }, body: '<h1>Hello</h1>' })
    );

    const result = await validateAndFetchUrl('https://example.com/page');
    expect(result).toBe('<h1>Hello</h1>');
  });

  it('2. HTTP URL — throws protocol error', async () => {
    await expect(validateAndFetchUrl('http://example.com/')).rejects.toThrow(
      /Only HTTPS URLs allowed/
    );
  });

  it('3. URL resolving to 127.0.0.1 — throws private IP error', async () => {
    mockDnsLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });

    await expect(validateAndFetchUrl('https://localhost.test/')).rejects.toThrow(
      /private IP address/
    );
  });

  it('4. URL resolving to 10.x.x.x — throws private IP error', async () => {
    mockDnsLookup.mockResolvedValue({ address: '10.0.0.1', family: 4 });

    await expect(validateAndFetchUrl('https://internal.corp/')).rejects.toThrow(
      /private IP address/
    );
  });

  it('5. redirect chain > 3 — throws too-many-redirects', async () => {
    // dns.lookup always returns public IP (called once per hop)
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });

    // 4 consecutive 301s — exceeds MAX_REDIRECTS=3
    fetchStub
      .mockResolvedValueOnce(makeResponse({ status: 301, location: 'https://example.com/r1' }))
      .mockResolvedValueOnce(makeResponse({ status: 301, location: 'https://example.com/r2' }))
      .mockResolvedValueOnce(makeResponse({ status: 301, location: 'https://example.com/r3' }))
      .mockResolvedValueOnce(makeResponse({ status: 301, location: 'https://example.com/r4' }));

    await expect(validateAndFetchUrl('https://example.com/')).rejects.toThrow(
      /Too many redirects/
    );
  });

  it('6. content-type application/json — throws disallowed content-type', async () => {
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    fetchStub.mockResolvedValue(
      makeResponse({ headers: { 'content-type': 'application/json' }, body: '{}' })
    );

    await expect(validateAndFetchUrl('https://example.com/api')).rejects.toThrow(
      /Disallowed content-type/
    );
  });

  it('7. body > 500KB — throws body too large', async () => {
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });

    const bigBody = 'x'.repeat(500 * 1024 + 1);
    fetchStub.mockResolvedValue(
      makeResponse({ headers: { 'content-type': 'text/plain' }, body: bigBody })
    );

    await expect(validateAndFetchUrl('https://example.com/big')).rejects.toThrow(
      /exceeds/
    );
  });

  it('8. AbortController timeout — throws timeout error', async () => {
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });

    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    fetchStub.mockRejectedValue(abortErr);

    await expect(validateAndFetchUrl('https://example.com/slow')).rejects.toThrow(
      /timed out/
    );
  });

  it('9. redirect to HTTP — throws non-HTTPS redirect error', async () => {
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    fetchStub.mockResolvedValueOnce(
      makeResponse({ status: 301, location: 'http://example.com/downgrade' })
    );

    await expect(validateAndFetchUrl('https://example.com/')).rejects.toThrow(
      /non-HTTPS/
    );
  });

  it('10. redirect to private IP — throws private IP error', async () => {
    // DNS called once per hop: first call for example.com (public), second for internal.corp (private)
    mockDnsLookup
      .mockResolvedValueOnce({ address: '93.184.216.34', family: 4 })  // hop 1: example.com
      .mockResolvedValueOnce({ address: '192.168.1.1', family: 4 });   // hop 2: internal.corp

    fetchStub.mockResolvedValueOnce(
      makeResponse({ status: 301, location: 'https://internal.corp/admin' })
    );

    await expect(validateAndFetchUrl('https://example.com/')).rejects.toThrow(
      /private IP address/
    );
  });
});
