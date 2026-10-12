# Library

tiklive has four parts you can use from your own code. Install the package and the Effect peer:

```sh
npm install tiklive effect
```

| Import              | Use it for                                                     |
| ------------------- | -------------------------------------------------------------- |
| `tiklive/core`      | Streaming a TikTok LIVE room from an Effect program, no server |
| `tiklive/client`    | Following a running tiklive server from a page, Bun or Node    |
| `tiklive/contracts` | Event and protocol schemas, for validation and types           |
| `tiklive/testing`   | Fakes for tests, so tests never reach tiktok.com               |

`tiklive/tiklive.js` is the browser client bundle, the same code as `tiklive/client`, served at `/tiklive.js`.
The server and the CLI are described in [server.md](./server.md).

## Connector (`tiklive/core`)

No server needed. Stream a TikTok LIVE from your own Effect program:

```ts
import { LiveConnection } from "tiklive/core";
import { Effect, Stream } from "effect";

LiveConnection.events("someone").pipe(
  Stream.runForEach((e) => Effect.log(e.type, e.timestamp)),
  Effect.provide(LiveConnection.layer()),
  Effect.runPromise,
);
```

- `LiveConnection.events(username, options)`: a `Stream` of normalized `LiveEvent`s.
- `LiveConnection.connect(username, options)`: a `Stream` of connection events: `Connected`, `Event`, `Raw`
  and `Disconnected`. `Connected` and `Disconnected` report the connection lifecycle. `Raw` carries every
  raw webcast message when you set `includeRaw`.
- `LiveConnection.layer(options)`: the default TikTok and WebSocket layers. The TikTok layer uses `fetch`,
  and the WebSocket layer uses the runtime's global `WebSocket`.
- Options: `roomId`, `wsHosts`, `includeHistory`, `includeRaw`, `reconnect`, `heartbeatInterval`,
  `connectTimeout`.

The stream fails with a typed error: `UserNotFound`, `UserOffline`, `TikTokRequestError`,
`SocketOpenFailed` or `ReconnectFailed`, all in the `ConnectError` union. Each is a tagged error, so you can
match one with `Effect.catchTag`. A stream that fails with `UserOffline` on its first attempt means the
streamer isn't live.

Reconnects, backoff, de-duplication and the room lookup are handled for you. Interrupting the stream closes
the socket.

Other exports:

- `TikTokWeb`: the service behind the room lookup (`getRoomStatus`) and the gift catalog (`getGifts`).
  `TikTokWeb.layer()` uses `fetch`. `TikTokWeb.layerWith()` takes your own `HttpClient`, for example a proxy.
- `decodeLiveEvent(rawMessage)` and `isSupportedMethod(method)`: decode a raw webcast message yourself, for
  types tiklive doesn't normalize (see `includeRaw`).
- `demoEvents`: an endless stream of fake events, for building overlays without a live stream.
- Types: `LiveEvent`, `LiveEventOf`, `LiveEventType`, `LiveUser`, `RawMessage`, `RoomStatus`.

## Client (`tiklive/client`)

The client talks to a running tiklive server. It has no runtime dependencies and no Effect code. Its types
are erased at build time, so the browser bundle has no Effect code either.

In a page, served by the server at `/tiklive.js`:

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

From Node or Bun, with a global `WebSocket`:

```ts
import { TikLive } from "tiklive/client";

const live = new TikLive({ username: "demo", server: "ws://127.0.0.1:8080/ws" });
live.on("*", (e) => console.log(e.type));
```

Options. Every option is optional:

| Option      | Default                     | Meaning                                                                |
| ----------- | --------------------------- | ---------------------------------------------------------------------- |
| `username`  | `?username=`, then `"demo"` | Streamer to follow                                                     |
| `server`    | this page's host, `/ws`     | WebSocket URL. Required outside a page                                 |
| `token`     | `?token=`                   | Access token, if the server uses one                                   |
| `events`    | all                         | Only these event types. `[]` for status only                           |
| `replay`    | `false`                     | Ask for recent events on connect (the last 50, which suits a chat box) |
| `actions`   | `false`                     | Also receive the actions fired by the server's rules, as `"action"`    |
| `WebSocket` | global `WebSocket`          | Constructor to use (tests, older runtimes)                             |
| `reconnect` | `true`                      | Reconnect with backoff (500 ms doubling, capped at 10 s)               |

Handlers:

- `live.on(type, handler)` returns a function that removes the handler.
- Event types (`chat`, `gift`, `like`, `follow`, `share`, `join`, `subscribe`, `question`, `emote`, `viewers`,
  `streamEnd`) get `(event, meta)`. `meta` has `replay` and `username`.
- `"*"` gets every event.
- `"status"`, `"hello"`, `"error"`, `"open"` and `"close"` get their own payloads.
- `"action"` gets `(action, meta)` when the `actions` option is on: a `FiredAction` with the rule's steps
  filled in. `meta` has `username`. Actions don't reach `"*"`.
- A handler that throws is logged with `console.error`, and the other handlers still run.
- With `replay`, a reconnect asks for recent events again, so events missed during the gap arrive. Events the
  client already delivered (by `msgId`, the last 1000) are skipped, so they don't show twice. Events without a
  `msgId` are never skipped.

`live.gifts()` returns the gift catalog (`GiftInfo[]`: `giftId`, `name`, `diamondCount`, `imageUrl`,
`streakable`, sorted by price). It fetches `/api/gifts` from the same server, with the same token. The server
caches the catalog for an hour. The promise rejects if the request fails.

The client doesn't validate events at runtime. It trusts the server.

To build the bundle from a checkout, run `bun run build`. It writes `packages/client/dist/tiklive.js`, which the
server serves.

## Contracts (`tiklive/contracts`)

Event and wire-protocol schemas. Each schema is an [Effect `Schema`](https://effect.website), so it works as a
runtime validator and as the source of the TypeScript types.

- Events: `LiveEvent`, one schema per event type (`ChatEvent`, `GiftEvent`, ...), and `LIVE_EVENT_TYPES`.
- Protocol: `ClientMessage` (subscribe, unsubscribe), `ServerMessage` (hello, event, status, error),
  `SessionStatus`, `SessionStats`, and `PROTOCOL_VERSION`.
- Helpers: `normalizeUsername("@SomeOne")` returns `"someone"`, and `Username` is the validated handle schema.

```ts
import { LiveEvent, normalizeUsername } from "tiklive/contracts";
import * as Schema from "effect/Schema";

normalizeUsername("https://www.tiktok.com/@SomeOne/live"); // "someone"

const isEvent = Schema.is(LiveEvent);
isEvent({ type: "follow", timestamp: Date.now(), user: {/* ... */} });
```

The field-by-field reference is in [PROTOCOL.md](../PROTOCOL.md). The sources are in
[`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts) and
[`packages/contracts/src/protocol.ts`](../../packages/contracts/src/protocol.ts).

## Testing fakes (`tiklive/testing`)

Use these in your tests instead of hitting TikTok:

- `FakeWebSocket` and `fakeWebSocketLayer`: a scriptable socket that records the frames it sends.
- `fakeTikTokWebLayer`: room lookups without the network.
- `chatFrame` and `streamEndFrame`: frame builders for protobuf messages.

Test with `TestClock` for anything that depends on time, not real sleeps.

## Events

Each event has `type`, `timestamp` (unix ms), and usually `msgId`. Users look like this:

```ts
{ userId, uniqueId /* @handle */, nickname, profilePictureUrl,
  isModerator?, isSubscriber?, isFollower?, isGifter?, gifterLevel? }
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
| `goal`                      | `goalId`, `description`, `goals[]` (`kind`, `progress`, `target`, gift fields), `contributors[]` (`user`, `count`), `endsAt?`     |

**Gift streaks:** streakable gifts (Rose and so on) fire repeatedly while a viewer holds the combo, with
`streaking: true` and a rising `repeatCount`. The final event has `streaking: false`. Alerts and coin totals
should use that one.

The TypeScript definitions are in [`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts).

## Migrating from the old packages

Earlier versions shipped four npm packages. Each one is now a path in `tiklive`:

| Before                       | After                |
| ---------------------------- | -------------------- |
| `@tiklive/server`            | `tiklive`            |
| `@tiklive/server/node`       | `tiklive/node`       |
| `@tiklive/server/bun`        | `tiklive/bun`        |
| `@tiklive/core`              | `tiklive/core`       |
| `@tiklive/core/testing`      | `tiklive/testing`    |
| `@tiklive/contracts`         | `tiklive/contracts`  |
| `@tiklive/client`            | `tiklive/client`     |
| `@tiklive/client/tiklive.js` | `tiklive/tiklive.js` |

The `tiklive` command is unchanged.
