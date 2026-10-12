# Actions

Actions are rules for your stream. "When someone sends a Rose, play a sound, show a GIF and say thanks."
You make them on the **Actions** page (`/actions.html`), and the **actions player** in OBS runs them on
your stream.

The page is linked from the sidebar. Open it with `?token=` if the server runs with `--token`, the same as the
dashboard.

## 1. Add the player to OBS

The player's URL and setup steps are on the **Overlays** page, in the **Actions player** section (sidebar →
**Overlays**, or `/overlays.html#actions`). In short:

1. In OBS, add a **Browser Source** and paste the URL. Set the size to 1920×1080.
2. With the command line, tick **Control audio via OBS**, so sounds and speech go through OBS's mixer. Leave it off
   in the desktop app, which plays sounds and speech itself; its URL leaves them out.
3. For scene switching, set the source's **Page permissions** to **Advanced access to OBS**.

The player is invisible until an action plays. In the desktop app, the sidebar has the sound controls: a switch to
turn sounds and speech on or off, a volume slider, what's playing and how many are waiting, and **Skip** and
**Clear**. The line under **Actions** on this page links to the player's setup on the
[Overlays](./overlays.md) page.

## 2. Create an action

Click **New action**. Each action has a name, a trigger (**When…**), one or more steps (**Then…**) and
optional cooldowns. If you leave the name empty, tiklive names it from the trigger and steps, for example
"When someone sends Rose (100+ coins) → Sound · Speak".

### Start from a preset

Presets are one-click starting points. Each one fills in a complete action.

- **On a new action.** Click **New action**, then pick a preset under **Start from a preset**. It fills in the
  name, trigger, steps and cooldowns. Change anything you like, then **Save**. Picking another preset replaces
  what you've entered, after asking first.
- **From the empty list.** When there are no actions yet, the page shows the presets as cards. Clicking one saves
  it straight away, then opens it in the editor so you can change it. Once you have actions, a **Start from a
  preset** line sits under the list.

| Preset                               | Trigger                                             | Step                                                                  |
| ------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- |
| Read chat aloud — friends only       | Any chat message, from friends                      | Say "{nickname} says {comment}", 10 s per-viewer cooldown             |
| Read chat aloud — followers, no spam | Any chat message, from followers with 50+ followers | Say "{nickname} says {comment}", 15 s per-viewer cooldown             |
| Welcome friends                      | Join, from friends, once per stream                 | Say "Welcome back {nickname}!"                                        |
| Thank gifters                        | Gift, at least 1 coin                               | Say "Thank you {nickname} for {count} {giftName}!"                    |
| Celebrate big gifts                  | Gift, at least 100 coins                            | Say "Wow, {nickname} sent {giftName}!"                                |
| New follower                         | Follow                                              | Say "Thanks for the follow, {nickname}!"                              |
| Answer !points                       | Chat command `!points`                              | Say "{nickname}, you have {points} points!", 30 s per-viewer cooldown |
| !hello chat command                  | Chat command `!hello`                               | Say "Hello {nickname}!", 30 s per-viewer cooldown                     |
| Every 1,000 likes                    | Likes, every 1000                                   | Say "We just hit {likes} likes!"                                      |

### Triggers

- **Gift.** Fires when a gift combo ends, once per combo, with the final total. Pick **Any gift**, or
  **A specific gift** from TikTok's gift list. **Minimum coins for the combo** skips small combos.
  **Repeat for each gift in a combo** runs the steps once per gift, up to 10 times, instead of once per combo.
- **Follow**, **Share** and **Subscribe.** Fire once for each event. No options.
- **Chat.** Matches chat messages. **Command** matches the first word, ignoring case, so `!dance` matches
  "!dance now". **Contains text** matches anywhere in the message. **Any message** fires on every message.
  **From** limits it to who may trigger it (see [Who may trigger](#who-may-trigger)).
- **Join.** Fires when a viewer joins the stream. **From** and **Minimum followers** work as on chat. By default
  each viewer triggers it once per stream. Turn off **Once per viewer per stream** to run it every time someone
  joins. See [Once per stream](#once-per-stream) for when the list resets.
- **Likes.** Fires each time the stream's like count passes another multiple of the number you enter, so
  "every 1000" fires at 1,000, 2,000 and so on.

### Who may trigger

Chat and join triggers have a **From** setting and a **Minimum followers** setting.

- **Everyone.** The default.
- **Followers.** Viewers who follow you. Friends are included.
- **Friends.** Viewers who follow you and whom you follow back (a mutual follow). Use this for a welcome or a
  "friends only" chat line.
- **Subscribers** and **Moderators.** As on TikTok.
- **Minimum followers** skips viewers with fewer followers than the number you enter. It's for stopping throwaway
  accounts from spamming your overlay. Followers and friends of yours always pass, whatever their count. So does a
  viewer whose follower count TikTok doesn't send.

### Once per stream

A join trigger with **Once per viewer per stream** on (the default) fires at most once for each viewer while the
stream runs. tiklive remembers who has fired in memory. The list clears when TikTok reports that the stream has
ended, so the same viewer fires again the next time you go live. A brief connection drop doesn't clear it. Restarting
tiklive does, because the list isn't saved to disk.

Each join action keeps its own list, so two welcome actions can both greet the same viewer.

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
- **Webhook.** Sends an HTTP request to another app or device when the action runs. See
  [Webhook steps](#webhook-steps) below.

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

| Placeholder   | Filled with                                                                  | Offered for   |
| ------------- | ---------------------------------------------------------------------------- | ------------- |
| `{nickname}`  | The viewer's display name                                                    | Every trigger |
| `{username}`  | The viewer's TikTok username                                                 | Every trigger |
| `{giftName}`  | The gift's name                                                              | Gift          |
| `{count}`     | How many of the gift were sent in the combo                                  | Gift          |
| `{coins}`     | The combo's total coins                                                      | Gift          |
| `{comment}`   | The chat message                                                             | Chat          |
| `{likes}`     | The like count, such as 1000                                                 | Likes         |
| `{months}`    | The subscriber's month count                                                 | Subscribe     |
| `{followers}` | The viewer's follower count, such as 1200. Empty when TikTok doesn't send it | Every trigger |
| `{points}`    | The viewer's [points](./points.md), including what this event just earned    | Every trigger |

For example, a chat rule for the command `!points` that says "{nickname}, you have {points} points!" answers
viewers who ask. tiklive can't post in TikTok's chat, so the answer is spoken or shown on stream.

### Webhook steps

A **Webhook** step sends an HTTP request when the action runs. Use it to start something outside tiklive:
Streamer.bot, a Minecraft plugin, Home Assistant or Zapier.

- **Address.** An `http://` or `https://` address. Placeholders work in the path and the query, such as
  `?viewer={nickname}`. Their values are percent-encoded, so a name with spaces or `&` stays in its own value.
  Use placeholders in the path or query, not in the host.
- **Method.** `POST` (the default), `PUT` or `GET`.
- **Body.** For `POST` and `PUT` only. Leave it empty to send a JSON description of the action: the rule's
  `id` and `name`, the event type, the viewer (`userId`, `uniqueId`, `nickname`), every placeholder's value under
  `vars`, and a `timestamp`. If you type a body, it's sent with its placeholders filled in, up to 4,000
  characters. It's sent as JSON when it's a JSON object or array with placeholders in place of values, inside
  quotes or bare as whole values. Partial values such as `[1{comment}]` are plain text. Values in a JSON body
  are escaped, so a viewer's name or comment can't change its fields, and placeholders in key names aren't filled.
  A placeholder outside quotes becomes a number when its value is one, and a quoted string otherwise. Any
  other body is plain text, sent exactly as you wrote it with
  values inserted as-is. A body with no placeholders is sent as JSON if it parses.

The request comes from the computer running tiklive, not from OBS or the browser. So a LAN address such as
`http://192.168.1.20:8080/...` works, and `127.0.0.1` means the computer running tiklive. A webhook step can
run next to the other steps; if it fails or takes longer than 5 seconds, the rest of the action still plays.
tiklive doesn't retry, and it writes a warning to the server log. At most four requests run at once.

**Home Assistant.** Create an automation that starts from the **Webhook** trigger, with the webhook ID
`tiklive-gift`. Then set the step to:

- Address: `http://homeassistant.local:8123/api/webhook/tiklive-gift`
- Method: `POST`
- Body: `{"viewer": "{nickname}", "gift": "{giftName}", "count": "{count}"}`

Home Assistant webhooks don't need a login, so anyone on your network who knows the ID can trigger them. Pick
an ID that's hard to guess.

**Streamer.bot.** Turn on Streamer.bot's HTTP server (its default port is 7474) and send a `POST` to its
`/DoAction` endpoint, with the body in the format Streamer.bot's HTTP documentation gives for the action you
want to run. Check that documentation for the exact fields, since they depend on your version.

Rules are stored on this computer, and the address and body are saved with them.

### Cooldowns

- **Cooldown** stops the action firing again for anyone for that many seconds. Use it so a busy gift
  stream doesn't flood the overlay.
- **Per-viewer cooldown** stops the same viewer triggering it again for that many seconds. Use it for chat
  commands, so one person can't spam `!hello`.

Both are optional. Leave them empty for none.

### Turning an action off

Use the switch on the action's row. Switching saves straight away, and an action that's off is dimmed in the list.

Click an action's name to edit it. The **⋯** menu on each row has **Test**, **Edit**, **Duplicate** and **Delete**.

## 3. Test it

- **Test**, in an action's **⋯** menu, sends a fake firing to the player in OBS. The page shows "Sent to the player".
  The Activity list on the page shows the firing with a **test** badge. This needs your stream session to
  be running, which the Actions page keeps open for you while it's loaded. Webhook steps send their requests
  too, so you can check a webhook with a real call. The sample viewer is "Test User".
- The test buttons on the dashboard also trigger your actions.

If nothing plays, check that the player is in OBS and that its source is visible, and that you're on the
right username.

## Text-to-speech

Speech depends on the voices and speech engine of the computer that plays it: the desktop app's computer, or the
one running OBS with the command-line server. With the command line, if speech is silent in OBS, open the player in
a normal browser tab with `&visuals=0&obs=0` added to its URL, for example
`http://127.0.0.1:8080/overlays/actions.html?username=yourname&visuals=0&obs=0`. If speech plays in that tab, the
problem is OBS's audio or browser source, not tiklive.

## Where rules and uploads are stored

- **Desktop app.** Rules are kept in the app's data folder, and uploaded sounds and media in its `media` folder:
  `~/Library/Application Support/tiklive/media` on macOS, and `%APPDATA%\tiklive\media` on Windows.
- **Command line.** They're kept in `~/.tiklive`, or in the folder you give with `--data-dir <dir>` (or the
  `TIKLIVE_DATA_DIR` environment variable). Uploads and sounds go in its `media` folder. See
  [Run the server](./server.md).

Uploads need a data folder. Without one, the server turns uploads off and the library says so.

Uploads, pasted links and imported sounds are listed in the **Media library** at the bottom of the Actions page.
It's collapsed until you open it. The **Media** page in the sidebar shows the whole library: play, rename and delete
files, upload by dropping them on the page, and see how many actions use each one. On **All** and **Sounds**, its
search box works like the sound picker's: typing filters your files, and Enter also searches MyInstants. **Add**
copies a result into your library.

### Record a sound

On the Media page, click **New sound**, then record up to 30 seconds from your microphone. Drag the Start and End
sliders to trim it, play it back, name it and save. It's saved as a WAV file and shows up with your other sounds in
Actions. The first time, the desktop app asks for microphone access. If you said no, turn it on in System Settings
→ Privacy & Security → Microphone (macOS), or Settings → Privacy → Microphone (Windows).

## Limits

- Uploads are up to 25 MB each.
- Images: PNG, JPG, GIF, WebP. Video: MP4, WebM. Sound: MP3, WAV, OGG, M4A. SVG and other types aren't allowed.
- A rule can have up to 10 steps, and the server keeps up to 200 rules.
- A webhook's address is up to 2,048 characters and its body up to 4,000. Each request times out after 5 seconds.
- Step times: media stays on screen for up to 120 seconds. A scene switch can revert after up to an hour.
- A step can also use a link to a file on the web (http or https) instead of an upload. The file has to stay
  online for the action to keep working.
