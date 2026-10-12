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
{ action: "subscribe", username: string, events?: LiveEventType[], replay?: boolean }

// Stop following a streamer.
{ action: "unsubscribe", username: string }
```

- `username` is normalized server-side: `@Name`, `name`, and `tiktok.com/@name` all work.
  Invalid names get an `invalid_username` error.
- `events` omitted: all event types. `[]`: status updates only, no events.
- `replay: true`: send recent events first (see [Replay](#replay)).
- One socket can follow several streamers. The limit is `maxSubscriptionsPerSocket`
  (default **20**). Re-subscribing to a streamer you already follow doesn't count again.

### Server to client

```ts
{ type: "hello", protocolVersion: number, serverVersion: string }
{ type: "event", username: string, event: LiveEvent, replay?: true }
{ type: "status", username: string, status: SessionStatus }
{ type: "error", code: ErrorCode, message: string }
```

- **`hello`** is sent once per connection, before anything else. Check `protocolVersion`
  against what your client expects.
- **`event`** carries one [event](#event-types). `replay` is present (and `true`) only for
  events replayed from history. Live events omit the key.
- **`status`** is sent right after each subscribe, on every state change, and at most once
  per second while the stats change. Subscribers get no status after unsubscribing.
- **`error`** is about the last client message. The connection stays open.

### Order on subscribe

1. `status` for the streamer (current state and stats)
2. `event` messages with `replay: true`, oldest first, if `replay` was requested
3. live `event` and `status` messages

`events` filters both replayed and live events. It never filters `status`.

### Replay

With `replay: true`, the server sends its last **50** events for that streamer (default
history size). Likes and viewer-count updates are never kept in history, because they're too
frequent to be useful when replayed.

### Shortcut URL

Overlays can subscribe without sending a message:

```
ws://localhost:8080/ws?username=someone&events=chat,gift&replay=1
```

- `username`: subscribes right after `hello`.
- `events`: comma-separated. Unknown names are dropped silently. If none are valid, you get
  status updates only.
- `replay=1`: same as `replay: true`. Any other value means off.

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

All routes except `/api/health` go through the Host, Origin and token checks above.
Responses are JSON. Errors look like `{"error": "message"}`.

| Method and path                         | Success                                | Notes                                                                                            |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /api/health`                       | `200 {ok: true, protocolVersion}`      | No auth, no Host or Origin check                                                                 |
| `GET /api/sessions`                     | `200 {sessions: SessionInfo[]}`        | Only sessions that are running                                                                   |
| `GET /api/sessions/:username`           | `200 SessionStatus`                    | `404` if no session is running for that streamer                                                 |
| `PUT` or `POST /api/sessions/:username` | `200 SessionStatus & {watching: true}` | Keeps the session running until `DELETE`. Same as `--watch`                                      |
| `DELETE /api/sessions/:username`        | `200 {ok: true}`                       | Stops watching. The session still closes after its subscribers leave and the idle timeout passes |
| `POST /api/sessions/:username/simulate` | `200 {ok: true, event}`                | Injects an event as if TikTok sent it. Needs a running session                                   |
| `GET /api/gifts`                        | `200 {gifts: GiftInfo[]}`              | TikTok's gift catalog, sorted by price. Cached for an hour. `502` if TikTok's lookup fails       |

Status codes used across these routes:

| Status | Meaning                                                           |
| ------ | ----------------------------------------------------------------- |
| `400`  | Invalid username, invalid JSON, or an event that fails validation |
| `401`  | Missing or wrong token                                            |
| `403`  | Host or Origin not allowed                                        |
| `404`  | No such session (or unknown path under `/api`)                    |
| `405`  | Method not supported on `/api/sessions/:username`                 |
| `413`  | Simulate body over 64 KB                                          |
| `415`  | Simulate without `Content-Type: application/json`                 |

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

## Versioning

- `PROTOCOL_VERSION` is in `packages/contracts/src/protocol.ts`. It's sent in `hello`, and
  `/api/health` reports it too.
- A **breaking** change bumps the version. Breaking means removing or renaming a field or
  type, making an optional field required, or changing what a field means.
- **Additive** changes don't bump it. Examples: a new optional field, or a new event type.
  Clients must ignore unknown fields and event types. The browser client already does.
- The browser client (`packages/client`) checks `hello.protocolVersion` against its own
  constant and logs one warning on a mismatch. It doesn't refuse to connect.
- When the version changes, update `PROTOCOL_VERSION`, this document, and the client together.
