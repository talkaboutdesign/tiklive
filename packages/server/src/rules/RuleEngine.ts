/**
 * Turns events into fired actions using the rules in `RulesStore`. Cooldowns and
 * like counters are kept per streamer, in memory. The matching itself is the pure
 * `evaluate` in ./evaluate.ts; this service adds the clock, ids and state, and sends
 * the webhook steps of the actions it fires.
 */
import type { FiredAction, LiveEvent, WebhookStep } from "@tiklive/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import {
  emptyState,
  evaluate,
  type EngineState,
  type Firing,
  renderRule,
  sampleEvent,
  type TemplateValues,
  userOf,
} from "./evaluate.ts";
import { RulesStore } from "./RulesStore.ts";
import {
  redactUrl,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_TIMEOUT,
  type WebhookPayload,
  webhookPayload,
  webhookRequest,
} from "./webhook.ts";

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

const describeError = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Rules are read from `RulesStore` on every event, so edits apply immediately. Webhook steps
 * are sent from fibers that live in the layer's scope, so they stop when the server does.
 */
export const layer: Layer.Layer<RuleEngine, never, RulesStore | HttpClient.HttpClient> = Layer.effect(
  RuleEngine,
  Effect.gen(function* () {
    const store = yield* RulesStore;
    const client = yield* HttpClient.HttpClient;
    const scope = yield* Effect.scope;
    const slots = yield* Semaphore.make(WEBHOOK_CONCURRENCY);
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

    /**
     * Sends one webhook step: at most WEBHOOK_CONCURRENCY at a time, with a timeout and no
     * retries. The response status is logged at debug; failures at warning. Never fails.
     */
    const send = (step: WebhookStep, payload: WebhookPayload): Effect.Effect<void> => {
      const label = `${step.method ?? "POST"} ${redactUrl(step.url)}`;
      return Semaphore.withPermit(
        slots,
        Effect.gen(function* () {
          const response = yield* client.execute(webhookRequest(step, payload));
          // Read the body so the connection can be reused. Its contents aren't used.
          yield* response.text;
          yield* Effect.logDebug(`Webhook ${label} responded ${response.status}`);
        }).pipe(Effect.timeout(WEBHOOK_TIMEOUT)),
      ).pipe(Effect.catch((cause) => Effect.logWarning(`Webhook ${label} failed: ${describeError(cause)}`)));
    };

    /** Starts the webhook steps of one action in the background. Returns without waiting for them. */
    const dispatch = (action: FiredAction, eventType: LiveEvent["type"], vars: TemplateValues) =>
      Effect.gen(function* () {
        for (const step of action.steps) {
          if (step.kind !== "webhook") continue;
          yield* Effect.forkIn(send(step, webhookPayload(action, eventType, vars)), scope);
        }
      });

    const fire = (username: string, event: LiveEvent): Effect.Effect<ReadonlyArray<FiredAction>> =>
      Effect.gen(function* () {
        const { rules } = yield* store.get;
        const now = yield* Clock.currentTimeMillis;
        const firings = yield* Effect.try({
          try: () => evaluate(rules, stateFor(username), event, now),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Action rules failed for an event; skipping it", cause).pipe(
              Effect.as<ReadonlyArray<Firing>>([]),
            ),
          ),
        );
        const actions: Array<FiredAction> = [];
        for (const firing of firings) {
          const action = toAction(firing, now);
          yield* dispatch(action, firing.eventType, firing.vars);
          actions.push(action);
        }
        return actions;
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
        const rendered = renderRule(rule, event, extra);
        const action: FiredAction = {
          id: nextId(now),
          ruleId: rule.id,
          ruleName: rule.name,
          timestamp: now,
          ...(user ? { user } : {}),
          test: true,
          steps: [...rendered.steps],
        };
        yield* dispatch(action, event.type, rendered.vars);
        return Option.some(action);
      });

    return RuleEngine.of({ fire, test });
  }),
);
