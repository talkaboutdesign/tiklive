/**
 * Electron main process. Runs the tiklive server in-process on 127.0.0.1:8080
 * (so OBS browser sources keep working while the app is open) and shows the
 * dashboard it serves in a window.
 */
import * as NodeServer from "tiklive/node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  session,
  shell,
  systemPreferences,
} from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "./ipc.ts";
import { makeQuitHandler } from "./shutdown.ts";
import * as DesktopSettings from "./settings.ts";
import { defaultChannel, isUpdateChannel } from "./updates/channel.ts";
import * as DesktopUpdates from "./updates/DesktopUpdates.ts";
import * as Updater from "./updates/Updater.ts";

const HOST = "127.0.0.1";
const PORT = 8080;
const serverUrl = `http://${HOST}:${PORT}/`;

// Packaged: electron-builder copies these into Resources (see electron-builder.yml).
// Dev: read straight from the repo, relative to apps/desktop.
const repoRoot = join(app.getAppPath(), "..", "..");
const staticDir = app.isPackaged
  ? join(process.resourcesPath, "overlays")
  : join(repoRoot, "examples", "overlays");
const clientBundle = app.isPackaged
  ? join(process.resourcesPath, "tiklive.js")
  : join(repoRoot, "packages", "client", "dist", "tiklive.js");

const serverRuntime = ManagedRuntime.make(
  NodeServer.layer({
    host: HOST,
    port: PORT,
    staticDir,
    dataDir: app.getPath("userData"),
    ...(existsSync(clientBundle) ? { clientBundle } : {}),
  }),
);

const stopServer = Effect.promise(() => serverRuntime.dispose()).pipe(
  Effect.timeout("5 seconds"),
  Effect.ignore,
);

const updatesRuntime = ManagedRuntime.make(
  DesktopUpdates.layer({ beforeInstall: stopServer }).pipe(
    Layer.provide(Updater.electronLayer({ isPackaged: app.isPackaged, currentVersion: app.getVersion() })),
    Layer.provide(
      DesktopSettings.layerFile({
        path: join(app.getPath("userData"), "desktop-settings.json"),
        defaultChannel: defaultChannel(app.getVersion()),
      }),
    ),
  ),
);

const runUpdates = <A, E>(f: (updates: DesktopUpdates.DesktopUpdates["Service"]) => Effect.Effect<A, E>) =>
  updatesRuntime.runPromise(DesktopUpdates.DesktopUpdates.use(f));

let mainWindow: BrowserWindow | undefined;

const isServerUrl = (url: string) => url.startsWith(serverUrl);

// The Actions player in app mode: plays sounds and speech, with no visible UI. See
// examples/overlays/overlays/actions.html. `visuals=0&obs=0` leaves pictures and scene switches to OBS.
const playerUrl = `${serverUrl}overlays/actions.html?app=1&visuals=0&obs=0`;
const PLAYER_RESTART_DELAY_MS = 2_000;
const PLAYER_RESTART_LIMIT = 5;
const PLAYER_RESTART_WINDOW_MS = 10 * 60_000;
let playerWindow: BrowserWindow | undefined;
let quitting = false;
const playerRestarts: Array<number> = [];

// macOS: the native title bar is hidden and the traffic lights sit in the sidebar's top area (see examples/overlays/app/app.css).
const macTitleBar: Electron.BrowserWindowConstructorOptions =
  process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } }
    : {};

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "tiklive",
    ...macTitleBar,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window.show());

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
    // The hidden player keeps the app running, so on Windows and Linux closing this window quits.
    // On macOS the app keeps running until Quit, like other Mac apps.
    if (process.platform !== "darwin" && !quitting) app.quit();
  });
  void window.loadURL(serverUrl);
  mainWindow = window;
};

// Child windows for local pages (opened with window.open or a link). They get no preload, so the
// page can't reach the desktop bridge. Their settings are set here, not inherited from the parent.
const createChildWindow = (options: Electron.BrowserWindowConstructorOptions) =>
  new BrowserWindow({
    ...options,
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  }).webContents;

const openExternally = (url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
};

// Hidden window that plays the Actions player's sounds and speech. Electron allows audio without a
// click (see the autoplay switch below). It is never shown, and it isn't the main window.
const createPlayerWindow = () => {
  const window = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  playerWindow = window;

  const stopped = (reason: string) => {
    if (quitting || playerWindow !== window) return;
    console.error(`tiklive: the sound player stopped (${reason})`);
    playerWindow = undefined;
    if (!window.isDestroyed()) window.destroy();
    restartPlayer();
  };
  window.webContents.on("render-process-gone", (_event, details) => stopped(details.reason));
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame) stopped(`${errorDescription} (${errorCode})`);
  });
  // Load failures are reported by did-fail-load above, so the rejected promise is ignored.
  void window.loadURL(playerUrl).catch(() => undefined);
};

const restartPlayer = () => {
  const now = Date.now();
  while (playerRestarts.length && now - (playerRestarts[0] ?? 0) > PLAYER_RESTART_WINDOW_MS) {
    playerRestarts.shift();
  }
  if (playerRestarts.length >= PLAYER_RESTART_LIMIT) {
    console.error("tiklive: the sound player stopped too often, so it won't restart until the app restarts");
    return;
  }
  playerRestarts.push(now);
  setTimeout(() => {
    if (!quitting && !playerWindow) createPlayerWindow();
  }, PLAYER_RESTART_DELAY_MS);
};

const checkForUpdatesFromMenu = async () => {
  await runUpdates((updates) => updates.check);
  const state = await runUpdates((updates) => updates.state);
  const message =
    state.status === "disabled"
      ? (state.message ?? "Updates are off.")
      : state.status === "up-to-date"
        ? `tiklive ${state.currentVersion} is the latest version.`
        : state.status === "error"
          ? `Couldn't check for updates: ${state.message ?? "unknown error"}`
          : undefined;
  if (message) await dialog.showMessageBox({ type: "info", message, buttons: ["OK"] });
};

const buildMenu = () => {
  const checkItem: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => void checkForUpdatesFromMenu(),
  };
  const template: Array<MenuItemConstructorOptions> =
    process.platform === "darwin"
      ? [
          {
            role: "appMenu",
            submenu: [
              { role: "about" },
              checkItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]
      : [
          { role: "fileMenu" },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
          { role: "help", submenu: [checkItem] },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// Electron grants every permission when no handler is set. Allow only what the local pages use:
// the microphone (recording sounds in the Media page) and copying overlay URLs.
const ALLOWED_PERMISSIONS = new Set(["media", "clipboard-sanitized-write"]);

const allowPermissions = () => {
  const allowed = (permission: string, url: string) =>
    ALLOWED_PERMISSIONS.has(permission) && URL.canParse(url) && isServerUrl(`${new URL(url).origin}/`);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    // Audio only: nothing here records the screen or the camera.
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    const audioOnly = mediaTypes.every((type) => type === "audio");
    callback(allowed(permission, details.requestingUrl || webContents.getURL()) && audioOnly);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, origin) =>
    allowed(permission, origin),
  );
};

// macOS asks once per app; after a denial only System Settings can change it.
const requestMicrophone = async (): Promise<boolean> => {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (status === "not-determined") return systemPreferences.askForMediaAccess("microphone");
  return false;
};

const registerIpc = () => {
  ipcMain.handle(IPC.requestMicrophone, () => requestMicrophone());
  ipcMain.handle(IPC.updateGetState, () => runUpdates((updates) => updates.state));
  ipcMain.handle(IPC.updateCheck, () => runUpdates((updates) => updates.check));
  ipcMain.handle(IPC.updateDownload, () => runUpdates((updates) => updates.download));
  ipcMain.handle(IPC.updateInstall, () => runUpdates((updates) => updates.install));
  ipcMain.handle(IPC.updateSetChannel, (_event, channel: unknown) => {
    if (!isUpdateChannel(channel)) throw new Error(`Unknown update channel: ${String(channel)}`);
    return runUpdates((updates) => updates.setChannel(channel));
  });

  updatesRuntime.runFork(
    DesktopUpdates.DesktopUpdates.use((updates) =>
      Stream.runForEach(updates.changes, (state) =>
        Effect.sync(() => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(IPC.updateState, state);
          }
        }),
      ),
    ),
  );
};

const start = async () => {
  try {
    // Building the layer binds the port, so a port conflict fails here.
    await serverRuntime.runPromise(Effect.void);
  } catch (error) {
    dialog.showErrorBox(
      "tiklive couldn't start",
      `The server couldn't listen on ${HOST}:${PORT}. Is another tiklive already running?\n\n${String(error)}`,
    );
    app.exit(1);
    return;
  }
  buildMenu();
  allowPermissions();
  registerIpc();
  createWindow();
  createPlayerWindow();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Lets the player's sounds and speech start without a click. Must be set before the app is ready.
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

  // Every window, including child windows, follows the same rules: pages on the local server open in
  // the app, other web pages open in the default browser.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isServerUrl(url)) return { action: "allow", createWindow: createChildWindow };
      openExternally(url);
      return { action: "deny" };
    });
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (isServerUrl(url)) return;
      event.preventDefault();
      openExternally(url);
    };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
  });

  app.on("second-instance", () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    // On macOS the app (and the server overlays depend on) keeps running until Quit.
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!mainWindow && app.isReady()) createWindow();
  });
  const awaitShutdown = makeQuitHandler({
    dispose: async () => {
      // Wait for both runtimes even if one fails, including the points store's final disk flush.
      const results = await Promise.allSettled([updatesRuntime.dispose(), serverRuntime.dispose()]);
      for (const result of results) {
        if (result.status === "rejected") console.error("tiklive: shutdown failed", result.reason);
      }
    },
    quit: () => app.quit(),
    onError: (error) => console.error("tiklive: shutdown failed", error),
  });
  app.on("before-quit", (event) => {
    void awaitShutdown(event);
    // The hidden player must not hold the app open.
    quitting = true;
    if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy();
    playerWindow = undefined;
  });

  void app.whenReady().then(start);
}
