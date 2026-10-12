# @tiklive/contracts

## 0.2.0

### Minor Changes

- [#1](https://github.com/talkaboutdesign/tiklive/pull/1) [`8bf14a9`](https://github.com/talkaboutdesign/tiklive/commit/8bf14a9bad3def87a60527a6b796b06f08309559) Thanks [@talkaboutdesign](https://github.com/talkaboutdesign)! - Add the `chatDelete` event, sent when a moderator or the host deletes chat messages. The chat overlay removes deleted messages.
  
  `@tiklive/core` re-exports the `LiveEvent`, `LiveEventOf`, `LiveEventType` and `LiveUser` types. An embedded server's `hello.serverVersion` defaults to the package version instead of `"dev"`. README links work on npm.

## 0.1.0

### Minor Changes

- First public release: connect to TikTok LIVE without a signing service, a self-hosted event server for overlays and apps, and a typed overlay client.
