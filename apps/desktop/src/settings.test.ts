import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopSettings, layerFile } from "./settings.ts";

const withTempDir = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "tiklive-settings-"))),
    f,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

const channelFrom = (path: string) =>
  DesktopSettings.use((settings) => settings.updateChannel).pipe(
    Effect.provide(layerFile({ path, defaultChannel: "latest" })),
  );

describe("DesktopSettings", () => {
  it.live("uses the default until a channel is saved, then remembers it", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "nested", "desktop-settings.json");
        expect(yield* channelFrom(path)).toBe("latest");

        yield* DesktopSettings.use((settings) => settings.setUpdateChannel("nightly")).pipe(
          Effect.provide(layerFile({ path, defaultChannel: "latest" })),
        );
        expect(JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))).toEqual({
          updateChannel: "nightly",
        });
        expect(yield* channelFrom(path)).toBe("nightly");
      }),
    ),
  );

  it.live("ignores a file it can't read", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "desktop-settings.json");
        yield* Effect.promise(() => writeFile(path, "{ not json"));
        expect(yield* channelFrom(path)).toBe("latest");

        yield* Effect.promise(() => writeFile(path, JSON.stringify({ updateChannel: "beta" })));
        expect(yield* channelFrom(path)).toBe("latest");
      }),
    ),
  );
});
