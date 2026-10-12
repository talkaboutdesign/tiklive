# tiklive

Self-hosted TikTok LIVE event server for building stream overlays.

Run it next to OBS, point it at a TikTok username, and get chats, gifts, likes, follows, shares,
joins, subs and viewer counts as clean JSON over a WebSocket. It ships with a browser client,
starter overlays (chat, alerts, goal bar), a dashboard, and a demo mode so you can build overlays
without being live.

There's no third-party signing service, no TikTok login and no headless browser. It talks to
TikTok directly.

> tiklive uses TikTok's private web protocol, which isn't an official API. See [Caveats](#caveats).

## Quick start

**Run the server** (Node 22+ or Bun):

```sh
npx @tiklive/server          # or: bunx @tiklive/server
```

**Use the library** in your own app:

```sh
npm install @tiklive/core effect     # connect to TikTok LIVE
npm install @tiklive/client          # typed client for overlays
```

### From source

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
bun run dev               # builds the client, serves http://localhost:8080
```

Open http://localhost:8080, enter a username (or `demo`), and copy an overlay URL into an OBS
**Browser Source**.

`bun run dev` reloads the server when its source changes. `bun run start` runs it without watching.

## Packages

| Package                                              | What it is                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| [`@tiklive/contracts`](packages/contracts/README.md) | Event and protocol schemas, shared types                             |
| [`@tiklive/core`](packages/core/README.md)           | Connects to TikTok LIVE and streams typed events                     |
| [`@tiklive/server`](packages/server/README.md)       | The `tiklive` server and CLI: sessions, HTTP and WebSocket API       |
| [`@tiklive/client`](packages/client/README.md)       | Browser and Node client with no runtime dependencies (`/tiklive.js`) |
| [`examples/overlays`](examples/overlays/README.md)   | Dashboard and OBS overlays built on the client                       |

Protocol reference: [docs/PROTOCOL.md](docs/PROTOCOL.md). Design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Overlays

The example overlays are plain HTML files in [`examples/overlays`](examples/overlays). Served by
the server, they're at:

| URL                                                           |                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/overlays/chat.html?username=NAME`                           | Chat box. `&max=12`, `&fade=30` (0 = never), `&joins=1`, `&gifts=1`, `&follows=1`              |
| `/overlays/alerts.html?username=NAME`                         | Queued gift, follow, sub and share alerts. `&min=100` (min coins), `&duration=5`, `&follows=0` |
| `/overlays/goal.html?username=NAME&metric=likes&target=10000` | Goal bar. `metric`: `likes`, `diamonds`, `follows`, `shares`, `viewers`                        |

Add `&token=…` if the server uses one. Use `username=demo` to test with fake events.
See [examples/overlays/README.md](examples/overlays/README.md) for every option.

## Using the library

### Connector only (`@tiklive/core`)

No server needed. Stream a TikTok LIVE from your own Effect program:

```ts
import { LiveConnection } from "@tiklive/core";
import { Effect, Stream } from "effect";

LiveConnection.events("someone").pipe(
  Stream.runForEach((e) => Effect.log(e.type, e.timestamp)),
  Effect.provide(LiveConnection.layer()),
  Effect.runPromise,
);
```

`LiveConnection.connect(username)` also yields connection lifecycle events (`Connected`,
`Disconnected`) and, with `includeRaw`, every raw webcast message. It fails with a typed error
(`UserNotFound`, `UserOffline`, `TikTokRequestError`, `SocketOpenFailed`, `ReconnectFailed`).

### Browser or Node client (`@tiklive/client`)

Talks to a running tiklive server. Works in any page, and in Bun or Node with a global `WebSocket`:

```html
<script type="module">
  import { TikLive } from "/tiklive.js";

  const live = new TikLive(); // reads ?username= and ?token= from the page URL
  live.on("chat", (e) => console.log(`${e.user.nickname}: ${e.comment}`));
  live.on("gift", (e) => {
    if (e.streaking) return; // wait until the combo finishes
    console.log(`${e.user.nickname} sent ${e.repeatCount}× ${e.giftName} (${e.totalDiamonds} coins)`);
  });
  live.on("status", (s) => console.log(s.state, s.stats));
</script>
```

Every option is optional: `new TikLive({ username, token, events: ["chat", "gift"], replay: true, server: "ws://host:8080/ws" })`.
`replay: true` sends the last 50 events on connect, which suits a chat box.

## Server

### Command line

From a checkout, run the CLI with Bun:

```sh
bun packages/server/src/bin.ts --watch someone --token secret
```

Help text (`bun packages/server/src/bin.ts --help`):

```
tiklive 0.1.0 — self-hosted TikTok LIVE event server

Usage: tiklive [options]

  -p, --port <n>           Port (env PORT, default 8080)
      --host <addr>        Interface to bind (env HOST, default 127.0.0.1)
      --token <secret>     Require this token for the API and WebSocket (env TIKLIVE_TOKEN)
  -w, --watch <user>       Stay connected to a streamer; repeatable (env TIKLIVE_WATCH, comma-separated)
      --static <dir>       Serve a directory of overlays/pages
      --allow-origin <url> Allow browser pages from this origin to use the API; repeatable
      --allow-host <name>  Accept this Host header (default: localhost names only); repeatable
      --log-requests       Log every HTTP request
  -h, --help               Show this help
  -v, --version            Print the version

Clients connect to ws://HOST:PORT/ws. Use the username "demo" for fake events.
```

Without `--watch`, a streamer's connection starts when the first overlay subscribes and stops 60
seconds after the last one leaves. If the streamer is offline, the session checks every 30 seconds
and connects when they go live. With `--watch`, the session stays connected, and it reconnects
whenever the streamer goes live.

The CLI is a Bun script. `bun run start` is the usual way to run it from a checkout.

### Embedding the server

`Server.layer` builds the routes and sessions. It needs an HTTP server layer, so you provide one.
Bun example, using the same settings as the CLI:

```ts
import { Server } from "@tiklive/server";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Layer from "effect/Layer";

const app = Server.layer({
  token: process.env.TIKLIVE_TOKEN,
  sessions: { watch: ["someone"] },
}).pipe(
  Layer.provide(
    BunHttpServer.layer({ port: 8080, hostname: "127.0.0.1", websocket: { maxPayloadLength: 64 * 1024 } }),
  ),
);

BunRuntime.runMain(Layer.launch(app));
```

Install `@effect/platform-bun` (or use `@effect/platform-node` the same way) alongside
`@tiklive/server`. `ServerOptions.port` and `host` are not read by `Server.layer` itself; set them on
the HTTP server layer as above. See [packages/server/README.md](packages/server/README.md).

### HTTP and WebSocket API

- WebSocket: `ws://localhost:8080/ws`. Subscribe to streamers, receive events and status.
- REST: `/api/health`, `/api/sessions`, `/api/sessions/:username` (`PUT` or `DELETE` to watch and unwatch),
  and `POST /api/sessions/:username/simulate` to inject a test event.

The full message and endpoint reference is in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Events

Each event has `type`, `timestamp` (unix ms), and usually `msgId`. Users look like:

```ts
{ userId, uniqueId /* @handle */, nickname, profilePictureUrl,
  isModerator?, isSubscriber?, isFollower?, isGifter? }
```

| `type`                      | Fields                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `chat`                      | `user`, `comment`, `emotes[]`                                                                                                     |
| `chatDelete`                | `msgIds[]` of deleted `chat` events, `userIds[]`                                                                                  |
| `gift`                      | `user`, `giftId`, `giftName`, `giftImageUrl`, `diamondCount`, `repeatCount`, `streaking`, `totalDiamonds`, `groupId`, `receiver?` |
| `like`                      | `user`, `likeCount`, `totalLikeCount`                                                                                             |
| `follow` / `share` / `join` | `user`                                                                                                                            |
| `subscribe`                 | `user`, `subMonth`                                                                                                                |
| `question`                  | `user`, `question`                                                                                                                |
| `emote`                     | `user`, `emotes[]`                                                                                                                |
| `viewers`                   | `viewerCount`, `topViewers[]`                                                                                                     |
| `streamEnd`                 | `reason`: `ended` \| `suspended`                                                                                                  |

**Gift streaks:** streakable gifts (Rose and so on) fire repeatedly while a viewer holds the combo,
with `streaking: true` and a rising `repeatCount`. The final event has `streaking: false`. Alerts and
coin totals should use that one.

The TypeScript definitions are in [`packages/contracts/src/events.ts`](packages/contracts/src/events.ts).

## Security

- The server binds to `127.0.0.1` by default. Nothing outside your machine can reach it.
- A **Host allowlist** (localhost names by default) blocks DNS-rebinding attacks against a local server.
- An **Origin check** stops other websites from driving your server from a browser. Same-origin pages
  and non-browser clients (OBS, curl) are allowed. Add `--allow-origin` for other origins.
- **`--token`** requires a secret for the API and WebSocket, as `Authorization: Bearer` or `?token=`.
- Binding beyond localhost (`--host 0.0.0.0`) without a token prints a warning. Set a token before you
  expose the server.
- Inputs are validated against the schemas. The simulate endpoint requires JSON, with a 64 KB body limit.
- Each WebSocket can follow at most 20 streamers by default (`maxSubscriptionsPerSocket`). Slow
  subscribers lose their oldest messages rather than making the server buffer without limit.
- Static files get security headers and a Content-Security-Policy.

## How it works

1. **Room lookup.** `GET tiktok.com/api-live/user/room/?uniqueId=…` returns the current room ID and
   whether the user is live. It needs no signature.
2. **Device cookie.** A plain `GET tiktok.com/` issues an anonymous `ttwid` cookie.
3. **WebSocket.** Connects to `wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/`
   (falls back to `webcast-ws.us.tiktok.com`) with that cookie. It sends an `im_enter_room` frame, a
   heartbeat every 10 seconds, and an ack for each batch.
4. **Decoding.** Frames are protobuf envelopes holding gzipped batches of webcast messages
   (`WebcastChatMessage`, `WebcastGiftMessage`, and so on). A small hand-written decoder in
   [`packages/core/src/proto`](packages/core/src/proto) reads only the fields overlays need, so new fields
   from TikTok don't break it.

TikTok's website adds a signed HTTP request (`X-Bogus` / `X-Gnarly`) before it opens the socket. Libraries
normally need a signing service or a browser for that. The socket doesn't depend on the request, so
tiklive skips it. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the rest of the design.

## Caveats

- This is TikTok's private web protocol, not an official API. TikTok can change it at any time. Review
  TikTok's Terms of Service for your use case.
- It's read-only. It can't send chat messages or interact with the stream.
- The signed request that is skipped normally provides a resume cursor, so tiklive has none. Events
  during a reconnect gap can be missed. Duplicates are removed by message ID.
- Behind a VPN or a datacenter IP, TikTok may refuse the cookie or the socket.
- Keep the server on `127.0.0.1` (the default), or set `--token` before exposing it.

## Development

```sh
bun install
bun run check             # lint, format check, typecheck
bun run test              # tests on the Bun runtime
bun run test:node         # tests on Node
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [AGENTS.md](AGENTS.md) for the
repo map and conventions.

## License

[MIT](LICENSE). Copyright 2026 Talkabout Design LLC.
