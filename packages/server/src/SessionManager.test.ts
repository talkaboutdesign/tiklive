/**
 * SessionManager lifecycle: sessions live while acquired or watched, and are
 * stopped after the idle timeout once nothing needs them.
 */
import { describe, expect, it } from "@effect/vitest";
import type { FiredAction, LiveEvent, Rule } from "@tiklive/contracts";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { fakeTikTokWebLayer, fakeWebSocketLayer } from "@tiklive/core/testing";
import * as PointsStore from "./points/PointsStore.ts";
import * as RuleEngine from "./rules/RuleEngine.ts";
import * as RulesStore from "./rules/RulesStore.ts";
import * as SessionManager from "./SessionManager.ts";

const managerLayer = (options: SessionManager.SessionManagerOptions = {}) =>
  SessionManager.layer(options).pipe(
    Layer.provide(Layer.mergeAll(fakeTikTokWebLayer({ live: true }), fakeWebSocketLayer().layer)),
  );

/** Like `managerLayer`, but with a RuleEngine (over the given rules) in the sessions' context. */
const managerWithRulesLayer = (rules: ReadonlyArray<Rule>) =>
  SessionManager.layer({ idleTimeout: "10 seconds" }).pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeTikTokWebLayer({ live: true }),
        fakeWebSocketLayer().layer,
        RuleEngine.layer.pipe(
          Layer.provide(
            Layer.mergeAll(RulesStore.layerMemory({ revision: 0, rules }), FetchHttpClient.layer),
          ),
        ),
      ),
    ),
  );

const DANCE: Rule = {
  id: "dance",
  name: "Dance",
  enabled: true,
  trigger: { type: "chat", match: "command", text: "!dance" },
  steps: [{ kind: "speak", text: "{nickname} dances" }],
};

const chat = (comment: string): LiveEvent => ({
  type: "chat",
  timestamp: 1_700_000_000_000,
  user: { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" },
  comment,
  emotes: [],
});

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

const listedUsernames = (manager: SessionManager.SessionManager["Service"]) =>
  Effect.map(manager.list, (sessions) => sessions.map((s) => s.username));

describe("SessionManager", () => {
  it.live("keeps a session while it is acquired and stops it after the idle timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        expect(Option.isNone(yield* manager.get("demo"))).toBe(true);

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* manager.acquire("demo");
            expect(Option.isSome(yield* manager.get("demo"))).toBe(true);
            const [info] = yield* manager.list;
            expect(info).toMatchObject({ username: "demo", subscribers: 1, watching: false });
          }),
        );

        // The scope has closed; the session lingers for the idle timeout, then goes away.
        yield* waitUntil(listedUsernames(manager), (names) => names.length === 0, "session to stop");
        expect(Option.isNone(yield* manager.get("demo"))).toBe(true);
      }).pipe(Effect.provide(managerLayer({ idleTimeout: "50 millis" }))),
    ),
  );

  it.live("shares one session between concurrent acquirers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const first = yield* Effect.scoped(manager.acquire("demo"));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const second = yield* manager.acquire("demo");
            expect(second).toBe(first);
            const [info] = yield* manager.list;
            expect(info?.subscribers).toBe(1);
          }),
        );
        expect(yield* listedUsernames(manager)).toEqual(["demo"]);
      }).pipe(Effect.provide(managerLayer({ idleTimeout: "10 seconds" }))),
    ),
  );

  it.live("keeps a watched session beyond any subscriber scope until unwatched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        yield* manager.watch("demo");

        // Subscriber comes and goes; the watch keeps the session running past the idle timeout.
        yield* Effect.scoped(manager.acquire("demo"));
        yield* Effect.sleep("200 millis");
        const [watched] = yield* manager.list;
        expect(watched).toMatchObject({ username: "demo", watching: true, subscribers: 0 });

        yield* manager.unwatch("demo");
        yield* waitUntil(
          listedUsernames(manager),
          (names) => names.length === 0,
          "unwatched session to stop",
        );
      }).pipe(Effect.provide(managerLayer({ idleTimeout: "50 millis" }))),
    ),
  );

  it.live("starts configured streamers immediately and keeps them watched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        yield* waitUntil(listedUsernames(manager), (names) => names.includes("demo"), "startup watch");
        yield* Effect.sleep("150 millis");
        const [info] = yield* manager.list;
        expect(info).toMatchObject({ username: "demo", watching: true, state: "live" });
      }).pipe(Effect.provide(managerLayer({ idleTimeout: "50 millis", watch: ["demo"] }))),
    ),
  );

  it.live("fires rule actions for session events when a RuleEngine is provided", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const session = yield* manager.acquire("someone");
        yield* waitUntil(session.status, (s) => s.state === "live", "live");
        const subscription = yield* session.subscribe;

        yield* session.inject(chat("!dance now"));

        let fired: FiredAction | undefined;
        while (!fired) {
          const message = yield* PubSub.take(subscription);
          if (message._tag === "Action") fired = message.action;
        }
        expect(fired).toMatchObject({ ruleId: "dance", steps: [{ kind: "speak", text: "Viewer dances" }] });
      }).pipe(Effect.provide(managerWithRulesLayer([DANCE]))),
    ),
  );

  it.live("fires no rule actions without a RuleEngine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const session = yield* manager.acquire("someone");
        yield* waitUntil(session.status, (s) => s.state === "live", "live");
        const subscription = yield* session.subscribe;

        yield* session.inject(chat("!dance now"));
        yield* session.inject(chat("and again"));

        // Read through the second event: any action from the first would have arrived before it.
        const received: Array<{ readonly _tag: string }> = [];
        while (received.filter((m) => m._tag === "Event").length < 2) {
          received.push(yield* PubSub.take(subscription));
        }
        expect(received.some((m) => m._tag === "Action")).toBe(false);
      }).pipe(Effect.provide(managerLayer({ idleTimeout: "10 seconds" }))),
    ),
  );

  it.live("watch returns the running session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const session = yield* manager.watch("demo");
        expect(session.username).toBe("demo");
        // The session's runner is forked, so the first snapshot may still read "idle".
        const status = yield* waitUntil(session.status, (s) => s.state === "live", "live");
        expect(status).toMatchObject({ username: "demo", state: "live" });
        expect(Option.getOrUndefined(yield* manager.get("demo"))).toBe(session);
      }).pipe(Effect.provide(managerLayer({ idleTimeout: "50 millis" }))),
    ),
  );
});

describe("SessionManager viewer points", () => {
  const follow = (userId: string): LiveEvent => ({
    type: "follow",
    timestamp: 1_700_000_000_000,
    user: { userId, uniqueId: `u${userId}`, nickname: `User ${userId}`, profilePictureUrl: "" },
  });

  it.effect("keeps earning points with empty rules and supplies the total when a rule is added", () => {
    const points = PointsStore.layerMemory;
    const rules = RulesStore.layerMemory();
    const engine = RuleEngine.layer.pipe(Layer.provide(Layer.mergeAll(rules, FetchHttpClient.layer)));
    const manager = SessionManager.layer().pipe(
      Layer.provide(Layer.mergeAll(fakeTikTokWebLayer(), fakeWebSocketLayer().layer, points, engine)),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* SessionManager.SessionManager;
        const store = yield* RulesStore.RulesStore;
        const session = yield* sessions.acquire("someone");
        yield* session.inject(follow("1"));
        yield* store.replace(0, [{ ...DANCE, steps: [{ kind: "speak", text: "{points} points" }] }]);
        const subscription = yield* session.subscribe;
        yield* session.inject(chat("!dance"));
        while (true) {
          const message = yield* PubSub.take(subscription);
          if (message._tag !== "Action") continue;
          expect(message.action.steps).toEqual([{ kind: "speak", text: "51 points" }]);
          break;
        }
      }).pipe(Effect.provide(Layer.mergeAll(manager, rules))),
    );
  });

  /** A RuleEngine that records the viewer's points as seen when it runs, and fires nothing. */
  const pointsSeenByRules = (seen: Array<number | undefined>) =>
    Layer.effect(
      RuleEngine.RuleEngine,
      Effect.gen(function* () {
        const points = yield* PointsStore.PointsStore;
        return RuleEngine.RuleEngine.of({
          fire: (username, event, extra) =>
            Effect.gen(function* () {
              const viewer = yield* points.get(username, event.type === "follow" ? event.user.userId : "");
              expect(extra?.points).toBe(Option.isSome(viewer) ? String(viewer.value.points) : undefined);
              seen.push(Option.getOrUndefined(Option.map(viewer, (v) => v.points)));
              return [];
            }),
          test: () => Effect.succeed(Option.none()),
        });
      }),
    );

  it.live("records points before the rules run on the same event", () => {
    const seen: Array<number | undefined> = [];
    const points = PointsStore.layerMemory;
    const layer = SessionManager.layer({ idleTimeout: "10 seconds" }).pipe(
      Layer.provide(
        Layer.mergeAll(
          fakeTikTokWebLayer({ live: true }),
          fakeWebSocketLayer().layer,
          pointsSeenByRules(seen).pipe(Layer.provide(points)),
          points,
        ),
      ),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const session = yield* manager.acquire("someone");
        yield* waitUntil(session.status, (s) => s.state === "live", "live");
        yield* session.inject(follow("7"));
        // Follows are worth 50 points by default, so the rules must see 50, not nothing.
        expect(seen).toEqual([50]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.live("fills {points} with the viewer's total, including this event", () => {
    const points = PointsStore.layerMemory;
    const rule: Rule = {
      id: "points",
      name: "Points",
      enabled: true,
      trigger: { type: "chat", match: "command", text: "!points" },
      steps: [{ kind: "speak", text: "{nickname} has {points} points" }],
    };
    const layer = SessionManager.layer({ idleTimeout: "10 seconds" }).pipe(
      Layer.provide(
        Layer.mergeAll(
          fakeTikTokWebLayer({ live: true }),
          fakeWebSocketLayer().layer,
          RuleEngine.layer.pipe(
            Layer.provide(
              Layer.mergeAll(RulesStore.layerMemory({ revision: 0, rules: [rule] }), FetchHttpClient.layer),
            ),
          ),
          points,
        ),
      ),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const session = yield* manager.acquire("someone");
        yield* waitUntil(session.status, (s) => s.state === "live", "live");
        const subscription = yield* session.subscribe;

        // Same viewer (id 1): a follow (50), then the command itself earns 1 chat point before the rule runs.
        yield* session.inject(follow("1"));
        yield* session.inject(chat("!points"));

        let fired: FiredAction | undefined;
        while (!fired) {
          const message = yield* PubSub.take(subscription);
          if (message._tag === "Action") fired = message.action;
        }
        expect(fired.steps).toEqual([{ kind: "speak", text: "Viewer has 51 points" }]);
      }).pipe(Effect.provide(Layer.mergeAll(layer, points))),
    );
  });

  it.live("keeps points without a RuleEngine", () => {
    const points = PointsStore.layerMemory;
    const layer = SessionManager.layer({ idleTimeout: "10 seconds" }).pipe(
      Layer.provide(Layer.mergeAll(fakeTikTokWebLayer({ live: true }), fakeWebSocketLayer().layer, points)),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* SessionManager.SessionManager;
        const session = yield* manager.acquire("someone");
        yield* waitUntil(session.status, (s) => s.state === "live", "live");
        yield* session.inject(follow("7"));
        const store = yield* PointsStore.PointsStore;
        expect(Option.getOrThrow(yield* store.get("someone", "7")).points).toBe(50);
      }).pipe(Effect.provide(Layer.mergeAll(layer, points))),
    );
  });
});
