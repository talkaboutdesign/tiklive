import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { DesktopSettings, SettingsError } from "../settings.ts";
import type { UpdateChannel } from "./channel.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { actionFor } from "./updateMachine.ts";
import { Updater, UpdaterError } from "./Updater.ts";

interface FakeOptions {
  disabledReason?: string;
  /** The saved channel. */
  channel?: UpdateChannel;
  saveFails?: boolean;
  /** Each check takes the next entry; the last one repeats. A string is the available version. */
  checks?: Array<string | undefined | UpdaterError>;
  downloads?: Array<Stream.Stream<number, UpdaterError>>;
  installFails?: boolean;
}

const fakeUpdater = (options: FakeOptions = {}) => {
  const calls = {
    checks: 0,
    downloads: 0,
    installs: 0,
    beforeInstall: 0,
    /** Every channel the updater was pointed at, in order. */
    channels: [] as Array<UpdateChannel>,
    saved: [] as Array<UpdateChannel>,
  };
  const checks = options.checks ?? [undefined];
  const downloads = options.downloads ?? [Stream.make(40, 100)];
  const updater = Updater.of({
    currentVersion: "1.0.0",
    disabledReason: options.disabledReason,
    setChannel: (channel) => Effect.sync(() => void calls.channels.push(channel)),
    check: Effect.suspend(() => {
      const next = checks[Math.min(calls.checks++, checks.length - 1)];
      return next instanceof UpdaterError ? Effect.fail(next) : Effect.succeed(next);
    }),
    download: Stream.suspend(() => downloads[Math.min(calls.downloads++, downloads.length - 1)]!),
    quitAndInstall: Effect.suspend(() => {
      calls.installs++;
      return options.installFails
        ? Effect.fail(new UpdaterError({ message: "installer failed" }))
        : Effect.void;
    }),
  });
  const settings = DesktopSettings.of({
    updateChannel: Effect.succeed(options.channel ?? "latest"),
    setUpdateChannel: (channel) =>
      options.saveFails
        ? Effect.fail(new SettingsError({ message: "disk full" }))
        : Effect.sync(() => void calls.saved.push(channel)),
  });
  const service = DesktopUpdates.make({ beforeInstall: Effect.sync(() => calls.beforeInstall++) }).pipe(
    Effect.provideService(Updater, updater),
    Effect.provideService(DesktopSettings, settings),
  );
  return { calls, service };
};

describe("DesktopUpdates", () => {
  it.effect("does nothing when updates are disabled", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({ disabledReason: "dev build" });
      const updates = yield* service;
      yield* TestClock.adjust("1 hour");
      yield* updates.check;

      expect(calls.checks).toBe(0);
      expect(yield* updates.state).toEqual({
        status: "disabled",
        currentVersion: "1.0.0",
        channel: "latest",
        message: "dev build",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("checks after the startup delay, then on every interval", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({ checks: [undefined, "1.1.0"] });
      const updates = yield* service;

      yield* TestClock.adjust("14 seconds");
      expect(calls.checks).toBe(0);
      yield* TestClock.adjust("1 second");
      expect(calls.checks).toBe(1);
      expect((yield* updates.state).status).toBe("up-to-date");

      yield* TestClock.adjust(DesktopUpdates.POLL_INTERVAL);
      expect(calls.checks).toBe(2);
      const state = yield* updates.state;
      expect(state).toMatchObject({ status: "available", availableVersion: "1.1.0" });
      expect(actionFor(state)).toBe("download");
    }).pipe(Effect.scoped),
  );

  it.effect("downloads and installs only when asked", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({ checks: ["1.1.0"] });
      const updates = yield* service;
      yield* updates.check;
      expect(calls.downloads).toBe(0);

      yield* updates.download;
      expect(yield* updates.state).toMatchObject({ status: "downloaded", availableVersion: "1.1.0" });
      expect(calls.installs).toBe(0);

      yield* updates.install;
      expect(calls.beforeInstall).toBe(1);
      expect(calls.installs).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("reports download progress", () =>
    Effect.gen(function* () {
      const { service } = fakeUpdater({ checks: ["1.1.0"], downloads: [Stream.make(10, 55.5, 100)] });
      const updates = yield* service;
      yield* updates.check;

      const seen = yield* updates.changes.pipe(
        Stream.filter((state) => state.status === "downloading"),
        Stream.map((state) => state.downloadPercent),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* updates.download;

      expect(Array.from(yield* Fiber.join(seen))).toEqual([0, 10, 55.5, 100]);
    }).pipe(Effect.scoped),
  );

  it.effect("a failed download can be retried", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({
        checks: ["1.1.0"],
        downloads: [Stream.fail(new UpdaterError({ message: "network down" })), Stream.make(100)],
      });
      const updates = yield* service;
      yield* updates.check;
      yield* updates.download;

      const failed = yield* updates.state;
      expect(failed).toMatchObject({ status: "error", errorContext: "download", message: "network down" });
      expect(actionFor(failed)).toBe("download");

      yield* updates.download;
      expect(calls.downloads).toBe(2);
      expect((yield* updates.state).status).toBe("downloaded");
    }).pipe(Effect.scoped),
  );

  it.effect("a failed install keeps the download for another try", () =>
    Effect.gen(function* () {
      const { service } = fakeUpdater({ checks: ["1.1.0"], installFails: true });
      const updates = yield* service;
      yield* updates.check;
      yield* updates.download;
      yield* updates.install;

      const state = yield* updates.state;
      expect(state).toMatchObject({
        status: "downloaded",
        errorContext: "install",
        message: "installer failed",
      });
      expect(actionFor(state)).toBe("install");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps polling after a failed check", () =>
    Effect.gen(function* () {
      const { service } = fakeUpdater({ checks: [new UpdaterError({ message: "offline" }), "1.1.0"] });
      const updates = yield* service;

      yield* TestClock.adjust(DesktopUpdates.STARTUP_DELAY);
      expect(yield* updates.state).toMatchObject({
        status: "error",
        errorContext: "check",
        message: "offline",
      });

      yield* TestClock.adjust(DesktopUpdates.POLL_INTERVAL);
      expect(yield* updates.state).toMatchObject({ status: "available", availableVersion: "1.1.0" });
    }).pipe(Effect.scoped),
  );

  it.effect("stops checking once an update is downloaded", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({ checks: ["1.1.0"] });
      const updates = yield* service;
      yield* updates.check;
      yield* updates.download;

      yield* TestClock.adjust("1 hour");
      expect(calls.checks).toBe(1);
      expect((yield* updates.state).status).toBe("downloaded");
    }).pipe(Effect.scoped),
  );

  it.effect("starts on the saved channel", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({ channel: "nightly" });
      const updates = yield* service;

      expect(calls.channels).toEqual(["nightly"]);
      expect((yield* updates.state).channel).toBe("nightly");
    }).pipe(Effect.scoped),
  );

  it.effect("switching channels saves it and checks the new channel right away", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({ checks: ["1.1.0", "1.2.0-nightly.20261012173210"] });
      const updates = yield* service;
      yield* updates.check;
      expect(yield* updates.state).toMatchObject({ channel: "latest", availableVersion: "1.1.0" });

      yield* updates.setChannel("nightly");

      expect(calls.saved).toEqual(["nightly"]);
      expect(calls.channels).toEqual(["latest", "nightly"]);
      expect(calls.checks).toBe(2);
      expect(yield* updates.state).toMatchObject({
        status: "available",
        channel: "nightly",
        availableVersion: "1.2.0-nightly.20261012173210",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("picking the current channel does nothing", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater();
      const updates = yield* service;
      yield* updates.setChannel("latest");

      expect(calls.saved).toEqual([]);
      expect(calls.checks).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the old channel when it can't be saved", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({ saveFails: true });
      const updates = yield* service;
      const result = yield* Effect.result(updates.setChannel("nightly"));

      expect(result._tag).toBe("Failure");
      expect(calls.channels).toEqual(["latest"]);
      expect((yield* updates.state).channel).toBe("latest");
    }).pipe(Effect.scoped),
  );

  it.effect("saves the channel while updates are disabled, without checking", () =>
    Effect.gen(function* () {
      const { calls, service } = fakeUpdater({ disabledReason: "dev build" });
      const updates = yield* service;
      yield* updates.setChannel("nightly");

      expect(calls.saved).toEqual(["nightly"]);
      expect(calls.checks).toBe(0);
      expect(yield* updates.state).toMatchObject({ status: "disabled", channel: "nightly" });
    }).pipe(Effect.scoped),
  );
});
