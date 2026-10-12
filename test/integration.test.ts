import { afterEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, WebSocket } from 'ws';
import { TikTokLiveConnection, UserOfflineError } from '../src/tiktok/connection.js';
import { TikTokWeb, type RoomStatus } from '../src/tiktok/web.js';
import { decodePushFrame, encodePushFrame } from '../src/proto/frames.js';
import { decode, ProtoWriter } from '../src/proto/wire.js';
import { LiveServer, type ServerMessage } from '../src/server/server.js';
import type { LiveEvent } from '../src/events.js';

class FakeWeb extends TikTokWeb {
  constructor(private readonly live: boolean) {
    super();
  }
  override async getTtwid() {
    return 'fake-ttwid';
  }
  override async getRoomStatus(username: string): Promise<RoomStatus> {
    return {
      roomId: '123456789',
      isLive: this.live,
      title: 'test stream',
      viewerCount: 5,
      owner: { userId: '1', uniqueId: username, nickname: username, profilePictureUrl: '', followerCount: 0 },
    };
  }
}

function chatBatch(msgId: string, comment: string): Uint8Array {
  const chat = new ProtoWriter()
    .message(1, new ProtoWriter().varint(2, msgId).varint(4, 1791744000000))
    .message(2, new ProtoWriter().varint(1, '42').string(3, 'Viewer').string(38, 'viewer'))
    .string(3, comment)
    .finish();
  const batch = new ProtoWriter()
    .message(1, new ProtoWriter().string(1, 'WebcastChatMessage').bytes(2, chat).varint(3, msgId))
    .finish();
  return encodePushFrame({ logId: '9001', payloadType: 'msg', payload: new Uint8Array(gzipSync(batch)) });
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fakeTikTok() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  cleanups.push(() => new Promise((r) => wss.close(r)));
  const port = (wss.address() as { port: number }).port;
  return { wss, url: `ws://127.0.0.1:${port}/ws` };
}

describe('TikTokLiveConnection', () => {
  it('joins the room, acks batches, emits events and drops duplicates', async () => {
    const { wss, url } = await fakeTikTok();
    const received: { types: string[]; cookie?: string; roomParam?: string | null } = { types: [] };

    wss.on('connection', (socket, req) => {
      received.cookie = req.headers.cookie;
      received.roomParam = new URL(req.url!, 'http://x').searchParams.get('room_id');
      socket.on('message', (data: Buffer) => {
        const frame = decodePushFrame(data);
        received.types.push(frame.payloadType);
        if (frame.payloadType === 'im_enter_room') {
          expect(decode(frame.payload).id(1)).toBe('123456789');
          socket.send(chatBatch('1', 'hello'));
          socket.send(chatBatch('1', 'hello')); // duplicate
          socket.send(chatBatch('2', 'world'));
        }
      });
    });

    const conn = new TikTokLiveConnection('@Someone', { web: new FakeWeb(true), wsHosts: [url], autoReconnect: false });
    cleanups.push(() => conn.disconnect());
    const events: LiveEvent[] = [];
    conn.on('chat', (e) => events.push(e));

    const info = await conn.connect();
    expect(info.roomId).toBe('123456789');
    expect(conn.username).toBe('someone');

    await expect.poll(() => events.length).toBe(2);
    expect(events.map((e) => (e.type === 'chat' ? e.comment : ''))).toEqual(['hello', 'world']);
    expect(received.cookie).toBe('ttwid=fake-ttwid');
    expect(received.roomParam).toBe('123456789');
    await expect.poll(() => received.types.filter((t) => t === 'ack').length).toBe(3);
  });

  it('rejects when the user is offline', async () => {
    const conn = new TikTokLiveConnection('offline', { web: new FakeWeb(false) });
    await expect(conn.connect()).rejects.toBeInstanceOf(UserOfflineError);
    expect(conn.state).toBe('disconnected');
  });

  it('reconnects after an unexpected close', async () => {
    const { wss, url } = await fakeTikTok();
    let connections = 0;
    wss.on('connection', (socket) => {
      connections++;
      if (connections === 1) setTimeout(() => socket.close(1011), 20);
    });

    const conn = new TikTokLiveConnection('someone', { web: new FakeWeb(true), wsHosts: [url] });
    cleanups.push(() => conn.disconnect());
    const disconnects: boolean[] = [];
    conn.on('disconnected', (d) => disconnects.push(d.willReconnect));
    await conn.connect();

    await expect.poll(() => connections, { timeout: 3000 }).toBe(2);
    await expect.poll(() => conn.state).toBe('connected');
    expect(disconnects).toEqual([true]);
  });
});

describe('LiveServer', () => {
  async function startServer(options: ConstructorParameters<typeof LiveServer>[0] = {}) {
    const server = new LiveServer({ port: 0, publicDir: false, idleTimeoutMs: 50, ...options });
    const { port } = await server.listen();
    cleanups.push(() => server.close());
    return { server, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
  }

  function collect(url: string) {
    const ws = new WebSocket(url);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    cleanups.push(() => ws.close());
    return { ws, messages, open: new Promise((r) => ws.once('open', r)) };
  }

  it('streams demo events with filtering and accepts simulated events', async () => {
    const { base, ws } = await startServer();
    const client = collect(`${ws}?username=demo&events=gift,follow`);
    await client.open;

    await expect.poll(() => client.messages.find((m) => m.type === 'status')).toBeTruthy();
    const status = client.messages.find((m) => m.type === 'status');
    expect(status).toMatchObject({ username: 'demo', status: { state: 'live' } });

    const res = await fetch(`${base}/api/sessions/demo/simulate`, {
      method: 'POST',
      body: JSON.stringify({ type: 'follow', user: { userId: '1', uniqueId: 'tester', nickname: 'Tester', profilePictureUrl: '' } }),
    });
    expect(res.status).toBe(200);

    await expect
      .poll(() => client.messages.some((m) => m.type === 'event' && m.event.type === 'follow' && m.event.user.uniqueId === 'tester'))
      .toBe(true);
    const types = new Set(client.messages.flatMap((m) => (m.type === 'event' ? [m.event.type] : [])));
    for (const t of types) expect(['gift', 'follow']).toContain(t);
  });

  it('requires the token when configured', async () => {
    const { base, ws } = await startServer({ token: 's3cret' });
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/sessions?token=s3cret`)).status).toBe(200);
    expect((await fetch(`${base}/api/sessions`, { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(200);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);

    const denied = new WebSocket(`${ws}?username=demo`);
    denied.on('error', () => {});
    const result = await new Promise((r) => {
      denied.once('open', () => r('open'));
      denied.once('unexpected-response', (_req, res) => r(res.statusCode));
    });
    expect(result).toBe(401);
  });

  it('stops idle sessions once the last overlay leaves', async () => {
    const { base, ws } = await startServer();
    const client = collect(`${ws}?username=demo`);
    await client.open;
    await expect.poll(async () => (await (await fetch(`${base}/api/sessions`)).json()).sessions.length).toBe(1);

    client.ws.close();
    await expect.poll(async () => (await (await fetch(`${base}/api/sessions`)).json()).sessions.length).toBe(0);
  });
});
