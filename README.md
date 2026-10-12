# tiklive

Self-hosted TikTok LIVE event server for building stream overlays.

Run it next to OBS, point it at a TikTok username, and get chats, gifts, likes,
follows, shares, joins, subs and viewer counts as clean JSON over a WebSocket.
It includes a browser client, starter overlays (chat, alerts, goal bar), a dashboard,
and a demo mode so you can build overlays without being live.

There's no third-party signing service, no TikTok login and no headless browser:
just Node talking to TikTok directly.

## Quick start

```sh
npm install
npm run build
npm start                 # http://localhost:8080
```

Open the dashboard at http://localhost:8080, enter a username (or `demo`), and copy
an overlay URL into an OBS **Browser Source**.

```sh
npm run dev               # auto-reload while hacking on the server
npm test
```

### Options

| Flag | Env | Default | |
|---|---|---|---|
| `-p, --port` | `PORT` | `8080` | |
| `--host` | `HOST` | `127.0.0.1` | Use `0.0.0.0` to expose on your network |
| `--token` | `TIKLIVE_TOKEN` | – | Require a token for the API and WebSocket |
| `-w, --watch <user>` | `TIKLIVE_WATCH` (comma-separated) | – | Stay connected; auto-connect whenever they go live |

Without `--watch`, a streamer's session starts when the first overlay subscribes and
stops 60s after the last one leaves. If the streamer is offline, the session waits and
checks every 30s, connecting as soon as they go live.

## Overlays

| URL | |
|---|---|
| `/overlays/chat.html?username=NAME` | Chat box. `&max=12`, `&fade=30` (0 = never), `&joins=1`, `&gifts=1`, `&follows=1` |
| `/overlays/alerts.html?username=NAME` | Queued gift/follow/sub/share alerts. `&min=100` (min coins), `&duration=5`, `&follows=0` … |
| `/overlays/goal.html?username=NAME&metric=likes&target=10000` | Goal bar. `metric`: `likes`, `diamonds`, `follows`, `shares`, `viewers` |

Add `&token=…` if the server uses one. Use `username=demo` to test with fake events.

### Writing your own overlay

Put an HTML file in `public/` (or anywhere) and use the client:

```html
<script type="module">
  import { TikLive } from '/tiklive.js';

  const live = new TikLive();            // reads ?username= and ?token= from the page URL
  live.on('chat', (e) => console.log(`${e.user.nickname}: ${e.comment}`));
  live.on('gift', (e) => {
    if (e.streaking) return;             // wait until a combo finishes
    console.log(`${e.user.nickname} sent ${e.repeatCount}× ${e.giftName} (${e.totalDiamonds} coins)`);
  });
  live.on('status', (s) => console.log(s.state, s.stats));
</script>
```

`new TikLive({ username, token, events: ['chat', 'gift'], replay: true, server: 'ws://host:8080/ws' })`:
every option is optional. `replay: true` sends the last ~50 events on connect, which is handy for chat boxes.

## Events

Each event has `type`, `timestamp` (ms), and usually `msgId`. Users look like:

```ts
{ userId, uniqueId /* @handle */, nickname, profilePictureUrl,
  isModerator?, isSubscriber?, isFollower?, isGifter? }
```

| type | fields |
|---|---|
| `chat` | `user`, `comment`, `emotes[]` |
| `gift` | `user`, `giftId`, `giftName`, `giftImageUrl`, `diamondCount`, `repeatCount`, `streaking`, `totalDiamonds`, `groupId`, `receiver?` |
| `like` | `user`, `likeCount`, `totalLikeCount` |
| `follow` / `share` / `join` | `user` |
| `subscribe` | `user`, `subMonth` |
| `question` | `user`, `question` |
| `emote` | `user`, `emotes[]` |
| `viewers` | `viewerCount`, `topViewers[]` (`user`, `coinCount`, `rank`) |
| `streamEnd` | `reason`: `ended` \| `suspended` |

**Gift streaks:** streakable gifts (Rose, etc.) fire repeatedly while a viewer holds the
combo, with `streaking: true` and a rising `repeatCount`. The final event has
`streaking: false`. Alerts and coin totals should use that one.

The TypeScript definitions live in [`src/events.ts`](src/events.ts).

## WebSocket protocol

Connect to `ws://localhost:8080/ws` (append `?token=` if required). Send:

```json
{ "action": "subscribe", "username": "someone", "events": ["chat", "gift"], "replay": true }
{ "action": "unsubscribe", "username": "someone" }
```

Omit `events` for everything; `[]` means status updates only. One socket can follow
several streamers. Shortcut: `/ws?username=someone&events=chat,gift&replay=1`.

You'll receive:

```json
{ "type": "event",  "username": "someone", "event": { "type": "chat", ... }, "replay": false }
{ "type": "status", "username": "someone", "status": { "state": "live", "stats": { ... }, ... } }
{ "type": "error",  "message": "..." }
```

`status.state` is one of `connecting`, `live`, `waiting` (offline, checking again
soon), `error` or `idle`. `status.stats` holds running totals for the current
stream: `likes`, `diamonds`, `follows`, `shares`, `joins`, `chats`, `viewers`,
`peakViewers`. It's pushed at most once per second.

## REST API

| | |
|---|---|
| `GET /api/health` | Liveness (no auth) |
| `GET /api/sessions` | All sessions with state, stats, overlay count |
| `GET /api/sessions/:user` | One session |
| `POST /api/sessions/:user` | Watch permanently (same as `--watch`) |
| `DELETE /api/sessions/:user` | Stop watching |
| `POST /api/sessions/:user/simulate` | Inject a test event, e.g. `{"type":"follow","user":{...}}` |

## Using it as a library

```ts
import { TikTokLiveConnection } from 'tiklive';

const conn = new TikTokLiveConnection('someone');
conn.on('chat', (e) => console.log(e.user.uniqueId, e.comment));
conn.on('gift', (e) => !e.streaking && console.log(e.giftName, e.totalDiamonds));
conn.on('disconnected', ({ willReconnect }) => console.log('dropped; reconnecting:', willReconnect));
await conn.connect();     // throws UserOfflineError if they're not live
```

Also exported: `LiveServer` (embed the server in your own app), `TikTokWeb` (room lookups),
`decodeLiveEvent` and the frame codec. The `rawMessage` event exposes every protobuf
message, including types without a normalized event, if you want to decode more.

## How it works

1. **Room lookup:** `GET tiktok.com/api-live/user/room/?uniqueId=…` returns the
   current room ID and whether the user is live. It doesn't need a signature.
2. **Device cookie:** a plain `GET tiktok.com/` issues an anonymous `ttwid` cookie.
3. **WebSocket:** connect to
   `wss://webcast-ws.tiktok.com/webcast/im/ws_proxy/ws_reuse_supplement/?room_id=…`
   with that cookie (falls back to `webcast-ws.us.tiktok.com`). Then send an `im_enter_room`
   frame, a heartbeat every 10s, and an ack per batch.
4. **Decoding:** frames are protobuf envelopes holding gzipped batches of webcast
   messages (`WebcastChatMessage`, `WebcastGiftMessage`, …). A small hand-written
   decoder ([`src/proto`](src/proto)) reads only the fields overlays need, so new
   fields from TikTok don't break anything.

TikTok's website adds a signed HTTP request (`X-Bogus` / `X-Gnarly` / `X-Dynosaur`) before
opening the socket. That's what libraries normally need a signing service or browser for.
The socket itself doesn't depend on that request, so tiklive skips it.

## Caveats

- This uses TikTok's private web protocol, not an official API. TikTok can change it at
  any time, and you should review their Terms of Service for your use case.
- It's read-only: it can't send chat messages.
- The skipped signed request is what normally provides a resume cursor. On reconnect
  you may miss events from the gap. Messages seen twice are de-duplicated.
- Behind a VPN or datacenter IP, TikTok may refuse the cookie or socket.
- Keep the server on `127.0.0.1` (the default) or set `--token` before exposing it.
