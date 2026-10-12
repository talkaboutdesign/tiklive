import { describe, expect, it } from "@effect/vitest";
import { LIVE_EVENT_TYPES, LiveEvent } from "@tiklive/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { demoEvents } from "./demo.ts";

describe("demoEvents", () => {
  it.effect("emits valid live events endlessly", () =>
    Effect.gen(function* () {
      const fiber = yield* demoEvents.pipe(Stream.take(50), Stream.runCollect, Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const events = yield* Fiber.join(fiber);

      expect(events).toHaveLength(50);
      const decode = Schema.decodeUnknownSync(LiveEvent);
      for (const event of events) {
        expect(LIVE_EVENT_TYPES).toContain(event.type);
        expect(() => decode(event)).not.toThrow();
      }
    }),
  );
});
