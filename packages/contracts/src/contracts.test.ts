import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ClientMessage, LIVE_EVENT_TYPES, LiveEvent, normalizeUsername, Username } from "./index.ts";

const user = { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" };

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
