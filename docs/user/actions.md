# Actions

Actions are rules for your stream. "When someone sends a Rose, play a sound, show a GIF and say thanks."
You make them on the **Actions** page (`/actions.html`), and the **actions player** in OBS runs them on
your stream.

The page is linked from the dashboard header. Open it with `?token=` if the server runs with `--token`,
the same as the dashboard.

## 1. Add the player to OBS

The Actions page shows the player's URL at the top. To add it:

1. In OBS, add a **Browser Source** and paste the URL. Set the size to 1920×1080.
2. Tick **Control audio via OBS**, so sounds and speech go through OBS's mixer.
3. For scene switching, set the source's **Page permissions** to **Advanced access to OBS**.

The player is invisible until an action plays. Setup details are in the
[Actions player section of Overlays](./overlays.md#actions-player-overlaysactionshtml).

## 2. Create an action

Click **New action**. Each action has a name, a trigger (**When…**), one or more steps (**Then…**) and
optional cooldowns. If you leave the name empty, tiklive names it from the trigger and steps, for example
"When someone sends Rose (100+ coins) → Sound · Speak".

Or start from a template. Templates are saved straight away, then open in the editor so you can change them:

| Template                     | Trigger                  | Step                                                 |
| ---------------------------- | ------------------------ | ---------------------------------------------------- |
| Thank new followers out loud | Follow                   | Say "Thanks for the follow, {nickname}!"             |
| Celebrate big gifts          | Gift, at least 100 coins | Say "{nickname} sent {count} {giftName}! Thank you!" |
| !hello chat command          | Chat command `!hello`    | Say "Hello {nickname}!", 30 s per-viewer cooldown    |
| Every 1,000 likes            | Likes, every 1000        | Say "We just hit {likes} likes!"                     |

### Triggers

- **Gift.** Fires when a gift combo ends, once per combo, with the final total. Pick **Any gift**, or
  **A specific gift** from TikTok's gift list. **Minimum coins for the combo** skips small combos.
  **Repeat for each gift in a combo** runs the steps once per gift, up to 10 times, instead of once per combo.
- **Follow**, **Share** and **Subscribe.** Fire once for each event. No options.
- **Chat.** Matches chat messages. **Command** matches the first word, ignoring case, so `!dance` matches
  "!dance now". **Contains text** matches anywhere in the message. **Any message** fires on every message.
  **From** limits it to everyone, followers, subscribers or moderators.
- **Likes.** Fires each time the stream's like count passes another multiple of the number you enter, so
  "every 1000" fires at 1,000, 2,000 and so on.

### Steps

An action can have up to 10 steps. They run together, in the order shown. The player works through actions
from a queue, one after another.

- **Play sound.** Pick a sound and set the volume. Find it with the sound picker described below.
- **Show image or video.** Pick an image (PNG, JPG, GIF, WebP) or a video (MP4, WebM). Set how long it stays
  on screen, in seconds. Leave it empty to show an image for 5 seconds, or a video for its full length. Add a
  caption if you want. The volume only appears for videos.
- **Say something.** Type what to say, then speak it with **Preview**. Use the variable buttons to insert
  placeholders. The list depends on the trigger (see below). Choose a voice from the ones on your computer,
  and a speed.
- **Switch OBS scene.** Enter the scene name. Set **Switch back after** a number of seconds to return to the
  previous scene, or leave it empty to stay. This needs the Page permissions from step 1.

### Pick a sound

A **Play sound** step opens its picker with the search box focused. The picker is one panel, top to bottom:

- **Search box.** Type to filter your saved sounds as you type. Press Enter, or **Search**, to also search
  [MyInstants](https://www.myinstants.com). Until you search, the MyInstants part offers suggestions such as
  "airhorn" and "applause".
- **Your sounds.** Your saved sounds, newest first. **▶** plays one in the editor (press it again to stop),
  **Use** selects it for the step, and **Delete** removes it from your library. The sound the step already uses
  shows "✓ Selected".
- **From MyInstants.** Results from the search. **▶** plays a result, **↗** opens its page on MyInstants, and
  **Use** copies it into your saved sounds and selects it for the step. The copy stays in your library, so the
  action keeps working if the sound is removed from MyInstants. OBS never loads sounds from MyInstants. Using a
  sound needs a data folder, the same as uploads (see below).

Searching sends your search text to myinstants.com. Previews and **Use** download the sound from there, and
nothing else is sent. Sounds on MyInstants are uploaded by its users. Make sure you're allowed to use a sound
on your stream.

At the bottom, **Upload a file** adds an MP3, WAV, OGG or M4A from your computer, and **Paste a link** uses a
sound at an http or https address. You can also drop a file onto the panel to upload it.

Once a step has a sound, the step shows its name with **Change**, which opens the picker again.

### Placeholders for "Say something" and captions

These are filled in when the action fires. Anything else you type is left as it is.

| Placeholder  | Filled with                                 | Offered for   |
| ------------ | ------------------------------------------- | ------------- |
| `{nickname}` | The viewer's display name                   | Every trigger |
| `{username}` | The viewer's TikTok username                | Every trigger |
| `{giftName}` | The gift's name                             | Gift          |
| `{count}`    | How many of the gift were sent in the combo | Gift          |
| `{coins}`    | The combo's total coins                     | Gift          |
| `{comment}`  | The chat message                            | Chat          |
| `{likes}`    | The like count, such as 1000                | Likes         |
| `{months}`   | The subscriber's month count                | Subscribe     |

### Cooldowns

- **Cooldown** stops the action firing again for anyone for that many seconds. Use it so a busy gift
  stream doesn't flood the overlay.
- **Per-viewer cooldown** stops the same viewer triggering it again for that many seconds. Use it for chat
  commands, so one person can't spam `!hello`.

Both are optional. Leave them empty for none.

### Turning an action off

Use the switch on the action's row. Switching saves straight away, and an action that's off is dimmed in the list.

## 3. Test it

- **Test** on an action's row sends a fake firing to the player in OBS. The page shows "Sent to the player".
  The Activity list on the page shows the firing with a **test** badge. This needs your stream session to
  be running, which the Actions page keeps open for you while it's loaded.
- The test buttons on the dashboard also trigger your actions.

If nothing plays, check that the player is in OBS and that its source is visible, and that you're on the
right username.

## Text-to-speech

Speech depends on the voices and speech engine of the computer running OBS. If speech is silent in OBS,
open the player in a normal browser tab with `&visuals=0&obs=0` added to its URL, for example
`http://127.0.0.1:8080/overlays/actions.html?username=yourname&visuals=0&obs=0`. If speech plays in that tab,
the problem is OBS's audio or browser source, not tiklive.

## Where rules and uploads are stored

- **Desktop app.** Rules are kept in the app's data folder, and uploaded sounds and media in its `media` folder:
  `~/Library/Application Support/tiklive/media` on macOS, and `%APPDATA%\tiklive\media` on Windows.
- **Command line.** They're kept in `~/.tiklive`, or in the folder you give with `--data-dir <dir>` (or the
  `TIKLIVE_DATA_DIR` environment variable). Uploads and sounds go in its `media` folder. See
  [Run the server](./server.md).

Uploads need a data folder. Without one, the server turns uploads off and the library says so.

## Limits

- Uploads are up to 25 MB each.
- Images: PNG, JPG, GIF, WebP. Video: MP4, WebM. Sound: MP3, WAV, OGG, M4A. SVG and other types aren't allowed.
- A rule can have up to 10 steps, and the server keeps up to 200 rules.
- Step times: media stays on screen for up to 120 seconds. A scene switch can revert after up to an hour.
- A step can also use a link to a file on the web (http or https) instead of an upload. The file has to stay
  online for the action to keep working.
