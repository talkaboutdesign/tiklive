/**
 * RulesStore: revisions and conflicts, both backends, and file handling
 * (persistence, a corrupt file, a failed write).
 */
import { describe, expect, it } from "@effect/vitest";
import type { Rule } from "@tiklive/contracts";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerFile, layerMemory, RevisionConflict, RulesStore, RulesWriteError } from "./RulesStore.ts";

const rule = (id: string): Rule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  trigger: { type: "follow" },
  steps: [{ kind: "speak", text: "hi" }],
});

/** A fresh directory, removed when the scope closes. */
const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "tiklive-rules-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

/** Builds a file-backed store in `dir` (after any fixture files are written) and runs `body` with it. */
const withFileStore = <A, E>(dir: string, body: (store: RulesStore["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const store = yield* RulesStore;
    return yield* body(store);
  }).pipe(Effect.provide(layerFile(dir)));

describe("RulesStore in memory", () => {
  it.effect("starts empty at revision 0 and bumps the revision on each save", () =>
    Effect.gen(function* () {
      const store = yield* RulesStore;
      expect(yield* store.get).toEqual({ revision: 0, rules: [] });

      const saved = yield* store.replace(0, [rule("a")]);
      expect(saved).toEqual({ revision: 1, rules: [rule("a")] });
      expect(yield* store.get).toEqual(saved);

      expect((yield* store.replace(1, [rule("b")])).revision).toBe(2);
    }).pipe(Effect.provide(layerMemory())),
  );

  it.effect("rejects a save based on an old revision and keeps the current rules", () =>
    Effect.gen(function* () {
      const store = yield* RulesStore;
      yield* store.replace(0, [rule("a")]);
      const error = yield* Effect.flip(store.replace(0, [rule("b")]));
      expect(error).toBeInstanceOf(RevisionConflict);
      expect(error).toMatchObject({ expected: 0, current: 1 });
      expect((yield* store.get).rules).toEqual([rule("a")]);
    }).pipe(Effect.provide(layerMemory())),
  );

  it.effect("starts from the initial rules when given some", () =>
    Effect.gen(function* () {
      const store = yield* RulesStore;
      expect(yield* store.get).toEqual({ revision: 3, rules: [rule("seed")] });
    }).pipe(Effect.provide(layerMemory({ revision: 3, rules: [rule("seed")] }))),
  );
});

describe("RulesStore in a file", () => {
  it.effect("starts empty when there is no file, and writes rules.json on save", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const saved = yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            expect(yield* store.get).toEqual({ revision: 0, rules: [] });
            return yield* store.replace(0, [rule("a")]);
          }),
        );
        expect(saved.revision).toBe(1);

        const onDisk = JSON.parse(yield* Effect.promise(() => readFile(join(dir, "rules.json"), "utf8")));
        expect(onDisk).toEqual({ revision: 1, rules: [rule("a")] });
      }),
    ),
  );

  it.effect("creates the data directory when saving", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* tempDir;
        const dir = join(root, "nested", "data");
        const saved = yield* withFileStore(dir, (store) => store.replace(0, [rule("a")]));
        expect(saved.revision).toBe(1);
        expect(yield* Effect.promise(() => readdir(dir))).toContain("rules.json");
      }),
    ),
  );

  it.effect("keeps rules and revision across a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) => store.replace(0, [rule("a")]));

        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            expect(yield* store.get).toEqual({ revision: 1, rules: [rule("a")] });
            // The revision carries over, so an editor that loaded before the restart still conflicts correctly.
            expect((yield* store.replace(1, [rule("b")])).revision).toBe(2);
          }),
        );
      }),
    ),
  );

  it.effect("moves an unparseable file aside and starts empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* Effect.promise(() => writeFile(join(dir, "rules.json"), "{ not json"));

        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            expect(yield* store.get).toEqual({ revision: 0, rules: [] });
          }),
        );

        const files = yield* Effect.promise(() => readdir(dir));
        expect(files.some((name) => /^rules\.json\.broken-\d+$/.test(name))).toBe(true);
        expect(files).not.toContain("rules.json");
      }),
    ),
  );

  it.effect("moves a file with the wrong shape aside and starts empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* Effect.promise(() =>
          writeFile(join(dir, "rules.json"), JSON.stringify({ revision: -1, rules: "nope" })),
        );

        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            expect(yield* store.get).toEqual({ revision: 0, rules: [] });
          }),
        );

        const files = yield* Effect.promise(() => readdir(dir));
        expect(files.some((name) => name.startsWith("rules.json.broken-"))).toBe(true);
      }),
    ),
  );

  it.effect("keeps the old rules when the write fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            yield* store.replace(0, [rule("a")]);

            // A directory where the temp file should go makes the write fail.
            yield* Effect.promise(() => mkdir(join(dir, "rules.json.tmp")));
            const error = yield* Effect.flip(store.replace(1, [rule("b")]));
            expect(error).toBeInstanceOf(RulesWriteError);
            expect(yield* store.get).toEqual({ revision: 1, rules: [rule("a")] });

            // Once the obstacle is gone the same save goes through.
            yield* Effect.promise(() => rm(join(dir, "rules.json.tmp"), { recursive: true }));
            expect((yield* store.replace(1, [rule("b")])).revision).toBe(2);
          }),
        );
      }),
    ),
  );
});
