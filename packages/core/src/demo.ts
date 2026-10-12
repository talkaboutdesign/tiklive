import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { LiveEvent, LiveUser } from "@tiklive/contracts";

// [handle, followerCount, followStatus, gifterLevel]: a mix of friends, followers and low-follower
// strangers, with gifter levels from newcomers to big spenders.
const NAMES: ReadonlyArray<readonly [string, number, NonNullable<LiveUser["followStatus"]>, number]> = [
  ["pixelpanda", 1840, "friend", 36],
  ["nightowl", 312, "follower", 12],
  ["lofi.luna", 25300, "follower", 47],
  ["capt.crunch", 4, "none", 3],
  ["mochi_mia", 960, "friend", 22],
  ["turbo.tim", 0, "none", 1],
  ["starlight", 7120, "none", 31],
  ["bytebandit", 58, "follower", 8],
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
// Real gift art from TikTok's CDN (same URLs the gift catalog returns), so demo overlays look like a live stream.
const CDN = "https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/";
const GIFTS = [
  {
    giftId: 5655,
    giftName: "Rose",
    giftImageUrl: `${CDN}eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp`,
    diamondCount: 1,
    streakable: true,
  },
  {
    giftId: 5269,
    giftName: "TikTok",
    giftImageUrl: `${CDN}802a21ae29f9fae5abe3693de9f874bd~tplv-obj.webp`,
    diamondCount: 1,
    streakable: true,
  },
  {
    giftId: 5827,
    giftName: "Ice Cream Cone",
    giftImageUrl: `${CDN}968820bc85e274713c795a6aef3f7c67~tplv-obj.webp`,
    diamondCount: 1,
    streakable: true,
  },
  {
    giftId: 6064,
    giftName: "GG",
    giftImageUrl: `${CDN}3f02fa9594bd1495ff4e8aa5ae265eef~tplv-obj.webp`,
    diamondCount: 1,
    streakable: true,
  },
  {
    giftId: 5487,
    giftName: "Finger Heart",
    giftImageUrl: `${CDN}a4c4dc437fd3a6632aba149769491f49.png~tplv-obj.webp`,
    diamondCount: 5,
    streakable: true,
  },
  {
    giftId: 6267,
    giftName: "Corgi",
    giftImageUrl: `${CDN}148eef0884fdb12058d1c6897d1e02b9~tplv-obj.webp`,
    diamondCount: 299,
    streakable: false,
  },
  {
    giftId: 11046,
    giftName: "Galaxy",
    giftImageUrl: `${CDN}resource/79a02148079526539f7599150da9fd28.png~tplv-obj.webp`,
    diamondCount: 1000,
    streakable: false,
  },
];

const GOAL_TARGET = 100;

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

function fakeUser(): LiveUser {
  return userFor(pick(NAMES));
}

function userFor(entry: (typeof NAMES)[number]): LiveUser {
  const [name, followerCount, followStatus, gifterLevel] = entry;
  return {
    userId: String(1000 + NAMES.indexOf(entry)),
    uniqueId: name,
    nickname: name.replace(/[._]/g, " "),
    profilePictureUrl: `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(name)}`,
    gifterLevel,
    followerCount,
    followingCount: 150,
    followStatus,
    isFollower: followStatus !== "none",
  };
}

interface GiftStreak {
  gift: (typeof GIFTS)[number];
  user: LiveUser;
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
  // A Rose goal that fills up and then restarts with a new goalId.
  let goal = { id: 1, progress: 0 };

  const base = () => ({ timestamp: Date.now(), msgId: `demo-${++seq}` });

  const goalEvent = (): LiveEvent => {
    goal.progress = Math.min(GOAL_TARGET, goal.progress + 1 + Math.floor(Math.random() * 6));
    // Three different viewers, with the top one contributing about half of the progress.
    const contributors = NAMES.slice(0, 3).map((entry, i) => {
      const user = userFor(entry);
      return {
        user: {
          userId: user.userId,
          nickname: user.nickname,
          profilePictureUrl: user.profilePictureUrl,
        },
        count: Math.max(1, Math.round(goal.progress * [0.5, 0.3, 0.2][i]!)),
      };
    });
    const event: LiveEvent = {
      type: "goal",
      ...base(),
      goalId: String(goal.id),
      description: "GIFT GAL",
      goals: [
        {
          kind: "gift",
          giftId: 5655,
          giftName: "Rose",
          giftImageUrl: `${CDN}eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp`,
          progress: goal.progress,
          target: GOAL_TARGET,
        },
      ],
      contributors: contributors.sort((a, b) => b.count - a.count),
      endsAt: Date.now() + 2 * 60 * 60 * 1000,
    };
    if (goal.progress >= GOAL_TARGET) goal = { id: goal.id + 1, progress: 0 };
    return event;
  };

  const giftEvent = (s: GiftStreak): LiveEvent => {
    s.sent++;
    const streaking = s.gift.streakable && s.sent < s.total;
    return {
      type: "gift",
      ...base(),
      user: s.user,
      giftId: s.gift.giftId,
      giftName: s.gift.giftName,
      giftImageUrl: s.gift.giftImageUrl,
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
    } else if (roll < 0.99) {
      return goalEvent();
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
