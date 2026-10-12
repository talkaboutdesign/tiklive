import { describe, expect, it } from "@effect/vitest";
import { gzipSync } from "node:zlib";
import { decode, ProtoWriter } from "./wire.ts";
import {
  decodeFetchResult,
  decodePushFrame,
  decodeSocketFrame,
  encodeAck,
  encodeHeartbeat,
  encodePushFrame,
} from "./frames.ts";
import { decodeLiveEvent } from "./messages.ts";

const user = (id: string, handle: string, nickname: string) =>
  new ProtoWriter()
    .varint(1, id)
    .string(3, nickname)
    .message(9, new ProtoWriter().string(1, `https://img/${handle}.webp`))
    .string(38, handle);

const common = (msgId: string, createTime: number, displayKey = "") => {
  const w = new ProtoWriter().varint(2, msgId).varint(4, createTime);
  if (displayKey) w.message(8, new ProtoWriter().string(1, displayKey));
  return w;
};

describe("wire codec", () => {
  it("round-trips varints, 64-bit ids, strings and nested messages", () => {
    const buf = new ProtoWriter()
      .varint(1, "7693676830666705678")
      .varint(2, 42)
      .varint(3, true)
      .string(4, "héllo 👋")
      .message(5, new ProtoWriter().string(1, "nested"))
      .message(6, new ProtoWriter().string(1, "a"))
      .message(6, new ProtoWriter().string(1, "b"))
      .finish();

    const m = decode(buf);
    expect(m.id(1)).toBe("7693676830666705678");
    expect(m.num(2)).toBe(42);
    expect(m.bool(3)).toBe(true);
    expect(m.str(4)).toBe("héllo 👋");
    expect(m.msg(5)?.str(1)).toBe("nested");
    expect(m.msgs(6).map((x) => x.str(1))).toEqual(["a", "b"]);
    expect(m.num(99)).toBe(0);
    expect(m.str(99)).toBe("");
  });

  it("decodes negative int32 values encoded as 10-byte varints", () => {
    const m = decode(new ProtoWriter().varint(1, -5).finish());
    expect(m.num(1)).toBe(-5);
  });

  it("reads repeated uint64 fields in packed and unpacked form", () => {
    const packed = decode(new ProtoWriter().packedVarints(1, ["7693676830666705678", 42, 0]).finish());
    expect(packed.ids(1)).toEqual(["7693676830666705678", "42", "0"]);

    const unpacked = decode(new ProtoWriter().varint(2, "300").varint(2, "5").finish());
    expect(unpacked.ids(2)).toEqual(["300", "5"]);

    expect(decode(new Uint8Array()).ids(3)).toEqual([]);
  });

  it("rejects truncated input", () => {
    const buf = new ProtoWriter().string(1, "hello").finish();
    expect(() => decode(buf.subarray(0, 3))).toThrow();
  });
});

describe("frames", () => {
  it("round-trips push frames", () => {
    const encoded = encodePushFrame({ logId: "123", payloadType: "msg", payload: Uint8Array.of(1, 2, 3) });
    const frame = decodePushFrame(encoded);
    expect(frame).toMatchObject({ logId: "123", payloadType: "msg", payloadEncoding: "pb" });
    expect([...frame.payload]).toEqual([1, 2, 3]);
  });

  it("encodes heartbeat and ack frames", () => {
    const hb = decodePushFrame(encodeHeartbeat("999"));
    expect(hb.payloadType).toBe("hb");
    expect(decode(hb.payload).id(1)).toBe("999");

    const ack = decodePushFrame(encodeAck("55"));
    expect(ack).toMatchObject({ logId: "55", payloadType: "ack" });
    expect(new TextDecoder().decode(ack.payload)).toBe("-");
  });

  it("decodes gzipped event batches from socket frames", async () => {
    const batch = new ProtoWriter()
      .message(
        1,
        new ProtoWriter().string(1, "WebcastChatMessage").bytes(2, Uint8Array.of(9)).varint(3, "77"),
      )
      .string(2, "cursor-1")
      .string(5, "internal-ext")
      .message(7, new ProtoWriter().string(1, "imprp").string(2, "xyz"))
      .varint(9, true)
      .string(10, "wss://push.example/ws")
      .finish();

    const frame = encodePushFrame({
      logId: "1",
      payloadType: "msg",
      payload: new Uint8Array(gzipSync(batch)),
    });
    const { result } = await decodeSocketFrame(frame);
    expect(result).toMatchObject({
      cursor: "cursor-1",
      internalExt: "internal-ext",
      routeParams: { imprp: "xyz" },
      needAck: true,
      pushServer: "wss://push.example/ws",
    });
    expect(result?.messages[0]).toMatchObject({ method: "WebcastChatMessage", msgId: "77" });
    expect(decodeFetchResult(batch).messages).toHaveLength(1);
  });
});

describe("live event decoding", () => {
  it("treats a zero common msgId as missing and uses the envelope id instead", () => {
    const payload = new ProtoWriter()
      .message(1, common("0", 1791744000123))
      .message(2, user("1", "alice", "Alice"))
      .string(3, "hi")
      .finish();
    const decode = (msgId: string) =>
      decodeLiveEvent({ method: "WebcastChatMessage", payload, msgId, isHistory: false });

    expect(decode("555")).toMatchObject({ msgId: "555" });
    expect(decode("0")).not.toHaveProperty("msgId");
    expect(decode("")).not.toHaveProperty("msgId");
  });

  it("decodes chat messages with user identity", () => {
    const payload = new ProtoWriter()
      .message(1, common("100", 1791744000123))
      .message(2, user("1", "alice", "Alice"))
      .string(3, "hello stream")
      .message(18, new ProtoWriter().varint(2, true).varint(5, true))
      .finish();

    expect(
      decodeLiveEvent({ method: "WebcastChatMessage", payload, msgId: "100", isHistory: false }),
    ).toEqual({
      type: "chat",
      msgId: "100",
      timestamp: 1791744000123,
      user: {
        userId: "1",
        uniqueId: "alice",
        nickname: "Alice",
        profilePictureUrl: "https://img/alice.webp",
        isGifter: false,
        isSubscriber: true,
        isFollower: false,
        isModerator: true,
      },
      comment: "hello stream",
      emotes: [],
    });
  });

  it("decodes the viewer's follower counts and relationship to the streamer", () => {
    const chatFrom = (followInfo?: ProtoWriter) => {
      const u = user("4", "dana", "Dana");
      if (followInfo) u.message(22, followInfo);
      return new ProtoWriter().message(1, common("400", 1)).message(2, u).string(3, "hi").finish();
    };
    const userOf = (payload: Uint8Array) => {
      const event = decodeLiveEvent({
        method: "WebcastChatMessage",
        payload,
        msgId: "400",
        isHistory: false,
      });
      return event?.type === "chat" ? event.user : undefined;
    };

    const friend = new ProtoWriter().varint(1, 275).varint(2, 53).varint(3, 2);
    expect(userOf(chatFrom(friend))).toMatchObject({
      followingCount: 275,
      followerCount: 53,
      followStatus: "friend",
    });
    expect(userOf(chatFrom(new ProtoWriter().varint(1, 1).varint(2, 2).varint(3, 1)))?.followStatus).toBe(
      "follower",
    );
    // A stranger: TikTok leaves followStatus at its zero default.
    expect(userOf(chatFrom(new ProtoWriter().varint(1, 623).varint(2, 229)))).toMatchObject({
      followerCount: 229,
      followStatus: "none",
    });
    // An unknown status is left out rather than guessed.
    expect(userOf(chatFrom(new ProtoWriter().varint(3, 9)))).not.toHaveProperty("followStatus");

    const bare = userOf(chatFrom());
    expect(bare).not.toHaveProperty("followerCount");
    expect(bare).not.toHaveProperty("followStatus");
  });

  it("tracks gift streaks", () => {
    const gift = (repeatCount: number, repeatEnd: boolean) =>
      new ProtoWriter()
        .message(1, common("200", 1791744000000))
        .varint(2, 5655)
        .varint(5, repeatCount)
        .message(7, user("2", "bob", "Bob"))
        .varint(9, repeatEnd)
        .message(
          15,
          new ProtoWriter()
            .message(1, new ProtoWriter().string(1, "https://img/rose.webp"))
            .varint(11, 1)
            .varint(12, 1)
            .string(16, "Rose"),
        )
        .finish();

    const mid = decodeLiveEvent({
      method: "WebcastGiftMessage",
      payload: gift(3, false),
      msgId: "",
      isHistory: false,
    });
    expect(mid).toMatchObject({
      type: "gift",
      giftName: "Rose",
      repeatCount: 3,
      streaking: true,
      totalDiamonds: 3,
    });

    const end = decodeLiveEvent({
      method: "WebcastGiftMessage",
      payload: gift(5, true),
      msgId: "",
      isHistory: false,
    });
    expect(end).toMatchObject({
      streaking: false,
      repeatCount: 5,
      totalDiamonds: 5,
      giftImageUrl: "https://img/rose.webp",
    });
  });

  it("splits social messages into follow and share", () => {
    const social = (key: string) =>
      new ProtoWriter()
        .message(1, common("300", 1, key))
        .message(2, user("3", "cat", "Cat"))
        .finish();

    expect(
      decodeLiveEvent({
        method: "WebcastSocialMessage",
        payload: social("pm_main_follow_message_viewer_2"),
        msgId: "",
        isHistory: false,
      })?.type,
    ).toBe("follow");
    expect(
      decodeLiveEvent({
        method: "WebcastSocialMessage",
        payload: social("pm_mt_guidance_share"),
        msgId: "",
        isHistory: false,
      })?.type,
    ).toBe("share");
  });

  it("ignores unsupported methods", () => {
    expect(
      decodeLiveEvent({
        method: "WebcastUnknownThing",
        payload: new Uint8Array(),
        msgId: "",
        isHistory: false,
      }),
    ).toBeUndefined();
  });
});

describe("battle decoding", () => {
  // Shapes mirror real WebcastLinkMicBattle / WebcastLinkMicArmies payloads.
  const host = (id: string, handle: string) =>
    new ProtoWriter()
      .varint(1, id)
      .message(
        2,
        new ProtoWriter().message(
          1,
          new ProtoWriter().varint(1, id).string(2, handle.toUpperCase()).string(4, handle),
        ),
      );
  const settings = new ProtoWriter().varint(1, "77").varint(2, 1791769672539).varint(3, 301).varint(5, 2);

  it("decodes a finished battle with results", () => {
    const payload = new ProtoWriter()
      .varint(2, "77")
      .message(3, settings)
      .varint(4, 6)
      .message(
        5,
        new ProtoWriter()
          .varint(1, "1")
          .message(2, new ProtoWriter().varint(1, "1").varint(2, 1).varint(3, 9)),
      )
      .message(5, new ProtoWriter().varint(1, "2").message(2, new ProtoWriter().varint(1, "2").varint(3, 15)))
      .message(10, host("1", "alpha"))
      .message(10, host("2", "beta"))
      .finish();
    const event = decodeLiveEvent({ method: "WebcastLinkMicBattle", payload, msgId: "", isHistory: false });
    expect(event).toMatchObject({
      type: "battle",
      battleId: "77",
      status: "finished",
      action: "cutShort",
      durationSeconds: 301,
      hosts: [
        { user: { userId: "1", uniqueId: "alpha", nickname: "ALPHA" }, score: 9, result: "lose" },
        { user: { userId: "2", uniqueId: "beta" }, score: 15, result: "win" },
      ],
    });
  });

  it("decodes battle scores with top gifters sorted", () => {
    const army = (id: string, score: number) =>
      new ProtoWriter().varint(1, id).varint(2, score).string(3, `fan${id}`);
    const payload = new ProtoWriter()
      .varint(2, "77")
      .message(
        3,
        new ProtoWriter()
          .varint(1, "2")
          .message(2, new ProtoWriter().message(1, army("10", 3)).message(1, army("11", 5)).varint(2, 8)),
      )
      .varint(7, 1)
      .finish();
    const event = decodeLiveEvent({ method: "WebcastLinkMicArmies", payload, msgId: "", isHistory: false });
    expect(event).toMatchObject({
      type: "battleScore",
      battleId: "77",
      reason: "scoreUpdate",
      teams: [
        { hostUserId: "2", score: 8, topGifters: [{ score: 5, user: { nickname: "fan11" } }, { score: 3 }] },
      ],
    });
  });
});

describe("chat deletion decoding", () => {
  it("decodes packed deleted message ids and user ids", () => {
    const payload = new ProtoWriter()
      .message(1, common("400", 1791744000456))
      .packedVarints(2, ["7000000000000000001", "7000000000000000002"])
      .packedVarints(3, ["555"])
      .finish();

    expect(
      decodeLiveEvent({ method: "WebcastImDeleteMessage", payload, msgId: "", isHistory: false }),
    ).toEqual({
      type: "chatDelete",
      msgId: "400",
      timestamp: 1791744000456,
      msgIds: ["7000000000000000001", "7000000000000000002"],
      userIds: ["555"],
    });
  });

  it("allows an absent user id list", () => {
    const payload = new ProtoWriter()
      .message(1, common("401", 1791744000789))
      .packedVarints(2, ["9"])
      .finish();
    expect(
      decodeLiveEvent({ method: "WebcastImDeleteMessage", payload, msgId: "", isHistory: false }),
    ).toMatchObject({
      type: "chatDelete",
      msgIds: ["9"],
      userIds: [],
    });
  });

  it("drops messages that delete nothing", () => {
    const payload = new ProtoWriter().message(1, common("402", 1791744000999)).finish();
    expect(
      decodeLiveEvent({ method: "WebcastImDeleteMessage", payload, msgId: "", isHistory: false }),
    ).toBeUndefined();
  });
});

describe("goal decoding", () => {
  // A gift goal with one gift target and one unknown target, and two contributors.
  const goalPayload = () =>
    new ProtoWriter()
      .message(1, common("500", 1791744001000))
      .message(
        3,
        new ProtoWriter()
          .varint(1, "7695831808499763999")
          .message(
            4,
            new ProtoWriter()
              .varint(1, 1)
              .varint(2, 5655)
              .varint(3, 15)
              .varint(4, 100)
              .message(
                5,
                new ProtoWriter()
                  .string(1, "Rose")
                  .message(2, new ProtoWriter().string(1, "https://img/rose.png")),
              ),
          )
          .message(4, new ProtoWriter().varint(1, 7).varint(3, 2).varint(4, 5))
          .string(5, "GIFT GAL")
          .varint(9, 1791839928)
          .message(
            11,
            new ProtoWriter()
              .varint(1, "6822775526810371077")
              .message(2, new ProtoWriter().string(1, "https://img/daddy.webp"))
              .string(3, "Daddy Butch")
              .varint(4, 10)
              .string(5, "6822775526810371077"),
          )
          .message(11, new ProtoWriter().varint(1, "7530015499872846903").string(3, "Paddler").varint(4, 1)),
      )
      .finish();

  it("decodes gift goals with progress, contributors and end time", () => {
    expect(
      decodeLiveEvent({
        method: "WebcastGoalUpdateMessage",
        payload: goalPayload(),
        msgId: "",
        isHistory: false,
      }),
    ).toEqual({
      type: "goal",
      msgId: "500",
      timestamp: 1791744001000,
      goalId: "7695831808499763999",
      description: "GIFT GAL",
      goals: [
        {
          kind: "gift",
          giftId: 5655,
          giftName: "Rose",
          giftImageUrl: "https://img/rose.png",
          progress: 15,
          target: 100,
        },
        { kind: "other", progress: 2, target: 5 },
      ],
      contributors: [
        {
          user: {
            userId: "6822775526810371077",
            nickname: "Daddy Butch",
            profilePictureUrl: "https://img/daddy.webp",
          },
          count: 10,
        },
        { user: { userId: "7530015499872846903", nickname: "Paddler", profilePictureUrl: "" }, count: 1 },
      ],
      endsAt: 1791839928000,
    });
  });

  it("allows a goal with no targets or contributors", () => {
    const payload = new ProtoWriter()
      .message(1, common("501", 1791744002000))
      .message(3, new ProtoWriter().varint(1, "9"))
      .finish();
    expect(
      decodeLiveEvent({ method: "WebcastGoalUpdateMessage", payload, msgId: "", isHistory: false }),
    ).toEqual({
      type: "goal",
      msgId: "501",
      timestamp: 1791744002000,
      goalId: "9",
      description: "",
      goals: [],
      contributors: [],
    });
  });

  it("drops goal updates without a goal", () => {
    const payload = new ProtoWriter().message(1, common("502", 1791744003000)).finish();
    expect(
      decodeLiveEvent({ method: "WebcastGoalUpdateMessage", payload, msgId: "", isHistory: false }),
    ).toBeUndefined();
  });
});

describe("gifter level", () => {
  // Gifter badge (field 64 of the user): image `grade_badge_*`, level as a decimal string at 12.5.
  const gifterBadge = (level: string, image = "webcast-va/grade_badge_icon_lite_lv35_v3.png") =>
    new ProtoWriter()
      .varint(1, 4)
      .varint(2, 20)
      .message(12, new ProtoWriter().string(1, "2").varint(2, "7138382115757971236").string(5, level))
      .message(23, new ProtoWriter().varint(1, 4).message(2, new ProtoWriter().string(2, image)));

  const fanBadge = () =>
    new ProtoWriter()
      .varint(1, 4)
      .varint(2, 30)
      .message(12, new ProtoWriter().string(1, "2").string(5, "7"))
      .message(
        23,
        new ProtoWriter().message(
          2,
          new ProtoWriter().string(2, "webcast-va/webcast-va-fans_badge_icon_lv1_v2.png"),
        ),
      );

  const chatWith = (...badges: ProtoWriter[]) => {
    const userWriter = user("1", "alice", "Alice");
    for (const badge of badges) userWriter.message(64, badge);
    return new ProtoWriter()
      .message(1, common("600", 1791744004000))
      .message(2, userWriter)
      .string(3, "hi")
      .finish();
  };

  it("reads the level from a gifter badge", () => {
    const event = decodeLiveEvent({
      method: "WebcastChatMessage",
      payload: chatWith(gifterBadge("36")),
      msgId: "600",
      isHistory: false,
    });
    expect(event).toMatchObject({ type: "chat", user: { gifterLevel: 36 } });
  });

  it("skips fan club badges and leaves the level out when there is none", () => {
    const withFan = decodeLiveEvent({
      method: "WebcastChatMessage",
      payload: chatWith(fanBadge(), gifterBadge("21", "webcast-va/grade_badge_icon_lite_lv20_v1.png")),
      msgId: "600",
      isHistory: false,
    });
    expect(withFan).toMatchObject({ user: { gifterLevel: 21 } });

    const fanOnly = decodeLiveEvent({
      method: "WebcastChatMessage",
      payload: chatWith(fanBadge()),
      msgId: "600",
      isHistory: false,
    });
    expect(fanOnly).toBeDefined();
    expect(fanOnly && "user" in fanOnly && "gifterLevel" in fanOnly.user).toBe(false);
  });
});
