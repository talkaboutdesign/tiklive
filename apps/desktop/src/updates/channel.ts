/**
 * Update channels. "latest" follows stable releases; "nightly" follows the
 * prereleases published for every change merged to main
 * (vX.Y.Z-nightly.<timestamp>, with nightly*.yml update files).
 */
import * as Schema from "effect/Schema";

export const UpdateChannel = Schema.Literals(["latest", "nightly"]);
export type UpdateChannel = typeof UpdateChannel.Type;

export const isUpdateChannel = Schema.is(UpdateChannel);

export const isNightlyVersion = (version: string): boolean => /^[^-+]+-nightly\./.test(version);

/** A nightly build follows nightlies until the user picks a channel. */
export const defaultChannel = (currentVersion: string): UpdateChannel =>
  isNightlyVersion(currentVersion) ? "nightly" : "latest";

/**
 * How electron-updater should look for updates on `channel`. On "nightly" it
 * only considers nightly releases. A nightly build on "latest" may move to an
 * older stable release, since the user asked for stable; otherwise only newer
 * versions count, so a stable install doesn't "update" to the nightly of the
 * same version.
 */
export const updaterOptions = (channel: UpdateChannel, currentVersion: string) => ({
  channel,
  allowPrerelease: channel === "nightly",
  allowDowngrade: channel === "latest" && isNightlyVersion(currentVersion),
});
