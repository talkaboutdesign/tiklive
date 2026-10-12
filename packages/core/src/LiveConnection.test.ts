import { describe, expect, it } from "@effect/vitest";
import { TikTokWeb } from "./TikTokWeb.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as LiveConnection from "./LiveConnection.ts";
import type { ConnectionEvent, ConnectOptions } from "./LiveConnection.ts";
import { decodePushFrame } from "./proto/frames.ts";
import { decode } from "./proto/wire.ts";
import {
  chatFrame,
  fakeTikTokWebLayer,
  fakeWebSocketLayer,
  type FakeTikTokWebOptions,
  streamEndFrame,
} from "./testing.ts";

const ROOM_ID = "7000000000000000001";

/** Lets queued microtasks, socket callbacks and forked fibers run. */
const tick = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/**
 * Polls until `predicate` holds, yielding to the event loop between checks. With
 * `advance`, moves the TestClock forward on each step (needed for backoff sleeps,
 * which only wake when the clock moves). Dies after `maxSteps` so a stuck test fails.
 */
const waitFor = (
  predicate: () => boolean,
  options: { readonly label: string; readonly advance?: Duration.Input; readonly maxSteps?: number },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let step = 0; step < (options.maxSteps ?? 500); step++) {
      if (predicate()) return;
      yield* tick;
      if (options.advance !== undefined) yield* TestClock.adjust(options.advance);
    }
    if (predicate()) return;
    yield* Effect.die(new Error(`timed out waiting for ${options.label}`));
  });

/** Runs `connect` in a child fiber, recording every emitted event as it arrives. */
const start = (opts: ConnectOptions, web: FakeTikTokWebOptions = {}, ws = fakeWebSocketLayer()) => {
  const events: ConnectionEvent[] = [];
  const env = Layer.mergeAll(fakeTikTokWebLayer(web), ws.layer);
  return LiveConnection.connect("someone", opts).pipe(
    Stream.tap((event) => Effect.sync(() => events.push(event))),
    Stream.runDrain,
    Effect.provide(env),
    Effect.forkChild,
    Effect.map((fiber) => ({ fiber, events, sockets: ws.sockets })),
  );
};

const eventsOfTag = <T extends ConnectionEvent["_tag"]>(events: ReadonlyArray<ConnectionEvent>, tag: T) =>
  events.filter((e): e is Extract<ConnectionEvent, { _tag: T }> => e._tag === tag);

const chatComments = (events: ReadonlyArray<ConnectionEvent>) =>
  eventsOfTag(events, "Event").flatMap((e) => (e.event.type === "chat" ? [e.event.comment] : []));

describe("LiveConnection.connect", () => {
  it.effect("connects, joins the room and sends the enter frame", () =>
    Effect.gen(function* () {
      const { fiber, events, sockets } = yield* start({ roomId: ROOM_ID, heartbeatInterval: "1 hour" }, {});
      yield* waitFor(() => events.length > 0, { label: "Connected" });

      const first = events[0];
      expect(first).toMatchObject({ _tag: "Connected", roomId: ROOM_ID, wsHost: expect.any(String) });

      const ws = sockets[0]!;
      expect(ws.url).toContain(`room_id=${ROOM_ID}`);
      expect(ws.options?.headers).toMatchObject({ Cookie: "ttwid=fake-ttwid" });

      const enter = decodePushFrame(ws.sent[0]!);
      expect(enter.payloadType).toBe("im_enter_room");
      expect(decode(enter.payload).id(1)).toBe(ROOM_ID);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("looks up the room when no roomId is given and reports it on Connected", () =>
    Effect.gen(function* () {
      const { fiber, events, sockets } = yield* start({ heartbeatInterval: "1 hour" }, { roomId: "123" });
      yield* waitFor(() => events.length > 0, { label: "Connected" });

      const connected = eventsOfTag(events, "Connected")[0]!;
      expect(connected.roomId).toBe("123");
      expect(connected.room).toMatchObject({ roomId: "123", isLive: true });
      expect(sockets[0]!.url).toContain("room_id=123");

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("emits chat events from a batch, drops duplicate msgIds and acks each batch", () =>
    Effect.gen(function* () {
      const ws = fakeWebSocketLayer();
      const { fiber, events, sockets } = yield* start(
        { roomId: ROOM_ID, heartbeatInterval: "1 hour" },
        {},
        ws,
      );
      yield* waitFor(() => sockets.length > 0 && sockets[0]!.sent.length > 0, { label: "enter frame" });
      const socket = sockets[0]!;

      socket.receive(chatFrame("1", "hello", "9001"));
      socket.receive(chatFrame("1", "hello again", "9002")); // same msgId: redelivered, must be dropped
      socket.receive(chatFrame("2", "world", "9003"));
      yield* waitFor(() => chatComments(events).length >= 2, { label: "two chat events" });
      yield* tick;

      expect(chatComments(events)).toEqual(["hello", "world"]);
      const chat = eventsOfTag(events, "Event")[0]!.event;
      expect(chat).toMatchObject({
        type: "chat",
        msgId: "1",
        user: { uniqueId: "viewer", nickname: "Viewer" },
      });

      const acks = socket.sentOfType("ack").map((frame) => decodePushFrame(frame).logId);
      expect(acks).toEqual(["9001", "9002", "9003"]);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("fails with UserOffline when the room is not live on the first attempt", () =>
    Effect.gen(function* () {
      const { fiber, sockets } = yield* start({}, { live: false });
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error._tag).toBe("UserOffline");
      expect(sockets).toHaveLength(0);
    }),
  );

  it.effect("fails with UserNotFound when the account does not exist", () =>
    Effect.gen(function* () {
      const { fiber } = yield* start({}, { notFound: true });
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error._tag).toBe("UserNotFound");
    }),
  );

  it.effect("sends heartbeat frames on the configured interval", () =>
    Effect.gen(function* () {
      const { fiber, events, sockets } = yield* start({ roomId: ROOM_ID, heartbeatInterval: "10 seconds" });
      yield* waitFor(() => events.length > 0, { label: "Connected" });
      const ws = sockets[0]!;

      expect(ws.sentOfType("hb")).toHaveLength(0);
      yield* TestClock.adjust("10 seconds");
      yield* waitFor(() => ws.sentOfType("hb").length > 0, { label: "heartbeat" });

      const hb = decodePushFrame(ws.sentOfType("hb")[0]!);
      expect(decode(hb.payload).id(1)).toBe(ROOM_ID);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("falls back to the second WebSocket host when the first fails to open", () =>
    Effect.gen(function* () {
      const ws = fakeWebSocketLayer((socket, index) => {
        if (index === 0) queueMicrotask(() => socket.fail());
        else queueMicrotask(() => socket.open());
      });
      const { fiber, events, sockets } = yield* start(
        { roomId: ROOM_ID, wsHosts: ["ws://a/ws", "ws://b/ws"], heartbeatInterval: "1 hour" },
        {},
        ws,
      );
      yield* waitFor(() => events.length > 0, { label: "Connected" });

      expect(sockets.map((s) => s.url.split("?")[0])).toEqual(["ws://a/ws", "ws://b/ws"]);
      expect(eventsOfTag(events, "Connected")[0]).toMatchObject({ wsHost: "ws://b/ws" });

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("reconnects after a drop, emitting Disconnected then a fresh Connected", () =>
    Effect.gen(function* () {
      const ws = fakeWebSocketLayer();
      const { fiber, events, sockets } = yield* start(
        { roomId: ROOM_ID, heartbeatInterval: "1 hour" },
        {},
        ws,
      );
      yield* waitFor(() => sockets.length === 1 && sockets[0]!.sent.length > 0, { label: "first socket" });
      sockets[0]!.serverClose(1006, "gone");

      yield* waitFor(() => sockets.length === 2, { label: "reconnect socket", advance: "1 second" });
      yield* waitFor(() => eventsOfTag(events, "Connected").length === 2, {
        label: "second Connected",
        advance: "1 second",
      });

      const tags = events.map((e) => e._tag);
      expect(tags).toEqual(["Connected", "Disconnected", "Connected"]);
      expect(events[1]).toMatchObject({ _tag: "Disconnected", reason: "network", willReconnect: true });

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("treats a silent socket as dropped after idleTimeout and reconnects", () =>
    Effect.gen(function* () {
      const { fiber, events, sockets } = yield* start({
        roomId: ROOM_ID,
        heartbeatInterval: "1 hour",
        idleTimeout: "30 seconds",
      });
      yield* waitFor(() => events.length > 0, { label: "Connected" });

      yield* TestClock.adjust("29 seconds");
      expect(eventsOfTag(events, "Disconnected")).toEqual([]);

      yield* TestClock.adjust("2 seconds");
      yield* waitFor(() => eventsOfTag(events, "Disconnected").length > 0, { label: "idle disconnect" });
      expect(events[1]).toMatchObject({
        _tag: "Disconnected",
        reason: "network",
        willReconnect: true,
        detail: "no data from TikTok for 30 seconds",
      });

      yield* waitFor(() => sockets.length === 2, { label: "reconnect socket", advance: "1 second" });
      yield* waitFor(() => eventsOfTag(events, "Connected").length === 2, {
        label: "second Connected",
        advance: "1 second",
      });
      expect(events.map((e) => e._tag)).toEqual(["Connected", "Disconnected", "Connected"]);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("keeps a socket open while frames arrive within idleTimeout", () =>
    Effect.gen(function* () {
      const ws = fakeWebSocketLayer();
      const { fiber, events, sockets } = yield* start(
        { roomId: ROOM_ID, heartbeatInterval: "1 hour", idleTimeout: "30 seconds" },
        {},
        ws,
      );
      yield* waitFor(() => events.length > 0, { label: "Connected" });
      const socket = sockets[0]!;

      for (let i = 1; i <= 5; i++) {
        yield* TestClock.adjust("20 seconds");
        socket.receive(chatFrame(String(i), `hi ${i}`, String(9000 + i)));
        yield* waitFor(() => chatComments(events).length === i, { label: `chat ${i}` });
      }

      expect(chatComments(events)).toEqual(["hi 1", "hi 2", "hi 3", "hi 4", "hi 5"]);
      expect(eventsOfTag(events, "Disconnected")).toEqual([]);
      expect(sockets).toHaveLength(1);

      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("completes after a streamEnd control message", () =>
    Effect.gen(function* () {
      const ws = fakeWebSocketLayer();
      const { fiber, events, sockets } = yield* start(
        { roomId: ROOM_ID, heartbeatInterval: "1 hour" },
        {},
        ws,
      );
      yield* waitFor(() => sockets.length > 0 && sockets[0]!.sent.length > 0, { label: "enter frame" });
      sockets[0]!.receive(streamEndFrame("999", "9002"));

      yield* Fiber.join(fiber);

      expect(events.map((e) => e._tag)).toEqual(["Connected", "Event", "Disconnected"]);
      expect(events[1]).toMatchObject({ _tag: "Event", event: { type: "streamEnd", reason: "ended" } });
      expect(events[2]).toEqual({ _tag: "Disconnected", reason: "streamEnd", willReconnect: false });
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("completes with Disconnected offline when the room is no longer live on reconnect", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const ws = fakeWebSocketLayer();
      const { fiber, events, sockets } = yield* start(
        { heartbeatInterval: "1 hour" },
        { live: () => lookups++ === 0 },
        ws,
      );
      yield* waitFor(() => sockets.length === 1 && sockets[0]!.sent.length > 0, { label: "first socket" });
      sockets[0]!.serverClose(1006, "");

      // The reconnect backoff only elapses when the clock moves, so advance until the stream completes.
      yield* waitFor(() => fiber.pollUnsafe() !== undefined, {
        label: "stream completion",
        advance: "1 second",
      });
      yield* Fiber.join(fiber);

      expect(events.map((e) => e._tag)).toEqual(["Connected", "Disconnected", "Disconnected"]);
      expect(events[1]).toMatchObject({ _tag: "Disconnected", reason: "network", willReconnect: true });
      expect(events[2]).toEqual({ _tag: "Disconnected", reason: "offline", willReconnect: false });
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("fails with ReconnectFailed after a drop when reconnect is disabled", () =>
    Effect.gen(function* () {
      const ws = fakeWebSocketLayer();
      const { fiber, events, sockets } = yield* start(
        { roomId: ROOM_ID, reconnect: false, heartbeatInterval: "1 hour" },
        {},
        ws,
      );
      yield* waitFor(() => sockets.length === 1 && sockets[0]!.sent.length > 0, { label: "first socket" });
      sockets[0]!.serverClose(1006, "");

      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error._tag).toBe("ReconnectFailed");
      expect(events.map((e) => e._tag)).toEqual(["Connected", "Disconnected"]);
      expect(events[1]).toMatchObject({ _tag: "Disconnected", reason: "network", willReconnect: false });
      expect(sockets).toHaveLength(1);
    }),
  );
});

describe("device cookie timeouts", () => {
  for (const refreshOnly of [false, true]) {
    it.effect(`times out a stalled ${refreshOnly ? "refresh" : "initial"} cookie request`, () =>
      Effect.gen(function* () {
        const base = yield* TikTokWeb;
        const started = yield* Latch.make();
        const web = TikTokWeb.of({
          ...base,
          getTtwid: (options) =>
            refreshOnly && !options?.refresh
              ? Effect.succeed("old-cookie")
              : started.open.pipe(Effect.andThen(Effect.never)),
        });
        const sockets = fakeWebSocketLayer((socket) => queueMicrotask(() => socket.fail()));
        const fiber = yield* LiveConnection.connect("someone", {
          connectTimeout: "1 second",
          wsHosts: ["ws://fake/ws"],
        }).pipe(
          Stream.runDrain,
          Effect.result,
          Effect.provideService(TikTokWeb, web),
          Effect.provide(sockets.layer),
          Effect.forkChild,
        );
        yield* started.await;
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "TikTokRequestError", message: "Device cookie request timed out" },
        });
      }).pipe(Effect.provide(fakeTikTokWebLayer())),
    );
  }
});
