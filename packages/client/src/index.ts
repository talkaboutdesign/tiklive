/**
 * tiklive browser client. Drop it into any overlay page:
 *
 * ```html
 * <script type="module">
 *   import { TikLive } from '/tiklive.js';
 *   const live = new TikLive({ username: 'yourname' });
 *   live.on('chat', (e) => console.log(e.user.nickname, e.comment));
 *   live.on('gift', (e) => { if (!e.streaking) showAlert(e); });
 * </script>
 * ```
 *
 * Types are imported from `@tiklive/contracts` and erased at build time, so the
 * bundle (`dist/tiklive.js`) contains no runtime dependencies and no Effect code.
 * Works in browsers and in Bun/Node (anywhere with a global `WebSocket`).
 *
 * @module
 */
import type {
  ErrorMessage,
  FiredAction,
  GiftInfo,
  HelloMessage,
  LiveEvent,
  LiveEventOf,
  LiveEventType,
  ServerMessage,
  SessionStatus,
  SubscribeMessage,
} from "@tiklive/contracts";

/** Wire protocol version this client speaks. Must match the server's `PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 1;

const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

/** Extra fields that accompany every event delivered to a handler. */
export interface EventMeta {
  /** True when the event was replayed from the server's history (see `replay` option). */
  replay: boolean;
  /** The TikTok streamer the event belongs to. */
  username: string;
}

/** Options for {@link TikLive}. Every field is optional. */
export interface TikLiveOptions {
  /**
   * Streamer to follow. Defaults to the page's `?username=` query parameter,
   * then to `"demo"` (fake events, no TikTok connection needed).
   */
  username?: string | undefined;
  /**
   * Absolute WebSocket URL of the tiklive server, e.g. `ws://localhost:8080/ws`.
   * Defaults to `ws(s)://<page host>/ws`. Required when there is no page
   * (Node/Bun, tests); otherwise the constructor throws.
   */
  server?: string | undefined;
  /**
   * Access token, sent as `?token=` on the WebSocket URL. Defaults to the page's
   * `?token=` query parameter. Only needed when the server runs with `--token`.
   */
  token?: string | undefined;
  /**
   * Only receive these event types. Omit to receive every event; pass `[]` to
   * receive status updates only (no events).
   */
  events?: readonly LiveEventType[] | undefined;
  /** Ask the server to replay recent events (excluding likes and viewer counts) on connect. */
  replay?: boolean | undefined;
  /**
   * Also receive the actions fired by the server's rules (see the Actions page), as `"action"` events.
   * Default false.
   */
  actions?: boolean | undefined;
  /**
   * WebSocket constructor to use. Defaults to the global `WebSocket`. Mainly
   * useful for tests or for Node versions without a global WebSocket.
   */
  WebSocket?: typeof WebSocket | undefined;
  /**
   * Reconnect with exponential backoff (500 ms, doubling, capped at 10 s) when the
   * connection drops. Defaults to `true`. The backoff resets once a connection opens.
   */
  reconnect?: boolean | undefined;
}

type AnyHandler = (...args: never[]) => void;

interface LocationLike {
  protocol: string;
  host: string;
  search: string;
}

/**
 * Connects to a tiklive server, subscribes to one streamer, and dispatches
 * typed events to handlers registered with {@link TikLive.on}.
 *
 * Connections are established in the constructor and kept alive until
 * {@link TikLive.close} is called. Dropped connections are retried with
 * exponential backoff, and every (re)connect re-sends the subscription.
 *
 * ```ts
 * const live = new TikLive({ username: "yourname", replay: true });
 * live.on("chat", (e, meta) => console.log(meta.replay ? "(old)" : "", e.comment));
 * live.on("gift", (e) => { if (!e.streaking) console.log(e.giftName, e.totalDiamonds); });
 * live.on("status", (s) => console.log(s.state, s.stats.viewers));
 * ```
 *
 * Overlays are usually configured through the page URL, so one file serves any
 * streamer: `/overlays/chat.html?username=yourname&token=...`.
 *
 * {@link TikLive.gifts} fetches the gift catalog (names, prices, images) over HTTP
 * from the same server, for labelling gifts in an overlay.
 */
export class TikLive {
  /** Streamer being followed. */
  readonly username: string;
  /** WebSocket URL in use (without the token). */
  readonly server: string;
  /** Access token, or `""` when none is configured. */
  readonly token: string;
  /** Event types requested on subscribe, or `undefined` for all. */
  readonly events: readonly LiveEventType[] | undefined;
  /** Whether replay was requested on subscribe. */
  readonly replay: boolean;
  /** Whether actions were requested on subscribe. */
  readonly actions: boolean;
  /** Most recent session status from the server, or `null` before the first one. */
  status: SessionStatus | null = null;

  readonly #handlers = new Map<string, Set<AnyHandler>>();
  readonly #WebSocketCtor: typeof WebSocket;
  readonly #reconnect: boolean;
  #socket: WebSocket | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retry = 0;
  #closed = false;
  #warnedVersion = false;

  /**
   * @param options See {@link TikLiveOptions}. All fields are optional.
   * @throws If no `server` is given and there is no page location to derive it from.
   */
  constructor(options: TikLiveOptions = {}) {
    const loc = pageLocation();
    const params = new URLSearchParams(loc?.search ?? "");
    this.username = options.username ?? params.get("username") ?? "demo";
    this.token = options.token ?? params.get("token") ?? "";
    this.events = options.events;
    this.replay = options.replay ?? false;
    this.actions = options.actions ?? false;
    this.#reconnect = options.reconnect ?? true;
    this.#WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
    this.server = options.server ?? defaultServer(loc);
    this.#connect();
  }

  /**
   * Subscribes to a message type. Returns a function that removes the handler.
   *
   * - An event type (`"chat"`, `"gift"`, `"like"`, `"follow"`, `"share"`, `"join"`,
   *   `"subscribe"`, `"question"`, `"emote"`, `"viewers"`, `"streamEnd"`, `"chatDelete"`, `"goal"`) receives
   *   that event with its {@link EventMeta}.
   * - `"*"` receives every event.
   * - `"status"` receives each {@link SessionStatus} update (state, title, stats...).
   * - `"action"` receives each action fired by a rule, with the streamer's username. Only sent when
   *   the client was created with `actions: true`. Not sent to `"*"`.
   * - `"hello"` receives the server's greeting on every connection.
   * - `"error"` receives server-side errors (for example, an invalid username).
   * - `"open"` and `"close"` fire when the underlying connection opens or closes.
   *
   * Handler exceptions are caught and logged with `console.error`, so one faulty
   * handler does not stop the others.
   */
  on<K extends LiveEventType>(type: K, handler: (event: LiveEventOf<K>, meta: EventMeta) => void): () => void;
  on(type: "*", handler: (event: LiveEvent, meta: EventMeta) => void): () => void;
  on(type: "status", handler: (status: SessionStatus) => void): () => void;
  on(type: "action", handler: (action: FiredAction, meta: { username: string }) => void): () => void;
  on(type: "hello", handler: (hello: HelloMessage) => void): () => void;
  on(type: "error", handler: (error: ErrorMessage) => void): () => void;
  on(type: "open" | "close", handler: () => void): () => void;
  on(type: string, handler: AnyHandler): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      this.#handlers.get(type)?.delete(handler);
    };
  }

  /**
   * Fetches the gift catalog from the server's `GET /api/gifts`, sorted by price.
   * The server caches it for an hour. Uses the same host and token as the WebSocket.
   *
   * @throws If the request fails or the server answers with an error status.
   */
  async gifts(): Promise<GiftInfo[]> {
    const url = new URL(this.server);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/api/gifts";
    if (this.token) url.searchParams.set("token", this.token);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[tiklive] gift list request failed with HTTP ${res.status}`);
    const body = (await res.json()) as { gifts: GiftInfo[] };
    return body.gifts;
  }

  /**
   * Closes the connection and stops reconnecting. Handlers stay registered but
   * receive nothing further. The `"close"` handler fires as the socket closes.
   */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#socket?.close();
  }

  #connect(): void {
    const url = new URL(this.server);
    if (this.token) url.searchParams.set("token", this.token);
    const ws = new this.#WebSocketCtor(url.toString());
    this.#socket = ws;

    ws.onopen = () => {
      this.#retry = 0;
      ws.send(JSON.stringify(this.#subscribeMessage()));
      this.#emit("open");
    };

    ws.onmessage = (msg) => this.#handleRaw(msg.data);

    ws.onclose = () => {
      this.#emit("close");
      if (this.#closed || !this.#reconnect) return;
      const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** this.#retry);
      this.#retry++;
      this.#timer = setTimeout(() => this.#connect(), delay);
    };
  }

  #subscribeMessage(): SubscribeMessage {
    // `events` is omitted entirely when unset: the server treats a missing key as "all events".
    return {
      action: "subscribe",
      username: this.username,
      ...(this.events !== undefined && { events: this.events }),
      ...(this.replay && { replay: true }),
      ...(this.actions && { actions: true }),
    };
  }

  #handleRaw(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") return;
    const msg = parsed as unknown as ServerMessage;

    switch (msg.type) {
      case "hello":
        if (msg.protocolVersion !== PROTOCOL_VERSION && !this.#warnedVersion) {
          this.#warnedVersion = true;
          console.warn(
            `[tiklive] server speaks protocol ${msg.protocolVersion}, this client speaks ${PROTOCOL_VERSION}. ` +
              "Update @tiklive/client or the server.",
          );
        }
        this.#emit("hello", msg);
        return;
      case "event": {
        const event = msg.event;
        const meta: EventMeta = { replay: msg.replay === true, username: msg.username };
        this.#emit(event.type, event, meta);
        this.#emit("*", event, meta);
        return;
      }
      case "status":
        this.status = msg.status;
        this.#emit("status", msg.status);
        return;
      case "action":
        // Not sent to "*": that handler is for live events only.
        this.#emit("action", msg.action, { username: msg.username });
        return;
      case "error":
        if (!this.#handlers.get("error")?.size) console.warn(`[tiklive] ${msg.code}: ${msg.message}`);
        this.#emit("error", msg);
        return;
      default:
        // Unknown message type from a newer server: ignore it.
        return;
    }
  }

  #emit(type: string, ...args: unknown[]): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`[tiklive] ${type} handler failed`, err);
      }
    }
  }
}

function pageLocation(): LocationLike | undefined {
  return (globalThis as { location?: LocationLike }).location;
}

function defaultServer(loc: LocationLike | undefined): string {
  if (!loc) {
    throw new Error(
      "TikLive: no page location to derive the server URL from. Pass one explicitly, " +
        "e.g. new TikLive({ server: 'ws://localhost:8080/ws' }).",
    );
  }
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/ws`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
