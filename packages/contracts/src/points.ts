/**
 * Viewer points (loyalty): what viewers earn for chatting, gifting and liking, the
 * per-streamer leaderboard, and the bodies of the points REST routes. Points are
 * kept by the server per streamer and survive stream restarts. See docs/user/points.md.
 */
import * as Schema from "effect/Schema";

const Amount = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 0, maximum }));

/** How many points each action is worth. Whole numbers only. */
export const PointsSettings = Schema.Struct({
  /** Points for a chat message. */
  perMessage: Amount(1_000),
  /** A viewer earns chat points at most once per this many seconds. 0 means every message. */
  messageCooldownSeconds: Amount(86_400),
  /** One point per this many likes. Likes add up across batches, so 20 likes give one point. */
  likesPerPoint: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  /** Points per coin of a completed gift (a combo counts once, when it ends). */
  perCoin: Amount(1_000),
  perFollow: Amount(100_000),
  perShare: Amount(100_000),
  perSubscribe: Amount(100_000),
  perJoin: Amount(100_000),
});
export type PointsSettings = typeof PointsSettings.Type;

export const DEFAULT_POINTS_SETTINGS: PointsSettings = {
  perMessage: 1,
  messageCooldownSeconds: 60,
  likesPerPoint: 20,
  perCoin: 10,
  perFollow: 50,
  perShare: 20,
  perSubscribe: 200,
  perJoin: 0,
};

/** One viewer's running totals for a streamer. */
export const ViewerPoints = Schema.Struct({
  userId: Schema.String,
  /** The @handle, without the @. */
  uniqueId: Schema.String,
  nickname: Schema.String,
  profilePictureUrl: Schema.String,
  points: Schema.Finite,
  /** Lifetime coins from completed gifts. */
  coins: Schema.Finite,
  /** Lifetime chat messages, including those that didn't earn points. */
  messages: Schema.Finite,
  /** Unix ms of the viewer's first counted event for this streamer. */
  firstSeen: Schema.Finite,
  /** Unix ms of the viewer's latest counted event for this streamer. */
  lastSeen: Schema.Finite,
});
export type ViewerPoints = typeof ViewerPoints.Type;

/** A page of the leaderboard, best first. */
export const PointsLeaderboard = Schema.Struct({
  settings: PointsSettings,
  viewers: Schema.Array(ViewerPoints),
  /** How many viewers match `q` (all viewers when there is no `q`). */
  total: Schema.Finite,
});
export type PointsLeaderboard = typeof PointsLeaderboard.Type;

/** Body of `PATCH /api/sessions/:username/points/:userId`. Send exactly one of `delta` or `set`. */
export const PointsAdjustRequest = Schema.Struct({
  /** Adds this many points (negative takes points away). The total never goes below 0. */
  delta: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: -1_000_000_000, maximum: 1_000_000_000 })),
  ),
  /** Sets the total to this value. */
  set: Schema.optionalKey(Amount(1_000_000_000)),
});
export type PointsAdjustRequest = typeof PointsAdjustRequest.Type;
