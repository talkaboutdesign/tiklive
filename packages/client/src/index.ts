/**
 * tiklive browser client — drop into any overlay page.
 *
 *   import { TikLive } from '/tiklive.js';
 *   const live = new TikLive({ username: 'yourname' });
 *   live.on('chat', (e) => console.log(e.user.nickname, e.comment));
 *   live.on('gift', (e) => { if (!e.streaking) showAlert(e); });
 *
 * Options default from the page URL, so one overlay file works for any
 * streamer: /overlays/chat.html?username=yourname&token=...
 *
 * Event payloads match the `LiveEvent` types in src/events.ts.
 */
export class TikLive {
  /**
   * @param {object} [options]
   * @param {string} [options.username]  Streamer to follow (default: ?username= or "demo").
   * @param {string} [options.server]    WebSocket URL (default: this page's host + /ws).
   * @param {string} [options.token]     Access token if the server requires one (default: ?token=).
   * @param {string[]} [options.events]  Only receive these event types.
   * @param {boolean} [options.replay]   Replay recent events on connect (handy for chat boxes).
   */
  constructor(options = {}) {
    const params = new URLSearchParams(location.search);
    this.username = options.username ?? params.get('username') ?? 'demo';
    this.token = options.token ?? params.get('token') ?? '';
    this.events = options.events ?? null;
    this.replay = options.replay ?? false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.server = options.server ?? `${proto}//${location.host}/ws`;
    this.status = null;
    this._handlers = new Map();
    this._retry = 0;
    this._closed = false;
    this._connect();
  }

  /**
   * Listen for an event type ('chat', 'gift', 'like', 'follow', 'share', 'join',
   * 'subscribe', 'question', 'emote', 'viewers', 'streamEnd'), or:
   *  - '*'       every LIVE event
   *  - 'status'  session status changes ({ state, stats, title, owner, ... })
   *  - 'open' / 'close'  connection to the tiklive server
   * Returns an unsubscribe function.
   */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(handler);
    return () => this._handlers.get(type)?.delete(handler);
  }

  close() {
    this._closed = true;
    this._ws?.close();
  }

  _emit(type, payload, meta) {
    for (const h of this._handlers.get(type) ?? []) {
      try {
        h(payload, meta);
      } catch (err) {
        console.error(`[tiklive] ${type} handler failed`, err);
      }
    }
  }

  _connect() {
    const url = new URL(this.server);
    if (this.token) url.searchParams.set('token', this.token);
    const ws = (this._ws = new WebSocket(url));

    ws.onopen = () => {
      this._retry = 0;
      ws.send(JSON.stringify({ action: 'subscribe', username: this.username, events: this.events, replay: this.replay }));
      this._emit('open');
    };

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === 'event') {
        const meta = { replay: !!data.replay, username: data.username };
        this._emit(data.event.type, data.event, meta);
        this._emit('*', data.event, meta);
      } else if (data.type === 'status') {
        this.status = data.status;
        this._emit('status', data.status);
      } else if (data.type === 'error') {
        console.warn('[tiklive]', data.message);
      }
    };

    ws.onclose = () => {
      this._emit('close');
      if (this._closed) return;
      const delay = Math.min(10000, 500 * 2 ** this._retry++);
      setTimeout(() => this._connect(), delay);
    };
  }
}
