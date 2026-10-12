/**
 * Viewer points, kept per streamer. `record` turns each chat, gift, like, follow, share,
 * subscribe and join into points using the streamer's settings. The file-backed store keeps
 * each streamer's totals in `<dataDir>/points/<username>.json`: busy streams are written at
 * most every 5 seconds, and changes made from the dashboard (settings, adjustments, reset)
 * are written at once. The in-memory store is for servers started without a data directory.
 */
import {
  DEFAULT_POINTS_SETTINGS,
  PointsSettings,
  Username,
  ViewerPoints,
  type LiveEvent,
  type LiveUser,
  type PointsLeaderboard,
} from "@tiklive/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

/** Per-viewer state. `likeCarry` is the likes not yet worth a point; `lastChatAt` starts chat cooldowns. */
interface Viewer {
  userId: string;
  uniqueId: string;
  nickname: string;
  profilePictureUrl: string;
  points: number;
  coins: number;
  messages: number;
  firstSeen: number;
  lastSeen: number;
  likeCarry: number;
  lastChatAt: number | null;
}

interface Board {
  settings: PointsSettings;
  viewers: Map<string, Viewer>;
  /** Goes up on every change. A board needs saving when this is above the version last saved. */
  version: number;
}

const StoredViewer = Schema.Struct({
  ...ViewerPoints.fields,
  likeCarry: Schema.Finite,
  lastChatAt: Schema.NullOr(Schema.Finite),
});
const StoredBoard = Schema.Struct({ settings: PointsSettings, viewers: Schema.Array(StoredViewer) });
type Stored = typeof StoredBoard.Type;

const FLUSH_EVERY = Duration.seconds(5);

/** The user behind the events that can earn points. Other events (questions, emotes, viewer counts, battles) are ignored. */
const userOf = (event: LiveEvent): LiveUser | undefined => {
  switch (event.type) {
    case "chat":
    case "gift":
    case "like":
    case "follow":
    case "share":
    case "join":
    case "subscribe":
      return event.user;
    default:
      return undefined;
  }
};

/** TikTok sends "0" or nothing for accounts it can't identify. Those are never scored. */
const hasRealId = (user: LiveUser) => user.userId !== "" && user.userId !== "0";

/** Points one event is worth to a viewer. Also updates the viewer's counters and cooldown. */
const earn = (event: LiveEvent, viewer: Viewer, settings: PointsSettings, now: number): number => {
  switch (event.type) {
    case "chat": {
      viewer.messages += 1;
      const due =
        viewer.lastChatAt === null || now - viewer.lastChatAt >= settings.messageCooldownSeconds * 1000;
      if (!due) return 0;
      viewer.lastChatAt = now;
      return settings.perMessage;
    }
    case "gift": {
      // A combo fires repeatedly while it runs. Only the final event (streaking: false) counts.
      if (event.streaking) return 0;
      viewer.coins += event.totalDiamonds;
      return event.totalDiamonds * settings.perCoin;
    }
    case "like": {
      viewer.likeCarry += event.likeCount;
      const whole = Math.floor(viewer.likeCarry / settings.likesPerPoint);
      viewer.likeCarry -= whole * settings.likesPerPoint;
      return whole;
    }
    case "follow":
      return settings.perFollow;
    case "share":
      return settings.perShare;
    case "subscribe":
      return settings.perSubscribe;
    case "join":
      return settings.perJoin;
    default:
      return 0;
  }
};

const publicView = (viewer: Viewer): ViewerPoints => ({
  userId: viewer.userId,
  uniqueId: viewer.uniqueId,
  nickname: viewer.nickname,
  profilePictureUrl: viewer.profilePictureUrl,
  points: viewer.points,
  coins: viewer.coins,
  messages: viewer.messages,
  firstSeen: viewer.firstSeen,
  lastSeen: viewer.lastSeen,
});

/** Best first: most points, then the earliest arrival, then user id, so ties keep a stable order. */
const byRank = (a: Viewer, b: Viewer) =>
  b.points - a.points ||
  a.firstSeen - b.firstSeen ||
  (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

const freshBoard = (): Board => ({
  settings: { ...DEFAULT_POINTS_SETTINGS },
  viewers: new Map(),
  version: 0,
});

const cloneBoard = (board: Board): Board => ({
  settings: { ...board.settings },
  viewers: new Map([...board.viewers].map(([id, viewer]) => [id, { ...viewer }])),
  version: board.version,
});

const toStored = (board: Board): Stored => ({
  settings: { ...board.settings },
  viewers: [...board.viewers.values()].map((viewer) => ({ ...viewer })),
});

// Loaded from disk, so it starts at version 0, the same as a board nothing has changed.
const fromStored = (stored: Stored): Board => ({
  settings: { ...stored.settings },
  viewers: new Map(stored.viewers.map((viewer) => [viewer.userId, { ...viewer }])),
  version: 0,
});

/** Where a streamer's totals live. `load` never fails; `save` fails only on I/O. */
interface Persistence {
  readonly load: (username: string) => Effect.Effect<Stored | undefined>;
  readonly save: (username: string, stored: Stored) => Effect.Effect<void, PointsWriteError>;
}

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

/**
 * The store logic shared by both backends. Every change runs under `lock`, so the boards only change
 * one at a time. Changes from the dashboard are saved before they take effect. Points from events only
 * bump the board's version, and `flushDirty` saves the boards that changed: on a timer when `batched`,
 * and once more when the scope closes. Saves run under `writeLock`, after `lock` is released, so a
 * large board never holds up events. An older snapshot never overwrites a newer save.
 */
const makeStore = (persistence: Persistence, batched: boolean) =>
  Effect.gen(function* () {
    // Held for every change and read. Lock order is always `lock`, then `writeLock`.
    const lock = yield* Semaphore.make(1);
    // Held only around a save.
    const writeLock = yield* Semaphore.make(1);
    const boards = new Map<string, Board>();
    // The version last saved for each streamer. Nothing saved yet counts as version 0.
    // lastWritten only changes while holding writeLock, together with the write it records.
    const saved = new Map<string, number>();
    const savedVersion = (username: string) => saved.get(username) ?? 0;

    // Only called under the lock.
    const boardFor = (username: string) =>
      Effect.gen(function* () {
        const existing = boards.get(username);
        if (existing) return existing;
        const stored = yield* persistence.load(username);
        const board = stored ? fromStored(stored) : freshBoard();
        boards.set(username, board);
        return board;
      });

    // Writes `next` and only then makes it the current board, so a failed write keeps the old totals.
    // Only called under the lock.
    const commit = (username: string, current: Board, next: Board) => {
      next.version = current.version + 1;
      return writeLock
        .withPermit(
          persistence.save(username, toStored(next)).pipe(
            // Recorded before the permit is released, so a flush can't take the lock in between and
            // write an older snapshot over this one.
            Effect.andThen(Effect.sync(() => saved.set(username, next.version))),
          ),
        )
        .pipe(Effect.andThen(Effect.sync(() => boards.set(username, next))));
    };

    // Snapshots the boards that changed since they were saved, under the lock. Then each write runs
    // under `writeLock` alone, so events keep flowing while a big board is serialized and written.
    // A snapshot is skipped if a newer version has been saved since. A failed write is logged and
    // left unsaved, so the next flush retries it.
    const flushDirty = Effect.gen(function* () {
      const pending = yield* lock.withPermit(
        Effect.sync(() =>
          [...boards].flatMap(([username, board]) =>
            board.version > savedVersion(username)
              ? [{ username, version: board.version, stored: toStored(board) }]
              : [],
          ),
        ),
      );
      yield* Effect.forEach(
        pending,
        ({ username, version, stored }) =>
          // Suspended so the saved version is checked once the write lock is held, not before.
          writeLock.withPermit(
            Effect.suspend(() =>
              version <= savedVersion(username)
                ? Effect.void
                : persistence.save(username, stored).pipe(
                    Effect.andThen(Effect.sync(() => saved.set(username, version))),
                    Effect.catch((error) =>
                      Effect.logWarning(`Could not save points for @${username}; will retry`, error),
                    ),
                  ),
            ),
          ),
        { discard: true },
      );
    });

    if (batched) {
      yield* Effect.sleep(FLUSH_EVERY).pipe(Effect.andThen(flushDirty), Effect.forever, Effect.forkScoped);
      yield* Effect.addFinalizer(() => flushDirty);
    }

    return PointsStore.of({
      record: (username, event) =>
        lock.withPermit(
          Effect.gen(function* () {
            const user = userOf(event);
            if (!user || !hasRealId(user)) return;
            const board = yield* boardFor(username);
            const now = yield* Clock.currentTimeMillis;
            let viewer = board.viewers.get(user.userId);
            // Joins are most of a big stream's events. When they earn nothing, they don't add viewers,
            // so the board (and its file) only holds people who engaged.
            if (!viewer && event.type === "join" && board.settings.perJoin === 0) return;
            if (!viewer) {
              viewer = {
                userId: user.userId,
                uniqueId: user.uniqueId,
                nickname: user.nickname,
                profilePictureUrl: user.profilePictureUrl,
                points: 0,
                coins: 0,
                messages: 0,
                firstSeen: now,
                lastSeen: now,
                likeCarry: 0,
                lastChatAt: null,
              };
              board.viewers.set(user.userId, viewer);
            }
            // The newest name and picture win, so the leaderboard follows renames.
            viewer.uniqueId = user.uniqueId;
            viewer.nickname = user.nickname || user.uniqueId;
            viewer.profilePictureUrl = user.profilePictureUrl;
            viewer.lastSeen = now;
            viewer.points += earn(event, viewer, board.settings, now);
            board.version += 1;
          }),
        ),

      get: (username, userId) =>
        lock.withPermit(
          Effect.map(boardFor(username), (board) => {
            const viewer = board.viewers.get(userId);
            return viewer ? Option.some(publicView(viewer)) : Option.none();
          }),
        ),

      leaderboard: (username, page) =>
        lock.withPermit(
          Effect.gen(function* () {
            const board = yield* boardFor(username);
            const query = page.query.trim().toLowerCase();
            const matching = [...board.viewers.values()]
              .filter(
                (viewer) =>
                  query === "" ||
                  viewer.nickname.toLowerCase().includes(query) ||
                  viewer.uniqueId.toLowerCase().includes(query),
              )
              .sort(byRank);
            return {
              settings: { ...board.settings },
              viewers: matching.slice(page.offset, page.offset + page.limit).map(publicView),
              total: matching.length,
            };
          }),
        ),

      settings: (username) =>
        lock.withPermit(Effect.map(boardFor(username), (board) => ({ ...board.settings }))),

      updateSettings: (username, settings) =>
        lock.withPermit(
          Effect.gen(function* () {
            const board = yield* boardFor(username);
            const next = cloneBoard(board);
            next.settings = { ...settings };
            yield* commit(username, board, next);
            return { ...settings };
          }),
        ),

      adjust: (username, userId, change) =>
        lock.withPermit(
          Effect.gen(function* () {
            const board = yield* boardFor(username);
            if (!board.viewers.has(userId)) return Option.none<ViewerPoints>();
            const next = cloneBoard(board);
            const viewer = next.viewers.get(userId)!;
            viewer.points = Math.max(0, "delta" in change ? viewer.points + change.delta : change.set);
            yield* commit(username, board, next);
            return Option.some(publicView(viewer));
          }),
        ),

      reset: (username) =>
        lock.withPermit(
          Effect.gen(function* () {
            const board = yield* boardFor(username);
            const next = cloneBoard(board);
            next.viewers.clear();
            yield* commit(username, board, next);
          }),
        ),
    });
  });

/**
 * `makeStore` over any persistence, so tests can hold a save open. This module is re-exported as
 * `PointsStore` from the package index, so it is part of the namespace. Use `layerFile` or `layerMemory`.
 */
export const makeStoreForTest = makeStore;

/** Points kept in memory only. Start empty, and are lost when the server stops. */
export const layerMemory: Layer.Layer<PointsStore> = Layer.effect(
  PointsStore,
  makeStore(memoryPersistence, false),
);

/** Points kept in `<dir>/points/`. Never fails: a bad file is moved aside and that streamer starts empty. */
export const layerFile = (dir: string): Layer.Layer<PointsStore> =>
  Layer.effect(PointsStore, makeStore(filePersistence(dir), true));
