---
"tiklive": minor
---

Actions:

- a `webhook` step, which sends an HTTP request (POST, PUT or GET) when the action runs. Use it to reach Streamer.bot, Minecraft plugins, Home Assistant, Zapier or other apps on your network. The server sends it, so LAN addresses work
- without a body, POST and PUT send a JSON description of the action, with the viewer, the event and the template values
- placeholders work in the webhook's address (percent-encoded) and body
- the editor's Test button sends the webhook too
