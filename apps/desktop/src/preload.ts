/**
 * Runs in the sandboxed window before the page loads. Only exposes the
 * narrow `DesktopBridge`, never `ipcRenderer` itself.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { type DesktopBridge, IPC } from "./ipc.ts";
import type { UpdateState } from "./updates/updateMachine.ts";

const bridge: DesktopBridge = {
  platform: process.platform,
  updates: {
    getState: () => ipcRenderer.invoke(IPC.updateGetState),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    setChannel: (channel) => ipcRenderer.invoke(IPC.updateSetChannel, channel),
    onState: (listener) => {
      const handler = (_event: IpcRendererEvent, state: UpdateState) => listener(state);
      ipcRenderer.on(IPC.updateState, handler);
      return () => {
        ipcRenderer.off(IPC.updateState, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("tikliveDesktop", bridge);
