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

1. When a new version is out, an update button appears at the bottom of the sidebar.
2. Click the button to download the update.
3. When the download finishes, click **Restart to update**.

macOS installs updates only for signed builds. Development builds, from `bun run desktop:dev`, have updates
turned off.

### Stable or nightly

Open **Settings** in the sidebar and pick an **Update channel** under **About**:

- **Stable** (the default) gets tested releases.
- **Nightly** gets a new build a few times a day when there are new changes. Nightlies get new features first and can have bugs.

The app checks the new channel as soon as you switch. Switching from Nightly back to Stable offers the latest
stable release even when it's older than your nightly. A nightly install stays on nightlies until a newer nightly
comes out, even after the stable release of the same version. Switch to Stable to get it.

## Dashboard

The dashboard is the view to keep open while you're live. It shows who's live and the room's numbers at the top,
your chat in the middle, and gifts on the right. Likes, joins and other noise stay out of it.

- **Filters** (above the chat): show everyone, only followers, or only friends (people you follow back). The
  Filters button opens the rest: hide strangers with fewer than a set number of followers, hide messages with
  certain words, show gifts and follows in the chat, and the Silenced list. Moderators and your own messages always show. Gifts and new subscribers stand out in the chat, and
  follows can be turned on.
- **Gifts** (right column): the latest gifts, newest first, your top gifters, and the coins so far. Big gifts are
  highlighted.
- **Silence** (the eye button on a message): hides that person in tiklive only. They can still chat on TikTok, and
  everyone else still sees their messages. Undo it from the Silenced list under Filters.
- **Preview** (the video button, top right): plays your stream the way viewers see it, a few seconds behind. It's
  muted until you turn the sound on.

tiklive doesn't log in to TikTok, so it can't delete comments or block people. Do that in TikTok LIVE Studio or the
TikTok app, or ask a moderator.

## Using it with OBS

The app serves the same dashboard and overlays as the command-line server, at http://127.0.0.1:8080/. Use the
URLs in [overlays.md](./overlays.md).

## Sounds and speech

The app plays action sounds and text-to-speech itself, through your computer's speakers or default audio output.
You don't click anything to enable it, and you don't set anything up in OBS. To hear it on your stream, capture the
computer's audio: with TikTok LIVE Studio or OBS's desktop-audio capture, or by streaming from a phone with the
sound from the room.

- **Sidebar controls:** the bottom of the sidebar has them on every page, and **Settings → Sounds** has the same
  controls. The switch turns sounds and speech on or off, and the slider sets the volume. While an action is playing or waiting, a chip shows its name and how
  many are queued. **Skip** stops the action that's playing and moves to the next one. **Clear** drops everything
  waiting and stops what's playing, for when chat spams speech.
- **Sound player offline:** the sidebar shows this when the app's sound player isn't running or can't reach tiklive
  for a few seconds. Restart the app if it stays.
- **OBS:** use the Actions player link from **Overlays**. The app plays sounds and speech, so the link leaves them
  out (`sounds=0&speech=0`) and OBS shows only pictures, GIFs, videos and scene switches. To have OBS play sounds and
  speech too, turn on **OBS plays sounds and speech too** in the Actions player's settings on **Overlays**, and turn off app
  sound in the sidebar.
- **Closing the window:** on Windows and Linux, closing the window quits the app. On macOS the app keeps running
  after you close the window, so sound keeps playing until you choose **Quit**.
- **Links:** other pages on the tiklive server open in a new tiklive window. Other web links open in your browser.

## Build it yourself

From a checkout, `bun run desktop:dev` builds the client and starts the app. Packaging, signing and the release
flow are in [apps/desktop/README.md](../../apps/desktop/README.md) and [the release runbook](../operations/release.md).
