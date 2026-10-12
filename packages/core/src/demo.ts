import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { LiveEvent, LiveUser } from "@tiklive/contracts";

const NAMES = [
  "pixelpanda",
  "nightowl",
  "lofi.luna",
  "capt.crunch",
  "mochi_mia",
  "turbo.tim",
  "starlight",
  "bytebandit",
];
const COMMENTS = [
  "hello!! 👋",
  "this is so cool",
  "W stream",
  "first time here",
  "lets gooo 🔥",
  "how long have you been live?",
  "GG",
  "😂😂😂",
];
const GIFTS = [
  { giftId: 5655, giftName: "Rose", diamondCount: 1, streakable: true },
  { giftId: 5269, giftName: "TikTok", diamondCount: 1, streakable: true },
  { giftId: 5827, giftName: "Ice Cream Cone", diamondCount: 1, streakable: true },
  { giftId: 6064, giftName: "GG", diamondCount: 1, streakable: true },
  { giftId: 5487, giftName: "Finger Heart", diamondCount: 5, streakable: true },
  { giftId: 6267, giftName: "Corgi", diamondCount: 299, streakable: false },
  { giftId: 7934, giftName: "Galaxy", diamondCount: 1000, streakable: false },
];

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

function fakeUser(): LiveUser {
  const name = pick(NAMES);
  return {
    userId: String(1000 + NAMES.indexOf(name)),
    uniqueId: name,
    nickname: name.replace(/[._]/g, " "),
    profilePictureUrl: `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(name)}`,
  };
}

interface GiftStreak {
  gift: (typeof GIFTS)[number];
  user: LiveUser;
  giftImageUrl: string;
  groupId: string;
  total: number;
  sent: number;
}

/**
 * Endless stream of plausible fake events, roughly 2–4 per second. Used so
 * overlays can be built and tested without anyone being live. Selected with the
 * username `demo`.
 */
export const demoEvents: Stream.Stream<LiveEvent> = Stream.suspend(() => {
  // Fresh state per subscriber.
  let likes = 0;
  let viewers = 120;
  let seq = 0;
  let streak: GiftStreak | undefined;
  // msgIds of chat messages not yet deleted, so chatDelete events point at real chat.
  const recentChats: string[] = [];

  const base = () => ({ timestamp: Date.now(), msgId: `demo-${++seq}` });

  const giftEvent = (s: GiftStreak): LiveEvent => {
    s.sent++;
    const streaking = s.gift.streakable && s.sent < s.total;
    return {
      type: "gift",
      ...base(),
      user: s.user,
      giftId: s.gift.giftId,
      giftName: s.gift.giftName,
      giftImageUrl: s.giftImageUrl,
      diamondCount: s.gift.diamondCount,
      repeatCount: s.sent,
      streaking,
      totalDiamonds: s.gift.diamondCount * s.sent,
      groupId: s.groupId,
    };
  };

  const nextEvent = (): LiveEvent => {
    // A gift streak in progress emits its next repeat before anything else.
    if (streak) {
      const event = giftEvent(streak);
      if (streak.sent >= streak.total) streak = undefined;
      return event;
    }

    // Occasionally a moderator deletes one of the recent chat messages.
    if (recentChats.length > 0 && Math.random() < 0.03) {
      const [msgId] = recentChats.splice(Math.floor(Math.random() * recentChats.length), 1);
      return { type: "chatDelete", ...base(), msgIds: [msgId!], userIds: [] };
    }

    const roll = Math.random();
    if (roll < 0.35) {
      const chat = {
        type: "chat" as const,
        ...base(),
        user: fakeUser(),
        comment: pick(COMMENTS),
        emotes: [],
      };
      recentChats.push(chat.msgId);
      if (recentChats.length > 20) recentChats.shift();
      return chat;
    } else if (roll < 0.55) {
      const likeCount = 1 + Math.floor(Math.random() * 15);
      likes += likeCount;
      return { type: "like", ...base(), user: fakeUser(), likeCount, totalLikeCount: likes };
    } else if (roll < 0.68) {
      return { type: "join", ...base(), user: fakeUser() };
    } else if (roll < 0.78) {
      viewers = Math.max(1, viewers + Math.floor(Math.random() * 21) - 8);
      return { type: "viewers", ...base(), viewerCount: viewers, topViewers: [] };
    } else if (roll < 0.88) {
      const gift = pick(GIFTS);
      const total = gift.streakable ? 1 + Math.floor(Math.random() * 8) : 1;
      streak = {
        gift,
        user: fakeUser(),
        giftImageUrl: `https://api.dicebear.com/9.x/icons/svg?seed=${encodeURIComponent(gift.giftName)}`,
        groupId: String(Date.now()),
        total,
        sent: 0,
      };
      const event = giftEvent(streak);
      if (streak.sent >= streak.total) streak = undefined;
      return event;
    } else if (roll < 0.94) {
      return { type: "follow", ...base(), user: fakeUser() };
    } else if (roll < 0.98) {
      return { type: "share", ...base(), user: fakeUser() };
    } else {
      return { type: "subscribe", ...base(), user: fakeUser(), subMonth: 1 + Math.floor(Math.random() * 6) };
    }
  };

  // Each tick waits 250–750ms, then emits one event (70%) or a burst of two.
  const tick = Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(250 + Math.random() * 500));
    const count = Math.random() < 0.7 ? 1 : 2;
    return Array.from({ length: count }, nextEvent);
  });

  return Stream.fromEffectRepeat(tick).pipe(Stream.flattenIterable);
});
