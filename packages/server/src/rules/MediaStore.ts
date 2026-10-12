/**
 * Uploaded sounds, images and videos for actions. Files live in
 * `<dataDir>/media/`, with an `index.json` listing them, and are served at
 * `/media/<file>`.
 */
import { MAX_MEDIA_BYTES, MEDIA_TYPES, type MediaContentType, MediaItem } from "@tiklive/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * An upload was refused or couldn't be stored. `reason` maps to the HTTP status:
 * `unsupported` 415, `tooLarge` 413, `disabled` 503, `io` 500.
 */
export class MediaError extends Schema.TaggedError<MediaError>()("MediaError", {
  reason: Schema.Literals(["unsupported", "tooLarge", "disabled", "io"]),
  message: Schema.String,
}) {}

export class MediaStore extends Context.Service<
  MediaStore,
  {
    /** Newest first. */
    readonly list: Effect.Effect<ReadonlyArray<MediaItem>>;
    /**
     * Stores a file. `contentType` must be a key of `MEDIA_TYPES` (parameters such as
     * `; charset=` are ignored) and `bytes` at most `MAX_MEDIA_BYTES`. `name` is only for display.
     */
    readonly add: (
      name: string,
      contentType: string,
      bytes: Uint8Array,
    ) => Effect.Effect<MediaItem, MediaError>;
    /** Deletes the file. Returns false when no item has this id. */
    readonly remove: (id: string) => Effect.Effect<boolean>;
    /**
     * The file behind `/media/<file>`: its absolute path and content type.
     * None for unknown names, so the route never touches paths outside the media directory.
     */
    readonly resolve: (
      file: string,
    ) => Effect.Effect<Option.Option<{ readonly path: string; readonly contentType: string }>>;
  }
>()("@tiklive/server/MediaStore") {}

const MEDIA_DIR = "media";
const INDEX = "index.json";
const URL_PREFIX = "/media/";
/** Stored file names: what `add` generates. Anything else is never turned into a path. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUPPORTED = "Use PNG, JPG, GIF, WebP, MP4, WebM, MP3, WAV, OGG or M4A.";

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const normalizeContentType = (raw: string): string => (raw.split(";")[0] ?? "").trim().toLowerCase();

const cleanName = (raw: string): string =>
  raw
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, 200) || "file";

/** The stored file name behind a `/media/<file>` URL, if it is one. */
const fileOf = (url: string): string | undefined => {
  if (!url.startsWith(URL_PREFIX)) return undefined;
  const file = url.slice(URL_PREFIX.length);
  return FILE_NAME.test(file) ? file : undefined;
};

/** Reads the index. Missing means empty. A corrupt one is moved aside, and the server starts empty. */
const loadIndex = (dir: string): Effect.Effect<ReadonlyArray<MediaItem>> =>
  Effect.gen(function* () {
    const file = join(dir, MEDIA_DIR, INDEX);
    const read = yield* Effect.result(
      Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (cause) => cause }),
    );
    if (read._tag === "Failure") {
      if (errorCode(read.failure) !== "ENOENT") {
        yield* Effect.logWarning(
          `Could not read ${file}; starting with an empty media library`,
          read.failure,
        );
      }
      return [];
    }

    const decoded = yield* Effect.result(
      Effect.try({ try: () => JSON.parse(read.success) as unknown, catch: (cause) => cause }).pipe(
        Effect.flatMap((json) => Schema.decodeUnknownEffect(Schema.Array(MediaItem))(json)),
      ),
    );
    if (decoded._tag === "Success") return decoded.success;

    const aside = `${file}.broken-${Date.now()}`;
    yield* Effect.logWarning(`Invalid media index ${file}; moving it to ${aside}`, decoded.failure);
    yield* Effect.tryPromise({ try: () => rename(file, aside), catch: (cause) => cause }).pipe(
      Effect.catch((cause) => Effect.logWarning(`Could not move ${file} aside`, cause)),
    );
    return [];
  });

/** Uploads are turned off: `add` fails with a message saying how to enable them. */
export const layerDisabled: Layer.Layer<MediaStore> = Layer.succeed(MediaStore)(
  MediaStore.of({
    list: Effect.succeed([]),
    add: () =>
      Effect.fail(
        new MediaError({
          reason: "disabled",
          message: "Uploads need a data directory. Start tiklive with --data-dir <dir>.",
        }),
      ),
    remove: () => Effect.succeed(false),
    resolve: () => Effect.succeed(Option.none()),
  }),
);

/** Media files under `<dir>/media/`. Never fails: a corrupt index starts the library empty. */
export const layerFile = (dir: string): Layer.Layer<MediaStore> => {
  const mediaDir = join(dir, MEDIA_DIR);
  const indexFile = join(mediaDir, INDEX);

  return Layer.effect(
    MediaStore,
    Effect.gen(function* () {
      const items = yield* Ref.make<ReadonlyArray<MediaItem>>(yield* loadIndex(dir));
      // Serializes every change to the index and the files it lists.
      const lock = yield* Semaphore.make(1);

      const writeIndex = (next: ReadonlyArray<MediaItem>) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(mediaDir, { recursive: true });
            const tmp = `${indexFile}.tmp`;
            await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
            await rename(tmp, indexFile);
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new MediaError({ reason: "io", message: `Could not save the media index: ${describe(cause)}` }),
          ),
        );

      const removeFile = (path: string) =>
        Effect.tryPromise({ try: () => rm(path, { force: true }), catch: (cause) => cause }).pipe(
          Effect.catch((cause) => Effect.logWarning(`Could not delete ${path}`, cause)),
        );

      const add = (name: string, contentType: string, bytes: Uint8Array) =>
        Effect.gen(function* () {
          const type = normalizeContentType(contentType);
          if (!Object.hasOwn(MEDIA_TYPES, type)) {
            return yield* Effect.fail(
              new MediaError({
                reason: "unsupported",
                message: `Unsupported file type ${type}. ${SUPPORTED}`,
              }),
            );
          }
          if (bytes.length === 0) {
            return yield* Effect.fail(new MediaError({ reason: "unsupported", message: "Empty file." }));
          }
          if (bytes.length > MAX_MEDIA_BYTES) {
            return yield* Effect.fail(new MediaError({ reason: "tooLarge", message: "File is over 25 MB." }));
          }

          const spec = MEDIA_TYPES[type as MediaContentType];
          const id = randomUUID().replaceAll("-", "").slice(0, 16);
          const file = id + spec.ext;
          return yield* lock.withPermit(
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: async () => {
                  await mkdir(mediaDir, { recursive: true });
                  await writeFile(join(mediaDir, file), bytes);
                },
                catch: (cause) => cause,
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new MediaError({ reason: "io", message: `Could not store the file: ${describe(cause)}` }),
                ),
              );

              const item: MediaItem = {
                id,
                name: cleanName(name),
                kind: spec.kind,
                contentType: type,
                size: bytes.length,
                url: `${URL_PREFIX}${file}`,
                createdAt: Date.now(),
              };
              const current = yield* Ref.get(items);
              const next = [...current, item];
              yield* writeIndex(next).pipe(
                Effect.catch((error) =>
                  removeFile(join(mediaDir, file)).pipe(Effect.andThen(Effect.fail(error))),
                ),
              );
              yield* Ref.set(items, next);
              return item;
            }),
          );
        });

      const remove = (id: string) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(items);
            const item = current.find((candidate) => candidate.id === id);
            if (!item) return false;
            const next = current.filter((candidate) => candidate.id !== id);
            const saved = yield* Effect.result(writeIndex(next));
            if (saved._tag === "Failure") {
              yield* Effect.logWarning(`Could not remove media ${id}`, saved.failure);
              return false;
            }
            yield* Ref.set(items, next);
            const file = fileOf(item.url);
            if (file) yield* removeFile(join(mediaDir, file));
            return true;
          }),
        );

      return MediaStore.of({
        list: Effect.map(Ref.get(items), (current) =>
          [...current].reverse().sort((a, b) => b.createdAt - a.createdAt),
        ),
        add,
        remove,
        resolve: (file) =>
          Effect.map(Ref.get(items), (current) => {
            if (!FILE_NAME.test(file)) return Option.none();
            const item = current.find((candidate) => candidate.url === `${URL_PREFIX}${file}`);
            return item
              ? Option.some({ path: join(mediaDir, file), contentType: item.contentType })
              : Option.none();
          }),
      });
    }),
  );
};
