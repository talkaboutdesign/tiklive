---
"tiklive": minor
---

tiklive is now one npm package, `tiklive`, replacing `@tiklive/server`, `@tiklive/core`, `@tiklive/contracts` and `@tiklive/client`. Install `tiklive` and update imports:

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
