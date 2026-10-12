/**
 * Update state and the pure transitions between states. DesktopUpdates owns
 * the state and decides when each transition runs; this file only says what
 * the next state is.
 */
import type { UpdateChannel } from "./channel.ts";

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type UpdateErrorContext = "check" | "download" | "install";

export interface UpdateState {
  readonly status: UpdateStatus;
  readonly currentVersion: string;
  /** Where updates come from: stable releases or nightlies. */
  readonly channel: UpdateChannel;
  /** The newer version, once a check finds one. Kept through download, install and their errors. */
  readonly availableVersion?: string;
  /** 0–100 while downloading. */
  readonly downloadPercent?: number;
  /** Why updates are disabled, or what went wrong. */
  readonly message?: string;
  readonly errorContext?: UpdateErrorContext;
  /** Unix ms of the last check that finished. */
  readonly checkedAt?: number;
}

/** What the update button should do in this state. */
export type UpdateAction = "download" | "install" | "none";

export const initialState = (
  currentVersion: string,
  channel: UpdateChannel,
  disabledReason?: string,
): UpdateState =>
  disabledReason === undefined
    ? { status: "idle", currentVersion, channel }
    : { status: "disabled", currentVersion, channel, message: disabledReason };

const base = ({ currentVersion, channel, checkedAt }: UpdateState): UpdateState => ({
  status: "idle",
  currentVersion,
  channel,
  ...(checkedAt !== undefined ? { checkedAt } : {}),
});

/** A new channel starts over: what the old one found no longer applies. */
export const onChannelChange = (state: UpdateState, channel: UpdateChannel): UpdateState =>
  state.status === "disabled"
    ? { ...state, channel }
    : { status: "idle", currentVersion: state.currentVersion, channel };

export const onCheckStart = (state: UpdateState): UpdateState => ({
  ...base(state),
  status: "checking",
  ...(state.availableVersion !== undefined ? { availableVersion: state.availableVersion } : {}),
});

export const onCheckResult = (
  state: UpdateState,
  availableVersion: string | undefined,
  checkedAt: number,
): UpdateState =>
  availableVersion === undefined
    ? { ...base(state), status: "up-to-date", checkedAt }
    : { ...base(state), status: "available", availableVersion, checkedAt };

export const onCheckError = (state: UpdateState, message: string, checkedAt: number): UpdateState => ({
  ...base(state),
  status: "error",
  errorContext: "check",
  message,
  checkedAt,
  ...(state.availableVersion !== undefined ? { availableVersion: state.availableVersion } : {}),
});

export const onDownloadStart = (state: UpdateState): UpdateState => ({
  ...base(state),
  status: "downloading",
  downloadPercent: 0,
  ...(state.availableVersion !== undefined ? { availableVersion: state.availableVersion } : {}),
});

export const onDownloadProgress = (state: UpdateState, percent: number): UpdateState =>
  state.status === "downloading" ? { ...state, downloadPercent: Math.max(0, Math.min(100, percent)) } : state;

export const onDownloaded = (state: UpdateState): UpdateState => ({
  ...base(state),
  status: "downloaded",
  ...(state.availableVersion !== undefined ? { availableVersion: state.availableVersion } : {}),
});

export const onDownloadError = (state: UpdateState, message: string): UpdateState => ({
  ...base(state),
  status: "error",
  errorContext: "download",
  message,
  ...(state.availableVersion !== undefined ? { availableVersion: state.availableVersion } : {}),
});

/** The download is still on disk, so a failed install goes back to "downloaded" for a retry. */
export const onInstallError = (state: UpdateState, message: string): UpdateState => ({
  ...onDownloaded(state),
  errorContext: "install",
  message,
});

export const actionFor = (state: UpdateState): UpdateAction => {
  if (state.status === "downloaded") return "install";
  if (state.status === "available") return "download";
  if (state.status === "error" && state.errorContext === "download") return "download";
  return "none";
};

/** Checks don't run while a download is in progress or ready to install. */
export const canCheck = (state: UpdateState): boolean =>
  state.status !== "disabled" && state.status !== "downloading" && state.status !== "downloaded";
