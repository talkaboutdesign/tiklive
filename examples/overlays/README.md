# Example overlays

A dashboard and three OBS overlays built on the `/tiklive.js` client. They are plain HTML
files with no build step, so you can copy one and start editing.

## Running

From the repo root:

```sh
bun run dev        # auto-reloads while you work on the server
# or
bun run start
```

Both serve this folder at **http://localhost:8080** (use `PORT` or `--port` to change it).
Build the client first with `bun run build` so that `/tiklive.js` exists.

Open the dashboard, enter a TikTok username (or `demo` for fake events), and copy an overlay URL
into an OBS **Browser Source**. Set the source size to something like 1920×1080 and tick
"Shutdown source when not visible" if you don't want the connection to stay open.

## Overlays

Every overlay takes `username` (required unless you use `demo`) and `token` (only if the
server runs with `--token`). Other options are listed below.

### Chat — `/overlays/chat.html`

| Param      | Default | Meaning                                            |
| ---------- | ------- | -------------------------------------------------- |
| `username` | `demo`  | Streamer to follow                                 |
| `max`      | `12`    | Messages kept on screen                            |
| `fade`     | `30`    | Seconds before a message fades out; `0` keeps them |
| `joins`    | off     | `1` shows viewers joining                          |
| `gifts`    | off     | `1` shows finished gifts                           |
| `follows`  | off     | `1` shows follows                                  |

Example: `/overlays/chat.html?username=yourname&max=8&fade=0`

### Alerts — `/overlays/alerts.html`

Shows gift, follow, subscribe and share alerts one at a time, in a queue.

| Param      | Default | Meaning                            |
| ---------- | ------- | ---------------------------------- |
| `username` | `demo`  | Streamer to follow                 |
| `min`      | `1`     | Minimum coins for a gift alert     |
| `duration` | `5`     | Seconds each alert stays on screen |
| `follows`  | on      | `0` turns follow alerts off        |
| `subs`     | on      | `0` turns subscribe alerts off     |
| `shares`   | on      | `0` turns share alerts off         |

Gift alerts fire once, when a streak ends, and use the final total.

Example: `/overlays/alerts.html?username=yourname&min=100&duration=4`

### Goal bar — `/overlays/goal.html`

A progress bar driven by the streamer's running totals.

| Param      | Default    | Meaning                                                       |
| ---------- | ---------- | ------------------------------------------------------------- |
| `username` | `demo`     | Streamer to follow                                            |
| `metric`   | `likes`    | `likes`, `diamonds` (coins), `follows`, `shares` or `viewers` |
| `target`   | `1000`     | Goal value                                                    |
| `label`    | per metric | Custom label text                                             |

Example: `/overlays/goal.html?username=yourname&metric=diamonds&target=5000&label=Coin%20goal`

### Dashboard — `/`

Connects to a streamer, shows the live event log and status, lists the overlay URLs with
copy buttons, and has test buttons that send fake events to every overlay connected to that
streamer. Pass `?username=` in the URL to connect on load.

## Writing your own overlay

Save an HTML file somewhere the server can serve it, then import the client. The options
default from the page URL, so `?username=` and `?token=` work without any code.

```html
<script type="module">
  import { TikLive } from "/tiklive.js";

  const live = new TikLive(); // reads ?username= and ?token= from the page URL

  live.on("chat", (e, meta) => {
    console.log(`${e.user.nickname}: ${e.comment}`);
  });

  live.on("gift", (e) => {
    if (e.streaking) return; // wait for the combo to finish
    console.log(`${e.user.nickname} sent ${e.repeatCount}× ${e.giftName}`);
  });

  live.on("status", (s) => console.log(s.state, s.stats.viewers));
  live.on("error", (err) => console.warn(err.message));
</script>
```

Options (all optional):

- `username`: streamer to follow (default `?username=`, then `demo`)
- `token`: access token (default `?token=`)
- `server`: WebSocket URL, such as `ws://localhost:8080/ws` (default: this page's host)
- `events`: only these event types, such as `['chat', 'gift']`. Omit it for all events, or pass `[]` for status only.
- `replay`: `true` replays recent events on connect, which suits chat boxes
- `reconnect`: `false` disables automatic reconnection (on by default)

Listen for an event type (`chat`, `gift`, `like`, `follow`, `share`, `join`, `subscribe`,
`question`, `emote`, `viewers`, `streamEnd`), or for `*` (every event), `status`, `hello`,
`error`, `open` or `close`. Each `on()` call returns a function that removes the handler.

Escape or avoid HTML for anything from the event payload. Use `textContent`, or build nodes
with `document.createElement`. Only use `http:` or `https:` URLs for `img.src`. The
dashboard's `safeUrl` helper shows one way to do this.

The event shapes are documented in `packages/contracts/src/events.ts`.
