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
  pruneState,
  sampleEvent,
  type TemplateValues,
  userOf,
  type Vars,
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
    /** `extra` fills placeholders the event doesn't carry, such as `points`. */
    readonly fire: (
      username: string,
      event: LiveEvent,
      extra?: Vars,
      /** Room identity keeps per-stream state correct across session eviction. */
      roomId?: string,
    ) => Effect.Effect<ReadonlyArray<FiredAction>>;
    /**
     * Fires one rule with a made-up event that matches its trigger, ignoring `enabled`
     * and cooldowns, for the editor's Test button. None if no rule has this id.
     */
    readonly test: (username: string, ruleId: string) => Effect.Effect<Option.Option<FiredAction>>;
  }
>()("@tiklive/server/RuleEngine") {}

// The kind of failure only. HTTP client error messages can include the full URL, and webhook
// query strings often hold tokens.
const describeError = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) return "unknown error";
  const reason = "reason" in cause && typeof cause.reason === "string" ? ` (${cause.reason})` : "";
  return `${String(cause._tag)}${reason}`;
};

/** Webhook requests waiting for a slot. Beyond this, new ones are dropped, so a stuck receiver can't pile them up. */
const WEBHOOK_MAX_PENDING = 100;

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
    // Started but not finished (waiting or sending). Changed only inside Effect.sync.
    let pending = 0;
    // Mutated only inside Effect.try/sync blocks, which run without yielding.
    const states = new Map<string, { state: EngineState; roomId: string | undefined }>();
    let counter = 0;

    const stateFor = (username: string, roomId?: string): EngineState => {
      let entry = states.get(username);
      if (!entry) {
        entry = { state: emptyState(), roomId };
        states.set(username, entry);
      } else if (roomId !== undefined && entry.roomId !== roomId) {
        evaluate([], entry.state, { type: "streamEnd", reason: "ended", timestamp: 0 }, 0);
        entry.roomId = roomId;
      }
      return entry.state;
    };

    yield* Effect.gen(function* () {
      const { rules } = yield* store.get;
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => {
        for (const { state } of states.values()) pruneState(rules, state, now);
      });
    }).pipe(Effect.delay("1 minute"), Effect.forever, Effect.forkScoped);

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
          if (pending >= WEBHOOK_MAX_PENDING) {
            yield* Effect.logWarning(
              `Webhook ${redactUrl(step.url)} dropped: ${WEBHOOK_MAX_PENDING} requests are already waiting`,
            );
            continue;
          }
          pending += 1;
          const done = Effect.sync(() => {
            pending -= 1;
          });
          yield* Effect.forkIn(
            send(step, webhookPayload(action, eventType, vars)).pipe(Effect.ensuring(done)),
            scope,
          );
        }
      });

    const fire = (
      username: string,
      event: LiveEvent,
      extra: Vars = {},
      roomId?: string,
    ): Effect.Effect<ReadonlyArray<FiredAction>> =>
      Effect.gen(function* () {
        const { rules } = yield* store.get;
        const now = yield* Clock.currentTimeMillis;
        const firings = yield* Effect.try({
          try: () => evaluate(rules, stateFor(username, roomId), event, now, extra),
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
        // The sample viewer has a sample points total, so "{points}" reads naturally in a test.
        const extra = {
          points: "100",
          ...(rule.trigger.type === "likes" ? { likes: String(rule.trigger.every) } : {}),
        };
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
