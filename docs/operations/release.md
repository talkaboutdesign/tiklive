# Release runbook

> For maintainers. Using tiklive? See [docs/user](../user/).

tiklive ships as one npm package, `tiklive`, and one desktop app. Both get the same version. Releases use
[Changesets](https://github.com/changesets/changesets) and GitHub Actions, on two channels, with no approvals:

- **Nightly:** every merge to `main` with a changeset publishes a nightly on its own.
- **Stable:** one button promotes the latest nightly.

This follows [T3 Code's release flow](https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md).

## Changesets

Contributors add a changeset in any PR that changes the published package:

```sh
bun run changeset        # pick the bump (patch, minor or major) and write a one-line summary
```

Commit the generated `.changeset/*.md` file. Only `tiklive` is versioned. The workspace packages `contracts`,
`core` and `client` are private, so Changesets ignores them and they're bundled into `tiklive`.

A PR without a changeset (docs, CI, tests) doesn't release anything when it merges.

## Nightly

Only the maintainer can merge to `main`: they're the only collaborator with write access. Every push to `main` runs
the **Release** workflow (`release.yml`):

1. CI (`ci.yml`) runs against the pushed commit. If it fails, nothing ships.
2. With pending changesets, `changeset version --snapshot nightly` versions them as a nightly of the next version,
   for example `0.6.0-nightly.20261012173210` while `0.6.0` is pending. Nothing is committed: the changesets
   stay pending on `main` until a stable release.
3. `tiklive` is published under the npm `nightly` dist-tag (`npx tiklive@nightly`). `latest` doesn't move.
4. The commit is tagged `vX.Y.Z-nightly.<timestamp>` and gets a GitHub prerelease with the pending changelog.
   Prereleases are never marked latest, so the desktop app's updater ignores them.

Nightlies don't include desktop installers yet.

To build a nightly of `main` without a new merge (for example to retry a failed one): Actions → **Release** →
**Run workflow** on `main`, channel `nightly`.

## Stable

Actions → **Release** → **Run workflow** on `main`, channel `stable`. It promotes the **latest nightly**, not the
tip of `main`, so a stable release only ships code that already ran as a nightly. Changes merged after that nightly
wait for the next release.

1. On the nightly's commit, `changeset version` bumps the version (the one the nightly previewed:
   `0.6.0-nightly.*` ships as `0.6.0`) and writes the `CHANGELOG.md` entries. The workflow commits that as
   "Release: vX.Y.Z" and merges it into `main` (a fast-forward when nothing landed after the nightly).
2. `tiklive` is published to npm under `latest` (trusted publishing, OIDC, no tokens).
3. The desktop app is built from the version commit (`release-desktop.yml`).
4. The `vX.Y.Z` GitHub Release is created on that commit with the server's changelog as notes, and the installers
   and `latest*.yml` files attached.

The GitHub Release is created only after every installer exists. The desktop app's updater reads the latest
release, so it must never see a release without its `latest*.yml` files.

To change what the stable release contains, change what's on `main` and wait for (or start) the next nightly.

### When something fails

- **CI fails on a push:** no nightly was published. Fix it in a new PR.
- **A nightly fails to publish:** run **Release** with channel `nightly`.
- **The version commit can't be merged into `main`** (a conflict): nothing was published. Fix `main`, wait for the
  next nightly, and promote that.
- **npm publish fails after the version commit:** fix the cause, then use **Re-run failed jobs**, or run
  **Release** with channel `stable` again. It finds the version commit on `main` and continues from there.
- **The desktop build or GitHub Release fails:** npm already has the version. Use **Re-run failed jobs**.

Useful commands:

- `bun run release -- --dry-run` packs the package and shows what would be published, without publishing.
- `bun run build:binaries` builds a standalone `tiklive` binary for your platform into `dist/bin/` (`--all` for
  every target). Releases don't ship them yet.
- A version with a prerelease suffix publishes under a dist-tag named after it: `0.6.0-nightly.*` under `nightly`,
  `0.3.0-next.1` under `next`.

## Environment and secrets

The release jobs run in a GitHub environment named `release`. It allows only the `main` branch and has no required
reviewers. The signing secrets live in that environment, so only runs on `main` can read them, and only the
maintainer can push to `main`.

npm's trusted publisher for `tiklive` is set to GitHub repository `talkaboutdesign/tiklive`, workflow
`release.yml`, environment `release`, and allows direct publishing (not stage-only).

| Secret (environment `release`) | Value                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `CSC_LINK`                     | `base64 -i DeveloperID.p12` output (the Developer ID Application certificate) |
| `CSC_KEY_PASSWORD`             | the .p12 password                                                             |
| `APPLE_API_KEY`                | contents of `AuthKey_XXXXXXXXXX.p8`                                           |
| `APPLE_API_KEY_ID`             | the App Store Connect API key ID                                              |
| `APPLE_API_ISSUER`             | the issuer ID from App Store Connect (a UUID)                                 |

Without the Apple secrets, the mac build is unsigned. Windows builds are unsigned.

### Developer ID certificate expiry

The Developer ID certificate expires on **February 1, 2027**. Before then, create a new one, export it with a
password, and update `CSC_LINK` and `CSC_KEY_PASSWORD`. Builds that are already notarized keep working after the
certificate expires.

### Local signed builds

To sign and notarize a macOS build on your own machine, copy `apps/desktop/signing.env.example` to
`apps/desktop/.env.signing` (gitignored) and fill it in. Then run:

```sh
bun run --filter @tiklive/desktop dist:mac:signed
```

It signs with the Developer ID Application certificate in your keychain and notarizes with the App Store Connect
API key. `dist:mac` builds unsigned, and `dist:win` builds the Windows installer.

## Test a desktop build without releasing

Actions → **Desktop build** → **Run workflow** on `main` builds the desktop installers without publishing anything.
The installers are uploaded as workflow artifacts.

## One-time migration: the rename to `tiklive`

The four `@tiklive/*` packages (`server`, `core`, `contracts`, `client`) became one package, `tiklive`. Do these
steps once, in order.

1. **First publish of `tiklive`, by hand, before the next release.** npm can only attach a trusted publisher to
   a package that already exists. Right after this change merges, and before running **Release**, publish the
   current version (`0.3.0`) from an up-to-date `main`:

   ```sh
   bun install && bun run build
   bun run release --otp=123456     # the 2FA code from your authenticator app
   ```

   Don't publish a newer version by hand: the Release workflow only builds the desktop app and creates the
   GitHub Release when it publishes the version itself.

2. **Add the trusted publisher** on npmjs.com for the `tiklive` package: GitHub repository
   `talkaboutdesign/tiklive`, workflow `release.yml`, environment `release`.
3. **Deprecate the old packages**, so installs point to the new name:

   ```sh
   npm deprecate @tiklive/server "Moved to tiklive"
   npm deprecate @tiklive/core "Moved to tiklive"
   npm deprecate @tiklive/contracts "Moved to tiklive"
   npm deprecate @tiklive/client "Moved to tiklive"
   ```

The import map (old name → new name) is in [library.md](../user/library.md#migrating-from-the-old-packages).
