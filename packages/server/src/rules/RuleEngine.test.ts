/**
 * RuleEngine on top of an in-memory RulesStore: firing with the clock, per-streamer
 * state, the editor's Test button, and webhook steps (sent through a fake HttpClient).
 */
import { describe, expect, it } from "@effect/vitest";
import type { LiveEvent, LiveUser, Rule, WebhookStep } from "@tiklive/contracts";
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
import { renderRule, templateVars } from "./evaluate.ts";
import { layer as ruleEngineLayer, RuleEngine } from "./RuleEngine.ts";
import * as RulesStore from "./RulesStore.ts";
import { webhookPayload, webhookRequest } from "./webhook.ts";

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

const chatEvent = (comment: string, user: LiveUser = USER): LiveEvent => ({
  type: "chat",
  timestamp: 0,
  user,
  comment,
  emotes: [],
});

/** A chat rule whose webhook step has `body`. */
const chatRule = (body: string): Rule => ({
  id: "chat",
  name: "Chat",
  enabled: true,
  trigger: { type: "chat", match: "any" },
  steps: [{ kind: "webhook", url: HOOK, body }],
});

/** Fires `event` at a chat rule whose body is `template`, and returns the requests sent. */
const sentBodies = (template: string, event: LiveEvent) => {
  const sent: Array<Sent> = [];
  return Effect.gen(function* () {
    const engine = yield* RuleEngine;
    yield* engine.fire("someone", event);
    yield* settle;
    return sent;
  }).pipe(Effect.provide(engineWith([chatRule(template)], fakeHttp(sent))));
};

describe("RuleEngine.fire", () => {
  it.effect("skips lazy extras while rules are empty and uses edits on the next event", () => {
    const storeLayer = RulesStore.layerMemory();
    const engineLayer = ruleEngineLayer.pipe(Layer.provide(Layer.mergeAll(storeLayer, fakeHttp())));
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const store = yield* RulesStore.RulesStore;
      const unused = () => Effect.die("Empty rules must not resolve extras");
      expect(yield* engine.fireWithExtras!("someone", gift(), unused)).toEqual([]);
      yield* store.replace(0, [giftRule({ steps: [{ kind: "speak", text: "{points} points" }] })]);
      const fired = yield* engine.fireWithExtras!("someone", gift(), () => Effect.succeed({ points: "51" }));
      expect(fired[0]?.steps).toEqual([{ kind: "speak", text: "51 points" }]);
      yield* store.replace(1, []);
      expect(yield* engine.fireWithExtras!("someone", gift(), unused)).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(storeLayer, engineLayer)));
  });

  it.effect("keeps likes and stream resets current while no rules exist", () => {
    const storeLayer = RulesStore.layerMemory();
    const engineLayer = ruleEngineLayer.pipe(Layer.provide(Layer.mergeAll(storeLayer, fakeHttp())));
    const likes: LiveEvent = { type: "like", timestamp: 0, user: USER, likeCount: 15, totalLikeCount: 15 };
    const rule = giftRule({
      trigger: { type: "likes", every: 10 },
      steps: [{ kind: "speak", text: "{likes}" }],
    });
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const store = yield* RulesStore.RulesStore;
      yield* engine.fire("someone", likes, {}, "room-a");
      yield* store.replace(0, [rule]);
      const fired = yield* engine.fire("someone", { ...likes, likeCount: 1 }, {}, "room-a");
      expect(fired[0]?.steps).toEqual([{ kind: "speak", text: "10" }]);
      yield* store.replace(1, []);
      yield* engine.fire("someone", { type: "streamEnd", reason: "ended", timestamp: 0 });
      yield* store.replace(2, [rule]);
      expect(yield* engine.fire("someone", { ...likes, likeCount: 1 }, {}, "room-a")).toEqual([]);
      yield* store.replace(3, []);
      yield* engine.fire("someone", likes, {}, "room-a");
      // A different room clears the previous stream's likes, even before any rules are added.
      yield* engine.fire("someone", { ...likes, likeCount: 1 }, {}, "room-b");
      yield* store.replace(4, [rule]);
      expect(yield* engine.fire("someone", { ...likes, likeCount: 1 }, {}, "room-b")).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(storeLayer, engineLayer)));
  });

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
              points: "",
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

  it.effect(
    "sends a body as JSON only when its template is a JSON object or array, whatever viewers type",
    () => {
      const hostile: LiveUser = { ...USER, nickname: '{"x":0' };
      return Effect.gen(function* () {
        // The blocker. It starts with `{nickname}`, so it's text: the viewer's text is sent as typed.
        expect(
          yield* sentBodies(
            '{nickname},"action":"safe","said":"{comment}"}',
            chatEvent('x","action":"evil","pad":"', hostile),
          ),
        ).toMatchObject([
          { contentType: "text/plain", body: '{"x":0,"action":"safe","said":"x","action":"evil","pad":""}' },
        ]);
        // A lone placeholder is text, and so is text that starts with `[` or `"`.
        expect(yield* sentBodies("{comment}", chatEvent('{"action":"evil"}'))).toMatchObject([
          { contentType: "text/plain", body: '{"action":"evil"}' },
        ]);
        expect(yield* sentBodies("[Alert] {comment}", chatEvent('say "hi", {"a":1}'))).toMatchObject([
          { contentType: "text/plain", body: '[Alert] say "hi", {"a":1}' },
        ]);
        expect(yield* sentBodies('"{comment}" said hi', chatEvent('x"}'))).toMatchObject([
          { contentType: "text/plain", body: '"x"}" said hi' },
        ]);
        // An object is JSON, and a viewer's text stays inside its string, so `action` stays "safe".
        const [json] = yield* sentBodies(
          '{"viewer":"{nickname}","action":"safe"}',
          chatEvent("hi", { ...USER, nickname: 'x", "action": "evil' }),
        );
        expect(json?.contentType).toBe("application/json");
        expect(JSON.parse(json?.body ?? "")).toEqual({ viewer: 'x", "action": "evil', action: "safe" });
        // A body with no placeholders is JSON when it parses, as it always was.
        expect(yield* sentBodies("123", chatEvent("hi"))).toMatchObject([
          { contentType: "application/json", body: "123" },
        ]);
      });
    },
  );

  for (const path of ["fire", "Test"] as const) {
    const hostile = 'x","action":"evil';
    const cases = [
      {
        template: "[1{comment}]",
        event: chatEvent(hostile),
        contentType: "text/plain",
        body: `[1${hostile}]`,
      },
      {
        template: "[-{comment}]",
        event: chatEvent(hostile),
        contentType: "text/plain",
        body: `[-${hostile}]`,
      },
      { template: '{"count":0{count}}', event: gift(), contentType: "text/plain", body: '{"count":01}' },
      { template: '{"count":{count}}', event: gift(), contentType: "application/json", body: '{"count":1}' },
      { template: "[{count}, {coins}]", event: gift(), contentType: "application/json", body: "[1, 1]" },
      {
        template: '{"a":{comment}}',
        event: chatEvent(hostile),
        contentType: "application/json",
        body: JSON.stringify({ a: hostile }),
      },
      ...["123", "true", "null"].map((body) => ({
        template: body,
        event: gift(),
        contentType: "application/json",
        body,
      })),
    ];
    for (const { template, event, contentType, body } of cases) {
      it.effect(`${path}: requires whole-value bare placeholders in ${template}`, () => {
        const sent: Array<Sent> = [];
        const rule = giftRule({
          trigger:
            event.type === "chat" ? { type: "chat", match: "contains", text: hostile } : { type: "gift" },
          steps: [{ kind: "webhook", url: HOOK, body: template }],
        });
        return Effect.gen(function* () {
          const engine = yield* RuleEngine;
          if (path === "fire") yield* engine.fire("someone", event);
          else yield* engine.test("someone", rule.id);
          yield* settle;
          expect(sent).toMatchObject([{ contentType, body }]);
        }).pipe(Effect.provide(engineWith([rule], fakeHttp(sent))));
      });
    }
  }

  it.effect("sends the same kinds of body on the Test button, with the sample's values", () => {
    const sent: Array<Sent> = [];
    const testRule = (id: string, text: string, body: string): Rule => ({
      id,
      name: id,
      enabled: true,
      trigger: { type: "chat", match: "contains", text },
      steps: [{ kind: "webhook", url: HOOK, body }],
    });
    return Effect.gen(function* () {
      const engine = yield* RuleEngine;
      // The sample comment is the trigger's text, so the hostile text here is what the Test button sends.
      yield* engine.test("someone", "json");
      yield* settle;
      yield* engine.test("someone", "text");
      yield* settle;
      expect(sent).toHaveLength(2);
      expect(sent[0]?.contentType).toBe("application/json");
      expect(JSON.parse(sent[0]?.body ?? "")).toEqual({ viewer: "Test User", said: 'x","action":"evil' });
      expect(sent[1]).toMatchObject({ contentType: "text/plain", body: '{"action":"evil"}' });
    }).pipe(
      Effect.provide(
        engineWith(
          [
            testRule("json", 'x","action":"evil', '{"viewer":"{nickname}","said":"{comment}"}'),
            testRule("text", '{"action":"evil"}', "{comment}"),
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

describe("webhookRequest", () => {
  it("sends unregistered explicit bodies as text without classifying their contents", () => {
    const payload = webhookPayload(
      { id: "x", ruleId: "r", ruleName: "r", timestamp: 0, steps: [] },
      "chat",
      templateVars(chatEvent("hi")),
    );
    const contentTypeOf = (body: string) => {
      const request = webhookRequest({ kind: "webhook", url: HOOK, body }, payload);
      const sent = request.body;
      return sent._tag === "Uint8Array" ? sent.contentType : undefined;
    };
    expect(contentTypeOf('{"viewer":"{nickname}"}')).toBe("text/plain");
    expect(contentTypeOf("123")).toBe("text/plain");
    expect(contentTypeOf("{nickname} sent a gift")).toBe("text/plain");
  });

  it.each(["spread", "structuredClone"] as const)(
    "sends a %s copy of a rendered hostile step as text",
    (copy) => {
      const hostile = '{"action":"evil"}';
      const event = chatEvent(hostile);
      const { steps, vars } = renderRule(chatRule("{comment}"), event);
      const step = steps[0];
      if (step?.kind !== "webhook") throw new Error("Expected a rendered webhook step");
      const payload = webhookPayload(
        { id: "x", ruleId: "r", ruleName: "r", timestamp: 0, steps },
        "chat",
        vars,
      );
      const request = webhookRequest(copy === "spread" ? { ...step } : structuredClone(step), payload);
      expect(request.body).toMatchObject({ contentType: "text/plain", text: hostile });
    },
  );
});

describe("room identity", () => {
  it.effect("preserves joins for the same room and resets them when a later session uses a new room", () =>
    Effect.gen(function* () {
      const engine = yield* RuleEngine;
      const join: LiveEvent = { type: "join", timestamp: 0, user: USER };
      expect(yield* engine.fire("streamer", join, {}, "room-a")).toHaveLength(1);
      expect(yield* engine.fire("streamer", join, {}, "room-a")).toHaveLength(0);
      // No streamEnd arrives while the session is absent.
      expect(yield* engine.fire("streamer", join, {}, "room-b")).toHaveLength(1);
      expect(yield* engine.fire("streamer", join, {}, "room-b")).toHaveLength(0);
    }).pipe(Effect.provide(engineWith([giftRule({ trigger: { type: "join" } })]))),
  );
});
