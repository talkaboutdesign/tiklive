/**
 * Owns the update state. Checks shortly after startup and then on an interval;
 * downloading and installing only happen when the user asks.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Machine from "./updateMachine.ts";
import { Updater } from "./Updater.ts";

export const STARTUP_DELAY = "15 seconds";
export const POLL_INTERVAL = "4 minutes";

export interface DesktopUpdatesOptions {
  /** Runs before the installer quits the app, e.g. to stop the server. */
  readonly beforeInstall?: Effect.Effect<void>;
}

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly state: Effect.Effect<Machine.UpdateState>;
    /** The current state, then every change. */
    readonly changes: Stream.Stream<Machine.UpdateState>;
    readonly check: Effect.Effect<void>;
    readonly download: Effect.Effect<void>;
    readonly install: Effect.Effect<void>;
  }
>()("@tiklive/desktop/DesktopUpdates") {}

export const make = (options: DesktopUpdatesOptions = {}) =>
  Effect.gen(function* () {
    const updater = yield* Updater;
    const ref = yield* SubscriptionRef.make(
      Machine.initialState(updater.currentVersion, updater.disabledReason),
    );
    // One action at a time: a poll never races a download or an install.
    const lock = yield* Semaphore.make(1);
    const update = (f: (state: Machine.UpdateState) => Machine.UpdateState) => SubscriptionRef.update(ref, f);

    const check = Effect.gen(function* () {
      if (!Machine.canCheck(yield* SubscriptionRef.get(ref))) return;
      yield* update(Machine.onCheckStart);
      const result = yield* Effect.result(updater.check);
      const now = yield* Clock.currentTimeMillis;
      yield* update((state) =>
        result._tag === "Success"
          ? Machine.onCheckResult(state, result.success, now)
          : Machine.onCheckError(state, result.failure.message, now),
      );
    }).pipe(lock.withPermits(1));

    const download = Effect.gen(function* () {
      if (Machine.actionFor(yield* SubscriptionRef.get(ref)) !== "download") return;
      yield* update(Machine.onDownloadStart);
      const result = yield* Effect.result(
        Stream.runForEach(updater.download, (percent) =>
          update((state) => Machine.onDownloadProgress(state, percent)),
        ),
      );
      yield* update((state) =>
        result._tag === "Success"
          ? Machine.onDownloaded(state)
          : Machine.onDownloadError(state, result.failure.message),
      );
    }).pipe(lock.withPermits(1));

    const install = Effect.gen(function* () {
      if (Machine.actionFor(yield* SubscriptionRef.get(ref)) !== "install") return;
      if (options.beforeInstall) yield* options.beforeInstall;
      const result = yield* Effect.result(updater.quitAndInstall);
      if (result._tag === "Failure") {
        yield* update((state) => Machine.onInstallError(state, result.failure.message));
      }
    }).pipe(lock.withPermits(1));

    if (updater.disabledReason === undefined) {
      yield* check.pipe(
        Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
        Effect.delay(STARTUP_DELAY),
        Effect.forkScoped,
      );
    }

    return DesktopUpdates.of({
      state: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      check,
      download,
      install,
    });
  });

export const layer = (options: DesktopUpdatesOptions = {}) => Layer.effect(DesktopUpdates, make(options));
