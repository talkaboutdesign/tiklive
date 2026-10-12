/**
 * The update feed, as a service. `electronLayer` wraps electron-updater (which
 * reads the GitHub Releases feed electron-builder writes into the app);
 * tests provide a fake.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class UpdaterError extends Schema.TaggedError<UpdaterError>()("UpdaterError", {
  message: Schema.String,
}) {}

export class Updater extends Context.Service<
  Updater,
  {
    readonly currentVersion: string;
    /** Why updates are off (e.g. a dev build), or undefined when they're on. */
    readonly disabledReason: string | undefined;
    /** Asks the feed for a newer version. Resolves to that version, or undefined when up to date. */
    readonly check: Effect.Effect<string | undefined, UpdaterError>;
    /** Downloads the version the last check found. Emits progress (0–100) and ends when done. */
    readonly download: Stream.Stream<number, UpdaterError>;
    /** Quits the app and runs the installer. */
    readonly quitAndInstall: Effect.Effect<void, UpdaterError>;
  }
>()("@tiklive/desktop/Updater") {}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** electron-updater, set up so nothing downloads or installs without the user asking. */
export const electronLayer = (options: { readonly isPackaged: boolean; readonly currentVersion: string }) =>
  Layer.effect(
    Updater,
    Effect.gen(function* () {
      const disabledReason = !options.isPackaged
        ? "Updates are off in development builds."
        : process.env.TIKLIVE_DISABLE_AUTO_UPDATE
          ? "Updates are turned off by TIKLIVE_DISABLE_AUTO_UPDATE."
          : undefined;

      // Loaded lazily: electron-updater touches Electron's `app` at import time.
      const { autoUpdater } = yield* Effect.promise(() => import("electron-updater"));
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      // Failures surface through the promises below; this keeps EventEmitter from throwing.
      autoUpdater.on("error", () => {});

      return Updater.of({
        currentVersion: options.currentVersion,
        disabledReason,
        check: Effect.tryPromise({
          try: () => autoUpdater.checkForUpdates(),
          catch: (cause) => new UpdaterError({ message: messageOf(cause) }),
        }).pipe(Effect.map((result) => (result?.isUpdateAvailable ? result.updateInfo.version : undefined))),
        download: Stream.callback<number, UpdaterError>((queue) =>
          Effect.gen(function* () {
            const onProgress = (progress: { readonly percent: number }) => {
              Queue.offerUnsafe(queue, progress.percent);
            };
            yield* Effect.acquireRelease(
              Effect.sync(() => autoUpdater.on("download-progress", onProgress)),
              () => Effect.sync(() => autoUpdater.off("download-progress", onProgress)),
            );
            yield* Effect.tryPromise({
              try: () => autoUpdater.downloadUpdate(),
              catch: (cause) => new UpdaterError({ message: messageOf(cause) }),
            });
            Queue.endUnsafe(queue);
          }),
        ),
        quitAndInstall: Effect.try({
          try: () => autoUpdater.quitAndInstall(true, true),
          catch: (cause) => new UpdaterError({ message: messageOf(cause) }),
        }),
      });
    }),
  );
