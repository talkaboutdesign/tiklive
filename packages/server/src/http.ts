/**
 * HTTP + WebSocket surface of the tiklive server: the overlay WebSocket
 * (`/ws`), the REST API (`/api/*`), the client bundle (`/tiklive.js`) and
 * optional static files. See docs/PROTOCOL.md.
 */
import pkg from "../package.json" with { type: "json" };
import { TikTokWeb } from "@tiklive/core";
import {
  ClientMessage,
  ImportMediaRequest,
  RenameMediaRequest,
  LIVE_EVENT_TYPES,
  LiveEvent,
  LiveEventType,
  MAX_MEDIA_BYTES,
  normalizeUsername,
  PointsAdjustRequest,
  PointsSettings,
  PROTOCOL_VERSION,
  SaveRulesRequest,
  Username,
  type ErrorCode,
  type LiveEventType as LiveEventTypeT,
  type ServerMessage,
} from "@tiklive/contracts";
import { timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { PointsStore } from "./points/PointsStore.ts";
import { MediaStore } from "./rules/MediaStore.ts";
import { RuleEngine } from "./rules/RuleEngine.ts";
import { RulesStore } from "./rules/RulesStore.ts";
import { cleanQuery, isAllowedSoundUrl, SoundSearch } from "./rules/SoundSearch.ts";
import { SessionManager } from "./SessionManager.ts";

export interface HttpOptions {
  /** Require this token as `Authorization: Bearer` or `?token=` for the API and WebSocket. */
  readonly token?: string;
  /**
   * Custom authorization; overrides `token`. Return true to allow the request.
   * Runs for `/api/*` (except health) and `/ws`.
   */
  readonly authorize?: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<boolean>;
  /**
   * Hostnames the server accepts in the `Host` header, which blocks DNS-rebinding
   * attacks against a server on localhost. Default: localhost, 127.0.0.1, [::1].
   * `"any"` disables the check (use with a token when exposing the server).
   */
  readonly allowedHosts?: ReadonlyArray<string> | "any";
  /**
   * Extra origins allowed to call the API and WebSocket from a browser, e.g.
   * `https://my-overlay-app.example`. Same-origin pages and non-browser clients
   * (OBS, curl, Node) are always allowed.
   */
  readonly allowedOrigins?: ReadonlyArray<string>;
  /** Serve this directory (dashboard, overlays). */
  readonly staticDir?: string;
  /** Path to the built browser client, served at `/tiklive.js`. */
  readonly clientBundle?: string;
  /**
   * Files held in memory, keyed by URL path (e.g. "/index.html", "/overlays/chat.html", "/tiklive.js").
   * Used when `staticDir` is not set; `/tiklive.js` falls back to it when `clientBundle` is missing.
   * Directory URLs map to their `index.html`. The filesystem is never read for these.
   */
  readonly assets?: ReadonlyMap<string, Uint8Array>;
  /** Max streamers one WebSocket may follow. Default 20. */
  readonly maxSubscriptionsPerSocket?: number;
  /** Sent in `hello`. Defaults to this package's version. */
  readonly serverVersion?: string;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const STATIC_HEADERS = {
  ...SECURITY_HEADERS,
  "cache-control": "no-cache",
  // Overlays are plain HTML with inline scripts/styles; remote images (avatars, gifts) are allowed.
  // The dashboard's video preview fetches the HLS playlist and segments from TikTok's video CDNs.
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; connect-src 'self' ws: wss: https://*.tiktokcdn.com https://*.tiktokcdn-us.com https://*.tiktokcdn-eu.com; frame-ancestors 'self'",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

/** Uploaded media is immutable (names are random ids), so browsers and OBS may cache it for a year. */
const MEDIA_HEADERS = {
  ...SECURITY_HEADERS,
  "cache-control": "public, max-age=31536000, immutable",
};

/** Largest JSON body accepted by `PUT /api/rules`. */
const MAX_RULES_BODY = 1024 * 1024;
/** Largest JSON body accepted by `POST /api/rules/:id/test`. */
const MAX_TEST_BODY = 16 * 1024;
/** Largest JSON body accepted by `POST /api/media/import`. */
const MAX_IMPORT_BODY = 16 * 1024;
const MAX_RENAME_BODY = 4 * 1024;
/** Largest JSON body accepted by the points settings and adjust endpoints. */
const MAX_POINTS_BODY = 4 * 1024;

const MEDIA_STATUS = { unsupported: 415, tooLarge: 413, disabled: 503, io: 500 } as const;

/** Makes simulated msgIds unique even when two arrive in the same millisecond (clients dedupe replays by msgId). */
let simulateSeq = 0;

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: SECURITY_HEADERS });
const jsonError = (status: number, message: string) => json({ error: message }, status);

/**
 * Reads the whole request body, or gives up once it passes `max` bytes, so an oversized upload is
 * never buffered. Node and Bun have different body limits, so this doesn't rely on either.
 */
const readBytes = (
  request: HttpServerRequest.HttpServerRequest,
  max: number,
): Effect.Effect<Uint8Array | "tooLarge" | "unreadable"> =>
  Effect.gen(function* () {
    const declared = request.headers["content-length"];
    if (declared !== undefined && Number(declared) > max) return "tooLarge" as const;
    const chunks: Array<Uint8Array> = [];
    let total = 0;
    let tooLarge = false;
    // Past `max` the rest is read and discarded, up to twice `max`. Stopping at once would destroy the
    // socket before the 413 can be written. Past twice `max` the connection is dropped.
    const stopAt = max * 2;
    const read = yield* Effect.result(
      Stream.runForEachWhile(request.stream, (chunk) =>
        Effect.sync(() => {
          total += chunk.length;
          if (total > max) tooLarge = true;
          else chunks.push(chunk);
          return total <= stopAt;
        }),
      ),
    );
    if (tooLarge) return "tooLarge" as const;
    if (read._tag === "Failure") return "unreadable" as const;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  });

const isJsonRequest = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["content-type"]?.toLowerCase().startsWith("application/json") === true;

type JsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: HttpServerResponse.HttpServerResponse };

/** The request's JSON body, or the error response to send: 415, 413, 400. */
const readJson = (request: HttpServerRequest.HttpServerRequest, max: number): Effect.Effect<JsonBody> =>
  Effect.gen(function* () {
    const fail = (status: number, message: string): JsonBody => ({
      ok: false,
      response: jsonError(status, message),
    });
    if (!isJsonRequest(request)) return fail(415, "Content-Type must be application/json");
    const bytes = yield* readBytes(request, max);
    if (bytes === "tooLarge") return fail(413, "Body too large");
    if (bytes === "unreadable") return fail(400, "Could not read the body");
    try {
      return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
    } catch {
      return fail(400, "Body must be JSON");
    }
  });

/** The first problem in a schema error, as one short line. */
const firstProblem = (message: string) => {
  const [first = "", second = ""] = message.split("\n");
  const at = second.trim();
  const line = at.startsWith("at ") ? `${first.trim()} ${at}` : first.trim();
  return line.slice(0, 300) || "Invalid rules";
};

/** Decodes a header value that is percent-encoded. Falls back to `fallback` when it isn't valid. */
const decodeHeader = (raw: string | undefined, fallback: string) => {
  if (raw === undefined) return fallback;
  try {
    return decodeURIComponent(raw) || fallback;
  } catch {
    return fallback;
  }
};

export const routes = (options: HttpOptions = {}) => {
  const maxSubscriptions = options.maxSubscriptionsPerSocket ?? 20;
  const allowedHosts = options.allowedHosts ?? LOOPBACK_HOSTS;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const staticRoot = options.staticDir ? resolve(options.staticDir) : undefined;
  const assets = options.assets;

  /** Host/Origin checks. Returns an error response, or undefined when the request may proceed. */
  const checkRequest = (request: HttpServerRequest.HttpServerRequest, url: URL) => {
    const host = request.headers.host ?? "";
    if (allowedHosts !== "any") {
      const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
      if (!allowedHosts.includes(hostname.toLowerCase())) return jsonError(403, "Host not allowed");
    }
    const origin = request.headers.origin;
    if (origin && origin !== `${url.protocol}//${host}` && !allowedOrigins.has(origin)) {
      return jsonError(403, "Origin not allowed");
    }
    return undefined;
  };

  const authorized = (request: HttpServerRequest.HttpServerRequest, url: URL): Effect.Effect<boolean> => {
    if (options.authorize) return options.authorize(request);
    const expected = options.token;
    if (!expected) return Effect.succeed(true);
    const header = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const given = Buffer.from(header ?? url.searchParams.get("token") ?? "");
    const wanted = Buffer.from(expected);
    return Effect.succeed(given.length === wanted.length && timingSafeEqual(given, wanted));
  };

  const requestUrl = (request: HttpServerRequest.HttpServerRequest) =>
    Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"));

  /** Wraps a handler with Host/Origin checks and authorization. */
  const guarded =
    <E, R>(
      handler: (
        request: HttpServerRequest.HttpServerRequest,
        url: URL,
      ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ) =>
    (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const url = requestUrl(request);
        const rejected = checkRequest(request, url);
        if (rejected) return rejected;
        if (!(yield* authorized(request, url))) return jsonError(401, "Unauthorized");
        return yield* handler(request, url);
      });

  const parseUsername = (raw: string) => {
    const name = normalizeUsername(decodeURIComponent(raw));
    return Schema.is(Username)(name) ? name : undefined;
  };

  // ---- REST ----

  const health = HttpRouter.add("GET", "/api/health", json({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  const listSessions = HttpRouter.add(
    "GET",
    "/api/sessions",
    guarded(() =>
      Effect.gen(function* () {
        const manager = yield* SessionManager;
        return json({ sessions: yield* manager.list });
      }),
    ),
  );

  const sessionRoute = HttpRouter.add(
    "*",
    "/api/sessions/:username",
    guarded((request) =>
      Effect.gen(function* () {
        const manager = yield* SessionManager;
        const params = yield* HttpRouter.params;
        const username = parseUsername(params.username ?? "");
        if (!username) return jsonError(400, "Invalid username");
        switch (request.method) {
          case "GET": {
            const session = yield* manager.get(username);
            if (Option.isNone(session)) return jsonError(404, `No session for @${username}`);
            return json(yield* session.value.status);
          }
          case "PUT":
          case "POST": {
            const session = yield* manager.watch(username);
            return json({ ...(yield* session.status), watching: true });
          }
          case "DELETE":
            yield* manager.unwatch(username);
            return json({ ok: true });
          default:
            return jsonError(405, "Method not allowed");
        }
      }),
    ),
  );

  const simulateRoute = HttpRouter.add(
    "POST",
    "/api/sessions/:username/simulate",
    guarded((request) =>
      Effect.gen(function* () {
        const manager = yield* SessionManager;
        const params = yield* HttpRouter.params;
        const username = parseUsername(params.username ?? "");
        if (!username) return jsonError(400, "Invalid username");
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          return jsonError(415, "Content-Type must be application/json");
        }
        const session = yield* manager.get(username);
        if (Option.isNone(session)) return jsonError(404, `No session for @${username}`);
        const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
        if (text.length > 64 * 1024) return jsonError(413, "Body too large");
        let body: unknown;
        try {
          body = JSON.parse(text || "{}");
        } catch {
          return jsonError(400, "Body must be JSON");
        }
        const now = Date.now();
        const candidate =
          body && typeof body === "object"
            ? { timestamp: now, msgId: `sim-${now}-${++simulateSeq}`, ...body }
            : body;
        const decoded = Schema.decodeUnknownExit(LiveEvent)(candidate);
        if (decoded._tag === "Failure") {
          return jsonError(
            400,
            `Invalid event. "type" must be one of: ${LIVE_EVENT_TYPES.join(", ")}, with that event's fields`,
          );
        }
        yield* session.value.inject(decoded.value);
        return json({ ok: true, event: decoded.value });
      }),
    ),
  );

  // ---- Actions: rules and media library ----

  const rulesRoute = HttpRouter.add(
    "*",
    "/api/rules",
    guarded((request) =>
      Effect.gen(function* () {
        const store = yield* RulesStore;
        switch (request.method) {
          case "GET":
            return json(yield* store.get);
          case "PUT": {
            const parsed = yield* readJson(request, MAX_RULES_BODY);
            if (!parsed.ok) return parsed.response;
            const decoded = Schema.decodeUnknownExit(SaveRulesRequest)(parsed.value);
            if (decoded._tag === "Failure") {
              const problem = Exit.findErrorOption(decoded);
              return jsonError(
                400,
                Option.isSome(problem) ? firstProblem(problem.value.message) : "Invalid rules",
              );
            }
            const seen = new Set<string>();
            for (const rule of decoded.value.rules) {
              if (seen.has(rule.id)) return jsonError(400, `Duplicate rule id: ${rule.id}`);
              seen.add(rule.id);
            }
            return yield* store.replace(decoded.value.revision, decoded.value.rules).pipe(
              Effect.map((saved) => json(saved)),
              Effect.catchTags({
                RevisionConflict: (error) =>
                  Effect.succeed(json({ error: error.message, revision: error.current }, 409)),
                RulesWriteError: (error) => Effect.succeed(jsonError(500, error.message)),
              }),
            );
          }
          default:
            return jsonError(405, "Method not allowed");
        }
      }),
    ),
  );

  const ruleTestRoute = HttpRouter.add(
    "*",
    "/api/rules/:id/test",
    guarded((request) =>
      Effect.gen(function* () {
        if (request.method !== "POST") return jsonError(405, "Method not allowed");
        const parsed = yield* readJson(request, MAX_TEST_BODY);
        if (!parsed.ok) return parsed.response;
        const body = Schema.decodeUnknownExit(Schema.Struct({ username: Schema.String }))(parsed.value);
        if (body._tag === "Failure") return jsonError(400, 'Body must be {"username": "<streamer>"}');
        const username = normalizeUsername(body.value.username);
        if (!Schema.is(Username)(username)) return jsonError(400, "Invalid username");

        const manager = yield* SessionManager;
        const session = yield* manager.get(username);
        if (Option.isNone(session)) {
          return jsonError(
            404,
            `No session for @${username}. Open the dashboard or the actions player first.`,
          );
        }
        const params = yield* HttpRouter.params;
        const id = params.id ?? "";
        const engine = yield* RuleEngine;
        const action = yield* engine.test(username, id);
        if (Option.isNone(action)) return jsonError(404, `No action with id ${id}`);
        yield* session.value.emitAction(action.value);
        return json({ ok: true, action: action.value });
      }),
    ),
  );

  const mediaRoute = HttpRouter.add(
    "*",
    "/api/media",
    guarded((request) =>
      Effect.gen(function* () {
        const media = yield* MediaStore;
        switch (request.method) {
          case "GET":
            return json({ media: yield* media.list });
          case "POST": {
            const bytes = yield* readBytes(request, MAX_MEDIA_BYTES);
            if (bytes === "tooLarge") return jsonError(413, "File is over 25 MB.");
            if (bytes === "unreadable") return jsonError(400, "Could not read the upload");
            const name = decodeHeader(request.headers["x-file-name"], "file");
            return yield* media.add(name, request.headers["content-type"] ?? "", bytes).pipe(
              Effect.map((item) => json(item, 201)),
              Effect.catchTag("MediaError", (error) =>
                Effect.succeed(jsonError(MEDIA_STATUS[error.reason], error.message)),
              ),
            );
          }
          default:
            return jsonError(405, "Method not allowed");
        }
      }),
    ),
  );

  const mediaItemRoute = HttpRouter.add(
    "*",
    "/api/media/:id",
    guarded((request) =>
      Effect.gen(function* () {
        const media = yield* MediaStore;
        const params = yield* HttpRouter.params;
        const id = params.id ?? "";
        switch (request.method) {
          case "PATCH": {
            const parsed = yield* readJson(request, MAX_RENAME_BODY);
            if (!parsed.ok) return parsed.response;
            const body = Schema.decodeUnknownExit(RenameMediaRequest)(parsed.value);
            if (body._tag === "Failure")
              return jsonError(400, 'Body must be {"name": "<1 to 200 characters>"}');
            return yield* media.rename(id, body.value.name).pipe(
              Effect.map((item) =>
                Option.isSome(item) ? json(item.value) : jsonError(404, `No media with id ${id}`),
              ),
              Effect.catchTag("MediaError", (error) =>
                Effect.succeed(jsonError(MEDIA_STATUS[error.reason], error.message)),
              ),
            );
          }
          case "DELETE":
            if (!(yield* media.remove(id))) return jsonError(404, `No media with id ${id}`);
            return json({ ok: true });
          default:
            return jsonError(405, "Method not allowed");
        }
      }),
    ),
  );

  // Not guarded: OBS and plain <img>/<audio>/<video> tags can't send headers, like the static files.
  const mediaFileRoute = HttpRouter.add("GET", "/media/:file", () =>
    Effect.gen(function* () {
      const media = yield* MediaStore;
      const params = yield* HttpRouter.params;
      const found = yield* media.resolve(params.file ?? "");
      if (Option.isNone(found)) return jsonError(404, "Not found");
      return yield* HttpServerResponse.file(found.value.path, {
        contentType: found.value.contentType,
        headers: MEDIA_HEADERS,
      }).pipe(Effect.orElseSucceed(() => jsonError(404, "Not found")));
    }),
  );

  // ---- Viewer points ----
  // Points belong to the streamer, not to a running session, so these work whether or not they're live.

  /** A whole number from a query parameter in [min, max]. Absent means `fallback`. Undefined when invalid. */
  const pageNumber = (raw: string | null, fallback: number, min: number, max: number) => {
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) return undefined;
    const value = Number(raw);
    return value >= min && value <= max ? value : undefined;
  };

  const pointsRoute = HttpRouter.add(
    "*",
    "/api/sessions/:username/points",
    guarded((request, url) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const username = parseUsername(params.username ?? "");
        if (!username) return jsonError(400, "Invalid username");
        const points = yield* PointsStore;
        switch (request.method) {
          case "GET": {
            const limit = pageNumber(url.searchParams.get("limit"), 50, 1, 200);
            const offset = pageNumber(url.searchParams.get("offset"), 0, 0, 1_000_000_000);
            if (limit === undefined || offset === undefined) {
              return jsonError(400, "limit must be 1 to 200, and offset a whole number of 0 or more");
            }
            const query = url.searchParams.get("q") ?? "";
            if (query.length > 100) return jsonError(400, "q must be 100 characters or fewer");
            return json(yield* points.leaderboard(username, { limit, offset, query }));
          }
          case "DELETE":
            return yield* points.reset(username).pipe(
              Effect.as(json({ ok: true })),
              Effect.catchTag("PointsWriteError", (error) => Effect.succeed(jsonError(500, error.message))),
            );
          default:
            return jsonError(405, "Method not allowed");
        }
      }),
    ),
  );

  // Registered as its own route so `settings` is matched here, not as a viewer id.
  const pointsSettingsRoute = HttpRouter.add(
    "*",
    "/api/sessions/:username/points/settings",
    guarded((request) =>
      Effect.gen(function* () {
        if (request.method !== "PUT") return jsonError(405, "Method not allowed");
        const params = yield* HttpRouter.params;
        const username = parseUsername(params.username ?? "");
        if (!username) return jsonError(400, "Invalid username");
        const parsed = yield* readJson(request, MAX_POINTS_BODY);
        if (!parsed.ok) return parsed.response;
        const body = Schema.decodeUnknownExit(PointsSettings)(parsed.value);
        if (body._tag === "Failure") {
          const problem = Exit.findErrorOption(body);
          return jsonError(
            400,
            Option.isSome(problem) ? firstProblem(problem.value.message) : "Invalid settings",
          );
        }
        const points = yield* PointsStore;
        return yield* points.updateSettings(username, body.value).pipe(
          Effect.map((saved) => json(saved)),
          Effect.catchTag("PointsWriteError", (error) => Effect.succeed(jsonError(500, error.message))),
        );
      }),
    ),
  );

  const pointsViewerRoute = HttpRouter.add(
    "*",
    "/api/sessions/:username/points/:userId",
    guarded((request) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const username = parseUsername(params.username ?? "");
        if (!username) return jsonError(400, "Invalid username");
        const userId = params.userId ?? "";
        const points = yield* PointsStore;
        switch (request.method) {
          case "GET": {
            const viewer = yield* points.get(username, userId);
            return Option.isSome(viewer)
              ? json(viewer.value)
              : jsonError(404, `No points for viewer ${userId} on @${username}`);
          }
          case "PATCH": {
            const parsed = yield* readJson(request, MAX_POINTS_BODY);
            if (!parsed.ok) return parsed.response;
            const bad = 'Body must be {"delta": <whole number>} or {"set": <whole number>}';
            const body = Schema.decodeUnknownExit(PointsAdjustRequest)(parsed.value);
            if (body._tag === "Failure") return jsonError(400, bad);
            const { delta, set } = body.value;
            if ((delta === undefined) === (set === undefined)) return jsonError(400, bad);
            const change = delta !== undefined ? { delta } : { set: set! };
            return yield* points.adjust(username, userId, change).pipe(
              Effect.map((viewer) =>
                Option.isSome(viewer)
                  ? json(viewer.value)
                  : jsonError(404, `No points for viewer ${userId} on @${username}`),
              ),
              Effect.catchTag("PointsWriteError", (error) => Effect.succeed(jsonError(500, error.message))),
            );
          }
          default:
            return jsonError(405, "Method not allowed");
        }
      }),
    ),
  );

  // ---- Sound search (MyInstants) ----

  const soundSearchRoute = HttpRouter.add(
    "*",
    "/api/sounds/search",
    guarded((request, url) =>
      Effect.gen(function* () {
        if (request.method !== "GET") return jsonError(405, "Method not allowed");
        const query = cleanQuery(url.searchParams.get("q") ?? "");
        if (query === undefined) return jsonError(400, "Type 1 to 100 characters");
        const sounds = yield* SoundSearch;
        return yield* sounds.search(query, Number(url.searchParams.get("page") ?? "1")).pipe(
          Effect.map((found) => json(found)),
          Effect.catchTag("SoundSearchError", (error) => Effect.succeed(jsonError(502, error.message))),
        );
      }),
    ),
  );

  const importRoute = HttpRouter.add(
    "*",
    "/api/media/import",
    guarded((request) =>
      Effect.gen(function* () {
        if (request.method !== "POST") return jsonError(405, "Method not allowed");
        const parsed = yield* readJson(request, MAX_IMPORT_BODY);
        if (!parsed.ok) return parsed.response;
        const body = Schema.decodeUnknownExit(ImportMediaRequest)(parsed.value);
        if (body._tag === "Failure") return jsonError(400, 'Body must be {"url": "<MyInstants sound link>"}');
        const { url, name } = body.value;
        if (!isAllowedSoundUrl(url)) return jsonError(400, "Only MyInstants sound links can be imported");

        const sounds = yield* SoundSearch;
        const downloaded = yield* sounds.download(url).pipe(Effect.result);
        if (downloaded._tag === "Failure") return jsonError(502, downloaded.failure.message);

        const media = yield* MediaStore;
        const file = decodeHeader(
          new URL(url).pathname
            .split("/")
            .pop()
            ?.replace(/\.mp3$/i, ""),
          "sound",
        );
        return yield* media.add(name ?? file, "audio/mpeg", downloaded.success).pipe(
          Effect.map((item) => json(item, 201)),
          Effect.catchTag("MediaError", (error) =>
            Effect.succeed(jsonError(MEDIA_STATUS[error.reason], error.message)),
          ),
        );
      }),
    ),
  );

  // Successful catalog lookups are cached for an hour. Failures are not cached, so the next request retries.
  const giftCatalog = Layer.unwrap(
    Effect.gen(function* () {
      const tiktok = yield* TikTokWeb.TikTokWeb;
      const gifts = yield* Effect.cachedWithTTL(tiktok.getGifts(), (exit) =>
        Exit.isSuccess(exit) ? "1 hour" : 0,
      );
      return HttpRouter.add(
        "GET",
        "/api/gifts",
        guarded(() =>
          gifts.pipe(
            Effect.map((list) => json({ gifts: list })),
            Effect.catchTag("TikTokRequestError", (error) => Effect.succeed(jsonError(502, error.message))),
          ),
        ),
      );
    }),
  );

  // ---- WebSocket ----

  const wsRoute = HttpRouter.add(
    "GET",
    "/ws",
    guarded((request, url) =>
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* SessionManager;
          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          const scope = yield* Scope.Scope;
          const send = (message: ServerMessage) => writer.write(JSON.stringify(message)).pipe(Effect.ignore);
          const sendError = (code: ErrorCode, message: string) => send({ type: "error", code, message });
          const subscriptions = new Map<string, Fiber.Fiber<unknown>>();

          const subscribe = (
            raw: string,
            events: ReadonlyArray<LiveEventTypeT> | undefined,
            replay: boolean,
            actions: boolean,
          ) =>
            Effect.gen(function* () {
              const username = normalizeUsername(raw);
              if (!Schema.is(Username)(username))
                return yield* sendError("invalid_username", `Invalid username: ${raw}`);
              if (!subscriptions.has(username) && subscriptions.size >= maxSubscriptions) {
                return yield* sendError(
                  "too_many_subscriptions",
                  `At most ${maxSubscriptions} streamers per connection`,
                );
              }
              const previous = subscriptions.get(username);
              if (previous) yield* Fiber.interrupt(previous);
              const filter = events ? new Set(events) : undefined;
              const wants = (event: LiveEvent) => !filter || filter.has(event.type);

              const fiber = yield* Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* manager.acquire(username);
                  const updates = yield* session.subscribe;
                  yield* send({ type: "status", username, status: yield* session.status });
                  // An event published after `subscribe` but before `recentEvents` is in both the replay
                  // and the queue, so live events whose msgId was already replayed are skipped.
                  const replayed = new Set<string>();
                  if (replay) {
                    for (const event of yield* session.recentEvents) {
                      if (!wants(event)) continue;
                      yield* send({ type: "event", username, event, replay: true });
                      if (event.msgId && event.msgId !== "0") replayed.add(event.msgId);
                    }
                  }
                  while (true) {
                    const message = yield* PubSub.take(updates);
                    switch (message._tag) {
                      case "Status":
                        yield* send({ type: "status", username, status: message.status });
                        break;
                      case "Event":
                        if (wants(message.event) && !replayed.has(message.event.msgId ?? ""))
                          yield* send({ type: "event", username, event: message.event });
                        break;
                      // Actions skip the `events` filter and are never replayed.
                      case "Action":
                        if (actions) yield* send({ type: "action", username, action: message.action });
                        break;
                    }
                  }
                }),
              ).pipe(Effect.forkIn(scope));
              subscriptions.set(username, fiber);
            });

          const unsubscribe = (raw: string) =>
            Effect.suspend(() => {
              const username = normalizeUsername(raw);
              const fiber = subscriptions.get(username);
              subscriptions.delete(username);
              return fiber ? Fiber.interrupt(fiber) : Effect.void;
            });

          const handleText = (text: string) =>
            Effect.gen(function* () {
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch {
                return yield* sendError("invalid_message", "Messages must be JSON");
              }
              const decoded = Schema.decodeUnknownExit(ClientMessage)(parsed);
              if (decoded._tag === "Failure") {
                return yield* sendError("invalid_message", "Unknown or malformed message");
              }
              const message = decoded.value;
              if (message.action === "subscribe") {
                yield* subscribe(
                  message.username,
                  message.events,
                  message.replay ?? false,
                  message.actions ?? false,
                );
              } else {
                yield* unsubscribe(message.username);
              }
            });

          yield* send({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            serverVersion: options.serverVersion ?? pkg.version,
          });

          // Shortcut for overlays: /ws?username=foo&events=chat,gift&replay=1&actions=1
          const shortcut = url.searchParams.get("username");
          if (shortcut) {
            const eventsParam = url.searchParams.get("events");
            const events =
              eventsParam === null
                ? undefined
                : eventsParam.split(",").filter((e): e is LiveEventTypeT => Schema.is(LiveEventType)(e));
            yield* subscribe(
              shortcut,
              events,
              url.searchParams.get("replay") === "1",
              url.searchParams.get("actions") === "1",
            );
          }

          const decoder = new TextDecoder();
          while (true) {
            const chunks = yield* reader.pull.pipe(Effect.orElseSucceed(() => undefined));
            if (!chunks) break;
            for (const chunk of chunks) {
              const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
              if (text.length > 16 * 1024) {
                yield* sendError("invalid_message", "Message too large");
                continue;
              }
              yield* handleText(text);
            }
          }
          return HttpServerResponse.empty();
        }),
      ),
    ),
  );

  // ---- Static files ----

  const clientBundle = HttpRouter.add("GET", "/tiklive.js", () => {
    const path = options.clientBundle;
    if (!path || !existsSync(path)) {
      const bundled = assets?.get("/tiklive.js");
      if (bundled) {
        return Effect.succeed(
          HttpServerResponse.uint8Array(bundled, { contentType: MIME[".js"]!, headers: STATIC_HEADERS }),
        );
      }
      return Effect.succeed(
        HttpServerResponse.text(
          "// tiklive client bundle not built. Run: bun run --filter @tiklive/client build\n",
          {
            status: 404,
            contentType: "text/javascript; charset=utf-8",
            headers: STATIC_HEADERS,
          },
        ),
      );
    }
    return HttpServerResponse.file(path, { contentType: MIME[".js"]!, headers: STATIC_HEADERS }).pipe(
      Effect.orElseSucceed(() => jsonError(500, "Failed to read client bundle")),
    );
  });

  /** Serves an in-memory asset. Only used when no `staticDir` is configured. */
  const assetFile = (pathname: string): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
    if (!assets) return Effect.succeed(jsonError(404, "Not found"));
    const dirIndex = `${pathname.endsWith("/") ? pathname : pathname + "/"}index.html`;
    const key = [pathname, dirIndex].find((candidate) => assets.has(candidate));
    const bytes = key === undefined ? undefined : assets.get(key);
    if (key === undefined || !bytes) return Effect.succeed(jsonError(404, "Not found"));
    return Effect.succeed(
      HttpServerResponse.uint8Array(bytes, {
        contentType: MIME[extname(key)] ?? "application/octet-stream",
        headers: STATIC_HEADERS,
      }),
    );
  };

  const staticFiles = HttpRouter.add("GET", "/*", (request) => {
    if (!staticRoot) {
      let pathname: string;
      try {
        pathname = decodeURIComponent(requestUrl(request).pathname);
      } catch {
        return Effect.succeed(jsonError(400, "Bad path"));
      }
      return assetFile(pathname);
    }
    const url = requestUrl(request);
    let path: string;
    try {
      path = resolve(join(staticRoot, decodeURIComponent(url.pathname)));
    } catch {
      return Effect.succeed(jsonError(400, "Bad path"));
    }
    if (path !== staticRoot && !path.startsWith(staticRoot + sep))
      return Effect.succeed(jsonError(403, "Forbidden"));
    try {
      if (statSync(path).isDirectory()) path = join(path, "index.html");
    } catch {
      return Effect.succeed(jsonError(404, "Not found"));
    }
    if (!existsSync(path)) return Effect.succeed(jsonError(404, "Not found"));
    return HttpServerResponse.file(path, {
      contentType: MIME[extname(path)] ?? "application/octet-stream",
      headers: STATIC_HEADERS,
    }).pipe(Effect.orElseSucceed(() => jsonError(404, "Not found")));
  });

  return Layer.mergeAll(
    health,
    listSessions,
    sessionRoute,
    simulateRoute,
    rulesRoute,
    ruleTestRoute,
    mediaRoute,
    mediaItemRoute,
    pointsRoute,
    pointsSettingsRoute,
    pointsViewerRoute,
    soundSearchRoute,
    importRoute,
    giftCatalog,
    wsRoute,
    mediaFileRoute,
    clientBundle,
    staticFiles,
  );
};
