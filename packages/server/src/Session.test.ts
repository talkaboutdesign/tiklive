/**
 * Session behavior without HTTP: connection state, running stats, replay
 * history and offline/not-found handling. TikTok and WebSocket are faked.
 */
import { describe, expect, it } from "@effect/vitest";
import type { LiveEvent, SessionStatus } from "@tiklive/contracts";
import * as Core from "@tiklive/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import { fakeTikTokWebLayer, fakeWebSocketLayer } from "@tiklive/core/testing";
import * as Session from "./Session.ts";

const USER = { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" };
const TIMESTAMP = 1_700_000_000_000;

const chat = (comment: string): LiveEvent => ({
  type: "chat",
  timestamp: TIMESTAMP,
  user: USER,
  comment,
  emotes: [],
});
const follow = (): LiveEvent => ({ type: "follow", timestamp: TIMESTAMP, user: USER });
const share = (): LiveEvent => ({ type: "share", timestamp: TIMESTAMP, user: USER });
const join = (): LiveEvent => ({ type: "join", timestamp: TIMESTAMP, user: USER });
const like = (likeCount: number, totalLikeCount: number): LiveEvent => ({
  type: "like",
  timestamp: TIMESTAMP,
  user: USER,
  likeCount,
  totalLikeCount,
});
const viewers = (viewerCount: number): LiveEvent => ({
  type: "viewers",
  timestamp: TIMESTAMP,
  viewerCount,
  topViewers: [],
});
const gift = (overrides: { streaking: boolean; repeatCount: number; totalDiamonds: number }): LiveEvent => ({
  type: "gift",
  timestamp: TIMESTAMP,
  user: USER,
  giftId: 1,
  giftName: "Rose",
  giftImageUrl: "",
  diamondCount: 1,
  groupId: "g",
  ...overrides,
});

/** Fake streamer who is live; the fake socket opens immediately. */
const liveLayer = () => Layer.mergeAll(fakeTikTokWebLayer({ live: true }), fakeWebSocketLayer().layer);

/** Polls `read` until `predicate` holds, failing after `timeoutMs`. */
const waitUntil = <A>(
  read: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  label: string,
  timeoutMs = 2000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const value = yield* read;
      if (predicate(value)) return value;
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${label}`));
      yield* Effect.sleep("10 millis");
    }
  });

const waitForState = (session: Session.Session, state: SessionStatus["state"]) =>
  waitUntil(session.status, (s) => s.state === state, `state ${state}`);

describe("Session with a live streamer", () => {
  it.live("moves from connecting to live and reports the room", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make("someone");
        const status = yield* waitForState(session, "live");
        expect(status).toMatchObject({
          username: "someone",
          state: "live",
          roomId: "7000000000000000001",
          title: "Fake room",
          owner: { uniqueId: "someone" },
        });
        expect(status.liveSince).toBeTypeOf("number");
        expect(status.error).toBeUndefined();
      }).pipe(Effect.provide(liveLayer())),
    ),
  );

  it.live("reports TikTok's stream start time and cover when the room has them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make("someone");
        const status = yield* waitForState(session, "live");
        expect(status.streamStartedAt).toBe(1791770120000);
        expect(status.coverUrl).toBe("https://example.test/cover.webp");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            fakeTikTokWebLayer({
              live: true,
              streamStartedAt: 1791770120000,
              coverUrl: "https://example.test/cover.webp",
            }),
            fakeWebSocketLayer().layer,
          ),
        ),
      ),
    ),
  );

  it.live("omits the stream start time and cover when the room has none", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make("someone");
        const status = yield* waitForState(session, "live");
        expect(status.streamStartedAt).toBeUndefined();
        expect(status.coverUrl).toBeUndefined();
      }).pipe(Effect.provide(liveLayer())),
    ),
  );

  it.live("updates running stats from events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make("someone");
        yield* waitForState(session, "live");

        yield* session.inject(like(5, 10));
        yield* session.inject(like(3, 12));
        // Likes are max(running sum, server total): the sum (14) wins here.
        yield* session.inject(like(1, 5));
        yield* session.inject(gift({ streaking: true, repeatCount: 1, totalDiamonds: 2 }));
        yield* session.inject(gift({ streaking: false, repeatCount: 5, totalDiamonds: 10 }));
        yield* session.inject(follow());
        yield* session.inject(share());
        yield* session.inject(join());
        yield* session.inject(chat("one"));
        yield* session.inject(chat("two"));
        yield* session.inject(viewers(50));
        yield* session.inject(viewers(30));

        const { stats } = yield* session.status;
        expect(stats).toEqual({
          likes: 14,
          // Only the final (non-streaking) gift counts.
          diamonds: 10,
          follows: 1,
          shares: 1,
          joins: 1,
          chats: 2,
          viewers: 30,
          peakViewers: 50,
        });
      }).pipe(Effect.provide(liveLayer())),
    ),
  );

  it.live("keeps only the most recent chat, gift and follow events for replay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make("someone", { historySize: 3 });
        yield* waitForState(session, "live");

        yield* session.inject(chat("c1"));
        yield* session.inject(like(1, 1));
        yield* session.inject(viewers(10));
        yield* session.inject(chat("c2"));
        yield* session.inject(follow());
        yield* session.inject(chat("c3"));

        const history = yield* session.recentEvents;
        expect(history.map((e) => e.type)).toEqual(["chat", "follow", "chat"]);
        expect(history[0]).toMatchObject({ type: "chat", comment: "c2" });
        expect(history.some((e) => e.type === "like" || e.type === "viewers")).toBe(false);
      }).pipe(Effect.provide(liveLayer())),
    ),
  );

  it.live("delivers injected events to subscribers in order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make("someone");
        yield* waitForState(session, "live");
        const subscription = yield* session.subscribe;

        yield* session.inject(chat("hello"));
        yield* session.inject(follow());

        // Stats pushes (Status messages) may interleave, so collect until both events arrive.
        const received: Array<Session.SessionMessage> = [];
        const eventCount = () => received.filter((m) => m._tag === "Event").length;
        while (eventCount() < 2) received.push(yield* PubSub.take(subscription));
        const types = received.flatMap((m) => (m._tag === "Event" ? [m.event.type] : []));
        expect(types).toEqual(["chat", "follow"]);
      }).pipe(Effect.provide(liveLayer())),
    ),
  );
});

describe("Session with an offline or missing streamer", () => {
  it.live("waits while the streamer is offline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make("someone", { pollInterval: "1 hour" });
        const status = yield* waitForState(session, "waiting");
        expect(status.error).toBeUndefined();
        expect(status.liveSince).toBeUndefined();
      }).pipe(
        Effect.provide(Layer.mergeAll(fakeTikTokWebLayer({ live: false }), fakeWebSocketLayer().layer)),
      ),
    ),
  );

  it.live("enters error with the message and stops looking when the user doesn't exist", () => {
    let lookups = 0;
    const missingUser = Layer.succeed(Core.TikTokWeb.TikTokWeb)(
      Core.TikTokWeb.TikTokWeb.of({
        userAgent: "test",
        getTtwid: () => Effect.succeed("ttwid"),
        getGifts: () => Effect.succeed([]),
        getRoomStatus: (username) =>
          Effect.sync(() => {
            lookups++;
          }).pipe(Effect.andThen(Effect.fail(new Core.UserNotFound({ username })))),
      }),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make("someone", { pollInterval: "10 millis" });
        const status = yield* waitForState(session, "error");
        expect(status.error).toBe("TikTok user @someone not found");

        // A permanent failure must not be retried.
        yield* Effect.sleep("200 millis");
        expect(lookups).toBe(1);
        expect((yield* session.status).state).toBe("error");
      }).pipe(Effect.provide(Layer.mergeAll(missingUser, fakeWebSocketLayer().layer))),
    );
  });
});
