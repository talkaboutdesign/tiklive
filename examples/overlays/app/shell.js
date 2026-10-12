/**
 * tiklive app shell: the shared module for the dashboard, actions and settings pages.
 * Plain ES module, no build step. Styles are in ./app.css.
 *
 * ## Page setup
 *
 * Put this in <head>, before the stylesheet, so the saved theme applies with no flash:
 *
 *   <script>try{var t=localStorage.getItem("tiklive.theme");document.documentElement.dataset.theme=t==="light"||t==="dark"?t:"system"}catch{}</script>
 *   <link rel="stylesheet" href="/app/app.css" />
 *
 * (The same text is exported as THEME_SNIPPET.) Then, in <body>, this skeleton:
 *
 *   <div class="app">
 *     <aside id="sidebar"></aside>
 *     <main id="main">
 *       <header id="page-header"></header>
 *       <div class="page" id="page">…page content…</div>
 *     </main>
 *   </div>
 *
 * and a module script:
 *
 *   <script type="module">
 *     import { mountShell } from "/app/shell.js";
 *     mountShell({ page: "settings", crumbs: ["Settings"] });
 *   </script>
 *
 * ## Exports
 *
 * Constants
 *   USERNAME              RegExp for a valid TikTok username (copied from the dashboard).
 *   INVALID_USERNAME      The message shown for an invalid username.
 *   NAV                   The sidebar's nav items: { id, label, href, icon }.
 *   THEME_SNIPPET         The head script above, as a string.
 *   token                 The page's ?token= value, or "".
 *   isDesktop             True inside the desktop app (window.tikliveDesktop exists).
 *
 * DOM helpers
 *   el(tag, props, ...children)   Builds an element. Strings become text nodes, never HTML.
 *                                 props: attributes; class; null/undefined/false are skipped.
 *   img(src, props)               An <img> for a safe http(s) URL, or null. Hides itself on error.
 *   safeUrl(u)                    The absolute http(s) URL for u (relative to this page), or "".
 *   avatar(url, name, size)       Profile picture over a letter. size: "" | "sm" | "lg".
 *   pill(state)                   Status pill. state: live | waiting | connecting | error | idle.
 *   icon(name, size)              Inline SVG: dashboard | actions | overlays | settings | speaker |
 *                                 speakerOff | menu | external | video | filters | silence | volume | muted |
 *                                 mod | friend | gift | arrowDown | close | retry | media | mic | stop | play |
 *                                 pause | upload | pencil | trash.
 *   debounce(fn, ms)              Delayed call. Has .cancel().
 *   toast(message, { error })     Shows a short notice at the bottom. Auto-hides after 3 s.
 *
 * Network
 *   api(path, { method, json, body, headers })
 *                                 fetch with the Bearer token. json is sent as JSON, and the
 *                                 response is parsed as JSON (null when empty). Non-2xx throws an
 *                                 Error with the server's message, plus .status and .data.
 *   errorMessage(res)             The message text from a failed fetch Response (async).
 *   withToken(path)               Appends ?token= or &token= when a token is set.
 *
 * Username
 *   normalizeUsername(input)      Trims, strips @ and tiktok.com/@ links, lowercases.
 *   getUsername()                 ?username= first, then the saved name. Normalized and valid, or "".
 *   saveUsername(input)           Validates and saves the name, and removes ?username= from the
 *                                 address bar. Returns the normalized name. Throws Error with
 *                                 INVALID_USERNAME when invalid. Updates the sidebar and all
 *                                 other open tabs.
 *   onUsernameChange(cb)          Calls cb(newName) when the username changes in this window or
 *                                 another. Returns an unsubscribe function.
 *
 * Connection status (one shared status socket per page, opened by the shell)
 *   onStatus(cb)                  Calls cb(status) now and on each change. status is a
 *                                 SessionStatus, or null when there's no username. Returns an
 *                                 unsubscribe function.
 *   describeStatus(status)        Short text: "Live · 1,234 viewers", "Offline — waiting",
 *                                 "Connecting…", "Error", "Not connected".
 *   onHello(cb)                   Calls cb(hello) when the server greets us. hello.serverVersion is
 *                                 the server version. Called now if already known. Returns an unsubscribe.
 *
 * Theme
 *   getTheme()                    "system" | "light" | "dark" (default "system").
 *   setTheme(theme)               Saves and applies the theme at once. Throws on an unknown value.
 *
 * Desktop app only (these do nothing useful in a browser; the player runs in the desktop app)
 *   getAppAudio()                 { enabled, volume } (volume 0–1). Saved in localStorage.
 *   setAppAudio(patch)            Saves { enabled?, volume? } and notifies onAppAudio listeners.
 *   onAppAudio(cb)                Calls cb({ enabled, volume }) now and on change. Returns an unsubscribe.
 *   onPlayer(cb)                  Calls cb(view) now and on change. view = { offline, connected,
 *                                 playing (rule name or null), queued (count) }. offline is true
 *                                 when the player has been silent for 5 s.
 *   playerCommand("skip" | "clear")
 *                                 Skips the current action, or clears the queue.
 *
 * Window
 *   mountShell({ page, crumbs, actions })
 *                                 page: "dashboard" | "actions" | "media" | "overlays" | "settings" (marks the
 *                                 nav item). crumbs: string[] for the breadcrumb. actions: Node[]
 *                                 for the header's right side. Fills #sidebar and #page-header.
 *                                 Adds html.desktop-mac on macOS. Returns { setCrumbs(crumbs), setActions(nodes) }.
 *
 * Sidebar (filled by mountShell): brand; account block (links to Settings, or to / when no name);
 * nav; spacer; desktop only: the sound player controls and the "Update" button.
 */
import { TikLive } from "/tiklive.js";

export const USERNAME = /^[a-z0-9._]{1,32}$/;
export const INVALID_USERNAME =
  "That doesn't look like a TikTok username. Use letters, numbers, dots and underscores.";

export const NAV = Object.freeze([
  { id: "dashboard", label: "Dashboard", href: "/", icon: "dashboard" },
  { id: "actions", label: "Actions", href: "/actions.html", icon: "actions" },
  { id: "media", label: "Media", href: "/media.html", icon: "media" },
  { id: "overlays", label: "Overlays", href: "/overlays.html", icon: "overlays" },
  { id: "settings", label: "Settings", href: "/settings.html", icon: "settings" },
]);

export const THEME_SNIPPET =
  '<script>try{var t=localStorage.getItem("tiklive.theme");document.documentElement.dataset.theme=t==="light"||t==="dark"?t:"system"}catch{}</script>';

const USERNAME_KEY = "tiklive.username";
const THEME_KEY = "tiklive.theme";
const APP_AUDIO_KEY = "tiklive.appAudio";
const THEMES = ["system", "light", "dark"];
const PLAYER_OFFLINE_MS = 5000;
const PLAYER_POLL_MS = 1000;
const SVG_NS = "http://www.w3.org/2000/svg";

export const token = new URLSearchParams(location.search).get("token") ?? "";
export const isDesktop = Boolean(window.tikliveDesktop);

// ---------- Storage (falls back to memory when localStorage is unavailable) ----------

const memory = new Map();
function readStore(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}
function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    memory.set(key, value);
  }
}

// ---------- Small helpers ----------

// Mirrors normalizeUsername() in packages/contracts/src/protocol.ts.
export function normalizeUsername(input) {
  const trimmed = String(input ?? "").trim();
  const fromUrl = trimmed.match(/tiktok\.com\/@([^/?#]+)/i);
  return (fromUrl?.[1] ?? trimmed).replace(/^@/, "").toLowerCase();
}

// Only http(s) URLs may reach an <img>. Anything else gives "".
export function safeUrl(u) {
  try {
    const url = new URL(String(u ?? ""), location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

// Small DOM builder: strings become text nodes, so nothing is parsed as HTML.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.filter((c) => c !== undefined && c !== null && c !== false));
  return node;
}

export function img(src, props = {}) {
  const url = safeUrl(src);
  if (!url) return null;
  const node = el("img", { ...props, src: url, referrerpolicy: "no-referrer" });
  node.addEventListener("error", () => {
    node.style.visibility = "hidden";
  });
  return node;
}

// A profile picture when there is one, otherwise a circle with the first letter of the name.
export function avatar(url, name, size = "") {
  const letter = (name || "?").charAt(0).toUpperCase();
  return el("span", { class: `avatar ${size}`.trim(), "aria-hidden": "true" }, letter, img(url, { alt: "" }));
}

const PILL_LABELS = {
  live: "Live",
  waiting: "Offline",
  connecting: "Connecting",
  error: "Error",
  idle: "Idle",
};
export function pill(state) {
  const key = PILL_LABELS[state] ? state : "idle";
  return el("span", { class: `pill ${key}` }, PILL_LABELS[key]);
}

const SVG_ICONS = {
  dashboard: [
    ["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }],
    ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }],
  ],
  actions: [["path", { d: "M13 2 4 14h7l-1 8 9-12h-7l1-8z" }]],
  overlays: [
    ["rect", { x: 2, y: 3, width: 20, height: 14, rx: 2 }],
    ["path", { d: "M8 21h8M12 17v4" }],
  ],
  settings: [
    ["path", { d: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" }],
    ["circle", { cx: 15, cy: 6, r: 2 }],
    ["circle", { cx: 9, cy: 12, r: 2 }],
    ["circle", { cx: 17, cy: 18, r: 2 }],
  ],
  speaker: [
    ["path", { d: "M11 5 6 9H3v6h3l5 4z" }],
    ["path", { d: "M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" }],
  ],
  speakerOff: [
    ["path", { d: "M11 5 6 9H3v6h3l5 4z" }],
    ["path", { d: "m16 9 6 6m0-6-6 6" }],
  ],
  menu: [["path", { d: "M4 6h16M4 12h16M4 18h16" }]],
  external: [["path", { d: "M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" }]],
  // From Lucide (ISC license), https://lucide.dev
  video: [
    ["path", { d: "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" }],
    ["rect", { x: 2, y: 6, width: 14, height: 12, rx: 2 }],
  ],
  filters: [
    ["path", { d: "M10 5H3" }],
    ["path", { d: "M12 19H3" }],
    ["path", { d: "M14 3v4" }],
    ["path", { d: "M16 17v4" }],
    ["path", { d: "M21 12h-9" }],
    ["path", { d: "M21 19h-5" }],
    ["path", { d: "M21 5h-7" }],
    ["path", { d: "M8 10v4" }],
    ["path", { d: "M8 12H3" }],
  ],
  silence: [
    [
      "path",
      { d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" },
    ],
    ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242" }],
    [
      "path",
      { d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" },
    ],
    ["path", { d: "m2 2 20 20" }],
  ],
  volume: [
    [
      "path",
      {
        d: "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
      },
    ],
    ["path", { d: "M16 9a5 5 0 0 1 0 6" }],
    ["path", { d: "M19.364 18.364a9 9 0 0 0 0-12.728" }],
  ],
  muted: [
    [
      "path",
      {
        d: "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z",
      },
    ],
    ["line", { x1: 22, x2: 16, y1: 9, y2: 15 }],
    ["line", { x1: 16, x2: 22, y1: 9, y2: 15 }],
  ],
  mod: [
    [
      "path",
      {
        d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
      },
    ],
  ],
  friend: [
    [
      "path",
      {
        d: "M19.414 14.414C21 12.828 22 11.5 22 9.5a5.5 5.5 0 0 0-9.591-3.676.6.6 0 0 1-.818.001A5.5 5.5 0 0 0 2 9.5c0 2.3 1.5 4 3 5.5l5.535 5.362a2 2 0 0 0 2.879.052 2.12 2.12 0 0 0-.004-3 2.124 2.124 0 1 0 3-3 2.124 2.124 0 0 0 3.004 0 2 2 0 0 0 0-2.828l-1.881-1.882a2.41 2.41 0 0 0-3.409 0l-1.71 1.71a2 2 0 0 1-2.828 0 2 2 0 0 1 0-2.828l2.823-2.762",
      },
    ],
  ],
  gift: [
    ["rect", { x: 3, y: 8, width: 18, height: 4, rx: 1 }],
    ["path", { d: "M12 8v13" }],
    ["path", { d: "M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" }],
    ["path", { d: "M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" }],
  ],
  arrowDown: [
    ["path", { d: "M12 5v14" }],
    ["path", { d: "m19 12-7 7-7-7" }],
  ],
  close: [
    ["path", { d: "M18 6 6 18" }],
    ["path", { d: "m6 6 12 12" }],
  ],
  retry: [
    ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
    ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
    ["path", { d: "M8 16H3v5" }],
  ],
  // From Lucide (ISC license), https://lucide.dev
  media: [
    ["rect", { width: 8, height: 18, x: 3, y: 3, rx: 1 }],
    ["path", { d: "M7 3v18" }],
    [
      "path",
      {
        d: "M20.4 18.9c.2.5-.1 1.1-.6 1.3l-1.9.7c-.5.2-1.1-.1-1.3-.6L11.1 5.1c-.2-.5.1-1.1.6-1.3l1.9-.7c.5-.2 1.1.1 1.3.6Z",
      },
    ],
  ],
  mic: [
    ["path", { d: "M12 19v3" }],
    ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2" }],
    ["rect", { x: 9, y: 2, width: 6, height: 13, rx: 3 }],
  ],
  stop: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }]],
  play: [
    [
      "path",
      {
        d: "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z",
      },
    ],
  ],
  pause: [
    ["rect", { x: 14, y: 3, width: 5, height: 18, rx: 1 }],
    ["rect", { x: 5, y: 3, width: 5, height: 18, rx: 1 }],
  ],
  upload: [
    ["path", { d: "M12 3v12" }],
    ["path", { d: "m17 8-5-5-5 5" }],
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }],
  ],
  pencil: [
    [
      "path",
      {
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      },
    ],
    ["path", { d: "m15 5 4 4" }],
  ],
  trash: [
    ["path", { d: "M10 11v6" }],
    ["path", { d: "M14 11v6" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
    ["path", { d: "M3 6h18" }],
    ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
  ],
};

// Inline SVG icon, drawn in this file (stroke 2, 24×24 grid).
export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attrs = {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, String(value));
  for (const [tag, shape] of SVG_ICONS[name] ?? []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(shape)) node.setAttribute(key, String(value));
    svg.append(node);
  }
  return svg;
}

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

let toastNode;
let toastTimer;
export function toast(message, { error = false } = {}) {
  if (!toastNode) {
    toastNode = el("div", { role: "status", "aria-live": "polite", hidden: true });
    document.body.append(toastNode);
  }
  toastNode.textContent = message;
  toastNode.className = error ? "toast error" : "toast";
  toastNode.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode.hidden = true;
  }, 3000);
}

// ---------- Network ----------

export function withToken(path) {
  if (!token) return path;
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

// The message from a failed Response: the server's JSON error, or the body text, or the status.
export async function errorMessage(res) {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    return body?.error ?? body?.message ?? (text || `HTTP ${res.status}`);
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

export async function api(path, { method = "GET", json, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data?.error ?? data?.message ?? (text || `HTTP ${res.status}`);
    throw Object.assign(new Error(String(message)), { status: res.status, data });
  }
  return data;
}

// ---------- Username ----------

// ?username= for this page only, then the saved name. Invalid values count as "no name".
export function getUsername() {
  const fromUrl = normalizeUsername(new URLSearchParams(location.search).get("username") ?? "");
  if (USERNAME.test(fromUrl)) return fromUrl;
  const saved = readStore(USERNAME_KEY) ?? "";
  return USERNAME.test(saved) ? saved : "";
}

export function saveUsername(input) {
  const name = normalizeUsername(input);
  if (!USERNAME.test(name)) throw new Error(INVALID_USERNAME);
  writeStore(USERNAME_KEY, name);
  // A ?username= in the address bar would override the saved name, so drop it.
  const url = new URL(location.href);
  if (url.searchParams.has("username")) {
    url.searchParams.delete("username");
    history.replaceState(history.state, "", url);
  }
  window.dispatchEvent(new CustomEvent("tiklive:username", { detail: name }));
  return name;
}

export function onUsernameChange(cb) {
  const onSame = () => cb(getUsername());
  const onStorage = (event) => {
    if (event.key === null || event.key === USERNAME_KEY) cb(getUsername());
  };
  window.addEventListener("tiklive:username", onSame);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("tiklive:username", onSame);
    window.removeEventListener("storage", onStorage);
  };
}

// ---------- Connection status (one socket for the page) ----------

const bus = new EventTarget();
function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}
function subscribe(type, cb, current) {
  const handler = (event) => cb(event.detail);
  bus.addEventListener(type, handler);
  cb(current());
  return () => bus.removeEventListener(type, handler);
}

let currentName = "";
let client = null;
let lastStatus = null;
let lastHello = null;

function setStatus(status) {
  lastStatus = status;
  emit("status", status);
}

function connect(name) {
  client?.close();
  client = null;
  currentName = name;
  if (!name) {
    setStatus(null);
    return;
  }
  const own = new TikLive({ username: name, token, events: [] });
  client = own;
  // Messages from a socket that has since been replaced are ignored.
  const mine = (handler) => (value) => {
    if (own === client) handler(value);
  };
  own.on(
    "status",
    mine((status) => setStatus(status)),
  );
  own.on(
    "hello",
    mine((hello) => {
      lastHello = hello;
      emit("hello", hello);
    }),
  );
  setStatus({ username: name, state: "connecting", stats: {} });
}

function syncUsername() {
  const name = getUsername();
  if (name !== currentName) connect(name);
  renderAccount();
  refreshPlayer();
}

export function describeStatus(status) {
  if (!status) return "Not connected";
  switch (status.state) {
    case "live": {
      const viewers = Number(status.stats?.viewers) || 0;
      return viewers ? `Live · ${viewers.toLocaleString()} viewers` : "Live";
    }
    case "waiting":
      return "Offline — waiting";
    case "connecting":
      return "Connecting…";
    case "error":
      return "Error";
    default:
      return "Not connected";
  }
}

export function onStatus(cb) {
  return subscribe("status", cb, () => lastStatus);
}

export function onHello(cb) {
  const handler = (event) => cb(event.detail);
  bus.addEventListener("hello", handler);
  if (lastHello) cb(lastHello);
  return () => bus.removeEventListener("hello", handler);
}

// ---------- Theme ----------

export function getTheme() {
  const saved = readStore(THEME_KEY);
  return THEMES.includes(saved) ? saved : "system";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme) {
  if (!THEMES.includes(theme)) throw new Error(`Unknown theme: ${theme}`);
  writeStore(THEME_KEY, theme);
  applyTheme(theme);
}

// ---------- Desktop: app sound and the player ----------

const clampVolume = (v) => Math.min(1, Math.max(0, Number(v) || 0));

export function getAppAudio() {
  try {
    const saved = JSON.parse(readStore(APP_AUDIO_KEY) ?? "null");
    return {
      enabled: typeof saved?.enabled === "boolean" ? saved.enabled : true,
      volume: Number.isFinite(saved?.volume) ? clampVolume(saved.volume) : 1,
    };
  } catch {
    return { enabled: true, volume: 1 };
  }
}

export function setAppAudio(patch) {
  const current = getAppAudio();
  const next = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    volume: patch.volume === undefined ? current.volume : clampVolume(patch.volume),
  };
  writeStore(APP_AUDIO_KEY, JSON.stringify(next));
  emit("audio", next);
  return next;
}

export function onAppAudio(cb) {
  return subscribe("audio", cb, getAppAudio);
}

// Player state as the sidebar and settings show it. Recomputed on each poll and each message.
let player = null;
let heardAt = Date.now();
let disconnectedAt = null;
let lastPlayerKey = "";
let channel = null;

function playerView() {
  const now = Date.now();
  const offline =
    currentName !== "" &&
    (now - heardAt > PLAYER_OFFLINE_MS ||
      (disconnectedAt !== null && now - disconnectedAt > PLAYER_OFFLINE_MS));
  return {
    offline,
    connected: !offline && player?.connected === true,
    playing: typeof player?.playing === "string" ? player.playing : null,
    queued: Number(player?.queued) || 0,
  };
}

function refreshPlayer() {
  const view = playerView();
  const key = JSON.stringify(view);
  if (key !== lastPlayerKey) {
    lastPlayerKey = key;
    emit("player", view);
  }
}

export function onPlayer(cb) {
  return subscribe("player", cb, playerView);
}

export function playerCommand(type) {
  if (type !== "skip" && type !== "clear") throw new Error(`Unknown player command: ${type}`);
  channel?.postMessage({ type });
}

// ---------- Desktop: update button (the sidebar's, at the bottom) ----------

// Mirrors actionFor() in apps/desktop/src/updates/updateMachine.ts.
function updateAction(s) {
  if (s.status === "downloaded") return "install";
  if (s.status === "available" || (s.status === "error" && s.errorContext === "download")) return "download";
  return "none";
}

function updateLabel(s) {
  if (s.status === "downloading") return `Downloading… ${Math.round(s.downloadPercent ?? 0)}%`;
  if (s.status === "downloaded") return "Restart to update";
  if (s.status === "available") return `Update to v${s.availableVersion}`;
  return "Retry update";
}

function updateButton() {
  const updates = window.tikliveDesktop.updates;
  const button = el("button", { type: "button", class: "btn btn-primary update", hidden: true });
  let state;

  const render = (s) => {
    state = s;
    const busy = s.status === "downloading";
    button.hidden = updateAction(s) === "none" && !busy;
    button.disabled = busy;
    button.textContent = updateLabel(s);
    button.title = s.status === "error" || s.errorContext === "install" ? (s.message ?? "") : "";
  };

  button.addEventListener("click", async () => {
    const action = state ? updateAction(state) : "none";
    if (action === "download") {
      await updates.download();
    } else if (action === "install") {
      const version = state.availableVersion ?? "";
      if (confirm(`Restart tiklive to install v${version}? Live connections will drop briefly.`)) {
        await updates.install();
      }
    }
  });

  // Subscribe before reading the current state, so no change is missed. A pushed state wins over
  // the getState() snapshot, which may have been taken before it.
  let pushed = false;
  updates.onState((s) => {
    pushed = true;
    render(s);
  });
  updates
    .getState()
    .then((s) => {
      if (!pushed) render(s);
    })
    .catch(() => {});
  return button;
}

// The sidebar's player: sound on/off, volume, what's playing, skip and clear.
function playerPanel() {
  const speaker = el("span", { class: "muted", "aria-hidden": "true" });
  const toggle = el("button", {
    type: "button",
    class: "switch",
    role: "switch",
    "aria-label": "App sound",
    title: "Sounds and speech from the app",
  });
  const volume = el("input", {
    type: "range",
    min: "0",
    max: "100",
    step: "1",
    class: "range",
    "aria-label": "App volume",
  });
  const nowText = el("span", { class: "player-now-text" });
  const skip = el(
    "button",
    { type: "button", class: "btn btn-ghost btn-small", title: "Skip the action that's playing" },
    "Skip",
  );
  const clear = el(
    "button",
    { type: "button", class: "btn btn-ghost btn-small", title: "Drop the queue and stop what's playing" },
    "Clear",
  );
  const now = el(
    "div",
    { class: "player-now", hidden: true },
    nowText,
    el("div", { class: "player-now-actions" }, skip, clear),
  );
  const offline = el("div", { class: "hint", hidden: true }, "Sound player offline");

  const renderAudio = (a) => {
    toggle.setAttribute("aria-checked", String(a.enabled));
    speaker.replaceChildren(icon(a.enabled ? "speaker" : "speakerOff", 16));
    volume.value = String(Math.round(a.volume * 100));
    volume.title = `Volume ${Math.round(a.volume * 100)}%`;
  };
  const renderPlayer = (v) => {
    offline.hidden = !v.offline;
    const busy = !v.offline && Boolean(v.playing || v.queued > 0);
    now.hidden = !busy;
    if (busy) {
      const parts = [v.playing ? `▶ ${v.playing}` : `${v.queued} queued`];
      if (v.playing && v.queued > 0) parts.push(`${v.queued} queued`);
      nowText.textContent = parts.join(" · ");
      skip.disabled = !v.playing;
    }
  };

  toggle.addEventListener("click", () =>
    setAppAudio({ enabled: toggle.getAttribute("aria-checked") !== "true" }),
  );
  volume.addEventListener("input", () => setAppAudio({ volume: Number(volume.value) / 100 }));
  skip.addEventListener("click", () => playerCommand("skip"));
  clear.addEventListener("click", () => playerCommand("clear"));
  onAppAudio(renderAudio);
  onPlayer(renderPlayer);

  return el(
    "section",
    { class: "player", "aria-label": "Sound player" },
    el("div", { class: "player-row" }, speaker, volume, toggle),
    now,
    offline,
  );
}

// ---------- Sidebar and window ----------

let sidebarAccount = null;

function renderAccount() {
  if (!sidebarAccount) return;
  const { link, slot, name, dot, text } = sidebarAccount;
  if (!currentName) {
    link.href = withToken("/");
    slot.replaceChildren(avatar("", ""));
    name.textContent = "Set your TikTok username";
    dot.dataset.state = "idle";
    text.textContent = "Open the dashboard to get started";
    return;
  }
  const owner = lastStatus?.owner;
  link.href = withToken("/settings.html");
  slot.replaceChildren(avatar(owner?.profilePictureUrl, currentName));
  name.textContent = `@${currentName}`;
  dot.dataset.state = lastStatus?.state ?? "connecting";
  text.textContent = describeStatus(lastStatus);
}

function buildSidebar(sidebar, page) {
  const account = {
    link: el("a", { class: "account" }),
    slot: el("span"),
    name: el("span", { class: "account-name" }),
    dot: el("span", { class: "dot", "aria-hidden": "true" }),
    text: el("span"),
  };
  account.link.append(
    account.slot,
    el(
      "span",
      { class: "account-text" },
      account.name,
      el("span", { class: "account-status" }, account.dot, account.text),
    ),
  );
  sidebarAccount = account;

  const nav = el(
    "nav",
    { class: "nav", "aria-label": "Pages" },
    ...NAV.map((item) =>
      el(
        "a",
        {
          class: "nav-link",
          href: withToken(item.href),
          "aria-current": item.id === page ? "page" : false,
        },
        icon(item.icon, 18),
        el("span", {}, item.label),
      ),
    ),
  );

  const parts = [
    el(
      "div",
      { class: "sb-top" },
      el("a", { class: "brand", href: withToken("/") }, "tik", el("span", {}, "live")),
    ),
    account.link,
    nav,
    el("div", { class: "sb-spacer" }),
  ];
  if (isDesktop) {
    parts.push(playerPanel(), updateButton());
  }
  sidebar.replaceChildren(...parts);
  renderAccount();
  onStatus(() => renderAccount());
}

/**
 * Fills #sidebar and #page-header for the page. See the module comment for the expected markup.
 * @returns {{ setCrumbs: (crumbs: string[]) => void, setActions: (nodes: Node[]) => void }}
 */
export function mountShell({ page, crumbs = [], actions = [] } = {}) {
  const sidebar = document.getElementById("sidebar");
  const header = document.getElementById("page-header");
  const main = document.getElementById("main");
  if (!sidebar || !header || !main) {
    throw new Error("mountShell needs #sidebar, #main and #page-header. See app/shell.js.");
  }
  const app = sidebar.closest(".app") ?? document.body;
  if (window.tikliveDesktop?.platform === "darwin") document.documentElement.classList.add("desktop-mac");

  buildSidebar(sidebar, page);

  const crumbList = el("ol", { class: "crumbs" });
  const actionBox = el("div", { class: "page-actions" });
  const scrim = el("div", { class: "scrim", hidden: true });
  const menu = el(
    "button",
    {
      type: "button",
      class: "btn btn-ghost btn-small menu-button",
      "aria-label": "Open menu",
      "aria-expanded": "false",
    },
    icon("menu", 18),
  );
  const setDrawer = (open) => {
    app.classList.toggle("drawer-open", open);
    scrim.hidden = !open;
    menu.setAttribute("aria-expanded", String(open));
  };
  menu.addEventListener("click", () => setDrawer(!app.classList.contains("drawer-open")));
  scrim.addEventListener("click", () => setDrawer(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDrawer(false);
  });
  sidebar.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) setDrawer(false);
  });
  app.append(scrim);

  header.classList.add("page-header");
  header.replaceChildren(menu, el("nav", { "aria-label": "Breadcrumb" }, crumbList), actionBox);
  main.addEventListener("scroll", () => header.toggleAttribute("data-scrolled", main.scrollTop > 0), {
    passive: true,
  });

  const setCrumbs = (list) => {
    crumbList.replaceChildren(
      ...list.map((text, i) => el("li", i === list.length - 1 ? { "aria-current": "page" } : {}, text)),
    );
  };
  const setActions = (nodes) => actionBox.replaceChildren(...nodes);
  setCrumbs(crumbs);
  setActions(actions);
  return { setCrumbs, setActions };
}

// ---------- Module setup (runs once per page) ----------

applyTheme(getTheme());
connect(getUsername());
window.addEventListener("tiklive:username", syncUsername);
window.addEventListener("storage", (event) => {
  if (event.key === null || event.key === USERNAME_KEY) syncUsername();
  if (event.key === null || event.key === THEME_KEY) applyTheme(getTheme());
  if (event.key === null || event.key === APP_AUDIO_KEY) emit("audio", getAppAudio());
});
if (isDesktop) {
  channel = new BroadcastChannel("tiklive-player");
  channel.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type !== "status") return;
    player = message;
    heardAt = Date.now();
    if (message.connected) disconnectedAt = null;
    else disconnectedAt ??= heardAt;
    refreshPlayer();
  });
  // Ask now, then poll. A silent player shows as offline, and a stale status clears.
  channel.postMessage({ type: "status?" });
  setInterval(() => {
    channel.postMessage({ type: "status?" });
    refreshPlayer();
  }, PLAYER_POLL_MS);
}
