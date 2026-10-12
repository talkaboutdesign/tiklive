/**
 * PointsStore: what each event is worth, the chat cooldown, likes, gifts, admin changes, and the
 * file-backed store (batched writes, writes on close, restarts, a corrupt file, a failed write).
 */
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_POINTS_SETTINGS,
  type LiveEvent,
  type LiveUser,
  type PointsSettings,
} from "@tiklive/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layerFile, layerMemory, PointsStore, PointsWriteError } from "./PointsStore.ts";

const USER = "streamer";

const user = (userId: string, nickname = `Name ${userId}`, uniqueId = `handle${userId}`): LiveUser => ({
  userId,
  uniqueId,
  nickname,
  profilePictureUrl: `https://img.example/${userId}.jpg`,
});

const chat = (userId: string, comment = "hello", who: LiveUser = user(userId)): LiveEvent => ({
  type: "chat",
  timestamp: 0,
  user: who,
  comment,
  emotes: [],
});

const gift = (userId: string, totalDiamonds: number, streaking = false): LiveEvent => ({
  type: "gift",
  timestamp: 0,
  user: user(userId),
  giftId: 1,
  giftName: "Rose",
  giftImageUrl: "",
  diamondCount: totalDiamonds,
  repeatCount: 1,
  streaking,
  totalDiamonds,
  groupId: "g",
});

const like = (userId: string, likeCount: number): LiveEvent => ({
  type: "like",
  timestamp: 0,
  user: user(userId),
  likeCount,
  totalLikeCount: likeCount,
});

const follow = (userId: string, who: LiveUser = user(userId)): LiveEvent => ({
  type: "follow",
  timestamp: 0,
  user: who,
});
const share = (userId: string): LiveEvent => ({ type: "share", timestamp: 0, user: user(userId) });
const joinEvent = (userId: string): LiveEvent => ({ type: "join", timestamp: 0, user: user(userId) });
const subscribe = (userId: string): LiveEvent => ({
  type: "subscribe",
  timestamp: 0,
  user: user(userId),
  subMonth: 1,
});

/** Points of one viewer, or undefined when they have none yet. */
const pointsOf = (store: PointsStore["Service"], userId: string) =>
  Effect.map(store.get(USER, userId), (viewer) => (Option.isSome(viewer) ? viewer.value.points : undefined));

const settingsWith = (patch: Partial<PointsSettings>): PointsSettings => ({
  ...DEFAULT_POINTS_SETTINGS,
  ...patch,
});

describe("PointsStore: what events are worth", () => {
  it.effect("awards the default points for each kind of event", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, chat("1"));
      yield* store.record(USER, follow("1"));
      yield* store.record(USER, share("1"));
      yield* store.record(USER, subscribe("1"));
      yield* store.record(USER, joinEvent("1"));
      // 1 (chat) + 50 (follow) + 20 (share) + 200 (subscribe) + 0 (join)
      expect(yield* pointsOf(store, "1")).toBe(271);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("gives coins times perCoin for a finished gift, and records the coins", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, gift("1", 30));
      expect(yield* pointsOf(store, "1")).toBe(300);
      const viewer = yield* store.get(USER, "1");
      expect(Option.getOrThrow(viewer).coins).toBe(30);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("counts a combo once, when it ends (streaking: false)", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, gift("1", 1, true));
      yield* store.record(USER, gift("1", 2, true));
      expect(yield* pointsOf(store, "1")).toBe(0);
      yield* store.record(USER, gift("1", 3, false));
      expect(yield* pointsOf(store, "1")).toBe(30);
      expect(Option.getOrThrow(yield* store.get(USER, "1")).coins).toBe(3);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("gives chat points at most once per cooldown, but counts every message", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, chat("1"));
      yield* TestClock.adjust("30 seconds");
      yield* store.record(USER, chat("1"));
      yield* store.record(USER, chat("1"));
      const viewer = Option.getOrThrow(yield* store.get(USER, "1"));
      expect(viewer.points).toBe(1);
      expect(viewer.messages).toBe(3);

      yield* TestClock.adjust("30 seconds");
      yield* store.record(USER, chat("1"));
      expect(yield* pointsOf(store, "1")).toBe(2);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("gives chat points on every message when the cooldown is 0", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.updateSettings(USER, settingsWith({ messageCooldownSeconds: 0 }));
      yield* store.record(USER, chat("1"));
      yield* store.record(USER, chat("1"));
      expect(yield* pointsOf(store, "1")).toBe(2);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("adds likes up across batches, so 20 likes are one point", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, like("1", 15));
      expect(yield* pointsOf(store, "1")).toBe(0);
      yield* store.record(USER, like("1", 10));
      expect(yield* pointsOf(store, "1")).toBe(1);
      // 5 left over from before, plus 15 more: one more point, 0 left over.
      yield* store.record(USER, like("1", 15));
      expect(yield* pointsOf(store, "1")).toBe(2);
      yield* store.record(USER, like("1", 19));
      expect(yield* pointsOf(store, "1")).toBe(2);
      yield* store.record(USER, like("1", 1));
      expect(yield* pointsOf(store, "1")).toBe(3);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("ignores events without a real user id", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, follow("0"));
      yield* store.record(USER, follow("", user("")));
      yield* store.record(USER, { type: "viewers", timestamp: 0, viewerCount: 5, topViewers: [] });
      yield* store.record(USER, { type: "streamEnd", timestamp: 0, reason: "ended" });
      const board = yield* store.leaderboard(USER, { limit: 10, offset: 0, query: "" });
      expect(board.total).toBe(0);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("follows the latest nickname and picture", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, chat("1"));
      yield* store.record(USER, chat("1", "hi", user("1", "New name", "newhandle")));
      const viewer = Option.getOrThrow(yield* store.get(USER, "1"));
      expect(viewer).toMatchObject({ nickname: "New name", uniqueId: "newhandle", points: 1 });
      expect(viewer.lastSeen).toBeGreaterThanOrEqual(viewer.firstSeen);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("keeps each streamer's points apart", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record("alpha", follow("1"));
      expect(Option.isNone(yield* store.get("beta", "1"))).toBe(true);
      expect(Option.getOrThrow(yield* store.get("alpha", "1")).points).toBe(50);
    }).pipe(Effect.provide(layerMemory)),
  );
});

describe("PointsStore: leaderboard and settings", () => {
  it.effect("sorts by points, pages, and filters by name or handle without case", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, follow("1")); // 50
      yield* store.record(USER, follow("2", user("2", "Alice", "alice_x"))); // 50, same time as 1
      yield* TestClock.adjust("1 second");
      yield* store.record(USER, follow("3", user("3", "Bob", "bobby"))); // 50, arrived later
      yield* store.record(USER, gift("4", 10)); // 100

      const all = yield* store.leaderboard(USER, { limit: 10, offset: 0, query: "" });
      expect(all.total).toBe(4);
      expect(all.viewers.map((v) => v.userId)).toEqual(["4", "1", "2", "3"]);

      const page = yield* store.leaderboard(USER, { limit: 2, offset: 1, query: "" });
      expect(page.viewers.map((v) => v.userId)).toEqual(["1", "2"]);
      expect(page.total).toBe(4);

      const byName = yield* store.leaderboard(USER, { limit: 10, offset: 0, query: "  ALICE " });
      expect(byName.viewers.map((v) => v.userId)).toEqual(["2"]);
      expect(byName.total).toBe(1);

      const byHandle = yield* store.leaderboard(USER, { limit: 10, offset: 0, query: "bobby" });
      expect(byHandle.viewers.map((v) => v.userId)).toEqual(["3"]);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("starts with the default settings and returns the ones that were saved", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      expect(yield* store.settings(USER)).toEqual(DEFAULT_POINTS_SETTINGS);
      const next = settingsWith({ perFollow: 5, likesPerPoint: 1 });
      expect(yield* store.updateSettings(USER, next)).toEqual(next);
      expect(yield* store.settings(USER)).toEqual(next);

      yield* store.record(USER, follow("1"));
      yield* store.record(USER, like("1", 3));
      expect(yield* pointsOf(store, "1")).toBe(8);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("adjusts by delta and never goes below 0", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, follow("1"));
      const up = yield* store.adjust(USER, "1", { delta: 10 });
      expect(Option.getOrThrow(up).points).toBe(60);
      const down = yield* store.adjust(USER, "1", { delta: -1000 });
      expect(Option.getOrThrow(down).points).toBe(0);
      expect(yield* pointsOf(store, "1")).toBe(0);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("sets the total", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      yield* store.record(USER, follow("1"));
      expect(Option.getOrThrow(yield* store.adjust(USER, "1", { set: 7 })).points).toBe(7);
      expect(yield* pointsOf(store, "1")).toBe(7);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("returns None when adjusting a viewer with no points", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      expect(Option.isNone(yield* store.adjust(USER, "nobody", { delta: 5 }))).toBe(true);
      expect(Option.isNone(yield* store.get(USER, "nobody"))).toBe(true);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("reset clears every viewer but keeps the settings", () =>
    Effect.gen(function* () {
      const store = yield* PointsStore;
      const next = settingsWith({ perFollow: 9 });
      yield* store.updateSettings(USER, next);
      yield* store.record(USER, follow("1"));
      yield* store.record(USER, follow("2"));
      yield* store.reset(USER);
      expect((yield* store.leaderboard(USER, { limit: 10, offset: 0, query: "" })).total).toBe(0);
      expect(yield* store.settings(USER)).toEqual(next);
    }).pipe(Effect.provide(layerMemory)),
  );
});

// ---- the file-backed store ----

/** A fresh directory, removed when the test ends. */
const withTempDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "tiklive-points-")));
    return yield* body(dir).pipe(
      Effect.ensuring(Effect.promise(() => rm(dir, { recursive: true, force: true }))),
    );
  });

const onDisk = (dir: string) =>
  Effect.promise(async () => {
    try {
      return JSON.parse(await readFile(join(dir, "points", `${USER}.json`), "utf8")) as {
        settings: PointsSettings;
        viewers: Array<{ userId: string; points: number }>;
      };
    } catch {
      return undefined;
    }
  });

/**
 * Like `onDisk`, but waits in real time for the write. The fake clock moves the flush timer,
 * and the file write itself is real I/O that finishes on its own schedule.
 */
const onDiskSoon = (dir: string) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        return JSON.parse(await readFile(join(dir, "points", `${USER}.json`), "utf8")) as {
          settings: PointsSettings;
          viewers: Array<{ userId: string; points: number }>;
        };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return undefined;
  });

describe("PointsStore in a file", () => {
  it.effect("writes a streamer's points about 5 seconds after they change, not per event", () =>
    Effect.scoped(
      withTempDir((dir) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const store = yield* PointsStore;
            yield* store.record(USER, follow("1"));
            yield* store.record(USER, follow("2"));
            expect(yield* onDisk(dir)).toBeUndefined();
            yield* TestClock.adjust("4 seconds");
            expect(yield* onDisk(dir)).toBeUndefined();
            yield* TestClock.adjust("1 second");
            const saved = yield* onDiskSoon(dir);
            expect(saved?.viewers.map((v) => [v.userId, v.points])).toEqual([
              ["1", 50],
              ["2", 50],
            ]);
          }).pipe(Effect.provide(layerFile(dir)));
        }),
      ),
    ),
  );

  it.effect("writes pending points when the server stops, before the next timer", () =>
    Effect.scoped(
      withTempDir((dir) =>
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* PointsStore;
              yield* store.record(USER, follow("1"));
            }).pipe(Effect.provide(layerFile(dir))),
          );
          expect(yield* onDisk(dir)).toMatchObject({ viewers: [{ userId: "1", points: 50 }] });
        }),
      ),
    ),
  );

  it.effect("keeps points, settings and cooldowns across a restart", () =>
    Effect.scoped(
      withTempDir((dir) =>
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* PointsStore;
              yield* store.updateSettings(USER, settingsWith({ perFollow: 3, likesPerPoint: 10 }));
              yield* store.record(USER, chat("1"));
              yield* store.record(USER, like("1", 7));
            }).pipe(Effect.provide(layerFile(dir))),
          );

          yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* PointsStore;
              expect(yield* store.settings(USER)).toMatchObject({ perFollow: 3, likesPerPoint: 10 });
              expect(yield* pointsOf(store, "1")).toBe(1);
              // Still inside the chat cooldown from before the restart.
              yield* store.record(USER, chat("1"));
              expect(yield* pointsOf(store, "1")).toBe(1);
              // The 7 likes carried over: 3 more make 10, which is one more point.
              yield* store.record(USER, like("1", 3));
              expect(yield* pointsOf(store, "1")).toBe(2);
            }).pipe(Effect.provide(layerFile(dir))),
          );
        }),
      ),
    ),
  );

  it.effect("writes adjustments and resets at once", () =>
    Effect.scoped(
      withTempDir((dir) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const store = yield* PointsStore;
            yield* store.record(USER, follow("1"));
            yield* store.adjust(USER, "1", { set: 99 });
            expect(yield* onDisk(dir)).toMatchObject({ viewers: [{ userId: "1", points: 99 }] });
            yield* store.reset(USER);
            expect(yield* onDisk(dir)).toMatchObject({ viewers: [] });
          }).pipe(Effect.provide(layerFile(dir)));
        }),
      ),
    ),
  );

  it.effect("moves a corrupt file aside and starts that streamer empty", () =>
    Effect.scoped(
      withTempDir((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => mkdir(join(dir, "points"), { recursive: true }));
          yield* Effect.promise(() => writeFile(join(dir, "points", `${USER}.json`), "{ not json"));
          yield* Effect.gen(function* () {
            const store = yield* PointsStore;
            expect((yield* store.leaderboard(USER, { limit: 10, offset: 0, query: "" })).total).toBe(0);
          }).pipe(Effect.provide(layerFile(dir)));
          const files = yield* Effect.promise(() => readdir(join(dir, "points")));
          expect(files.some((name) => /^streamer\.json\.broken-\d+$/.test(name))).toBe(true);
          expect(files).not.toContain(`${USER}.json`);
        }),
      ),
    ),
  );

  it.effect("keeps the old totals when an adjustment can't be written", () =>
    Effect.scoped(
      withTempDir((dir) =>
        Effect.gen(function* () {
          // A regular file where the points folder should be: nothing can be written there.
          yield* Effect.promise(() => writeFile(join(dir, "points"), "x"));
          const store = yield* PointsStore;
          const failed = yield* Effect.flip(store.reset(USER));
          expect(failed).toBeInstanceOf(PointsWriteError);
          expect(failed.message).toContain("Could not save points");
          expect(Option.isNone(yield* store.get(USER, "1"))).toBe(true);
        }).pipe(Effect.provide(layerFile(dir))),
      ),
    ),
  );
});
