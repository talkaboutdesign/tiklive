# tiklive

tiklive is an open-source TikTok LIVE connector and event server. It turns TikTok's LIVE WebSocket into
typed JSON events for stream overlays: chats, gifts, likes, follows, shares, joins, subs and viewer counts.
It ships a browser client, starter overlays (chat, alerts, goal bar), a dashboard, and a demo mode, so you
can build overlays without being live.

**[Download the desktop app for macOS and Windows](https://github.com/talkaboutdesign/tiklive/releases/latest)**,
or run `npx tiklive`.

## Why

- No third-party signing service, no TikTok login, no headless browser. tiklive makes plain HTTPS calls to
  tiktok.com with an anonymous `ttwid` cookie.
- Read-only. It observes a stream. It can't send chat messages or act on the stream.
- Self-hosted. The server binds to `127.0.0.1` by default, so nothing leaves your machine.
- MIT licensed.

tiklive uses TikTok's private web protocol, which is not an official API. See [Notes](#notes).

## Install

### Desktop app

Download the app from [GitHub Releases](https://github.com/talkaboutdesign/tiklive/releases). It runs the
server on `127.0.0.1:8080`, shows the dashboard, and updates itself.

- **macOS:** a DMG for Apple Silicon and a DMG for Intel.
- **Windows:** an x64 installer. It isn't code-signed yet, so SmartScreen warns on first run. Click
  **More info**, then **Run anyway**.

See [docs/user/desktop.md](docs/user/desktop.md).

### Command line

Needs Node 22+ or Bun.

```sh
npx tiklive            # or: bunx tiklive
```

Open http://127.0.0.1:8080/ for the dashboard. Type `demo` as the username to get fake events.
Options are in [docs/user/server.md](docs/user/server.md).

### As a library

```sh
npm install tiklive effect
```

`effect` is a peer dependency of the library entry points. See [Library](#library).

## Quick start

1. Start tiklive, with the desktop app or `npx tiklive`.
2. Open http://127.0.0.1:8080/ and enter a TikTok username. tiklive connects when that streamer is live.
3. In OBS, add a **Browser Source** and paste an overlay URL:

| Overlay  | URL                                                                                |
| -------- | ---------------------------------------------------------------------------------- |
| Chat     | `http://127.0.0.1:8080/overlays/chat.html?username=NAME`                           |
| Alerts   | `http://127.0.0.1:8080/overlays/alerts.html?username=NAME`                         |
| Goal bar | `http://127.0.0.1:8080/overlays/goal.html?username=NAME&metric=likes&target=10000` |

Add `&token=…` if the server runs with `--token`. Use `username=demo` to test with fake events. Every
option is in [docs/user/overlays.md](docs/user/overlays.md).

## Library

| Import               | What it is                                                                |
| -------------------- | ------------------------------------------------------------------------- |
| `tiklive`            | The server: `Server.layer`, `SessionManager`, `Session`, `routes`         |
| `tiklive/node`       | The server on Node's HTTP server: `layer`, `runMain`                      |
| `tiklive/bun`        | The server on Bun's HTTP server: `layer`, `runMain`                       |
| `tiklive/core`       | The TikTok connector: `LiveConnection`, `TikTokWeb`, errors, `demoEvents` |
| `tiklive/client`     | The `TikLive` client for browsers, Bun and Node. No runtime dependencies  |
| `tiklive/contracts`  | Event and protocol schemas and types                                      |
| `tiklive/testing`    | Fakes for tests: a scriptable socket, room lookups, frame builders        |
| `tiklive/tiklive.js` | The browser client bundle, served at `/tiklive.js`                        |

Connect to TikTok LIVE from your own Effect program:

```ts
import { LiveConnection } from "tiklive/core";
import { Effect, Stream } from "effect";

LiveConnection.events("someone").pipe(
  Stream.runForEach((e) => Effect.log(e.type, e.timestamp)),
  Effect.provide(LiveConnection.layer()),
  Effect.runPromise,
);
```

Or follow a running server from Node or Bun:

```ts
import { TikLive } from "tiklive/client";

const live = new TikLive({ username: "demo", server: "ws://127.0.0.1:8080/ws" });
live.on("gift", (e) => {
  if (!e.streaking) console.log(`${e.user.nickname} sent ${e.repeatCount}× ${e.giftName}`);
});
```

Each subpath is covered in [docs/user/library.md](docs/user/library.md). Embedding the server is in
[docs/user/server.md](docs/user/server.md#embedding-the-server).

## Notes

- This is TikTok's private web protocol, not an official API. TikTok can change it at any time. Check
  TikTok's Terms of Service for your use case.
- tiklive is read-only, and it has no resume cursor. Events can be missed while a connection reconnects.
  Duplicates are removed by message ID.
- Behind a VPN or a datacenter IP, TikTok may refuse the connection.
- Keep the server on `127.0.0.1` (the default), or set `--token` before you expose it.

## Documentation

Start at [docs/README.md](docs/README.md).

- [Run the server](docs/user/server.md): command-line options, watching streamers, tokens, security, embedding
- [Overlays](docs/user/overlays.md): OBS setup and the built-in overlays
- [Library](docs/user/library.md): connector, client, contracts, testing fakes, events
- [Desktop app](docs/user/desktop.md): install, updates, first launch
- [Wire protocol](docs/PROTOCOL.md): WebSocket messages, REST endpoints, event types
- [Architecture](docs/ARCHITECTURE.md): packages, data flow, design notes
- [Release runbook](docs/operations/release.md): changesets, releases, signing (maintainers)
- [Contributing](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) (repo map and conventions)

## Building from source

Requires [Bun](https://bun.sh) 1.4.3, pinned in `package.json`.

```sh
bun install
bun run dev              # builds the client, serves the overlays at http://127.0.0.1:8080
bun run desktop:dev      # runs the desktop app from the checkout
```

`bun run dev` reloads the server when its source changes. `bun run start` runs it without watching.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks, tests and workflow.

## License

[MIT](LICENSE). Copyright 2026 Talkabout Design LLC.
