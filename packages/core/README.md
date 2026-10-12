# @tiklive/core

Connects to a TikTok LIVE room and streams typed events. It needs no signing service, no login and no
headless browser. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#connection-lifecycle-liveconnection)
for how the connection works.

## Usage

```ts
import { LiveConnection } from "@tiklive/core";
import { Effect, Stream } from "effect";

LiveConnection.events("someone").pipe(
  Stream.runForEach((e) => Effect.log(e.type, e.timestamp)),
  Effect.provide(LiveConnection.layer()),
  Effect.runPromise,
);
```

`LiveConnection.layer()` provides what the connection needs: a `TikTokWeb` service (room lookups and the
`ttwid` cookie, via `fetch`) and a `WebSocket` constructor (the runtime's global `WebSocket`).

## What's exported

- **`LiveConnection`**
  - `connect(username, options)`: a `Stream` of `ConnectionEvent`s: `Connected`, `Event`, `Raw`, `Disconnected`.
  - `events(username, options)`: just the normalized `LiveEvent`s.
  - `layer(options)`: the default TikTok and WebSocket layers.
  - Options: `roomId`, `wsHosts`, `includeHistory`, `includeRaw`, `reconnect`, `heartbeatInterval`, `connectTimeout`.
- **`TikTokWeb`**: the service behind room lookups. `layer()` uses `fetch`. `layerWith()` takes your own `HttpClient`,
  for a proxy.
- **Errors:** `UserNotFound`, `UserOffline`, `TikTokRequestError`, `SocketOpenFailed`, `ReconnectFailed`, and the
  `ConnectError` union. Each is a tagged error, so you can match with `Effect.catchTag`.
- **`decodeLiveEvent(rawMessage)`** and **`isSupportedMethod(method)`**: decode a raw webcast message yourself, for
  the types tiklive doesn't normalize (see `includeRaw`).
- **`demoEvents`**: an endless stream of fake events, for building overlays without a live stream.

Reconnects, backoff, de-duplication and the room lookup are handled for you. A stream that fails with
`UserOffline` on its first attempt tells you the streamer isn't live. Interrupting the stream closes the socket.

Schemas for the events themselves are in [`@tiklive/contracts`](../contracts/README.md).
