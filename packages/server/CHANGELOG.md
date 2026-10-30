# @tiklive/server

## 0.6.0

### Minor Changes

- [#21](https://github.com/talkaboutdesign/tiklive/pull/21) [`2258cef`](https://github.com/talkaboutdesign/tiklive/commit/2258cef2a730be7740a9328dfae37d0045a8b2d4) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Actions:
  
  - a `join` trigger, for when a viewer joins the stream, with once per viewer per stream (on by default)
  - a `friends` audience (mutual follows), and `followers` now includes friends
  - a minimum follower count on chat and join triggers, for keeping throwaway accounts out
  - a `{followers}` placeholder for the viewer's follower count
  - presets: one-click starting points for new actions in the editor
  
  When a session reconnects into a new room, the action rules are told the previous stream ended (TikTok doesn't always send `streamEnd`), so like milestones and once-per-stream joins start fresh.

- [#17](https://github.com/talkaboutdesign/tiklive/pull/17) [`7c6bb18`](https://github.com/talkaboutdesign/tiklive/commit/7c6bb18c3e2d926fa636307a09a779a1087c5c1b) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - The app has a new look:
  - a sidebar with your account and live status, navigation, the sound mini player and the update button
  - light and dark themes, following your system by default
  - a Settings page for your username, sound, theme and updates
  - an Overlays page with live previews, per-overlay options and test events
  
  The Actions player's OBS setup moved to the Overlays page. On macOS the desktop app uses an inset title bar.

- [#16](https://github.com/talkaboutdesign/tiklive/pull/16) [`c1306cd`](https://github.com/talkaboutdesign/tiklive/commit/c1306cdf6cb0128f26b710c94e9b3c2ae4b192f7) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Desktop app: choose Stable or Nightly updates in the new Settings dialog. Nightly builds come out for every merged change. The desktop app has a new icon.

- [#26](https://github.com/talkaboutdesign/tiklive/pull/26) [`5431d32`](https://github.com/talkaboutdesign/tiklive/commit/5431d3281f2e999912f1335459e3798aae33baf5) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - New `goal` event for LIVE goals (such as "GIFT GAL"), with progress per target and the top contributors. `LiveUser.gifterLevel` carries the viewer's gifter level, and the dashboard shows a goal card and "Lv" badges in chat. Demo mode emits goals and gifter levels. Both are additive, so `PROTOCOL_VERSION` stays at 1.

- [#19](https://github.com/talkaboutdesign/tiklive/pull/19) [`9906806`](https://github.com/talkaboutdesign/tiklive/commit/990680613716a9c38e0f047d91a2ee3e738e04c9) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - New Media page: browse, play, rename and delete your sounds, images and videos, upload by drag and drop, and record a new sound (up to 30 seconds) with a trim slider. `PATCH /api/media/:id` renames a file. The desktop app asks for microphone access when you record, and only allows the microphone and copying links for its own pages.

- [#38](https://github.com/talkaboutdesign/tiklive/pull/38) [`e4350bd`](https://github.com/talkaboutdesign/tiklive/commit/e4350bda70e3589bb7002fe51380f94459a5b52f) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - - The Media page's search also searches MyInstants (press Enter), and **Add** copies a sound into your library
  - Viewer names on the dashboard and the Viewers leaderboard, and your own name in the sidebar, open the TikTok profile
  - A MyInstants search with no results now says so, instead of "Couldn't reach MyInstants"

- [#23](https://github.com/talkaboutdesign/tiklive/pull/23) [`63194cb`](https://github.com/talkaboutdesign/tiklive/commit/63194cb4b6f8ce08d0c7ed6e84ebd8724d3889c7) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - OBS overlays for a subathon timer, a top supporters leaderboard and a spin wheel. Each is on the Overlays page with its own options and a URL builder.

- [#27](https://github.com/talkaboutdesign/tiklive/pull/27) [`03a236e`](https://github.com/talkaboutdesign/tiklive/commit/03a236e943a45c3922a3b75e6f89344140a457fc) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Actions: a `{points}` placeholder with the viewer's points (including what the triggering event just earned), and an "Answer !points" preset that says "{nickname}, you have {points} points!".

- [#32](https://github.com/talkaboutdesign/tiklive/pull/32) [`d083164`](https://github.com/talkaboutdesign/tiklive/commit/d08316477fea57ed092cd1df4e181b716522999a) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - The server now refuses to listen beyond localhost without `--token`. Pass `--allow-no-token` to keep the old behaviour.

- [#18](https://github.com/talkaboutdesign/tiklive/pull/18) [`485e74e`](https://github.com/talkaboutdesign/tiklive/commit/485e74e5b1b0f099d64b01f6290377a7bb3e82e3) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - The dashboard is now a live view: chat with filters for followers, friends, minimum follower count and hidden words, highlighted gifts and subscriptions, a gifts column with top gifters, a way to silence someone in your own view, and an optional video preview. The raw event log is gone. `LiveUser` gains `followerCount`, `followingCount` and `followStatus` (`none`, `follower` or `friend`), and `SessionStatus` gains `hlsUrl`.

- [#25](https://github.com/talkaboutdesign/tiklive/pull/25) [`808a9b3`](https://github.com/talkaboutdesign/tiklive/commit/808a9b39a5828f05032b66753c7f3ba9b904c045) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Viewer points: viewers earn points for chat, gifts, likes, follows, shares, subscriptions and joins, kept per streamer and saved to `<data-dir>/points/`. A new Viewers page shows the leaderboard, lets you search, adjust a viewer's points and change how many points each action is worth, and reset everyone. The dashboard shows points on chat rows, and the leaderboard overlay has `metric=points`. New REST routes: `GET`/`DELETE /api/sessions/:username/points`, `GET`/`PATCH /api/sessions/:username/points/:userId` and `PUT /api/sessions/:username/points/settings`. See `docs/user/points.md`.

- [#24](https://github.com/talkaboutdesign/tiklive/pull/24) [`c47aaaa`](https://github.com/talkaboutdesign/tiklive/commit/c47aaaa30e84b0ce78d9c36ef0b5775c1c4e7dc1) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Actions:
  
  - a `webhook` step, which sends an HTTP request (POST, PUT or GET) when the action runs. Use it to reach Streamer.bot, Minecraft plugins, Home Assistant, Zapier or other apps on your network. The server sends it, so LAN addresses work
  - without a body, POST and PUT send a JSON description of the action, with the viewer, the event and the template values
  - placeholders work in the webhook's address (percent-encoded) and body
  - the editor's Test button sends the webhook too

### Patch Changes

- [#39](https://github.com/talkaboutdesign/tiklive/pull/39) [`92766c6`](https://github.com/talkaboutdesign/tiklive/commit/92766c6565ed88b314f6d93082255af0c1adabec) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Keep temporary room lookup failures retryable and bound device cookie requests by the connection timeout.

- [#40](https://github.com/talkaboutdesign/tiklive/pull/40) [`ce13cae`](https://github.com/talkaboutdesign/tiklive/commit/ce13cae1dd6d2a686562e736935c2f10813a0df6) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Wait for server cleanup and pending viewer points to be saved before the desktop app quits.

- [#44](https://github.com/talkaboutdesign/tiklive/pull/44) [`512f1f3`](https://github.com/talkaboutdesign/tiklive/commit/512f1f38a7e22ee9e56169206ac2f273a969b7bb) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Skip viewer-points lookups and clock reads when the action rule list is empty, while preserving likes and stream resets.

- [#34](https://github.com/talkaboutdesign/tiklive/pull/34) [`5d37931`](https://github.com/talkaboutdesign/tiklive/commit/5d37931dc05c14584af8f0ec4c1dd70e4caae4a1) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Viewer points are saved without pausing live events, and the points files are written compactly, so busy streams stay smooth.

- [#42](https://github.com/talkaboutdesign/tiklive/pull/42) [`1ec55b7`](https://github.com/talkaboutdesign/tiklive/commit/1ec55b7fc500a449c7072417a2518601cc00a047) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Isolate points-store locking per streamer and avoid sorting every viewer for small leaderboard pages.

- [#46](https://github.com/talkaboutdesign/tiklive/pull/46) [`6945448`](https://github.com/talkaboutdesign/tiklive/commit/69454486e3e54515b7c74445e7d635091423f13b) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Fix slow desktop quit by closing app windows before server cleanup and limiting the desktop server grace period to one second, while preserving the final points save.

- [#29](https://github.com/talkaboutdesign/tiklive/pull/29) [`d2a1c1c`](https://github.com/talkaboutdesign/tiklive/commit/d2a1c1c2e7b09d08ab57def074e3c7f635afd7b3) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Overlays and the browser client no longer show the same chat lines and gifts again after reconnecting.

- [#41](https://github.com/talkaboutdesign/tiklive/pull/41) [`45a9ad9`](https://github.com/talkaboutdesign/tiklive/commit/45a9ad9ad21a13847d446036127e90cf76374fb8) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Prune unused rule cooldown state and reset per-stream rules when room identity changes across session lifetimes.

- [#45](https://github.com/talkaboutdesign/tiklive/pull/45) [`2ac22c7`](https://github.com/talkaboutdesign/tiklive/commit/2ac22c72d1f18f8ce4834e6145d39d7c737ffa73) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Share JSON encoding of live event, status and action publications across WebSocket subscribers.

- [#30](https://github.com/talkaboutdesign/tiklive/pull/30) [`e123911`](https://github.com/talkaboutdesign/tiklive/commit/e12391143d87c99c938682cdb61f3561b0b403c6) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Connections now notice a silent TikTok socket (no data for 60 seconds) and reconnect, instead of looking live with no events. Set with `idleTimeout`.

- [#37](https://github.com/talkaboutdesign/tiklive/pull/37) [`25d5215`](https://github.com/talkaboutdesign/tiklive/commit/25d5215797788dc822a71c52a45209db9914fb05) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Actions: picking a voice in "Say something" now previews it right away (with a sample line if the message is empty). The voice list hides macOS joke and robot voices (Bubbles, Zarvox, Fred, ...) and lists voices in your language first.

- [#28](https://github.com/talkaboutdesign/tiklive/pull/28) [`6f7425f`](https://github.com/talkaboutdesign/tiklive/commit/6f7425f6c03df7570e17d7db008f1dd0672f9bed) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Actions: placeholder values in a JSON webhook body are now escaped, so a viewer's nickname or comment can't add or change fields in the request.

- [#43](https://github.com/talkaboutdesign/tiklive/pull/43) [`3467074`](https://github.com/talkaboutdesign/tiklive/commit/34670747180ed7d7ab9ede9ec116546db3b60fb6) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Disconnect slow overlay sockets that exceed the platform outgoing buffer limit.

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
