# tiklive

Open-source TikTok LIVE connector and event server. It turns TikTok's LIVE WebSocket into typed JSON events
for stream overlays: chats, gifts, likes, follows, shares, joins, subs and viewer counts. No signing service,
no login, no headless browser.

## Install

```sh
npx tiklive                      # run the server; dashboard at http://127.0.0.1:8080/
npm install tiklive effect       # as a library (effect is a peer dependency)
```

Open http://127.0.0.1:8080/ and type `demo` as the username to get fake events. Options: `npx tiklive --help`.

## Import map

| Import               | What it is                                                  |
| -------------------- | ----------------------------------------------------------- |
| `tiklive`            | The server: `Server.layer`, `SessionManager`, `Session`     |
| `tiklive/node`       | The server on Node's HTTP server                            |
| `tiklive/bun`        | The server on Bun's HTTP server                             |
| `tiklive/core`       | The TikTok connector: `LiveConnection`, `TikTokWeb`, errors |
| `tiklive/client`     | The `TikLive` client, with no runtime dependencies          |
| `tiklive/contracts`  | Event and protocol schemas                                  |
| `tiklive/testing`    | Fakes for tests                                             |
| `tiklive/tiklive.js` | The browser client bundle, served at `/tiklive.js`          |

Before, these were `@tiklive/server` (now `tiklive`), `@tiklive/server/node` and `@tiklive/server/bun`
(now `tiklive/node` and `tiklive/bun`), `@tiklive/core` and `@tiklive/core/testing` (now `tiklive/core` and
`tiklive/testing`), `@tiklive/contracts` and `@tiklive/client` (now `tiklive/contracts` and `tiklive/client`).

## Documentation

- [README on GitHub](https://github.com/talkaboutdesign/tiklive#readme): overview, quick start, notes
- [Run the server](https://github.com/talkaboutdesign/tiklive/blob/main/docs/user/server.md): CLI options, tokens, security, embedding
- [Library](https://github.com/talkaboutdesign/tiklive/blob/main/docs/user/library.md): connector, client, contracts, testing, events
- [Overlays](https://github.com/talkaboutdesign/tiklive/blob/main/docs/user/overlays.md) and [desktop app](https://github.com/talkaboutdesign/tiklive/blob/main/docs/user/desktop.md)
- [Wire protocol](https://github.com/talkaboutdesign/tiklive/blob/main/docs/PROTOCOL.md)

Licensed under MIT.
