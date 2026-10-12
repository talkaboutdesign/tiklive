/**
 * Sound search on MyInstants (myinstants.com) for the action editor. Browsers can't call the site
 * (no CORS), so the server reads its public search page. Results are cached for 10 minutes.
 * Imports copy the MP3 into the media library, so overlays never depend on myinstants.com.
 * Downloads are limited to MyInstants sound URLs, and redirects are refused.
 */
import { MAX_MEDIA_BYTES, type SoundSearchResponse, type SoundSearchResult } from "@tiklive/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const ORIGIN = "https://www.myinstants.com";
const SEARCH_TIMEOUT = "10 seconds";
const DOWNLOAD_TIMEOUT = "20 seconds";
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const MAX_QUERY_LENGTH = 100;
const MAX_PAGE = 50;
/** A full page has 36 results. Fewer than this means the search is exhausted. */
const MORE_THRESHOLD = 30;
const UNREACHABLE = "Couldn't reach MyInstants";
const DOWNLOAD_FAILED = "Couldn't download that sound from MyInstants";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" };

type Fetch = typeof globalThis.fetch;

/** A MyInstants request failed, or the input was refused. `message` is safe to show the user. */
export class SoundSearchError extends Schema.TaggedError<SoundSearchError>()("SoundSearchError", {
  message: Schema.String,
}) {}

export class SoundSearch extends Context.Service<
  SoundSearch,
  {
    /** One page of MyInstants results. `query` is trimmed; 1–100 chars. Cached for 10 minutes. */
    readonly search: (query: string, page: number) => Effect.Effect<SoundSearchResponse, SoundSearchError>;
    /** Downloads an allowed MyInstants MP3. Fails for any other URL, non-audio responses, or files over MAX_MEDIA_BYTES. */
    readonly download: (url: string) => Effect.Effect<Uint8Array, SoundSearchError>;
  }
>()("@tiklive/server/SoundSearch") {}

/** The trimmed query, or undefined when it isn't 1 to 100 characters. */
export const cleanQuery = (raw: string): string | undefined => {
  const query = raw.trim();
  return query.length >= 1 && query.length <= MAX_QUERY_LENGTH ? query : undefined;
};

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes named and numeric entities in one pass, so `&amp;lt;` becomes `&lt;`. Unknown ones are kept. */
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });

const BLOCK_START = /<div\s+class="instant"\s*>/;
const PLAY = /\bplay\('(\/media\/sounds\/[^']+?\.mp3)'/;
const LINK = /<a\b([^>]*\bclass="[^"]*\binstant-link\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/;
const HREF = /\bhref="([^"]*)"/;
const TAGS = /<[^>]*>/g;
const SOUND_PATH = /^\/media\/sounds\/[A-Za-z0-9._%-]+\.mp3$/;

/**
 * The sounds on one search page. Blocks without a playable MP3 or a title are skipped, and so are
 * sounds whose URL `isAllowedSoundUrl` would refuse, since they couldn't be imported anyway.
 */
export const parseResults = (html: string): ReadonlyArray<SoundSearchResult> => {
  const seen = new Set<string>();
  const results: Array<SoundSearchResult> = [];
  for (const block of html.split(BLOCK_START).slice(1)) {
    const play = PLAY.exec(block);
    const link = LINK.exec(block);
    if (!play || !link) continue;
    const title = decodeEntities((link[2] ?? "").replace(TAGS, "")).trim();
    if (!title) continue;
    const url = ORIGIN + (play[1] ?? "");
    if (seen.has(url) || !isAllowedSoundUrl(url)) continue;
    seen.add(url);
    const href = HREF.exec(link[1] ?? "")?.[1] ?? "";
    const pageUrl = href.startsWith("/") ? ORIGIN + href : `${ORIGIN}/`;
    results.push({ title, url, pageUrl });
  }
  return results;
};

/**
 * True only for `https://www.myinstants.com/media/sounds/<file>.mp3` (or the bare host), with no
 * credentials, port, query or fragment. Query strings are refused: sound links never need one.
 */
export const isAllowedSoundUrl = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    (url.hostname === "www.myinstants.com" || url.hostname === "myinstants.com") &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    SOUND_PATH.test(url.pathname)
  );
};

const clampPage = (page: number): number =>
  Number.isFinite(page) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(page))) : 1;

const searchFailure = (message: string) => new SoundSearchError({ message });

interface CacheEntry {
  readonly at: number;
  readonly response: SoundSearchResponse;
}

const make = (fetchFn: Fetch) => {
  const cache = new Map<string, CacheEntry>();

  /** One search page. The signal aborts the request when the effect is interrupted (timeout). */
  const fetchPage = async (url: string, signal: AbortSignal): Promise<SoundSearchResponse["results"]> => {
    const res = await fetchFn(url, { headers: HEADERS, signal });
    const html = await res.text();
    // A search with no results answers 404.
    if (res.status === 404) return [];
    if (!res.ok) throw searchFailure(`MyInstants returned HTTP ${res.status}`);
    return parseResults(html);
  };

  const search = (raw: string, page: number) =>
    Effect.gen(function* () {
      const query = cleanQuery(raw);
      if (query === undefined) return yield* Effect.fail(searchFailure("Type 1 to 100 characters"));
      const pageNumber = clampPage(page);
      const key = `${pageNumber}:${query.toLowerCase()}`;

      const now = yield* Clock.currentTimeMillis;
      const hit = cache.get(key);
      if (hit && now - hit.at < CACHE_TTL_MS) return hit.response;
      cache.delete(key);

      const params = new URLSearchParams({ name: query, page: String(pageNumber) });
      const results = yield* Effect.tryPromise({
        try: (signal) => fetchPage(`${ORIGIN}/en/search/?${params}`, signal),
        catch: (cause) => (cause instanceof SoundSearchError ? cause : searchFailure(UNREACHABLE)),
      }).pipe(
        Effect.timeoutOrElse({
          duration: SEARCH_TIMEOUT,
          orElse: () => Effect.fail(searchFailure(UNREACHABLE)),
        }),
      );

      const response: SoundSearchResponse = {
        results,
        page: pageNumber,
        hasMore: results.length >= MORE_THRESHOLD && pageNumber < MAX_PAGE,
      };
      if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { at: yield* Clock.currentTimeMillis, response });
      return response;
    });

  /** Fetches the MP3 and reads it with a running byte count. Throws SoundSearchError for every refusal. */
  const readSound = async (url: string, signal: AbortSignal): Promise<Uint8Array> => {
    // A redirect would send the server to a host it wasn't asked to visit, so it's an error.
    const res = await fetchFn(url, { headers: HEADERS, redirect: "error", signal });
    if (!res.ok) throw searchFailure(`MyInstants returned HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("audio/")) throw searchFailure("That link isn't an audio file");
    const declared = res.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_MEDIA_BYTES) throw searchFailure("File is over 25 MB");

    const reader = res.body?.getReader();
    if (!reader) throw searchFailure("That sound file is empty");
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) {
        await reader.cancel();
        throw searchFailure("File is over 25 MB");
      }
      chunks.push(value);
    }
    if (total === 0) throw searchFailure("That sound file is empty");

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };

  const download = (url: string) =>
    Effect.gen(function* () {
      if (!isAllowedSoundUrl(url)) {
        return yield* Effect.fail(searchFailure("Only MyInstants sound links can be imported"));
      }
      return yield* Effect.tryPromise({
        try: (signal) => readSound(url, signal),
        catch: (cause) => (cause instanceof SoundSearchError ? cause : searchFailure(DOWNLOAD_FAILED)),
      }).pipe(
        Effect.timeoutOrElse({
          duration: DOWNLOAD_TIMEOUT,
          orElse: () => Effect.fail(searchFailure("MyInstants took too long to send that sound")),
        }),
      );
    });

  return SoundSearch.of({ search, download });
};

/** Uses the runtime's global `fetch` unless a `fetch` is given (tests). */
export const layer = (options: { readonly fetch?: Fetch } = {}): Layer.Layer<SoundSearch> =>
  Layer.effect(
    SoundSearch,
    Effect.sync(() => make(options.fetch ?? globalThis.fetch)),
  );
