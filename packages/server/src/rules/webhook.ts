/**
 * Builds the HTTP request for a webhook step. Pure, so RuleEngine.ts can send it and tests can
 * check the exact request. Webhooks run on the server, not in the browser player: a page can't
 * make cross-origin requests to LAN addresses (CSP and CORS).
 */
import type { FiredAction, LiveEvent, TemplateVariable, WebhookStep } from "@tiklive/contracts";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { TemplateValues } from "./evaluate.ts";

/** Each request gives up after this long. */
export const WEBHOOK_TIMEOUT = "5 seconds";
/** At most this many webhook requests run at once, across all rules and streamers. */
export const WEBHOOK_CONCURRENCY = 4;

/** The JSON sent by a POST or PUT webhook step that has no `body`. */
export interface WebhookPayload {
  readonly rule: { readonly id: string; readonly name: string };
  /** The event type, `like` for likes milestones. */
  readonly event: LiveEvent["type"];
  readonly user: { readonly userId: string; readonly uniqueId: string; readonly nickname: string } | null;
  /** Every template variable, as the steps saw it. Empty strings for ones that don't apply. */
  readonly vars: Readonly<Record<TemplateVariable, string>>;
  /** Unix ms when the rule fired. */
  readonly timestamp: number;
}

export const webhookPayload = (
  action: FiredAction,
  eventType: LiveEvent["type"],
  vars: TemplateValues,
): WebhookPayload => ({
  rule: { id: action.ruleId, name: action.ruleName },
  event: eventType,
  user: action.user
    ? { userId: action.user.userId, uniqueId: action.user.uniqueId, nickname: action.user.nickname }
    : null,
  vars,
  timestamp: action.timestamp,
});

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** The request for a rendered webhook step. GET never has a body. */
export const webhookRequest = (
  step: WebhookStep,
  payload: WebhookPayload,
): HttpClientRequest.HttpClientRequest => {
  const method = step.method ?? "POST";
  if (method === "GET") return HttpClientRequest.get(step.url);
  const request = method === "PUT" ? HttpClientRequest.put(step.url) : HttpClientRequest.post(step.url);
  if (step.body === undefined) return HttpClientRequest.bodyJsonUnsafe(request, payload);
  return HttpClientRequest.bodyText(
    request,
    step.body,
    isJson(step.body) ? "application/json" : "text/plain",
  );
};

/** `origin/path` of a webhook URL, without the query. Query strings often hold tokens, so logs leave them out. */
export const redactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(invalid URL)";
  }
};
