---
"tiklive": minor
---

Actions:

- a `join` trigger, for when a viewer joins the stream, with once per viewer per stream (on by default)
- a `friends` audience (mutual follows), and `followers` now includes friends
- a minimum follower count on chat and join triggers, for keeping throwaway accounts out
- a `{followers}` placeholder for the viewer's follower count
- presets: one-click starting points for new actions in the editor

When a session reconnects into a new room, the action rules are told the previous stream ended (TikTok doesn't always send `streamEnd`), so like milestones and once-per-stream joins start fresh.
