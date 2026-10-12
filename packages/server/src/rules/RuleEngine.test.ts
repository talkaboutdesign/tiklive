/**
 * RuleEngine on top of an in-memory RulesStore: firing with the clock, per-streamer
 * state, the editor's Test button, and webhook steps (sent through a fake HttpClient).
 */
import { describe, expect, it } from "@effect/vitest";
import type { LiveEvent, Rule, WebhookStep } from "@tiklive/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { layer as ruleEngineLayer, RuleEngine } from "./RuleEngine.ts";
import * as RulesStore from "./RulesStore.ts";

const USER = { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" };

const gift = (overrides: Partial<Extract<LiveEvent, { type: "gift" }>> = {}): LiveEvent => ({
  type: "gift",
  timestamp: 0,
  user: USER,
  giftId: 5655,
  giftName: "Rose",
  giftImageUrl: "",
  diamondCount: 1,
  repeatCount: 1,
  streaking: false,
  totalDiamonds: 1,
  groupId: "0",
  ...overrides,
});

const giftRule = (overrides: Partial<Rule> = {}): Rule => ({
  id: "big",
  name: "Big gift",
  enabled: true,
  trigger: { type: "gift" },
  steps: [{ kind: "speak", text: "Thanks {nickname}" }],
  ...overrides,
});

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly contentType: string | undefined;
  readonly body: string | undefined;
}

/**
 * A fake HttpClient. Each request is recorded in `sent` as it starts; `answer` decides the outcome
 * (a status, a failure, or never).
 */
const fakeHttp = (
  sent: Array<Sent> = [],
  answer: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<number, HttpClientError.HttpClientError> = () => Effect.succeed(200),
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request) => {
      const body = request.body;
      const text = body._tag === "Uint8Array";
      sent.push({
        method: request.method,
        url: request.url,
        contentType: text ? body.contentType : undefined,
        body: text ? body.text : undefined,
      });
      return answer(request).pipe(
        Effect.map((status) => HttpClientResponse.fromWeb(request, new Response(null, { status }))),
      );
    }),
  );

const engineWith = (rules: ReadonlyArray<Rule>, http: Layer.Layer<HttpClient.HttpClient> = fakeHttp()) =>
  ruleEngineLayer.pipe(
    Layer.provide(Layer.mergeAll(RulesStore.layerMemory({ revision: 0, rules: [...rules] }), http)),
  );

const HOOK = "https://hooks.example.test/tiklive";
const hookRule = (step: Partial<Omit<WebhookStep, "kind">> = {}): Rule =>
  giftRule({ id: "hook", name: "Hook", steps: [{ kind: "webhook", url: HOOK, ...step }] });

/** Lets forked webhook fibers run. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
});

describe("RuleEngine.fire", () => {
  it.effect("returns an action per firing, with the steps rendered and the viewer attached", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const now = yield* Clock.currentTimeMillis;
      const actions = yield* engine.fire("someone", gift());
      expect(actions).toEqual([
        {
          id: expect.any(String),
          ruleId: "big",
          ruleName: "Big gift",
          timestamp: now,
          user: USER,
          steps: [{ kind: "speak", text: "Thanks Viewer" }],
        },
      ]);
    }).pipe(Effect.provide(engineWith([giftRule()]))),
  );

  it.effect("gives every action a unique id", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const first = yield* engine.fire("someone", gift());
      const second = yield* engine.fire("someone", gift());
      const ids = [...first, ...second].map((action) => action.id);
      expect(new Set(ids).size).toBe(2);
    }).pipe(Effect.provide(engineWith([giftRule()]))),
  );

  it.effect("applies cooldowns against the clock", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      expect(yield* engine.fire("someone", gift())).toHaveLength(1);
      yield* TestClock.adjust("9 seconds");
      expect(yield* engine.fire("someone", gift())).toHaveLength(0);
      yield* TestClock.adjust("1 second");
      expect(yield* engine.fire("someone", gift())).toHaveLength(1);
    }).pipe(Effect.provide(engineWith([giftRule({ cooldown: 10 })]))),
  );

  it.effect("keeps cooldowns and like totals separate per streamer", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      expect(yield* engine.fire("alice", gift())).toHaveLength(1);
      // Alice is cooling down; Bob is not.
      expect(yield* engine.fire("alice", gift())).toHaveLength(0);
      expect(yield* engine.fire("bob", gift())).toHaveLength(1);

      // Each streamer's likes total starts from zero, so both reach their first milestone once.
      const tenLikes: LiveEvent = {
        type: "like",
        timestamp: 0,
        user: USER,
        likeCount: 10,
        totalLikeCount: 10,
      };
      expect(yield* engine.fire("alice", tenLikes)).toHaveLength(1);
      expect(yield* engine.fire("bob", tenLikes)).toHaveLength(1);
    }).pipe(
      Effect.provide(
        engineWith([
          giftRule({ cooldown: 60 }),
          giftRule({
            id: "ten",
            trigger: { type: "likes", every: 10 },
            steps: [{ kind: "speak", text: "{likes}" }],
          }),
        ]),
      ),
    ),
  );

  it.effect("ignores disabled rules", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      expect(yield* engine.fire("someone", gift())).toEqual([]);
    }).pipe(Effect.provide(engineWith([giftRule({ enabled: false })]))),
  );
});

describe("RuleEngine.test", () => {
  it.effect("fires a disabled rule with a sample event, marked as a test", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const now = yield* Clock.currentTimeMillis;
      const action = yield* engine.test("someone", "big");
      expect(Option.getOrUndefined(action)).toEqual({
        id: expect.any(String),
        ruleId: "big",
        ruleName: "Big gift",
        timestamp: now,
        user: expect.objectContaining({ uniqueId: "test_user" }),
        test: true,
        steps: [{ kind: "speak", text: "Thanks Test User" }],
      });
    }).pipe(Effect.provide(engineWith([giftRule({ enabled: false })]))),
  );

  it.effect("ignores cooldowns and does not start one", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      expect(Option.isSome(yield* engine.test("someone", "big"))).toBe(true);
      expect(Option.isSome(yield* engine.test("someone", "big"))).toBe(true);
      // Testing left the cooldown untouched, so the real event still fires.
      expect(yield* engine.fire("someone", gift())).toHaveLength(1);
      expect(Option.isSome(yield* engine.test("someone", "big"))).toBe(true);
    }).pipe(Effect.provide(engineWith([giftRule({ cooldown: 60 })]))),
  );

  it.effect("fills the likes variable with the trigger's every", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const action = Option.getOrUndefined(yield* engine.test("someone", "likes"));
      expect(action?.steps).toEqual([{ kind: "speak", text: "25 likes" }]);
    }).pipe(
      Effect.provide(
        engineWith([
          giftRule({
            id: "likes",
            trigger: { type: "likes", every: 25 },
            steps: [{ kind: "speak", text: "{likes} likes" }],
          }),
        ]),
      ),
    ),
  );

  it.effect("returns an action with no steps when the rule renders none", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const action = Option.getOrUndefined(yield* engine.test("someone", "big"));
      expect(action?.steps).toEqual([]);
    }).pipe(Effect.provide(engineWith([giftRule({ steps: [{ kind: "speak", text: "   " }] })]))),
  );

  it.effect("returns None for an unknown rule id", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      expect(Option.isNone(yield* engine.test("someone", "nope"))).toBe(true);
    }).pipe(Effect.provide(engineWith([giftRule()]))),
  );

  it.effect("sends the webhook of a test action too, with the sample viewer", () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      yield* engine.test("someone", "hook");
      yield* settle;
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]?.body ?? "")).toMatchObject({
        event: "gift",
        user: { uniqueId: "test_user" },
      });
    }).pipe(Effect.provide(engineWith([hookRule()], fakeHttp(sent))));
  });
});

describe("RuleEngine webhook steps", () => {
  it.effect("POSTs a JSON description of the action when the step has no body", () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const now = yield* Clock.currentTimeMillis;
      expect(yield* engine.fire("someone", gift())).toHaveLength(1);
      yield* settle;
      expect(sent).toEqual([
        {
          method: "POST",
          url: HOOK,
          contentType: "application/json",
          body: JSON.stringify({
            rule: { id: "hook", name: "Hook" },
            event: "gift",
            user: { userId: "1", uniqueId: "viewer", nickname: "Viewer" },
            vars: {
              nickname: "Viewer",
              username: "viewer",
              giftName: "Rose",
              count: "1",
              coins: "1",
              comment: "",
              likes: "",
              months: "",
              followers: "",
            },
            timestamp: now,
          }),
        },
      ]);
    }).pipe(Effect.provide(engineWith([hookRule()], fakeHttp(sent))));
  });

  it.effect("sends a custom body as JSON when it parses, and as text otherwise", () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      // Both rules fire on one gift, so each step sends once, in rule order.
      yield* engine.fire("someone", gift());
      yield* settle;
      expect(sent.map((request) => [request.contentType, request.body])).toEqual([
        ["application/json", '{"text":"Viewer sent 1x Rose"}'],
        ["text/plain", "Viewer sent a gift"],
      ]);
    }).pipe(
      Effect.provide(
        engineWith(
          [
            hookRule({ body: '{"text":"{nickname} sent {count}x {giftName}"}' }),
            giftRule({ id: "text", steps: [{ kind: "webhook", url: HOOK, body: "{nickname} sent a gift" }] }),
          ],
          fakeHttp(sent),
        ),
      ),
    );
  });

  it.effect("sends PUT with the default payload, and GET with no body at all", () => {
    const sent: Array<Sent> = [];
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      yield* engine.fire("someone", gift());
      yield* settle;
      expect(sent.map((request) => [request.method, request.contentType, request.body])).toEqual([
        ["PUT", "application/json", expect.any(String)],
        ["GET", undefined, undefined],
      ]);
      expect(sent[1]?.url).toBe(`${HOOK}?who=Viewer`);
    }).pipe(
      Effect.provide(
        engineWith(
          [
            hookRule({ method: "PUT" }),
            giftRule({
              id: "get",
              steps: [{ kind: "webhook", url: `${HOOK}?who={nickname}`, method: "GET", body: "ignored" }],
            }),
          ],
          fakeHttp(sent),
        ),
      ),
    );
  });

  it.effect("does not wait for a slow webhook, and gives up on it after 5 seconds", () => {
    const sent: Array<Sent> = [];
    let aborted = 0;
    const slow = fakeHttp(sent, () =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            aborted++;
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      // Returns even though the request never completes.
      expect(yield* engine.fire("someone", gift())).toHaveLength(1);
      yield* settle;
      expect(sent).toHaveLength(1);
      expect(aborted).toBe(0);
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      expect(aborted).toBe(1);
    }).pipe(Effect.provide(engineWith([hookRule()], slow)));
  });

  it.effect("swallows failed webhooks: transport errors and error statuses", () => {
    const sent: Array<Sent> = [];
    let calls = 0;
    const flaky = fakeHttp(sent, (request) => {
      calls++;
      return calls === 1
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
            }),
          )
        : Effect.succeed(500);
    });
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      expect(yield* engine.fire("someone", gift())).toHaveLength(1);
      expect(yield* engine.fire("someone", gift())).toHaveLength(1);
      yield* settle;
      expect(sent).toHaveLength(2);
    }).pipe(Effect.provide(engineWith([hookRule()], flaky)));
  });

  it.effect("sends at most four webhook requests at once", () => {
    const sent: Array<Sent> = [];
    const gate = Latch.makeUnsafe(false);
    let inFlight = 0;
    let peak = 0;
    const held = fakeHttp(sent, () =>
      Effect.sync(() => {
        inFlight++;
        peak = Math.max(peak, inFlight);
      }).pipe(
        Effect.andThen(Latch.whenOpen(gate)(Effect.void)),
        Effect.andThen(
          Effect.sync(() => {
            inFlight--;
          }),
        ),
        Effect.as(200),
      ),
    );
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      for (let i = 0; i < 6; i++) yield* engine.fire("someone", gift());
      yield* settle;
      expect(sent).toHaveLength(4);
      expect(peak).toBe(4);
      yield* Latch.open(gate);
      yield* settle;
      expect(sent).toHaveLength(6);
      expect(peak).toBe(4);
    }).pipe(Effect.provide(engineWith([hookRule()], held)));
  });

  it.effect("drops webhook requests beyond 100 waiting, so a stuck receiver can't pile them up", () => {
    const sent: Array<Sent> = [];
    const gate = Latch.makeUnsafe(false);
    const stuck = fakeHttp(sent, () => Latch.whenOpen(gate)(Effect.void).pipe(Effect.as(200)));
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      for (let i = 0; i < 130; i++) yield* engine.fire("someone", gift());
      yield* settle;
      yield* Latch.open(gate);
      yield* settle;
      // 100 were accepted (4 sending, 96 waiting); the other 30 were dropped.
      expect(sent).toHaveLength(100);
      // Once they finish, new ones are accepted again.
      yield* engine.fire("someone", gift());
      yield* settle;
      expect(sent).toHaveLength(101);
    }).pipe(Effect.provide(engineWith([hookRule()], stuck)));
  });
});
