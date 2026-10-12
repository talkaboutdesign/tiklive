/**
 * Viewer points, kept per streamer. `record` turns each chat, gift, like, follow, share,
 * subscribe and join into points using the streamer's settings. The file-backed store keeps
 * each streamer's totals in `<dataDir>/points/<username>.json`: busy streams are written at
 * most every 5 seconds, and changes made from the dashboard (settings, adjustments, reset)
 * are written at once. The in-memory store is for servers started without a data directory.
 */
import {
  type PointsSettings,
  Username,
  type ViewerPoints,
  type LiveEvent,
  type PointsLeaderboard,
} from "@tiklive/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeStore, StoredBoard, type Persistence } from "./store.ts";

/** Writing a streamer's points to disk failed. The totals in memory are unchanged. */
export class PointsWriteError extends Schema.TaggedError<PointsWriteError>()("PointsWriteError", {
  message: Schema.String,
}) {}

/** A page request. `query` matches nickname or @handle, ignoring case. Empty matches everyone. */
export interface LeaderboardPage {
  readonly limit: number;
  readonly offset: number;
  readonly query: string;
}

/** Exactly one of: add `delta` (negative takes points away), or set the total to `set`. */
export type PointsChange = { readonly delta: number } | { readonly set: number };

export class PointsStore extends Context.Service<
  PointsStore,
  {
    /** Adds the points this event is worth to its user, for this streamer. Never fails. */
    readonly record: (username: string, event: LiveEvent) => Effect.Effect<void>;
    /** One viewer's totals. None when the viewer has no points yet. */
    readonly get: (username: string, userId: string) => Effect.Effect<Option.Option<ViewerPoints>>;
    readonly leaderboard: (username: string, page: LeaderboardPage) => Effect.Effect<PointsLeaderboard>;
    readonly settings: (username: string) => Effect.Effect<PointsSettings>;
    readonly updateSettings: (
      username: string,
      settings: PointsSettings,
    ) => Effect.Effect<PointsSettings, PointsWriteError>;
    /**
     * Changes one viewer's points, never below 0. None when the viewer has no points yet.
     * Written to disk before it returns.
     */
    readonly adjust: (
      username: string,
      userId: string,
      change: PointsChange,
    ) => Effect.Effect<Option.Option<ViewerPoints>, PointsWriteError>;
    /** Clears every viewer's points for this streamer. Settings stay. Written to disk before it returns. */
    readonly reset: (username: string) => Effect.Effect<void, PointsWriteError>;
  }
>()("@tiklive/server/PointsStore") {}

const memoryPersistence: Persistence = {
  load: () => Effect.succeed(undefined),
  save: () => Effect.void,
};

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Writes to `<file>.tmp` and renames over `file`, so readers never see a half-written file. */
const writeFileAtomic = (file: string, contents: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, contents);
      await rename(tmp, file);
    },
    catch: (cause) => cause,
  });

/** `<dir>/points/<username>.json`. Usernames that aren't valid TikTok handles are never written. */
const filePersistence = (dir: string): Persistence => {
  const fileFor = (username: string) => join(dir, "points", `${username}.json`);
  return {
    load: (username) =>
      Effect.gen(function* () {
        if (!Schema.is(Username)(username)) return undefined;
        const file = fileFor(username);
        const read = yield* Effect.result(
          Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (cause) => cause }),
        );
        if (read._tag === "Failure") {
          if (errorCode(read.failure) !== "ENOENT") {
            yield* Effect.logWarning(`Could not read ${file}; starting with no points`, read.failure);
          }
          return undefined;
        }
        const decoded = yield* Effect.result(
          Effect.try({ try: () => JSON.parse(read.success) as unknown, catch: (cause) => cause }).pipe(
            Effect.flatMap((json) => Schema.decodeUnknownEffect(StoredBoard)(json)),
          ),
        );
        if (decoded._tag === "Success") return decoded.success;

        const aside = `${file}.broken-${Date.now()}`;
        yield* Effect.logWarning(`Invalid points file ${file}; moving it to ${aside}`, decoded.failure);
        yield* Effect.tryPromise({ try: () => rename(file, aside), catch: (cause) => cause }).pipe(
          Effect.catch((cause) => Effect.logWarning(`Could not move ${file} aside`, cause)),
        );
        return undefined;
      }),
    save: (username, stored) => {
      if (!Schema.is(Username)(username)) return Effect.void;
      const file = fileFor(username);
      return writeFileAtomic(file, `${JSON.stringify(stored)}\n`).pipe(
        Effect.mapError(
          (cause) =>
            new PointsWriteError({ message: `Could not save points to ${file}: ${describe(cause)}` }),
        ),
      );
    },
  };
};

/** Points kept in memory only. Start empty, and are lost when the server stops. */
export const layerMemory: Layer.Layer<PointsStore> = Layer.effect(
  PointsStore,
  makeStore(memoryPersistence, false),
);

/** Points kept in `<dir>/points/`. Never fails: a bad file is moved aside and that streamer starts empty. */
export const layerFile = (dir: string): Layer.Layer<PointsStore> =>
  Layer.effect(PointsStore, makeStore(filePersistence(dir), true));
