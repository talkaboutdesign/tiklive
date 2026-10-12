# @tiklive/core

## 0.3.0

### Minor Changes

- [#4](https://github.com/talkaboutdesign/tiklive/pull/4) [`e1d8ebd`](https://github.com/talkaboutdesign/tiklive/commit/e1d8ebde214f50961a4b7522972269f2a600e73c) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Add the gift catalog and more room details. `GET /api/gifts` (and `TikLive#gifts()` in the client) returns TikTok's gift list, sorted by price and cached for an hour. `SessionStatus` gains `streamStartedAt` (TikTok's stream start time, which survives reconnects) and `coverUrl`.

### Patch Changes

- Updated dependencies [[`e1d8ebd`](https://github.com/talkaboutdesign/tiklive/commit/e1d8ebde214f50961a4b7522972269f2a600e73c)]:
  - @tiklive/contracts@0.3.0

## 0.2.0

### Minor Changes

- [#1](https://github.com/talkaboutdesign/tiklive/pull/1) [`8bf14a9`](https://github.com/talkaboutdesign/tiklive/commit/8bf14a9bad3def87a60527a6b796b06f08309559) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Add the `chatDelete` event, sent when a moderator or the host deletes chat messages. The chat overlay removes deleted messages.
  
  `@tiklive/core` re-exports the `LiveEvent`, `LiveEventOf`, `LiveEventType` and `LiveUser` types. An embedded server's `hello.serverVersion` defaults to the package version instead of `"dev"`. README links work on npm.

### Patch Changes

- Updated dependencies [[`8bf14a9`](https://github.com/talkaboutdesign/tiklive/commit/8bf14a9bad3def87a60527a6b796b06f08309559)]:
  - @tiklive/contracts@0.2.0

## 0.1.0

### Minor Changes

- First public release: connect to TikTok LIVE without a signing service, a self-hosted event server for overlays and apps, and a typed overlay client.

### Patch Changes

- Updated dependencies []:
  - @tiklive/contracts@0.1.0
