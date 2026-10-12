/**
 * One streamer's session: keeps a TikTok connection alive across stream
 * restarts, tracks running stats, and fans events out to subscribers.
 */
import type { LiveEvent, SessionState, SessionStats, SessionStatus } from "@tiklive/contracts";
import { demoEvents, LiveConnection, type RoomStatus } from "@tiklive/core";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export const DEMO_USERNAME = "demo";

export type SessionMessage =
  | { readonly _tag: "Event"; readonly event: LiveEvent }
  | { readonly _tag: "Status"; readonly status: SessionStatus };

export interface Session {
  readonly username: string;
  readonly status: Effect.Effect<SessionStatus>;
  /** Recent events for replay, oldest first. Excludes likes and viewer counts. */
  readonly recentEvents: Effect.Effect<ReadonlyArray<LiveEvent>>;
  /**
   * Live events and status changes. Subscribe before reading `status` or
   * `recentEvents` to avoid missing anything in between. Slow subscribers
   * lose their oldest undelivered messages rather than buffering forever.
   */
  readonly subscribe: Effect.Effect<PubSub.Subscription<SessionMessage>, never, Scope.Scope>;
  /** Handles an event as if it came from TikTok (test buttons, automations). */
  readonly inject: (event: LiveEvent) => Effect.Effect<void>;
}

export interface SessionOptions {
  /** How often to check whether an offline streamer has gone live. Default 30 seconds. */
  readonly pollInterval?: Duration.Input;
  /** Events kept for replay. Default 50. */
  readonly historySize?: number;
  /** Per-subscriber buffer before old messages are dropped. Default 512. */
  readonly subscriberBuffer?: number;
  readonly connection?: LiveConnection.ConnectOptions;
}

type MutableStats = { -readonly [K in keyof SessionStats]: SessionStats[K] };

const emptyStats = (): MutableStats => ({
  likes: 0,
  diamonds: 0,
  follows: 0,
  shares: 0,
  joins: 0,
  chats: 0,
  viewers: 0,
  peakViewers: 0,
});

/** Starts a session that runs until the surrounding scope closes. */
export const make = (username: string, options: SessionOptions = {}) =>
  Effect.gen(function* () {
    const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? "30 seconds");
    const historySize = options.historySize ?? 50;
    const pubsub = yield* PubSub.sliding<SessionMessage>(options.subscriberBuffer ?? 512);

    // Mutated only inside Effect.sync blocks; fibers never interleave within one.
    // Start in the state the runner will enter first, so early snapshots are accurate.
    let state: SessionState = username === DEMO_USERNAME ? "live" : "connecting";
    let error: string | undefined;
    let room: RoomStatus | undefined;
    let roomId: string | undefined;
    let liveSince: number | undefined;
    let stats = emptyStats();
    let statsDirty = false;
    const history: Array<LiveEvent> = [];

    const snapshot = (): SessionStatus => ({
      username,
      state,
      ...(roomId ? { roomId } : {}),
      ...(room ? { title: room.title, owner: room.owner } : {}),
      ...(liveSince ? { liveSince } : {}),
      ...(error ? { error } : {}),
      stats: { ...stats },
    });

    const publishStatus = Effect.suspend(() => {
      statsDirty = false;
      return PubSub.publish(pubsub, { _tag: "Status", status: snapshot() });
    });

    const setState = (next: SessionState, nextError?: string) =>
      Effect.suspend(() => {
        state = next;
        error = nextError;
        return publishStatus;
      });

    const handleEvent = (event: LiveEvent) =>
      Effect.suspend(() => {
        switch (event.type) {
          case "like":
            stats.likes = Math.max(stats.likes + event.likeCount, event.totalLikeCount);
            break;
          case "gift":
            if (!event.streaking) stats.diamonds += event.totalDiamonds;
            break;
          case "follow":
            stats.follows++;
            break;
          case "share":
            stats.shares++;
            break;
          case "join":
            stats.joins++;
            break;
          case "chat":
            stats.chats++;
            break;
          case "viewers":
            stats.viewers = event.viewerCount;
            stats.peakViewers = Math.max(stats.peakViewers, event.viewerCount);
            break;
        }
        statsDirty = true;
        // Likes and viewer counts are too noisy to be useful as replayed history.
        if (event.type !== "like" && event.type !== "viewers") {
          history.push(event);
          if (history.length > historySize) history.shift();
        }
        return PubSub.publish(pubsub, { _tag: "Event", event });
      });

    const onConnection = (event: LiveConnection.ConnectionEvent) => {
      switch (event._tag) {
        case "Connected":
          return Effect.suspend(() => {
            room = event.room ?? room;
            // A new room means a new stream; reconnects to the same room keep running totals.
            if (event.roomId !== roomId) {
              roomId = event.roomId;
              liveSince = Date.now();
              stats = emptyStats();
              stats.viewers = event.room?.viewerCount ?? 0;
              stats.peakViewers = stats.viewers;
            }
            liveSince ??= Date.now();
            return setState("live");
          });
        case "Event":
          return handleEvent(event.event);
        case "Disconnected":
          return event.willReconnect ? setState("connecting") : Effect.void;
        case "Raw":
          return Effect.void;
      }
    };

    const runLive = Effect.gen(function* () {
      while (true) {
        yield* setState("connecting", error);
        const result = yield* LiveConnection.connect(username, options.connection).pipe(
          Stream.runForEach(onConnection),
          Effect.result,
        );
        if (result._tag === "Success") {
          liveSince = undefined;
          yield* setState("waiting");
        } else {
          const failure = result.failure;
          if (failure._tag === "UserOffline") {
            yield* setState("waiting");
          } else if (failure._tag === "UserNotFound") {
            yield* setState("error", failure.message);
            return;
          } else {
            yield* setState("error", failure.message);
          }
        }
        yield* Effect.sleep(pollInterval);
      }
    });

    if (username === DEMO_USERNAME) liveSince = Date.now();
    const runDemo = Effect.gen(function* () {
      yield* setState("live");
      yield* Stream.runForEach(demoEvents, handleEvent);
    });

    yield* (username === DEMO_USERNAME ? runDemo : runLive).pipe(Effect.forkScoped);

    // Push stat changes (goal bars etc.) at most once per second.
    yield* Effect.suspend(() => (statsDirty ? publishStatus : Effect.void)).pipe(
      Effect.delay("1 second"),
      Effect.forever,
      Effect.forkScoped,
    );

    return {
      username,
      status: Effect.sync(snapshot),
      recentEvents: Effect.sync(() => [...history]),
      subscribe: PubSub.subscribe(pubsub),
      inject: (event) => Effect.asVoid(handleEvent(event)),
    } satisfies Session;
  });
