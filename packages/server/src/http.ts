/**
 * HTTP + WebSocket surface of the tiklive server: the overlay WebSocket
 * (`/ws`), the REST API (`/api/*`), the client bundle (`/tiklive.js`) and
 * optional static files. See docs/PROTOCOL.md.
 */
import pkg from "../package.json" with { type: "json" };
import {
  ClientMessage,
  LIVE_EVENT_TYPES,
  LiveEvent,
  LiveEventType,
  normalizeUsername,
  PROTOCOL_VERSION,
  Username,
  type ErrorCode,
  type LiveEventType as LiveEventTypeT,
  type ServerMessage,
} from "@tiklive/contracts";
import { timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
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
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'",
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
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
};

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: SECURITY_HEADERS });
const jsonError = (status: number, message: string) => json({ error: message }, status);

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
          body && typeof body === "object" ? { timestamp: now, msgId: `sim-${now}`, ...body } : body;
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
                  if (replay) {
                    for (const event of yield* session.recentEvents) {
                      if (wants(event)) yield* send({ type: "event", username, event, replay: true });
                    }
                  }
                  while (true) {
                    const message = yield* PubSub.take(updates);
                    if (message._tag === "Status")
                      yield* send({ type: "status", username, status: message.status });
                    else if (wants(message.event))
                      yield* send({ type: "event", username, event: message.event });
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
                yield* subscribe(message.username, message.events, message.replay ?? false);
              } else {
                yield* unsubscribe(message.username);
              }
            });

          yield* send({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            serverVersion: options.serverVersion ?? pkg.version,
          });

          // Shortcut for overlays: /ws?username=foo&events=chat,gift&replay=1
          const shortcut = url.searchParams.get("username");
          if (shortcut) {
            const eventsParam = url.searchParams.get("events");
            const events =
              eventsParam === null
                ? undefined
                : eventsParam.split(",").filter((e): e is LiveEventTypeT => Schema.is(LiveEventType)(e));
            yield* subscribe(shortcut, events, url.searchParams.get("replay") === "1");
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
    wsRoute,
    clientBundle,
    staticFiles,
  );
};
