/**
 * Electron main process. Runs the tiklive server in-process on 127.0.0.1:8080
 * (so OBS browser sources keep working while the app is open) and shows the
 * dashboard it serves in a window.
 */
import * as NodeServer from "@tiklive/server/node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { app, BrowserWindow, dialog, ipcMain, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "./ipc.ts";
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
  ),
);

const runUpdates = <A>(f: (updates: DesktopUpdates.DesktopUpdates["Service"]) => Effect.Effect<A>) =>
  updatesRuntime.runPromise(DesktopUpdates.DesktopUpdates.use(f));

let mainWindow: BrowserWindow | undefined;

const isServerUrl = (url: string) => url.startsWith(serverUrl);

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "tiklive",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window.show());

  // Pages outside the local server open in the default browser, not in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isServerUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  void window.loadURL(serverUrl);
  mainWindow = window;
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

const registerIpc = () => {
  ipcMain.handle(IPC.updateGetState, () => runUpdates((updates) => updates.state));
  ipcMain.handle(IPC.updateCheck, () => runUpdates((updates) => updates.check));
  ipcMain.handle(IPC.updateDownload, () => runUpdates((updates) => updates.download));
  ipcMain.handle(IPC.updateInstall, () => runUpdates((updates) => updates.install));

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
  registerIpc();
  createWindow();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
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
  app.on("will-quit", () => {
    void updatesRuntime.dispose();
    void serverRuntime.dispose();
  });

  void app.whenReady().then(start);
}
