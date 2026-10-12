# @tiklive/server

The tiklive server and CLI. It keeps one TikTok connection per streamer, shares its events with any number of
overlays and apps over WebSocket, and exposes a small REST API. The CLI is `packages/server/src/bin.ts`.

- **`Server.layer(options)`:** the routes, sessions and TikTok connection, as a layer that needs an HTTP server.
- **`SessionManager`:** one shared session per streamer. Sessions start on first use and stop after an idle timeout,
  or when watched with `watch`.
- **`Session`:** one streamer's connection, stats, status, and recent history.
- **`routes(options)`:** the HTTP and WebSocket routes, if you want to mount them in your own server.

## Run it

```sh
npx @tiklive/server --help          # or: bunx @tiklive/server
npx @tiklive/server --port 8080     # then connect overlays to ws://localhost:8080/ws
```

The `tiklive` bin starts with Node. To run it on Bun, install the package and run `bun node_modules/.bin/tiklive`.
From a checkout of this repo, `bun run dev` builds the client and serves `examples/overlays` on :8080.

Full CLI flags and the REST and WebSocket API: [the root README](https://github.com/talkaboutdesign/tiklive/blob/main/README.md#server) and
[docs/PROTOCOL.md](https://github.com/talkaboutdesign/tiklive/blob/main/docs/PROTOCOL.md).

## Embed it

`@tiklive/server/bun` and `@tiklive/server/node` export `layer(options)`, the server bound to that runtime's HTTP
server, and `runMain`:

```ts
import { layer, runMain } from "@tiklive/server/node"; // or "@tiklive/server/bun"
import * as Layer from "effect/Layer";

runMain(Layer.launch(layer({ port: 8080, sessions: { watch: ["someone"] } })));
```

`@effect/platform-node` and `@effect/platform-bun` come with this package. For another HTTP server, provide one to
`Server.layer(options)` yourself, as `src/platform/node.ts` does.
`ServerOptions.port` and `host` are only read by those platform layers, not by `Server.layer`.
`/tiklive.js` is served only when you pass `clientBundle`, e.g.
`fileURLToPath(import.meta.resolve("@tiklive/client/tiklive.js"))` (the CLI does this for you).
