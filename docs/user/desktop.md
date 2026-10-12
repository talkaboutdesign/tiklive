# Desktop app

The desktop app is an Electron app. It runs the tiklive server inside the app, on `127.0.0.1:8080`, so OBS
browser sources keep working while the app is open. It shows the dashboard in a window.

## Install

Download the latest version from [GitHub Releases](https://github.com/talkaboutdesign/tiklive/releases):

- **macOS:** a DMG for Apple Silicon and a DMG for Intel. The macOS builds are signed and notarized.
- **Windows:** an x64 NSIS installer. It isn't code-signed yet, so Windows SmartScreen warns when you run it.
  Click **More info**, then **Run anyway**.

## Port 8080

The app uses `127.0.0.1:8080`. If another tiklive is already running there, for example `npx tiklive` in a
terminal, the app shows an error instead of starting. Quit the other one first.

## Updates

The app checks GitHub Releases for a newer version. It doesn't download anything on its own:

1. When a new version is out, the dashboard header shows an update button.
2. Click the button to download the update.
3. When the download finishes, click **Restart to update**.

macOS installs updates only for signed builds. Development builds, from `bun run desktop:dev`, have updates
turned off.

## Using it with OBS

The app serves the same dashboard and overlays as the command-line server, at http://127.0.0.1:8080/. Use the
URLs in [overlays.md](./overlays.md).

## Build it yourself

From a checkout, `bun run desktop:dev` builds the client and starts the app. Packaging, signing and the release
flow are in [apps/desktop/README.md](../../apps/desktop/README.md) and [the release runbook](../operations/release.md).
