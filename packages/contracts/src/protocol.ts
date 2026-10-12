/**
 * The JSON protocol spoken between a tiklive server and its clients
 * (overlays, apps) over `ws://host/ws`. See docs/PROTOCOL.md.
 */
import * as Schema from "effect/Schema";
import { LiveEvent, LiveEventType } from "./events.ts";
import { FiredAction } from "./rules.ts";

/** Bumped on breaking changes to any message below. Sent in the `hello` message. */
export const PROTOCOL_VERSION = 1;

/** TikTok handle as used in URLs: lowercase letters, digits, `.` and `_`. */
export const Username = Schema.String.check(Schema.isPattern(/^[a-z0-9._]{1,32}$/));
export type Username = typeof Username.Type;

/** Accepts `name`, `@name`, or a tiktok.com profile/live URL and returns the bare lowercase handle. */
export function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/tiktok\.com\/@([^/?#]+)/i);
  return (fromUrl?.[1] ?? trimmed).replace(/^@/, "").toLowerCase();
}

export const SessionState = Schema.Literals([
  /** Not connected and not trying to. */
  "idle",
  /** Streamer is offline; the server checks periodically and connects when they go live. */
  "waiting",
  "connecting",
  "live",
  /** Permanent failure (e.g. the user doesn't exist). `error` has details. */
  "error",
]);
export type SessionState = typeof SessionState.Type;

/** Running totals for the current stream. Reset each time the streamer goes live. */
export const SessionStats = Schema.Struct({
  likes: Schema.Finite,
  /** Coins from completed gifts (streaks count once, when they end). */
  diamonds: Schema.Finite,
  follows: Schema.Finite,
  shares: Schema.Finite,
  joins: Schema.Finite,
  chats: Schema.Finite,
  viewers: Schema.Finite,
  peakViewers: Schema.Finite,
});
export type SessionStats = typeof SessionStats.Type;

export const RoomOwner = Schema.Struct({
  userId: Schema.String,
  uniqueId: Schema.String,
  nickname: Schema.String,
  profilePictureUrl: Schema.String,
  followerCount: Schema.Finite,
});
export type RoomOwner = typeof RoomOwner.Type;

export const SessionStatus = Schema.Struct({
  username: Schema.String,
  state: SessionState,
  roomId: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  owner: Schema.optionalKey(RoomOwner),
  /** Unix ms when the current stream connection started. */
  liveSince: Schema.optionalKey(Schema.Finite),
  /** Unix ms when TikTok says the stream started. Unlike `liveSince`, it doesn't reset when tiklive reconnects. */
  streamStartedAt: Schema.optionalKey(Schema.Finite),
  /** Stream cover image URL. */
  coverUrl: Schema.optionalKey(Schema.String),
  /** HLS playlist URL for watching the stream. Signed by TikTok and only valid for the current stream. */
  hlsUrl: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  stats: SessionStats,
});
export type SessionStatus = typeof SessionStatus.Type;

/** A TikTok gift from the public gift catalog. */
export const GiftInfo = Schema.Struct({
  giftId: Schema.Finite,
  name: Schema.String,
  /** Price in diamonds (coins). */
  diamondCount: Schema.Finite,
  imageUrl: Schema.String,
  /** Streaks: repeated sends are combined into one event until the streak ends. */
  streakable: Schema.Boolean,
});
export type GiftInfo = typeof GiftInfo.Type;

// ---- client → server ----

export const SubscribeMessage = Schema.Struct({
  action: Schema.tag("subscribe"),
  username: Schema.String,
  /** Only receive these event types. Omit for all events; `[]` for status updates only. */
  events: Schema.optionalKey(Schema.Array(LiveEventType)),
  /** Replay recent events (excluding likes and viewer counts) on subscribe. */
  replay: Schema.optionalKey(Schema.Boolean),
  /** Also receive `action` messages: the actions fired by the server's rules. Default false. */
  actions: Schema.optionalKey(Schema.Boolean),
});
export type SubscribeMessage = typeof SubscribeMessage.Type;

export const UnsubscribeMessage = Schema.Struct({
  action: Schema.tag("unsubscribe"),
  username: Schema.String,
});
export type UnsubscribeMessage = typeof UnsubscribeMessage.Type;

export const ClientMessage = Schema.Union([SubscribeMessage, UnsubscribeMessage]).pipe(
  Schema.toTaggedUnion("action"),
);
export type ClientMessage = typeof ClientMessage.Type;

// ---- server → client ----

/** First message on every connection. */
export const HelloMessage = Schema.Struct({
  type: Schema.tag("hello"),
  protocolVersion: Schema.Finite,
  serverVersion: Schema.String,
});
export type HelloMessage = typeof HelloMessage.Type;

export const EventMessage = Schema.Struct({
  type: Schema.tag("event"),
  username: Schema.String,
  event: LiveEvent,
  /** True for events replayed from history on subscribe. */
  replay: Schema.optionalKey(Schema.Boolean),
});
export type EventMessage = typeof EventMessage.Type;

/** Sent on subscribe, on every state change, and at most once per second while stats change. */
export const StatusMessage = Schema.Struct({
  type: Schema.tag("status"),
  username: Schema.String,
  status: SessionStatus,
});
export type StatusMessage = typeof StatusMessage.Type;

/** A rule fired. Sent only to subscriptions with `actions: true`. Never replayed. */
export const ActionMessage = Schema.Struct({
  type: Schema.tag("action"),
  username: Schema.String,
  action: FiredAction,
});
export type ActionMessage = typeof ActionMessage.Type;

export const ErrorCode = Schema.Literals([
  "invalid_message",
  "invalid_username",
  "too_many_subscriptions",
  "internal",
]);
export type ErrorCode = typeof ErrorCode.Type;

export const ErrorMessage = Schema.Struct({
  type: Schema.tag("error"),
  code: ErrorCode,
  message: Schema.String,
});
export type ErrorMessage = typeof ErrorMessage.Type;

export const ServerMessage = Schema.Union([
  HelloMessage,
  EventMessage,
  StatusMessage,
  ActionMessage,
  ErrorMessage,
]).pipe(Schema.toTaggedUnion("type"));
export type ServerMessage = typeof ServerMessage.Type;
