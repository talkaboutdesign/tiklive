# @tiklive/server

The tiklive server and CLI. It keeps one TikTok connection per streamer, shares its events with any number of
overlays and apps over WebSocket, and exposes a small REST API. The CLI is `packages/server/src/bin.ts`.

- **`Server.layer(options)`:** the routes, sessions and TikTok connection, as a layer that needs an HTTP server.
- **`SessionManager`:** one shared session per streamer. Sessions start on first use and stop after an idle timeout,
  or when watched with `watch`.
- **`Session`:** one streamer's connection, stats, status, and recent history.
- **`routes(options)`:** the HTTP and WebSocket routes, if you want to mount them in your own server.

## Run it

From a checkout of this repo:

```sh
bun run dev                         # builds the client, serves examples/overlays on :8080
bun packages/server/src/bin.ts --help
```

Full CLI flags and the REST and WebSocket API: [the root README](../../README.md#server) and
[docs/PROTOCOL.md](../../docs/PROTOCOL.md).

## Embed it

`Server.layer` needs an HTTP server layer. Bun example:

```ts
import { Server } from "@tiklive/server";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Layer from "effect/Layer";

const app = Server.layer({ sessions: { watch: ["someone"] } }).pipe(
  Layer.provide(
    BunHttpServer.layer({ port: 8080, hostname: "127.0.0.1", websocket: { maxPayloadLength: 64 * 1024 } }),
  ),
);

BunRuntime.runMain(Layer.launch(app));
```

Add `@effect/platform-bun` or `@effect/platform-node` as a dependency of your app. The platform layers in
`src/platform/` aren't exported from this package yet, so copy the pattern shown above.
`ServerOptions.port` and `host` are only read by those platform layers, not by `Server.layer`.
