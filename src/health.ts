import http from 'node:http';

/** Tiny health endpoint — no deps beyond Node built-ins. */
export function createHealthServer(): http.Server {
  const startTime = Date.now();
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const body = JSON.stringify({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}
