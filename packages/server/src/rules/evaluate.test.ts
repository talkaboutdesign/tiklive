/**
 * Matching rules for action triggers. Pure functions, so no Effect and no clock:
 * `now` is passed in explicitly.
 */
import { describe, expect, it } from "@effect/vitest";
import { LiveEvent, type LiveUser, type Rule, type RuleStep, type RuleTrigger } from "@tiklive/contracts";
import * as Schema from "effect/Schema";
import { bodyMode, emptyState, evaluate, renderTemplate, sampleEvent, type Vars } from "./evaluate.ts";

const NOW = 1_700_000_000_000;
const USER: LiveUser = { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" };

const say = (text: string): RuleStep => ({ kind: "speak", text });

const rule = (id: string, trigger: RuleTrigger, overrides: Partial<Rule> = {}): Rule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  trigger,
  steps: [say("hi")],
  ...overrides,
});

const gift = (overrides: Partial<Extract<LiveEvent, { type: "gift" }>> = {}): LiveEvent => ({
  type: "gift",
  timestamp: NOW,
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

const chat = (comment: string, user: LiveUser = USER): LiveEvent => ({
  type: "chat",
  timestamp: NOW,
  user,
  comment,
  emotes: [],
});

const like = (likeCount: number, user: LiveUser = USER): LiveEvent => ({
  type: "like",
  timestamp: NOW,
  user,
  likeCount,
  totalLikeCount: likeCount,
});

const plain = (type: "follow" | "share", user: LiveUser = USER): LiveEvent => ({
  type,
  timestamp: NOW,
  user,
});

const texts = (firings: ReturnType<typeof evaluate>) =>
  firings.map((firing) => firing.steps.map((step) => (step.kind === "speak" ? step.text : step.kind)));

describe("evaluate: rule order and skipping", () => {
  it("fires every matching rule, in array order", () => {
    const rules = [
      rule("a", { type: "gift" }, { steps: [say("first")] }),
      rule("b", { type: "follow" }),
      rule("c", { type: "gift" }, { steps: [say("third")] }),
    ];
    const firings = evaluate(rules, emptyState(), gift(), NOW);
    expect(firings.map((f) => f.rule.id)).toEqual(["a", "c"]);
    expect(texts(firings)).toEqual([["first"], ["third"]]);
  });

  it("skips disabled rules and rules without steps", () => {
    const rules = [
      rule("off", { type: "gift" }, { enabled: false }),
      rule("empty", { type: "gift" }, { steps: [] }),
      rule("on", { type: "gift" }),
    ];
    expect(evaluate(rules, emptyState(), gift(), NOW).map((f) => f.rule.id)).toEqual(["on"]);
  });

  it("attaches the viewer to the firing", () => {
    const [firing] = evaluate([rule("g", { type: "gift" })], emptyState(), gift(), NOW);
    expect(firing?.user).toEqual(USER);
  });

  it("does nothing for events without a matching trigger", () => {
    expect(evaluate([rule("g", { type: "gift" })], emptyState(), plain("follow"), NOW)).toEqual([]);
  });
});

describe("evaluate: gift triggers", () => {
  it("ignores gifts that are still streaking", () => {
    const rules = [rule("g", { type: "gift" })];
    expect(evaluate(rules, emptyState(), gift({ streaking: true }), NOW)).toEqual([]);
    expect(evaluate(rules, emptyState(), gift({ streaking: false }), NOW)).toHaveLength(1);
  });

  it("matches only the configured gift id", () => {
    const rules = [rule("g", { type: "gift", giftId: 1 })];
    expect(evaluate(rules, emptyState(), gift({ giftId: 5655 }), NOW)).toEqual([]);
    expect(evaluate(rules, emptyState(), gift({ giftId: 1 }), NOW)).toHaveLength(1);
  });

  it("requires at least minCoins for the whole combo", () => {
    const rules = [rule("g", { type: "gift", minCoins: 10 })];
    expect(evaluate(rules, emptyState(), gift({ totalDiamonds: 9 }), NOW)).toEqual([]);
    expect(evaluate(rules, emptyState(), gift({ totalDiamonds: 10 }), NOW)).toHaveLength(1);
  });

  it("fires once per combo by default", () => {
    const firings = evaluate([rule("g", { type: "gift" })], emptyState(), gift({ repeatCount: 5 }), NOW);
    expect(firings).toHaveLength(1);
  });

  it("fires once per gift with perGift, using the combo's repeat count", () => {
    const firings = evaluate(
      [rule("g", { type: "gift", perGift: true })],
      emptyState(),
      gift({ repeatCount: 3 }),
      NOW,
    );
    expect(firings).toHaveLength(3);
    expect(firings[0]?.steps).toEqual(firings[1]?.steps);
  });

  it("caps perGift at 10 firings and treats a repeat count below 1 as 1", () => {
    const capped = evaluate(
      [rule("g", { type: "gift", perGift: true })],
      emptyState(),
      gift({ repeatCount: 25 }),
      NOW,
    );
    expect(capped).toHaveLength(10);
    const floor = evaluate(
      [rule("g", { type: "gift", perGift: true })],
      emptyState(),
      gift({ repeatCount: 0 }),
      NOW,
    );
    expect(floor).toHaveLength(1);
  });

  it("checks the cooldown once for all perGift copies", () => {
    const rules = [rule("g", { type: "gift", perGift: true }, { cooldown: 10 })];
    const state = emptyState();
    expect(evaluate(rules, state, gift({ repeatCount: 3 }), NOW)).toHaveLength(3);
    expect(evaluate(rules, state, gift({ repeatCount: 3 }), NOW + 1_000)).toHaveLength(0);
  });
});

describe("evaluate: follow, share and subscribe", () => {
  it("matches the same event type", () => {
    expect(evaluate([rule("f", { type: "follow" })], emptyState(), plain("follow"), NOW)).toHaveLength(1);
    expect(evaluate([rule("f", { type: "follow" })], emptyState(), plain("share"), NOW)).toEqual([]);
    expect(evaluate([rule("s", { type: "share" })], emptyState(), plain("share"), NOW)).toHaveLength(1);
  });

  it("matches subscriptions and fills in the month count", () => {
    const sub: LiveEvent = { type: "subscribe", timestamp: NOW, user: USER, subMonth: 3 };
    const firings = evaluate(
      [rule("s", { type: "subscribe" }, { steps: [say("{months} months!")] })],
      emptyState(),
      sub,
      NOW,
    );
    expect(texts(firings)).toEqual([["3 months!"]]);
  });
});

describe("evaluate: chat triggers", () => {
  it("any matches every chat message", () => {
    const rules = [rule("c", { type: "chat", match: "any" })];
    expect(evaluate(rules, emptyState(), chat("anything at all"), NOW)).toHaveLength(1);
    expect(evaluate(rules, emptyState(), plain("follow"), NOW)).toEqual([]);
  });

  it("command matches the first word, ignoring case and surrounding spaces", () => {
    const rules = [rule("c", { type: "chat", match: "command", text: "!dance" })];
    expect(evaluate(rules, emptyState(), chat("!dance now"), NOW)).toHaveLength(1);
    expect(evaluate(rules, emptyState(), chat("  !DANCE  "), NOW)).toHaveLength(1);
    expect(evaluate(rules, emptyState(), chat("please !dance"), NOW)).toEqual([]);
    expect(evaluate(rules, emptyState(), chat("!dancer"), NOW)).toEqual([]);
  });

  it("command ignores spaces around the configured text", () => {
    const rules = [rule("c", { type: "chat", match: "command", text: "  !dance  " })];
    expect(evaluate(rules, emptyState(), chat("!dance"), NOW)).toHaveLength(1);
  });

  it("contains matches anywhere, ignoring case", () => {
    const rules = [rule("c", { type: "chat", match: "contains", text: "GG" })];
    expect(evaluate(rules, emptyState(), chat("good game gg"), NOW)).toHaveLength(1);
    expect(evaluate(rules, emptyState(), chat("GG everyone"), NOW)).toHaveLength(1);
    expect(evaluate(rules, emptyState(), chat("nope"), NOW)).toEqual([]);
  });

  it("a blank or missing text never matches command or contains", () => {
    const comment = chat("  ");
    for (const trigger of [
      { type: "chat", match: "command", text: "" },
      { type: "chat", match: "command", text: "   " },
      { type: "chat", match: "contains", text: "  " },
      { type: "chat", match: "contains" },
      { type: "chat", match: "command" },
    ] satisfies Array<RuleTrigger>) {
      expect(evaluate([rule("c", trigger)], emptyState(), comment, NOW)).toEqual([]);
      expect(evaluate([rule("c", trigger)], emptyState(), chat("", USER), NOW)).toEqual([]);
    }
  });

  it("limits the audience with the from field", () => {
    const plainUser: LiveUser = { ...USER };
    const followers = [rule("c", { type: "chat", match: "any", from: "followers" })];
    const subscribers = [rule("c", { type: "chat", match: "any", from: "subscribers" })];
    const moderators = [rule("c", { type: "chat", match: "any", from: "moderators" })];

    expect(evaluate(followers, emptyState(), chat("hi", plainUser), NOW)).toEqual([]);
    expect(evaluate(followers, emptyState(), chat("hi", { ...USER, isFollower: true }), NOW)).toHaveLength(1);
    expect(evaluate(subscribers, emptyState(), chat("hi", { ...USER, isFollower: true }), NOW)).toEqual([]);
    expect(
      evaluate(subscribers, emptyState(), chat("hi", { ...USER, isSubscriber: true }), NOW),
    ).toHaveLength(1);
    expect(evaluate(moderators, emptyState(), chat("hi", { ...USER, isSubscriber: true }), NOW)).toEqual([]);
    expect(evaluate(moderators, emptyState(), chat("hi", { ...USER, isModerator: true }), NOW)).toHaveLength(
      1,
    );
  });

  it("treats everyone as the default audience", () => {
    const rules = [rule("c", { type: "chat", match: "any", from: "everyone" })];
    expect(evaluate(rules, emptyState(), chat("hi"), NOW)).toHaveLength(1);
  });
});

describe("evaluate: likes triggers", () => {
  const likesRule = (every: number, overrides: Partial<Rule> = {}) =>
    rule("L", { type: "likes", every }, { steps: [say("{likes} likes")], ...overrides });

  it("fires each time the total passes a multiple of every", () => {
    const rules = [likesRule(10)];
    const state = emptyState();
    expect(evaluate(rules, state, like(4), NOW)).toEqual([]);
    expect(texts(evaluate(rules, state, like(6), NOW))).toEqual([["10 likes"]]);
    expect(evaluate(rules, state, like(5), NOW)).toEqual([]);
    expect(texts(evaluate(rules, state, like(10), NOW))).toEqual([["20 likes"]]);
  });

  it("fires for each milestone a single event crosses, capped at 3", () => {
    const rules = [likesRule(10)];
    const state = emptyState();
    expect(texts(evaluate(rules, state, like(35), NOW))).toEqual([["30 likes"], ["30 likes"], ["30 likes"]]);
    // Still at the 30 milestone: nothing more until the next one.
    expect(evaluate(rules, state, like(4), NOW)).toEqual([]);
  });

  it("drops missed milestones beyond the cap instead of firing them later", () => {
    const rules = [likesRule(10)];
    const state = emptyState();
    // 10 milestones crossed at once: 3 firings, and the counter jumps to 10.
    expect(evaluate(rules, state, like(100), NOW)).toHaveLength(3);
    expect(evaluate(rules, state, like(1), NOW)).toEqual([]);
    // 10 -> 19 is nine milestones, but only 3 fire.
    expect(texts(evaluate(rules, state, like(90), NOW))).toEqual([
      ["190 likes"],
      ["190 likes"],
      ["190 likes"],
    ]);
  });

  it("counts likes once per event, however many likes rules there are", () => {
    const rules = [likesRule(10), likesRule(10, { id: "M" })];
    const state = emptyState();
    evaluate(rules, state, like(10), NOW);
    expect(state.likeTotal).toBe(10);
  });

  it("resets the count on streamEnd, so the next stream starts from zero", () => {
    const rules = [likesRule(10)];
    const state = emptyState();
    evaluate(rules, state, like(9), NOW);
    const ended: LiveEvent = { type: "streamEnd", timestamp: NOW, reason: "ended" };
    expect(evaluate(rules, state, ended, NOW)).toEqual([]);
    expect(state.likeTotal).toBe(0);
    expect(evaluate(rules, state, like(1), NOW)).toEqual([]);
    expect(texts(evaluate(rules, state, like(9), NOW))).toEqual([["10 likes"]]);
  });

  it("keeps separate milestones for two rules with different every", () => {
    const rules = [likesRule(5, { id: "five" }), likesRule(10, { id: "ten" })];
    const firings = evaluate(rules, emptyState(), like(10), NOW);
    // Every 5 crosses 5 and 10 at once (two firings); every 10 crosses 10 (one).
    expect(firings.map((f) => f.rule.id)).toEqual(["five", "five", "ten"]);
    expect(texts(firings)).toEqual([["10 likes"], ["10 likes"], ["10 likes"]]);
  });

  it("gives each firing the viewer behind the like", () => {
    const [firing] = evaluate([likesRule(10)], emptyState(), like(10), NOW);
    expect(firing?.user).toEqual(USER);
  });

  it("advances the milestone while cooling down, so the miss does not pile up", () => {
    const rules = [likesRule(10, { cooldown: 60 })];
    const state = emptyState();
    expect(evaluate(rules, state, like(10), NOW)).toHaveLength(1);
    // Milestone 2 is reached during the cooldown: skipped, but counted as reached.
    expect(evaluate(rules, state, like(10), NOW + 1_000)).toEqual([]);
    expect(evaluate(rules, state, like(1), NOW + 2_000)).toEqual([]);
    // After the cooldown only milestone 3 fires, not the skipped 2.
    expect(texts(evaluate(rules, state, like(10), NOW + 60_000))).toEqual([["30 likes"]]);
  });
});

describe("evaluate: cooldowns", () => {
  it("blocks the rule for everyone until cooldown seconds have passed (boundary fires)", () => {
    const rules = [rule("g", { type: "gift" }, { cooldown: 10 })];
    const state = emptyState();
    expect(evaluate(rules, state, gift(), NOW)).toHaveLength(1);
    expect(evaluate(rules, state, gift({ user: { ...USER, userId: "2" } }), NOW + 9_999)).toEqual([]);
    expect(evaluate(rules, state, gift(), NOW + 10_000)).toHaveLength(1);
  });

  it("blocks each viewer for userCooldown seconds, but not other viewers (boundary fires)", () => {
    const rules = [rule("g", { type: "gift" }, { userCooldown: 5 })];
    const state = emptyState();
    const other: LiveUser = { ...USER, userId: "2" };
    expect(evaluate(rules, state, gift(), NOW)).toHaveLength(1);
    expect(evaluate(rules, state, gift({ user: other }), NOW + 1_000)).toHaveLength(1);
    expect(evaluate(rules, state, gift(), NOW + 4_999)).toEqual([]);
    expect(evaluate(rules, state, gift(), NOW + 5_000)).toHaveLength(1);
  });

  it("does not record a cooldown for a rule that rendered no steps", () => {
    const rules = [rule("g", { type: "gift" }, { cooldown: 10, steps: [say("   ")] })];
    const state = emptyState();
    expect(evaluate(rules, state, gift(), NOW)).toEqual([]);
    expect(state.lastFired.has("g")).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("replaces known variables that are present and leaves the rest as typed", () => {
    expect(renderTemplate("{foo} {nickname} {unknown_x}", { nickname: "Ada" })).toBe("{foo} Ada {unknown_x}");
  });

  it("keeps a known variable that is absent from vars", () => {
    expect(renderTemplate("{nickname}", {})).toBe("{nickname}");
  });

  it("renders an empty variable as nothing", () => {
    expect(renderTemplate("[{giftName}]", { giftName: "" })).toBe("[]");
  });

  it("truncates to 300 characters", () => {
    expect(renderTemplate("a".repeat(400), {})).toHaveLength(300);
  });

  it("does not leave half a surrogate pair at the cut", () => {
    const out = renderTemplate(`${"a".repeat(299)}😀`, {});
    expect(out).toBe("a".repeat(299));
  });
});

describe("evaluate: template variables in steps", () => {
  it("fills nickname (falling back to the handle), username and the gift vars", () => {
    const steps = [say("{nickname} / {username} / {count}x {giftName} = {coins}")];
    const firings = evaluate(
      [rule("g", { type: "gift" }, { steps })],
      emptyState(),
      gift({ repeatCount: 3, totalDiamonds: 30 }),
      NOW,
    );
    expect(texts(firings)).toEqual([["Viewer / viewer / 3x Rose = 30"]]);
  });

  it("uses the handle when the nickname is empty", () => {
    const firings = evaluate(
      [rule("f", { type: "follow" }, { steps: [say("hi {nickname}")] })],
      emptyState(),
      plain("follow", { ...USER, nickname: "" }),
      NOW,
    );
    expect(texts(firings)).toEqual([["hi viewer"]]);
  });

  it("renders variables that don't apply to the event as empty", () => {
    const firings = evaluate(
      [rule("f", { type: "follow" }, { steps: [say("Thanks {nickname}, {giftName}!")] })],
      emptyState(),
      plain("follow"),
      NOW,
    );
    expect(texts(firings)).toEqual([["Thanks Viewer, !"]]);
  });

  it("fills comment for chat rules", () => {
    const firings = evaluate(
      [rule("c", { type: "chat", match: "any" }, { steps: [say("{nickname} said: {comment}")] })],
      emptyState(),
      chat("hello"),
      NOW,
    );
    expect(texts(firings)).toEqual([["Viewer said: hello"]]);
  });

  it("renders media captions, and leaves a media step without text alone", () => {
    const firings = evaluate(
      [
        rule(
          "m",
          { type: "follow" },
          {
            steps: [
              { kind: "media", url: "/media/x.png", text: "Welcome {nickname}!" },
              { kind: "media", url: "/media/y.png" },
            ],
          },
        ),
      ],
      emptyState(),
      plain("follow"),
      NOW,
    );
    expect(firings[0]?.steps[0]).toEqual({ kind: "media", url: "/media/x.png", text: "Welcome Viewer!" });
    expect(firings[0]?.steps[1]).toEqual({ kind: "media", url: "/media/y.png" });
    expect(firings[0]?.steps[1]).not.toHaveProperty("text");
  });

  it("drops blank speak steps and keeps the rest", () => {
    const firings = evaluate(
      [rule("g", { type: "gift" }, { steps: [say("   "), say("ok")] })],
      emptyState(),
      gift(),
      NOW,
    );
    expect(firings[0]?.steps).toEqual([say("ok")]);
  });

  it("does not fire a rule whose steps are all blank", () => {
    const firings = evaluate([rule("g", { type: "gift" }, { steps: [say(" ")] })], emptyState(), gift(), NOW);
    expect(firings).toEqual([]);
  });
});

describe("sampleEvent", () => {
  const triggers: Array<RuleTrigger> = [
    { type: "gift" },
    { type: "gift", giftId: 1, giftName: "Heart", minCoins: 50, perGift: true },
    { type: "follow" },
    { type: "share" },
    { type: "subscribe" },
    { type: "chat", match: "any" },
    { type: "chat", match: "command", text: "!dance", from: "subscribers" },
    { type: "chat", match: "contains", text: "gg", from: "moderators" },
    { type: "chat", match: "any", from: "friends", minFollowers: 100 },
    { type: "join" },
    { type: "join", from: "friends", minFollowers: 50, oncePerStream: false },
    { type: "likes", every: 50 },
  ];

  it.each(triggers.map((trigger) => [trigger.type, trigger] as const))(
    "decodes as a LiveEvent for %s triggers",
    (_, trigger) => {
      expect(() => Schema.decodeUnknownSync(LiveEvent)(sampleEvent(trigger, NOW))).not.toThrow();
    },
  );

  it.each(triggers.map((trigger) => [trigger.type, trigger] as const))(
    "matches its own %s trigger",
    (_, trigger) => {
      const firings = evaluate([rule("s", trigger)], emptyState(), sampleEvent(trigger, NOW), NOW);
      expect(firings).toHaveLength(1);
    },
  );

  it("uses the trigger's gift settings, with Rose as the default", () => {
    const event = sampleEvent({ type: "gift" }, NOW);
    expect(event).toMatchObject({
      type: "gift",
      giftId: 5655,
      giftName: "Rose",
      totalDiamonds: 1,
      streaking: false,
    });
    const heart = sampleEvent({ type: "gift", giftId: 1, giftName: "Heart", minCoins: 50 }, NOW);
    expect(heart).toMatchObject({ giftId: 1, giftName: "Heart", totalDiamonds: 50 });
  });

  it("uses the trigger's text as the chat message, or a greeting", () => {
    expect(sampleEvent({ type: "chat", match: "command", text: "!dance" }, NOW)).toMatchObject({
      comment: "!dance",
    });
    expect(sampleEvent({ type: "chat", match: "any" }, NOW)).toMatchObject({ comment: "Hello!" });
  });

  it("uses the trigger's count for likes", () => {
    expect(sampleEvent({ type: "likes", every: 50 }, NOW)).toMatchObject({
      likeCount: 50,
      totalLikeCount: 50,
    });
  });

  it("makes a join event for join triggers, and a friend for friends-only ones", () => {
    expect(sampleEvent({ type: "join" }, NOW)).toMatchObject({
      type: "join",
      user: { uniqueId: "test_user" },
    });
    expect(sampleEvent({ type: "join", from: "friends" }, NOW)).toMatchObject({
      type: "join",
      user: { followStatus: "friend" },
    });
  });
});

const follows = (followStatus: LiveUser["followStatus"], extra: Partial<LiveUser> = {}): LiveUser => ({
  ...USER,
  ...(followStatus ? { followStatus } : {}),
  ...extra,
});

describe("evaluate: follower and friend audiences", () => {
  const from = (audience: "followers" | "friends", user: LiveUser) =>
    evaluate([rule("c", { type: "chat", match: "any", from: audience })], emptyState(), chat("hi", user), NOW)
      .length;

  it("followers accepts isFollower, followStatus follower and friend", () => {
    expect(from("followers", follows("none"))).toBe(0);
    expect(from("followers", follows("follower"))).toBe(1);
    expect(from("followers", follows("friend"))).toBe(1);
    expect(from("followers", { ...USER, isFollower: true })).toBe(1);
  });

  it("friends accepts only followStatus friend", () => {
    expect(from("friends", follows("follower"))).toBe(0);
    expect(from("friends", { ...USER, isFollower: true })).toBe(0);
    expect(from("friends", follows("friend"))).toBe(1);
  });

  it("applies the friends audience to join triggers too", () => {
    const rules = [rule("j", { type: "join", from: "friends" })];
    const join = (user: LiveUser): LiveEvent => ({ type: "join", timestamp: NOW, user });
    expect(evaluate(rules, emptyState(), join(follows("follower")), NOW)).toEqual([]);
    expect(evaluate(rules, emptyState(), join(follows("friend")), NOW)).toHaveLength(1);
  });
});

describe("evaluate: minFollowers", () => {
  const fires = (user: LiveUser) =>
    evaluate(
      [rule("c", { type: "chat", match: "any", minFollowers: 50 })],
      emptyState(),
      chat("hi", user),
      NOW,
    ).length;

  it("requires at least minFollowers followers on the viewer", () => {
    expect(fires({ ...USER, followerCount: 49 })).toBe(0);
    expect(fires({ ...USER, followerCount: 50 })).toBe(1);
    expect(fires({ ...USER, followerCount: 5000 })).toBe(1);
  });

  it("lets followers and friends of the streamer through, whatever their count", () => {
    expect(fires(follows("follower", { followerCount: 3 }))).toBe(1);
    expect(fires(follows("friend", { followerCount: 0 }))).toBe(1);
    expect(fires({ ...USER, isFollower: true, followerCount: 0 })).toBe(1);
  });

  it("lets a viewer through when TikTok didn't send their follower count", () => {
    expect(fires(USER)).toBe(1);
  });

  it("applies to join triggers", () => {
    const rules = [rule("j", { type: "join", minFollowers: 10 })];
    const join = (user: LiveUser): LiveEvent => ({ type: "join", timestamp: NOW, user });
    expect(evaluate(rules, emptyState(), join({ ...USER, followerCount: 9 }), NOW)).toEqual([]);
    expect(evaluate(rules, emptyState(), join({ ...USER, followerCount: 10 }), NOW)).toHaveLength(1);
    expect(evaluate(rules, emptyState(), join(USER), NOW)).toHaveLength(1);
  });

  it("with minFollowers 0 or omitted, every viewer passes", () => {
    const zero = [rule("c", { type: "chat", match: "any", minFollowers: 0 })];
    expect(evaluate(zero, emptyState(), chat("hi", { ...USER, followerCount: 0 }), NOW)).toHaveLength(1);
  });
});

describe("evaluate: join triggers", () => {
  const join = (user: LiveUser = USER): LiveEvent => ({ type: "join", timestamp: NOW, user });
  const welcome = (trigger: Partial<Extract<RuleTrigger, { type: "join" }>> = {}) =>
    rule("j", { type: "join", ...trigger }, { steps: [say("Welcome {nickname}")] });

  it("fires once per viewer per stream by default", () => {
    const state = emptyState();
    const rules = [welcome()];
    expect(texts(evaluate(rules, state, join(), NOW))).toEqual([["Welcome Viewer"]]);
    expect(evaluate(rules, state, join(), NOW + 1000)).toEqual([]);
    expect(texts(evaluate(rules, state, join({ ...USER, userId: "2" }), NOW + 2000))).toEqual([
      ["Welcome Viewer"],
    ]);
  });

  it("fires again for the same viewer after streamEnd", () => {
    const state = emptyState();
    const rules = [welcome({ oncePerStream: true })];
    expect(evaluate(rules, state, join(), NOW)).toHaveLength(1);
    const ended: LiveEvent = { type: "streamEnd", timestamp: NOW, reason: "ended" };
    expect(evaluate(rules, state, ended, NOW)).toEqual([]);
    expect(evaluate(rules, state, join(), NOW)).toHaveLength(1);
  });

  it("fires every time with oncePerStream false", () => {
    const state = emptyState();
    const rules = [welcome({ oncePerStream: false })];
    expect(evaluate(rules, state, join(), NOW)).toHaveLength(1);
    expect(evaluate(rules, state, join(), NOW + 1000)).toHaveLength(1);
  });

  it("tracks each join rule separately, so two rules both greet the same viewer", () => {
    const state = emptyState();
    const rules = [welcome(), { ...welcome(), id: "j2" }];
    expect(evaluate(rules, state, join(), NOW).map((f) => f.rule.id)).toEqual(["j", "j2"]);
    expect(evaluate(rules, state, join(), NOW)).toEqual([]);
  });

  it("does not use up the once-per-stream slot when the viewer doesn't match the audience", () => {
    const state = emptyState();
    const rules = [welcome({ from: "friends" })];
    expect(evaluate(rules, state, join(follows("follower")), NOW)).toEqual([]);
    expect(evaluate(rules, state, join(follows("friend")), NOW)).toHaveLength(1);
  });

  it("does not fire on chat, follow or other events", () => {
    expect(evaluate([welcome()], emptyState(), chat("hi"), NOW)).toEqual([]);
    expect(evaluate([welcome()], emptyState(), plain("follow"), NOW)).toEqual([]);
  });

  it("respects the rule's cooldowns", () => {
    const state = emptyState();
    const limited = [{ ...welcome({ oncePerStream: false }), cooldown: 10 }];
    expect(evaluate(limited, state, join(), NOW)).toHaveLength(1);
    expect(evaluate(limited, state, join({ ...USER, userId: "2" }), NOW + 1000)).toEqual([]);
  });
});

describe("evaluate: {followers} template variable", () => {
  it("fills in the viewer's follower count as a plain number", () => {
    const firings = evaluate(
      [rule("c", { type: "chat", match: "any" }, { steps: [say("{nickname} has {followers} followers")] })],
      emptyState(),
      chat("hi", { ...USER, followerCount: 12_345 }),
      NOW,
    );
    expect(texts(firings)).toEqual([["Viewer has 12345 followers"]]);
  });

  it("renders as empty when the count is unknown", () => {
    const firings = evaluate(
      [rule("c", { type: "chat", match: "any" }, { steps: [say("{followers}|")] })],
      emptyState(),
      chat("hi"),
      NOW,
    );
    expect(texts(firings)).toEqual([["|"]]);
  });
});

describe("evaluate: {points} and other values from the caller", () => {
  it("fills {points} from the values passed in", () => {
    const firings = evaluate(
      [
        rule(
          "c",
          { type: "chat", match: "command", text: "!points" },
          { steps: [say("{nickname}: {points}")] },
        ),
      ],
      emptyState(),
      chat("!points"),
      NOW,
      { points: "1240" },
    );
    expect(texts(firings)).toEqual([["Viewer: 1240"]]);
  });

  it("renders {points} as empty when the caller doesn't know them", () => {
    const firings = evaluate(
      [rule("c", { type: "chat", match: "any" }, { steps: [say("{points}|")] })],
      emptyState(),
      chat("hi"),
      NOW,
    );
    expect(texts(firings)).toEqual([["|"]]);
  });

  it("passes them to like milestones too, alongside {likes}", () => {
    const firings = evaluate(
      [rule("l", { type: "likes", every: 10 }, { steps: [say("{likes} likes, {points} points")] })],
      emptyState(),
      like(10),
      NOW,
      { points: "7" },
    );
    expect(texts(firings)).toEqual([["10 likes, 7 points"]]);
  });
});

describe("bodyMode: decided by the template, not by the filled text", () => {
  it.each([
    ['{"viewer":"{nickname}"}', "json"],
    ['{"count":{count}}', "json"],
    ["[{count}]", "json"],
    ['{"count":{count},"action":"safe","said":"{comment}"}', "json"],
    ['{"count":0{count}}', "text"],
    ["[Alert] {comment}", "text"],
    ['"{comment}" said hi', "text"],
    ['"{comment}"', "text"],
    ["{nickname} sent a gift", "text"],
    ["{wave} {nickname} waved", "text"],
    ["{comment}", "text"],
    ['{nickname},"action":"safe","said":"{comment}"}', "text"],
    ['{"count":0{count},"action":"safe","said":"{comment}"}', "text"],
    // With no known placeholder, a body is JSON when it parses, as it always was.
    ["123", "json"],
    ["true", "json"],
    ['{"a":1}', "json"],
    ["hello", "text"],
    ["", "text"],
  ])("%s is sent as %s", (template, mode) => {
    expect(bodyMode(template)).toBe(mode);
  });
});

describe("evaluate: webhook steps", () => {
  const hook = (url: string, body?: string): RuleStep => ({
    kind: "webhook",
    url,
    ...(body === undefined ? {} : { body }),
  });

  it("URL-encodes values substituted into the url, so they can't add a path, query or fragment", () => {
    const sneaky = gift({ user: { ...USER, nickname: "Ann & Bo/x?#" } });
    const firings = evaluate(
      [
        rule(
          "w",
          { type: "gift" },
          { steps: [hook("https://h.example/{username}?n={nickname}&g={giftName}")] },
        ),
      ],
      emptyState(),
      sneaky,
      NOW,
    );
    expect(firings[0]?.steps).toEqual([
      { kind: "webhook", url: "https://h.example/viewer?n=Ann%20%26%20Bo%2Fx%3F%23&g=Rose" },
    ]);
  });

  it("fills the body with the same variables, without encoding them or cutting it at 300 characters", () => {
    const firings = evaluate(
      [
        rule(
          "w",
          { type: "chat", match: "any" },
          { steps: [hook("https://h.example/", '{"said":"{comment}"}')] },
        ),
      ],
      emptyState(),
      chat("a & b"),
      NOW,
    );
    expect(firings[0]?.steps).toEqual([
      { kind: "webhook", url: "https://h.example/", body: '{"said":"a & b"}' },
    ]);

    const padded = "x".repeat(350);
    const kept = evaluate(
      [rule("w", { type: "gift" }, { steps: [hook("https://h.example/", padded)] })],
      emptyState(),
      gift(),
      NOW,
    );
    expect(kept[0]?.steps).toEqual([{ kind: "webhook", url: "https://h.example/", body: padded }]);
  });

  const bodyOf = (firing: ReturnType<typeof evaluate>[number] | undefined): string | undefined => {
    const step = firing?.steps[0];
    return step?.kind === "webhook" ? step.body : undefined;
  };

  it("escapes values inside quotes in a JSON body, so a viewer's text can't add keys", () => {
    const hostile = 'x", "evil": "1\\ \n';
    const firings = evaluate(
      [
        rule(
          "w",
          { type: "chat", match: "any" },
          { steps: [hook("https://h.example/", '{"said": "{comment}", "by": "{nickname}"}')] },
        ),
      ],
      emptyState(),
      chat(hostile, { ...USER, nickname: hostile }),
      NOW,
    );
    expect(JSON.parse(bodyOf(firings[0]) ?? "")).toEqual({ said: hostile, by: hostile });
  });

  it("keeps escaped quotes in the template working, so the value stays inside its string", () => {
    const firings = evaluate(
      [
        rule(
          "w",
          { type: "chat", match: "any" },
          { steps: [hook("https://h.example/", '{"q": "say \\"{comment}\\""}')] },
        ),
      ],
      emptyState(),
      chat('x", "evil": "1'),
      NOW,
    );
    expect(JSON.parse(bodyOf(firings[0]) ?? "")).toEqual({ q: 'say "x", "evil": "1"' });
  });

  it("puts a bare placeholder in as a number when it is one, and as a quoted string otherwise", () => {
    const counted = evaluate(
      [
        rule(
          "w",
          { type: "gift" },
          { steps: [hook("https://h.example/", '{"count": {count}, "gift": {giftName}}')] },
        ),
      ],
      emptyState(),
      gift({ repeatCount: 3 }),
      NOW,
    );
    expect(bodyOf(counted[0])).toBe('{"count": 3, "gift": "Rose"}');

    const injected = evaluate(
      [
        rule(
          "w",
          { type: "chat", match: "any" },
          { steps: [hook("https://h.example/", '{"said": {comment}}')] },
        ),
      ],
      emptyState(),
      chat('1, "evil": 2'),
      NOW,
    );
    expect(JSON.parse(bodyOf(injected[0]) ?? "")).toEqual({ said: '1, "evil": 2' });
  });

  /** The body of the first webhook firing, for a chat rule whose body is `template`. */
  const chatBody = (template: string, event: LiveEvent, extra: Vars = {}): string | undefined =>
    bodyOf(
      evaluate(
        [rule("w", { type: "chat", match: "any" }, { steps: [hook("https://h.example/", template)] })],
        emptyState(),
        event,
        NOW,
        extra,
      )[0],
    );

  it("fills a text body as typed, because it isn't JSON", () => {
    expect(chatBody('{nickname} said "{comment}"', chat('a "b" \\ c'))).toBe('Viewer said "a "b" \\ c"');
  });

  it("keeps a text body raw when it starts with a letter, even if the value has quotes", () => {
    expect(chatBody("viewer={nickname}", chat('"x"'))).toBe("viewer=Viewer");
  });

  it("keeps a body that starts with a placeholder as text, so its value is not quoted", () => {
    expect(chatBody("{nickname} sent a gift", chat("hi"))).toBe("Viewer sent a gift");
    expect(chatBody("{comment}", chat('a "quoted" \\ line'))).toBe('a "quoted" \\ line');
  });

  it("keeps a body that starts with an unknown {word} as text, since it can't be JSON", () => {
    expect(chatBody("{wave} {nickname} waved", chat("hi"))).toBe("{wave} Viewer waved");
  });

  it("keeps a hostile nickname inside its string in a JSON body, so it can't add keys", () => {
    const body = chatBody('{"viewer":"{nickname}"}', chat("hi", { ...USER, nickname: 'x", "evil": "1' }));
    expect(JSON.parse(body ?? "")).toEqual({ viewer: 'x", "evil": "1' });
  });

  it("never fills a placeholder in a key, so a viewer's name can't override a fixed key", () => {
    expect(
      chatBody('{"action":"safe","{nickname}":"{comment}"}', chat("hi", { ...USER, nickname: "action" })),
    ).toBe('{"action":"safe","{nickname}":"hi"}');
  });

  it("fills a body with a broken escape as text, since `\\{` isn't valid JSON", () => {
    expect(chatBody('{"said": "\\{comment}"}', chat('"x'))).toBe('{"said": "\\"x"}');
  });

  it("keeps an escaped backslash before a placeholder, so the value is escaped after it", () => {
    const body = chatBody('{"said": "\\\\{comment}"}', chat('"x'));
    expect(JSON.parse(body ?? "")).toEqual({ said: '\\"x' });
  });

  it("quotes a bare placeholder unless its value is a JSON number", () => {
    const body = (points: string) => chatBody('{"v": {points}}', chat("hi"), { points });
    expect(body("01")).toBe('{"v": "01"}');
    expect(body("1e5")).toBe('{"v": 1e5}');
    expect(body("-0.5")).toBe('{"v": -0.5}');
    expect(body("1.")).toBe('{"v": "1."}');
  });

  it("keeps a viewer's text inside its string when the template's own JSON is valid", () => {
    const body = chatBody(
      '{"count":{count},"action":"safe","said":"{comment}"}',
      chat('x","action":"evil","pad":"'),
      { count: "2" },
    );
    expect(JSON.parse(body ?? "")).toEqual({
      count: 2,
      action: "safe",
      said: 'x","action":"evil","pad":"',
    });
  });

  it("fills a body that isn't JSON as typed, even when the filled text parses", () => {
    // `{count}` is empty on a chat event, so `0{count}` is `0` and the template isn't JSON. Its text is
    // filled as typed, and the request is text/plain (see RuleEngine.test.ts).
    const body = chatBody(
      '{"count":0{count},"action":"safe","said":"{comment}"}',
      chat('x","action":"evil","pad":"'),
    );
    expect(body).toBe('{"count":0,"action":"safe","said":"x","action":"evil","pad":""}');
  });

  it("keeps unknown placeholders as typed, and keeps the webhook even when its values are empty", () => {
    const firings = evaluate(
      [rule("w", { type: "follow" }, { steps: [hook("https://h.example/{nope}/{comment}")] })],
      emptyState(),
      plain("follow"),
      NOW,
    );
    expect(firings[0]?.steps).toEqual([{ kind: "webhook", url: "https://h.example/{nope}/" }]);
  });

  it("records the event type and the template values on each firing, for the default payload", () => {
    const [firing] = evaluate([rule("g", { type: "gift" })], emptyState(), gift(), NOW);
    expect(firing?.eventType).toBe("gift");
    expect(firing?.vars).toMatchObject({ nickname: "Viewer", giftName: "Rose", count: "1", comment: "" });

    const likes = evaluate(
      [rule("l", { type: "likes", every: 10 }, { steps: [say("{likes}")] })],
      emptyState(),
      like(10),
      NOW,
    );
    expect(likes[0]?.eventType).toBe("like");
    expect(likes[0]?.vars.likes).toBe("10");
  });
});
