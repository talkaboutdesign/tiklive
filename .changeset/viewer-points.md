---
"tiklive": minor
---

Viewer points: viewers earn points for chat, gifts, likes, follows, shares, subscriptions and joins, kept per streamer and saved to `<data-dir>/points/`. A new Viewers page shows the leaderboard, lets you search, adjust a viewer's points and change how many points each action is worth, and reset everyone. The dashboard shows points on chat rows, and the leaderboard overlay has `metric=points`. New REST routes: `GET`/`DELETE /api/sessions/:username/points`, `GET`/`PATCH /api/sessions/:username/points/:userId` and `PUT /api/sessions/:username/points/settings`. See `docs/user/points.md`.
