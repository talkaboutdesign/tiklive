/**
 * A live connection to one TikTok LIVE room, as a Stream.
 *
 * The webcast WebSocket only needs an anonymous `ttwid` cookie, so no request
 * signing, login, or third-party service is involved.
 */
import type { LiveEvent } from "@tiklive/contracts";
import { normalizeUsername } from "@tiklive/contracts";
import type * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import {
  type ConnectError,
  ReconnectFailed,
  SocketOpenFailed,
  TikTokRequestError,
  UserNotFound,
  UserOffline,
} from "./errors.ts";
import {
  decodeSocketFrame,
  encodeAck,
  encodeEnterRoom,
  encodeHeartbeat,
  type RawMessage,
} from "./proto/frames.ts";
import { decodeLiveEvent } from "./proto/messages.ts";
import * as TikTokWebModule from "./TikTokWeb.ts";
import { type RoomStatus, TikTokWeb } from "./TikTokWeb.ts";

export type DisconnectReason =
  /** The socket dropped unexpectedly. Followed by a reconnect when `willReconnect`. */
  | "network"
  /** TikTok sent a stream-ended control message. */
  | "streamEnd"
  /** On reconnect, the room lookup said the user is no longer live. */
  | "offline";

export type ConnectionEvent =
  | {
      readonly _tag: "Connected";
      readonly roomId: string;
      /** Missing only when connecting with an explicit `roomId`. */
      readonly room: RoomStatus | undefined;
      readonly wsHost: string;
    }
  | { readonly _tag: "Event"; readonly event: LiveEvent }
  /** Every webcast message, including types without a normalized event. Only with `includeRaw`. */
  | { readonly _tag: "Raw"; readonly message: RawMessage }
  | {
      readonly _tag: "Disconnected";
      readonly reason: DisconnectReason;
      readonly willReconnect: boolean;
      readonly detail?: string;
    };

export interface ConnectOptions {
  /** Skip the first room lookup and join this room directly. */
  readonly roomId?: string;
  /** WebSocket hosts to try, in order. Entries may be full `ws(s)://` base URLs. */
  readonly wsHosts?: ReadonlyArray<string>;
  /** Emit the few recent comments TikTok replays on join. Default false. */
  readonly includeHistory?: boolean;
  /** Emit `Raw` events for every webcast message. Default false. */
  readonly includeRaw?: boolean;
  /** Reconnect after unexpected drops. `false` disables. Default: up to 10 attempts, backoff capped at 30s. */
  readonly reconnect?: false | { readonly maxAttempts?: number; readonly maxDelay?: Duration.Input };
  /** Default 10 seconds. */
  readonly heartbeatInterval?: Duration.Input;
  /** Treat the socket as dropped when nothing arrives for this long. Default 60 seconds. */
  readonly idleTimeout?: Duration.Input;
  /** Timeout for the room lookup and for each socket open. Default 15 seconds. */
  readonly connectTimeout?: Duration.Input;
}

export const DEFAULT_WS_HOSTS: ReadonlyArray<string> = ["webcast-ws.tiktok.com", "webcast-ws.us.tiktok.com"];
const WS_PATH = "/webcast/im/ws_proxy/ws_reuse_supplement/";

/** The socket closed after it was open. Internal: turned into a reconnect or ReconnectFailed. */
class Dropped extends Data.TaggedError("Dropped")<{ readonly detail: string }> {}

/**
 * Connects to `username`'s LIVE and streams connection lifecycle and events.
 *
 * - Emits `Connected`, then `Event`s. Drops emit `Disconnected { willReconnect: true }`
 *   followed by a fresh `Connected` once back.
 * - Completes after `Disconnected { reason: "streamEnd" | "offline" }`.
 * - Fails with a {@link ConnectError}: on the first attempt for any problem
 *   (e.g. `UserOffline`), later only for `UserNotFound` or `ReconnectFailed`.
 *
 * Interrupting the stream closes the socket.
 */
export const connect = (
  username: string,
  options: ConnectOptions = {},
): Stream.Stream<ConnectionEvent, ConnectError, TikTokWeb | Socket.WebSocketConstructor> =>
  Stream.callback<ConnectionEvent, ConnectError, TikTokWeb | Socket.WebSocketConstructor>(
    (queue) => run(normalizeUsername(username), options, queue).pipe(Effect.andThen(Queue.end(queue))),
    { bufferSize: 1024, strategy: "suspend" },
  );

/** Just the LIVE events, for when you don't care about the connection lifecycle. */
export const events = (
  username: string,
  options: ConnectOptions = {},
): Stream.Stream<LiveEvent, ConnectError, TikTokWeb | Socket.WebSocketConstructor> =>
  connect(username, options).pipe(
    Stream.filter((e): e is Extract<ConnectionEvent, { _tag: "Event" }> => e._tag === "Event"),
    Stream.map((e) => e.event),
  );

/**
 * `WebSocketConstructor` using the runtime's global `WebSocket`, passing handshake
 * headers through. Bun and Node 22+ support this; browsers don't (and can't connect
 * to TikTok anyway, since they can't set the Cookie header).
 */
export const layerWebSocketGlobal: Layer.Layer<Socket.WebSocketConstructor> = Layer.succeed(
  Socket.WebSocketConstructor,
)((url, options) => new (globalThis.WebSocket as unknown as GlobalWebSocket)(url, options));

type GlobalWebSocket = new (
  url: string,
  options?: Socket.WebSocketConstructorOptions,
) => Socket.WebSocketLike;

/** Everything `connect` needs, using the runtime's global `fetch` and `WebSocket` (Bun, Node 22+). */
export const layer = (
  options: TikTokWebModule.TikTokWebOptions = {},
): Layer.Layer<TikTokWeb | Socket.WebSocketConstructor> =>
  Layer.mergeAll(TikTokWebModule.layer(options), layerWebSocketGlobal);

const run = (
  username: string,
  options: ConnectOptions,
  queue: Queue.Queue<ConnectionEvent, ConnectError | Cause.Done>,
) =>
  Effect.gen(function* () {
    const web = yield* TikTokWeb;
    const hosts = options.wsHosts ?? DEFAULT_WS_HOSTS;
    const heartbeatInterval = Duration.fromInputUnsafe(options.heartbeatInterval ?? "10 seconds");
    const idleTimeout = Duration.fromInputUnsafe(options.idleTimeout ?? "60 seconds");
    const connectTimeout = Duration.fromInputUnsafe(options.connectTimeout ?? "15 seconds");
    const reconnect = options.reconnect === false ? undefined : (options.reconnect ?? {});
    const maxAttempts = reconnect?.maxAttempts ?? 10;
    const maxDelay = Duration.toMillis(Duration.fromInputUnsafe(reconnect?.maxDelay ?? "30 seconds"));
    const seen = new RecentIds(5000);
    const emit = (event: ConnectionEvent) => Queue.offer(queue, event);

    let explicitRoomId = options.roomId;
    let everConnected = false;
    let failures = 0;
    let refreshTtwid = false;

    /** One socket lifetime. Succeeds with "streamEnd"; fails with Dropped once it was open. */
    const runSocket = (roomId: string, room: RoomStatus | undefined, ttwid: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* openFirstHost(
            hosts,
            roomId,
            ttwid,
            web.userAgent,
            heartbeatInterval,
            connectTimeout,
          );
          const { reader, writer, host } = opened;
          yield* writer
            .write(encodeEnterRoom(roomId))
            .pipe(Effect.mapError((error) => new Dropped({ detail: describeSocketError(error) })));
          everConnected = true;
          failures = 0;
          yield* emit({ _tag: "Connected", roomId, room, wsHost: host });

          yield* Effect.sleep(heartbeatInterval).pipe(
            Effect.andThen(writer.write(encodeHeartbeat(roomId))),
            Effect.forever,
            Effect.ignore,
            Effect.forkScoped,
          );

          while (true) {
            // Each pull gets its own timeout, so any frame resets the idle clock.
            const chunks = yield* reader.pull.pipe(
              Effect.mapError((error) => new Dropped({ detail: describeSocketError(error) })),
              Effect.timeoutOrElse({
                duration: idleTimeout,
                orElse: () =>
                  Effect.fail(
                    new Dropped({
                      detail: `no data from TikTok for ${Duration.toSeconds(idleTimeout)} seconds`,
                    }),
                  ),
              }),
            );
            for (const chunk of chunks) {
              if (typeof chunk === "string") continue;
              const decoded = yield* Effect.tryPromise(() => decodeSocketFrame(chunk)).pipe(Effect.option);
              if (decoded._tag === "None") continue;
              const { frame, result } = decoded.value;
              if (!result) continue;
              if (frame.logId && frame.logId !== "0") {
                yield* writer.write(encodeAck(frame.logId)).pipe(Effect.ignore);
              }
              for (const message of result.messages) {
                if (options.includeRaw) yield* emit({ _tag: "Raw", message });
                if (message.isHistory && !options.includeHistory) continue;
                if (seen.has(message.msgId)) continue;
                let event: LiveEvent | undefined;
                try {
                  event = decodeLiveEvent(message);
                } catch {
                  continue; // Malformed or unexpected message shape; skip it rather than drop the connection.
                }
                if (!event) continue;
                yield* emit({ _tag: "Event", event });
                if (event.type === "streamEnd") return "streamEnd" as const;
              }
            }
          }
        }),
      );

    /** Room lookup + ttwid + socket. */
    const attempt = Effect.gen(function* () {
      let roomId: string;
      let room: RoomStatus | undefined;
      if (explicitRoomId) {
        roomId = explicitRoomId;
        explicitRoomId = undefined; // Rooms change when a streamer restarts; look it up on reconnects.
      } else {
        room = yield* web.getRoomStatus(username).pipe(
          Effect.timeoutOrElse({
            duration: connectTimeout,
            orElse: () => Effect.fail(new TikTokRequestError({ message: "Room lookup timed out" })),
          }),
        );
        if (!room.isLive) return yield* new UserOffline({ username });
        roomId = room.roomId;
      }
      const ttwid = yield* web.getTtwid({ refresh: refreshTtwid });
      refreshTtwid = false;
      return yield* runSocket(roomId, room, ttwid).pipe(
        Effect.catchTag("SocketOpenFailed", (error) =>
          // A stale device cookie is the most common cause; retry once with a fresh one.
          web
            .getTtwid({ refresh: true })
            .pipe(
              Effect.flatMap((fresh) =>
                fresh === ttwid ? Effect.fail(error) : runSocket(roomId, room, fresh),
              ),
            ),
        ),
      );
    });

    while (true) {
      const result = yield* Effect.result(attempt);
      if (result._tag === "Success") {
        yield* emit({ _tag: "Disconnected", reason: "streamEnd", willReconnect: false });
        return;
      }
      const error = result.failure;
      if (error._tag === "Dropped" && !everConnected) {
        return yield* new SocketOpenFailed({ message: error.detail, hosts });
      }
      if (error._tag !== "Dropped" && (!everConnected || error._tag === "UserNotFound")) {
        return yield* Effect.fail(error);
      }
      if (error._tag === "UserOffline") {
        yield* emit({ _tag: "Disconnected", reason: "offline", willReconnect: false });
        return;
      }

      const detail = error._tag === "Dropped" ? error.detail : error.message;
      const willReconnect = reconnect !== undefined && failures < maxAttempts;
      if (error._tag === "Dropped") {
        yield* emit({ _tag: "Disconnected", reason: "network", willReconnect, detail });
      }
      if (error._tag === "SocketOpenFailed") refreshTtwid = true;
      if (!willReconnect) return yield* new ReconnectFailed({ attempts: failures, lastError: detail });

      const delay = Math.min(maxDelay, 1000 * 2 ** failures) * (0.8 + Math.random() * 0.4);
      failures++;
      yield* Effect.sleep(Duration.millis(delay));
    }
  });

function openFirstHost(
  hosts: ReadonlyArray<string>,
  roomId: string,
  ttwid: string,
  userAgent: string,
  heartbeatInterval: Duration.Duration,
  connectTimeout: Duration.Duration,
) {
  return Effect.gen(function* () {
    const errors: Array<string> = [];
    for (const host of hosts) {
      const url = socketUrl(host, roomId, userAgent, heartbeatInterval);
      const opened = yield* Effect.gen(function* () {
        const makeWs = yield* Socket.WebSocketConstructor;
        const headers = {
          "User-Agent": userAgent,
          Cookie: `ttwid=${ttwid}`,
          Origin: "https://www.tiktok.com",
        };
        const socket = yield* Socket.fromWebSocket(
          Effect.acquireRelease(
            Effect.try({
              try: () => makeWs(url, { headers }),
              catch: (cause) =>
                new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
            }),
            (ws) => Effect.sync(() => ws.close(1000)),
          ),
          { openTimeout: connectTimeout },
        );
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        return { reader, writer, host };
      }).pipe(Effect.result);
      if (opened._tag === "Success") return opened.success;
      errors.push(`${host}: ${describeSocketError(opened.failure)}`);
    }
    return yield* new SocketOpenFailed({
      message: `Could not open the TikTok socket (${errors.join("; ")})`,
      hosts,
    });
  });
}

function socketUrl(
  host: string,
  roomId: string,
  userAgent: string,
  heartbeatInterval: Duration.Duration,
): string {
  const params = new URLSearchParams({
    version_code: "180800",
    device_platform: "web",
    cookie_enabled: "true",
    screen_width: "1920",
    screen_height: "1080",
    browser_language: "en-US",
    browser_platform: "MacIntel",
    browser_name: "Mozilla",
    browser_version: userAgent.replace(/^Mozilla\//, ""),
    browser_online: "true",
    tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
    app_name: "tiktok_web",
    sup_ws_ds_opt: "1",
    update_version_code: "2.0.0",
    compress: "gzip",
    webcast_language: "en",
    ws_direct: "1",
    aid: "1988",
    live_id: "12",
    app_language: "en",
    client_enter: "1",
    room_id: roomId,
    identity: "audience",
    history_comment_count: "6",
    heartbeat_duration: String(Duration.toMillis(heartbeatInterval)),
    resp_content_type: "protobuf",
    did_rule: "3",
  });
  const base = /^wss?:\/\//.test(host) ? host : `wss://${host}${WS_PATH}`;
  return `${base}?${params}`;
}

function describeSocketError(error: Socket.SocketError): string {
  const reason = error.reason;
  if (reason._tag === "SocketCloseError")
    return `closed with code ${reason.code}${reason.closeReason ? `: ${reason.closeReason}` : ""}`;
  return reason.message;
}

/** Bounded set of recently seen message IDs; TikTok can redeliver messages after reconnects. */
class RecentIds {
  readonly #ids = new Set<string>();
  readonly #max: number;
  constructor(max: number) {
    this.#max = max;
  }
  has(id: string): boolean {
    if (!id || id === "0") return false;
    if (this.#ids.has(id)) return true;
    this.#ids.add(id);
    if (this.#ids.size > this.#max) {
      const oldest = this.#ids.values().next().value;
      if (oldest !== undefined) this.#ids.delete(oldest);
    }
    return false;
  }
}

export { UserNotFound };
