/**
 * Maps raw TikTok webcast messages onto normalized {@link LiveEvent}s.
 *
 * Field numbers come from TikTok's webcast protobuf schemas. Each decoder only
 * reads the handful of fields overlays need.
 */
import type { Emote, LiveEvent, LiveUser } from '../events.js';
import type { RawMessage } from './frames.js';
import { decode, type ProtoMessage } from './wire.js';

/** Common header present as field 1 on every webcast message. */
function common(m: ProtoMessage): { msgId: string; timestamp: number; displayKey: string } {
  const c = m.msg(1);
  const createTime = c?.num(4) ?? 0;
  return {
    msgId: c?.id(2) ?? '',
    // createTime is ms on most messages but occasionally seconds.
    timestamp: createTime === 0 ? Date.now() : createTime < 1e12 ? createTime * 1000 : createTime,
    displayKey: c?.msg(8)?.str(1) ?? '',
  };
}

function imageUrl(image: ProtoMessage | undefined): string {
  return image?.strs(1)[0] ?? '';
}

export function decodeUser(u: ProtoMessage | undefined, identity?: ProtoMessage): LiveUser {
  const user: LiveUser = {
    userId: u?.id(1) ?? '',
    uniqueId: u?.str(38) ?? '',
    nickname: u?.str(3) ?? '',
    profilePictureUrl: imageUrl(u?.msg(9)),
  };
  if (identity) {
    user.isGifter = identity.bool(1);
    user.isSubscriber = identity.bool(2);
    user.isFollower = identity.bool(4);
    user.isModerator = identity.bool(5);
  }
  return user;
}

function decodeEmote(e: ProtoMessage | undefined): Emote {
  return { emoteId: e?.str(1) ?? '', imageUrl: imageUrl(e?.msg(2)) };
}

type Decoder = (m: ProtoMessage) => LiveEvent | undefined;

const decoders: Record<string, Decoder> = {
  WebcastChatMessage(m) {
    return {
      type: 'chat',
      ...base(m),
      user: decodeUser(m.msg(2), m.msg(18)),
      comment: m.str(3),
      emotes: m.msgs(13).map((e) => decodeEmote(e.msg(2))),
    };
  },

  WebcastGiftMessage(m) {
    const gift = m.msg(15);
    const giftType = gift?.num(11) ?? 0;
    const repeatCount = m.num(5) || 1;
    const diamondCount = gift?.num(12) ?? 0;
    const toMemberId = m.str(45);
    return {
      type: 'gift',
      ...base(m),
      user: decodeUser(m.msg(7), m.msg(32)),
      giftId: m.num(2),
      giftName: gift?.str(16) ?? '',
      giftImageUrl: imageUrl(gift?.msg(1)),
      diamondCount,
      repeatCount,
      // Type 1 gifts are streakable; repeatEnd marks the last event of a streak.
      streaking: giftType === 1 && !m.bool(9),
      totalDiamonds: diamondCount * repeatCount,
      groupId: m.id(11),
      ...(toMemberId && toMemberId !== '0'
        ? { receiver: { userId: toMemberId, nickname: m.str(47) } }
        : {}),
    };
  },

  WebcastLikeMessage(m) {
    return {
      type: 'like',
      ...base(m),
      user: decodeUser(m.msg(5)),
      likeCount: m.num(2),
      totalLikeCount: m.num(3),
    };
  },

  WebcastMemberMessage(m) {
    // action 1 = joined; other actions are moderation (kick, admin, ...).
    if (m.num(10) !== 1) return undefined;
    return { type: 'join', ...base(m), user: decodeUser(m.msg(2)) };
  },

  WebcastSocialMessage(m) {
    const key = common(m).displayKey;
    const action = m.num(4);
    const user = decodeUser(m.msg(2));
    if (key.includes('follow') || (!key && action === 1)) return { type: 'follow', ...base(m), user };
    if (key.includes('share') || (!key && action === 3)) return { type: 'share', ...base(m), user };
    return undefined;
  },

  WebcastRoomUserSeqMessage(m) {
    return {
      type: 'viewers',
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
    return { type: 'subscribe', ...base(m), user: decodeUser(m.msg(2)), subMonth: m.num(4) };
  },

  WebcastQuestionNewMessage(m) {
    const q = m.msg(2);
    return { type: 'question', ...base(m), user: decodeUser(q?.msg(5)), question: q?.str(2) ?? '' };
  },

  WebcastEmoteChatMessage(m) {
    return {
      type: 'emote',
      ...base(m),
      user: decodeUser(m.msg(2), m.msg(5)),
      emotes: m.msgs(3).map(decodeEmote),
    };
  },

  WebcastControlMessage(m) {
    const action = m.num(2);
    if (action === 3) return { type: 'streamEnd', ...base(m), reason: 'ended' };
    if (action === 4) return { type: 'streamEnd', ...base(m), reason: 'suspended' };
    return undefined;
  },
};

function base(m: ProtoMessage): { timestamp: number; msgId?: string } {
  const { msgId, timestamp } = common(m);
  return msgId ? { timestamp, msgId } : { timestamp };
}

export function isSupportedMethod(method: string): boolean {
  return method in decoders;
}

/** Returns undefined for message types overlays don't need (or variants we skip). */
export function decodeLiveEvent(raw: RawMessage): LiveEvent | undefined {
  const decoder = decoders[raw.method];
  if (!decoder) return undefined;
  const event = decoder(decode(raw.payload));
  if (event && !event.msgId && raw.msgId && raw.msgId !== '0') event.msgId = raw.msgId;
  return event;
}
