import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIVE_EVENT_TYPES, type LiveEvent, type LiveEventType } from '../events.js';
import { normalizeUsername } from '../tiktok/web.js';
import { Session, type SessionOptions, type SessionStatus } from './session.js';

export interface ServerOptions extends SessionOptions {
  port?: number;
  host?: string;
  /** When set, required as `?token=` (WebSocket) or `Authorization: Bearer` (REST). */
  token?: string;
  /** Static files (overlays, dashboard). Set to false to disable. */
  publicDir?: string | false;
  /** Usernames to watch permanently, connecting whenever they go live. */
  watch?: string[];
  /** How long a session with no overlays attached stays connected. */
  idleTimeoutMs?: number;
}

/** Messages sent to overlay clients. */
export type ServerMessage =
  | { type: 'event'; username: string; event: LiveEvent; replay?: boolean }
  | { type: 'status'; username: string; status: SessionStatus }
  | { type: 'error'; message: string };

/** Messages overlay clients may send. */
export type ClientMessage =
  | { action: 'subscribe'; username: string; events?: LiveEventType[]; replay?: boolean }
  | { action: 'unsubscribe'; username: string };

interface Subscription {
  events: Set<LiveEventType> | null;
}

interface Client {
  ws: WebSocket;
  subs: Map<string, Subscription>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class LiveServer {
  readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<string, Session>();
  private readonly pinned = new Set<string>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly clients = new Set<Client>();
  private readonly options: ServerOptions;

  constructor(options: ServerOptions = {}) {
    this.options = options;
    this.http = createHttpServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        sendJson(res, status, { error: (err as Error).message });
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws' || !this.authorized(req, url)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handleClient(ws, url));
    });
    for (const name of options.watch ?? []) this.watch(name);
  }

  listen(): Promise<{ port: number; host: string }> {
    const port = this.options.port ?? 8080;
    const host = this.options.host ?? '127.0.0.1';
    return new Promise((resolvePromise, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        const addr = this.http.address();
        resolvePromise({ port: typeof addr === 'object' && addr ? addr.port : port, host });
      });
    });
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.stop();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    for (const client of this.clients) client.ws.terminate();
    this.wss.close();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  /** Keeps a session running regardless of attached overlays. */
  watch(username: string): Session {
    const name = normalizeUsername(username);
    this.pinned.add(name);
    return this.getSession(name);
  }

  unwatch(username: string): void {
    const name = normalizeUsername(username);
    this.pinned.delete(name);
    this.maybeStop(name);
  }

  private getSession(name: string): Session {
    let session = this.sessions.get(name);
    if (!session) {
      session = new Session(name, this.options);
      session.on('event', (event) => this.broadcastEvent(name, event));
      session.on('status', (status) => this.broadcast(name, { type: 'status', username: name, status }));
      this.sessions.set(name, session);
      session.start();
    }
    clearTimeout(this.idleTimers.get(name));
    this.idleTimers.delete(name);
    return session;
  }

  private subscriberCount(name: string): number {
    let n = 0;
    for (const c of this.clients) if (c.subs.has(name)) n++;
    return n;
  }

  private maybeStop(name: string): void {
    if (this.pinned.has(name) || this.subscriberCount(name) > 0 || this.idleTimers.has(name)) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(name);
      if (this.pinned.has(name) || this.subscriberCount(name) > 0) return;
      this.sessions.get(name)?.stop();
      this.sessions.delete(name);
    }, this.options.idleTimeoutMs ?? 60_000);
    this.idleTimers.set(name, timer);
  }

  private broadcastEvent(name: string, event: LiveEvent): void {
    const payload = JSON.stringify({ type: 'event', username: name, event } satisfies ServerMessage);
    for (const client of this.clients) {
      const sub = client.subs.get(name);
      if (sub && (!sub.events || sub.events.has(event.type))) client.ws.send(payload);
    }
  }

  private broadcast(name: string, message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients) if (client.subs.has(name)) client.ws.send(payload);
  }

  // ---- WebSocket clients ----

  private handleClient(ws: WebSocket, url: URL): void {
    const client: Client = { ws, subs: new Map() };
    this.clients.add(client);

    const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));

    const subscribe = (raw: string, events?: string[] | null, replay = false) => {
      const name = normalizeUsername(raw);
      if (!/^[a-z0-9._]{1,32}$/.test(name)) {
        send({ type: 'error', message: `Invalid username: ${raw}` });
        return;
      }
      // null = all events; an empty list = status updates only.
      const filter = Array.isArray(events)
        ? new Set(events.filter((e): e is LiveEventType => (LIVE_EVENT_TYPES as string[]).includes(e)))
        : null;
      client.subs.set(name, { events: filter });
      const session = this.getSession(name);
      send({ type: 'status', username: name, status: session.status });
      if (replay) {
        for (const event of session.recentEvents()) {
          if (!filter || filter.has(event.type)) send({ type: 'event', username: name, event, replay: true });
        }
      }
    };

    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send({ type: 'error', message: 'Messages must be JSON' });
        return;
      }
      if (msg.action === 'subscribe' && typeof msg.username === 'string') {
        subscribe(msg.username, msg.events, msg.replay);
      } else if (msg.action === 'unsubscribe' && typeof msg.username === 'string') {
        const name = normalizeUsername(msg.username);
        client.subs.delete(name);
        this.maybeStop(name);
      } else {
        send({ type: 'error', message: 'Unknown action' });
      }
    });

    ws.on('close', () => {
      this.clients.delete(client);
      for (const name of client.subs.keys()) this.maybeStop(name);
    });

    // Shortcut for overlays: /ws?username=foo&events=chat,gift&replay=1
    const username = url.searchParams.get('username');
    if (username) {
      const events = url.searchParams.get('events');
      subscribe(username, events === null ? null : events.split(','), url.searchParams.get('replay') === '1');
    }
  }

  // ---- HTTP ----

  private authorized(req: IncomingMessage, url: URL): boolean {
    const expected = this.options.token;
    if (!expected) return true;
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const given = header ?? url.searchParams.get('token') ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/health') return sendJson(res, 200, { ok: true });

    if (path.startsWith('/api/')) {
      if (!this.authorized(req, url)) throw new HttpError(401, 'Unauthorized');
      return this.handleApi(req, res, path);
    }

    if (this.options.publicDir === false) throw new HttpError(404, 'Not found');
    return this.serveStatic(res, path);
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/api/sessions' && req.method === 'GET') {
      return sendJson(res, 200, {
        sessions: [...this.sessions.values()].map((s) => ({
          ...s.status,
          watching: this.pinned.has(s.username),
          overlays: this.subscriberCount(s.username),
        })),
      });
    }

    const match = path.match(/^\/api\/sessions\/([^/]+)(\/simulate)?$/);
    if (!match) throw new HttpError(404, 'Not found');
    const name = normalizeUsername(decodeURIComponent(match[1]!));

    if (match[2]) {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const session = this.sessions.get(name);
      if (!session) throw new HttpError(404, `No session for @${name}`);
      const body = (await readJson(req)) as Partial<LiveEvent>;
      if (!body.type || !(LIVE_EVENT_TYPES as string[]).includes(body.type)) {
        throw new HttpError(400, `"type" must be one of: ${LIVE_EVENT_TYPES.join(', ')}`);
      }
      const event = { timestamp: Date.now(), msgId: `sim-${Date.now()}`, ...body } as LiveEvent;
      session.inject(event);
      return sendJson(res, 200, { ok: true, event });
    }

    switch (req.method) {
      case 'GET': {
        const session = this.sessions.get(name);
        if (!session) throw new HttpError(404, `No session for @${name}`);
        return sendJson(res, 200, { ...session.status, watching: this.pinned.has(name) });
      }
      case 'PUT':
      case 'POST':
        return sendJson(res, 200, { ...this.watch(name).status, watching: true });
      case 'DELETE':
        this.unwatch(name);
        return sendJson(res, 200, { ok: true });
      default:
        throw new HttpError(405, 'Method not allowed');
    }
  }

  private async serveStatic(res: ServerResponse, path: string): Promise<void> {
    const root = resolve(this.options.publicDir || 'public');
    let file = normalize(join(root, decodeURIComponent(path)));
    if (!file.startsWith(root)) throw new HttpError(403, 'Forbidden');
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      throw new HttpError(404, 'Not found');
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}
