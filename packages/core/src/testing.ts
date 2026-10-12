/**
 * Test doubles for `LiveConnection`: a scriptable WebSocket, a fake TikTok web
 * client, and builders for webcast frames. Exported so library users can drive
 * `connect` without a network.
 */
import { gzipSync } from "node:zlib";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { UserNotFound } from "./errors.ts";
import { decodePushFrame, encodePushFrame } from "./proto/frames.ts";
import { ProtoWriter } from "./proto/wire.ts";
import { type RoomStatus, TikTokWeb } from "./TikTokWeb.ts";

type EventType = "open" | "message" | "error" | "close";

interface Listener {
  readonly listener: (event: Socket.WebSocketEvent) => void;
  readonly once: boolean;
}

/**
 * A `WebSocketLike` the test controls. Events dispatched while no listener is
 * attached are held and delivered to the next listener, so a socket opened or
 * closed in the microtask right after construction is never missed.
 */
export class FakeWebSocket implements Socket.WebSocketLike {
  readyState = 0;
  /** Frames the client sent, in order. */
  readonly sent: Uint8Array[] = [];
  /** Constructor options as passed by `LiveConnection` (`{ headers }`). */
  readonly options: Socket.WebSocketClientOptions | undefined;

  readonly #listeners = new Map<EventType, Array<Listener>>();
  readonly #pending: Array<{ type: EventType; event: Socket.WebSocketEvent }> = [];

  readonly url: string;

  constructor(url: string, options?: Socket.WebSocketConstructorOptions) {
    this.url = url;
    this.options = typeof options === "object" && !Array.isArray(options) ? options : undefined;
  }

  addEventListener(
    type: EventType,
    listener: (event: Socket.WebSocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void {
    const once = options?.once ?? false;
    const list = this.#listeners.get(type) ?? [];
    list.push({ listener, once });
    this.#listeners.set(type, list);
    // Flush anything dispatched before anyone was listening.
    const held = this.#pending.filter((p) => p.type === type);
    for (const p of held) {
      this.#pending.splice(this.#pending.indexOf(p), 1);
      this.#deliver(type, p.event);
    }
  }

  removeEventListener(type: EventType, listener: (event: Socket.WebSocketEvent) => void): void {
    const list = this.#listeners.get(type);
    if (!list) return;
    this.#listeners.set(
      type,
      list.filter((l) => l.listener !== listener),
    );
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#dispatch("close", { type: "close", code, reason });
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    if (typeof data === "string") throw new TypeError("FakeWebSocket only accepts binary frames");
    this.sent.push(data);
  }

  /** Completes the handshake. */
  open(): void {
    this.readyState = 1;
    this.#dispatch("open", { type: "open" });
  }

  /** Delivers a binary frame from the server. */
  receive(bytes: Uint8Array): void {
    this.#dispatch("message", { type: "message", data: bytes });
  }

  /** The server closes the socket (abnormal by default, so the client sees a drop). */
  serverClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.#dispatch("close", { type: "close", code, reason });
  }

  /** Handshake failure: an error followed by a close, as browsers and `ws` do. */
  fail(): void {
    this.#dispatch("error", { type: "error" });
    this.readyState = 3;
    this.#dispatch("close", { type: "close", code: 1006, reason: "" });
  }

  /** Frames the client sent, filtered by payload type (e.g. `"hb"`, `"ack"`). */
  sentOfType(payloadType: string): Uint8Array[] {
    return this.sent.filter((frame) => decodePushFrame(frame).payloadType === payloadType);
  }

  #dispatch(type: EventType, event: Socket.WebSocketEvent): void {
    const list = this.#listeners.get(type) ?? [];
    if (list.length === 0) {
      this.#pending.push({ type, event });
      return;
    }
    this.#deliver(type, event);
  }

  #deliver(type: EventType, event: Socket.WebSocketEvent): void {
    const list = this.#listeners.get(type) ?? [];
    for (const l of [...list]) {
      if (l.once) this.removeEventListener(type, l.listener);
      l.listener(event);
    }
  }
}

export interface FakeWebSocketLayer {
  readonly layer: Layer.Layer<Socket.WebSocketConstructor>;
  /** Every socket constructed so far, in order. */
  readonly sockets: FakeWebSocket[];
}

/**
 * `WebSocketConstructor` that records each socket it creates. `behavior` runs
 * synchronously on construction, so it can schedule `open()`, `fail()`, etc.
 */
export const fakeWebSocketLayer = (
  behavior: (ws: FakeWebSocket, index: number) => void = (ws) => queueMicrotask(() => ws.open()),
): FakeWebSocketLayer => {
  const sockets: FakeWebSocket[] = [];
  const layer = Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
    const ws = new FakeWebSocket(url, options);
    sockets.push(ws);
    behavior(ws, sockets.length - 1);
    return ws;
  });
  return { layer, sockets };
};

export interface FakeTikTokWebOptions {
  /** Whether the room is live. A function is consulted on every room lookup. Default true. */
  readonly live?: boolean | (() => boolean);
  /** Make every room lookup fail with `UserNotFound`. */
  readonly notFound?: boolean;
  /** Room ID returned by lookups. Default "7000000000000000001". */
  readonly roomId?: string;
  readonly userAgent?: string;
}

/** `TikTokWeb` that never touches the network. `ttwid` is always "fake-ttwid". */
export const fakeTikTokWebLayer = (options: FakeTikTokWebOptions = {}): Layer.Layer<TikTokWeb> => {
  const roomId = options.roomId ?? "7000000000000000001";
  const userAgent = options.userAgent ?? "fake-user-agent";
  return Layer.succeed(TikTokWeb)(
    TikTokWeb.of({
      userAgent,
      getTtwid: () => Effect.succeed("fake-ttwid"),
      getRoomStatus: (username) => {
        if (options.notFound) return Effect.fail(new UserNotFound({ username }));
        return Effect.sync(() => {
          const isLive = typeof options.live === "function" ? options.live() : (options.live ?? true);
          const room: RoomStatus = {
            roomId,
            isLive,
            title: "Fake room",
            viewerCount: 0,
            owner: {
              userId: "1",
              uniqueId: username,
              nickname: "Fake",
              profilePictureUrl: "",
              followerCount: 0,
            },
          };
          return room;
        });
      },
    }),
  );
};

/** Common header (field 1) shared by webcast messages. */
const commonHeader = (msgId: string) => new ProtoWriter().varint(2, msgId).varint(4, 1791744000000);

/** Wraps one webcast message in a gzipped `msg` push frame, as TikTok sends it. */
const batchFrame = (method: string, message: Uint8Array, msgId: string, logId: string): Uint8Array => {
  const batch = new ProtoWriter()
    .message(1, new ProtoWriter().string(1, method).bytes(2, message).varint(3, msgId))
    .finish();
  return encodePushFrame({ logId, payloadType: "msg", payload: new Uint8Array(gzipSync(batch)) });
};

/** A `WebcastChatMessage` batch with one comment from viewer "viewer". */
export const chatFrame = (msgId: string, comment: string, logId = "9001"): Uint8Array => {
  const chat = new ProtoWriter()
    .message(1, commonHeader(msgId))
    .message(2, new ProtoWriter().varint(1, "42").string(3, "Viewer").string(38, "viewer"))
    .string(3, comment)
    .finish();
  return batchFrame("WebcastChatMessage", chat, msgId, logId);
};

/** A `WebcastControlMessage` with action 3 (stream ended). */
export const streamEndFrame = (msgId = "999", logId = "9002"): Uint8Array => {
  const control = new ProtoWriter().message(1, commonHeader(msgId)).varint(2, 3).finish();
  return batchFrame("WebcastControlMessage", control, msgId, logId);
};
