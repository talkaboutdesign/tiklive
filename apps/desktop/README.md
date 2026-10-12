# @tiklive/desktop

Electron desktop shell for tiklive. It runs the tiklive server in-process on `127.0.0.1:8080`, so OBS browser sources keep working while the app is open, and shows the dashboard in a window.

## Development

From the repo root:

```sh
bun run desktop:dev
```

This builds the client, bundles the main process and preload with `vp pack`, and starts Electron. The app loads `examples/overlays` and `packages/client/dist/tiklive.js` straight from the repo.

## Packaging

```sh
bun run --filter @tiklive/desktop dist:mac
```

Output goes to `apps/desktop/release/`: a DMG and a ZIP per architecture, plus `latest-mac.yml`. `dist:win` and `dist` (current platform) also exist.

`dist:mac` builds unsigned. To sign and notarize locally, copy `signing.env.example` to `.env.signing`
(gitignored), fill it in, and run `dist:mac:signed`. It signs with the Developer ID Application certificate
in your keychain and notarizes with an App Store Connect API key. Windows builds are unsigned.

## Releases (CI)

`.github/workflows/release-desktop.yml` builds macOS (arm64 + x64, signed and notarized) and Windows x64.
The Release workflow calls it whenever it publishes a new version, and attaches the installers and
`latest*.yml` files to the `vX.Y.Z` GitHub Release. The app's version is `packages/server`'s version.
Run "Desktop build" by hand in Actions to test a build without releasing; installers are uploaded as
workflow artifacts.

Repository secrets (without them the mac build is unsigned):

| Secret             | Value                                         |
| ------------------ | --------------------------------------------- |
| `CSC_LINK`         | `base64 -i DeveloperID.p12` output            |
| `CSC_KEY_PASSWORD` | the .p12 password                             |
| `APPLE_API_KEY`    | contents of `AuthKey_XXXXXXXXXX.p8`           |
| `APPLE_API_KEY_ID` | the API key ID                                |
| `APPLE_API_ISSUER` | the issuer ID from App Store Connect (a UUID) |

## Updates

Release builds check GitHub Releases (`talkaboutdesign/tiklive`) through `electron-updater`, which needs the
repo to be public. Update checks are off in dev builds. macOS only installs updates for signed builds.
