// tests/fake-server.ts - HTTP server on 127.0.0.1 for wire tests; records every request

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export async function startFakeServer(handler: (req: SeenRequest, res: http.ServerResponse) => void) {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(request);
      handler(request, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
