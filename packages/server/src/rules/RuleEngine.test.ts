/**
 * RuleEngine on top of an in-memory RulesStore: firing with the clock, per-streamer
 * state, and the editor's Test button.
 */
import { describe, expect, it } from "@effect/vitest";
import type { LiveEvent, Rule } from "@tiklive/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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

const engineWith = (rules: ReadonlyArray<Rule>) =>
  ruleEngineLayer.pipe(Layer.provide(RulesStore.layerMemory({ revision: 0, rules: [...rules] })));

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
});
