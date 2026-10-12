/**
 * tiklive media helpers: the pure parts of the Media Library page (media.html). Plain ES module, no
 * imports and no DOM, so it can be tested under any runtime. Network calls live in media.html.
 *
 * Exports
 *   MEDIA_TYPES                 Upload content types the server accepts, mapped to their kind.
 *                               Mirrors MEDIA_TYPES in packages/contracts/src/rules.ts.
 *   MAX_MEDIA_BYTES             25 MB, the largest upload.
 *   ACCEPT                      The file input's accept list.
 *   FILTERS                     The tabs: { all, sounds, images, videos } to a kind (or null for all).
 *   kindOf(contentType)         "image" | "video" | "audio", or null when the server won't take it.
 *   fileProblem(file)           An error message for a File the server won't take, or "" when it's fine.
 *   uploadErrorMessage(error)   A short message for an Error thrown by api() during an upload.
 *   cleanName(input)            Trimmed name, at most 100 characters. "" when empty.
 *   nextRecordingName(items)    "Recording 1", "Recording 2", … the first number not in use.
 *   formatSize(bytes)           "512 B", "340 KB", "1.2 MB".
 *   formatDuration(seconds)     "m:ss", e.g. "0:04" or "1:12". "" when not a finite number.
 *   formatDate(ms)              A short date, e.g. "Oct 12, 2026".
 *   usageByUrl(rules)           Map from a media url to how many actions use it. Counts each action once.
 *   usageText(count)            "Used by 3 actions", "Used by 1 action" or "Not used".
 *   deleteWarning(count)        "" when unused, else "Used by 3 actions. They'll stop playing it."
 *   filterItems(items, { filter, query })
 *                               The items for a tab and a search, in their original order.
 */

export const MEDIA_TYPES = Object.freeze({
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
  "audio/mp4": "audio",
});

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export const ACCEPT = Object.keys(MEDIA_TYPES).join(",");

export const FILTERS = Object.freeze({
  all: null,
  sounds: "audio",
  images: "image",
  videos: "video",
});

const MAX_NAME = 100;

export function kindOf(contentType) {
  return Object.hasOwn(MEDIA_TYPES, contentType) ? MEDIA_TYPES[contentType] : null;
}

export function fileProblem(file) {
  if (!kindOf(file.type))
    return `${file.name} is not a type tiklive can use. Try PNG, JPEG, GIF, WebP, MP4, WebM, MP3, WAV, OGG or M4A.`;
  if (file.size > MAX_MEDIA_BYTES) return `${file.name} is over 25 MB.`;
  return "";
}

export function uploadErrorMessage(error) {
  if (error?.status === 413) return "File is over 25 MB.";
  if (error?.status === 415) return "That file type isn't supported.";
  return error?.message || "Upload failed.";
}

export function cleanName(input) {
  return String(input ?? "")
    .trim()
    .slice(0, MAX_NAME);
}

export function nextRecordingName(items) {
  const taken = new Set();
  for (const item of items) {
    const match = /^Recording (\d+)(\.wav)?$/i.exec(item.name);
    if (match) taken.add(Number(match[1]));
  }
  let n = 1;
  while (taken.has(n)) n += 1;
  return `Recording ${n}`;
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.floor(seconds);
  const s = String(whole % 60).padStart(2, "0");
  return `${Math.floor(whole / 60)}:${s}`;
}

export function formatDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function usageByUrl(rules) {
  const counts = new Map();
  for (const rule of rules ?? []) {
    const urls = new Set();
    for (const step of rule.steps ?? []) {
      if ((step.kind === "sound" || step.kind === "media") && typeof step.url === "string")
        urls.add(step.url);
    }
    for (const url of urls) counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return counts;
}

export function usageText(count) {
  if (!count) return "Not used";
  return count === 1 ? "Used by 1 action" : `Used by ${count} actions`;
}

export function deleteWarning(count) {
  if (!count) return "";
  return `${usageText(count)}. They'll stop playing it.`;
}

export function filterItems(items, { filter = "all", query = "" } = {}) {
  const kind = FILTERS[filter] ?? null;
  const needle = String(query).trim().toLowerCase();
  return items.filter(
    (item) =>
      (kind === null || item.kind === kind) && (needle === "" || item.name.toLowerCase().includes(needle)),
  );
}
