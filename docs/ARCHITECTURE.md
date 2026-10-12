# Architecture

tiklive has two halves. One is a **connector** that turns TikTok's LIVE WebSocket into typed
events. The other is a **server** that shares those events with overlays and apps over a simple
JSON protocol. The connector is a library you can use alone. The server is built on top of it.

## Packages

```
                ┌───────────────────┐
                │ @tiklive/contracts │  event + protocol schemas, PROTOCOL_VERSION
                └─────────┬─────────┘
          ┌──────────────┼───────────────┐
          ▼              ▼               ▼
  ┌──────────────┐ ┌────────────┐  ┌──────────────┐
  │ @tiklive/core│ │@tiklive/   │  │ tiklive client│  (dist/tiklive.js, no deps)
  │ TikTok side  │ │  client    │  └──────▲───────┘
  └──────┬───────┘ └─────┬──────┘         │ /tiklive.js
         │               │                │
         ▼               ▼                │
  ┌──────────────────────────────────────┐ │
  │ @tiklive/server                      │─┘  serves bundle, static overlays
  │ SessionManager → Session → HTTP/WS   │
  └──────────────────────────────────────┘
          ▲                    ▲
     overlays, dashboards   OBS, apps
```

| Package              | Depends on                                         | Role                                                                                                                |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@tiklive/contracts` | `effect` (Schema only)                             | Event and protocol schemas. Types come from here.                                                                   |
| `@tiklive/core`      | contracts, `effect`                                | Talks to TikTok. Exposes the `LiveConnection` stream, the `TikTokWeb` service, errors, decoders, and a demo stream. |
| `@tiklive/server`    | core, contracts, client (for the bundle), `effect` | Shares sessions over HTTP and WebSocket. Ships the `tiklive` CLI.                                                   |
| `@tiklive/client`    | contracts (types only)                             | Browser and Node client. Built into one file with no runtime dependencies.                                          |
| `examples/overlays`  | none at runtime                                    | Static HTML dashboard and OBS overlays. Served by the server with `--static`.                                       |

The client's only import from contracts is types, so `dist/tiklive.js` contains no Effect code.

## Data flow

From TikTok to an overlay:

```
TikTok webcast WebSocket
  │  binary frames: protobuf envelope, gzipped payload
  ▼
core/LiveConnection   decodeSocketFrame → RawMessage[]
  │                   skip history unless includeHistory; drop msgIds seen in the last 5000
  │                   decodeLiveEvent → LiveEvent (unknown methods are skipped)
  │  Stream<ConnectionEvent>   (buffer 1024, backpressure: suspend)
  ▼
server/Session        one per streamer
  │                   • stats (likes, diamonds, follows, …) and status snapshot
  │                   • history: last 50 events, excluding likes and viewers
  │                   • PubSub (sliding, 512 per subscriber): events + status
  ▼
server/SessionManager shares one Session per streamer (RcMap)
  │                   • acquire (per-socket) or watch (--watch / REST)
  │                   • idle timeout (60s) after the last user leaves
  ▼
server/http           /ws subscribers filter by event type, send replay, forward PubSub
  │                   /api/* REST, /tiklive.js, static files
  ▼
overlay (TikLive client) → handlers
```

Two details matter for correctness:

- **Ordering within one streamer.** A subscriber subscribes to the PubSub before it reads the
  status and history, so nothing published in between is lost. The replay happens before live
  messages are forwarded.
- **Slow subscribers.** Each subscriber's PubSub is sliding. A slow socket loses its oldest
  undelivered messages instead of making the server buffer without limit. Library users who
  consume `LiveConnection` directly get backpressure instead (see below).

## Connection lifecycle (`LiveConnection`)

`LiveConnection.connect(username)` is a `Stream` of `ConnectionEvent`s:

| Event          | When                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Connected`    | The socket opened and the room was entered. Carries `roomId`, `room` (absent when you pass `roomId` yourself), and `wsHost`. |
| `Event`        | A normalized `LiveEvent`                                                                                                     |
| `Raw`          | Every webcast message, when `includeRaw: true`                                                                               |
| `Disconnected` | `reason` is `network`, `streamEnd`, or `offline`. `willReconnect` says whether a retry follows.                              |

Each connection attempt does three things:

1. **Room lookup.** `GET https://www.tiktok.com/api-live/user/room/?uniqueId=…` returns the room ID
   and whether the user is live. This call needs no signature. An empty body or HTTP 429 becomes
   a `TikTokRequestError` with `rateLimited: true`.
2. **Device cookie.** A plain `GET https://www.tiktok.com/` returns an anonymous `ttwid` cookie.
   It's cached. If the socket later refuses to open, a fresh cookie is fetched once and the open
   is retried.
3. **Socket.** Connects to `wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/`
   and falls back to `webcast-ws.us.tiktok.com`. It sends the `ttwid` cookie and an
   `im_enter_room` frame. A heartbeat goes out every 10 seconds, and each frame with a log ID is
   acked.

**Why there's no signing.** TikTok's website signs an `im/fetch` request (`X-Bogus`, `X-Gnarly`)
before it opens the socket. The socket itself doesn't depend on that request. Skipping it is why
tiklive needs no signing service, no login, and no headless browser. The cost is that the signed
request normally gives you a resume cursor, and tiklive doesn't have one. Events during a reconnect
gap can be lost.

**Reconnects.** After a drop once connected, the stream retries with exponential backoff: 1 s,
doubling, capped at 30 s, with ±20% jitter. It makes up to 10 attempts (both configurable). Each
retry does a fresh room lookup, because rooms change when a streamer restarts. The stream ends
with `Disconnected { reason: "streamEnd" | "offline" }` when TikTok says the stream ended, or when
the room lookup says the user is no longer live.

**Failure rules:**

- Before the first successful connection, any failure fails the stream immediately. `UserOffline`
  and `SocketOpenFailed` are examples.
- After a connection was established, only `UserNotFound` and `ReconnectFailed` fail the stream.
  Other problems retry.

Interrupting the stream closes the socket.

## Sessions (`server/Session`)

A session follows one streamer and runs until its scope closes.

- **Live streamer:** connects and records `Connected`, `Event`, and `Disconnected`.
- **Offline streamer:** the stream ends with `offline`, so the state goes to `waiting`. The session
  waits `pollInterval` (30 s) and tries again.
- **`UserNotFound`:** the session goes to `error` and stops trying.
- **Other failures:** the session goes to `error` and retries after `pollInterval`.
- **Demo:** the username `demo` runs `demoEvents` (fake events) instead of connecting.

Stats update on each event. A status push is published at most once per second, and only when the
stats changed. State changes publish immediately.

## Session manager (`server/SessionManager`)

- One session per streamer, held in an `RcMap` (reference-counted, so each streamer has one session).
- `acquire(username)` is used by a WebSocket subscription. It holds a reference for as long as the
  subscription lives, and also counts subscribers.
- `watch(username)` (`--watch`, `PUT /api/sessions/:user`) holds a scope that stays open until
  `unwatch`.
- When the last reference is released, the session stays alive for `idleTimeout` (60 s by default)
  and then stops. Watched sessions don't stop this way.

## HTTP layer (`server/http`)

Built with `HttpRouter`. Every route except `/api/health` and the static files goes through a `guarded`
wrapper, which does this in order:

1. Host allowlist (blocks DNS rebinding)
2. Origin check
3. Authorization: the `authorize` hook if given, otherwise the token (constant-time compare)

Static files get security headers and a Content-Security-Policy. Paths are resolved and checked
to stay inside the static directory.

Note what isn't guarded: static files and `/tiklive.js` are served without the token or Host check.
They contain no session data. The API and WebSocket are the protected surface.

## Server composition (`server/server`)

`Server.layer(options)` takes the `HttpRouter` routes and provides `SessionManager`, which needs a
TikTok connection layer. By default that's `LiveConnection.layer()`, which uses the runtime's global
`fetch` and `WebSocket`. `ServerOptions.tiktok` replaces it, which is how you add a proxy or a fake in tests.

`Server.layer` doesn't bind a port. It needs an `HttpServer` layer. The bundled ones are in
`packages/server/src/platform/bun.ts` and `node.ts`. The CLI picks one at runtime by checking for `Bun`.

## Client (`packages/client`)

`TikLive` is a plain class over the global `WebSocket`. It has no Effect, because overlays are plain
browser pages and the client should stay small and dependency-free.
Its types are imported from contracts and erased at build time. Reconnects use backoff, and every
reconnect sends the subscription again.

## Errors

Errors are `Schema.TaggedError`s, so they serialize and pattern-match well:

| Error                | Raised by      | Meaning                                                                                                 |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `UserNotFound`       | room lookup    | The account doesn't exist, or is hidden                                                                 |
| `UserOffline`        | room lookup    | The account exists and isn't live. Internal: the stream turns it into `Disconnected` or a waiting state |
| `TikTokRequestError` | HTTP calls     | Failed request, unexpected response, or rate limit (`rateLimited`, `status`)                            |
| `SocketOpenFailed`   | socket         | No WebSocket host accepted the connection. Has `hosts`                                                  |
| `ReconnectFailed`    | reconnect loop | Dropped and `maxAttempts` retries failed. Has `attempts` and `lastError`                                |

`ConnectError` is the union of the ones a `connect` stream can fail with.

## Why Effect

- **Lifecycle.** Sessions, sockets, reconnect timers and subscriptions all need cleanup when someone
  leaves. Scopes and fibers handle that, and interrupting a stream closes its socket.
- **Typed failures.** Each step declares its errors, so the session can tell a permanent failure
  (`UserNotFound`) from one worth retrying (`TikTokRequestError`, `ReconnectFailed`).
- **Testability.** TikTok access is behind the `TikTokWeb` and `WebSocketConstructor` services. Tests swap
  in fakes (`packages/core/src/testing.ts`) and use `TestClock` for timing.
- **Schemas.** The same `Schema` definitions validate injected events (the simulate endpoint), client
  messages, and the server's outgoing types.

## Known gaps

These are things the code does that the design doesn't intend, or things that aren't wired up yet:

- **Stats reset on every reconnect**, not only when the streamer goes live. `Session` resets stats on
  each `Connected` event, and `Connected` fires again after a network drop. `SessionStats` is documented
  as resetting when the stream starts.
- **`internal` error code** is in the schema but never sent.
- **`ServerOptions.port` and `host`** are read only by the platform layers, not by `Server.layer`. Passing
  them to `Server.layer` does nothing.
- **Platform layers and test fakes aren't exported** from their package entry points. `@tiklive/server`
  exports `Server`, `SessionManager`, and `Session`, but not `platform/bun` or `platform/node`. `@tiklive/core`
  doesn't export `testing`. Package `exports` only map `"."`, so deep imports are blocked too.
- **`encodeEnterRoom` takes an optional `cursor`**, but nothing sends one. TikTok's socket has no resume
  cursor in tiklive's flow (see Reconnects above).
- **`packages/core/record.ts`** is a fixture-recording script that is not part of the package API.
