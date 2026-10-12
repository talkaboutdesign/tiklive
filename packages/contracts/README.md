# @tiklive/contracts

Event and wire-protocol schemas shared by every tiklive package. Each schema is an
[Effect `Schema`](https://effect.website), so it doubles as a runtime validator and as the source of
the TypeScript types.

- **Events:** `LiveEvent` and one schema per event type (`ChatEvent`, `GiftEvent`, ...). `LIVE_EVENT_TYPES` lists the type names.
- **Protocol:** `ClientMessage` (subscribe, unsubscribe), `ServerMessage` (hello, event, status, error), `SessionStatus`,
  `SessionStats`, and `PROTOCOL_VERSION`.
- **Helpers:** `normalizeUsername("@SomeOne")` returns `"someone"`. `Username` is the validated handle schema.

```ts
import { LiveEvent, normalizeUsername } from "@tiklive/contracts";
import * as Schema from "effect/Schema";

normalizeUsername("https://www.tiktok.com/@SomeOne/live"); // "someone"

const isEvent = Schema.is(LiveEvent);
isEvent({ type: "follow", timestamp: Date.now(), user: {/* ... */} });
```

This package has no runtime logic beyond the schemas and the normalizer. Field-by-field reference:
[docs/PROTOCOL.md](../../docs/PROTOCOL.md). Source: [`src/events.ts`](src/events.ts) and [`src/protocol.ts`](src/protocol.ts).
