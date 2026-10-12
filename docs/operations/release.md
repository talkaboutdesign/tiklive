# Release runbook

> For maintainers. Using tiklive? See [docs/user](../user/).

tiklive ships as one npm package, `tiklive`, and one desktop app. Both get the same version. Releases use
[Changesets](https://github.com/changesets/changesets) and GitHub Actions. Nothing runs on its own: a release
starts only when the maintainer runs it by hand.

## Changesets

Contributors add a changeset in any PR that changes the published package:

```sh
bun run changeset        # pick the bump (patch, minor or major) and write a one-line summary
```

Commit the generated `.changeset/*.md` file. Only `tiklive` is versioned. The workspace packages `contracts`,
`core` and `client` are private, so Changesets ignores them and they're bundled into `tiklive`.

Changesets pile up on `main` until the maintainer decides to release.

## Release steps

Only the maintainer can start or approve a release. The steps are in order:

1. **Open the version PR.** Actions → **Release** → **Run workflow** on `main`. With pending changesets, the
   workflow opens or updates a "Release: version packages" PR. That PR bumps the version and writes
   `CHANGELOG.md` entries.
2. **Merge the version PR.**
3. **Publish.** Run **Release** again on `main`. With no pending changesets, the workflow:
   - stages `tiklive` on npm (trusted publishing, OIDC, no tokens),
   - builds the desktop app (`release-desktop.yml`, which uses the same version),
   - creates the `vX.Y.Z` GitHub Release with the server's changelog as notes, and attaches the installers and
     `latest*.yml` files.
4. **Approve the npm stage.** Staged versions aren't installable yet. Approve them with 2FA, on npmjs.com or
   with the CLI:

   ```sh
   npm stage list tiklive
   npm stage approve <stage-id>
   ```

The GitHub Release is created only after every installer exists. The desktop app's updater reads the latest
release, so it must never see a release without its `latest*.yml` files.

Useful commands:

- `bun run release -- --dry-run` packs the package and shows what would be published, without publishing.
- `bun run build:binaries` builds a standalone `tiklive` binary for your platform into `dist/bin/` (`--all` for
  every target). Releases don't ship them yet.
- A version with a prerelease suffix (for example `0.3.0-next.1`) publishes under the `next` dist-tag.

## Environment and secrets

The jobs run in a protected GitHub environment named `release`. It requires the maintainer's approval and allows
only the `main` branch. The signing secrets live in that environment, so no one else can start or approve a
release or read the secrets.

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

Actions → **Desktop build** → **Run workflow** builds the desktop installers without publishing anything. It also
needs the `release` environment approval. The installers are uploaded as workflow artifacts.

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
