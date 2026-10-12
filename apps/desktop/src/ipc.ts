/**
 * IPC between the main process and the window. The preload exposes
 * `DesktopBridge` as `window.tikliveDesktop`; pages check for it to know
 * they're running in the desktop app.
 */
import type { UpdateChannel } from "./updates/channel.ts";
import type { UpdateState } from "./updates/updateMachine.ts";

export const IPC = {
  /** main → window: pushed on every update state change. */
  updateState: "tiklive:update-state",
  updateGetState: "tiklive:update-get-state",
  updateCheck: "tiklive:update-check",
  updateDownload: "tiklive:update-download",
  updateInstall: "tiklive:update-install",
  updateSetChannel: "tiklive:update-set-channel",
} as const;

export interface DesktopBridge {
  readonly platform: string;
  readonly updates: {
    readonly getState: () => Promise<UpdateState>;
    readonly check: () => Promise<void>;
    readonly download: () => Promise<void>;
    readonly install: () => Promise<void>;
    /** Switches between stable releases ("latest") and nightlies, saves it, and checks right away. */
    readonly setChannel: (channel: UpdateChannel) => Promise<void>;
    /** Calls `listener` on every state change. Returns an unsubscribe function. */
    readonly onState: (listener: (state: UpdateState) => void) => () => void;
  };
}
