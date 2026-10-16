// src/llm/ws-client.ts - Minimal RFC 6455 WebSocket client (handshake + frames) over node:net/tls
//
// Node's built-in WebSocket cannot send custom headers and the runtime dependency budget is
// `picocolors` only, so the gitlab-duo-agent wire hand-rolls the subset it needs: masked text
// frames client→server, text/close/ping/pong frames server→client.

import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

type Socket = net.Socket | tls.TLSSocket;

export class WsClient {
  private queue: string[] = [];
  private waiters: ((message: string | null) => void)[] = [];
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;

  private constructor(private readonly socket: Socket) {}

  static async connect(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<WsClient> {
    if (signal?.aborted) throw new Error('WebSocket connect aborted');
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error(`unsupported WebSocket protocol: ${parsed.protocol}`);
    }
    const secure = parsed.protocol === 'wss:';
    const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
    // SNI must not carry an IP literal; Node rejects it there.
    const sni = net.isIP(parsed.hostname) ? {} : { servername: parsed.hostname };
    const socket: Socket = secure
      ? tls.connect({ host: parsed.hostname, port, ...sni })
      : net.createConnection({ host: parsed.hostname, port });

    const onAbort = (): void => {
      socket.destroy();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await once(socket, secure ? 'secureConnect' : 'connect');
      const key = crypto.randomBytes(16).toString('base64');
      const headerLines = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('');
      socket.write(
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${headerLines}\r\n\r\n`,
      );
      const head = await readHandshake(socket);
      assertHandshake(head, key);
      const client = new WsClient(socket);
      client.adopt(head.subarray(head.indexOf('\r\n\r\n') + 4));
      return client;
    } catch (err) {
      socket.destroy();
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Queues a text frame; the peer expects client frames to be masked (RFC 6455 §5.3). */
  send(text: string): void {
    if (this.closed) return;
    this.writeFrame(0x1, Buffer.from(text, 'utf8'));
  }

  /** The next text message, or null once the connection is closed. */
  next(): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Best-effort close frame, then the socket goes away. */
  close(): void {
    if (this.closed) return;
    try {
      this.writeFrame(0x8, Buffer.alloc(0));
    } catch {
      // Already gone; nothing to send.
    }
    this.closed = true;
    this.socket.end();
    this.flush();
  }

  /** Wires the post-handshake data/error/close events and replays any buffered bytes. */
  private adopt(rest: Buffer): void {
    this.socket.on('data', (chunk: Buffer) => this.feed(chunk));
    this.socket.on('error', () => this.destroy());
    this.socket.on('close', () => this.destroy());
    if (rest.length > 0) this.feed(rest);
  }

  private destroy(): void {
    if (this.closed) {
      this.flush();
      return;
    }
    this.closed = true;
    this.flush();
  }

  private flush(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(null);
  }

  private deliver(text: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(text);
    else this.queue.push(text);
  }

  private feed(data: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    while (true) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) {
          this.destroy();
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_FRAME_BYTES) {
        this.destroy();
        return;
      }
      let maskKey: Buffer | undefined;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      if (maskKey) {
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ maskKey[i % 4]!;
        payload = unmasked;
      }
      this.buffer = this.buffer.subarray(offset + len);
      this.dispatch(fin, opcode, payload);
    }
  }

  private dispatch(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      this.closed = true;
      this.socket.destroy();
      this.flush();
      return;
    }
    if (opcode === 0x9) {
      // RFC 6455 §5.5.2: a pong echoes the ping's payload.
      this.writeFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) this.deliver(payload.toString('utf8'));
      else this.fragments = [payload];
      return;
    }
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) {
        this.deliver(Buffer.concat(this.fragments).toString('utf8'));
        this.fragments = [];
      }
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 0x10000) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
}

/** Resolves with the socket's first `event`, or rejects when it errors/closes first. */
function once(socket: Socket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      socket.off('error', onError);
      socket.off(event, onEvent);
      socket.off('close', onClose);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`connection closed before WebSocket ${event}`));
    };
    socket.once('error', onError);
    socket.once(event, onEvent);
    socket.once('close', onClose);
  });
}

/** Buffers bytes until the response header terminator. */
function readHandshake(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      acc = Buffer.concat([acc, chunk]);
      if (acc.indexOf('\r\n\r\n') === -1) return;
      cleanup();
      resolve(acc);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('connection closed during WebSocket handshake'));
    };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function assertHandshake(head: Buffer, key: string): void {
  const text = head.toString('latin1');
  const [statusLine, ...rest] = text.split('\r\n');
  const status = Number(statusLine?.split(' ')[1]);
  if (status !== 101) throw new Error(`WebSocket handshake failed: ${statusLine ?? 'no status line'}`);
  const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const acceptName = 'sec-websocket-accept:';
  const got = rest
    .find((line) => line.toLowerCase().startsWith(acceptName))
    ?.slice(acceptName.length)
    .trim();
  if (got !== expect) throw new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept');
}
