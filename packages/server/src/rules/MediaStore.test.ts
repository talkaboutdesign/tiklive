/**
 * MediaStore: uploads on disk, type and size checks, persistence, and the path
 * lookups behind `/media/<file>`.
 */
import { describe, expect, it } from "@effect/vitest";
import { MAX_MEDIA_BYTES } from "@tiklive/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerDisabled, layerFile, MediaError, MediaStore } from "./MediaStore.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A fresh directory, removed when the scope closes. */
const tempDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "tiklive-media-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

/** Builds a file-backed store in `dir` (after any fixture files are written) and runs `body` with it. */
const withFileStore = <A, E>(dir: string, body: (store: MediaStore["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const store = yield* MediaStore;
    return yield* body(store);
  }).pipe(Effect.provide(layerFile(dir)));

const fileExists = (path: string) =>
  Effect.promise(() =>
    access(path).then(
      () => true,
      () => false,
    ),
  );

describe("MediaStore on disk", () => {
  it.effect("stores a file, lists it, serves it and removes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            const item = yield* store.add("Ding.png", "image/png", PNG);
            expect(item).toMatchObject({
              name: "Ding.png",
              kind: "image",
              contentType: "image/png",
              size: PNG.length,
            });
            expect(item.id).toMatch(/^[0-9a-f]{16}$/);
            expect(item.url).toBe(`/media/${item.id}.png`);

            expect(yield* store.list).toEqual([item]);

            const file = `${item.id}.png`;
            const resolved = yield* store.resolve(file);
            expect(Option.getOrUndefined(resolved)).toEqual({
              path: join(dir, "media", file),
              contentType: "image/png",
            });
            expect(yield* fileExists(join(dir, "media", file))).toBe(true);

            expect(yield* store.remove(item.id)).toBe(true);
            expect(yield* store.list).toEqual([]);
            expect(yield* fileExists(join(dir, "media", file))).toBe(false);
            expect(Option.isNone(yield* store.resolve(file))).toBe(true);
          }),
        );
      }),
    ),
  );

  it.effect("lists newest first", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            const first = yield* store.add("first.png", "image/png", PNG);
            const second = yield* store.add("second.gif", "image/gif", PNG);
            expect((yield* store.list).map((item) => item.id)).toEqual([second.id, first.id]);
          }),
        );
      }),
    ),
  );

  it.effect("maps video and audio types to their kinds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            const video = yield* store.add("clip.mp4", "video/mp4", PNG);
            const sound = yield* store.add("boom.mp3", "audio/mpeg", PNG);
            expect([video.kind, sound.kind]).toEqual(["video", "audio"]);
            expect(video.url.endsWith(".mp4")).toBe(true);
            expect(sound.url.endsWith(".mp3")).toBe(true);
          }),
        );
      }),
    ),
  );

  it.effect("ignores content type parameters and case", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            const item = yield* store.add("a.png", "IMAGE/PNG; charset=binary", PNG);
            expect(item.contentType).toBe("image/png");
          }),
        );
      }),
    ),
  );

  it.effect("cleans control characters and long names from the display name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            expect((yield* store.add("  bad\u0007name  ", "image/png", PNG)).name).toBe("badname");
            expect((yield* store.add("x".repeat(500), "image/png", PNG)).name).toHaveLength(200);
            expect((yield* store.add("\u0001", "image/png", PNG)).name).toBe("file");
          }),
        );
      }),
    ),
  );

  it.effect("rejects types it doesn't accept, including SVG", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            for (const type of ["image/svg+xml", "text/html", "application/octet-stream", "toString"]) {
              const error = yield* Effect.flip(store.add("x", type, PNG));
              expect(error).toBeInstanceOf(MediaError);
              expect(error).toMatchObject({ reason: "unsupported" });
            }
            const svg = yield* Effect.flip(store.add("x", "image/svg+xml", PNG));
            expect(svg.message).toBe(
              "Unsupported file type image/svg+xml. Use PNG, JPG, GIF, WebP, MP4, WebM, MP3, WAV, OGG or M4A.",
            );
            expect(yield* store.list).toEqual([]);
          }),
        );
      }),
    ),
  );

  it.effect("rejects an empty file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(store.add("x", "image/png", new Uint8Array(0)));
            expect(error).toMatchObject({ reason: "unsupported", message: "Empty file." });
          }),
        );
      }),
    ),
  );

  it.effect("rejects a file over 25 MB", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            // One allocation at the limit + 1; that is the smallest file that must be refused.
            const tooBig = new Uint8Array(MAX_MEDIA_BYTES + 1);
            const error = yield* Effect.flip(store.add("big.mp4", "video/mp4", tooBig));
            expect(error).toMatchObject({ reason: "tooLarge", message: "File is over 25 MB." });
            expect(yield* store.list).toEqual([]);
          }),
        );
      }),
    ),
  );

  it.effect("keeps uploads and the index across a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const id = yield* withFileStore(dir, (store) =>
          store.add("Ding.png", "image/png", PNG).pipe(Effect.map((item) => item.id)),
        );
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            expect((yield* store.list).map((item) => item.id)).toEqual([id]);
            expect(Option.isSome(yield* store.resolve(`${id}.png`))).toBe(true);
          }),
        );
      }),
    ),
  );

  it.effect("resolves only names in the index, never paths", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            yield* store.add("Ding.png", "image/png", PNG);
            expect(Option.isNone(yield* store.resolve("unknown.png"))).toBe(true);
            expect(Option.isNone(yield* store.resolve("../index.json"))).toBe(true);
            expect(Option.isNone(yield* store.resolve("../../etc/passwd"))).toBe(true);
          }),
        );
      }),
    ),
  );

  it.effect("returns false for an unknown id and deletes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            const item = yield* store.add("Ding.png", "image/png", PNG);
            expect(yield* store.remove("0123456789abcdef")).toBe(false);
            expect(yield* store.list).toEqual([item]);
          }),
        );
      }),
    ),
  );

  it.effect("starts empty and keeps the files when the index is corrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const media = join(dir, "media");
        yield* Effect.promise(() => mkdir(media, { recursive: true }));
        yield* Effect.promise(() => writeFile(join(media, "keep.png"), PNG));
        yield* Effect.promise(() => writeFile(join(media, "index.json"), "not json"));

        yield* withFileStore(dir, (store) =>
          Effect.gen(function* () {
            expect(yield* store.list).toEqual([]);
          }),
        );

        expect(yield* fileExists(join(media, "keep.png"))).toBe(true);
        const files = yield* Effect.promise(() => readdir(media));
        expect(files.some((name) => /^index\.json\.broken-\d+$/.test(name))).toBe(true);
      }),
    ),
  );
});

describe("MediaStore when uploads are disabled", () => {
  it.effect("refuses uploads with a hint about --data-dir", () =>
    Effect.gen(function* () {
      const store = yield* MediaStore;
      const error = yield* Effect.flip(store.add("x", "image/png", PNG));
      expect(error).toMatchObject({
        reason: "disabled",
        message: "Uploads need a data directory. Start tiklive with --data-dir <dir>.",
      });
      expect(yield* store.list).toEqual([]);
      expect(yield* store.remove("anything")).toBe(false);
      expect(Option.isNone(yield* store.resolve("anything.png"))).toBe(true);
    }).pipe(Effect.provide(layerDisabled)),
  );
});
