/**
 * Maps raw TikTok webcast messages onto normalized {@link LiveEvent}s.
 *
 * Field numbers come from TikTok's webcast protobuf schemas. Each decoder only
 * reads the handful of fields overlays need.
 */
import type {
  BattleEvent,
  BattleHost,
  BattleScoreEvent,
  Emote,
  LiveEvent,
  LiveUser,
} from "@tiklive/contracts";
import type { RawMessage } from "./frames.ts";
import { decode, type ProtoMessage } from "./wire.ts";

/** Common header present as field 1 on every webcast message. */
function common(m: ProtoMessage): { msgId: string; timestamp: number; displayKey: string } {
  const c = m.msg(1);
  const createTime = c?.num(4) ?? 0;
  return {
    msgId: c?.id(2) ?? "",
    // createTime is ms on most messages but occasionally seconds.
    timestamp: createTime === 0 ? Date.now() : createTime < 1e12 ? createTime * 1000 : createTime,
    displayKey: c?.msg(8)?.str(1) ?? "",
  };
}

function imageUrl(image: ProtoMessage | undefined): string {
  return image?.strs(1)[0] ?? "";
}

// FollowInfo.followStatus: the viewer's relationship to the streamer.
const FOLLOW_STATUS: ReadonlyArray<NonNullable<LiveUser["followStatus"]>> = ["none", "follower", "friend"];

export function decodeUser(u: ProtoMessage | undefined, identity?: ProtoMessage): LiveUser {
  const follow = u?.msg(22);
  const followStatus = follow ? FOLLOW_STATUS[follow.num(3)] : undefined;
  return {
    userId: u?.id(1) ?? "",
    uniqueId: u?.str(38) ?? "",
    nickname: u?.str(3) ?? "",
    profilePictureUrl: imageUrl(u?.msg(9)),
    ...(follow ? { followingCount: follow.num(1), followerCount: follow.num(2) } : {}),
    ...(followStatus ? { followStatus } : {}),
    ...(identity
      ? {
          isGifter: identity.bool(1),
          isSubscriber: identity.bool(2),
          isFollower: identity.bool(4),
          isModerator: identity.bool(5),
        }
      : {}),
  };
}

function decodeEmote(e: ProtoMessage | undefined): Emote {
  return { emoteId: e?.str(1) ?? "", imageUrl: imageUrl(e?.msg(2)) };
}

const BATTLE_STATUS: ReadonlyArray<BattleEvent["status"]> = [
  "notStarted",
  "started",
  "finished",
  "punishStarted",
  "punishFinished",
];
const BATTLE_ACTION: ReadonlyArray<BattleEvent["action"]> = [
  "unknown",
  "invite",
  "reject",
  "cancel",
  "open",
  "finish",
  "cutShort",
  "accept",
  "quitApply",
  "declineQuit",
  "declineOffQuit",
  "leaveLinkMic",
];
const BATTLE_RESULT: ReadonlyArray<NonNullable<BattleHost["result"]>> = ["win", "lose", "draw"];

/** Battle participants use a smaller user struct (BattleBaseUserInfo). */
function decodeBattleUser(u: ProtoMessage | undefined): LiveUser {
  return {
    userId: u?.id(1) ?? "",
    uniqueId: u?.str(4) ?? "",
    nickname: u?.str(2) ?? "",
    profilePictureUrl: imageUrl(u?.msg(3)),
  };
}

/** Reads a protobuf map<int64, Message> as [key, value] pairs. */
function mapEntries(m: ProtoMessage, field: number): Array<[string, ProtoMessage | undefined]> {
  return m.msgs(field).map((entry) => [entry.id(1), entry.msg(2)]);
}

type Decoder = (m: ProtoMessage) => LiveEvent | undefined;

const decoders: Record<string, Decoder> = {
  WebcastChatMessage(m) {
    return {
      type: "chat",
      ...base(m),
      user: decodeUser(m.msg(2), m.msg(18)),
      comment: m.str(3),
      emotes: m.msgs(13).map((e) => decodeEmote(e.msg(2))),
    };
  },

  // Chat deletion by a moderator or host. Field numbers: 2=deleted msgIds (packed uint64),
  // 3=user ids whose messages were deleted (packed uint64, may be absent).
  WebcastImDeleteMessage(m) {
    const msgIds = m.ids(2);
    const userIds = m.ids(3);
    if (msgIds.length === 0 && userIds.length === 0) return undefined;
    return { type: "chatDelete", ...base(m), msgIds, userIds };
  },

  WebcastGiftMessage(m) {
    const gift = m.msg(15);
    const giftType = gift?.num(11) ?? 0;
    const repeatCount = m.num(5) || 1;
    const diamondCount = gift?.num(12) ?? 0;
    const toMemberId = m.str(45);
    return {
      type: "gift",
      ...base(m),
      user: decodeUser(m.msg(7), m.msg(32)),
      giftId: m.num(2),
      giftName: gift?.str(16) ?? "",
      giftImageUrl: imageUrl(gift?.msg(1)),
      diamondCount,
      repeatCount,
      // Type 1 gifts are streakable; repeatEnd marks the last event of a streak.
      streaking: giftType === 1 && !m.bool(9),
      totalDiamonds: diamondCount * repeatCount,
      groupId: m.id(11),
      ...(toMemberId && toMemberId !== "0" ? { receiver: { userId: toMemberId, nickname: m.str(47) } } : {}),
    };
  },

  WebcastLikeMessage(m) {
    return {
      type: "like",
      ...base(m),
      user: decodeUser(m.msg(5)),
      likeCount: m.num(2),
      totalLikeCount: m.num(3),
    };
  },

  WebcastMemberMessage(m) {
    // action 1 = joined; other actions are moderation (kick, admin, ...).
    if (m.num(10) !== 1) return undefined;
    return { type: "join", ...base(m), user: decodeUser(m.msg(2)) };
  },

  WebcastSocialMessage(m) {
    const key = common(m).displayKey;
    const action = m.num(4);
    const user = decodeUser(m.msg(2));
    if (key.includes("follow") || (!key && action === 1)) return { type: "follow", ...base(m), user };
    if (key.includes("share") || (!key && action === 3)) return { type: "share", ...base(m), user };
    return undefined;
  },

  WebcastRoomUserSeqMessage(m) {
    return {
      type: "viewers",
      ...base(m),
      viewerCount: m.num(3),
      topViewers: m.msgs(2).map((c) => ({
        user: decodeUser(c.msg(2)),
        coinCount: c.num(1),
        rank: c.num(3),
      })),
    };
  },

  WebcastSubNotifyMessage(m) {
    return { type: "subscribe", ...base(m), user: decodeUser(m.msg(2)), subMonth: m.num(4) };
  },

  WebcastQuestionNewMessage(m) {
    const q = m.msg(2);
    return { type: "question", ...base(m), user: decodeUser(q?.msg(5)), question: q?.str(2) ?? "" };
  },

  WebcastEmoteChatMessage(m) {
    return {
      type: "emote",
      ...base(m),
      user: decodeUser(m.msg(2), m.msg(5)),
      emotes: m.msgs(3).map(decodeEmote),
    };
  },

  WebcastControlMessage(m) {
    const action = m.num(2);
    if (action === 3) return { type: "streamEnd", ...base(m), reason: "ended" };
    if (action === 4) return { type: "streamEnd", ...base(m), reason: "suspended" };
    return undefined;
  },
  // LIVE battles (PK). Field numbers: LinkMicBattle 2=battleId, 3=BattleSetting
  // (2=startTimeMs, 3=duration, 5=status), 4=action, 5=map<userId, BattleResult
  // (2=result, 3=score)>, 10=map<userId, BattleUserInfo(1=BattleBaseUserInfo)>.
  WebcastLinkMicBattle(m): BattleEvent {
    const settings = m.msg(3);
    const results = new Map(mapEntries(m, 5));
    const startedAt = settings?.num(2) ?? 0;
    return {
      type: "battle",
      ...base(m),
      battleId: m.id(2),
      status: BATTLE_STATUS[settings?.num(5) ?? -1] ?? "unknown",
      action: BATTLE_ACTION[m.num(4)] ?? "unknown",
      ...(startedAt ? { startedAt } : {}),
      durationSeconds: settings?.num(3) ?? 0,
      hosts: mapEntries(m, 10).map(([userId, info]): BattleHost => {
        const result = results.get(userId);
        const user = decodeBattleUser(info?.msg(1));
        return {
          user: user.userId ? user : { ...user, userId },
          ...(result ? { score: result.num(3), result: BATTLE_RESULT[result.num(2)] ?? "draw" } : {}),
        };
      }),
    };
  },

  // Battle scores. LinkMicArmies 2=battleId, 3=map<hostId, BattleUserArmies(1=BattleUserArmy[]
  // (1=userId, 2=score, 3=nickname, 4=avatar), 2=hostScore)>, 7=triggerReason (1=score, 2=end).
  WebcastLinkMicArmies(m): BattleScoreEvent {
    const reason = m.num(7);
    return {
      type: "battleScore",
      ...base(m),
      battleId: m.id(2),
      reason: reason === 1 ? "scoreUpdate" : reason === 2 ? "battleEnd" : "other",
      teams: mapEntries(m, 3).map(([hostUserId, armies]) => ({
        hostUserId,
        score: armies?.num(2) ?? 0,
        topGifters: (armies?.msgs(1) ?? [])
          .map((army) => ({
            user: {
              userId: army.id(1),
              uniqueId: "",
              nickname: army.str(3),
              profilePictureUrl: imageUrl(army.msg(4)),
            },
            score: army.num(2),
          }))
          .sort((a, b) => b.score - a.score),
      })),
    };
  },
};

function base(m: ProtoMessage): { timestamp: number; msgId?: string } {
  const { msgId, timestamp } = common(m);
  return msgId ? { timestamp, msgId } : { timestamp };
}

export function isSupportedMethod(method: string): boolean {
  return Object.hasOwn(decoders, method);
}

/** Returns undefined for message types overlays don't need (or variants we skip). */
export function decodeLiveEvent(raw: RawMessage): LiveEvent | undefined {
  const decoder = Object.hasOwn(decoders, raw.method) ? decoders[raw.method] : undefined;
  if (!decoder) return undefined;
  const event = decoder(decode(raw.payload));
  if (event && !event.msgId && raw.msgId && raw.msgId !== "0") return { ...event, msgId: raw.msgId };
  return event;
}
