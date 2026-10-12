# Example overlays

A dashboard and three OBS overlays built on the `/tiklive.js` client. They are plain HTML
files with no build step, so you can copy one and start editing.

Run the server from the repo root with `bun run dev` (reloads while you work) or `bun run start`. Both serve
this folder at http://127.0.0.1:8080/. Build the client first with `bun run build` if `/tiklive.js` is missing.

- `index.html`: the dashboard, at `/`. It's the live view of your room: chat with filters, gifts, subscriptions, an optional video preview, and per-view silencing
- `overlays/chat.html`, `overlays/alerts.html`, `overlays/goal.html`: the OBS overlays
- `media.html`: the Media Library, at `/media.html`. Record a sound, upload images, videos and sounds, and rename or delete them. It shows which actions use each file

The URL parameters, the OBS setup, and how to write your own overlay are in
[docs/user/overlays.md](../../docs/user/overlays.md). The client API is in
[docs/user/library.md](../../docs/user/library.md).
