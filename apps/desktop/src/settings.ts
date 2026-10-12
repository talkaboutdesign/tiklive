/**
 * Desktop app settings, saved as desktop-settings.json in the app's data
 * folder. Only the update channel for now. A missing or unreadable file means
 * the defaults.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isUpdateChannel, type UpdateChannel } from "./updates/channel.ts";

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String,
}) {}

export class DesktopSettings extends Context.Service<
  DesktopSettings,
  {
    readonly updateChannel: Effect.Effect<UpdateChannel>;
    readonly setUpdateChannel: (channel: UpdateChannel) => Effect.Effect<void, SettingsError>;
  }
>()("@tiklive/desktop/DesktopSettings") {}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const layerFile = (options: { readonly path: string; readonly defaultChannel: UpdateChannel }) =>
  Layer.effect(
    DesktopSettings,
    Effect.gen(function* () {
      const saved = yield* Effect.promise(() =>
        readFile(options.path, "utf8")
          .then((text): unknown => JSON.parse(text))
          .catch(() => undefined),
      );
      const savedChannel = (saved as { updateChannel?: unknown } | undefined)?.updateChannel;
      const channel = yield* Ref.make(isUpdateChannel(savedChannel) ? savedChannel : options.defaultChannel);

      return DesktopSettings.of({
        updateChannel: Ref.get(channel),
        setUpdateChannel: (next) =>
          Effect.tryPromise({
            try: async () => {
              await mkdir(dirname(options.path), { recursive: true });
              const tmp = `${options.path}.tmp`;
              await writeFile(tmp, `${JSON.stringify({ updateChannel: next }, null, 2)}\n`);
              await rename(tmp, options.path);
            },
            catch: (cause) => new SettingsError({ message: `Could not save settings: ${messageOf(cause)}` }),
          }).pipe(Effect.andThen(Ref.set(channel, next))),
      });
    }),
  );
