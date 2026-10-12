export * as LiveConnection from "./LiveConnection.ts";
export type { ConnectError } from "./errors.ts";
export {
  ReconnectFailed,
  SocketOpenFailed,
  TikTokRequestError,
  UserNotFound,
  UserOffline,
} from "./errors.ts";
export * as TikTokWeb from "./TikTokWeb.ts";
export type { RoomStatus } from "./TikTokWeb.ts";
export { demoEvents } from "./demo.ts";
export { decodeLiveEvent, isSupportedMethod } from "./proto/messages.ts";
export type { RawMessage } from "./proto/frames.ts";
// Event types, so apps using only @tiklive/core can type their handlers.
export type { LiveEvent, LiveEventOf, LiveEventType, LiveUser } from "@tiklive/contracts";
