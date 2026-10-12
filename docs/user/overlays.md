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

## Timer: `/overlays/timer.html`

A subathon countdown. It starts at `start` minutes and counts down in real time. Gifts, follows, subscribes and
shares add time. Each addition shows a short toast such as `+2:30 · nickname`. When the clock hits zero it shows
**Time's up!** and stops adding time.

The end time is saved in the browser, so an OBS reload keeps the remaining time. Each `id` has its own saved time.

| Param       | Default    | Meaning                                                             |
| ----------- | ---------- | ------------------------------------------------------------------- |
| `username`  | `demo`     | Streamer to follow                                                  |
| `start`     | `60`       | Starting time, in minutes                                           |
| `perCoin`   | `10`       | Seconds added per coin. A finished gift adds its total coins × this |
| `perFollow` | `30`       | Seconds added per follow                                            |
| `perSub`    | `300`      | Seconds added per subscribe                                         |
| `perShare`  | `0`        | Seconds added per share                                             |
| `max`       | none       | Cap on the remaining time, in minutes. Extra time is clamped to it  |
| `label`     | `Subathon` | Text above the clock                                                |
| `id`        | `default`  | Name for the saved time. Use another name for a second timer        |
| `reset`     | off        | `1` clears the saved time on load, so the countdown starts again    |

Gifts count once per combo, when it ends, using the combo's total. Replayed events never add time. Keep `reset=1`
only while you set up the overlay: with it on, every reload starts the countdown again.

Example: `/overlays/timer.html?username=yourname&start=120&perSub=600&max=240&label=Subathon%20hour`

## Leaderboard: `/overlays/leaderboard.html`

Top gifters and likers for the current stream. Coins come from finished gift combos, and likes come from the
like count. Rows reorder with a short animation, and the top three get a crown and medal colours.

Totals are saved per stream, so an OBS reload keeps them. When a new stream starts, the totals start from zero.
Gifts and likes sent while the page is closed aren't counted, because the overlay doesn't ask for replayed events.

| Param      | Default    | Meaning                                                        |
| ---------- | ---------- | -------------------------------------------------------------- |
| `username` | `demo`     | Streamer to follow                                             |
| `metric`   | `gifts`    | `gifts` (coins), `likes`, or `both` (two columns)              |
| `limit`    | `5`        | Rows per column, 1 to 10                                       |
| `title`    | per metric | Heading. Defaults to Top gifters, Top likers or Top supporters |
| `id`       | `default`  | Name for the saved totals                                      |
| `reset`    | off        | `1` clears the saved totals on load                            |

Example: `/overlays/leaderboard.html?username=yourname&metric=both&limit=3`

## Spin the wheel: `/overlays/wheel.html`

A wheel that spins when a gift or a chat command comes in, then lands on a random option. A result banner shows
`nickname: option` for six seconds. Spins queue up, up to 10 waiting, and run one after another.

A spin starts when a finished gift matches `gift` (by name, not case-sensitive), or when a finished gift is worth
at least `minCoins`. It also starts when a chat message starts with `command`. Set `commandFrom=moderators` (the
default) to accept the command from moderators and the streamer only. Replayed events never spin the wheel.

| Param         | Default                                              | Meaning                                                                            |
| ------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `username`    | `demo`                                               | Streamer to follow                                                                 |
| `options`     | `Dance,Sing,Push-ups,Shout out,Spin again,Free pick` | Comma-separated segments, 2 to 20                                                  |
| `gift`        | none                                                 | Gift name that spins the wheel                                                     |
| `minCoins`    | `0`                                                  | Finished gifts worth this many coins or more spin it. `0` is off                   |
| `command`     | none                                                 | Chat command that spins it, for example `!spin`                                    |
| `commandFrom` | `moderators`                                         | `moderators` or `everyone`                                                         |
| `speak`       | off                                                  | `1` reads each result aloud                                                        |
| `hideIdle`    | off                                                  | `1` hides the wheel when it isn't spinning. Otherwise it stays faded in the corner |
| `title`       | `Spin the wheel`                                     | Heading above the wheel                                                            |

Example: `/overlays/wheel.html?username=yourname&gift=Rose&minCoins=100&command=!spin&hideIdle=1`

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
