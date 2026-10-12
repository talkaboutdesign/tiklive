import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { LiveEvent, LiveEventOf, LiveEventType } from '../events.js';
import { decodeSocketFrame, encodeAck, encodeEnterRoom, encodeHeartbeat, type RawMessage } from '../proto/frames.js';
import { decodeLiveEvent } from '../proto/messages.js';
import { normalizeUsername, TikTokWeb, type RoomStatus } from './web.js';

export class UserOfflineError extends Error {}

export interface ConnectionOptions {
  /** Skip the room lookup and connect to this room directly. */
  roomId?: string;
  /** WebSocket hosts to try, in order. Entries may be full `ws(s)://` base URLs. */
  wsHosts?: string[];
  userAgent?: string;
  /** Emit the few recent comments TikTok replays on connect. Default false. */
  includeHistory?: boolean;
  /** Reconnect after unexpected disconnects. Default true. */
  autoReconnect?: boolean;
  /** Give up after this many consecutive failed reconnects. Default 10. */
  maxReconnectAttempts?: number;
  heartbeatIntervalMs?: number;
  connectTimeoutMs?: number;
  /** Override for tests or custom HTTP stacks. */
  web?: TikTokWeb;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface ConnectedInfo {
  roomId: string;
  room?: RoomStatus;
  wsHost: string;
}

export interface DisconnectedInfo {
  code: number;
  reason: string;
  willReconnect: boolean;
}

type EventListeners = {
  [K in LiveEventType]: [event: LiveEventOf<K>];
};

export interface ConnectionEvents extends EventListeners {
  event: [event: LiveEvent];
  connected: [info: ConnectedInfo];
  disconnected: [info: DisconnectedInfo];
  /** Every decoded message, including types without a normalized event. */
  rawMessage: [message: RawMessage];
  error: [error: Error];
}

const DEFAULT_WS_HOSTS = ['webcast-ws.tiktok.com', 'webcast-ws.us.tiktok.com'];
const WS_PATH = '/webcast/im/ws_proxy/ws_reuse_supplement/';

/**
 * A live connection to one TikTok LIVE room.
 *
 * The webcast WebSocket only needs an anonymous `ttwid` cookie, so no request
 * signing, login, or third-party service is involved.
 */
export class TikTokLiveConnection extends EventEmitter<ConnectionEvents> {
  readonly username: string;
  readonly web: TikTokWeb;

  private readonly options: Required<Omit<ConnectionOptions, 'roomId' | 'web' | 'userAgent'>>;
  private ws: WebSocket | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private manualClose = false;
  private _state: ConnectionState = 'disconnected';
  private _roomId: string | undefined;
  private _room: RoomStatus | undefined;
  private readonly seenMsgIds = new Set<string>();

  constructor(username: string, options: ConnectionOptions = {}) {
    super();
    this.username = normalizeUsername(username);
    this.web = options.web ?? new TikTokWeb(options.userAgent);
    this._roomId = options.roomId;
    this.options = {
      wsHosts: options.wsHosts ?? DEFAULT_WS_HOSTS,
      includeHistory: options.includeHistory ?? false,
      autoReconnect: options.autoReconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
    };
  }

  get state(): ConnectionState {
    return this._state;
  }

  get roomId(): string | undefined {
    return this._roomId;
  }

  get room(): RoomStatus | undefined {
    return this._room;
  }

  /** Resolves once events are flowing. Rejects with {@link UserOfflineError} if the user isn't live. */
  async connect(): Promise<ConnectedInfo> {
    if (this._state === 'connected' || this._state === 'connecting') {
      throw new Error(`Already ${this._state}`);
    }
    this.manualClose = false;
    this._state = 'connecting';
    try {
      const info = await this.establish();
      this.reconnectAttempts = 0;
      return info;
    } catch (err) {
      this._state = 'disconnected';
      throw err;
    }
  }

  disconnect(): void {
    this.manualClose = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.ws) {
      this.ws.close(1000);
    } else if (this._state !== 'disconnected') {
      this._state = 'disconnected';
    }
  }

  private async establish(): Promise<ConnectedInfo> {
    // Always refresh room status: a streamer gets a new room ID each time they go live.
    if (!this._roomId || this._room) {
      this._room = await this.web.getRoomStatus(this.username);
      if (!this._room.isLive) throw new UserOfflineError(`@${this.username} is not live`);
      this._roomId = this._room.roomId;
    }
    const roomId = this._roomId;
    const ttwid = await this.web.getTtwid();

    let lastError: unknown;
    for (const host of this.options.wsHosts) {
      try {
        const ws = await this.openSocket(host, roomId, ttwid);
        this.attach(ws, roomId);
        const info: ConnectedInfo = { roomId, wsHost: host, ...(this._room ? { room: this._room } : {}) };
        this._state = 'connected';
        this.emit('connected', info);
        return info;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Failed to open WebSocket');
  }

  private openSocket(host: string, roomId: string, ttwid: string): Promise<WebSocket> {
    const ua = this.web.userAgent;
    const params = new URLSearchParams({
      version_code: '180800',
      device_platform: 'web',
      cookie_enabled: 'true',
      screen_width: '1920',
      screen_height: '1080',
      browser_language: 'en-US',
      browser_platform: 'MacIntel',
      browser_name: 'Mozilla',
      browser_version: ua.replace(/^Mozilla\//, ''),
      browser_online: 'true',
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
      app_name: 'tiktok_web',
      sup_ws_ds_opt: '1',
      update_version_code: '2.0.0',
      compress: 'gzip',
      webcast_language: 'en',
      ws_direct: '1',
      aid: '1988',
      live_id: '12',
      app_language: 'en',
      client_enter: '1',
      room_id: roomId,
      identity: 'audience',
      history_comment_count: '6',
      heartbeat_duration: String(this.options.heartbeatIntervalMs),
      resp_content_type: 'protobuf',
      did_rule: '3',
    });

    const base = /^wss?:\/\//.test(host) ? host : `wss://${host}${WS_PATH}`;
    const ws = new WebSocket(`${base}?${params}`, {
      headers: { 'User-Agent': ua, Cookie: `ttwid=${ttwid}`, Origin: 'https://www.tiktok.com' },
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`Timed out connecting to ${host}`)), this.options.connectTimeoutMs);
      const fail = (err: Error) => {
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.on('error', () => {});
        ws.terminate();
        reject(err);
      };
      ws.once('open', () => {
        clearTimeout(timer);
        ws.removeAllListeners();
        resolve(ws);
      });
      ws.once('error', fail);
      ws.once('unexpected-response', (_req, res) => {
        const msg = res.headers['handshake-msg'];
        fail(new Error(`${host} rejected the WebSocket (HTTP ${res.statusCode}${msg ? `: ${msg}` : ''})`));
      });
    });
  }

  private attach(ws: WebSocket, roomId: string): void {
    this.ws = ws;
    ws.send(encodeEnterRoom(roomId));
    this.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeHeartbeat(roomId));
    }, this.options.heartbeatIntervalMs);

    ws.on('message', (data: Buffer) => {
      this.handleFrame(ws, data).catch((err) => this.emitError(err));
    });
    ws.on('error', (err) => this.emitError(err));
    ws.on('close', (code, reason) => this.handleClose(ws, code, reason.toString()));
  }

  private async handleFrame(ws: WebSocket, data: Buffer): Promise<void> {
    const { frame, result } = await decodeSocketFrame(data);
    if (!result) return;
    if (frame.logId && frame.logId !== '0' && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeAck(frame.logId));
    }

    for (const raw of result.messages) {
      this.emit('rawMessage', raw);
      if (raw.isHistory && !this.options.includeHistory) continue;
      if (this.isDuplicate(raw.msgId)) continue;

      let event: LiveEvent | undefined;
      try {
        event = decodeLiveEvent(raw);
      } catch (err) {
        this.emitError(new Error(`Failed to decode ${raw.method}: ${(err as Error).message}`));
        continue;
      }
      if (!event) continue;

      this.emit('event', event);
      (this.emit as (name: string, e: LiveEvent) => boolean)(event.type, event);

      if (event.type === 'streamEnd') {
        this.manualClose = true;
        ws.close(1000);
      }
    }
  }

  /** TikTok can redeliver messages after reconnects; drop ones we've already emitted. */
  private isDuplicate(msgId: string): boolean {
    if (!msgId || msgId === '0') return false;
    if (this.seenMsgIds.has(msgId)) return true;
    this.seenMsgIds.add(msgId);
    if (this.seenMsgIds.size > 5000) {
      const oldest = this.seenMsgIds.values().next().value;
      if (oldest !== undefined) this.seenMsgIds.delete(oldest);
    }
    return false;
  }

  private handleClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.ws = undefined;
    ws.removeAllListeners();
    ws.on('error', () => {});

    const willReconnect =
      !this.manualClose && this.options.autoReconnect && this.reconnectAttempts < this.options.maxReconnectAttempts;
    this._state = willReconnect ? 'reconnecting' : 'disconnected';
    this.emit('disconnected', { code, reason, willReconnect });
    if (willReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.manualClose) return;
      try {
        await this.establish();
        this.reconnectAttempts = 0;
      } catch (err) {
        this.emitError(err as Error);
        if (err instanceof UserOfflineError) {
          this._state = 'disconnected';
          this.emit('disconnected', { code: 0, reason: 'offline', willReconnect: false });
        } else if (this.reconnectAttempts < this.options.maxReconnectAttempts && !this.manualClose) {
          this.scheduleReconnect();
        } else {
          this._state = 'disconnected';
          this.emit('disconnected', { code: 0, reason: 'reconnect failed', willReconnect: false });
        }
      }
    }, delay);
  }

  private emitError(err: Error): void {
    // EventEmitter throws on unhandled 'error' events; only emit when someone listens.
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }
}
