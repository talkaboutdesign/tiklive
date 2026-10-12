/**
 * Turns events into fired actions using the rules in `RulesStore`. Cooldowns and
 * like counters are kept per streamer, in memory. The matching itself is the pure
 * `evaluate` in ./evaluate.ts; this service adds the clock, ids and state.
 */
import type { FiredAction, LiveEvent } from "@tiklive/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  emptyState,
  evaluate,
  type EngineState,
  type Firing,
  renderSteps,
  sampleEvent,
  userOf,
} from "./evaluate.ts";
import { RulesStore } from "./RulesStore.ts";

export class RuleEngine extends Context.Service<
  RuleEngine,
  {
    /** Actions fired by this event for this streamer, in rule order. Never fails. */
    readonly fire: (username: string, event: LiveEvent) => Effect.Effect<ReadonlyArray<FiredAction>>;
    /**
     * Fires one rule with a made-up event that matches its trigger, ignoring `enabled`
     * and cooldowns, for the editor's Test button. None if no rule has this id.
     */
    readonly test: (username: string, ruleId: string) => Effect.Effect<Option.Option<FiredAction>>;
  }
>()("@tiklive/server/RuleEngine") {}

/** Rules are read from `RulesStore` on every event, so edits apply immediately. */
export const layer: Layer.Layer<RuleEngine, never, RulesStore> = Layer.effect(
  RuleEngine,
  Effect.gen(function* () {
    const store = yield* RulesStore;
    // Mutated only inside Effect.try/sync blocks, which run without yielding.
    const states = new Map<string, EngineState>();
    let counter = 0;

    const stateFor = (username: string): EngineState => {
      let state = states.get(username);
      if (!state) {
        state = emptyState();
        states.set(username, state);
      }
      return state;
    };

    const nextId = (now: number) => `${now.toString(36)}-${counter++}`;

    const toAction = (firing: Firing, now: number): FiredAction => ({
      id: nextId(now),
      ruleId: firing.rule.id,
      ruleName: firing.rule.name,
      timestamp: now,
      ...(firing.user ? { user: firing.user } : {}),
      steps: [...firing.steps],
    });

    const fire = (username: string, event: LiveEvent): Effect.Effect<ReadonlyArray<FiredAction>> =>
      Effect.gen(function* () {
        const { rules } = yield* store.get;
        const now = yield* Clock.currentTimeMillis;
        return yield* Effect.try({
          try: () => evaluate(rules, stateFor(username), event, now).map((firing) => toAction(firing, now)),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Action rules failed for an event; skipping it", cause).pipe(
              Effect.as<ReadonlyArray<FiredAction>>([]),
            ),
          ),
        );
      });

    const test = (_username: string, ruleId: string): Effect.Effect<Option.Option<FiredAction>> =>
      Effect.gen(function* () {
        const { rules } = yield* store.get;
        const rule = rules.find((candidate) => candidate.id === ruleId);
        if (!rule) return Option.none();
        const now = yield* Clock.currentTimeMillis;
        const event = sampleEvent(rule.trigger, now);
        const extra = rule.trigger.type === "likes" ? { likes: String(rule.trigger.every) } : {};
        const user = userOf(event);
        return Option.some<FiredAction>({
          id: nextId(now),
          ruleId: rule.id,
          ruleName: rule.name,
          timestamp: now,
          ...(user ? { user } : {}),
          test: true,
          steps: [...renderSteps(rule, event, extra)],
        });
      });

    return RuleEngine.of({ fire, test });
  }),
);
