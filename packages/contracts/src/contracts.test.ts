import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ClientMessage,
  GiftInfo,
  LIVE_EVENT_TYPES,
  LiveEvent,
  normalizeUsername,
  SessionStatus,
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
    const detailed = { ...status, streamStartedAt: 1791770120000, coverUrl: "https://img.example/c.webp" };
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
