# @tiklive/server

## 0.5.0

### Minor Changes

- [#14](https://github.com/talkaboutdesign/tiklive/pull/14) [`f8b47a7`](https://github.com/talkaboutdesign/tiklive/commit/f8b47a7cf02d055b4215de7c154dbee90f2fe13c) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Add Actions: rules that turn LIVE events into sounds, images, GIFs, videos, text-to-speech and OBS scene switches. Set them up on the new Actions page (`/actions.html`), and add the actions player (`/overlays/actions.html`) to OBS. Triggers are gifts (any or a specific one, with a minimum coin value), follows, shares, subscriptions, chat commands or keywords, and like milestones, with optional cooldowns. Rules and uploaded files are stored in the data directory: `~/.tiklive` by default, or `--data-dir <dir>`. The desktop app uses its app data folder.
  
  Sound steps can search MyInstants from the editor. Picking a result copies the sound into your media library, so it keeps working offline and OBS never loads it from MyInstants.
  
  The desktop app now plays action sounds and text-to-speech itself, with no click needed to allow audio. The dashboard and Actions page headers have controls to turn app sound on or off, set the volume, and skip or clear queued actions. In the desktop app, the OBS player link on the Actions page shows only images, videos and scene switches, so nothing plays twice. Links to tiklive's own pages now open in app windows.
  
  The WebSocket protocol gains an `actions` subscribe option and an `action` message. The browser client gains the matching `actions` option and `"action"` event. Both are additive, so `PROTOCOL_VERSION` stays 1.
  
  The dashboard was also redesigned. It asks for your TikTok username once and remembers it, and you can change it from the header.

## 0.4.0

### Minor Changes

- [#10](https://github.com/talkaboutdesign/tiklive/pull/10) [`2f4a16c`](https://github.com/talkaboutdesign/tiklive/commit/2f4a16c30804da23c813b4487242dd89f1e3b6f1) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - tiklive is now one npm package, `tiklive`, replacing `@tiklive/server`, `@tiklive/core`, `@tiklive/contracts` and `@tiklive/client`. Install `tiklive` and update imports:
  
  | Before                       | After                |
  | ---------------------------- | -------------------- |
  | `@tiklive/server`            | `tiklive`            |
  | `@tiklive/server/node`       | `tiklive/node`       |
  | `@tiklive/server/bun`        | `tiklive/bun`        |
  | `@tiklive/core`              | `tiklive/core`       |
  | `@tiklive/core/testing`      | `tiklive/testing`    |
  | `@tiklive/contracts`         | `tiklive/contracts`  |
  | `@tiklive/client`            | `tiklive/client`     |
  | `@tiklive/client/tiklive.js` | `tiklive/tiklive.js` |
  
  The `tiklive` command and the server's HTTP and WebSocket API are unchanged.

### Patch Changes

- [#8](https://github.com/talkaboutdesign/tiklive/pull/8) [`610baa2`](https://github.com/talkaboutdesign/tiklive/commit/610baa2dcf4d545f48147e205826f97f0318b389) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - The dashboard event log and the chat overlay now show gift images. The demo stream uses TikTok's real gift art instead of placeholder icons, and its Galaxy gift has the correct gift ID (11046).

## 0.3.0

### Minor Changes

- [#5](https://github.com/talkaboutdesign/tiklive/pull/5) [`7a50c10`](https://github.com/talkaboutdesign/tiklive/commit/7a50c1080261d6a135317ff8b69f0c6c751dc87e) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - `npx @tiklive/server` now serves the dashboard and example overlays at http://localhost:8080 unless you pass `--static <dir>`.

- [#4](https://github.com/talkaboutdesign/tiklive/pull/4) [`e1d8ebd`](https://github.com/talkaboutdesign/tiklive/commit/e1d8ebde214f50961a4b7522972269f2a600e73c) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Add the gift catalog and more room details. `GET /api/gifts` (and `TikLive#gifts()` in the client) returns TikTok's gift list, sorted by price and cached for an hour. `SessionStatus` gains `streamStartedAt` (TikTok's stream start time, which survives reconnects) and `coverUrl`.

### Patch Changes

- Updated dependencies [[`e1d8ebd`](https://github.com/talkaboutdesign/tiklive/commit/e1d8ebde214f50961a4b7522972269f2a600e73c)]:
  - @tiklive/contracts@0.3.0
  - @tiklive/core@0.3.0
  - @tiklive/client@0.3.0

## 0.2.0

### Minor Changes

- [#1](https://github.com/talkaboutdesign/tiklive/pull/1) [`8bf14a9`](https://github.com/talkaboutdesign/tiklive/commit/8bf14a9bad3def87a60527a6b796b06f08309559) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Add the `chatDelete` event, sent when a moderator or the host deletes chat messages. The chat overlay removes deleted messages.
  
  `@tiklive/core` re-exports the `LiveEvent`, `LiveEventOf`, `LiveEventType` and `LiveUser` types. An embedded server's `hello.serverVersion` defaults to the package version instead of `"dev"`. README links work on npm.

### Patch Changes

- Updated dependencies [[`8bf14a9`](https://github.com/talkaboutdesign/tiklive/commit/8bf14a9bad3def87a60527a6b796b06f08309559)]:
  - @tiklive/contracts@0.2.0
  - @tiklive/core@0.2.0
  - @tiklive/client@0.2.0

## 0.1.0

### Minor Changes

- First public release: connect to TikTok LIVE without a signing service, a self-hosted event server for overlays and apps, and a typed overlay client.

### Patch Changes

- Updated dependencies []:
  - @tiklive/contracts@0.1.0
  - @tiklive/core@0.1.0
  - @tiklive/client@0.1.0
