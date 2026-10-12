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
