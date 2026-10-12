---
"tiklive": minor
---

Add Actions: rules that turn LIVE events into sounds, images, GIFs, videos, text-to-speech and OBS scene switches. Set them up on the new Actions page (`/actions.html`), and add the actions player (`/overlays/actions.html`) to OBS. Triggers are gifts (any or a specific one, with a minimum coin value), follows, shares, subscriptions, chat commands or keywords, and like milestones, with optional cooldowns. Rules and uploaded files are stored in the data directory: `~/.tiklive` by default, or `--data-dir <dir>`. The desktop app uses its app data folder.

Sound steps can search MyInstants from the editor. Picking a result copies the sound into your media library, so it keeps working offline and OBS never loads it from MyInstants.

The desktop app now plays action sounds and text-to-speech itself, with no click needed to allow audio. The dashboard and Actions page headers have controls to turn app sound on or off, set the volume, and skip or clear queued actions. In the desktop app, the OBS player link on the Actions page shows only images, videos and scene switches, so nothing plays twice. Links to tiklive's own pages now open in app windows.

The WebSocket protocol gains an `actions` subscribe option and an `action` message. The browser client gains the matching `actions` option and `"action"` event. Both are additive, so `PROTOCOL_VERSION` stays 1.

The dashboard was also redesigned. It asks for your TikTok username once and remembers it, and you can change it from the header.
