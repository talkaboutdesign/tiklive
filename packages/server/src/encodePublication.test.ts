import { expect, it } from "@effect/vitest";
import type { LiveEvent } from "@tiklive/contracts";
import { makePublicationEncoder } from "./encodePublication.ts";
import type { SessionMessage } from "./Session.ts";

const event: LiveEvent = {
  type: "chat",
  timestamp: 1,
  msgId: "same-id",
  user: { userId: "1", uniqueId: "viewer", nickname: "Viewer", profilePictureUrl: "" },
  comment: "Hello",
  emotes: [],
};

it("encodes live events without publication sequence or replay metadata", () => {
  const encode = makePublicationEncoder();
  const publication: SessionMessage = { _tag: "Event", event, seq: 1 };
  const expected = { type: "event", username: "alice", event };
  expect(JSON.parse(encode("alice", publication))).toEqual(expected);
  expect(JSON.parse(encode("alice", publication))).toEqual(expected);
  expect(JSON.parse(encode("bob", publication))).toEqual({ ...expected, username: "bob" });
  expect(JSON.parse(encode("alice", publication))).toEqual(expected);
});

it("encodes each publication independently even when its event or id is reused", () => {
  const encode = makePublicationEncoder();
  const reused = { ...event };
  const first: SessionMessage = { _tag: "Event", event: reused, seq: 1 };
  expect(JSON.parse(encode("alice", first)).event.comment).toBe("Hello");
  reused.comment = "Updated";
  expect(JSON.parse(encode("alice", { _tag: "Event", event: reused, seq: 2 })).event.comment).toBe("Updated");
  expect(
    JSON.parse(encode("alice", { _tag: "Event", event: { ...event, comment: "New object" }, seq: 3 })).event
      .comment,
  ).toBe("New object");
});

it("encodes statuses and actions in their existing wire shapes", () => {
  const encode = makePublicationEncoder();
  const status = {
    username: "alice",
    state: "live" as const,
    stats: { likes: 0, diamonds: 0, follows: 0, shares: 0, joins: 0, chats: 0, viewers: 0, peakViewers: 0 },
  };
  const action = { id: "a1", ruleId: "r1", ruleName: "Rule", timestamp: 1, steps: [] };
  const statusPublication: SessionMessage = { _tag: "Status", status };
  const actionPublication: SessionMessage = { _tag: "Action", action };
  for (let i = 0; i < 2; i++) {
    expect(JSON.parse(encode("alice", statusPublication))).toEqual({
      type: "status",
      username: "alice",
      status,
    });
    expect(JSON.parse(encode("alice", actionPublication))).toEqual({
      type: "action",
      username: "alice",
      action,
    });
  }
});
