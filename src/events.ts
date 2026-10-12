/**
 * Normalized, JSON-serializable events. This is the public contract that
 * overlays consume, so it's deliberately flat and decoupled from TikTok's
 * raw protobuf schemas.
 */

export interface LiveUser {
  userId: string;
  /** The @handle. */
  uniqueId: string;
  nickname: string;
  profilePictureUrl: string;
  /** Present when TikTok includes viewer→streamer relationship data. */
  isModerator?: boolean;
  isSubscriber?: boolean;
  isFollower?: boolean;
  isGifter?: boolean;
}

export interface Emote {
  emoteId: string;
  imageUrl: string;
}

interface Base<T extends string> {
  type: T;
  /** Unix ms when TikTok created the message (falls back to receive time). */
  timestamp: number;
  msgId?: string;
}

export interface ChatEvent extends Base<'chat'> {
  user: LiveUser;
  comment: string;
  emotes: Emote[];
}

export interface GiftEvent extends Base<'gift'> {
  user: LiveUser;
  giftId: number;
  giftName: string;
  giftImageUrl: string;
  /** Coin value of one gift. */
  diamondCount: number;
  /** Running count within the current combo/streak. */
  repeatCount: number;
  /**
   * Streakable gifts fire repeatedly while the viewer holds the combo; only the
   * final event has `streaking: false`. Alerts should usually wait for that.
   */
  streaking: boolean;
  /** diamondCount × repeatCount. */
  totalDiamonds: number;
  groupId: string;
  /** Set when the gift went to a co-host/guest rather than the streamer. */
  receiver?: { userId: string; nickname: string };
}

export interface LikeEvent extends Base<'like'> {
  user: LiveUser;
  likeCount: number;
  totalLikeCount: number;
}

export interface FollowEvent extends Base<'follow'> {
  user: LiveUser;
}

export interface ShareEvent extends Base<'share'> {
  user: LiveUser;
}

export interface JoinEvent extends Base<'join'> {
  user: LiveUser;
}

export interface SubscribeEvent extends Base<'subscribe'> {
  user: LiveUser;
  subMonth: number;
}

export interface QuestionEvent extends Base<'question'> {
  user: LiveUser;
  question: string;
}

export interface EmoteEvent extends Base<'emote'> {
  user: LiveUser;
  emotes: Emote[];
}

export interface TopViewer {
  user: LiveUser;
  coinCount: number;
  rank: number;
}

export interface ViewerCountEvent extends Base<'viewers'> {
  viewerCount: number;
  topViewers: TopViewer[];
}

export interface StreamEndEvent extends Base<'streamEnd'> {
  reason: 'ended' | 'suspended';
}

/** Events that originate from TikTok. */
export type LiveEvent =
  | ChatEvent
  | GiftEvent
  | LikeEvent
  | FollowEvent
  | ShareEvent
  | JoinEvent
  | SubscribeEvent
  | QuestionEvent
  | EmoteEvent
  | ViewerCountEvent
  | StreamEndEvent;

export type LiveEventType = LiveEvent['type'];

export const LIVE_EVENT_TYPES: readonly LiveEventType[] = [
  'chat',
  'gift',
  'like',
  'follow',
  'share',
  'join',
  'subscribe',
  'question',
  'emote',
  'viewers',
  'streamEnd',
];

export type LiveEventOf<T extends LiveEventType> = Extract<LiveEvent, { type: T }>;
