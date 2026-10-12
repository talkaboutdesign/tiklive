# Wire protocol

This is the JSON protocol between a tiklive server and its clients (overlays, dashboards,
apps). The schemas live in [`packages/contracts`](../packages/contracts/src); this page
describes them. If the two disagree, the schemas win and this page needs a fix.

Current protocol version: **1** (`PROTOCOL_VERSION` in `packages/contracts/src/protocol.ts`).

## Connection

```
ws://HOST:PORT/ws          wss:// when the server is behind a TLS proxy
```

Default is `ws://127.0.0.1:8080/ws`. Every text frame is one JSON message. The server
sends `hello` first, before any client message.

### Authentication

Only needed when the server runs with `--token` (or a custom `authorize` hook).

- `Authorization: Bearer <token>` header, or
- `?token=<token>` query parameter (what browser overlays use, since they can't set headers).

If both are present, the header wins. A missing or wrong token gets HTTP `401` before the
upgrade (`{"error":"Unauthorized"}`).

### Origin and Host checks

Applied before the upgrade and before any API call:

- **Host** must be on the allowlist (default `localhost`, `127.0.0.1`, `[::1]`). Otherwise `403`.
- **Origin**, if sent by a browser, must match the server's own origin or be in
  `allowedOrigins` / `--allow-origin`. Otherwise `403`.

Requests without an `Origin` header (OBS, curl, Node, Bun) are allowed.

## Messages

### Client to server

```ts
// Follow a streamer. Replaces any earlier subscription to the same username.
{ action: "subscribe", username: string, events?: LiveEventType[], replay?: boolean, actions?: boolean }

// Stop following a streamer.
{ action: "unsubscribe", username: string }
```

- `username` is normalized server-side: `@Name`, `name`, and `tiktok.com/@name` all work.
  Invalid names get an `invalid_username` error.
- `events` omitted: all event types. `[]`: status updates only, no events.
- `replay: true`: send recent events first (see [Replay](#replay)).
- `actions: true`: also send `action` messages for this streamer (see [Actions](#actions)). Default off.
- One socket can follow several streamers. The limit is `maxSubscriptionsPerSocket`
  (default **20**). Re-subscribing to a streamer you already follow doesn't count again.

### Server to client

```ts
{ type: "hello", protocolVersion: number, serverVersion: string }
{ type: "event", username: string, event: LiveEvent, replay?: true }
{ type: "status", username: string, status: SessionStatus }
{ type: "action", username: string, action: FiredAction }
{ type: "error", code: ErrorCode, message: string }
```

- **`hello`** is sent once per connection, before anything else. Check `protocolVersion`
  against what your client expects.
- **`event`** carries one [event](#event-types). `replay` is present (and `true`) only for
  events replayed from history. Live events omit the key.
- **`status`** is sent right after each subscribe, on every state change, and at most once
  per second while the stats change. Subscribers get no status after unsubscribing.
- **`action`** is sent when one of the streamer's [action rules](#actions) fires. Only
  subscriptions with `actions: true` get it. It is never replayed, and `events` doesn't filter it.
- **`error`** is about the last client message. The connection stays open.

### Order on subscribe

1. `status` for the streamer (current state and stats)
2. `event` messages with `replay: true`, oldest first, if `replay` was requested
3. live `event`, `action` and `status` messages

`events` filters both replayed and live events. It never filters `status` or `action`.

### Replay

With `replay: true`, the server sends its last **50** events for that streamer (default
history size). Likes and viewer-count updates are never kept in history, because they're too
frequent to be useful when replayed.

### Shortcut URL

Overlays can subscribe without sending a message:

```
ws://localhost:8080/ws?username=someone&events=chat,gift&replay=1&actions=1
```

- `username`: subscribes right after `hello`.
- `events`: comma-separated. Unknown names are dropped silently. If none are valid, you get
  status updates only.
- `replay=1`: same as `replay: true`. Any other value means off.
- `actions=1`: same as `actions: true`. Any other value means off.

Query `token` works here too.

## Error codes

| `code`                   | When                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `invalid_message`        | Not JSON, doesn't match a client message, or the text is over 16 KB        |
| `invalid_username`       | The username doesn't normalize to a valid TikTok handle                    |
| `too_many_subscriptions` | The socket already follows `maxSubscriptionsPerSocket` streamers           |
| `internal`               | Reserved. Declared in the schema, but the server doesn't currently send it |

Errors don't close the connection.

## REST API

All routes except `/api/health` go through the Host, Origin and token checks above. The exceptions
are `/media/:file` and the static files: they aren't guarded, because OBS loads them as plain
`<img>`, `<audio>` and `<video>` sources and can't send headers.
Responses are JSON. Errors look like `{"error": "message"}`.

| Method and path                         | Success                                | Notes                                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                       | `200 {ok: true, protocolVersion}`      | No auth, no Host or Origin check                                                                                                                                                                         |
| `GET /api/sessions`                     | `200 {sessions: SessionInfo[]}`        | Only sessions that are running                                                                                                                                                                           |
| `GET /api/sessions/:username`           | `200 SessionStatus`                    | `404` if no session is running for that streamer                                                                                                                                                         |
| `PUT` or `POST /api/sessions/:username` | `200 SessionStatus & {watching: true}` | Keeps the session running until `DELETE`. Same as `--watch`                                                                                                                                              |
| `DELETE /api/sessions/:username`        | `200 {ok: true}`                       | Stops watching. The session still closes after its subscribers leave and the idle timeout passes                                                                                                         |
| `POST /api/sessions/:username/simulate` | `200 {ok: true, event}`                | Injects an event as if TikTok sent it. Needs a running session                                                                                                                                           |
| `GET /api/gifts`                        | `200 {gifts: GiftInfo[]}`              | TikTok's gift catalog, sorted by price. Cached for an hour. `502` if TikTok's lookup fails                                                                                                               |
| `GET /api/rules`                        | `200 RuleSet`                          | The action rules and their `revision`                                                                                                                                                                    |
| `PUT /api/rules`                        | `200 RuleSet`                          | Body is a `RuleSet` whose `revision` is the one you last read. `409` if the rules changed since. Up to 1 MB                                                                                              |
| `POST /api/rules/:id/test`              | `200 {ok: true, action}`               | Body `{username}`. Fires rule `:id` once, with a sample event, for a streamer with a running session. The action has `test: true`. `404` if either is missing                                            |
| `GET /api/media`                        | `200 {media: MediaItem[]}`             | Uploaded files, newest first                                                                                                                                                                             |
| `POST /api/media`                       | `201 MediaItem`                        | Raw file bytes. `Content-Type` is the file's type, and `X-File-Name` its percent-encoded name. Up to 25 MB. Needs `--data-dir`                                                                           |
| `PATCH /api/media/:id`                  | `200 MediaItem`                        | Body `{name}` (1 to 200 characters). Renames the item for display. Its file and `url` stay the same. `404` if no such item                                                                               |
| `DELETE /api/media/:id`                 | `200 {ok: true}`                       | `404` if no such item                                                                                                                                                                                    |
| `GET /api/sounds/search?q=&page=`       | `200 SoundSearchResponse`              | Searches myinstants.com. `q` is 1 to 100 characters, `page` 1 to 50. Cached for 10 minutes. `400` for a bad `q`, `502` if MyInstants fails                                                               |
| `POST /api/media/import`                | `201 MediaItem`                        | Body `{url, name?}`. Copies a MyInstants sound (`https://www.myinstants.com/media/sounds/<file>.mp3`) into the library. `400` for any other URL, `502` if the download fails, `503` without `--data-dir` |
| `GET /media/:file`                      | `200` the file                         | Not guarded (see above). Cached for a year. `Range` requests (for seeking in video) work on Bun. On Node the whole file is sent                                                                          |

Status codes used across these routes:

| Status | Meaning                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid username, invalid JSON, a body that fails validation (rules, events), or a duplicate rule id                                              |
| `401`  | Missing or wrong token                                                                                                                            |
| `403`  | Host or Origin not allowed                                                                                                                        |
| `404`  | No such session, rule or media item (or unknown path under `/api`)                                                                                |
| `405`  | Method not supported on that route                                                                                                                |
| `409`  | Rules were saved since you read them. The body has `revision`, the current one                                                                    |
| `413`  | Simulate body over 64 KB, rules over 1 MB, test or import body over 16 KB, or upload over 25 MB                                                   |
| `415`  | Body isn't JSON where JSON is required (simulate, rules, the test and import endpoints), or an upload of a type that isn't allowed                |
| `500`  | Rules or the media index couldn't be saved                                                                                                        |
| `502`  | MyInstants couldn't be reached, or returned an error or a file that isn't an audio file (sound search, import), or TikTok's lookup failed (gifts) |
| `503`  | Uploads and imports are turned off because the server has no `--data-dir`                                                                         |

### Simulate body

The body is an event without `timestamp` or `msgId`. The server fills those in.

```json
{
  "type": "follow",
  "user": { "userId": "1", "uniqueId": "tester", "nickname": "Tester", "profilePictureUrl": "" }
}
```

Validation uses the same `LiveEvent` schema as real events, so every required field for that
type must be present.

## Event types

Every event has `type`, `timestamp` (unix ms, when TikTok created the message, or when
tiklive received it if TikTok didn't say), and usually `msgId` (TikTok's message ID, used for
de-duplication). `user` is a `LiveUser`:

```ts
{
  userId: string;
  uniqueId: string;          // the @handle, without the @
  nickname: string;
  profilePictureUrl: string;
  isModerator?: boolean;     // present when TikTok sends viewer relationship data
  isSubscriber?: boolean;
  isFollower?: boolean;
  isGifter?: boolean;
  followerCount?: number;    // the viewer's own counts, when TikTok includes them
  followingCount?: number;
  followStatus?: "none" | "follower" | "friend"; // the viewer's relationship to the streamer. friend = mutual follow
}
```

| `type`       | Fields (besides `type`, `timestamp`, `msgId?`)                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat`       | `user`, `comment: string`, `emotes: Emote[]`                                                                                                                                                                                            |
| `chatDelete` | `msgIds: string[]` (msgIds of earlier `chat` events that were deleted), `userIds: string[]` (authors of deleted messages, when TikTok sends them; often empty)                                                                          |
| `gift`       | `user`, `giftId`, `giftName`, `giftImageUrl`, `diamondCount` (coins per gift), `repeatCount` (count within the combo), `streaking: boolean`, `totalDiamonds` (`diamondCount × repeatCount`), `groupId`, `receiver?: {userId, nickname}` |
| `like`       | `user`, `likeCount`, `totalLikeCount`                                                                                                                                                                                                   |
| `follow`     | `user`                                                                                                                                                                                                                                  |
| `share`      | `user`                                                                                                                                                                                                                                  |
| `join`       | `user`                                                                                                                                                                                                                                  |
| `subscribe`  | `user`, `subMonth`                                                                                                                                                                                                                      |
| `question`   | `user`, `question: string`                                                                                                                                                                                                              |
| `emote`      | `user`, `emotes: Emote[]`                                                                                                                                                                                                               |
| `viewers`    | `viewerCount`, `topViewers: TopViewer[]` (`{user, coinCount, rank}`)                                                                                                                                                                    |
| `streamEnd`  | `reason: "ended" \| "suspended"`                                                                                                                                                                                                        |

`Emote` is `{ emoteId, imageUrl }`.

**Chat deletes.** `chatDelete` is sent when a moderator or the host deletes chat. Remove any chat
message whose `msgId` is in `msgIds`. `userIds` carries user IDs when TikTok includes them, and is
usually empty.

**Gift streaks.** Streakable gifts (Rose, and so on) send one event per repeat while the viewer
holds the combo. Each has `streaking: true` and a rising `repeatCount`. The last one has
`streaking: false`. Use that one for alerts and totals. `SessionStats.diamonds` already counts
only finished streaks.

## Session status

```ts
interface SessionStatus {
  username: string;
  state: "idle" | "waiting" | "connecting" | "live" | "error";
  roomId?: string;
  title?: string;
  owner?: { userId; uniqueId; nickname; profilePictureUrl; followerCount };
  liveSince?: number; // unix ms when the current connection started
  streamStartedAt?: number; // unix ms when TikTok says the stream started. Doesn't reset on reconnect
  coverUrl?: string; // stream cover image URL
  hlsUrl?: string; // HLS playlist for watching the stream. Signed by TikTok, valid for the current stream only
  error?: string; // set in the "error" state
  stats: SessionStats;
}
```

| `state`      | Meaning                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `idle`       | Not connected and not trying to                                                                                              |
| `waiting`    | The streamer is offline. The session checks again every 30 seconds (`pollInterval`)                                          |
| `connecting` | Looking up the room or opening the socket, or reconnecting after a drop                                                      |
| `live`       | Connected and receiving events                                                                                               |
| `error`      | Something failed. `error` has the message. A `UserNotFound` error stops the session. Other errors retry after `pollInterval` |

`SessionInfo` (from `GET /api/sessions`) is `SessionStatus` plus `watching: boolean` and
`subscribers: number`.

```ts
interface SessionStats {
  likes: number;
  diamonds: number; // coins from finished gift streaks
  follows: number;
  shares: number;
  joins: number;
  chats: number;
  viewers: number; // latest viewer count
  peakViewers: number;
}
```

Stats are running totals for the current stream. They reset when a connection is established
(see the caveat in [ARCHITECTURE.md](ARCHITECTURE.md#known-gaps)).

## Actions

An action rule says what to play when an event happens, for example "when someone sends `!dance`,
play a sound and show a GIF". The server checks every event against the rules. Each match becomes a
`FiredAction`, sent as an `action` message to subscriptions with `actions: true`. The player
(`/overlays/actions.html`) runs the steps. The server never plays anything itself.

The schemas are in [`packages/contracts/src/rules.ts`](../packages/contracts/src/rules.ts):

- **`Rule`**: `id`, `name`, `enabled`, `trigger`, `steps` (at most 10), and optional `cooldown` and
  `userCooldown` in seconds.
- **Triggers**: `gift`, `follow`, `share`, `subscribe`, `chat` (`command`, `contains` or `any`), `join`
  (a viewer joins; `oncePerStream` defaults to true), and `likes` (every N likes).
- **Audiences**: `from` on `chat` and `join` is `everyone` (the default), `followers` (includes friends),
  `friends` (mutual follows only), `subscribers` or `moderators`. `minFollowers` on `chat` and `join`
  sets the least follower count a viewer may have; followers and friends of the streamer always pass it,
  and so does a viewer whose count is unknown.
- **Steps**: `sound`, `media`, `speak` (text to speech), `obsScene` and `webhook`. Text can use placeholders
  such as `{nickname}`, `{comment}` and `{followers}` (the viewer's follower count).
- **`webhook` step**: `{kind: "webhook", url, method?, body?}`. `url` is an `http://` or `https://` URL that
  parses, at most 2048 characters. Placeholders are allowed in its path and query, and the values are
  percent-encoded. `method` is `POST` (the default), `PUT` or `GET`. `body` is at most 4000 characters, is
  sent as-is for `POST` and `PUT` (as `application/json` if it parses as JSON, else `text/plain`), and is
  ignored for `GET`. Without a `body`, `POST` and `PUT` send a JSON description of the action:
  `{rule: {id, name}, event, user: {userId, uniqueId, nickname} | null, vars, timestamp}`, where `event` is
  the event type (`like` for likes milestones) and `vars` holds every template variable. The server sends
  these requests, not the browser player, and the player skips the step.
- **`RuleSet`**: `{revision, rules}`, at most 200 rules. `revision` goes up on every save.
- **`FiredAction`**: `id`, `ruleId`, `ruleName`, `timestamp`, `user` (when there is one), `test`, and
  `steps` with the placeholders already filled in.
- **`MediaItem`**: `id`, `name`, `kind` (`image`, `video` or `audio`), `contentType`, `size`, `url`
  and `createdAt`.

A media step's `url` is either `/media/<file>` (a file uploaded to this server) or an `http(s)` URL.
Other schemes, such as `javascript:` and `data:`, are rejected. Uploads can be PNG, JPEG, GIF, WebP,
MP4, WebM, MP3, WAV, OGG or M4A, up to 25 MB. SVG isn't allowed.

Sound search reads myinstants.com on the user's behalf; nothing is sent there unless someone searches or imports.
`POST /api/media/import` copies a found sound into the media library, so rules keep working without the site.

Rules are stored in `rules.json` in the data directory (in memory when there isn't one). Save them
with `PUT /api/rules`, sending the `revision` you last read. A save based on an older revision gets
`409`.

```json
{
  "type": "action",
  "username": "someone",
  "action": {
    "id": "lq3x9-0",
    "ruleId": "dance",
    "ruleName": "Dance",
    "timestamp": 1791770120000,
    "user": { "userId": "1", "uniqueId": "tester", "nickname": "Tester", "profilePictureUrl": "" },
    "steps": [{ "kind": "speak", "text": "Tester dances" }]
  }
}
```

- `action` messages go only to subscriptions with `actions: true` (or `actions=1` in the URL).
- They are never replayed, and the `events` filter doesn't apply to them.

## Versioning

- `PROTOCOL_VERSION` is in `packages/contracts/src/protocol.ts`. It's sent in `hello`, and
  `/api/health` reports it too.
- A **breaking** change bumps the version. Breaking means removing or renaming a field or
  type, making an optional field required, or changing what a field means.
- **Additive** changes don't bump it. Examples: a new optional field, or a new event type.
  Clients must ignore unknown fields and event types. The browser client already does.
- Actions (the `action` message, the `actions` subscribe option, `actions=1`, and the `/api/rules`,
  `/api/media`, `/api/media/import`, `/api/sounds/search` and `/media/:file` routes) was an additive change, so `PROTOCOL_VERSION` stays at 1.
  So were `PATCH /api/media/:id`, the follow fields on `LiveUser`, and `SessionStatus.hlsUrl`, and the
  rule additions: the `join` trigger, the `friends` audience, `minFollowers` and `oncePerStream`, and the `{followers}` placeholder.
  The `webhook` step is another additive rule change, so `PROTOCOL_VERSION` stays at 1. Older players skip the
  step kind they don't know.
- The browser client (`packages/client`) checks `hello.protocolVersion` against its own
  constant and logs one warning on a mismatch. It doesn't refuse to connect.
- When the version changes, update `PROTOCOL_VERSION`, this document, and the client together.
