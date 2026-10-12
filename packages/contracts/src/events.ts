/**
 * Normalized, JSON-serializable LIVE events. This is the public contract that
 * apps and overlays consume, so it's deliberately flat and decoupled from
 * TikTok's raw protobuf messages.
 *
 * Every event has a `type` discriminator, a `timestamp` (unix ms) and usually
 * a `msgId`. Schemas double as runtime validators (e.g. for injected test
 * events) and as the source of the exported TypeScript types.
 */
import * as Schema from "effect/Schema";

const Count = Schema.Finite;

export const LiveUser = Schema.Struct({
  userId: Schema.String,
  /** The @handle, without the @. */
  uniqueId: Schema.String,
  nickname: Schema.String,
  profilePictureUrl: Schema.String,
  /** Present when TikTok includes viewer→streamer relationship data. */
  isModerator: Schema.optionalKey(Schema.Boolean),
  isSubscriber: Schema.optionalKey(Schema.Boolean),
  isFollower: Schema.optionalKey(Schema.Boolean),
  isGifter: Schema.optionalKey(Schema.Boolean),
});
export type LiveUser = typeof LiveUser.Type;

export const Emote = Schema.Struct({
  emoteId: Schema.String,
  imageUrl: Schema.String,
});
export type Emote = typeof Emote.Type;

export const TopViewer = Schema.Struct({
  user: LiveUser,
  coinCount: Count,
  rank: Count,
});
export type TopViewer = typeof TopViewer.Type;

const base = {
  /** Unix ms when TikTok created the message (falls back to receive time). */
  timestamp: Count,
  msgId: Schema.optionalKey(Schema.String),
};

export const ChatEvent = Schema.Struct({
  type: Schema.tag("chat"),
  ...base,
  user: LiveUser,
  comment: Schema.String,
  emotes: Schema.Array(Emote),
});
export type ChatEvent = typeof ChatEvent.Type;

/**
 * Chat messages were deleted by a moderator or the host. Remove any rendered chat
 * message whose `msgId` is in `msgIds`. `userIds` carries user IDs when TikTok
 * includes them, and is usually empty.
 */
export const ChatDeleteEvent = Schema.Struct({
  type: Schema.tag("chatDelete"),
  ...base,
  /** msgIds of earlier `chat` events that were deleted. */
  msgIds: Schema.Array(Schema.String),
  userIds: Schema.Array(Schema.String),
});
export type ChatDeleteEvent = typeof ChatDeleteEvent.Type;

export const GiftEvent = Schema.Struct({
  type: Schema.tag("gift"),
  ...base,
  user: LiveUser,
  giftId: Count,
  giftName: Schema.String,
  giftImageUrl: Schema.String,
  /** Coin value of one gift. */
  diamondCount: Count,
  /** Running count within the current combo/streak. */
  repeatCount: Count,
  /**
   * Streakable gifts fire repeatedly while the viewer holds the combo; only the
   * final event has `streaking: false`. Alerts and totals should use that one.
   */
  streaking: Schema.Boolean,
  /** diamondCount × repeatCount. */
  totalDiamonds: Count,
  groupId: Schema.String,
  /** Set when the gift went to a co-host/guest rather than the streamer. */
  receiver: Schema.optionalKey(Schema.Struct({ userId: Schema.String, nickname: Schema.String })),
});
export type GiftEvent = typeof GiftEvent.Type;

export const LikeEvent = Schema.Struct({
  type: Schema.tag("like"),
  ...base,
  user: LiveUser,
  likeCount: Count,
  totalLikeCount: Count,
});
export type LikeEvent = typeof LikeEvent.Type;

export const FollowEvent = Schema.Struct({ type: Schema.tag("follow"), ...base, user: LiveUser });
export type FollowEvent = typeof FollowEvent.Type;

export const ShareEvent = Schema.Struct({ type: Schema.tag("share"), ...base, user: LiveUser });
export type ShareEvent = typeof ShareEvent.Type;

export const JoinEvent = Schema.Struct({ type: Schema.tag("join"), ...base, user: LiveUser });
export type JoinEvent = typeof JoinEvent.Type;

export const SubscribeEvent = Schema.Struct({
  type: Schema.tag("subscribe"),
  ...base,
  user: LiveUser,
  subMonth: Count,
});
export type SubscribeEvent = typeof SubscribeEvent.Type;

export const QuestionEvent = Schema.Struct({
  type: Schema.tag("question"),
  ...base,
  user: LiveUser,
  question: Schema.String,
});
export type QuestionEvent = typeof QuestionEvent.Type;

export const EmoteEvent = Schema.Struct({
  type: Schema.tag("emote"),
  ...base,
  user: LiveUser,
  emotes: Schema.Array(Emote),
});
export type EmoteEvent = typeof EmoteEvent.Type;

export const ViewerCountEvent = Schema.Struct({
  type: Schema.tag("viewers"),
  ...base,
  viewerCount: Count,
  topViewers: Schema.Array(TopViewer),
});
export type ViewerCountEvent = typeof ViewerCountEvent.Type;

export const StreamEndEvent = Schema.Struct({
  type: Schema.tag("streamEnd"),
  ...base,
  reason: Schema.Literals(["ended", "suspended"]),
});
export type StreamEndEvent = typeof StreamEndEvent.Type;

export const BattleHost = Schema.Struct({
  user: LiveUser,
  /** Points at the end of the battle. Present on finished battles. */
  score: Schema.optionalKey(Count),
  result: Schema.optionalKey(Schema.Literals(["win", "lose", "draw"])),
});
export type BattleHost = typeof BattleHost.Type;

/** A LIVE battle (PK) between hosts changed state: started, finished, etc. */
export const BattleEvent = Schema.Struct({
  type: Schema.tag("battle"),
  ...base,
  battleId: Schema.String,
  status: Schema.Literals([
    "notStarted",
    "started",
    "finished",
    "punishStarted",
    "punishFinished",
    "unknown",
  ]),
  /** What triggered this update, e.g. "open" when it starts, "finish"/"cutShort" when it ends. */
  action: Schema.Literals([
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
    "unknown",
  ]),
  /** Unix ms. */
  startedAt: Schema.optionalKey(Count),
  durationSeconds: Count,
  hosts: Schema.Array(BattleHost),
});
export type BattleEvent = typeof BattleEvent.Type;

export const BattleGifter = Schema.Struct({ user: LiveUser, score: Count });
export type BattleGifter = typeof BattleGifter.Type;

export const BattleTeam = Schema.Struct({
  /** userId of the host this team supports. Matches `BattleEvent.hosts[].user.userId`. */
  hostUserId: Schema.String,
  score: Count,
  /** Top supporters, highest first. */
  topGifters: Schema.Array(BattleGifter),
});
export type BattleTeam = typeof BattleTeam.Type;

/** Live battle scores. Sent whenever points change during a battle. */
export const BattleScoreEvent = Schema.Struct({
  type: Schema.tag("battleScore"),
  ...base,
  battleId: Schema.String,
  reason: Schema.Literals(["scoreUpdate", "battleEnd", "other"]),
  teams: Schema.Array(BattleTeam),
});
export type BattleScoreEvent = typeof BattleScoreEvent.Type;

/** Any event that originates from TikTok. Use `LiveEvent.match` / `LiveEvent.guards` to branch on `type`. */
export const LiveEvent = Schema.Union([
  ChatEvent,
  ChatDeleteEvent,
  GiftEvent,
  LikeEvent,
  FollowEvent,
  ShareEvent,
  JoinEvent,
  SubscribeEvent,
  QuestionEvent,
  EmoteEvent,
  ViewerCountEvent,
  StreamEndEvent,
  BattleEvent,
  BattleScoreEvent,
]).pipe(Schema.toTaggedUnion("type"));
export type LiveEvent = typeof LiveEvent.Type;

export type LiveEventType = LiveEvent["type"];
export type LiveEventOf<T extends LiveEventType> = Extract<LiveEvent, { readonly type: T }>;

export const LIVE_EVENT_TYPES = LiveEvent.discriminants as ReadonlyArray<LiveEventType>;
export const LiveEventType = Schema.Literals(LIVE_EVENT_TYPES);
