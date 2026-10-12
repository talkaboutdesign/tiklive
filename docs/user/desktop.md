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

## Sounds and speech

The app plays action sounds and text-to-speech itself, through your computer's speakers or default audio output.
You don't click anything to enable it, and you don't set anything up in OBS. To hear it on your stream, capture the
computer's audio: with TikTok LIVE Studio or OBS's desktop-audio capture, or by streaming from a phone with the
sound from the room.

- **Header controls:** the dashboard and the Actions page both have them. The speaker button turns sounds and speech
  on or off, and the slider sets the volume. While an action is playing or waiting, a chip shows its name and how
  many are queued. **Skip** stops the action that's playing and moves to the next one. **Clear** drops everything
  waiting and stops what's playing, for when chat spams speech.
- **Sound player offline:** the header shows this when the app's sound player isn't running or can't reach tiklive
  for a few seconds. Restart the app if it stays.
- **OBS:** use the OBS player link from the Actions page. The app plays sounds and speech, so the link leaves them
  out (`sounds=0&speech=0`) and OBS shows only pictures, GIFs, videos and scene switches. To have OBS play sounds and
  speech too, tick **OBS plays sounds and speech too** on the Actions page, and turn off app sound in the header.
- **Closing the window:** on Windows and Linux, closing the window quits the app. On macOS the app keeps running
  after you close the window, so sound keeps playing until you choose **Quit**.
- **Links:** other pages on the tiklive server open in a new tiklive window. Other web links open in your browser.

## Build it yourself

From a checkout, `bun run desktop:dev` builds the client and starts the app. Packaging, signing and the release
flow are in [apps/desktop/README.md](../../apps/desktop/README.md) and [the release runbook](../operations/release.md).
