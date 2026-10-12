# @tiklive/client

A typed client for tiklive servers. It connects to a server over WebSocket, subscribes to a streamer, and calls your
handlers for each event. It has **no runtime dependencies** and no Effect code. Its types come from
[`@tiklive/contracts`](../contracts/README.md) and are erased at build time.

It runs in browsers, and in Bun or Node wherever there's a global `WebSocket`.

## Usage

Served by the server at `/tiklive.js`:

```html
<script type="module">
  import { TikLive } from "/tiklive.js";

  const live = new TikLive({ username: "someone" }); // or leave out; reads ?username= from the page URL
  live.on("chat", (e, meta) => console.log(meta.replay ? "(replay)" : "", e.user.nickname, e.comment));
  live.on("gift", (e) => {
    if (!e.streaking) console.log(e.giftName, e.totalDiamonds);
  });
  live.on("status", (s) => console.log(s.state, s.stats.viewers));
</script>
```

From Node or Bun:

```ts
import { TikLive } from "@tiklive/client";

const live = new TikLive({ username: "demo", server: "ws://127.0.0.1:8080/ws" });
live.on("*", (e) => console.log(e.type));
```

## Options

| Option      | Default                     |                                                          |
| ----------- | --------------------------- | -------------------------------------------------------- |
| `username`  | `?username=`, then `"demo"` | Streamer to follow                                       |
| `server`    | this page's host, `/ws`     | WebSocket URL. Required outside a page                   |
| `token`     | `?token=`                   | Access token, if the server uses one                     |
| `events`    | all                         | Only these event types. `[]` for status only             |
| `replay`    | `false`                     | Ask for recent events on connect                         |
| `WebSocket` | global `WebSocket`          | Constructor to use (tests, older runtimes)               |
| `reconnect` | `true`                      | Reconnect with backoff (500 ms doubling, capped at 10 s) |

## Handlers

`live.on(type, handler)` returns a function that removes the handler.

- Event types (`chat`, `gift`, `like`, `follow`, `share`, `join`, `subscribe`, `question`, `emote`, `viewers`, `streamEnd`)
  get `(event, meta)`.
- `"*"` gets every event.
- `"status"`, `"hello"`, `"error"`, `"open"`, `"close"` get their own payloads.

A handler that throws is logged with `console.error`, and the other handlers still run.

The full protocol is in [docs/PROTOCOL.md](../../docs/PROTOCOL.md). Build the bundle with `bun run build` in this
package or from the root. It writes `dist/tiklive.js`, which the server serves.
