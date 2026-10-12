import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import {
  PROTOCOL_VERSION as CONTRACT_PROTOCOL_VERSION,
  type LiveEvent,
  type SessionStatus,
} from "@tiklive/contracts";
import { PROTOCOL_VERSION, TikLive } from "./index.ts";

/** Minimal stand-in for the WebSocket API surface used by TikLive. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Client-side close: fires onclose like a real socket would. */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  // ---- test helpers ----

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }

  /** Server or network dropped the connection. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  static reset(): void {
    FakeSocket.instances = [];
  }
}

const FakeWebSocket = FakeSocket as unknown as typeof WebSocket;
const server = "ws://test.local/ws";
const lastSocket = (): FakeSocket => {
  const ws = FakeSocket.instances.at(-1);
  if (!ws) throw new Error("no socket created");
  return ws;
};

const user = { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" };
const chat: LiveEvent = { type: "chat", timestamp: 1, user, comment: "hi", emotes: [] };
const follow: LiveEvent = { type: "follow", timestamp: 2, user };
const status: SessionStatus = {
  username: "alice",
  state: "live",
  title: "Hello",
  liveSince: 1,
  stats: { likes: 1, diamonds: 2, follows: 3, shares: 4, joins: 5, chats: 6, viewers: 7, peakViewers: 8 },
};

beforeEach(() => {
  FakeSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("subscribe", () => {
  it("sends subscribe on open, omitting events when not given", () => {
    const live = new TikLive({ server, username: "alice", WebSocket: FakeWebSocket });
    const ws = lastSocket();
    expect(ws.sent).toHaveLength(0);
    ws.open();
    expect(ws.sent).toHaveLength(1);
    const msg = JSON.parse(ws.sent[0] ?? "");
    expect(msg).toEqual({ action: "subscribe", username: "alice" });
    expect("events" in msg).toBe(false);
    live.close();
  });

  it("sends events and replay when given", () => {
    const live = new TikLive({
      server,
      username: "alice",
      events: ["chat", "gift"],
      replay: true,
      WebSocket: FakeWebSocket,
    });
    lastSocket().open();
    expect(JSON.parse(lastSocket().sent[0] ?? "")).toEqual({
      action: "subscribe",
      username: "alice",
      events: ["chat", "gift"],
      replay: true,
    });
    live.close();
  });

  it("sends an empty events array for status-only subscriptions", () => {
    const live = new TikLive({ server, username: "alice", events: [], WebSocket: FakeWebSocket });
    lastSocket().open();
    expect(JSON.parse(lastSocket().sent[0] ?? "").events).toEqual([]);
    live.close();
  });

  it("derives server and username from the page location when not given", () => {
    vi.stubGlobal("location", {
      protocol: "https:",
      host: "overlays.test",
      search: "?username=bob&token=t0k",
    });
    const live = new TikLive({ WebSocket: FakeWebSocket });
    expect(live.username).toBe("bob");
    expect(live.server).toBe("wss://overlays.test/ws");
    expect(lastSocket().url).toBe("wss://overlays.test/ws?token=t0k");
    live.close();
  });

  it("falls back to the demo username without a page location", () => {
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    expect(live.username).toBe("demo");
    live.close();
  });

  it("throws a clear error when there is no server and no page location", () => {
    vi.stubGlobal("location", undefined);
    expect(() => new TikLive({ WebSocket: FakeWebSocket })).toThrow(/Pass one explicitly/);
  });
});

describe("events", () => {
  it("dispatches typed events to type handlers and '*' with meta", () => {
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    const onChat = vi.fn();
    const onAll = vi.fn();
    const onGift = vi.fn();
    live.on("chat", onChat);
    live.on("*", onAll);
    live.on("gift", onGift);
    lastSocket().open();
    lastSocket().receive({ type: "event", username: "alice", event: chat, replay: true });

    expect(onChat).toHaveBeenCalledWith(chat, { replay: true, username: "alice" });
    expect(onAll).toHaveBeenCalledWith(chat, { replay: true, username: "alice" });
    expect(onGift).not.toHaveBeenCalled();
    live.close();
  });

  it("reports replay as false for live events", () => {
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    const onFollow = vi.fn();
    live.on("follow", onFollow);
    lastSocket().open();
    lastSocket().receive({ type: "event", username: "alice", event: follow });
    expect(onFollow.mock.calls[0]?.[1]).toEqual({ replay: false, username: "alice" });
    live.close();
  });

  it("unsubscribes with the returned function", () => {
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    const handler = vi.fn();
    const off = live.on("chat", handler);
    lastSocket().open();
    off();
    lastSocket().receive({ type: "event", username: "alice", event: chat });
    expect(handler).not.toHaveBeenCalled();
    live.close();
  });

  it("isolates handler exceptions", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    const after = vi.fn();
    live.on("chat", () => {
      throw new Error("boom");
    });
    live.on("chat", after);
    lastSocket().open();
    lastSocket().receive({ type: "event", username: "alice", event: chat });
    expect(after).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    live.close();
  });

  it("ignores unknown message types and invalid JSON", () => {
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    const all = vi.fn();
    live.on("*", all);
    lastSocket().open();
    expect(() => {
      lastSocket().receive("not json{");
      lastSocket().receive({ type: "from-the-future", data: 1 });
    }).not.toThrow();
    expect(all).not.toHaveBeenCalled();
    live.close();
  });
});

describe("status, hello and error", () => {
  it("updates .status and notifies 'status' handlers", () => {
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    const onStatus = vi.fn();
    live.on("status", onStatus);
    expect(live.status).toBeNull();
    lastSocket().open();
    lastSocket().receive({ type: "status", username: "alice", status });
    expect(live.status).toEqual(status);
    expect(onStatus).toHaveBeenCalledWith(status);
    live.close();
  });

  it("passes hello and error messages to their handlers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    const onHello = vi.fn();
    const onError = vi.fn();
    live.on("hello", onHello);
    live.on("error", onError);
    lastSocket().open();
    lastSocket().receive({ type: "hello", protocolVersion: PROTOCOL_VERSION, serverVersion: "x" });
    lastSocket().receive({ type: "error", code: "invalid_username", message: "nope" });
    expect(onHello).toHaveBeenCalledWith({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: "x",
    });
    expect(onError).toHaveBeenCalledWith({ type: "error", code: "invalid_username", message: "nope" });
    expect(warn).not.toHaveBeenCalled();
    live.close();
  });

  it("warns once when the server speaks a different protocol version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    lastSocket().open();
    lastSocket().receive({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1, serverVersion: "x" });
    lastSocket().receive({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1, serverVersion: "x" });
    expect(warn).toHaveBeenCalledOnce();
    live.close();
  });
});

describe("reconnect", () => {
  it("reconnects with exponential backoff and re-subscribes", () => {
    vi.useFakeTimers();
    const live = new TikLive({ server, username: "alice", WebSocket: FakeWebSocket });
    expect(FakeSocket.instances).toHaveLength(1);

    lastSocket().open();
    lastSocket().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // Second drop without a successful open in between: 1000 ms.
    lastSocket().drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    lastSocket().open();
    expect(JSON.parse(lastSocket().sent[0] ?? "").username).toBe("alice");
    live.close();
  });

  it("resets the backoff once a connection opens", () => {
    vi.useFakeTimers();
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    lastSocket().drop(); // 500 ms
    vi.advanceTimersByTime(500);
    lastSocket().drop(); // 1000 ms
    vi.advanceTimersByTime(1000);
    lastSocket().open(); // resets
    lastSocket().drop();
    vi.advanceTimersByTime(499);
    expect(FakeSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(4);
    live.close();
  });

  it("caps the backoff at 10 seconds", () => {
    vi.useFakeTimers();
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    for (let i = 0; i < 10; i++) {
      lastSocket().drop();
      vi.advanceTimersByTime(10_000);
    }
    const before = FakeSocket.instances.length;
    lastSocket().drop();
    vi.advanceTimersByTime(9_999);
    expect(FakeSocket.instances.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(before + 1);
    live.close();
  });

  it("close() stops reconnecting", () => {
    vi.useFakeTimers();
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    const onClose = vi.fn();
    live.on("close", onClose);
    lastSocket().open();
    live.close();
    expect(onClose).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("close() cancels a pending reconnect", () => {
    vi.useFakeTimers();
    const live = new TikLive({ server, WebSocket: FakeWebSocket });
    lastSocket().drop(); // reconnect scheduled
    live.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("does not reconnect when reconnect: false", () => {
    vi.useFakeTimers();
    const live = new TikLive({ server, reconnect: false, WebSocket: FakeWebSocket });
    lastSocket().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    live.close();
  });
});

describe("protocol", () => {
  it("PROTOCOL_VERSION matches the contracts package", () => {
    expect(PROTOCOL_VERSION).toBe(CONTRACT_PROTOCOL_VERSION);
  });
});

describe("gifts", () => {
  it("fetches the catalog over HTTP from the server, with the token", async () => {
    const gift = { giftId: 5655, name: "Rose", diamondCount: 1, imageUrl: "", streakable: true };
    const fetchMock = vi.fn(async (_input: URL | string) => new Response(JSON.stringify({ gifts: [gift] })));
    vi.stubGlobal("fetch", fetchMock);
    const live = new TikLive({ server: "wss://overlays.test/ws", token: "t0k", WebSocket: FakeWebSocket });

    expect(await live.gifts()).toEqual([gift]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://overlays.test/api/gifts?token=t0k");
    live.close();
  });

  it("uses http for a ws server and rejects on an error status", async () => {
    const fetchMock = vi.fn(async (_input: URL | string) => new Response("nope", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const live = new TikLive({ server, WebSocket: FakeWebSocket });

    await expect(live.gifts()).rejects.toThrow("HTTP 502");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("http://test.local/api/gifts");
    live.close();
  });
});
