/**
 * Shares one Session per streamer between everything that needs it, starting
 * sessions on first use and stopping them after they've been unused for a while.
 */
import type { FiredAction, LiveEvent, SessionStatus } from "@tiklive/contracts";
import type { TikTokWeb } from "@tiklive/core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";
import * as Session from "./Session.ts";
import { PointsStore } from "./points/PointsStore.ts";
import { RuleEngine } from "./rules/RuleEngine.ts";

export interface SessionInfo extends SessionStatus {
  /** Kept running regardless of subscribers. */
  readonly watching: boolean;
  /** Number of active subscribers (overlays, apps). */
  readonly subscribers: number;
}

export class SessionManager extends Context.Service<
  SessionManager,
  {
    /** Uses a session for the lifetime of the scope. `username` must already be normalized. */
    readonly acquire: (username: string) => Effect.Effect<Session.Session, never, Scope.Scope>;
    /** A running session, without keeping it alive. */
    readonly get: (username: string) => Effect.Effect<Option.Option<Session.Session>>;
    /** Keeps a session running until `unwatch`, connecting whenever the streamer goes live. */
    readonly watch: (username: string) => Effect.Effect<Session.Session>;
    readonly unwatch: (username: string) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<SessionInfo>>;
  }
>()("@tiklive/server/SessionManager") {}

export interface SessionManagerOptions {
  /** How long a session stays connected after its last subscriber leaves. Default 60 seconds. */
  readonly idleTimeout?: Duration.Input;
  /** Streamers to watch from startup. */
  readonly watch?: ReadonlyArray<string>;
  readonly session?: Session.SessionOptions;
}

export const make = (options: SessionManagerOptions = {}) =>
  Effect.gen(function* () {
    const running = new Map<string, Session.Session>();
    const subscribers = new Map<string, number>();
    const watching = new Map<string, Scope.Closeable>();
    // Both optional: without a RuleEngine sessions fire no actions, and without a PointsStore they
    // record no points.
    const engine = yield* Effect.serviceOption(RuleEngine);
    const points = yield* Effect.serviceOption(PointsStore);

    const sessionOptionsFor = (username: string): Session.SessionOptions | undefined => {
      if (Option.isNone(engine) && Option.isNone(points)) return options.session;
      // Points first, so a rule that runs on this event already sees the viewer's new total.
      const actions = (event: LiveEvent): Effect.Effect<ReadonlyArray<FiredAction>> =>
        Effect.gen(function* () {
          if (Option.isSome(points)) yield* points.value.record(username, event);
          if (Option.isNone(engine)) return [];
          return yield* engine.value.fire(username, event);
        });
      return { ...options.session, actions };
    };

    const sessions = yield* RcMap.make({
      lookup: (username: string) =>
        Effect.acquireRelease(
          Session.make(username, sessionOptionsFor(username)).pipe(
            Effect.tap((s) => Effect.sync(() => running.set(username, s))),
          ),
          () => Effect.sync(() => running.delete(username)),
        ),
      idleTimeToLive: options.idleTimeout ?? "60 seconds",
    });

    const acquire = (username: string) =>
      Effect.acquireRelease(
        Effect.sync(() => subscribers.set(username, (subscribers.get(username) ?? 0) + 1)),
        () => Effect.sync(() => subscribers.set(username, (subscribers.get(username) ?? 1) - 1)),
      ).pipe(Effect.andThen(RcMap.get(sessions, username)));

    const watch = (username: string) =>
      Effect.gen(function* () {
        const existing = watching.get(username);
        if (existing) return yield* RcMap.get(sessions, username).pipe(Scope.provide(existing));
        const scope = yield* Scope.make();
        watching.set(username, scope);
        return yield* RcMap.get(sessions, username).pipe(Scope.provide(scope));
      });

    const unwatch = (username: string) =>
      Effect.suspend(() => {
        const scope = watching.get(username);
        if (!scope) return Effect.void;
        watching.delete(username);
        return Scope.close(scope, Exit.void);
      });

    const list = () =>
      Effect.forEach([...running.values()], (session) =>
        Effect.map(session.status, (status): SessionInfo => ({
          ...status,
          watching: watching.has(session.username),
          subscribers: subscribers.get(session.username) ?? 0,
        })),
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...watching.values()], (scope) => Scope.close(scope, Exit.void), { discard: true }),
    );
    for (const username of options.watch ?? []) yield* watch(username);

    return SessionManager.of({
      acquire,
      get: (username) => Effect.sync(() => Option.fromUndefinedOr(running.get(username))),
      watch,
      unwatch,
      list: Effect.suspend(list),
    });
  });

export const layer = (
  options: SessionManagerOptions = {},
): Layer.Layer<SessionManager, never, TikTokWeb.TikTokWeb | Socket.WebSocketConstructor> =>
  Layer.effect(SessionManager, make(options));
