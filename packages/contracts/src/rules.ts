/**
 * Actions: rules like "when someone sends a Rose, play a sound and show a GIF".
 *
 * The server stores the rules and evaluates them against every event. Each match
 * produces a `FiredAction`, which goes to the clients that subscribed with
 * `actions: true` (usually the `/overlays/actions.html` player in OBS). The player
 * runs the steps; the server never talks to OBS or plays anything itself.
 */
import * as Result from "effect/Result";
import * as Url from "effect/http/Url";
import * as Schema from "effect/Schema";
import { LiveUser } from "./events.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const NonEmptyText = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const Range = (minimum: number, maximum: number) =>
  Schema.Finite.check(Schema.isBetween({ minimum, maximum }));

/**
 * A media file: `/media/<file>` for files uploaded to this server, or an http(s) URL.
 * Anything else (`javascript:`, `data:`, relative paths) is rejected.
 */
export const MediaUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^(\/media\/[A-Za-z0-9][A-Za-z0-9._-]*|https?:\/\/[^\s]+)$/, {
    expected: "an uploaded file (/media/...) or an http(s) URL",
  }),
);
export type MediaUrl = typeof MediaUrl.Type;

// ---- triggers ----

/** Fires when a gift combo ends (`streaking: false`), once per combo. */
export const GiftTrigger = Schema.Struct({
  type: Schema.tag("gift"),
  /** Only this gift. Omit for any gift. */
  giftId: Schema.optionalKey(Schema.Finite),
  /** The gift's name, for display in the editor. Not used for matching. */
  giftName: Schema.optionalKey(Text(100)),
  /** Minimum coins for the whole combo (`totalDiamonds`). Default 0. */
  minCoins: Schema.optionalKey(Range(0, 1_000_000_000)),
  /** Run the steps once per gift in the combo (at most 10 times) instead of once per combo. */
  perGift: Schema.optionalKey(Schema.Boolean),
});
export type GiftTrigger = typeof GiftTrigger.Type;

export const FollowTrigger = Schema.Struct({ type: Schema.tag("follow") });
export const ShareTrigger = Schema.Struct({ type: Schema.tag("share") });
export const SubscribeTrigger = Schema.Struct({ type: Schema.tag("subscribe") });

/**
 * Who may trigger a rule. `everyone` is the default. `followers` includes friends (mutual
 * follows). `friends` is only viewers who follow the streamer and whom the streamer follows back.
 */
export const ChatAudience = Schema.Literals([
  "everyone",
  "followers",
  "friends",
  "subscribers",
  "moderators",
]);
export type ChatAudience = typeof ChatAudience.Type;

/**
 * Viewers with at least this many followers may trigger the rule. Followers and friends of
 * the streamer always pass, and so does a viewer whose follower count TikTok didn't send.
 */
const MinFollowers = Range(0, 1_000_000_000);

export const ChatTrigger = Schema.Struct({
  type: Schema.tag("chat"),
  /**
   * `command`: the message's first word equals `text`, ignoring case (`!dance` matches "!dance now").
   * `contains`: `text` appears anywhere, ignoring case. `any`: every chat message.
   */
  match: Schema.Literals(["command", "contains", "any"]),
  /** Required for `command` and `contains`. An empty `text` never matches. */
  text: Schema.optionalKey(Text(100)),
  from: Schema.optionalKey(ChatAudience),
  minFollowers: Schema.optionalKey(MinFollowers),
});
export type ChatTrigger = typeof ChatTrigger.Type;

/**
 * Fires when a viewer joins the stream. Only joins TikTok reports as joins; viewers who
 * were already watching don't count.
 */
export const JoinTrigger = Schema.Struct({
  type: Schema.tag("join"),
  /** Who may trigger it. Default everyone. */
  from: Schema.optionalKey(ChatAudience),
  minFollowers: Schema.optionalKey(MinFollowers),
  /**
   * Each viewer triggers it at most once per stream. The count resets when the stream
   * ends (`streamEnd`). Default true.
   */
  oncePerStream: Schema.optionalKey(Schema.Boolean),
});
export type JoinTrigger = typeof JoinTrigger.Type;

/** Fires every time the stream's like count passes another multiple of `every`. */
export const LikesTrigger = Schema.Struct({
  type: Schema.tag("likes"),
  every: Range(1, 1_000_000_000),
});
export type LikesTrigger = typeof LikesTrigger.Type;

export const RuleTrigger = Schema.Union([
  GiftTrigger,
  FollowTrigger,
  ShareTrigger,
  SubscribeTrigger,
  ChatTrigger,
  JoinTrigger,
  LikesTrigger,
]).pipe(Schema.toTaggedUnion("type"));
export type RuleTrigger = typeof RuleTrigger.Type;
export type RuleTriggerType = RuleTrigger["type"];

// ---- steps ----
// Text fields in rules are templates (see TEMPLATE_VARIABLES). In a FiredAction they're already filled in.

export const SoundStep = Schema.Struct({
  kind: Schema.tag("sound"),
  url: MediaUrl,
  /** 0 to 1. Default 1. */
  volume: Schema.optionalKey(Range(0, 1)),
});
export type SoundStep = typeof SoundStep.Type;

/** Shows an image, GIF or video in the middle of the overlay. */
export const MediaStep = Schema.Struct({
  kind: Schema.tag("media"),
  url: MediaUrl,
  /** Seconds on screen. Default: 5 for images, the video's length for videos (at most 60). */
  duration: Schema.optionalKey(Range(0.5, 120)),
  /** Caption under the media. */
  text: Schema.optionalKey(Text(300)),
  /** Video volume, 0 to 1. Default 1. */
  volume: Schema.optionalKey(Range(0, 1)),
});
export type MediaStep = typeof MediaStep.Type;

/** Text-to-speech, spoken by the player with the browser's speech engine. */
export const SpeakStep = Schema.Struct({
  kind: Schema.tag("speak"),
  text: NonEmptyText(300),
  /** A voice name from `speechSynthesis.getVoices()`. Falls back to the default voice. */
  voice: Schema.optionalKey(Text(200)),
  /** 0.5 to 2. Default 1. */
  rate: Schema.optionalKey(Range(0.5, 2)),
  /** 0 to 1. Default 1. */
  volume: Schema.optionalKey(Range(0, 1)),
});
export type SpeakStep = typeof SpeakStep.Type;

/**
 * Switches the OBS scene. Works only when the player runs as an OBS browser source
 * with page permissions set to "Advanced access to OBS".
 */
export const ObsSceneStep = Schema.Struct({
  kind: Schema.tag("obsScene"),
  scene: NonEmptyText(200),
  /** Switch back to the previous scene after this many seconds. Omit to stay. */
  revertAfter: Schema.optionalKey(Range(1, 3600)),
});
export type ObsSceneStep = typeof ObsSceneStep.Type;

/**
 * An http(s) URL that parses, with a literal scheme. Templates such as `{nickname}` are allowed
 * anywhere after it. Their values are percent-encoded when filled in, so they suit the path and query.
 */
export const WebhookUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((url: string) => /^https?:\/\//i.test(url) && Result.isSuccess(Url.fromString(url)), {
    expected: "an http:// or https:// URL",
  }),
);
export type WebhookUrl = typeof WebhookUrl.Type;

/**
 * Sends an HTTP request from the computer running tiklive when the action runs. The server
 * sends it; the browser player skips this step. Requests time out after 5 seconds and are
 * not retried.
 */
export const WebhookStep = Schema.Struct({
  kind: Schema.tag("webhook"),
  url: WebhookUrl,
  /** Default POST. GET ignores `body`. */
  method: Schema.optionalKey(Schema.Literals(["POST", "GET", "PUT"])),
  /**
   * Sent as-is for POST and PUT: as application/json if it parses as JSON, otherwise as text/plain.
   * Omit it to send a JSON description of the action (see docs/user/actions.md).
   */
  body: Schema.optionalKey(Text(4000)),
});
export type WebhookStep = typeof WebhookStep.Type;

export const RuleStep = Schema.Union([SoundStep, MediaStep, SpeakStep, ObsSceneStep, WebhookStep]).pipe(
  Schema.toTaggedUnion("kind"),
);
export type RuleStep = typeof RuleStep.Type;
export type RuleStepKind = RuleStep["kind"];

/**
 * Placeholders allowed in step text, including a webhook's URL and body (URL values are
 * percent-encoded). Unknown placeholders are left as typed.
 * `count`, `coins` and `giftName` are empty for non-gift triggers; `comment` for non-chat ones.
 * `followers` is the viewer's follower count, empty when TikTok didn't send it.
 */
export const TEMPLATE_VARIABLES = [
  "nickname",
  "username",
  "giftName",
  "count",
  "coins",
  "comment",
  "likes",
  "months",
  "followers",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

// ---- rules ----

export const RuleId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
export type RuleId = typeof RuleId.Type;

export const Rule = Schema.Struct({
  id: RuleId,
  name: Text(100),
  enabled: Schema.Boolean,
  trigger: RuleTrigger,
  /** Run together, when the player reaches this action in its queue. */
  steps: Schema.Array(RuleStep).check(Schema.isMaxLength(10)),
  /** Seconds before the rule can fire again for anyone. Default 0. */
  cooldown: Schema.optionalKey(Range(0, 86_400)),
  /** Seconds before the same viewer can trigger it again. Default 0. */
  userCooldown: Schema.optionalKey(Range(0, 86_400)),
});
export type Rule = typeof Rule.Type;

/** Every rule, plus a revision number that goes up on each save (for conflict checks). */
export const RuleSet = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rules: Schema.Array(Rule).check(Schema.isMaxLength(200)),
});
export type RuleSet = typeof RuleSet.Type;

/** Body of `PUT /api/rules`. `revision` is the one the client last read. */
export const SaveRulesRequest = RuleSet;
export type SaveRulesRequest = typeof SaveRulesRequest.Type;

// ---- fired actions (server → player) ----

export const FiredAction = Schema.Struct({
  /** Unique per firing. */
  id: Schema.String,
  ruleId: Schema.String,
  ruleName: Schema.String,
  /** Unix ms when the rule fired. */
  timestamp: Schema.Finite,
  /** The viewer who triggered it. Absent for like milestones without a user. */
  user: Schema.optionalKey(LiveUser),
  /** From the editor's Test button rather than a real event. */
  test: Schema.optionalKey(Schema.Boolean),
  /** Templates already filled in. */
  steps: Schema.Array(RuleStep),
});
export type FiredAction = typeof FiredAction.Type;

// ---- media library ----

export const MediaKind = Schema.Literals(["image", "video", "audio"]);
export type MediaKind = typeof MediaKind.Type;

export const MediaItem = Schema.Struct({
  id: Schema.String,
  /** Original file name, for display. */
  name: Schema.String,
  kind: MediaKind,
  contentType: Schema.String,
  /** Bytes. */
  size: Schema.Finite,
  /** Where it's served, `/media/<file>`. Use this as a step's `url`. */
  url: Schema.String,
  createdAt: Schema.Finite,
});
export type MediaItem = typeof MediaItem.Type;

/** Upload types the server accepts, and the file extension it stores each one under. SVG is not allowed. */
export const MEDIA_TYPES = {
  "image/png": { kind: "image", ext: ".png" },
  "image/jpeg": { kind: "image", ext: ".jpg" },
  "image/gif": { kind: "image", ext: ".gif" },
  "image/webp": { kind: "image", ext: ".webp" },
  "video/mp4": { kind: "video", ext: ".mp4" },
  "video/webm": { kind: "video", ext: ".webm" },
  "audio/mpeg": { kind: "audio", ext: ".mp3" },
  "audio/wav": { kind: "audio", ext: ".wav" },
  "audio/ogg": { kind: "audio", ext: ".ogg" },
  "audio/mp4": { kind: "audio", ext: ".m4a" },
} as const satisfies Record<string, { kind: MediaKind; ext: string }>;
export type MediaContentType = keyof typeof MEDIA_TYPES;

/** Largest upload the server accepts: 25 MB. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

// ---- sound search (MyInstants) ----

/** One result from `GET /api/sounds/search`. */
export const SoundSearchResult = Schema.Struct({
  title: Schema.String,
  /** Direct MP3 link on myinstants.com. Fine for previews; import it before using it in a rule. */
  url: Schema.String,
  /** The sound's page on myinstants.com. */
  pageUrl: Schema.String,
});
export type SoundSearchResult = typeof SoundSearchResult.Type;

export const SoundSearchResponse = Schema.Struct({
  results: Schema.Array(SoundSearchResult),
  page: Schema.Finite,
  /** Another page may have more results. */
  hasMore: Schema.Boolean,
});
export type SoundSearchResponse = typeof SoundSearchResponse.Type;

/**
 * Body of `POST /api/media/import`: copies a sound from a search result into the media
 * library. Only `https://www.myinstants.com/media/sounds/<file>.mp3` URLs are accepted.
 */
export const ImportMediaRequest = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  /** Display name for the library. Defaults to the file name. */
  name: Schema.optionalKey(Text(200)),
});
export type ImportMediaRequest = typeof ImportMediaRequest.Type;

/** Body of `PATCH /api/media/:id`. */
export const RenameMediaRequest = Schema.Struct({
  /** New display name. The file and its URL don't change, so rules that use it keep working. */
  name: NonEmptyText(200),
});
export type RenameMediaRequest = typeof RenameMediaRequest.Type;
