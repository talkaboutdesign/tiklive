/**
 * Plain HTTPS calls to tiktok.com. None of these require request signing.
 */
import { type GiftInfo, normalizeUsername, type RoomOwner } from "@tiklive/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { TikTokRequestError, UserNotFound } from "./errors.ts";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

export interface RoomStatus {
  readonly roomId: string;
  readonly isLive: boolean;
  readonly title: string;
  readonly viewerCount: number;
  readonly owner: RoomOwner;
  /** Unix ms when TikTok says the stream started. Only set when TikTok reports a start time. */
  readonly streamStartedAt?: number;
  /** Stream cover image URL. Only set when TikTok provides one. */
  readonly coverUrl?: string;
}

export interface TikTokWebOptions {
  readonly userAgent?: string;
}

export class TikTokWeb extends Context.Service<
  TikTokWeb,
  {
    readonly userAgent: string;
    /**
     * Anonymous `ttwid` device cookie the webcast WebSocket requires. TikTok
     * issues one on any plain page load. Cached; pass `refresh` to get a new one.
     */
    readonly getTtwid: (options?: {
      readonly refresh?: boolean;
    }) => Effect.Effect<string, TikTokRequestError>;
    /** Looks up the user's current room and whether it's live. */
    readonly getRoomStatus: (
      username: string,
    ) => Effect.Effect<RoomStatus, UserNotFound | TikTokRequestError>;
    /** The public gift catalog, sorted by price. Not cached here; callers cache. */
    readonly getGifts: () => Effect.Effect<ReadonlyArray<GiftInfo>, TikTokRequestError>;
  }
>()("@tiklive/core/TikTokWeb") {}

const requestError = (message: string, extra: { status?: number; rateLimited?: boolean } = {}) =>
  new TikTokRequestError({ message, ...extra });

export const make = (options: TikTokWebOptions = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    const cachedTtwid = yield* Ref.make(Option.none<string>());

    const headers = (extra: Record<string, string> = {}) => ({
      "User-Agent": userAgent,
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.tiktok.com/",
      ...extra,
    });

    const fetchTtwid = client.get("https://www.tiktok.com/", { headers: headers() }).pipe(
      Effect.mapError((cause) => requestError(`Failed to load tiktok.com: ${cause.message}`)),
      Effect.flatMap((res) =>
        Option.match(Cookies.getValue(res.cookies, "ttwid"), {
          onNone: () =>
            Effect.fail(
              requestError(`TikTok did not issue a ttwid cookie (HTTP ${res.status})`, {
                status: res.status,
                rateLimited: res.status === 429,
              }),
            ),
          onSome: (ttwid) => Effect.succeed(ttwid),
        }),
      ),
      Effect.tap((ttwid) => Ref.set(cachedTtwid, Option.some(ttwid))),
    );

    const getTtwid = (opts: { readonly refresh?: boolean } = {}) =>
      Effect.flatMap(Ref.get(cachedTtwid), (cached) =>
        Option.isSome(cached) && !opts.refresh ? Effect.succeed(cached.value) : fetchTtwid,
      );

    const getRoomStatus = (username: string) =>
      Effect.gen(function* () {
        const uniqueId = normalizeUsername(username);
        const params = new URLSearchParams({
          aid: "1988",
          app_name: "tiktok_web",
          device_platform: "web_pc",
          uniqueId,
          sourceType: "54",
        });
        const res = yield* client
          .get(`https://www.tiktok.com/api-live/user/room/?${params}`, {
            headers: headers({ Accept: "application/json" }),
          })
          .pipe(Effect.mapError((cause) => requestError(`Room lookup failed: ${cause.message}`)));
        if (res.status < 200 || res.status >= 300) {
          return yield* requestError(`Room lookup failed with HTTP ${res.status}`, {
            status: res.status,
            rateLimited: res.status === 429,
          });
        }
        const text = yield* res.text.pipe(
          Effect.mapError((cause) => requestError(`Room lookup failed: ${cause.message}`)),
        );
        if (!text) {
          return yield* requestError("Room lookup returned an empty response (likely rate limited)", {
            status: res.status,
            rateLimited: true,
          });
        }
        const body = yield* Effect.try({
          try: () => JSON.parse(text) as RoomApiResponse,
          catch: () => requestError("Room lookup returned invalid JSON", { status: res.status }),
        });
        if (body.statusCode === 19881007 || !body.data?.user) {
          return yield* new UserNotFound({ username: uniqueId });
        }
        if (body.statusCode) {
          return yield* requestError(`Room lookup failed: ${body.message ?? body.statusCode}`);
        }

        const { user, liveRoom, stats } = body.data;
        const startTime = liveRoom?.startTime ?? 0;
        return {
          roomId: user.roomId ?? "",
          // liveRoom.status: 2 = live, 4 = ended.
          isLive: liveRoom?.status === 2 && !!user.roomId,
          title: liveRoom?.title ?? "",
          viewerCount: liveRoom?.liveRoomStats?.userCount ?? 0,
          owner: {
            userId: user.id ?? "",
            uniqueId: user.uniqueId ?? uniqueId,
            nickname: user.nickname ?? "",
            profilePictureUrl: user.avatarThumb ?? "",
            followerCount: stats?.followerCount ?? 0,
          },
          ...(startTime > 0 ? { streamStartedAt: startTime * 1000 } : {}),
          ...(liveRoom?.coverUrl ? { coverUrl: liveRoom.coverUrl } : {}),
        } satisfies RoomStatus;
      });

    const getGifts = () =>
      Effect.gen(function* () {
        const params = new URLSearchParams({
          aid: "1988",
          app_name: "tiktok_web",
          device_platform: "web_pc",
          browser_language: "en-US",
        });
        const res = yield* client
          .get(`https://webcast.tiktok.com/webcast/gift/list/?${params}`, {
            headers: headers({ Accept: "application/json" }),
          })
          .pipe(Effect.mapError((cause) => requestError(`Gift list failed: ${cause.message}`)));
        if (res.status < 200 || res.status >= 300) {
          return yield* requestError(`Gift list failed with HTTP ${res.status}`, {
            status: res.status,
            rateLimited: res.status === 429,
          });
        }
        const text = yield* res.text.pipe(
          Effect.mapError((cause) => requestError(`Gift list failed: ${cause.message}`)),
        );
        const body = yield* Effect.try({
          try: () => JSON.parse(text) as GiftApiResponse | null,
          catch: () => requestError("Gift list returned invalid JSON", { status: res.status }),
        });
        if (body?.status_code) {
          return yield* requestError(`Gift list failed: ${body.status_code}`);
        }
        return parseGiftList(body);
      });

    return TikTokWeb.of({ userAgent, getTtwid, getRoomStatus, getGifts });
  });

/** TikTokWeb backed by an `HttpClient` you provide (e.g. one routed through a proxy). */
export const layerWith = (
  options: TikTokWebOptions = {},
): Layer.Layer<TikTokWeb, never, HttpClient.HttpClient> => Layer.effect(TikTokWeb, make(options));

/** TikTokWeb using the runtime's global `fetch`. */
export const layer = (options: TikTokWebOptions = {}): Layer.Layer<TikTokWeb> =>
  layerWith(options).pipe(Layer.provide(FetchHttpClient.layer));

/** Maps the gift catalog response to `GiftInfo`, skipping entries without an id or name. */
export const parseGiftList = (body: unknown): ReadonlyArray<GiftInfo> => {
  const gifts = (body as GiftApiResponse | null | undefined)?.data?.gifts;
  if (!Array.isArray(gifts)) return [];
  return gifts
    .flatMap((gift) => {
      if (typeof gift?.id !== "number" || typeof gift.name !== "string") return [];
      return [
        {
          giftId: gift.id,
          name: gift.name,
          diamondCount: gift.diamond_count ?? 0,
          imageUrl: gift.image?.url_list?.[0] ?? "",
          // Type 1 gifts are streakable (repeated sends combine until the streak ends).
          streakable: gift.type === 1,
        },
      ];
    })
    .sort((a, b) => a.diamondCount - b.diamondCount || a.name.localeCompare(b.name));
};

interface GiftApiResponse {
  status_code?: number;
  data?: {
    gifts?: Array<{
      id?: number;
      name?: string;
      diamond_count?: number;
      type?: number;
      image?: { url_list?: Array<string> };
    } | null>;
  };
}

interface RoomApiResponse {
  statusCode?: number;
  message?: string;
  data?: {
    user?: {
      id?: string;
      uniqueId?: string;
      nickname?: string;
      avatarThumb?: string;
      roomId?: string;
      status?: number;
    };
    stats?: { followerCount?: number };
    liveRoom?: {
      status?: number;
      title?: string;
      liveRoomStats?: { userCount?: number };
      /** Unix seconds. */
      startTime?: number;
      coverUrl?: string;
    };
  };
}
