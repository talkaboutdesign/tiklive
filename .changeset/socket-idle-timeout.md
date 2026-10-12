---
"tiklive": patch
---

Connections now notice a silent TikTok socket (no data for 60 seconds) and reconnect, instead of looking live with no events. Set with `idleTimeout`.
