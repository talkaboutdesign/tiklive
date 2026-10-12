// Records raw webcast messages from a live stream as fixtures: bun scripts/record.ts <user> [seconds] [outDir]
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { LiveConnection } from "../src/index.ts";
const [user, secs = "60", out = "/tmp/tl-fixtures"] = process.argv.slice(2);
mkdirSync(`${out}/${user}`, { recursive: true });
const counts: Record<string, number> = {};
await Effect.runPromise(
  LiveConnection.connect(user!, { includeRaw: true }).pipe(
    Stream.tap((e) =>
      Effect.sync(() => {
        if (e._tag !== "Raw") return;
        const m = e.message.method;
        counts[m] = (counts[m] ?? 0) + 1;
        if (counts[m]! <= 5) writeFileSync(`${out}/${user}/${m}.${counts[m]}.bin`, e.message.payload);
      }),
    ),
    Stream.interruptWhen(Effect.sleep(`${secs} seconds`)),
    Stream.runDrain,
    Effect.provide(LiveConnection.layer()),
    Effect.catch((e) => Effect.sync(() => console.log("FAILED", e._tag, e.message))),
  ),
);
console.log(
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v}\t${k}`)
    .join("\n"),
);
