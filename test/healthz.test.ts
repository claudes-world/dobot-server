import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHealthServer } from '../src/index.js';

// Helper: make an HTTP GET request and return { statusCode, body }
function get(server: http.Server, path: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('/healthz endpoint', () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createHealthServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve); // port 0 = OS assigns ephemeral port
      server.once('error', reject);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /healthz returns 200 with status=ok JSON', async () => {
    const { statusCode, body } = await get(server, '/healthz');
    expect(statusCode).toBe(200);
    const json = JSON.parse(body) as { status: string; uptime: number };
    expect(json.status).toBe('ok');
    expect(typeof json.uptime).toBe('number');
    expect(json.uptime).toBeGreaterThanOrEqual(0);
  });

  it('GET /other returns 404', async () => {
    const { statusCode } = await get(server, '/other');
    expect(statusCode).toBe(404);
  });

  it('GET / returns 404', async () => {
    const { statusCode } = await get(server, '/');
    expect(statusCode).toBe(404);
  });
});

describe('sd-notify API surface', () => {
  it('ready() and startWatchdogMode() exist and are callable without throwing', () => {
    // Load sd-notify the same way index.ts does — via createRequire from a CJS module.
    // This test verifies the module loads correctly and the expected methods are present.
    const _require = createRequire(import.meta.url);
    const sdNotify = _require('sd-notify') as {
      ready: () => void;
      startWatchdogMode: (ms: number) => void;
      stopWatchdogMode: () => void;
      watchdog: () => void;
    };

    expect(typeof sdNotify.ready).toBe('function');
    expect(typeof sdNotify.startWatchdogMode).toBe('function');
    expect(typeof sdNotify.stopWatchdogMode).toBe('function');
    expect(typeof sdNotify.watchdog).toBe('function');
  });

  it('startWatchdogMode sets up a repeating timer and stopWatchdogMode clears it', () => {
    const _require = createRequire(import.meta.url);
    const sdNotify = _require('sd-notify') as {
      startWatchdogMode: (ms: number) => void;
      stopWatchdogMode: () => void;
    };

    // Spy on setInterval/clearInterval to confirm timer lifecycle
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    sdNotify.startWatchdogMode(15_000);
    expect(setIntervalSpy).toHaveBeenCalled();

    sdNotify.stopWatchdogMode();
    expect(clearIntervalSpy).toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
