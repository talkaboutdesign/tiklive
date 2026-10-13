# @tiklive/desktop

Electron desktop shell for tiklive. It runs the tiklive server in-process on `127.0.0.1:8080`, so OBS browser sources keep working while the app is open, and shows the dashboard in a window. For users, see [docs/user/desktop.md](../../docs/user/desktop.md).

## Development

From the repo root:

```sh
bun run desktop:dev
```

This builds the client, bundles the main process and preload with `vp pack`, and starts Electron. The app loads `examples/overlays` and `packages/client/dist/tiklive.js` straight from the repo.

On quit, the app destroys its windows before shutting down the server. External clients such as OBS get a
one-second server grace period before their connections are closed. Quit still waits for the final points
save to finish.

## Packaging

```sh
bun run --filter @tiklive/desktop dist:mac
```

Output goes to `apps/desktop/release/`: a DMG and a ZIP per architecture, plus `latest-mac.yml`. `dist:win` and `dist` (current platform) also exist.

The app icon is `build/icon.png` (1024×1024, transparent corners, the shape at 824 px like Apple's icon grid).
electron-builder generates the macOS `.icns` and Windows `.ico` from it.

`dist:mac` builds unsigned. To sign and notarize locally, copy `signing.env.example` to `.env.signing`
(gitignored), fill it in, and run `dist:mac:signed`. It signs with the Developer ID Application certificate
in your keychain and notarizes with an App Store Connect API key. Windows builds are unsigned.

## Releases and updates

The release workflow builds the signed macOS DMGs and the Windows installer for both channels. Stable releases
(`vX.Y.Z`) carry `latest*.yml` update files; nightly prereleases (`vX.Y.Z-nightly.<timestamp>`) carry
`nightly*.yml`. The app's version is the `tiklive` package version.

The update channel (`latest` or `nightly`) is saved in `desktop-settings.json` in the app's data folder and set on
the Settings page (`examples/overlays/settings.html`, About). `src/updates/channel.ts` maps it to electron-updater's `channel`,
`allowPrerelease` and `allowDowngrade`.
The signing secrets, the `release` environment and the release steps are in
[docs/operations/release.md](../../docs/operations/release.md). How updates behave for users is in
[docs/user/desktop.md](../../docs/user/desktop.md#updates).
