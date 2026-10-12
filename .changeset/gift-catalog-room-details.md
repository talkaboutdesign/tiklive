---
"@tiklive/contracts": minor
"@tiklive/core": minor
"@tiklive/server": minor
"@tiklive/client": minor
---

Add the gift catalog and more room details. `GET /api/gifts` (and `TikLive#gifts()` in the client) returns TikTok's gift list, sorted by price and cached for an hour. `SessionStatus` gains `streamStartedAt` (TikTok's stream start time, which survives reconnects) and `coverUrl`.
