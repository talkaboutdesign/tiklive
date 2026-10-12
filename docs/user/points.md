# Viewer points

Viewer points are a loyalty score. Viewers earn points for chatting, gifting, liking, following, sharing,
subscribing and joining. The score is kept per streamer, so it carries over from one stream to the next.
Use it to reward regulars, run a leaderboard on stream, or pick a winner.

Points are on by default. You don't need to set anything up. Open the **Viewers** page (`/viewers.html`) to
see the leaderboard and change how many points each action is worth.

## How viewers earn points

Every number below is a setting you can change on the Viewers page. Defaults are in brackets.

| Action            | Points                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Chat message      | Per message [1]. A viewer earns chat points at most once per cooldown [60 seconds].         |
| Coins from a gift | Per coin [10]. A gift combo counts once, when it ends, with its total coins.                |
| Likes             | One point per [20] likes. Likes add up across batches, so 20 likes are one point.           |
| Follow            | Per follow [50].                                                                            |
| Share             | Per share [20].                                                                             |
| Subscribe         | Per subscription [200].                                                                     |
| Join              | Per join [0]. Joins are listed on the leaderboard, but don't earn points unless you say so. |

Notes:

- Only whole numbers are allowed. A setting can't be negative.
- The chat cooldown is per viewer. With a cooldown of 0, every chat message earns the chat points.
- Chat messages are counted even when they don't earn points, so the **Messages** column is the viewer's total.
- Questions, emotes and viewer counts don't earn points.
- A viewer whose user id TikTok doesn't send is skipped.
- Points start counting when the server sees the event. Events that happen while tiklive isn't connected
  aren't counted, the same as the rest of the overlays.

Changing a setting applies to points earned from then on. It doesn't change points already earned.

## The Viewers page

The page lists viewers from highest to lowest points. Each row shows the rank, name and @handle, points,
coins, chat messages and when the viewer was last seen. The list refreshes every 10 seconds while the page is open.

- **Search** matches a name or @handle, ignoring case. Ranks then count among the matching viewers.
- **Load more** shows the next 50 viewers.
- **Adjust**: type an amount and press **+** to add points or **−** to take them away. A viewer's points never go below 0.
- **How viewers earn points**: the settings above. Press **Save settings**.
- **Reset all points**: sets every viewer back to 0. Settings stay. This can't be undone, and asks you to confirm first.

## Show points on the dashboard and in OBS

- **Dashboard**: a chat row shows the viewer's points, such as "· 1.2K pts", when they are in the top 200 of the leaderboard.
  The dashboard reloads the leaderboard every 15 seconds.
- **Leaderboard overlay**: set `metric=points` to rank viewers by points. The overlay reads the leaderboard every 5 seconds.

```text
http://127.0.0.1:8080/overlays/leaderboard.html?username=yourname&metric=points&limit=5
```

Add `&token=…` if the server runs with `--token`. See [overlays](./overlays.md#leaderboard-overlaysleaderboardhtml) for every option.

## Where points are kept

With `--data-dir`, each streamer's points are in `<data-dir>/points/<streamer>.json`. While a stream is busy,
the server writes them about every 5 seconds, not after every event, and it writes them again when it stops.
Changes you make on the Viewers page (settings, adjustments and resets) are written at once.

Without a data directory, points are kept in memory and are lost when the server stops.

If a points file can't be read, it's moved aside as `<streamer>.json.broken-<time>` and that streamer starts
with no points. The other streamers aren't affected.

## Use points from the API

The routes are in [the wire protocol](../PROTOCOL.md#rest-api). For example:

```sh
curl "http://127.0.0.1:8080/api/sessions/yourname/points?limit=10"
curl -X PATCH -H "content-type: application/json" -d '{"delta": 100}' \
  "http://127.0.0.1:8080/api/sessions/yourname/points/123456789"
```

Points don't need a running session. Any streamer name works, and a name with no points returns an empty leaderboard.
