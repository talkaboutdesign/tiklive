import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ClientMessage,
  DEFAULT_POINTS_SETTINGS,
  GiftInfo,
  PointsAdjustRequest,
  PointsSettings,
  LIVE_EVENT_TYPES,
  LiveEvent,
  normalizeUsername,
  Rule,
  RuleSet,
  ServerMessage,
  SessionStatus,
  SubscribeMessage,
  Username,
} from "./index.ts";

const user = { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" };
const stats = () => ({
  likes: 0,
  diamonds: 0,
  follows: 0,
  shares: 0,
  joins: 0,
  chats: 0,
  viewers: 0,
  peakViewers: 0,
});

describe("contracts", () => {
  it("lists every event type", () => {
    expect(LIVE_EVENT_TYPES).toContain("chat");
    expect(LIVE_EVENT_TYPES).toContain("streamEnd");
    expect(LIVE_EVENT_TYPES).toContain("chatDelete");
    expect(LIVE_EVENT_TYPES).toHaveLength(14);
  });

  it("decodes valid events and rejects wrong field types", () => {
    const decode = Schema.decodeUnknownSync(LiveEvent);
    expect(decode({ type: "follow", timestamp: 1, user }).type).toBe("follow");
    expect(() =>
      decode({
        type: "gift",
        timestamp: 1,
        user,
        giftId: 1,
        giftName: "Rose",
        giftImageUrl: "",
        diamondCount: 1,
        repeatCount: "<img src=x onerror=alert(1)>",
        streaking: false,
        totalDiamonds: 1,
        groupId: "0",
      }),
    ).toThrow();
    expect(() => decode({ type: "nope", timestamp: 1 })).toThrow();
  });

  it("accepts the optional follow details on a user", () => {
    const decode = Schema.decodeUnknownSync(LiveEvent);
    const follower = { ...user, followerCount: 53, followingCount: 275, followStatus: "friend" };
    expect(decode({ type: "follow", timestamp: 1, user: follower })).toEqual({
      type: "follow",
      timestamp: 1,
      user: follower,
    });
    expect(() =>
      decode({ type: "follow", timestamp: 1, user: { ...user, followStatus: "bestie" } }),
    ).toThrow();
  });

  it("matches on event type", () => {
    const describeEvent = LiveEvent.match({
      chat: (e) => e.comment,
      chatDelete: (e) => `${e.msgIds.length} deleted`,
      follow: (e) => `${e.user.nickname} followed`,
      gift: () => "gift",
      like: () => "like",
      share: () => "share",
      join: () => "join",
      subscribe: () => "subscribe",
      question: () => "question",
      emote: () => "emote",
      viewers: () => "viewers",
      streamEnd: () => "end",
      battle: () => "battle",
      battleScore: () => "battleScore",
    });
    expect(describeEvent({ type: "follow", timestamp: 1, user })).toBe("Viewer followed");
  });

  it("accepts the optional room details on session status", () => {
    const status = { username: "alice", state: "live", stats: stats() };
    const decode = Schema.decodeUnknownSync(SessionStatus);
    expect(decode(status)).toEqual(status);
    const detailed = {
      ...status,
      streamStartedAt: 1791770120000,
      coverUrl: "https://img.example/c.webp",
      hlsUrl: "https://cdn.example/live.m3u8",
    };
    expect(decode(detailed)).toEqual(detailed);
    expect(() => decode({ ...status, streamStartedAt: "yesterday" })).toThrow();
  });

  it("decodes gift info", () => {
    const gift = {
      giftId: 5655,
      name: "Rose",
      diamondCount: 1,
      imageUrl: "https://img.example/r.webp",
      streakable: true,
    };
    expect(Schema.decodeUnknownSync(GiftInfo)(gift)).toEqual(gift);
    expect(() => Schema.decodeUnknownSync(GiftInfo)({ ...gift, streakable: "yes" })).toThrow();
  });

  it("validates client messages", () => {
    const decode = Schema.decodeUnknownSync(ClientMessage);
    expect(decode({ action: "subscribe", username: "x", events: ["chat"] }).action).toBe("subscribe");
    expect(() => decode({ action: "subscribe", username: "x", events: ["bogus"] })).toThrow();
  });

  it("normalizes usernames", () => {
    expect(normalizeUsername(" @Some.One ")).toBe("some.one");
    expect(normalizeUsername("https://www.tiktok.com/@zaynscape/live")).toBe("zaynscape");
    expect(Schema.is(Username)("some.one")).toBe(true);
    expect(Schema.is(Username)("../etc")).toBe(false);
  });
});

describe("actions", () => {
  const decodeRule = Schema.decodeUnknownSync(Rule);
  const baseRule = {
    id: "r1",
    name: "Rule",
    enabled: true,
    trigger: { type: "follow" },
    steps: [{ kind: "speak", text: "hi" }],
  };

  it("decodes a full rule with every trigger and step kind", () => {
    const triggers = [
      { type: "gift", giftId: 5655, giftName: "Rose", minCoins: 10, perGift: true },
      { type: "follow" },
      { type: "share" },
      { type: "subscribe" },
      { type: "chat", match: "command", text: "!dance", from: "subscribers" },
      { type: "chat", match: "contains", text: "wave", from: "moderators" },
      { type: "chat", match: "any", from: "everyone" },
      { type: "chat", match: "any", from: "friends", minFollowers: 50 },
      { type: "chat", match: "command", text: "!hi", from: "followers", minFollowers: 0 },
      { type: "join" },
      { type: "join", from: "friends", minFollowers: 10, oncePerStream: false },
      { type: "join", from: "followers", oncePerStream: true },
      { type: "likes", every: 100 },
    ];
    for (const trigger of triggers) {
      expect(decodeRule({ ...baseRule, trigger }).trigger).toEqual(trigger);
    }

    const steps = [
      { kind: "sound", url: "/media/abc123.mp3", volume: 0.5 },
      { kind: "media", url: "https://img.example/a.gif", duration: 3, text: "Hi {nickname}", volume: 1 },
      { kind: "speak", text: "{nickname} says {comment}", voice: "Samantha", rate: 1.2, volume: 0.8 },
      { kind: "obsScene", scene: "Dance", revertAfter: 30 },
    ];
    const full = { ...baseRule, cooldown: 10, userCooldown: 60, steps };
    expect(decodeRule(full)).toEqual(full);
  });

  it("rejects media URLs other than /media/<file> and http(s)", () => {
    const decode = Schema.decodeUnknownSync(Rule);
    const withUrl = (url: string) => ({ ...baseRule, steps: [{ kind: "sound", url }] });
    expect(() => decode(withUrl("javascript:alert(1)"))).toThrow();
    expect(() => decode(withUrl("data:audio/mpeg;base64,AAAA"))).toThrow();
    expect(() => decode(withUrl("../media/x.png"))).toThrow();
    expect(decode(withUrl("/media/x.png")).steps[0]).toMatchObject({ kind: "sound" });
  });

  it("rejects audiences, minFollowers values and join options that don't fit", () => {
    const decodeTrigger = (trigger: unknown) => decodeRule({ ...baseRule, trigger });
    expect(() => decodeTrigger({ type: "chat", match: "any", from: "vips" })).toThrow();
    expect(() => decodeTrigger({ type: "join", from: "vips" })).toThrow();
    expect(() => decodeTrigger({ type: "chat", match: "any", minFollowers: -1 })).toThrow();
    expect(() => decodeTrigger({ type: "join", minFollowers: 1_000_000_001 })).toThrow();
    expect(() => decodeTrigger({ type: "join", oncePerStream: "yes" })).toThrow();
    expect(() => decodeTrigger({ type: "join", minFollowers: 1_000_000_000 })).not.toThrow();
  });

  it("accepts the followers template variable in speech", () => {
    const rule = {
      ...baseRule,
      trigger: { type: "join" },
      steps: [{ kind: "speak", text: "{nickname} has {followers} followers" }],
    };
    expect(decodeRule(rule).steps).toEqual(rule.steps);
  });

  it("rejects rules with more than 10 steps and unknown step kinds", () => {
    const decode = Schema.decodeUnknownSync(Rule);
    const steps = Array.from({ length: 11 }, () => ({ kind: "speak", text: "hi" }));
    expect(() => decode({ ...baseRule, steps })).toThrow();
    expect(() => decode({ ...baseRule, steps: [{ kind: "explode" }] })).toThrow();
  });

  it("validates rule sets", () => {
    const decode = Schema.decodeUnknownSync(RuleSet);
    expect(decode({ revision: 0, rules: [] })).toEqual({ revision: 0, rules: [] });
    expect(() => decode({ revision: -1, rules: [] })).toThrow();
  });

  it("accepts actions on subscribe", () => {
    const decode = Schema.decodeUnknownSync(SubscribeMessage);
    expect(decode({ action: "subscribe", username: "demo", actions: true }).actions).toBe(true);
    expect(decode({ action: "subscribe", username: "demo" }).actions).toBeUndefined();
    expect(
      Schema.decodeUnknownSync(ClientMessage)({ action: "subscribe", username: "demo", actions: true }),
    ).toMatchObject({ actions: true });
  });

  it("decodes action server messages", () => {
    const message = {
      type: "action",
      username: "demo",
      action: {
        id: "a1",
        ruleId: "r1",
        ruleName: "Rule",
        timestamp: 1,
        user: { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" },
        steps: [{ kind: "speak", text: "Viewer says hi" }],
      },
    };
    expect(Schema.decodeUnknownSync(ServerMessage)(message)).toEqual(message);
    expect(() =>
      Schema.decodeUnknownSync(ServerMessage)({ type: "action", username: "demo", action: { id: "a1" } }),
    ).toThrow();
  });
});

describe("viewer points", () => {
  it("accepts the default settings and rejects fractions, negatives and out-of-range values", () => {
    expect(Schema.is(PointsSettings)(DEFAULT_POINTS_SETTINGS)).toBe(true);
    expect(Schema.is(PointsSettings)({ ...DEFAULT_POINTS_SETTINGS, perMessage: 1.5 })).toBe(false);
    expect(Schema.is(PointsSettings)({ ...DEFAULT_POINTS_SETTINGS, perFollow: -1 })).toBe(false);
    expect(Schema.is(PointsSettings)({ ...DEFAULT_POINTS_SETTINGS, likesPerPoint: 0 })).toBe(false);
    expect(Schema.is(PointsSettings)({ ...DEFAULT_POINTS_SETTINGS, messageCooldownSeconds: 86_401 })).toBe(
      false,
    );
    expect(Schema.is(PointsSettings)({ ...DEFAULT_POINTS_SETTINGS, perJoin: Infinity })).toBe(false);
    expect(Schema.is(PointsSettings)({ perMessage: 1 })).toBe(false);
  });

  it("accepts a whole-number delta or set, within bounds", () => {
    expect(Schema.is(PointsAdjustRequest)({ delta: -5 })).toBe(true);
    expect(Schema.is(PointsAdjustRequest)({ set: 0 })).toBe(true);
    expect(Schema.is(PointsAdjustRequest)({ delta: 1.5 })).toBe(false);
    expect(Schema.is(PointsAdjustRequest)({ set: -1 })).toBe(false);
    expect(Schema.is(PointsAdjustRequest)({ delta: 2_000_000_000 })).toBe(false);
  });
});
