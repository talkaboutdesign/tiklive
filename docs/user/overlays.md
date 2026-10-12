# Overlays

The example overlays are plain HTML pages with no build step. The server serves them at `/overlays/`. The easiest
way to get one is the **Overlays** page (sidebar → Overlays, or `/overlays.html`). It shows every overlay with a
live preview, and you can copy its URL, change its options, and send test events to see the previews react. The
overlays are in [`examples/overlays`](../../examples/overlays) if you want to copy one.

Every overlay takes `username` (required, unless you use `demo`) and `token` (only if the server runs with
`--token`). The other options are listed below.

## Set up OBS

1. Run tiklive, with the desktop app or `npx tiklive`.
2. In OBS, add a **Browser Source** and paste an overlay URL. Copy it from the Overlays page, or write it by hand,
   for example `http://127.0.0.1:8080/overlays/chat.html?username=yourname`.
3. Set the source size to something like 1920×1080. Tick **Shutdown source when not visible** if you don't
   want the connection to stay open while the source is hidden.

To check an overlay without going live, use `username=demo`. It shows fake events.

## Overlays page

Open **Overlays** in the sidebar. Each overlay has a card with a live preview (the overlay at its real size, scaled
down):

- **Copy URL** copies the OBS URL for that overlay.
- **Customize** opens the overlay's options. Changing one updates the preview and the URL. The URL includes only the
  options you've changed from the defaults below, plus `username` and `token`.
- **Send test event** (top right) sends a fake chat message, gift, follow, share, subscribe or like to your
  username, so you can see the previews react without going live.

Your options are saved in this browser, so they're still there after a reload. The previews are always silent.

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

## Actions player: `/overlays/actions.html`

Plays the actions you set up on the Actions page: sounds, images, GIFs and videos, text-to-speech, and OBS scene
switches. Each action runs its steps together. Actions play one at a time, in the order they fired. See
[actions.md](./actions.md) for setting up actions.

The player depends on how you run tiklive:

- **Desktop app:** the app plays sounds and speech itself, through the computer's audio. The link on the Actions
  page leaves them out (`sounds=0&speech=0`), so the player in OBS shows pictures, GIFs, videos and scene switches
  only. Sounds and speech don't need anything set up in OBS.
- **Command-line server (`npx tiklive`):** there's no app to play them, so the player in OBS plays everything.
  Tick **Control audio via OBS** for its sounds and speech.

| Param      | Default | Meaning                                                 |
| ---------- | ------- | ------------------------------------------------------- |
| `username` | none    | Streamer whose actions to play (required)               |
| `sounds`   | on      | `0` turns sound steps off                               |
| `visuals`  | on      | `0` turns image, GIF and video steps off                |
| `speech`   | on      | `0` turns text-to-speech off                            |
| `obs`      | on      | `0` turns scene switches off                            |
| `volume`   | `1`     | Master volume, 0 to 1                                   |
| `queue`    | `20`    | Most actions waiting to play. Extra ones are dropped.   |
| `gap`      | `300`   | Milliseconds between actions                            |
| `debug`    | off     | `1` shows a status line (connection, queue, last error) |

Example: `/overlays/actions.html?username=yourname&speech=0&volume=0.8`

In the desktop app, the Actions player's URL on the Overlays page is the same URL with `&sounds=0&speech=0`
added. Tick **OBS plays sounds and speech too** there if you want OBS to play them instead, and turn off app sound in
the app's sidebar so they don't play twice.

OBS setup tips:

- Set the Browser Source size to 1920×1080. Media appears in the middle of the frame.
- Command-line server only: tick **Control audio via OBS** so sounds and speech go through OBS's mixer, where you
  can adjust their levels. Skip this with the desktop app, which plays them itself.
- For scene switches, set **Page permissions** to **Advanced access to OBS**. Without it, the player skips scene
  steps and logs a warning.
- Command-line server only: if speech is silent in OBS, open the player in a normal browser tab with
  `&visuals=0&obs=0` and capture that audio instead.

In a normal browser tab, the browser may block sound until you click the page. A **Click to enable sound** button
appears when that happens. OBS doesn't need it.

## Dashboard: `/`

The first time you open the dashboard, it asks for your TikTok username. tiklive saves it in this browser, so
later visits go straight to the dashboard. You don't need to be live for this: tiklive waits and connects when
you go live. To switch to another username, use **Settings** in the sidebar.

The dashboard is a live view of your room: your status and totals at the top, your chat with filters (followers,
friends, minimum follower count, hidden words), highlighted gifts and subscriptions, a gifts column with your top
gifters, and an optional video preview. Likes, joins and other events stay out of it. See
[desktop.md](./desktop.md#dashboard) for the details. The overlay URLs and their options are on the
[Overlays page](#overlays-page).

**Send test event** sends a fake event to every overlay connected to your username. It's enabled once connected.

Two cases don't save anything. `?username=` in the URL connects for that visit only. `demo` (typed in the form,
or from "Try the demo") shows fake events and is never saved. If the server runs with `--token`, open the
dashboard with `?token=`. The sidebar carries it to the Overlays page, and the overlay URLs include it.

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
