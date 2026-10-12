import { EventEmitter } from 'node:events';
import type { LiveEvent } from '../events.js';
import { TikTokLiveConnection, UserOfflineError } from '../tiktok/connection.js';
import { UserNotFoundError, type RoomStatus } from '../tiktok/web.js';
import { DemoSource } from './demo.js';

export const DEMO_USERNAME = 'demo';

export type SessionState =
  /** Not connected and not trying to. */
  | 'idle'
  /** User is offline; polling until they go live. */
  | 'waiting'
  | 'connecting'
  | 'live'
  | 'error';

export interface SessionStats {
  likes: number;
  diamonds: number;
  follows: number;
  shares: number;
  joins: number;
  chats: number;
  viewers: number;
  peakViewers: number;
}

export interface SessionStatus {
  username: string;
  state: SessionState;
  roomId?: string;
  title?: string;
  owner?: RoomStatus['owner'];
  liveSince?: number;
  error?: string;
  stats: SessionStats;
}

export interface SessionOptions {
  /** How often to check whether an offline user has gone live. */
  pollIntervalMs?: number;
  /** Number of recent events replayed to newly connected overlays. */
  historySize?: number;
}

const emptyStats = (): SessionStats => ({
  likes: 0,
  diamonds: 0,
  follows: 0,
  shares: 0,
  joins: 0,
  chats: 0,
  viewers: 0,
  peakViewers: 0,
});

/**
 * Owns the TikTok connection for one streamer and keeps it alive across
 * stream restarts, tracking running stats for overlays like goal bars.
 */
export class Session extends EventEmitter<{ event: [LiveEvent]; status: [SessionStatus] }> {
  private conn: TikTokLiveConnection | undefined;
  private demo: DemoSource | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private statsTimer: NodeJS.Timeout | undefined;
  private running = false;
  private _state: SessionState = 'idle';
  private error: string | undefined;
  private room: RoomStatus | undefined;
  private liveSince: number | undefined;
  private stats = emptyStats();
  private readonly history: LiveEvent[] = [];
  private readonly pollIntervalMs: number;
  private readonly historySize: number;

  constructor(
    readonly username: string,
    options: SessionOptions = {},
  ) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.historySize = options.historySize ?? 50;
  }

  get isDemo(): boolean {
    return this.username === DEMO_USERNAME;
  }

  get status(): SessionStatus {
    return {
      username: this.username,
      state: this._state,
      ...(this.room ? { roomId: this.room.roomId, title: this.room.title, owner: this.room.owner } : {}),
      ...(this.liveSince ? { liveSince: this.liveSince } : {}),
      ...(this.error ? { error: this.error } : {}),
      stats: { ...this.stats },
    };
  }

  recentEvents(): LiveEvent[] {
    return [...this.history];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.isDemo) {
      this.demo = new DemoSource();
      this.demo.on('event', (e) => this.handleEvent(e));
      this.demo.start();
      this.liveSince = Date.now();
      this.setState('live');
      return;
    }
    void this.tryConnect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    clearTimeout(this.statsTimer);
    this.statsTimer = undefined;
    this.demo?.stop();
    this.demo = undefined;
    const conn = this.conn;
    this.conn = undefined;
    conn?.removeAllListeners();
    conn?.on('error', () => {});
    conn?.disconnect();
    this.setState('idle');
  }

  /** Injects an event as if it came from TikTok; used by the dashboard's test buttons. */
  inject(event: LiveEvent): void {
    this.handleEvent(event);
  }

  private async tryConnect(): Promise<void> {
    if (!this.running) return;
    this.setState('connecting');
    const conn = new TikTokLiveConnection(this.username);
    this.conn = conn;

    conn.on('event', (e) => this.handleEvent(e));
    conn.on('error', () => {
      // Transient errors are retried by the connection; terminal ones surface via 'disconnected'.
    });
    conn.on('connected', () => this.setState('live'));
    conn.on('disconnected', ({ willReconnect, reason }) => {
      if (conn !== this.conn) return;
      if (willReconnect) {
        this.setState('connecting');
        return;
      }
      this.conn = undefined;
      this.liveSince = undefined;
      if (this.running) {
        if (reason === 'reconnect failed') this.error = 'Lost connection to TikTok';
        this.schedulePoll();
      }
    });

    try {
      await conn.connect();
      if (conn !== this.conn) return;
      this.room = conn.room;
      this.error = undefined;
      this.liveSince = Date.now();
      this.stats = emptyStats();
      this.stats.viewers = this.room?.viewerCount ?? 0;
      this.stats.peakViewers = this.stats.viewers;
      this.setState('live');
    } catch (err) {
      if (conn !== this.conn) return;
      this.conn = undefined;
      if (err instanceof UserOfflineError) {
        this.error = undefined;
        this.schedulePoll();
      } else if (err instanceof UserNotFoundError) {
        this.error = err.message;
        this.running = false;
        this.setState('error');
      } else {
        this.error = (err as Error).message;
        this.schedulePoll();
      }
    }
  }

  private schedulePoll(): void {
    this.setState(this.error ? 'error' : 'waiting');
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.tryConnect(), this.pollIntervalMs);
  }

  private handleEvent(event: LiveEvent): void {
    const s = this.stats;
    switch (event.type) {
      case 'like':
        s.likes = Math.max(s.likes + event.likeCount, event.totalLikeCount);
        break;
      case 'gift':
        if (!event.streaking) s.diamonds += event.totalDiamonds;
        break;
      case 'follow':
        s.follows++;
        break;
      case 'share':
        s.shares++;
        break;
      case 'join':
        s.joins++;
        break;
      case 'chat':
        s.chats++;
        break;
      case 'viewers':
        s.viewers = event.viewerCount;
        s.peakViewers = Math.max(s.peakViewers, event.viewerCount);
        break;
    }

    // Likes and viewer counts are too noisy to be useful as replayed history.
    if (event.type !== 'like' && event.type !== 'viewers') {
      this.history.push(event);
      if (this.history.length > this.historySize) this.history.shift();
    }
    this.emit('event', event);

    // Push stat changes to overlays (goal bars etc.) at most once per second.
    this.statsTimer ??= setTimeout(() => {
      this.statsTimer = undefined;
      this.emit('status', this.status);
    }, 1000);
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.emit('status', this.status);
  }
}
