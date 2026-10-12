# Run the server

The `tiklive` CLI runs the server. It keeps one TikTok connection per streamer, shares that streamer's
events with any number of overlays and apps over WebSocket, and exposes a small REST API. It needs Node 22+
or Bun.

## Command line

```sh
npx tiklive                     # or: bunx tiklive
npx tiklive --port 8080 --watch someone --token secret
```

The package includes the dashboard and the example overlays, and serves them at http://127.0.0.1:8080/
unless you pass `--static <dir>`. The CLI prints this help with `--help`:

```
Usage: tiklive [options]

  -p, --port <n>           Port (env PORT, default 8080)
      --host <addr>        Interface to bind (env HOST, default 127.0.0.1)
      --token <secret>     Require this token for the API and WebSocket (env TIKLIVE_TOKEN; required beyond localhost)
  -w, --watch <user>       Stay connected to a streamer; repeatable (env TIKLIVE_WATCH, comma-separated)
      --static <dir>       Serve a directory of overlays/pages
      --allow-origin <url> Allow browser pages from this origin to use the API; repeatable
      --allow-host <name>  Accept this Host header (default: localhost names only); repeatable
      --allow-no-token     Allow listening beyond localhost without --token (not recommended)
      --data-dir <dir>     Where action rules and uploads are kept (env TIKLIVE_DATA_DIR, default ~/.tiklive)
      --log-requests       Log every HTTP request
  -h, --help               Show this help
  -v, --version            Print the version

Clients connect to ws://HOST:PORT/ws. Use the username "demo" for fake events.

Dashboard: open http://127.0.0.1:8080/ in a browser (or the port you set) for the
built-in overlays (chat, goal, alerts). --static <dir> serves your own files instead.
```

The first line of the real help is `tiklive <version> — self-hosted TikTok LIVE event server`. The footer
is printed only when the bundled overlays are present, as they are in the published package.

From a checkout, run the CLI with Bun instead:

```sh
bun run start                                    # builds the client, serves examples/overlays
bun run dev                                      # same, and reloads when the server source changes
bun packages/server/src/bin.ts --watch someone --token secret
```

## Watching streamers

Without `--watch`, a streamer's connection starts when the first overlay subscribes, and it stops 60
seconds after the last one leaves. If the streamer is offline, the session checks every 30 seconds and
connects when they go live.

With `--watch` (or `TIKLIVE_WATCH`, comma-separated), the session stays connected and reconnects whenever
the streamer goes live.

## Tokens and remote access

- `--token` (or `TIKLIVE_TOKEN`) requires a secret for the API and the WebSocket. Send it as
  `Authorization: Bearer <token>` or as `?token=` on the URL. Overlays take it as `&token=`.
- The server binds to `127.0.0.1` by default. To reach it from another machine, pass `--host 0.0.0.0`
  (or another interface). A token is required for that: without `--token` (or `TIKLIVE_TOKEN`), the server
  refuses to start on a non-loopback `--host` and exits with an error. The `tiklive` CLI enforces this; if you
  embed the server with `Server.layer`, you set `token` and `allowedHosts` yourself.
- `--allow-no-token` lets the server listen beyond localhost without a token. It prints a warning and is not
  recommended: anyone who can reach the port can edit rules (including webhooks to LAN addresses), upload and
  delete media, and reset points.
- When you bind beyond localhost and don't pass `--allow-host`, the Host check is off. Any Host header is
  accepted, so the token is the only guard.

## Security

- The server binds to `127.0.0.1` by default. Nothing outside your machine can reach it.
- A **Host allowlist** (localhost names by default) blocks DNS-rebinding attacks against a local server.
- An **Origin check** stops other websites from driving your server from a browser. Same-origin pages and
  non-browser clients (OBS, curl) are allowed. Add `--allow-origin` for other origins.
- **`--token`** requires a secret for the API and WebSocket. It is required when `--host` is not localhost.
- Inputs are validated against the schemas. The simulate endpoint requires JSON, with a 64 KB body limit.
- Each WebSocket can follow at most 20 streamers by default (`maxSubscriptionsPerSocket`). Slow subscribers
  lose their oldest messages rather than making the server buffer without limit.
- Static files get security headers and a Content-Security-Policy. The Host and Origin checks apply to `/api`
  and `/ws` only, so don't put secrets in the static directory.

## Embedding the server

`tiklive/node` and `tiklive/bun` run the server on that runtime's HTTP server, with the same options as the CLI:

```ts
import { layer, runMain } from "tiklive/node"; // or "tiklive/bun"
import * as Layer from "effect/Layer";

runMain(
  Layer.launch(layer({ port: 8080, token: process.env.TIKLIVE_TOKEN, sessions: { watch: ["someone"] } })),
);
```

The platform HTTP layers come with the package, so you don't need to install `@effect/platform-*` yourself.

The root entry, `tiklive`, exports `Server.layer(options)`. It builds the routes and sessions but needs an
`HttpServer` layer to run. Provide one yourself, as `src/platform/node.ts` does for Node. `ServerOptions.port`
and `host` are read only by the platform layers, not by `Server.layer`. Pass `clientBundle` to serve
`/tiklive.js`, for example `fileURLToPath(import.meta.resolve("tiklive/tiklive.js"))`. The CLI does this for you.
Pass `dataDir` to keep action rules, uploads and viewer points on disk. Without it, rules and points stay in
memory until the server stops, and uploads are turned off.

## HTTP and WebSocket API

- WebSocket: `ws://127.0.0.1:8080/ws`. Subscribe to streamers, then receive events and status.
- REST: `/api/health`, `/api/sessions`, `/api/sessions/:username` (`PUT` or `DELETE` to watch and unwatch),
  `POST /api/sessions/:username/simulate` to inject a test event, and `/api/gifts` for the gift catalog.

The full message and endpoint reference is in [PROTOCOL.md](../PROTOCOL.md).
