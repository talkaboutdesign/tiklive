/**
 * Pure matching for action rules: given the rules, one streamer's counters and
 * one event, decide which rules fire and with which steps. No Effect and no
 * clock (the caller passes `now`). RuleEngine.ts adds state, ids and time.
 */
import {
  type ChatAudience,
  type ChatTrigger,
  type JoinTrigger,
  type LiveEvent,
  type LiveUser,
  type Rule,
  type RuleStep,
  type RuleTrigger,
  TEMPLATE_VARIABLES,
  type TemplateVariable,
} from "@tiklive/contracts";

/** Per-streamer counters that rules need across events. Mutated by `evaluate`. */
export interface EngineState {
  /** ruleId → unix ms of the last firing. */
  readonly lastFired: Map<string, number>;
  /** `${ruleId}\u0000${userId}` → unix ms of the viewer's last firing. */
  readonly lastFiredByUser: Map<string, number>;
  /** Likes counted since the engine saw this streamer, or the last streamEnd. */
  likeTotal: number;
  /** `${ruleId}:${every}` → milestones already fired. */
  readonly likeMilestones: Map<string, number>;
  /** `${ruleId}\u0000${userId}` for each join rule with oncePerStream that fired for this viewer. Cleared on streamEnd. */
  readonly joinsThisStream: Set<string>;
}

export const emptyState = (): EngineState => ({
  lastFired: new Map(),
  lastFiredByUser: new Map(),
  likeTotal: 0,
  likeMilestones: new Map(),
  joinsThisStream: new Set(),
});

/** Every template variable with its value for this event ("" when it doesn't apply). */
export type TemplateValues = Record<TemplateVariable, string>;

export interface Firing {
  readonly rule: Rule;
  readonly user?: LiveUser;
  /** Steps with templates filled in. */
  readonly steps: ReadonlyArray<RuleStep>;
  /** The event's type (`like` for likes milestones). Goes in webhook payloads. */
  readonly eventType: LiveEvent["type"];
  /** The template values the steps were rendered with. Goes in webhook payloads. */
  readonly vars: TemplateValues;
}

export type Vars = Partial<Record<TemplateVariable, string>>;

const MAX_TEXT = 300;
const MAX_PER_GIFT = 10;
const MAX_MILESTONES = 3;

const TEST_USER: LiveUser = {
  userId: "0",
  uniqueId: "test_user",
  nickname: "Test User",
  profilePictureUrl: "",
};

/** The viewer behind an event, if the event has one. */
export const userOf = (event: LiveEvent): LiveUser | undefined => ("user" in event ? event.user : undefined);

const isTemplateVariable = (name: string): name is TemplateVariable =>
  (TEMPLATE_VARIABLES as ReadonlyArray<string>).includes(name);

const truncate = (text: string): string => {
  if (text.length <= MAX_TEXT) return text;
  const cut = text.slice(0, MAX_TEXT);
  // Don't leave half of a surrogate pair at the end.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/**
 * Replaces `{name}` for known variables present in `vars`, passing each value through `encode`.
 * Anything else stays as typed.
 */
const fill = (text: string, vars: Vars, encode: (value: string) => string = (value) => value): string =>
  text.replace(/\{(\w+)\}/g, (placeholder: string, name: string) => {
    if (!isTemplateVariable(name)) return placeholder;
    const value = vars[name];
    return value === undefined ? placeholder : encode(value);
  });

/**
 * Fills a webhook body. A JSON template gets its values escaped for where they land, so a viewer's
 * text can't close a string and add keys: inside a string it's JSON-escaped, and a bare placeholder
 * becomes a number or a quoted string. Text templates are filled as typed.
 */
const fillBody = (template: string, vars: Vars): string => {
  const probe = template.replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    isTemplateVariable(name) ? "0" : placeholder,
  );
  try {
    JSON.parse(probe);
  } catch {
    return fill(template, vars);
  }
  let inString = false;
  return template.replace(/\\[\s\S]|"|\{(\w+)\}/g, (token: string, name: string | undefined) => {
    if (token === '"') {
      inString = !inString;
      return token;
    }
    const value = name !== undefined && isTemplateVariable(name) ? vars[name] : undefined;
    if (value === undefined) return token;
    if (inString) return JSON.stringify(value).slice(1, -1);
    return /^-?\d+(\.\d+)?$/.test(value) ? value : JSON.stringify(value);
  });
};

export const renderTemplate = (text: string, vars: Vars): string => truncate(fill(text, vars));

/** Every template variable the event provides. Ones that don't apply are "". */
export const templateVars = (event: LiveEvent, extra: Vars = {}): TemplateValues => {
  const user = userOf(event);
  const vars: TemplateValues = {
    nickname: user ? user.nickname || user.uniqueId : "",
    username: user?.uniqueId ?? "",
    giftName: "",
    count: "",
    coins: "",
    comment: "",
    likes: "",
    months: "",
    followers: "",
    // Filled in by the caller (SessionManager), which knows the viewer's points.
    points: "",
  };
  if (event.type === "gift") {
    vars.giftName = event.giftName;
    vars.count = String(event.repeatCount);
    vars.coins = String(event.totalDiamonds);
  } else if (event.type === "chat") {
    vars.comment = event.comment;
  } else if (event.type === "subscribe") {
    vars.months = String(event.subMonth);
  }
  if (user && user.followerCount !== undefined) vars.followers = String(user.followerCount);
  return { ...vars, ...extra };
};

const renderStep = (step: RuleStep, vars: Vars): RuleStep | undefined => {
  switch (step.kind) {
    case "speak": {
      const text = renderTemplate(step.text, vars);
      return text.trim() ? { ...step, text } : undefined;
    }
    case "media":
      return step.text === undefined ? step : { ...step, text: renderTemplate(step.text, vars) };
    case "webhook":
      // Values go into the URL percent-encoded, so they can't add a path segment, query or fragment.
      return {
        ...step,
        url: fill(step.url, vars, encodeURIComponent),
        ...(step.body === undefined ? {} : { body: fillBody(step.body, vars) }),
      };
    default:
      return step;
  }
};

/**
 * The rule's steps with templates filled in for this event, and the template values they
 * were filled with. Blank speak steps are dropped. `extra` overrides the event's own
 * variables (likes milestones need this).
 */
export const renderRule = (
  rule: Rule,
  event: LiveEvent,
  extra: Vars = {},
): { readonly steps: ReadonlyArray<RuleStep>; readonly vars: TemplateValues } => {
  const vars = templateVars(event, extra);
  const steps = rule.steps.flatMap((step) => {
    const rendered = renderStep(step, vars);
    return rendered ? [rendered] : [];
  });
  return { steps, vars };
};

/** The rule's steps with templates filled in for this event. See `renderRule`. */
export const renderSteps = (rule: Rule, event: LiveEvent, extra: Vars = {}): ReadonlyArray<RuleStep> =>
  renderRule(rule, event, extra).steps;

/** Follows the streamer. Friends (mutual follows) count too. */
const followsStreamer = (user: LiveUser): boolean =>
  user.isFollower === true || user.followStatus === "follower" || user.followStatus === "friend";

const AUDIENCE: Record<ChatAudience, (user: LiveUser) => boolean> = {
  everyone: () => true,
  followers: followsStreamer,
  friends: (user) => user.followStatus === "friend",
  subscribers: (user) => user.isSubscriber === true,
  moderators: (user) => user.isModerator === true,
};

/** The `from` and `minFollowers` checks shared by chat and join triggers. */
const allowedTo = (
  trigger: { readonly from?: ChatAudience; readonly minFollowers?: number },
  user: LiveUser,
): boolean => {
  if (!AUDIENCE[trigger.from ?? "everyone"](user)) return false;
  const minimum = trigger.minFollowers ?? 0;
  if (minimum <= 0 || followsStreamer(user) || user.followerCount === undefined) return true;
  return user.followerCount >= minimum;
};

const commentMatches = (trigger: ChatTrigger, comment: string): boolean => {
  if (trigger.match === "any") return true;
  const text = trigger.text?.trim().toLowerCase() ?? "";
  if (!text) return false;
  if (trigger.match === "command") {
    return (comment.trim().split(/\s+/)[0] ?? "").toLowerCase() === text;
  }
  return comment.toLowerCase().includes(text);
};

/** Whether a non-likes trigger matches the event (before cooldowns). */
const matches = (trigger: RuleTrigger, event: LiveEvent): boolean => {
  switch (trigger.type) {
    case "gift":
      return (
        event.type === "gift" &&
        !event.streaking &&
        (trigger.giftId === undefined || trigger.giftId === event.giftId) &&
        event.totalDiamonds >= (trigger.minCoins ?? 0)
      );
    case "follow":
    case "share":
    case "subscribe":
      return event.type === trigger.type;
    case "chat":
      return (
        event.type === "chat" && allowedTo(trigger, event.user) && commentMatches(trigger, event.comment)
      );
    case "join":
      return event.type === "join" && allowedTo(trigger, event.user);
    case "likes":
      return false;
  }
};

const userKey = (ruleId: string, userId: string) => `${ruleId}\u0000${userId}`;

/** Join rules with oncePerStream (the default) skip viewers who already triggered them this stream. */
const joinedAlready = (
  rule: Rule,
  trigger: RuleTrigger,
  user: LiveUser | undefined,
  state: EngineState,
): boolean =>
  trigger.type === "join" && trigger.oncePerStream !== false && user !== undefined
    ? state.joinsThisStream.has(userKey(rule.id, user.userId))
    : false;

/** True when the rule or this viewer is still cooling down. Boundary: exactly at the limit is free. */
const coolingDown = (rule: Rule, user: LiveUser | undefined, state: EngineState, now: number): boolean => {
  const cooldown = rule.cooldown ?? 0;
  if (cooldown > 0) {
    const last = state.lastFired.get(rule.id);
    if (last !== undefined && now - last < cooldown * 1000) return true;
  }
  const userCooldown = rule.userCooldown ?? 0;
  if (user && userCooldown > 0) {
    const last = state.lastFiredByUser.get(userKey(rule.id, user.userId));
    if (last !== undefined && now - last < userCooldown * 1000) return true;
  }
  return false;
};

const recordFired = (rule: Rule, user: LiveUser | undefined, state: EngineState, now: number): void => {
  state.lastFired.set(rule.id, now);
  if (user) state.lastFiredByUser.set(userKey(rule.id, user.userId), now);
};

const firing = (
  rule: Rule,
  user: LiveUser | undefined,
  event: LiveEvent,
  rendered: ReturnType<typeof renderRule>,
): Firing => ({
  rule,
  ...(user ? { user } : {}),
  steps: rendered.steps,
  eventType: event.type,
  vars: rendered.vars,
});

/** Likes rules: one check per like event, firing for each newly reached milestone (capped). */
const likeFirings = (
  rule: Rule,
  every: number,
  event: Extract<LiveEvent, { type: "like" }>,
  state: EngineState,
  now: number,
  extra: Vars,
): Array<Firing> => {
  const key = `${rule.id}:${every}`;
  const reached = Math.floor(state.likeTotal / every);
  const prev = state.likeMilestones.get(key) ?? 0;
  if (reached <= prev) return [];
  // Advance even when cooling down, so missed milestones don't pile up later.
  state.likeMilestones.set(key, reached);
  if (coolingDown(rule, event.user, state, now)) return [];
  const rendered = renderRule(rule, event, { ...extra, likes: String(reached * every) });
  if (rendered.steps.length === 0) return [];
  recordFired(rule, event.user, state, now);
  const count = Math.min(reached - prev, MAX_MILESTONES);
  return Array.from({ length: count }, () => firing(rule, event.user, event, rendered));
};

/** The rules that fire for this event, in rule order. Updates `state` (likes, cooldowns). */
export const evaluate = (
  rules: ReadonlyArray<Rule>,
  state: EngineState,
  event: LiveEvent,
  now: number,
  /** Values the event doesn't carry, such as the viewer's points. */
  extra: Vars = {},
): ReadonlyArray<Firing> => {
  if (event.type === "streamEnd") {
    state.likeTotal = 0;
    state.likeMilestones.clear();
    state.joinsThisStream.clear();
    return [];
  }
  if (event.type === "like") state.likeTotal += event.likeCount;

  const firings: Array<Firing> = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.steps.length === 0) continue;
    const trigger = rule.trigger;

    if (trigger.type === "likes") {
      if (event.type === "like") firings.push(...likeFirings(rule, trigger.every, event, state, now, extra));
      continue;
    }

    if (!matches(trigger, event)) continue;
    const user = userOf(event);
    if (joinedAlready(rule, trigger, user, state)) continue;
    if (coolingDown(rule, user, state, now)) continue;
    const rendered = renderRule(rule, event, extra);
    if (rendered.steps.length === 0) continue;

    // perGift: one firing per gift in the combo (at most 10), with the cooldown checked once.
    const copies =
      trigger.type === "gift" && trigger.perGift && event.type === "gift"
        ? Math.min(Math.max(event.repeatCount, 1), MAX_PER_GIFT)
        : 1;
    recordFired(rule, user, state, now);
    if (trigger.type === "join" && trigger.oncePerStream !== false && user) {
      state.joinsThisStream.add(userKey(rule.id, user.userId));
    }
    for (let i = 0; i < copies; i++) firings.push(firing(rule, user, event, rendered));
  }
  return firings;
};

/** A test viewer who passes the trigger's audience check. */
const sampleViewer = (trigger: ChatTrigger | JoinTrigger): LiveUser => {
  switch (trigger.from) {
    case "followers":
      return { ...TEST_USER, isFollower: true, followStatus: "follower" };
    case "friends":
      return { ...TEST_USER, isFollower: true, followStatus: "friend" };
    case "subscribers":
      return { ...TEST_USER, isSubscriber: true };
    case "moderators":
      return { ...TEST_USER, isModerator: true };
    default:
      return TEST_USER;
  }
};

/**
 * A made-up event that matches the trigger, for the editor's Test button. It decodes
 * as a `LiveEvent`. Viewer flags are set so the sample passes a chat audience check.
 */
export const sampleEvent = (trigger: RuleTrigger, now: number): LiveEvent => {
  const base = { timestamp: now, msgId: `test-${now}` };
  switch (trigger.type) {
    case "gift":
      return {
        type: "gift",
        ...base,
        user: TEST_USER,
        giftId: trigger.giftId ?? 5655,
        giftName: trigger.giftName || "Rose",
        giftImageUrl: "",
        diamondCount: 1,
        repeatCount: 1,
        totalDiamonds: Math.max(1, trigger.minCoins ?? 0),
        streaking: false,
        groupId: "0",
      };
    case "follow":
      return { type: "follow", ...base, user: TEST_USER };
    case "share":
      return { type: "share", ...base, user: TEST_USER };
    case "subscribe":
      return { type: "subscribe", ...base, user: TEST_USER, subMonth: 1 };
    case "chat":
      return {
        type: "chat",
        ...base,
        user: sampleViewer(trigger),
        comment: trigger.text?.trim() ? trigger.text : "Hello!",
        emotes: [],
      };
    case "join":
      return { type: "join", ...base, user: sampleViewer(trigger) };
    case "likes":
      return {
        type: "like",
        ...base,
        user: TEST_USER,
        likeCount: trigger.every,
        totalLikeCount: trigger.every,
      };
  }
};
