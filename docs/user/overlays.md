# Overlays

The example overlays are plain HTML pages with no build step. The server serves them at `/overlays/`, and the
dashboard is at `/`. They're in [`examples/overlays`](../../examples/overlays) if you want to copy one.

Every overlay takes `username` (required, unless you use `demo`) and `token` (only if the server runs with
`--token`). The other options are listed below.

## Set up OBS

1. Run tiklive, with the desktop app or `npx tiklive`.
2. In OBS, add a **Browser Source** and paste an overlay URL, for example
   `http://127.0.0.1:8080/overlays/chat.html?username=yourname`.
3. Set the source size to something like 1920×1080. Tick **Shutdown source when not visible** if you don't
   want the connection to stay open while the source is hidden.

To check an overlay without going live, use `username=demo`. It shows fake events.

## Chat: `/overlays/chat.html`

| Param      | Default | Meaning                                            |
| ---------- | ------- | -------------------------------------------------- |
| `username` | `demo`  | Streamer to follow                                 |
| `max`      | `12`    | Messages kept on screen                            |
| `fade`     | `30`    | Seconds before a message fades out; `0` keeps them |
| `joins`    | off     | `1` shows viewers joining                          |
| `gifts`    | off     | `1` shows finished gifts                           |
| `follows`  | off     | `1` shows follows                                  |

Example: `/overlays/chat.html?username=yourname&max=8&fade=0`

## Alerts: `/overlays/alerts.html`

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

## Goal bar: `/overlays/goal.html`

A progress bar driven by the streamer's running totals.

| Param      | Default    | Meaning                                                       |
| ---------- | ---------- | ------------------------------------------------------------- |
| `username` | `demo`     | Streamer to follow                                            |
| `metric`   | `likes`    | `likes`, `diamonds` (coins), `follows`, `shares` or `viewers` |
| `target`   | `1000`     | Goal value                                                    |
| `label`    | per metric | Custom label text                                             |

Example: `/overlays/goal.html?username=yourname&metric=diamonds&target=5000&label=Coin%20goal`

## Dashboard: `/`

Connects to a streamer, shows the live event log and status, lists the overlay URLs with copy buttons, and
has test buttons that send fake events to every overlay connected to that streamer. Pass `?username=` in the
URL to connect on load.

## Write your own overlay

Save an HTML file somewhere the server can serve it, then import the client. Its options default from the page
URL, so `?username=` and `?token=` work without any code:

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

The options and handlers are in [library.md](./library.md), under Client. In short:

- `username`, `token`, `server` (WebSocket URL, default: this page's host), `events` (for example
  `['chat', 'gift']`, or `[]` for status only), `replay` (replay recent events on connect, which suits chat
  boxes), `reconnect` (`false` turns off automatic reconnection).
- Listen for an event type, `*` for every event, or `status`, `hello`, `error`, `open` or `close`. Each `on()`
  call returns a function that removes the handler.

Escape or avoid HTML for anything from the event payload. Use `textContent`, or build nodes with
`document.createElement`. Only use `http:` or `https:` URLs for `img.src`. The dashboard's `safeUrl` helper
shows one way to do this.

The event shapes are in [library.md](./library.md#events).
