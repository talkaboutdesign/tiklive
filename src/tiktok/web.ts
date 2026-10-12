/**
 * Plain HTTPS calls to tiktok.com. None of these require request signing.
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

export class TikTokRequestError extends Error {}
export class UserNotFoundError extends Error {}

export interface RoomStatus {
  roomId: string;
  isLive: boolean;
  title: string;
  viewerCount: number;
  owner: {
    userId: string;
    uniqueId: string;
    nickname: string;
    profilePictureUrl: string;
    followerCount: number;
  };
}

/** Accepts `name`, `@name`, or a full tiktok.com profile/live URL. */
export function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/tiktok\.com\/@([^/?#]+)/i);
  return (fromUrl ? fromUrl[1]! : trimmed).replace(/^@/, '').toLowerCase();
}

export class TikTokWeb {
  private ttwid: string | undefined;

  constructor(
    readonly userAgent: string = DEFAULT_USER_AGENT,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'User-Agent': this.userAgent,
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.tiktok.com/',
      ...extra,
    };
  }

  /**
   * Anonymous `ttwid` device cookie that the webcast WebSocket requires.
   * TikTok issues one on any plain page load; it's cached per instance.
   */
  async getTtwid(forceRefresh = false): Promise<string> {
    if (this.ttwid && !forceRefresh) return this.ttwid;
    const res = await this.fetchImpl('https://www.tiktok.com/', { headers: this.headers(), redirect: 'manual' });
    for (const cookie of res.headers.getSetCookie()) {
      const match = cookie.match(/^ttwid=([^;]+)/);
      if (match) {
        this.ttwid = match[1]!;
        return this.ttwid;
      }
    }
    throw new TikTokRequestError(`TikTok did not issue a ttwid cookie (HTTP ${res.status})`);
  }

  /** Looks up the user's current room and whether it's live. */
  async getRoomStatus(username: string): Promise<RoomStatus> {
    const uniqueId = normalizeUsername(username);
    const params = new URLSearchParams({
      aid: '1988',
      app_name: 'tiktok_web',
      device_platform: 'web_pc',
      uniqueId,
      sourceType: '54',
    });
    const res = await this.fetchImpl(`https://www.tiktok.com/api-live/user/room/?${params}`, {
      headers: this.headers({ Accept: 'application/json' }),
    });
    if (!res.ok) throw new TikTokRequestError(`Room lookup failed with HTTP ${res.status}`);

    const text = await res.text();
    if (!text) throw new TikTokRequestError('Room lookup returned an empty response (possibly rate limited)');
    const body = JSON.parse(text) as RoomApiResponse;

    if (body.statusCode === 19881007 || !body.data?.user) {
      throw new UserNotFoundError(`TikTok user @${uniqueId} not found`);
    }
    if (body.statusCode) {
      throw new TikTokRequestError(`Room lookup failed: ${body.message ?? body.statusCode}`);
    }

    const { user, liveRoom, stats } = body.data;
    return {
      roomId: user.roomId ?? '',
      // 2 = live, 4 = ended.
      isLive: liveRoom?.status === 2 && !!user.roomId,
      title: liveRoom?.title ?? '',
      viewerCount: liveRoom?.liveRoomStats?.userCount ?? 0,
      owner: {
        userId: user.id ?? '',
        uniqueId: user.uniqueId ?? uniqueId,
        nickname: user.nickname ?? '',
        profilePictureUrl: user.avatarThumb ?? '',
        followerCount: stats?.followerCount ?? 0,
      },
    };
  }
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
    };
  };
}
